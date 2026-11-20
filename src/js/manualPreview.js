import ImageDB from './api/imageDB';
import { containsPermissions } from './api/permissions';
import { PREVIEW_CAPTURE_PORT, VISIBLE_PREVIEW_PORT } from './api/previewCapture';
import { storage } from './api/storage';
import { captureBackgroundTab } from './backgroundTabPreview';
import { FIREFOX_BROWSER, THUMBNAIL_POPUP_HEIGHT, THUMBNAIL_POPUP_WIDTH } from './constants';
import {
  encodeVisitPreview, getCaptureDocument, isWebUrl, matchesNavigatedPreviewAddress,
  sameCaptureDocument, sameCaptureViewport, saveBookmarkPreview,
  isInitialPreviewEnabled, needsInitialBookmarkPreview, reserveInitialBookmarkPreview, saveInitialBookmarkPreview
} from './visitPreview';

const permission = { origins: ['<all_urls>'] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let activeBatch;
let savedBookmarks = Promise.resolve();
const captureTabs = new Map();
const failedVisibleUrls = new Map();
let restoredFailures;

async function canAutoFill(tab) {
  const [prefs, source, win, permitted] = await Promise.all([
    storage.local.get('autoFillMissingPreviews'),
    browser.tabs.get(tab.id),
    browser.windows.get(tab.windowId),
    containsPermissions(permission)
  ]);
  return prefs.autoFillMissingPreviews === true && permitted && source.active && source.url === tab.url
    && (!source.pendingUrl || source.pendingUrl === source.url) && source.windowId === tab.windowId
    && win.type === 'normal' && win.focused && win.state !== 'minimized' && !win.incognito;
}

async function fillVisiblePreview(batch, { id, url }) {
  const current = () => !batch.stopped;
  if (FIREFOX_BROWSER || typeof id !== 'string' || !isWebUrl(url)) return 'unchanged';
  if (!await canAutoFill(batch.port.sender.tab)) return 'stopped';
  // Keep a failed site from opening once per new tab while still allowing an explicit retry.
  const session = browser.storage.session;
  restoredFailures ??= session?.get('failedVisiblePreviews').then(({ failedVisiblePreviews = [] }) => {
    for (const [address, until] of failedVisiblePreviews) if (until > Date.now()) failedVisibleUrls.set(address, until);
  }).catch(() => undefined);
  await restoredFailures;
  if (failedVisibleUrls.get(url) > Date.now()) return 'unchanged';
  const missing = async() => {
    const [bookmark] = await browser.bookmarks.get(id).catch(() => []);
    return bookmark?.url === url && await needsInitialBookmarkPreview(bookmark);
  };
  if (!current() || !await missing() || !current()) return 'unchanged';
  const { settings } = await storage.local.get('settings');
  const wait = manualWait(settings);
  const image = await captureBackgroundTab({ url, windowId: batch.sourceWindowId, wait, current })
    .catch(() => undefined);
  if (!current()) return 'stopped';
  if (!await canAutoFill(batch.port.sender.tab) || !current()) return 'stopped';
  if (!image) {
    failedVisibleUrls.delete(url);
    failedVisibleUrls.set(url, Date.now() + 30 * 60 * 1000);
    if (failedVisibleUrls.size > 128) failedVisibleUrls.delete(failedVisibleUrls.keys().next().value);
    await session?.set({ failedVisiblePreviews: [...failedVisibleUrls] }).catch(() => undefined);
    return 'failed';
  }
  if (!await missing() || !current()) return 'unchanged';
  // A shared first image is reusable. A manual per-card cover or an explicit clear takes precedence.
  const saved = await ImageDB.putVisitPreview(url, image.blob, current, 0, image.capturedAt, { fillMissing: true });
  if (saved) await browser.runtime.sendMessage({ visitPreviewUpdated: true }).catch(() => undefined);
  return saved ? 'updated' : 'unchanged';
}

function manualWait(settings) {
  return Math.min(15000, Math.max(500, (Number(settings?.thumbnails_update_delay) || 0.5) * 1000));
}

async function removeOwnedTab(resource, source) {
  if (!resource || resource.detached) return;
  try {
    const tab = await browser.tabs.get(resource.tabId);
    // Never remove a whole window, or a tab somebody moved out of our popup.
    if (resource.detached || tab.windowId !== resource.windowId) return;
    if (tab.active && source && await sourceIsActive(source)
      && (await browser.windows.get(resource.windowId)).focused) {
      await browser.windows.update(source.windowId, { focused: true }).catch(() => undefined);
    }
    if (!resource.detached && (await browser.tabs.get(resource.tabId)).windowId === resource.windowId) {
      await browser.tabs.remove(resource.tabId);
    }
  } catch {
    // The tab may already have been closed.
  }
}

function stop(batch, disconnected = false) {
  if (batch.stopped) return;
  batch.stopped = true;
  if (activeBatch === batch) activeBatch = undefined;
  if (batch.resource) captureTabs.delete(batch.resource.tabId);
  clearTimeout(batch.idle);
  if (!disconnected) batch.port?.disconnect();
  return removeOwnedTab(batch.resource, batch.port?.sender?.tab);
}

async function sourceIsActive(source) {
  const tab = await browser.tabs.get(source.id).catch(() => undefined);
  return tab?.active && tab.windowId === source.windowId && tab.url === source.url;
}

async function revealCoveredWorkspace(batch, resource, current) {
  const source = batch.port?.sender?.tab;
  if (!source || batch.revealed || !current()) return;
  const [frame] = await browser.scripting.executeScript({
    target: { tabId: resource.tabId }, injectImmediately: true, func: () => document.visibilityState
  }).catch(() => []);
  if (frame?.result !== 'hidden' || !current() || !await sourceIsActive(source)) return;
  const home = await browser.windows.get(source.windowId).catch(() => undefined);
  if (!home?.focused || home.state === 'minimized' || !current()) return;
  // An occluded window may never paint on Windows. Reveal it at most once per explicit
  // refresh, only while the initiating bookmark page is still in the foreground.
  batch.revealed = true;
  return browser.windows.update(resource.windowId, { focused: true }).catch(() => undefined);
}

async function createWorkspace(batch) {
  const { screen } = await storage.local.get('screen');
  if (batch.stopped) return;
  const popup = await browser.windows.create({
    url: 'about:blank', type: 'popup', focused: false,
    width: THUMBNAIL_POPUP_WIDTH, height: THUMBNAIL_POPUP_HEIGHT,
    ...(screen && {
      left: Math.max(0, screen.availWidth - THUMBNAIL_POPUP_WIDTH),
      top: Math.max(0, screen.availHeight - THUMBNAIL_POPUP_HEIGHT)
    })
  });
  if (popup?.id === undefined) return;
  const tab = popup.tabs?.[0];
  if (tab?.id === undefined) return;
  const resource = { windowId: popup.id, tabId: tab.id, navigation: 0, url: 'about:blank' };
  if (batch.stopped) {
    await removeOwnedTab(resource);
    return;
  }
  batch.resource = resource;
  captureTabs.set(resource.tabId, batch);
  return resource;
}

async function ownedTab(resource) {
  const tab = await browser.tabs.get(resource.tabId);
  if (!resource.detached && tab.windowId === resource.windowId && tab.active && !tab.incognito) return tab;
}

function committedUrl(tab) {
  return tab?.url && (!tab.pendingUrl || tab.pendingUrl === tab.url) ? tab.url : undefined;
}

async function navigate(batch, resource, url, current, wait) {
  const from = await ownedTab(resource);
  if (!from || !current() || (from.url && from.url !== resource.url)) return;
  const previous = matchesNavigatedPreviewAddress(url, from.url)
    && await getCaptureDocument(from, { allowEarly: true }).catch(() => undefined);
  if (!current()) return;
  const revision = resource.navigation;
  const started = Date.now();
  let checkVisibilityAt = started + 900;
  await browser.tabs.update(resource.tabId, { url, muted: true });
  const deadline = started + 20000;
  while (current() && Date.now() < deadline) {
    const tab = await ownedTab(resource);
    if (!tab) return;
    const actual = committedUrl(tab);
    if (isWebUrl(actual) && (actual !== from.url || resource.navigation !== revision)) {
      resource.url = actual;
      if (!matchesNavigatedPreviewAddress(url, actual)) return;
      const committed = resource.navigation;
      const document = await getCaptureDocument(tab, { allowEarly: true, trackViewport: true }).catch(error => {
        if (error.httpStatus) throw error;
      });
      if (!document && batch.port && !batch.revealed && Date.now() >= checkVisibilityAt) {
        checkVisibilityAt = Date.now() + 1000;
        await revealCoveredWorkspace(batch, resource, current);
      }
      // A normalized address can land on the previous URL, so verify its document changed.
      const newDocument = actual !== from.url || (previous
        ? !sameCaptureDocument(previous, document)
        : document?.timeOrigin >= started);
      if (document && newDocument && current() && committed === resource.navigation) {
        await delay(wait);
        const visible = current() && await ownedTab(resource);
        if (!visible) return;
        if (committedUrl(visible) === actual) {
          const revisionAfterWait = resource.navigation;
          const after = await getCaptureDocument(visible, { allowEarly: true }).catch(() => undefined);
          // Some SPAs report another "loading" for the same URL while hydrating.
          // Verify the actual document and viewport again before accepting that revision.
          if (sameCaptureViewport(document, after) && revisionAfterWait === resource.navigation) {
            return { tab: visible, document, revision: revisionAfterWait };
          }
          if (after && sameCaptureDocument(document, after) && !sameCaptureViewport(document, after)) return;
          if (!after) await revealCoveredWorkspace(batch, resource, current);
        }
      }
    }
    await delay(150);
  }
}

async function saveSinglePreview(bookmark, blob, current, capturedAt) {
  const [latest] = await browser.bookmarks.get(bookmark.id);
  if (latest?.url !== bookmark.url || !current()) return 'stopped';
  const status = await ImageDB.putBookmarkPreview(bookmark, blob, current, capturedAt);
  if (status === 'updated') await browser.runtime.sendMessage({ visitPreviewUpdated: true }).catch(() => undefined);
  return status;
}

async function capture(batch, { id, url, mode }) {
  const current = () => !batch.stopped && (!batch.reservation || batch.reservation.current());
  if (!current() || typeof id !== 'string' || !isWebUrl(url) || !await containsPermissions(permission)) return 'failed';
  const [bookmark] = await browser.bookmarks.get(id);
  if (bookmark?.url !== url || !current()) return 'failed';
  if ((await ImageDB.get(id))?.custom) return 'protected';
  const { settings } = await storage.local.get('settings');
  const manualDelay = manualWait(settings);
  if (!current()) return 'stopped';
  if (mode === 'single' && !FIREFOX_BROWSER) {
    const image = await captureBackgroundTab({ url, windowId: batch.sourceWindowId, wait: manualDelay, current });
    if (!image || !current() || !await containsPermissions(permission)) return 'failed';
    return saveSinglePreview(bookmark, image.blob, current, image.capturedAt);
  }
  const resource = batch.resource ?? await createWorkspace(batch);
  if (!resource || !current()) return 'stopped';
  const wait = mode === 'initial' ? 0 : Math.min(5000, manualDelay);
  const sampled = await navigate(batch, resource, url, current, wait);
  if (!sampled || !current()) return 'failed';
  let sampledRevision = sampled.revision;
  const unchanged = () => current() && !resource.detached && resource.navigation === sampledRevision;
  if (mode === 'initial' && !await isInitialPreviewEnabled()) return 'stopped';
  const samePage = async() => {
    if (!unchanged()) return false;
    const tab = await ownedTab(resource);
    return committedUrl(tab) === sampled.tab.url
      && sameCaptureViewport(sampled.document, await getCaptureDocument(tab, { allowEarly: true })) && unchanged();
  };
  const snap = () => browser.tabs.captureVisibleTab(resource.windowId, { format: 'jpeg', quality: 88 });
  let screenshot;
  let capturedAt;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) {
      sampledRevision = resource.navigation;
      if (!await samePage() || !await containsPermissions(permission)
        || (mode === 'initial' && !await isInitialPreviewEnabled())) return 'stopped';
    }
    capturedAt = Date.now();
    try {
      const image = await snap();
      if (image && await samePage()) {
        screenshot = image;
        break;
      }
      if (!current() || resource.navigation === sampledRevision) return 'failed';
    } catch (error) {
      if (!error?.message?.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) throw error;
      await delay(1050);
    }
  }
  if (!screenshot) return 'failed';
  const blob = await encodeVisitPreview(screenshot);
  if (!blob || !unchanged()
    || !await containsPermissions(permission)) return 'failed';
  if (mode === 'single') {
    return saveSinglePreview(bookmark, blob, unchanged, capturedAt);
  }

  const bookmarks = (await browser.bookmarks.search({ url })).filter(item => item.url === url);
  if (!bookmarks.some(item => item.id === id) || !unchanged()) return 'failed';
  const updated = mode === 'initial'
    ? await saveInitialBookmarkPreview(bookmark, blob, unchanged, capturedAt)
    : await saveBookmarkPreview(url, bookmarks, blob, unchanged, capturedAt);
  if (!unchanged()) return 'stopped';
  if (updated) await browser.runtime.sendMessage({ visitPreviewUpdated: true }).catch(() => undefined);
  return updated ? 'updated' : 'unchanged';
}

