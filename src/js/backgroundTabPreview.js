import {
  encodeVisitPreview, isWebUrl, matchesNavigatedPreviewAddress, sameCaptureDocument
} from './visitPreview';

const TIME_LIMIT = 23000;
const POLL_INTERVAL = 350;
const STABLE_TIME = 750;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Runs in the isolated world of the temporary tab. Hidden documents often have no FCP entry.
function inspectFirstScreen(expected) {
  if (location.href !== expected) return;
  const status = performance.getEntriesByType('navigation')[0]?.responseStatus;
  if (status >= 400) return { httpStatus: status };
  const body = document.body;
  if (!body || !innerWidth || !innerHeight || document.visibilityState !== 'hidden') return;
  const root = document.scrollingElement;
  const atStart = offset => Math.abs(offset || 0) <= 2;
  if (!atStart(scrollY) || !atStart(root?.scrollTop) || !atStart(visualViewport?.pageTop)) {
    window.scrollTo({ top: 0, behavior: 'instant' });
    return;
  }
  let panel = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  while (panel && panel !== body && panel !== document.documentElement) {
    if (!atStart(panel.scrollTop)) {
      const rect = panel.getBoundingClientRect();
      if (rect.width >= innerWidth / 2 && rect.height >= innerHeight / 2) {
        panel.scrollTo({ top: 0, behavior: 'instant' });
        return;
      }
    }
    panel = panel.parentElement;
  }
  // A small, viewport-local sample avoids waiting on ads, footers or the window load event.
  // The center hit targets supplement the traversal on sites with large menus or deeply nested markup.
  const candidates = new Set();
  const mainSelector = 'main, [role="main"]';
  let main = document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest(mainSelector)
    || document.querySelector(mainSelector);
  if (main && !main.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) main = null;
  const seeds = [main, body];
  for (const y of [0.22, 0.5, 0.78]) {
    for (const x of [0.2, 0.5, 0.8]) {
      let hit = document.elementFromPoint(innerWidth * x, innerHeight * y);
      for (let depth = 0; hit && depth < 8; depth++, hit = hit.parentElement) candidates.add(hit);
    }
  }
  for (const seed of seeds) {
    if (!seed) continue;
    const walker = document.createTreeWalker(seed, NodeFilter.SHOW_ELEMENT);
    let element = seed;
    for (let n = 0; element && n < 100; n++, element = walker.nextNode()) candidates.add(element);
  }
  const viewportArea = innerWidth * innerHeight;
  const loadingName = /(?:^|[\s_-])(?:skeleton|shimmer|spinner|preloader|loader|loading)(?:$|[\s_-])/i;
  const loadingText = /^(?:loading(?:\s+(?:content|page|data|images?)|\s+.{1,36}(?=…|\.\.\.))?|please wait|(?:正在)?加载(?:中|页面|内容|数据)?|(?:页面|内容|数据)加载中|请稍候|请稍等)[\s.…。!！]*$/i;
  const content = [];
  let mainSignals = 0;
  let primaryText = 0;
  let centralLoader = false;
  let blocked = false;
  for (const el of candidates) {
    if (/^(?:SCRIPT|STYLE|LINK|META|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) continue;
    const width = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    const area = width * height / viewportArea;
    const isImage = el.tagName === 'IMG';
    if (!area && !(isImage && width >= innerWidth / 3)) continue;
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const cx = (rect.left + rect.right) / (2 * innerWidth);
    const cy = (rect.top + rect.bottom) / (2 * innerHeight);
    const inCenter = cx > .2 && cx < .8 && cy > .15 && cy < .85;
    const inMain = (!main || main.contains(el)) && !el.closest('nav, aside, footer, [role="navigation"]');
    let words = '';
    for (let child = el.firstChild, n = 0; child && n < 10; child = child.nextSibling, n++) {
      if (child.nodeType === Node.TEXT_NODE) words += ' ' + child.textContent.slice(0, 100);
    }
    words = words.trim();
    const names = (el.id + ' ' + (el.getAttribute('class') || '')).slice(0, 300).replace(/([a-z])([A-Z])/g, '$1-$2');
    const loadingMessage = loadingText.test(words) || loadingText.test(el.getAttribute('aria-label') || '');
    const marked = el.matches('[aria-busy="true"],[role="progressbar"],progress') || loadingName.test(names)
      || loadingMessage;
    if (marked) {
      if (area >= .15) blocked = true;
      if (inMain && (inCenter || (loadingMessage && width >= innerWidth / 3))) centralLoader = true;
      continue;
    }
    let media = '';
    if (isImage) {
      const placeholder = el.naturalWidth <= 2 && el.matches('[data-src], [data-srcset], [data-original]');
      if (!el.complete || !el.naturalWidth || placeholder) {
        if (area >= .06 || (!height && width >= innerWidth / 3)) {
          // Hidden tabs may withhold native lazy images until their first compositor frame.
          if (el.loading === 'lazy') el.loading = 'eager';
          blocked = true;
        }
      } else if (area >= .015) media = el.currentSrc.slice(-64);
    } else if (area >= .035 && /^(CANVAS|SVG|svg|IFRAME|VIDEO)$/.test(el.tagName)) {
      media = el.tagName;
    } else if (area >= .10) {
      const background = getComputedStyle(el).backgroundImage;
      if (background.includes('url(')) {
        media = 'background';
        // Computed single-layer URLs are absolute. Resource Timing lists completed requests,
        // including memory-cache hits. Querying it does not download or decode an image again.
        const single = /^url\("?(https?:\/\/[^"]*?)"?\)$/.exec(background);
        if (single && area >= .18 && (inMain || el === body || el === document.documentElement || el.contains(main))) {
          const address = single[1].split('#')[0];
          const entries = performance.getEntriesByName(address, 'resource');
          if (!entries.some(entry => entry.responseEnd > 0 && !(entry.responseStatus >= 400))) blocked = true;
        }
      }
    }
    if (!words && !media) continue;
    const banner = el.closest('header, [role="banner"]');
    const headerOnly = banner && !main?.contains(banner) && banner.getBoundingClientRect().height < innerHeight / 2;
    if (inMain && !headerOnly) {
      mainSignals++;
      primaryText += words.length;
    }
    if (content.length < 12) content.push([el.tagName, Math.round(width / 48), Math.round(height / 48),
      words.replace(/\d+/g, '#').slice(0, 36), media]);
  }
  const ready = !blocked && mainSignals > 0
    && !(centralLoader && mainSignals < 3 && primaryText < 80);
  return {
    timeOrigin: performance.timeOrigin, width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio || 1,
    signature: ready ? JSON.stringify(content) : ''
  };
}

