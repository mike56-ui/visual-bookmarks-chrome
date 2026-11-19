import ImageDB from './api/imageDB';
import { containsPermissions } from './api/permissions';
import { PREVIEW_CAPTURE_PORT } from './api/previewCapture';
import { storage } from './api/storage';
import { THUMBNAIL_POPUP_HEIGHT, THUMBNAIL_POPUP_WIDTH } from './constants';
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

async function removeOwnedTab(resource) {
  if (!resource || resource.detached) return;
  try {
    const tab = await browser.tabs.get(resource.tabId);
    // Never remove a whole window, or a tab somebody moved out of our popup.
    if (!resource.detached && tab.windowId === resource.windowId) await browser.tabs.remove(resource.tabId);
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
  return removeOwnedTab(batch.resource);
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

async function navigate(resource, url, current, wait) {
  const from = await ownedTab(resource);
  if (!from || !current() || (from.url && from.url !== resource.url)) return;
  const previous = matchesNavigatedPreviewAddress(url, from.url)
    && await getCaptureDocument(from, { allowEarly: true }).catch(() => undefined);
  if (!current()) return;
  const revision = resource.navigation;
  const started = Date.now();
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
      const document = await getCaptureDocument(tab, { allowEarly: true, trackViewport: true }).catch(() => undefined);
      // A normalized address can land on the previous URL, so verify its document changed.
      const newDocument = actual !== from.url || (previous
        ? !sameCaptureDocument(previous, document)
        : document?.timeOrigin >= started);
      if (document && newDocument && current() && committed === resource.navigation) {
        await delay(wait);
        const visible = current() && await ownedTab(resource);
        if (committedUrl(visible) !== actual || committed !== resource.navigation
          || !sameCaptureViewport(document, await getCaptureDocument(visible, { allowEarly: true }))) return;
        return { tab: visible, document, revision: committed };
      }
    }
    await delay(150);
  }
}

async function capture(batch, { id, url, mode }) {
  const current = () => !batch.stopped && (!batch.reservation || batch.reservation.current());
  if (!current() || typeof id !== 'string' || !isWebUrl(url) || !await containsPermissions(permission)) return 'failed';
  const [bookmark] = await browser.bookmarks.get(id);
  if (bookmark?.url !== url || !current()) return 'failed';
  if ((await ImageDB.get(id))?.custom) return 'protected';
  const { settings } = await storage.local.get('settings');
  const manualDelay = (Number(settings?.thumbnails_update_delay) || 0.5) * 1000;
  const wait = mode === 'initial' ? 0 : Math.min(5000, Math.max(500, manualDelay));
  if (!current()) return 'stopped';
  const resource = batch.resource ?? await createWorkspace(batch);
  if (!resource || !current()) return 'stopped';
  const sampled = await navigate(resource, url, current, wait);
  if (!sampled || !current()) return 'failed';
  const unchanged = () => current() && !resource.detached && resource.navigation === sampled.revision;
  if (mode === 'initial' && !await isInitialPreviewEnabled()) return 'stopped';
  const samePage = async() => {
    if (!unchanged()) return false;
    const tab = await ownedTab(resource);
    return committedUrl(tab) === sampled.tab.url
      && sameCaptureViewport(sampled.document, await getCaptureDocument(tab, { allowEarly: true })) && unchanged();
  };
  const snap = () => browser.tabs.captureVisibleTab(resource.windowId, { format: 'jpeg', quality: 88 });
  let screenshot;
  let capturedAt = Date.now();
  try {
    screenshot = await snap();
  } catch (error) {
    if (!error?.message?.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) throw error;
    await delay(1050);
    if (!await samePage() || !await containsPermissions(permission)
      || (mode === 'initial' && !await isInitialPreviewEnabled())) return 'stopped';
    capturedAt = Date.now();
    screenshot = await snap();
  }
  if (!screenshot || !await samePage()) return 'failed';
  const blob = await encodeVisitPreview(screenshot);
  if (!blob || !unchanged()
    || !await containsPermissions(permission)) return 'failed';
  if (mode === 'single') {
    const [currentBookmark] = await browser.bookmarks.get(id);
    if (currentBookmark?.url !== url || !unchanged()) return 'failed';
    const status = await ImageDB.putBookmarkPreview({ id, url }, blob, unchanged, capturedAt);
    if (status === 'updated') await browser.runtime.sendMessage({ visitPreviewUpdated: true }).catch(() => undefined);
    return status;
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
    if (port.name !== PREVIEW_CAPTURE_PORT) return;
    if (!trustedSource(port.sender) || activeBatch) {
      port.disconnect();
      return;
    }
    const batch = { port, busy: false };
    activeBatch = batch;
    const expire = () => {
      batch.idle = setTimeout(() => stop(batch), 8000);
    };
    expire();
    port.onDisconnect.addListener(() => stop(batch, true));
    port.onMessage.addListener(request => {
      if (activeBatch !== batch || batch.busy) return;
      batch.busy = true;
      clearTimeout(batch.idle);
      capture(batch, { ...request, mode: request?.mode === 'single' ? 'single' : 'folder' })
        .catch(() => 'failed')
        .then(status => {
          if (activeBatch !== batch) return;
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
