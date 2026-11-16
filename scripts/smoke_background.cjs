// Exercise the production worker as an ES module, with no pre-existing `browser` global.
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');

async function check(existingBrowser = false) {
  const listeners = {};
  const event = name => ({ addListener: listener => { listeners[name] = listener; } });
  const page = 'chrome-extension://test-extension/newtab.html';
  let tabs = [{ id: 1, url: 'edge://newtab/' }, { id: 2 }];
  const actions = [];
  const api = {
    i18n: { getMessage: key => key },
    runtime: { getURL: path => `chrome-extension://test-extension/${path}`,
      onInstalled: event('installed'), onMessage: event('message') },
    storage: { onChanged: event('storage') },
    bookmarks: Object.fromEntries(['onCreated', 'onChanged', 'onRemoved', 'onMoved', 'onImportBegan', 'onImportEnded']
      .map(name => [name, event(name)])),
    contextMenus: { onClicked: event('contextMenu') },
    action: { onClicked: event('action') },
    notifications: { onClicked: event('notification'), onButtonClicked: event('notificationButton') },
    tabs: {
      onCreated: event('tabCreated'),
      query: (options, callback) => callback(tabs),
      update: (id, options) => actions.push({ kind: 'activate', id, ...options }),
      create: options => actions.push({ kind: 'create', ...options })
    }
  };
  const context = vm.createContext({ chrome: api, console, crypto: webcrypto, setTimeout, clearTimeout,
    ...(existingBrowser ? { browser: api } : {}) });
  const worker = new vm.SourceTextModule(readFileSync('extension_chrome/background.js', 'utf8'), { context });
  await worker.link(() => { throw Error('Unexpected external dependency in worker'); });
  await worker.evaluate();
  assert.equal(context.browser, api);
  assert.equal(typeof listeners.installed, 'function');
  assert.equal(typeof listeners.action, 'function');

  listeners.action();
  assert.equal(actions.pop().url, page, 'An old Edge new tab must open the actual bookmark page');
  tabs = [{ id: 3, url: 'chrome://newtab/' }];
  listeners.action();
  assert.equal(actions.pop().kind, 'create');
  tabs = [{ id: 4, url: `${page}#folder` }];
  listeners.action();
  assert.equal(actions.pop().id, 4, 'Reuse the extension page');
  tabs = [{ id: 5, url: page.replace('chrome-extension:', 'extension:') }];
  listeners.action();
  assert.equal(actions.pop().id, 5, 'Reuse the Edge extension URL alias');
}

(async () => {
  await check();
  await check(true);
  console.log('PASS: production module startup, event registration, toolbar opening and page reuse');
})().catch(error => { console.error(error); process.exitCode = 1; });
