const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');
const countCaptureCalls = require('./preview_capture_counter.cjs');

const build = path.resolve(process.env.VB_TEST_EXTENSION || 'extension_chrome');
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sample(home, url) {
  return home.evaluate(async url => {
    const name = 'visual-bookmarks-visit-previews';
    if (!(await indexedDB.databases()).some(database => database.name === name)) return null;
    const entry = await new Promise((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const database = open.result;
        const request = database.transaction('visitPreviews').objectStore('visitPreviews').get(url);
        request.onsuccess = () => { database.close(); resolve(request.result); };
        request.onerror = () => { database.close(); reject(request.error); };
      };
    });
    if (!entry?.blob) return null;
    const bitmap = await createImageBitmap(entry.blob);
    try {
      const canvas = new OffscreenCanvas(1, 1);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, Math.round(bitmap.width * 0.75), Math.round(bitmap.height * 0.75), 1, 1, 0, 0, 1, 1);
      return { digest: entry.digest, updated: entry.updated,
        pixel: [...context.getImageData(0, 0, 1, 1).data].slice(0, 3) };
    } finally {
      bitmap.close();
    }
  }, url);
}

function closeTo(sample, color) {
  return sample?.pixel.every((channel, index) => Math.abs(channel - color[index]) < 20);
}

async function waitForPixel(home, url, color, message) {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const result = await sample(home, url);
    if (closeTo(result, color)) return result;
    await sleep(100);
  }
  assert.fail(message);
}

async function run(directory, origin) {
  const browser = await puppeteer.launch({ executablePath, headless: 'new', args: [
    `--disable-extensions-except=${directory}`, `--load-extension=${directory}`
  ] });
  try {
    const home = await browser.newPage();
    await home.goto('chrome://newtab/');
    await home.waitForSelector('#folderDockList .folder-card');
    const captures = await countCaptureCalls(home);
    const pageUrl = await home.evaluate(() => chrome.runtime.getURL('newtab.html'));
    assert.equal(await home.evaluate(() => chrome.permissions.contains({ origins: ['<all_urls>'] })), true);
    const folder = await home.evaluate(async() => {
      const [tree] = await chrome.bookmarks.getTree();
      return (await chrome.bookmarks.create({ parentId: tree.children[0].id, title: 'Early capture fixture' })).id;
    });
    await home.goto(pageUrl + '#' + folder);
    await home.evaluate(() => { window.testOriginalTab = true; });

    const saveBookmark = route => home.evaluate(async ({ parentId, url, title }) => chrome.bookmarks.create({
      parentId, url, title
    }), { parentId: folder, url: origin + route, title: route });

    async function bookmarkOpenPage(route, beforeSave) {
      const url = origin + route;
      const page = await browser.newPage();
      await page.bringToFront();
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('main') && document.visibilityState === 'visible');
      await beforeSave?.(page);
      return { page, bookmark: await saveBookmark(route) };
    }

    const { page: slow, bookmark: slowBookmark } = await bookmarkOpenPage('/slow');
    await slow.waitForFunction(() => document.querySelector('main') && document.visibilityState === 'visible'
      && performance.getEntriesByName('first-contentful-paint', 'paint').length > 0);
    const beforeReturn = await waitForPixel(home, slowBookmark.url, [42, 121, 163], 'First screen missing before load');
    assert.notEqual(await slow.evaluate(() => document.readyState), 'complete', 'Fixture must still be waiting on a resource');
    await home.bringToFront();
    assert.deepEqual(await sample(home, slowBookmark.url), beforeReturn, 'The original first screen must survive switching tabs');
    await home.waitForFunction(id => window.testOriginalTab
      && document.querySelector(`#bookmarks [data-id="${id}"] .bookmark__screenshot img`)?.naturalWidth > 0,
    {}, slowBookmark.id);
    await slow.close();

    const { page: spa, bookmark: spaBookmark } = await bookmarkOpenPage('/spa');
    const first = await waitForPixel(home, spaBookmark.url, [84, 51, 117], 'The first rendered SPA state was not saved');
    await spa.waitForFunction(() => document.querySelector('main')?.textContent === 'Rendered SPA content');
    await sleep(1600);
    assert.deepEqual(await sample(home, spaBookmark.url), first, 'Later SPA content must keep the original image and timestamp');
    await home.bringToFront();
    assert.ok(await home.evaluate(() => window.testOriginalTab), 'The original bookmark page must not reload');

    for (const [route, nested] of [['/scroll-root', false], ['/scroll-main', true]]) {
      const { page: live, bookmark: item } = await bookmarkOpenPage(route);
      const top = await waitForPixel(home, item.url, [40, 115, 175], `Missing first screen for ${item.url}`);
      const readPosition = () => live.evaluate(nested => nested ? document.querySelector('main').scrollTop : scrollY, nested);
      await live.evaluate(nested => {
        (nested ? document.querySelector('main') : window).scrollTo(0, 1000);
      }, nested);
      assert.equal(await readPosition(), 1000, 'Fixture must be in the lower part of the page');
      await home.bringToFront();
      await live.bringToFront();
      await sleep(1500);
      assert.deepEqual(await sample(home, item.url), top, 'Reactivating a scrolled page must keep the top preview');
      assert.equal(await readPosition(), 1000, 'Sampling must not move the website');
      await home.bringToFront();
      await live.close();
    }

    const { page: moved, bookmark: movedBookmark } = await bookmarkOpenPage('/scroll-refine');
    const original = await waitForPixel(home, movedBookmark.url, [40, 115, 175], 'First frame before scroll missing');
    await moved.evaluate(async () => {
      scrollTo(0, 1000);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      scrollTo(0, 0);
    });
    await moved.waitForFunction(() => window.changedTop === true);
    await sleep(1300);
    assert.deepEqual(await sample(home, movedBookmark.url), original,
      'Late page changes must not replace the first preview once the user has scrolled away');

    for (const [route, nested] of [['/scroll-save-root', false], ['/scroll-save-main', true]]) {
      const before = await captures();
      const { page: alreadyScrolled, bookmark } = await bookmarkOpenPage(route, page => page.evaluate(async nested => {
        const scroller = nested ? document.querySelector('main') : window;
        scroller.scrollTo(0, 1000);
        await new Promise(resolve => requestAnimationFrame(resolve));
        if ((nested ? scroller.scrollTop : scrollY) !== 1000) throw new Error('The fixture did not scroll before saving');
      }, nested));
      const firstScreen = await waitForPixel(home, bookmark.url, [40, 115, 175], 'No first screen after saving a scrolled page');
      assert.equal(await captures(), before + 1, 'Only the independent first-screen capture should run');
      const state = await alreadyScrolled.evaluate(nested => ({
        position: nested ? document.querySelector('main').scrollTop : scrollY,
        visible: document.visibilityState === 'visible'
      }), nested);
      assert.deepEqual(state, { position: 1000, visible: true }, 'Preserve the live tab and its reading position');

      await saveBookmark(route);
      await home.bringToFront();
      await alreadyScrolled.bringToFront();
      await alreadyScrolled.reload({ waitUntil: 'domcontentloaded' });
      await sleep(1150);
      assert.equal(await captures(), before + 1, 'A duplicate, tab revisit and reload must never start another screenshot');
      assert.deepEqual(await sample(home, bookmark.url), firstScreen);
      await alreadyScrolled.close();
    }
    console.log(`PASS ${await browser.version()}: early first paint, preserved first image, and one first-screen capture when saving a scrolled page.`);
  } finally {
    await browser.close();
  }
}

