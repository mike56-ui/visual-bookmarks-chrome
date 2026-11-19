const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const build = path.resolve(process.env.VB_TEST_EXTENSION || 'extension_chrome');
const routes = [
  { saved: '/control', destination: '/control', preview: true },
  { saved: '/dashboard', destination: '/dashboard/', status: 301, preview: true },
  { saved: '/reports?utm_source=x', destination: '/reports', status: 302, preview: true },
  { saved: '/account', destination: '/login', status: 302, preview: false },
  { saved: '/document?doc=1', destination: '/document?doc=2', status: 302, preview: false },
  { saved: '/research?utm_medium=email', destination: '/research', status: 301, preview: true }
];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForStoredPreview(page, saved, destination) {
  await page.waitForFunction(async url => {
    const name = 'visual-bookmarks-visit-previews';
    if (!(await indexedDB.databases()).some(database => database.name === name)) return false;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const query = db.transaction('visitPreviews').objectStore('visitPreviews').get(url);
        query.onerror = () => { db.close(); reject(query.error); };
        query.onsuccess = () => { db.close(); resolve(query.result?.blob?.size > 0); };
      };
    });
  }, { polling: 100, timeout: 6500 }, saved).catch(error => {
    throw new Error(`No preview stored for ${saved} after opening ${destination}`, { cause: error });
  });
}

async function waitForCardPreview(home, card) {
  await home.waitForFunction(selector => {
    const thumbnail = document.querySelector(selector + ' .bookmark__screenshot.is-ready img');
    return thumbnail?.naturalWidth > 0;
  }, { timeout: 5000 }, card);
}

async function run(extension, origin) {
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    headless: 'new',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const home = await browser.newPage();
    await home.goto('chrome://newtab/');
    await home.waitForSelector('#folderDockList .folder-card');
    assert.equal(await home.evaluate(() => chrome.permissions.contains({ origins: ['<all_urls>'] })), true);
    const folderId = await home.evaluate(async () => {
      const [root] = await chrome.bookmarks.getTree();
      return (await chrome.bookmarks.create({parentId:root.children[0].id, title:'First save QA'})).id;
    });
    await home.goto(home.url() + '#' + folderId);
    await home.waitForFunction(id => document.getElementById('bookmarks').dataset.folder === id, {}, folderId);
    await home.evaluate(() => {
      window.previewWindows = { opened: [], closed: [] };
      chrome.windows.onCreated.addListener(win => window.previewWindows.opened.push(win.id));
      chrome.windows.onRemoved.addListener(id => window.previewWindows.closed.push(id));
    });
    async function saveUsingForm(url) {
      await home.waitForFunction(() => {
        const button = document.querySelector('#newtabActionsToggle');
        const box = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      });
      await home.click('#newtabActionsToggle');
      await home.waitForSelector('[data-newtab-action="add"]', {visible:true, timeout:3000});
      await home.click('[data-newtab-action="add"]');
      await home.waitForSelector('#formBookmark #url', {visible:true});
      await home.type('#formBookmark #title', 'Saved ' + new URL(url).pathname);
      await home.type('#formBookmark #url', url);
      await home.click('#saveBookmarkBtn');
      await home.waitForFunction(url => Array.from(document.querySelectorAll('#bookmarks a.bookmark'))
        .some(card => card.href === url), {}, url);
      return home.evaluate(url => Array.from(document.querySelectorAll('#bookmarks a.bookmark'))
        .find(card => card.href === url).dataset.id, url);
    }

    for (const [index, item] of routes.entries()) {
      const saved = origin + item.saved;
      const id = await saveUsingForm(saved);
      const card = '#bookmarks [data-id="' + id + '"]';
      await home.waitForFunction(index => {
        const popup = window.previewWindows.opened[index];
        return popup !== undefined && window.previewWindows.closed.includes(popup);
      }, {polling:100, timeout:10000}, index);
      if (item.preview) {
        await waitForStoredPreview(home, saved, origin + item.destination);
        await waitForCardPreview(home, card);
      } else {
        assert.equal(await home.$(card + ' .bookmark__screenshot'), null, item.saved + ' must retain its icon');
      }
    }
    const windows = await home.evaluate(() => window.previewWindows);
    assert.equal(windows.opened.length, routes.length);
    assert.deepEqual(windows.closed, windows.opened);
    await home.evaluate(() => chrome.storage.local.set({visitPreviewEnabled:false}));
    const disabled = await saveUsingForm(origin + '/disabled');
    await delay(600);
    assert.equal(await home.$('#vb-' + disabled + ' .bookmark__screenshot'), null);
    assert.equal(await home.evaluate(() => window.previewWindows.opened.length), routes.length);

    console.log('PASS ' + await browser.version() + ': adding from the bookmark form captures the first screen, '
      + 'handles same-page redirects, skips unrelated destinations and respects the opt-out.');
  } finally {
    await browser.close();
  }
}

(async() => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vb-redirect-preview-qa-'));
  const server = http.createServer((request, response) => {
    const redirect = routes.find(item => item.status && item.saved === request.url);
    if (redirect) {
      response.writeHead(redirect.status, { Location: redirect.destination, 'Cache-Control': 'no-store' });
      return response.end();
    }
    if (routes.some(item => item.destination === request.url)) {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return response.end(`<!doctype html><title>Redirect preview fixture</title><main style="padding:3rem;background:#4a3a95;color:white">${request.url}</main>`);
    }
    response.writeHead(404);
    response.end();
  });
  try {
    await fs.cp(build, directory, { recursive: true });
    const manifestPath = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    // Declare access in this disposable fixture while retaining the real capture and permission checks.
    manifest.host_permissions = ['<all_urls>'];
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await run(directory, `http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('vb-redirect-preview-qa-')) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
