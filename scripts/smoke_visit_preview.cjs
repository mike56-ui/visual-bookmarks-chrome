const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { webcrypto } = require('node:crypto');
const vm = require('node:vm');

async function checkInitialPreviewStorage() {
  const tables = new Map();
  const openDB = async name => {
    if (!tables.has(name)) tables.set(name, new Map());
    const records = tables.get(name);
    const store = {
      get: async key => records.get(key),
      put: async value => records.set(value.id ?? value.url, value)
    };
    return { get: (name, key) => store.get(key), put: (name, value) => store.put(value),
      transaction: () => ({ store, done: Promise.resolve() }) };
  };
  const context = vm.createContext({ crypto: webcrypto, console });
  const source = readFileSync(join(__dirname, '../src/js/api/imageDB.js'), 'utf8');
  const module = new vm.SourceTextModule(source, { context });
  await module.link(() => new vm.SyntheticModule(['openDB', 'deleteDB'], function() {
    this.setExport('openDB', openDB);
    this.setExport('deleteDB', name => tables.delete(name));
  }, { context }));
  await module.evaluate();
  const ImageDB = module.namespace.default;
  const url = 'https://example.test/shared';
  const bookmarks = ['existing', 'custom', 'new'].map(id => ({ id, url }));
  const [legacy, custom, initial, manual] = ['legacy', 'custom', 'initial', 'manual'].map(content => new Blob([content]));
  await ImageDB.update({ id: 'existing', url, blob: legacy, updated: 1 });
  await ImageDB.update({ id: 'custom', blob: custom, custom: true });
  assert.ok(await ImageDB.putVisitPreview(url, initial, () => true, 0, 100, { fillMissing: true }));
  assert.equal(await ImageDB.putVisitPreview(url, manual, () => true, 0, 200, { fillMissing: true }), false);
  const first = await ImageDB.getForBookmarks(bookmarks);
  assert.equal(first[0].blob, legacy, 'A shared initial preview must preserve a per-bookmark historical cover');
  assert.equal(first[1].blob, custom, 'A shared initial preview must preserve the separately uploaded cover');
  assert.equal(first[2].blob, initial, 'The empty duplicate can use the shared initial preview');

  const saved = tables.get(ImageDB.VISIT_DB);
  for (let index = 0; index < 512; index++) saved.set('past-' + index, { blob: initial });
  assert.ok(await ImageDB.putVisitPreview('https://example.test/one-more', initial, () => true, 0, 150,
    { fillMissing: true }));
  assert.equal(saved.size, 514, 'Adding a bookmark must not evict a saved first image');

  assert.ok(await ImageDB.putVisitPreview(url, manual, () => true, 1, 99),
    'An explicit refresh can replace a first image independently of save ordering');
  const refreshed = await ImageDB.getForBookmarks(bookmarks);
  assert.equal(refreshed[0].blob, manual);
  assert.equal(refreshed[1].blob, custom);
  assert.equal(refreshed[2].blob, manual);
}

