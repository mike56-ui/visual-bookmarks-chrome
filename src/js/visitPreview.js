import ImageDB from './api/imageDB';
import { storage } from './api/storage';
import { $base64ToBlob } from './utils';
import { cacheDeclaredSiteIcon } from './siteIconCapture';

const CAPTURE_DELAY = 700;
const HOST_PERMISSION = { origins: ['<all_urls>'] };

export function isWebUrl(url) {
  try {
    const parsed = new URL(url);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

async function isBookmarked(url) {
  const bookmarks = await browser.bookmarks.search({ url });
  return bookmarks.some(bookmark => bookmark.url === url);
}

async function isEnabled() {
  const { visitPreviewEnabled } = await storage.local.get('visitPreviewEnabled');
  return visitPreviewEnabled === true && browser.permissions.contains(HOST_PERMISSION);
}

async function getForegroundTab(tabId, windowId) {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !tab.active || tab.incognito || tab.status !== 'complete' || !isWebUrl(tab.url)
    || tab.discarded
    || (tab.pendingUrl && tab.pendingUrl !== tab.url)
    || (tabId !== undefined && tabId !== tab.id)
    || (windowId !== undefined && windowId !== tab.windowId)
    || tab.splitViewId >= 0) return;
  const win = await browser.windows.get(tab.windowId);
  if (win.focused && !win.incognito && win.type === 'normal' && win.state !== 'minimized') return tab;
}

// Runs in the extension's isolated world and keeps the marker with the live document.
function inspectDocument(url, markTimeOrigin, includeIcons) {
  if (location.href !== url || document.readyState !== 'complete'
    || document.visibilityState !== 'visible') return null;
  if (!document.body || (!document.body.childElementCount && !document.body.textContent.trim())) return null;
  const timeOrigin = performance.timeOrigin;
  const alreadyCaptured = window.visualBookmarksCapturedVisit === url;
  if (markTimeOrigin === timeOrigin) window.visualBookmarksCapturedVisit = url;
  const links = includeIcons ? document.head?.querySelectorAll(
    'link[rel~="icon" i], link[rel="apple-touch-icon" i], link[rel="apple-touch-icon-precomposed" i]'
  ) : null;
  const icons = links ? Array.from(links).slice(0, 24).filter(link => link.href.length <= 2048
    && (!link.media || window.matchMedia(link.media).matches)).map(link => ({
    url: link.href, sizes: link.getAttribute('sizes')?.slice(0, 150) ?? '', type: link.type.slice(0, 64)
  })) : [];
  return { timeOrigin, alreadyCaptured, icons };
}

async function getDocument(tab, markTimeOrigin = null, includeIcons = false) {
  const [frame] = await browser.scripting.executeScript({
    target: { tabId: tab.id },
    func: inspectDocument,
    args: [tab.url, markTimeOrigin, includeIcons]
  });
  if (frame?.result) return { ...frame.result, id: frame.documentId };
}

function sameDocument(first, second) {
  return second && second.id === first.id && second.timeOrigin === first.timeOrigin;
}

async function thumbnail(dataUrl) {
  const bitmap = await createImageBitmap($base64ToBlob(dataUrl, 'image/jpeg'));
  try {
    const scale = Math.min(1, 960 / bitmap.width, 600 / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const options = { type: 'image/webp', quality: 0.82 };
    const blob = await canvas.convertToBlob(options);
    return blob.size <= ImageDB.MAX_VISIT_BYTES ? blob : canvas.convertToBlob({ ...options, quality: 0.58 });
  } finally {
    bitmap.close();
  }
}

export function registerVisitPreview() {
  let generation = 0;
  let timer;
  let target;

  function cancel() {
    clearTimeout(timer);
    target = undefined;
    generation++;
  }

  function schedule(tabId, windowId) {
    cancel();
    const current = generation;
    target = { tabId, windowId };
    timer = setTimeout(() => {
      // Tabs and windows can disappear between any of the browser API calls.
      capture(tabId, windowId, () => current === generation).catch(() => undefined);
    }, CAPTURE_DELAY);
  }

  async function capture(tabId, windowId, current) {
    const tab = await getForegroundTab(tabId, windowId);
    if (!tab || !current() || !await isEnabled() || !await isBookmarked(tab.url)) return;
    const before = await getDocument(tab);
    if (!before || before.alreadyCaptured || !current()) return;

    const fresh = await getForegroundTab(tab.id, tab.windowId);
    if (fresh?.url !== tab.url || !current()) return;
    const marked = await getDocument(tab, before.timeOrigin, true);
    if (!sameDocument(before, marked) || marked.alreadyCaptured || !current()) return;

    const screenshot = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 88 });
    if (!screenshot || !current()) return;
    const after = await getForegroundTab(tab.id, tab.windowId);
    if (after?.url !== tab.url || !sameDocument(before, await getDocument(tab)) || !current()) return;

    const blob = await thumbnail(screenshot);
    if (!current() || !await isEnabled() || !await isBookmarked(tab.url) || !current()) return;
    if (await ImageDB.putVisitPreview(tab.url, blob, current)) {
      await browser.runtime.sendMessage({ visitPreviewUpdated: true }).catch(() => undefined);
    }
    const origin = await cacheDeclaredSiteIcon(tab.url, marked.icons, current, isEnabled).catch(() => undefined);
    if (origin) await browser.runtime.sendMessage({ siteIconUpdated: origin }).catch(() => undefined);
  }

  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (!tab.active || tab.incognito || (!change.status && !change.url)) return;
    if (change.status === 'loading' && !change.url) {
      if (target?.tabId === tabId || target?.windowId === tab.windowId) cancel();
      return;
    }
    if (tab.status === 'complete' && isWebUrl(tab.url)) schedule(tabId, tab.windowId);
    else if (target?.tabId === tabId || target?.windowId === tab.windowId) cancel();
  });
  browser.tabs.onActivated.addListener(({ tabId, windowId }) => schedule(tabId, windowId));
  browser.tabs.onRemoved.addListener((tabId) => {
    if (target?.tabId === tabId) cancel();
  });
  browser.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
    if (target?.tabId === removedTabId) schedule(addedTabId, target.windowId);
  });
  browser.windows.onFocusChanged.addListener(windowId => {
    if (windowId < 0) cancel();
    else schedule(undefined, windowId);
  });
}