function trustedSource(sender) {
  if (sender?.tab?.incognito || !sender?.tab || sender.frameId !== 0) return false;
  const page = sender.url?.replace(/^extension:/, 'chrome-extension:').split(/[?#]/, 1)[0];
  return page === browser.runtime.getURL('newtab.html');
}

export function queueInitialBookmarkPreview(bookmark) {
  const pending = isInitialPreviewEnabled().then(enabled => enabled && reserveInitialBookmarkPreview(bookmark))
    .catch(() => undefined);
  savedBookmarks = savedBookmarks.then(async() => {
    const reservation = await pending;
    if (!reservation) return;
    const batch = { reservation };
    try {
      if (reservation.current() && await isInitialPreviewEnabled() && await needsInitialBookmarkPreview(bookmark)) {
        await capture(batch, { ...bookmark, mode: 'initial' });
      }
    } finally {
      await stop(batch);
      reservation.release();
    }
  }).catch(error => console.warn(error));
  return savedBookmarks;
}

export function registerManualPreviews() {
  browser.runtime.onMessage.addListener((message, sender, respond) => {
    const bookmark = message?.newBookmarkPreview;
    if (!bookmark || !trustedSource(sender) || typeof bookmark.id !== 'string' || !isWebUrl(bookmark.url)) return;
    queueInitialBookmarkPreview(bookmark).then(() => respond(true));
    return true;
  });
  browser.runtime.onConnect.addListener(port => {
    const automatic = port.name === VISIBLE_PREVIEW_PORT;
    if (!automatic && port.name !== PREVIEW_CAPTURE_PORT) return;
    if (!trustedSource(port.sender)) {
      port.disconnect();
      return;
    }
    if (!automatic && activeBatch?.automatic) stop(activeBatch);
    if (activeBatch) {
      port.disconnect();
      return;
    }
    const batch = { port, automatic, busy: false, sourceWindowId: port.sender.tab.windowId };
    activeBatch = batch;
    const expire = () => {
      batch.idle = setTimeout(() => stop(batch), 8000);
    };
    expire();
    port.onDisconnect.addListener(() => {
      batch.disconnected = true;
      // A user can navigate away from the bookmark page while a single background capture finishes.
      if (!batch.backgroundSingle) stop(batch, true);
    });
    port.onMessage.addListener(request => {
      if (activeBatch !== batch || batch.busy) return;
      batch.busy = true;
      batch.backgroundSingle = !automatic && !FIREFOX_BROWSER && request?.mode === 'single';
      clearTimeout(batch.idle);
      const task = automatic ? fillVisiblePreview(batch, request || {})
        : capture(batch, { ...request, mode: request?.mode === 'single' ? 'single' : 'folder' });
      task
        .catch(error => error?.httpStatus >= 400 ? 'unavailable' : 'failed')
        .then(status => {
          if (activeBatch !== batch) return;
          batch.backgroundSingle = false;
          if (batch.disconnected) return stop(batch, true);
          batch.busy = false;
          expire();
          try {
            port.postMessage({ status });
          } catch {
            stop(batch);
          }
        });
    });
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.autoFillMissingPreviews && !changes.autoFillMissingPreviews.newValue
      && activeBatch?.automatic) stop(activeBatch);
  });
  browser.permissions.onRemoved.addListener(removed => {
    if (!removed.origins?.length) return;
    if (activeBatch?.automatic) stop(activeBatch);
    containsPermissions(permission).then(async granted => {
      if (!granted && (await storage.local.get('autoFillMissingPreviews')).autoFillMissingPreviews === true) {
        await storage.local.set({ autoFillMissingPreviews: false });
      }
    }).catch(() => undefined);
  });

  browser.tabs.onUpdated.addListener((id, change) => {
    const resource = captureTabs.get(id)?.resource;
    if (resource && (change.url || change.status === 'loading')) resource.navigation++;
  });
  browser.tabs.onDetached?.addListener(id => {
    const batch = captureTabs.get(id);
    if (!batch) return;
    batch.resource.detached = true;
    stop(batch);
  });
  browser.tabs.onRemoved.addListener(id => {
    const batch = captureTabs.get(id);
    if (batch) stop(batch);
  });
}