async function firstScreen(tabId, url) {
  const [frame] = await browser.scripting.executeScript({
    target: { tabId }, injectImmediately: true, func: inspectFirstScreen, args: [url]
  }).catch(() => []);
  if (frame?.result?.httpStatus) {
    const error = new Error(`Preview page returned HTTP ${frame.result.httpStatus}`);
    error.httpStatus = frame.result.httpStatus;
    throw error;
  }
  if (frame?.documentId && frame.result) return { ...frame.result, id: frame.documentId, url };
}

// A compositor may return a valid JPEG before it has painted any content.
async function hasVisibleDetail(blob) {
  const image = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(96, 64);
    const ctx = canvas.getContext('2d');
    // Omit the browser scrollbar, which otherwise looks like content on an empty page.
    ctx.drawImage(image, 0, 0, Math.max(1, image.width - 24), image.height, 0, 0, canvas.width, canvas.height);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const low = [255, 255, 255];
    const high = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        low[c] = Math.min(low[c], data[i + c]);
        high[c] = Math.max(high[c], data[i + c]);
        if (high[c] - low[c] >= 12) return true;
      }
    }
    return false;
  } finally {
    image.close();
  }
}

export async function captureBackgroundTab({ url, windowId, wait = 0, current = () => true }) {
  if (!isWebUrl(url) || !current() || !browser.debugger || !Number.isInteger(windowId)) return;
  const win = await browser.windows.get(windowId).catch(() => undefined);
  if (!win || win.type !== 'normal' || win.incognito || !current()) return;

  // tabs.create clamps its index to the current strip length, including simultaneous insertions.
  const tab = await browser.tabs.create({
    windowId, url: 'about:blank', active: false, index: 0x7fffffff
  }).catch(() => undefined);
  if (!Number.isInteger(tab?.id)) return;
  const target = { tabId: tab.id };
  let taken = false;
  let stopped = false;
  let navigating = false;
  let landed = false;
  let attached = false;
  let finishing = false;
  let interrupt;
  const stoppedPromise = new Promise(resolve => {
    interrupt = resolve;
  });
  const stop = () => {
    stopped = true;
    interrupt();
  };
  const takeOver = id => {
    if (id === tab.id) {
      taken = true;
      stop();
    }
  };
  const onActivate = ({ tabId }) => takeOver(tabId);
  const onReplace = (_, oldId) => takeOver(oldId);
  const onDetachDebugger = (source, reason) => {
    if (attached && source.tabId === tab.id && reason === 'canceled_by_user') stop();
  };
  const observe = (id, change, state) => {
    if (id !== tab.id) return;
    if (state.active || state.highlighted || state.pinned || state.windowId !== windowId || state.splitViewId >= 0) {
      takeOver(id);
      return;
    }
    if (state.discarded) {
      stop();
      return;
    }
    const addresses = [change.url || state.url, state.pendingUrl].filter(Boolean);
    for (const address of addresses) {
      if (address === 'about:blank' && !landed) continue;
      if (navigating && matchesNavigatedPreviewAddress(url, address)) continue;
      // Login pages and client-side redirects may navigate an untouched tab after its first commit.
      // Actual user adoption is tracked independently through browser tab events.
      stop();
      return;
    }
    if (navigating && matchesNavigatedPreviewAddress(url, state.url)) landed = true;
  };
  const listeners = [
    [browser.tabs.onActivated, onActivate], [browser.tabs.onMoved, takeOver],
    [browser.tabs.onDetached, takeOver], [browser.tabs.onRemoved, takeOver],
    [browser.tabs.onReplaced, onReplace], [browser.tabs.onUpdated, observe],
    [browser.debugger.onDetach, onDetachDebugger]
  ];
  for (const [event, listener] of listeners) event.addListener(listener);
  const deadline = setTimeout(stop, TIME_LIMIT);
  const cancellation = setInterval(() => {
    if (!current()) stop();
  }, POLL_INTERVAL);
  const live = () => !stopped && current();
  const bounded = promise => Promise.race([promise, stoppedPromise]);
  async function owned() {
    if (!live()) return;
    const fresh = await bounded(browser.tabs.get(tab.id));
    if (fresh) observe(tab.id, {}, fresh);
    if (live()) return fresh;
  }
  async function inspect() {
    const fresh = await owned();
    if (!fresh || !matchesNavigatedPreviewAddress(url, fresh.url)
      || (fresh.pendingUrl && fresh.pendingUrl !== fresh.url)) return;
    return bounded(firstScreen(tab.id, fresh.url));
  }
  const detach = () => browser.debugger.detach(target).catch(() => undefined);
  const release = async() => {
    if (!attached) return;
    attached = false;
    await detach();
  };
  const attach = async() => {
    if (!attached && live()) {
      await bounded(browser.debugger.attach(target, '1.3').then(() => {
        attached = true;
        if (finishing) return detach();
      }));
    }
    return attached && live();
  };
  const sameScreen = (a, b) => sameCaptureDocument(a, b) && a.url === b.url
    && a.width === b.width && a.height === b.height && a.pixelRatio === b.pixelRatio && a.signature === b.signature;
  let interruptedFrames = 0;
  const takeFrame = async(screen, probe) => {
    const pixels = width => width / (screen.width * screen.pixelRatio);
    const scale = probe ? Math.min(1, pixels(120)) :
      Math.min(1, pixels(1200), 800 / (screen.height * screen.pixelRatio));
    const timedOut = Symbol();
    let timer;
    try {
      const result = await bounded(Promise.race([
        browser.debugger.sendCommand(target, 'Page.captureScreenshot', {
          format: 'jpeg', quality: probe ? 30 : 88, fromSurface: true, captureBeyondViewport: !interruptedFrames,
          clip: { x: 0, y: 0, width: screen.width, height: screen.height, scale }
        }),
        new Promise(resolve => {
          timer = setTimeout(() => resolve(timedOut), 2500);
        })
      ]));
      if (result !== timedOut) return result;
      // A hidden compositor can stall on a surface read. Detach cancels that command
      // before retrying the visible viewport of this same verified tab.
      interruptedFrames++;
      await release();
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    if (!await owned()) return;
    await bounded(browser.tabs.update(tab.id, { muted: true }));
    if (!await owned()) return;
    navigating = true;
    await bounded(browser.tabs.update(tab.id, { url }));
    const minimumWait = Math.min(15000, Math.max(0, Number(wait) || 0));
    let previous;
    let documentSince = 0;
    let stableSince = 0;
    let lastProbe = 0;
    let probes = 0;
    while (live()) {
      const sample = await inspect();
      const now = Date.now();
      if (sample && !sameCaptureDocument(previous, sample)) documentSince = now;
      if (!sameScreen(previous, sample)) stableSince = now;
      previous = sample;
      const ready = sample?.signature && now - stableSince >= STABLE_TIME && now - documentSince >= minimumWait;
      // Hidden Edge tabs can defer rAF and IntersectionObserver until the compositor draws a frame.
      // These small frames only advance painting; their pixels never enter the thumbnail cache.
      const probe = sample && !sample.signature && now - documentSince >= 1500 && now - lastProbe >= 2000 && probes < 4;
      if ((ready || probe) && await attach()) {
        const before = await inspect();
        if (sameScreen(sample, before) && live()) {
          const capturedAt = Date.now();
          if (probe) {
            lastProbe = capturedAt;
            probes++;
            await takeFrame(before, true);
            // A slow page can keep loading without holding an attached debugger between probes.
            await release();
          } else {
            const result = await takeFrame(before, false);
            if (!live() || interruptedFrames >= 3) return;
            if (!result?.data) continue;
            if (sameScreen(before, await inspect()) && live()) {
              const blob = await bounded(encodeVisitPreview('data:image/jpeg;base64,' + result.data));
              if (blob && await bounded(hasVisibleDetail(blob)) && live()) return { blob, capturedAt };
            }
            stableSince = Date.now();
          }
        }
      }
      await bounded(delay(POLL_INTERVAL));
    }
  } catch (error) {
    if (error?.httpStatus && live()) throw error;
  } finally {
    finishing = true;
    clearTimeout(deadline);
    clearInterval(cancellation);
    try {
      await release();
      const fresh = await browser.tabs.get(tab.id).catch(() => undefined);
      if (fresh) {
        observe(tab.id, {}, fresh);
        if (!taken) await browser.tabs.remove(tab.id).catch(() => undefined);
        else if (fresh.mutedInfo?.extensionId === browser.runtime.id) {
          await browser.tabs.update(tab.id, { muted: false }).catch(() => undefined);
        }
      }
    } finally {
      for (const [event, listener] of listeners) event.removeListener(listener);
    }
  }
}
