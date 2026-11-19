const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

module.exports = async function checkPreviewCleanup() {
  const active = 'https://example.test/active';
  const edited = 'https://example.test/old-address';
  const readded = 'https://example.test/readded';
  const saved = new Set([active]);
  const previews = new Set([active, edited, readded]);
  const searched = [];
  const listeners = {};
  const timers = new Map();
  let nextTimer = 0;
  let scans = 0;
  const event = name => ({ addListener: fn => { listeners[name] = fn; } });
  const quietEvent = { addListener() {} };
  const browser = {
    runtime: { onInstalled: event('installed'), onMessage: quietEvent,
      getManifest: () => ({ version: '7.7.7' }), sendMessage: async() => {} },
    storage: { onChanged: quietEvent },
    bookmarks: {
      ...Object.fromEntries(['onCreated', 'onChanged', 'onRemoved', 'onMoved'].map(name => [name, event(name)])),
      getTree: async() => [{ children: [{ children: [...saved].map(url => ({ url })) }] }],
      search: async({ url }) => { searched.push(url); return saved.has(url) ? [{ url }] : []; }
    },
    tabs: { query: async() => [], onCreated: quietEvent },
    contextMenus: { onClicked: quietEvent }, action: { onClicked: quietEvent },
    notifications: { onClicked: quietEvent, onButtonClicked: quietEvent }
  };
  const dependencies = {
    './api/imageDB': { default: {
      deleteMismatchedThumbnail: async() => {},
      getVisitPreviewUrls: async() => { scans++; return [...previews]; },
      deleteVisitPreview: async(url, current) => {
        if (url === readded && !saved.has(url)) {
          saved.add(url);
          listeners.onCreated('recreated', { url });
        }
        if (!current()) return false;
        previews.delete(url);
        return true;
      }
    } },
    './api/bookmark': { create() {}, search() {},
      flattenArrayBookmarks: function flatten(nodes) { return nodes.flatMap(node => node.children ? flatten(node.children) : node); } },
    './api/storage': { storage: { local: { get: async() => ({}), set: async() => {} } } },
    './constants': { FIREFOX_BROWSER: true, NEWTAB_URLS: [], NEWTAB_EMPTY_URLS: [] },
    './utils': { $notifications() {} }, './settings': { settings: {} }, './usageWorker': {},
    './plugins/browserContextMenu': { default: { init() {} } },
    './visitPreview': { registerVisitPreview() {} },
    './manualPreview': { queueInitialBookmarkPreview() {}, registerManualPreviews() {} }
  };
  const context = vm.createContext({ browser, console,
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id) });
  const source = readFileSync(join(__dirname, '../src/js/background.js'), 'utf8');
  const worker = new vm.SourceTextModule(source, { context });
  await worker.link(name => new vm.SyntheticModule(Object.keys(dependencies[name]), function() {
    for (const [key, value] of Object.entries(dependencies[name])) this.setExport(key, value);
  }, { context }));
  await worker.evaluate();

  const flush = async() => {
    for (const [id, callback] of timers) { timers.delete(id); callback(); }
    await new Promise(resolve => setImmediate(resolve));
  };
  listeners.onCreated('new', { url: active });
  listeners.onChanged('renamed', { title: 'Updated title' });
  await flush();
  assert.equal(scans, 0, 'Saving or renaming a bookmark does not trigger a global scan');

  listeners.onChanged('edited-a', { url: active });
  listeners.onChanged('edited-b', { url: active });
  assert.equal(timers.size, 1, 'Multiple URL edits must share a delayed scan');
  await flush();
  assert.equal(scans, 1);
  assert.deepEqual([...previews], [active, readded]);
  assert.deepEqual(searched, [edited, readded, readded], 'Recheck concurrent recreation without querying URLs found in the tree');
  await flush();

  previews.add(edited);
  await listeners.installed({ reason: 'update', previousVersion: '7.7.6.7' });
  await flush();
  assert.equal(previews.has(edited), false, 'The one-time version migration also sweeps old orphans');
  assert.ok(previews.has(active) && previews.has(readded));
  console.log('PASS: orphan preview key cleanup coalesces edits and protects concurrent bookmark recreation');
};
