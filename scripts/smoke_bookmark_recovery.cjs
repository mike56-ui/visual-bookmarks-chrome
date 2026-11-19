const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const build = path.resolve(process.env.VB_TEST_EXTENSION || 'extension_chrome');
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].find(existsSync);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const card = id => `#bookmarks .bookmark[data-id="${id}"]`;

async function openPage(browser, url, errors) {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  return page;
}

async function waitForOptions(page) {
  await page.waitForFunction(() => document.getElementById('ext_version')?.textContent
    && document.getElementById('import'));
}

async function setToggle(page, key, value) {
  await page.$eval(`#${key}`, (field, checked) => {
    field.checked = checked;
    field.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

(async () => {
  if (!executablePath) throw new Error('Set PUPPETEER_EXECUTABLE_PATH to an Edge executable');
  assert.ok(existsSync(path.join(build, 'manifest.json')), `No built extension at ${build}`);
  // Puppeteer creates a fresh temporary user data directory for this browser.
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: [`--disable-extensions-except=${build}`, `--load-extension=${build}`]
  });
  const errors = [];
  try {
    const target = await browser.waitForTarget(candidate => candidate.type() === 'service_worker');
    const extension = target.url().replace(/\/background\.js$/, '/');
    const pageUrl = extension + 'newtab.html';
    const page = await openPage(browser, pageUrl, errors);
    await page.waitForSelector('#folderDockList .folder-card');
    const data = await page.evaluate(async () => {
      const [tree] = await chrome.bookmarks.getTree();
      const root = tree.children[0].id;
      const folder = await chrome.bookmarks.create({ parentId: root, title: 'Recovery fixture folder' });
      const add = (parentId, title, location) => chrome.bookmarks.create({
        parentId, title, url: `http://127.0.0.1:9/${location}`
      });
      const [keep, remove, fallback] = await Promise.all([
        add(folder.id, 'Keep', 'keep'), add(folder.id, 'Undo', 'undo'), add(root, 'Root fallback', 'root')
      ]);
      return { root, folder: folder.id, keep: keep.id, remove: remove.id, fallback: fallback.id };
    });
    // Start with a fresh document after the native fixture-import events.
    await page.goto('about:blank');
    await page.goto(pageUrl + '#' + data.folder);
    await page.waitForSelector(card(data.keep));
    await page.waitForSelector(card(data.remove));

    await page.keyboard.down('Control');
    try { await page.click(`${card(data.keep)} .bookmark__title`); }
    finally { await page.keyboard.up('Control'); }
    await page.waitForSelector(`${card(data.keep)}[data-selected]`);
    await page.waitForSelector('#bookmarks-panel');
    await page.$eval(card(data.keep), element => { window.recoverySelectedCard = element; });
    await page.evaluate(id => chrome.bookmarks.update(id, { title: 'Undo renamed' }), data.remove);
    await page.waitForFunction(id => document.querySelector(`#bookmarks [data-id="${id}"]`)?.title === 'Undo renamed', {}, data.remove);
    assert.equal(await page.$eval(card(data.keep), element => element === window.recoverySelectedCard
      && element.hasAttribute('data-selected') && !!document.querySelector('#bookmarks-panel')), true);

    await page.evaluate(id => chrome.bookmarks.update(id, { title: 'Keep renamed' }), data.keep);
    await page.waitForFunction(id => {
      const el = document.querySelector(`#bookmarks [data-id="${id}"]`);
      return el === window.recoverySelectedCard && el?.title === 'Keep renamed'
        && !el.hasAttribute('data-selected') && !document.querySelector('#bookmarks-panel');
    }, {}, data.keep);
    console.log('PASS native refresh closes stale selection and shows fresh bookmark data');

    const startDelete = Date.now();
    await page.$eval(`${card(data.remove)} .bookmark__delete`, button => button.click());
    await page.waitForSelector('.toast__action[data-action]');
    await page.evaluate(id => chrome.bookmarks.update(id, { title: 'Keep renamed again' }), data.keep);
    await page.waitForFunction(id => document.querySelector(`#bookmarks [data-id="${id}"]`)?.title === 'Keep renamed again', {}, data.keep);
    assert.equal(await page.$(card(data.remove)), null, 'A native refresh must not resurrect the pending deletion');
    assert.equal(await page.evaluate(async id => (await chrome.bookmarks.get(id)).length, data.remove), 1);
    await page.click('.toast__action[data-action]');
    await page.waitForSelector(`${card(data.remove)}:not([hidden])`);
    await delay(Math.max(0, startDelete + 8500 - Date.now()));
    assert.equal(await page.evaluate(async id => (await chrome.bookmarks.get(id)).length, data.remove), 1);
    console.log('PASS pending delete survives refresh and undo preserves the original native bookmark');

    const failedCache = await browser.newPage();
    failedCache.on('pageerror', error => errors.push(error.message));
    await failedCache.evaluateOnNewDocument(() => {
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function(name, ...args) {
        if (name === 'visual-bookmarks' || name === 'visual-bookmarks-visit-previews') {
          window.testRuntimeCacheFailure = true;
          throw new DOMException('Synthetic IndexedDB failure', 'SecurityError');
        }
        return open.call(this, name, ...args);
      };
    });
    await failedCache.goto(pageUrl + '#' + data.folder);
    await failedCache.waitForSelector(card(data.keep));
    assert.equal(await failedCache.evaluate(() => window.testRuntimeCacheFailure), true);
    assert.equal(await failedCache.$(`${card(data.keep)} .bookmark__screenshot img`), null);
    assert.equal(await failedCache.$('#bookmarks[aria-busy]'), null);
    await failedCache.close();
    console.log('PASS IndexedDB failure keeps native bookmark cards usable');

    await page.evaluate(async folderId => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, default_folder_id: folderId } });
    }, data.folder);
    await page.goto(pageUrl);
    await page.waitForSelector(card(data.keep));
    await page.evaluate(folderId => chrome.bookmarks.removeTree(folderId), data.folder);
    await page.waitForSelector(card(data.fallback));
    await page.waitForFunction(async root => {
      const { settings } = await chrome.storage.local.get('settings');
      return document.getElementById('bookmarks')?.dataset.folder === root && settings.default_folder_id === root;
    }, {}, data.root);
    assert.equal(await page.$('#bookmarks .not-found'), null);
    console.log('PASS deleted default folder falls back to the native bookmarks root and repairs the setting');

    const options = extension + 'options.html';
    const optionsA = await openPage(browser, options, errors);
    const optionsB = await openPage(browser, options, errors);
    await Promise.all([waitForOptions(optionsA), waitForOptions(optionsB)]);
    assert.equal(await optionsA.$eval('#show_toolbar', input => input.checked), true);
    assert.equal(await optionsB.$eval('#show_favicon', input => input.checked), true);
    await Promise.all([setToggle(optionsA, 'show_toolbar', false), setToggle(optionsB, 'show_favicon', false)]);
    await optionsB.waitForFunction(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      return settings.show_toolbar === false && settings.show_favicon === false;
    });
    console.log('PASS concurrent changes from two settings tabs preserve both fields');

    const legacyStyle = '/* 收藏夹 · 中文备份 · café */';
    await optionsA.$eval('#import', (input, style) => {
      window.recoverySettingsDocument = document;
      const backup = JSON.stringify({ custom_style: style, color_theme: 'dark', visitPreviewEnabled: true });
      const transfer = new DataTransfer();
      transfer.items.add(new File([backup], 'visual-bookmarks-settings.backup', { type: 'text/plain' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, legacyStyle);
    await optionsA.waitForFunction(style => document.getElementById('custom_style')?.value === style
      && document.getElementById('color_theme')?.value === 'dark', { polling: 100 }, legacyStyle);
    assert.equal(await optionsA.evaluate(() => window.recoverySettingsDocument === document), true);
    const saved = await optionsA.evaluate(() => chrome.storage.local.get(['settings', 'visitPreviewEnabled']));
    assert.equal(saved.settings.custom_style, legacyStyle);
    assert.equal(saved.settings.color_theme, 'dark');
    assert.equal(saved.settings.show_toolbar, false);
    assert.equal(saved.settings.show_favicon, false);
    assert.equal(saved.settings.visitPreviewEnabled, undefined);
    assert.notEqual(saved.visitPreviewEnabled, true);
    assert.deepEqual(errors, []);
    console.log('PASS legacy UTF-8 backup imports without corrupting Unicode, replacing unrelated settings or granting opt-in');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
