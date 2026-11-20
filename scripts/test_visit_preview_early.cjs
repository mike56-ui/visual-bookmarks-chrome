const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

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

async function run(directory, origin, allowDelayedPaint) {
  const browser = await puppeteer.launch({ executablePath, headless: 'new', args: [
    `--disable-extensions-except=${directory}`, `--load-extension=${directory}`
  ] });
  try {
    const home = await browser.newPage();
    await home.goto('chrome://newtab/');
    await home.waitForSelector('#folderDockList .folder-card');
    const workerUrl = await home.evaluate(() => chrome.runtime.getURL('background.js'));
    const worker = await browser.waitForTarget(target => target.type() === 'service_worker' && target.url() === workerUrl);
    const session = await worker.createCDPSession();
    const readWorker = async expression => {
      const { result, exceptionDetails } = await session.send('Runtime.evaluate', { expression, returnByValue: true });
      assert.equal(exceptionDetails, undefined);
      return result.value;
    };
    assert.equal(await readWorker(`(() => {
      const capture = chrome.tabs.captureVisibleTab;
      globalThis.testCaptureCalls = 0;
      chrome.tabs.captureVisibleTab = (...args) => {
        globalThis.testCaptureCalls++;
        return capture.apply(chrome.tabs, args);
      };
      return chrome.tabs.captureVisibleTab !== capture;
    })()`), true);
    const captures = () => readWorker('globalThis.testCaptureCalls');
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

    const pending = await browser.newPage();
    await pending.bringToFront();
    const pendingUrl = origin + '/before-first-paint';
    await pending.goto(pendingUrl, { waitUntil: 'domcontentloaded' });
    const beforePending = await captures();
    // Switch only after the worker has inspected the saved page. The server holds painting
    // until afterwards, so runner speed cannot accidentally produce a foreground screenshot.
    await readWorker(`(() => {
      const inspect = chrome.scripting.executeScript;
      globalThis.waitingForFirstScreen = false;
      chrome.scripting.executeScript = async function(request) {
        const response = await inspect.call(this, request);
        if (request.args?.[0] === ${JSON.stringify(pendingUrl)} && request.args?.[1]?.trackViewport) {
          globalThis.waitingForFirstScreen = true;
          chrome.scripting.executeScript = inspect;
        }
        return response;
      };
      return true;
    })()`);
    const pendingBookmark = await saveBookmark('/before-first-paint');
    const waitEnd = Date.now() + 5000;
    while (!await readWorker('globalThis.waitingForFirstScreen') && Date.now() < waitEnd) await sleep(50);
    assert.equal(await readWorker('globalThis.waitingForFirstScreen'), true, 'Worker must have inspected the active saved page');
    assert.equal(await sample(home, pendingUrl), null);
    await home.bringToFront();
    allowDelayedPaint();
    const pendingImage = await waitForPixel(home, pendingUrl, [39, 119, 93],
      'Switching tabs before the first paint lost the initial bookmark preview');
    assert.equal(await captures(), beforePending + 1);
    await home.waitForFunction(id => document.querySelector(`#vb-${id} .bookmark__screenshot.is-ready img`)?.naturalWidth > 0,
      {}, pendingBookmark.id);
    await pending.bringToFront();
    await pending.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1200);
    assert.equal(await captures(), beforePending + 1, 'Normal revisits must reuse the saved first image');
    assert.deepEqual(await sample(home, pendingUrl), pendingImage);
    await pending.close();

    const guardPage = await browser.newPage();
    for (const [route, flag] of [['/no-opt-in', 'visitPreviewEnabled'], ['/during-import', 'importingBookmarks']]) {
      await home.evaluate(flag => chrome.storage.local.set({ [flag]: flag === 'importingBookmarks' }), flag);
      await guardPage.bringToFront();
      await guardPage.goto(origin + route, { waitUntil: 'domcontentloaded' });
      await saveBookmark(route);
      await home.bringToFront();
      await sleep(800);
      await home.evaluate(flag => chrome.storage.local.remove(flag), flag);
      assert.equal(await sample(home, origin + route), null, 'Do not capture ' + route);
    }
    await guardPage.bringToFront();
    await saveBookmark('/not-the-active-page');
    await home.bringToFront();
    await sleep(1000);
    assert.equal(await sample(home, origin + '/not-the-active-page'), null);
    assert.equal(await captures(), beforePending + 1, 'Opt-out, imports, and unrelated bookmarks must not capture');
    await guardPage.close();
    console.log('PASS first-save recovery after an early tab switch, one screenshot, no recapture or unrelated backfill.');

    const { page: slow, bookmark: slowBookmark } = await bookmarkOpenPage('/slow');
    await slow.waitForFunction(() => document.querySelector('main') && document.visibilityState === 'visible'
      && performance.getEntriesByName('first-contentful-paint', 'paint').length > 0);
    await waitForPixel(home, slowBookmark.url, [42, 121, 163], 'The visible first screen should be saved before load');
    assert.notEqual(await slow.evaluate(() => document.readyState), 'complete', 'Fixture must still be waiting on a resource');
    await home.bringToFront();
    await waitForPixel(home, slowBookmark.url, [42, 121, 163], 'Painted page was never saved after return before load');
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
  let allowDelayedPaint;
  const delayedPaint = new Promise(resolve => { allowDelayedPaint = resolve; });
  const server = http.createServer((request, response) => {
    if (request.url === '/paint-ready') {
      delayedPaint.then(() => { response.end('ready'); });
      return;
    }
    if (request.url === '/before-first-paint') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><head><title>Delayed first paint</title><script>
        fetch('/paint-ready').then(res => res.text()).then(() => {
          document.body.style.background = '#27775d';
          document.body.innerHTML = '<main>First page content</main>';
        });
        </script></head><body></body>`);
      return;
    }
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
    await run(directory, `http://127.0.0.1:${server.address().port}`, allowDelayedPaint);
  } finally {
    server.closeAllConnections();
    server.close();
    if (path.dirname(directory) === temp && path.basename(directory).startsWith('vb-visit-early-')) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
