const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 22000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(80);
  }
  throw new Error(message);
}

async function prepare(home, origin) {
  const setup = await home.evaluate(async base => {
    await chrome.storage.local.set({ visitPreviewEnabled: false });
    const [tree] = await chrome.bookmarks.getTree();
    const folder = await chrome.bookmarks.create({ parentId: tree.children[0].id, title: 'Visible covers QA' });
    const books = [];
    for (let i = 0; i < 68; i++) {
      books.push(await chrome.bookmarks.create({ parentId: folder.id,
        title: String(i).padStart(2, '0'), url: base + '/book/' + i }));
    }
    location.hash = folder.id;
    return { folder: folder.id, books };
  }, origin);
  await home.waitForSelector('#bookmarks [data-id="' + setup.books[0].id + '"]');
  await home.evaluate(async books => {
    const canvas = new OffscreenCanvas(20, 20);
    canvas.getContext('2d').fillRect(0, 0, 15, 15);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    await new Promise((resolve, reject) => {
      const open = indexedDB.open('visual-bookmarks');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('images', 'readwrite');
        const images = tx.objectStore('images');
        books.forEach(({ id, url }, i) => {
          if (i === 0) images.put({ id, url, blob, updated: 1 });
          else if (![2, 3, books.length - 1].includes(i)) images.put({ id, url, hiddenAt: Date.now() });
        });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    });
  }, setup.books);
  await home.reload();
  await home.waitForSelector('#bookmarks .bookmark__screenshot.is-ready img');
  return setup;
}

function readFills(home) {
  return home.evaluate(async () => {
    const name = 'visual-bookmarks-visit-previews';
    if (!(await indexedDB.databases()).some(db => db.name === name)) return [];
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const read = db.transaction('visitPreviews').objectStore('visitPreviews').getAll();
        read.onerror = () => { db.close(); reject(read.error); };
        read.onsuccess = () => {
          db.close();
          resolve(read.result.filter(row => row.blob?.size && row.fillMissing)
            .map(row => ({ url: row.url, digest: row.digest, capturedAt: row.capturedAt })));
        };
      };
    });
  });
}

async function run(extension, origin, visits) {
  const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
    headless: 'new', args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  try {
    const work = await browser.newPage();
    await work.goto(origin + '/work');
    const home = await browser.newPage();
    await home.setViewport({ width: 1160, height: 660 });
    await home.goto('chrome://newtab/');
    await home.waitForSelector('#folderDockList .folder-card');
    const pageUrl = await home.evaluate(() => chrome.runtime.getURL('newtab.html'));
    const { books, folder } = await prepare(home, origin);
    const last = books.length - 1;
    const scrollTo = i => home.evaluate(id => document.querySelector('#bookmarks [data-id="' + id + '"]')
      .scrollIntoView({ block: 'center', behavior: 'instant' }), books[i].id);
    const preference = value => home.evaluate(value => chrome.storage.local.set({ autoFillMissingPreviews: value }), value);
    const since = (i, filter) => until(() => visits.slice(i).find(filter), 'Missing expected request since ' + i);
    const top = req => [2, 3].includes(req.i) && !req.closed;
    const assertClosed = req => until(() => req.closed, 'Superseded background request was not cancelled: ' + req.i);
    await home.bringToFront();
    await sleep(2000);
    assert.equal(visits.length, 0, 'Default settings must not visit bookmarks');

    await preference(true);
    const first = await since(0, top);
    await sleep(500);
    assert.equal(visits.length, 1, 'Only one missing visible card may be processed at once');
    await scrollTo(last);
    await assertClosed(first);
    const lower = await since(1, req => req.i === last);
    await preference(false);
    await assertClosed(lower);
    assert.deepEqual(await readFills(home), []);
    console.log('PASS enabling fills only the viewport, scrolling cancels the old request, and disabling cancels immediately.');

    await scrollTo(0);
    let start = visits.length;
    await preference(true);
    const leaving = await since(start, top);
    await work.bringToFront();
    await assertClosed(leaving);
    await work.type('input', 'still browsing');
    assert.deepEqual(await readFills(home), []);
    start = visits.length;
    await home.bringToFront();
    const restarted = await since(start, top);
    const manualSelector = '#bookmarks [data-id="' + books[0].id + '"]';
    await home.hover(manualSelector);
    await home.click(manualSelector + ' .bookmark__refresh');
    await assertClosed(restarted);
    const manual = await since(start, req => req.i === 0);
    assert.equal(visits.filter(req => !req.closed).length, 1);
    start = visits.length;
    manual.finish();
    const one = await since(start, top);
    one.finish();
    const two = await since(visits.indexOf(one) + 1, top);
    assert.notEqual(one.i, two.i);
    two.finish();
    const rows = await until(async () => {
      const fills = await readFills(home);
      return fills.length === 2 && fills;
    }, 'Expected both visible missing covers in the persistent cache');
    assert.deepEqual(rows.map(row => row.url).sort(), [books[2].url, books[3].url].sort());
    assert.ok(visits.every(req => [0, 2, 3, last].includes(req.i)), 'Auto filled a user-cleared bookmark');
    assert.equal(visits.filter(req => req.i === 0).length, 1, 'Existing cover was revisited outside the manual action');
    console.log('PASS leaving the tab cancels capture, manual refresh takes priority, and stored/cleared covers are skipped.');

    const count = visits.length;
    const second = await browser.newPage();
    await second.setViewport({ width: 1160, height: 660 });
    await second.goto(pageUrl + '#' + folder);
    for (const i of [2, 3]) {
      await second.waitForSelector('#bookmarks [data-id="' + books[i].id + '"] .bookmark__screenshot.is-ready img');
    }
    await sleep(2000);
    assert.equal(visits.length, count, 'Opening another new tab revisited cached URLs');
    assert.deepEqual(await readFills(second), rows);
    assert.equal(await work.$eval('input', input => input.value), 'still browsing');
    console.log('PASS ' + await browser.version() + ': a new bookmark tab reuses the same images without visiting the sites.');
  } finally {
    await browser.close();
  }
}

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vb-visible-fills-'));
  const visits = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/work') { res.writeHead(200, { 'Content-Type': 'text/html' }).end('<input>'); return; }
    const match = /^\/book\/(\d+)$/.exec(req.url);
    if (!match) { res.writeHead(404).end(); return; }
    const visit = { i: Number(match[1]), closed: false, finish() {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><body style="background:#cde"><main>Local saved page ' + this.i + '</main></body>');
    } };
    visits.push(visit);
    res.once('close', () => { visit.closed = true; });
  });
  try {
    await fs.cp(path.resolve(process.env.VB_TEST_EXTENSION || 'extension_chrome'), directory, { recursive: true });
    const file = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    // Only the local disposable test package receives its existing optional host grant in advance.
    manifest.host_permissions = ['<all_urls>'];
    await fs.writeFile(file, JSON.stringify(manifest));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await run(directory, 'http://127.0.0.1:' + server.address().port, visits);
  } finally {
    server.closeAllConnections();
    server.close();
    if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('vb-visible-fills-')) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