(async () => {
  const temp = path.resolve(os.tmpdir());
  const directory = path.resolve(await fs.mkdtemp(path.join(temp, 'vb-visit-early-')));
  const server = http.createServer((request, response) => {
    if (request.url === '/delay.gif') {
      const timer = setTimeout(() => {
        response.writeHead(200, { 'content-type': 'image/gif' });
        response.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
      }, 5000);
      response.on('close', () => clearTimeout(timer));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (request.url === '/spa') {
      response.end(`<!doctype html><body style="background:#543375"><main>Loading</main><script>
        setTimeout(() => {
          document.body.style.background = '#178148';
          document.querySelector('main').textContent = 'Rendered SPA content';
        }, 850);
        </script>`);
      return;
    }
    if (request.url?.startsWith('/scroll-')) {
      const nested = request.url.endsWith('-main');
      const mutate = request.url === '/scroll-refine' ? `<script>setTimeout(() => {
        document.querySelector('main > section').style.background = '#2c8d56';
        window.changedTop = true;
      }, 850);</script>` : '';
      response.end(`<!doctype html><body style="margin:0;${nested ? 'overflow:hidden' : ''}">
        <main style="${nested ? 'height:100vh;overflow-y:auto' : ''}">
        <section style="height:100vh;background:#2873af">First screen</section>
        <section style="height:2500px;background:#ac4a42">Lower part</section></main>${mutate}`);
      return;
    }
    response.end('<!doctype html><body style="background:#2a79a3"><main>Painted site</main><img src="/delay.gif">');
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await fs.cp(build, directory, { recursive: true });
    const file = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    // Only preauthorize an isolated copy. The installed manifest and browser profile are untouched.
    manifest.host_permissions = ['<all_urls>'];
    await fs.writeFile(file, JSON.stringify(manifest));
    await run(directory, `http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    server.close();
    if (path.dirname(directory) === temp && path.basename(directory).startsWith('vb-visit-early-')) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
