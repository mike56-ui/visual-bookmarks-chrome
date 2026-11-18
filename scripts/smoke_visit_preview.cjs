const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

module.exports = async function checkVisitPreview() {
  const listeners = {};
  const event = name => ({ addListener: listener => { listeners[name] = listener; } });
  const timers = new Map();
  const url = 'https://example.test/bookmark';
  let nextTimer = 0;
  let enabled = true;
  let permitted = true;
  let focused = true;
  let tab = { id: 1, windowId: 1, active: true, status: 'complete', url };
  let documentId = 1;
  let afterCapture;
  let duringEncode;
  let captures = 0;
  const markers = new Map();
  const writes = [];

  const chrome = {
    tabs: {
      onUpdated: event('updated'),
      onActivated: event('activated'),
      onRemoved: event('removed'),
      query: async() => [{ ...tab }],
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
    permissions: { contains: async() => permitted },
    bookmarks: { search: async() => [{ id: '1', url }] },
    scripting: {
      executeScript: async({ func, args }) => {
        context.location = { href: tab.url };
        context.document = { readyState: tab.status, visibilityState: 'visible', body: { childElementCount: 1 } };
        context.performance = { timeOrigin: documentId };
        context.window = { visualBookmarksCapturedVisit: markers.get(documentId) };
        const result = func(...args);
        markers.set(documentId, context.window.visualBookmarksCapturedVisit);
        return [{ frameId: 0, documentId, result }];
      }
    },
    runtime: { sendMessage: async() => {} }
  };
  const context = vm.createContext({
    URL,
    browser: chrome,
    setTimeout: callback => {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: handle => { timers.delete(handle); },
    createImageBitmap: async() => {
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
        async putVisitPreview(address, blob, current) {
          assert.ok(current());
          writes.push({ address, blob });
          return true;
        }
      }
    },
    './api/storage': { storage: { local: { get: async() => ({ visitPreviewEnabled: enabled }) } } },
    './utils': { $base64ToBlob: () => ({}) },
    './siteIconCapture': { cacheDeclaredSiteIcon: async() => undefined }
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
  module.namespace.registerVisitPreview();

  const flush = async() => {
    for (const [id, callback] of timers) {
      timers.delete(id);
      callback();
    }
    await new Promise(resolve => setImmediate(resolve));
  };
  const visit = () => listeners.updated(tab.id, { status: 'complete' }, tab);
  const activate = () => listeners.activated({ tabId: tab.id, windowId: tab.windowId });

  enabled = false;
  visit();
  await flush();
  enabled = true;
  permitted = false;
  visit();
  await flush();
  permitted = true;
  tab.incognito = true;
  activate();
  await flush();
  tab.incognito = false;
  focused = false;
  visit();
  await flush();
  focused = true;
  tab.url = `${url}?different=1`;
  visit();
  await flush();
  assert.equal(captures, 0, 'Disabled, ungranted, private, unfocused and inexact pages are ignored');

  tab.url = url;
  visit();
  activate();
  await flush();
  visit();
  await flush();
  assert.equal(captures, 1, 'Duplicate events capture one document once');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].address, url);

  documentId++;
  afterCapture = () => { documentId++; };
  visit();
  await flush();
  assert.equal(captures, 2);
  assert.equal(writes.length, 1, 'A same-address document replacement during capture is discarded');

  afterCapture = undefined;
  duringEncode = () => listeners.focused(-1);
  visit();
  await flush();
  assert.equal(captures, 3);
  assert.equal(writes.length, 1, 'Focus changes during image encoding prevent cache writes');

  duringEncode = undefined;
  documentId++;
  visit();
  await flush();
  assert.equal(captures, 4);
  assert.equal(writes.length, 2, 'A later visit captures a fresh document');
  console.log('PASS: foreground visit gate, exact match, document dedupe and navigation races');
};