module.exports = async function checkVisitPreview() {
  await checkInitialPreviewStorage();
  const listeners = {};
  const event = name => ({ addListener: listener => { listeners[name] = listener; } });
  const timers = new Map();
  const url = 'https://example.test/bookmark';
  let nextTimer = 0;
  const bookmarks = new Map();
  const cachedUrls = new Set();
  const storedCovers = new Set();
  const iconVisits = [];
  let enabled = true;
  let permitted = true;
  let importing = false;
  let goodDatabase = true;
  let focused = true;
  let tab = { id: 1, windowId: 1, active: true, status: 'complete', url };
  let documentId = 1;
  let readyState = 'complete';
  let painted = true;
  let rootScroll = 0;
  let mainScroll = 0;
  let renderedDocument;
  let frameWindow;
  const scrollListeners = new Set();
  let afterCapture;
  let duringEncode;
  let captures = 0;
  let encodes = 0;
  const writes = [];

  const chrome = {
    tabs: {
      onCreated: event('created'),
      onUpdated: event('updated'),
      onActivated: event('activated'),
      onRemoved: event('removed'),
      query: async() => [{ ...tab }],
      get: async() => ({ ...tab }),
      captureVisibleTab: async() => {
        captures++;
        afterCapture?.();
        return 'data:image/jpeg;base64,AA==';
      }
    },
    windows: {
      onFocusChanged: event('focused'),
      get: async() => ({ type: 'normal', state: 'normal', focused })
    },
    permissions: { contains: async() => permitted, onRemoved: event('permissionRemoved') },
    storage: { onChanged: event('settings') },
    bookmarks: {
      onCreated: event('bookmarkCreated'),
      onRemoved: event('bookmarkRemoved'),
      search: async({ url }) => [...bookmarks.values()].filter(bookmark => bookmark.url === url),
      get: async id => bookmarks.has(id) ? [bookmarks.get(id)] : []
    },
    scripting: {
      executeScript: async({ func, args }) => {
        if (renderedDocument !== documentId) {
          renderedDocument = documentId;
          scrollListeners.clear();
          frameWindow = {
            innerWidth: 800, innerHeight: 600,
            get scrollY() { return rootScroll; },
            addEventListener: (name, listener) => scrollListeners.add(listener),
            removeEventListener: (name, listener) => scrollListeners.delete(listener),
            setTimeout: () => 1, clearTimeout: () => {}
          };
        }
        context.location = { href: tab.url };
        const body = { childElementCount: 1 };
        const main = { parentElement: body, scrollTop: mainScroll, getBoundingClientRect: () => ({ width: 700, height: 580 }) };
        const head = { querySelectorAll: () => [{ href: new URL('/favicon.svg', tab.url).href,
          type: 'image/svg+xml', getAttribute: () => 'any' }] };
        context.document = { readyState, visibilityState: 'visible', body, head, elementFromPoint: () => main };
        context.performance = { timeOrigin: documentId, now: () => 10000,
          getEntriesByName: () => painted ? [{}] : [] };
        context.window = frameWindow;
        const result = func(...args);
        return [{ frameId: 0, documentId, result }];
      }
    },
    runtime: {
      id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`,
      onMessage: event('message'), sendMessage: async() => {}
    }
  };
  const context = vm.createContext({
    URL,
    browser: chrome,
    PerformanceObserver: { supportedEntryTypes: ['paint'] },
    setTimeout: callback => {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: handle => { timers.delete(handle); },
    createImageBitmap: async() => {
      encodes++;
      duringEncode?.();
      return { width: 1440, height: 900, close() {} };
    },
    OffscreenCanvas: class {
      getContext() { return { drawImage() {} }; }
      async convertToBlob() { return { size: 10 }; }
    }
  });
  const stubs = {
    './api/imageDB': {
      default: {
        MAX_VISIT_BYTES: 192 * 1024,
        latestLegacyCapture: async() => 0,
        readBookmarkPreviews: async items => ({ complete: goodDatabase, records: items.filter(bookmark =>
          cachedUrls.has(bookmark.url) || storedCovers.has(bookmark.id)) }),
        async putVisitPreview(address, blob, current, legacy, capturedAt, options) {
          assert.ok(current());
          assert.equal(options?.fillMissing, true);
          assert.ok(!cachedUrls.has(address));
          cachedUrls.add(address);
          writes.push({ address, blob });
          return true;
        }
      }
    },
    './api/storage': { storage: { local: {
      get: async() => ({ visitPreviewEnabled: enabled, importingBookmarks: importing })
    } } },
    './utils': { $base64ToBlob: () => ({}) },
    './siteIconCapture': { cacheDeclaredSiteIcon: async url => { iconVisits.push(url); } }
  };
  const source = readFileSync(join(__dirname, '../src/js/visitPreview.js'), 'utf8');
  const module = new vm.SourceTextModule(source, { context });
  await module.link(name => {
    const exports = stubs[name];
    return new vm.SyntheticModule(Object.keys(exports), function() {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  // Simulate Edge leaving the unfocused capture window occluded: it cannot save a usable frame.
  const attemptsFromWindow = [];
  module.namespace.registerVisitPreview(async bookmark => { attemptsFromWindow.push(bookmark.id); });

  const flush = async() => {
    for (const [id, callback] of timers) {
      timers.delete(id);
      callback();
    }
    await new Promise(resolve => setImmediate(resolve));
  };
  const visit = () => listeners.updated(tab.id, { status: 'complete' }, tab);
  const activate = () => listeners.activated({ tabId: tab.id, windowId: tab.windowId });

  const add = (id, address = tab.url) => {
    const bookmark = { id, url: address };
    bookmarks.set(id, bookmark);
    listeners.bookmarkCreated(id, bookmark);
    return bookmark;
  };
  const open = address => {
    documentId++;
    tab = { ...tab, url: address };
    listeners.updated(tab.id, { url: address, status: 'loading' }, tab);
  };

  bookmarks.set('existing-no-preview', { id: 'existing-no-preview', url });
  visit();
  activate();
  await flush();
  assert.ok(iconVisits.includes(url), 'Declared site icons can load without a screenshot');
  assert.equal(captures, 0, 'Opening a previously saved bookmark without an image must not fill it');

  enabled = false;
  add('disabled');
  await flush();
  enabled = true;
  permitted = false;
  add('ungranted');
  await flush();
  permitted = true;
  tab.incognito = true;
  add('private');
  await flush();
  tab.incognito = false;
  focused = false;
  add('unfocused');
  await flush();
  focused = true;
  importing = true;
  add('imported');
  await flush();
  importing = false;
  goodDatabase = false;
  add('unreadable');
  await flush();
  goodDatabase = true;
  add('different', url + '?different=1');
  await flush();
  assert.equal(captures, 0, 'Respect authorization, foreground identity, imports and database read failures');

  add('first-native-bookmark');
  add('second-native-bookmark');
  await flush();
  assert.equal(captures, 1, 'One screenshot for concurrent creates of the same URL');
  assert.equal(encodes, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].address, url);
  add('known-url');
  open(url);
  visit();
  activate();
  await flush();
  assert.equal(captures, 1, 'A cached URL is reused without capturing or encoding again');
  assert.equal(encodes, 1);
  assert.equal(writes.length, 1);

  open(url + '/custom');
  storedCovers.add('custom');
  add('custom');
  await flush();
  assert.equal(captures, 1, 'An available per-bookmark cover prevents initial screenshot');
  add('duplicate-without-cover');
  await flush();
  assert.equal(captures, 2, 'A new uncovered sibling can fill its own empty slot');

  open(url + '/slow');
  painted = false;
  add('first-slow');
  await flush();
  assert.equal(captures, 2, 'Await actual first paint even if readyState is complete');
  readyState = 'interactive';
  painted = true;
  await flush();
  assert.equal(captures, 3, 'The native bookmark event can save the first paint before load');
  assert.equal(writes.at(-1).address, tab.url);
  readyState = 'complete';
  visit();
  await flush();
  assert.equal(captures, 3, 'Full load never takes a second screenshot');

  open(url + '/missed');
  painted = false;
  const missed = add('missed');
  await flush();
  open(url + '/other');
  activate();
  open(missed.url);
  activate();
  painted = true;
  await flush();
  assert.equal(captures, 3, 'Do not follow a missed initial capture into the next visit');

  open(url + '/navigation-race');
  afterCapture = () => { documentId++; };
  add('navigation-race');
  await flush();
  assert.equal(captures, 4);
  assert.equal(writes.length, 3, 'Do not store a screenshot after the sampled document is replaced');

  open(url + '/scroll-race');
  afterCapture = () => {
    rootScroll = 460;
    for (const listener of scrollListeners) listener();
    rootScroll = 0;
  };
  add('scroll-race');
  await flush();
  assert.equal(captures, 5);
  assert.equal(writes.length, 3, 'Do not store a screenshot if it scrolled away mid-frame');
  afterCapture = undefined;

  open(url + '/nested');
  mainScroll = 700;
  add('nested');
  await flush();
  assert.equal(captures, 5, 'Reject a viewport-filling main scroller that is away from the top');
  open(url + '/encode-race');
  mainScroll = 0;
  duringEncode = () => listeners.focused(-1);
  add('encode-race');
  await flush();
  assert.equal(writes.length, 4, 'Returning after validated capture can finish a local write');
  duringEncode = undefined;

  open(url + '/auth-race');
  duringEncode = () => {
    listeners.settings({ visitPreviewEnabled: { newValue: false } }, 'local');
    listeners.settings({ visitPreviewEnabled: { newValue: true } }, 'local');
  };
  add('auth-race');
  await flush();
  assert.equal(writes.length, 4, 'Switching permission off and on invalidates the previous reservation');
  duringEncode = undefined;

  open(url + '/quota');
  afterCapture = () => {
    afterCapture = undefined;
    throw new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.');
  };
  add('quota');
  await flush();
  assert.equal(writes.length, 4);
  await flush();
  assert.equal(writes.at(-1).address, tab.url, 'A Chromium quota error can retry once on the same bookmarked page');

  async function missInitialFrame(id) {
    open(url + '/' + id);
    tab.id = 1;
    focused = true;
    painted = false;
    const bookmark = add(id);
    await flush();
    tab = { ...tab, id: 2, url };
    activate();
    painted = true;
    await flush();
    assert.ok(attemptsFromWindow.includes(id), 'Fixture must have attempted to capture the saved page in the background');
    assert.ok(!cachedUrls.has(bookmark.url), 'The capture window could not supply an image');
    return bookmark;
  }
  async function reactivateSource(bookmark) {
    tab = { ...tab, id: 1, url: bookmark.url };
    activate();
    await flush();
    await flush();
  }
  const beforeReturn = captures;
  const retry = await missInitialFrame('recover-on-return');
  activate();
  await flush();
  assert.equal(captures, beforeReturn, 'An unrelated active tab must never be captured');
  await reactivateSource(retry);
  assert.equal(captures, beforeReturn + 1, 'Returning to the source must recover its missing first image');
  assert.ok(cachedUrls.has(retry.url));
  await reactivateSource(retry);
  assert.equal(captures, beforeReturn + 1, 'A recovered first image remains cached');

  const failedAgain = await missInitialFrame('single-chance');
  afterCapture = () => { throw new Error('Edge cannot provide this frame'); };
  await reactivateSource(failedAgain);
  assert.equal(captures, beforeReturn + 2);
  afterCapture = undefined;
  const attemptsAfterFailure = attemptsFromWindow.length;
  await reactivateSource(failedAgain);
  assert.equal(captures, beforeReturn + 2, 'Do not retry a failed recovery on every visit');
  assert.equal(attemptsFromWindow.length, attemptsAfterFailure, 'Recovery must not reopen the capture window');

  for (const reason of ['removed', 'covered', 'opt-out', 'revoked', 'import']) {
    const bookmark = await missInitialFrame('cancel-' + reason);
    if (reason === 'removed') {
      bookmarks.delete(bookmark.id);
      listeners.bookmarkRemoved?.(bookmark.id, { node: bookmark });
    }
    if (reason === 'covered') storedCovers.add(bookmark.id);
    if (reason === 'opt-out') {
      enabled = false;
      listeners.settings({ visitPreviewEnabled: { newValue: false } }, 'local');
      enabled = true;
      listeners.settings({ visitPreviewEnabled: { newValue: true } }, 'local');
    }
    if (reason === 'revoked') {
      permitted = false;
      listeners.permissionRemoved({ origins: ['<all_urls>'] });
      permitted = true;
    }
    importing = reason === 'import';
    await reactivateSource(bookmark);
    importing = false;
    assert.equal(captures, beforeReturn + 2, 'Cancelled recovery must not capture: ' + reason);
  }
  console.log('PASS one foreground recovery for a missed new bookmark; other tabs, revoked access, imports and existing covers protected');

  const redirected = module.namespace.matchesNavigatedPreviewAddress;
  const original = url + '?doc=1&utm_source=x&doc=2#summary';
  const landing = url + '/?doc=1&doc=2#summary';
  assert.ok(redirected(original, landing));
  for (const changed of [
    url + '?doc=2&doc=1#summary', url + '?doc=1&doc=2&ut_m=new#summary',
    url + '//?doc=1&doc=2#summary', url + '?doc=1&doc=2#edit',
    landing.replace('example.test', 'other.test'), landing.replace('https:', 'http:')
  ]) assert.equal(redirected(original, changed), false, changed);

  console.log('PASS: initial bookmark events only, cache sharing, early first paint, authorization and navigation races');
};
