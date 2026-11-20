import ImageDB from './api/imageDB';
import { storage } from './api/storage';
import { $base64ToBlob } from './utils';
import { cacheDeclaredSiteIcon } from './siteIconCapture';

const FIRST_CAPTURE_DELAY = 100;
const PAINT_RETRY_DELAY = 160;
const PAINT_WAIT = 12000;
const CAPTURE_QUOTA_RETRY = 1050;
const NAVIGATION_SOURCE_TTL = 15000;
const NAVIGATION_SOURCE_LIMIT = 64;
const FIRST_SCREEN_RETRY_TTL = 30 * 60 * 1000;
const HOST_PERMISSION = { origins: ['<all_urls>'] };
const MARKETING_PARAMETERS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_id', 'utm_term', 'utm_content',
  'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic', 'fbclid', 'gclid', 'msclkid',
  'dclid', 'gbraid', 'wbraid'
]);
const initialCaptures = new Map();
let previewPolicy = 0;

export function isWebUrl(url) {
  try {
    const parsed = new URL(url);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function matchingAddresses(url) {
  if (!isWebUrl(url)) return [];
  const address = new URL(url);
  const addresses = [address.href];
  // Secure upgrades can change the scheme while keeping the saved page identity.
  if (address.protocol === 'https:' && !address.port) {
    address.protocol = 'http:';
    addresses.push(address.href);
  }
  return addresses;
}

export function matchesPreviewAddress(saved, actual) {
  return isWebUrl(saved) && matchingAddresses(actual).includes(new URL(saved).href);
}

function withoutTrailingSlash(path) {
  return path.endsWith('/') && !path.endsWith('//') ? path.slice(0, -1) : path;
}

function isNormalizedAddress(start, actual) {
  if (!isWebUrl(start) || !isWebUrl(actual)) return false;
  const original = new URL(start);
  const destination = new URL(actual);
  if (original.origin !== destination.origin || original.hash !== destination.hash
    || withoutTrailingSlash(original.pathname) !== withoutTrailingSlash(destination.pathname)) return false;

  // Retain each remaining key and value exactly, including repetitions, encoding and order.
  const from = original.search ? original.search.slice(1).split('&') : [];
  const to = destination.search ? destination.search.slice(1).split('&') : [];
  let index = 0;
  for (const part of from) {
    if (part === to[index]) index++;
    else if (!MARKETING_PARAMETERS.has(part.split('=', 1)[0])) return false;
  }
  return index === to.length && (from.length > to.length || original.pathname !== destination.pathname);
}

export function matchesNavigatedPreviewAddress(start, actual) {
  return matchesPreviewAddress(start, actual) || isNormalizedAddress(start, actual);
}

export async function matchingPreviewBookmarks(url, source) {
  const addresses = matchingAddresses(url);
  const originalAddress = isNormalizedAddress(source?.url, url) ? new URL(source.url).href : undefined;
  const exact = async address => {
    const matches = await browser.bookmarks.search({ url: address });
    return matches.filter(bookmark => isWebUrl(bookmark.url) && new URL(bookmark.url).href === address);
  };
  const [direct, starting] = await Promise.all([
    Promise.all(addresses.map(exact)), originalAddress ? exact(originalAddress) : []
  ]);
  if (source?.bookmarkId && !starting.some(bookmark => bookmark.id === source.bookmarkId)) return direct.flat();
  return direct.flat().concat(starting);
}

export async function saveBookmarkPreview(url, bookmarks, blob, current, capturedAt) {
  const legacyTimestamp = await ImageDB.latestLegacyCapture(bookmarks);
  return ImageDB.putVisitPreview(url, blob, current, legacyTimestamp, capturedAt);
}

export async function needsInitialBookmarkPreview(bookmark) {
  if (!isWebUrl(bookmark?.url)) return false;
  try {
    const { records, hiddenIds, complete } = await ImageDB.readBookmarkPreviews([bookmark]);
    return complete && !records.length && !hiddenIds?.has(bookmark.id);
  } catch {
    // A database error cannot establish that the bookmark has no cover.
    return false;
  }
}

export async function reserveInitialBookmarkPreview(bookmark) {
  const url = bookmark?.url;
  if (!isWebUrl(url) || initialCaptures.has(url)) return;
  const claim = { policy: previewPolicy };
  initialCaptures.set(url, claim);
  const current = () => initialCaptures.get(url) === claim && claim.policy === previewPolicy;
  const release = () => {
    if (initialCaptures.get(url) === claim) initialCaptures.delete(url);
  };
  if (await needsInitialBookmarkPreview(bookmark) && current()) return { current, release };
  release();
}

export async function saveInitialBookmarkPreview(bookmark, blob, current, capturedAt) {
  const claim = initialCaptures.get(bookmark.url);
  const canSave = () => !!claim && claim.policy === previewPolicy && initialCaptures.get(bookmark.url) === claim
    && current();
  if (!canSave() || !await isInitialPreviewEnabled()) return false;
  const [latest] = await browser.bookmarks.get(bookmark.id).catch(() => []);
  if (latest?.url !== bookmark.url || !await needsInitialBookmarkPreview(latest)
    || !await isInitialPreviewEnabled() || !canSave()) return false;
  return ImageDB.putVisitPreview(bookmark.url, blob, canSave, 0, capturedAt, { fillMissing: true });
}

export async function isInitialPreviewEnabled() {
  const { visitPreviewEnabled } = await storage.local.get('visitPreviewEnabled');
  return visitPreviewEnabled !== false && browser.permissions.contains(HOST_PERMISSION);
}

async function getForegroundTab(tabId, windowId) {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.active || tab.incognito || !isWebUrl(tab.url)
    || tab.discarded
    || (tab.pendingUrl && tab.pendingUrl !== tab.url)
    || (tabId !== undefined && tabId !== tab.id)
    || (windowId !== undefined && windowId !== tab.windowId)
    || tab.splitViewId >= 0) return;
  const win = await browser.windows.get(tab.windowId);
  if (win.focused && !win.incognito && win.type === 'normal' && win.state !== 'minimized') return tab;
}

// Runs in the extension's isolated world and verifies the live document.
function inspectDocument(url, { includeIcons, allowEarly, trackViewport, identityOnly, includeScrollPosition }) {
  if (location.href !== url) return null;
  const status = performance.getEntriesByType?.('navigation')[0]?.responseStatus;
  if (status >= 400) return { httpError: status };
  if (document.visibilityState !== 'visible') return null;
  const body = document.body;

  function atViewportStart() {
    const nearTop = offset => Math.abs(offset ?? 0) <= 2;
    if (!nearTop(window.scrollY) || !nearTop(window.visualViewport?.pageTop)
      || !nearTop(document.scrollingElement?.scrollTop)) return false;

    const { innerWidth, innerHeight } = window;
    let element = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    while (element && element !== body && element !== document.documentElement) {
      if (!nearTop(element.scrollTop)) {
        const { width, height } = element.getBoundingClientRect();
        if (width >= innerWidth / 2 && height >= innerHeight / 2) return false;
      }
      element = element.parentElement;
    }
    return true;
  }

  if (identityOnly) {
    const links = includeIcons ? document.head?.querySelectorAll(
      'link[rel~="icon" i], link[rel="apple-touch-icon" i], link[rel="apple-touch-icon-precomposed" i]'
    ) : null;
    const icons = links ? Array.from(links).slice(0, 24).filter(link => link.href.length <= 2048
      && (!link.media || window.matchMedia(link.media).matches)).map(link => ({
      url: link.href, sizes: link.getAttribute('sizes')?.slice(0, 150) ?? '', type: link.type.slice(0, 64)
    })) : [];
    const atTop = includeScrollPosition && body ? atViewportStart() : undefined;
    return { timeOrigin: performance.timeOrigin, icons, atTop };
  }
  const complete = document.readyState === 'complete';
  const supportsPaint = typeof PerformanceObserver !== 'undefined'
    && PerformanceObserver.supportedEntryTypes?.includes('paint');
  if (allowEarly && supportsPaint) {
    if (!performance.getEntriesByName('first-contentful-paint', 'paint').length) return null;
  } else if (!complete) return null;
  if (!body || (!body.childElementCount && !body.textContent.trim())) return null;

  if (!atViewportStart()) return null;
  const viewport = window.visualBookmarksPreviewViewport ??= { revision: 0 };
  if (trackViewport && !viewport.listening) {
    const onScroll = () => {
      if (atViewportStart()) return;
      viewport.revision++;
      stop();
    };
    const stop = () => {
      window.clearTimeout(expires);
      window.removeEventListener('scroll', onScroll, true);
      window.visualViewport?.removeEventListener('scroll', onScroll);
      viewport.listening = false;
    };
    const expires = window.setTimeout(stop, 6500);
    viewport.listening = true;
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.visualViewport?.addEventListener('scroll', onScroll, { passive: true });
  }

  return { timeOrigin: performance.timeOrigin, viewportRevision: viewport.revision };
}

export async function getCaptureDocument(tab, { includeIcons = false, allowEarly = false,
  trackViewport = false, identityOnly = false, includeScrollPosition = false } = {}) {
  const [frame] = await browser.scripting.executeScript({
    target: { tabId: tab.id },
    func: inspectDocument,
    ...(allowEarly && { injectImmediately: true }),
    args: [tab.url, { includeIcons, allowEarly, trackViewport, identityOnly, includeScrollPosition }]
  });
  if (frame?.result?.httpError) {
    const error = new Error(`Preview page returned HTTP ${frame.result.httpError}`);
    error.httpStatus = frame.result.httpError;
    throw error;
  }
  if (frame?.result) return { ...frame.result, id: frame.documentId };
}

export function sameCaptureDocument(first, second) {
  return first && second && second.id === first.id && second.timeOrigin === first.timeOrigin;
}

export function sameCaptureViewport(first, second) {
  return sameCaptureDocument(first, second) && second.viewportRevision === first.viewportRevision;
}

export async function encodeVisitPreview(dataUrl) {
  const bitmap = await createImageBitmap($base64ToBlob(dataUrl, 'image/jpeg'));
  try {
    const scale = Math.min(1, 960 / bitmap.width, 600 / bitmap.height);
    const render = (factor, quality) => {
      const width = Math.max(1, Math.round(bitmap.width * scale * factor));
      const height = Math.max(1, Math.round(bitmap.height * scale * factor));
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
      return canvas.convertToBlob({ type: 'image/webp', quality });
    };
    for (const [factor, quality] of [[1, 0.82], [1, 0.58], [0.75, 0.56], [0.56, 0.5]]) {
      const blob = await render(factor, quality);
      if (blob.size && blob.size <= ImageDB.MAX_VISIT_BYTES) return blob;
    }
  } finally {
    bitmap.close();
  }
}

export function registerVisitPreview(queueInitialBookmarkPreview) {
  const navigationSources = new Map();
  // Only missed *new* bookmarks are eligible. Session storage survives MV3 worker suspension.
  const missed = new Map();
  const session = browser.storage?.session;
  const restored = session?.get('missedFirstScreens').then(({ missedFirstScreens = [] }) => {
    for (const [id, item] of missedFirstScreens) if (item.expires > Date.now()) missed.set(id, item);
  }).catch(() => undefined);
  const persistMissed = () => session?.set({ missedFirstScreens: [...missed] }).catch(() => undefined);
  let timer;
  let target;
  let focusedWindow;
  let foregroundRevision = 0;

  function rememberPending(tab, bookmarkId) {
    if (tab.incognito || !isWebUrl(tab.pendingUrl) || tab.pendingUrl === tab.url) return;
    if (navigationSources.get(tab.id)?.expires > Date.now()) return;
    navigationSources.delete(tab.id);
    if (navigationSources.size >= NAVIGATION_SOURCE_LIMIT) {
      navigationSources.delete(navigationSources.keys().next().value);
    }
    navigationSources.set(tab.id, { url: tab.pendingUrl, bookmarkId, expires: Date.now() + NAVIGATION_SOURCE_TTL });
  }

  function updateNavigationSource(tab, change) {
    let source = navigationSources.get(tab.id);
    if (source?.expires <= Date.now() || (change.status === 'loading' && !change.url
      && (source?.destination || (tab.pendingUrl && source?.url !== tab.pendingUrl)
        || (!tab.pendingUrl && isWebUrl(tab.url))))) {
      navigationSources.delete(tab.id);
      source = undefined;
    }
    if (!source && !change.url) rememberPending(tab);
    if (!source || !change.url) return;

    // The pending address is evidence for this commit only. Never infer the source from the destination.
    if (source.destination === change.url) return;
    if (!source.destination && isNormalizedAddress(source.url, change.url)) source.destination = change.url;
    else navigationSources.delete(tab.id);
  }

  function cancel() {
    clearTimeout(timer);
    target = undefined;
  }

  function schedule(tabId, windowId) {
    cancel();
    const request = target = { tabId, windowId };
    timer = setTimeout(() => refreshForeground(request).catch(() => undefined), FIRST_CAPTURE_DELAY);
  }

  async function refreshForeground(request) {
    const capturedPolicy = previewPolicy;
    const canSave = () => capturedPolicy === previewPolicy;
    const current = () => target === request && canSave();
    const tab = await getForegroundTab(request.tabId, request.windowId);
    if (!tab || !current()) return;
    focusedWindow = tab.windowId;
    await restored;
    const retry = missed.get(tab.id);
    if (retry && (retry.expires <= Date.now() || matchesPreviewAddress(retry.bookmark.url, tab.url)) && current()) {
      missed.delete(tab.id);
      await persistMissed();
      if (retry.expires > Date.now() && current()) {
        const [latest] = await browser.bookmarks.get(retry.bookmark.id).catch(() => []);
        if (latest?.url === retry.bookmark.url && current()) {
          await captureCreatedBookmark(retry.bookmark, false);
        }
      }
    }
    const source = navigationSources.get(tab.id);
    const start = source?.destination === tab.url && source.expires > Date.now() ? source : undefined;
    if (!await isInitialPreviewEnabled() || !(await matchingPreviewBookmarks(tab.url, start)).length
      || !current()) return;
    const document = await getCaptureDocument(tab, { includeIcons: true, allowEarly: true, identityOnly: true });
    if (!document?.icons.length || !current()) return;
    const origin = await cacheDeclaredSiteIcon(tab.url, document.icons, canSave, isInitialPreviewEnabled);
    if (origin) await browser.runtime.sendMessage({ siteIconUpdated: origin }).catch(() => undefined);
  }

  async function captureCreatedBookmark(bookmark, allowRecovery = true) {
    if (!isWebUrl(bookmark.url)) return;
    const openedAt = Date.now();
    const originalRevision = foregroundRevision;
    const capturedPolicy = previewPolicy;
    const canSave = () => capturedPolicy === previewPolicy;
    const stillForeground = () => canSave() && originalRevision === foregroundRevision;
    const tab = await getForegroundTab();
    if (!tab || !stillForeground() || !matchesPreviewAddress(bookmark.url, tab.url)) return;
    const { importingBookmarks } = await storage.local.get('importingBookmarks');
    if (importingBookmarks || !await isInitialPreviewEnabled() || !canSave()) return;
    const reservation = await reserveInitialBookmarkPreview(bookmark);
    if (!reservation) return;
    try {
      if (stillForeground()) {
        const identity = await getCaptureDocument(tab, { allowEarly: true, identityOnly: true,
          includeScrollPosition: true }).catch(() => undefined);
        if (identity && identity.atTop !== false && stillForeground()) {
          schedule(tab.id, tab.windowId);
          const saved = await captureFirstScreen(bookmark, tab, identity, openedAt + PAINT_WAIT, stillForeground, canSave)
            .catch(() => false);
          if (saved) return;
        }
      }
    } finally {
      reservation.release();
    }
    // The user saved this foreground page, but may have switched tabs before its first paint.
    // Retry the original URL in the same capture window used for bookmarks added from the new tab.
    if (allowRecovery && queueInitialBookmarkPreview && canSave()
      && !(await storage.local.get('importingBookmarks')).importingBookmarks) {
      await queueInitialBookmarkPreview(bookmark);
      await restored;
      if (canSave() && await needsInitialBookmarkPreview(bookmark) && canSave()) {
        if (missed.size >= NAVIGATION_SOURCE_LIMIT) missed.delete(missed.keys().next().value);
        missed.set(tab.id, { bookmark, expires: Date.now() + FIRST_SCREEN_RETRY_TTL });
        await persistMissed();
      }
    }
  }

  async function captureFirstScreen(bookmark, tab, identity, deadline, stillForeground, canSave) {
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    let retriedQuota = false;
    while (stillForeground() && Date.now() < deadline) {
      const fresh = await getForegroundTab(tab.id, tab.windowId);
      if (fresh?.url !== tab.url || !stillForeground()) return;
      const before = await getCaptureDocument(fresh, { allowEarly: true, trackViewport: true });
      if (!before) {
        await delay(PAINT_RETRY_DELAY);
        continue;
      }
      if (!sameCaptureDocument(identity, before) || !stillForeground() || !await isInitialPreviewEnabled()) return;

      const capturedAt = Date.now();
      let screenshot;
      try {
        if (!stillForeground()) return;
        screenshot = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 88 });
      } catch (error) {
        if (retriedQuota || !error?.message?.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) return;
        retriedQuota = true;
        await delay(CAPTURE_QUOTA_RETRY);
        continue;
      }
      if (!screenshot || !stillForeground()) return;
      const after = await getForegroundTab(tab.id, tab.windowId);
      if (after?.url !== tab.url || !sameCaptureViewport(before, await getCaptureDocument(after, { allowEarly: true }))
        || !stillForeground()) return;

      // Finishing the local write is safe once the new bookmark's actual frame has been verified.
      const blob = await encodeVisitPreview(screenshot);
      if (blob && await saveInitialBookmarkPreview(bookmark, blob, canSave, capturedAt)) {
        await browser.runtime.sendMessage({ visitPreviewUpdated: true }).catch(() => undefined);
        return true;
      }
      return;
    }
  }

  browser.runtime.onMessage.addListener((request, sender) => {
    const { bookmarkOpened, sameTabBookmarkUrl } = request ?? {};
    if (typeof bookmarkOpened !== 'string' || !isWebUrl(sameTabBookmarkUrl) || sender.id !== browser.runtime.id
      || sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || sender.tab.incognito) return;
    const page = (sender.url || '').replace(/^extension:/, 'chrome-extension:').split(/[?#]/)[0];
    if (page !== browser.runtime.getURL('newtab.html')) return;
    rememberPending({ ...sender.tab, pendingUrl: sameTabBookmarkUrl }, bookmarkOpened);
  });
  browser.bookmarks.onCreated.addListener((id, bookmark) => {
    captureCreatedBookmark({ id, url: bookmark.url }).catch(() => undefined);
  });
  browser.tabs.onCreated.addListener(tab => rememberPending(tab));
  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (tab.incognito || (!change.status && !change.url)) return;
    updateNavigationSource(tab, change);
    if (!tab.active) return;
    if (focusedWindow !== undefined && focusedWindow !== tab.windowId) return;
    if (change.url || (change.status === 'loading' && tab.pendingUrl)) foregroundRevision++;
    if (isWebUrl(tab.url)) schedule(tabId, tab.windowId);
    else if (target?.tabId === tabId || target?.windowId === tab.windowId) cancel();
  });
  browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
    if (focusedWindow !== undefined && focusedWindow !== windowId) return;
    foregroundRevision++;
    schedule(tabId, windowId);
    const activation = target;
    browser.tabs.get(tabId).then(tab => {
      if (target === activation) rememberPending(tab);
    }).catch(() => undefined);
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    navigationSources.delete(tabId);
    Promise.resolve(restored).then(() => { if (missed.delete(tabId)) return persistMissed(); });
    if (target?.tabId === tabId) cancel();
  });
  browser.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
    navigationSources.delete(removedTabId);
    if (target?.tabId === removedTabId) schedule(addedTabId, target.windowId);
  });
  browser.windows.onFocusChanged.addListener(windowId => {
    foregroundRevision++;
    focusedWindow = windowId < 0 ? undefined : windowId;
    if (windowId < 0) cancel();
    else schedule(undefined, windowId);
  });
  function resetPolicy() {
    previewPolicy++;
    Promise.resolve(restored).then(() => {
      if (!missed.size) return;
      missed.clear();
      return persistMissed();
    });
  }
  browser.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.visitPreviewEnabled) resetPolicy();
  });
  browser.permissions.onRemoved?.addListener(removed => {
    if (removed.origins?.length) resetPolicy();
  });
}
