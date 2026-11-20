const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const build = path.resolve(process.env.VB_TEST_EXTENSION || 'extension_chrome');
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].find(existsSync);
const waitSeconds = 1.2;
const occlusionTest = process.env.VB_HEADFUL_OCCLUSION === '1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let firstContentSent;
let slowResourceRequested = false;
let coveredPageObserved = false;

async function readImage(home, url) {
  return home.evaluate(async url => {
    const name = 'visual-bookmarks-visit-previews';
    if (!(await indexedDB.databases()).some(db => db.name === name)) return;
    const data = await new Promise((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const read = db.transaction('visitPreviews').objectStore('visitPreviews').get(url);
        read.onsuccess = () => { db.close(); resolve(read.result); };
        read.onerror = () => { db.close(); reject(read.error); };
      };
    });
    if (!data?.blob) return;
    const image = await createImageBitmap(data.blob);
    const context = new OffscreenCanvas(1, 1).getContext('2d');
    try {
      context.drawImage(image, Math.floor(image.width * .75), Math.floor(image.height * .75), 1, 1, 0, 0, 1, 1);
      return { timestamp: data.capturedAt ?? data.updated, pixel: [...context.getImageData(0, 0, 1, 1).data].slice(0, 3) };
    } finally {
      image.close();
    }
  }, url);
}

async function run(directory, origin) {
  const browser = await puppeteer.launch({
    executablePath, headless: occlusionTest ? false : 'new',
    ...(occlusionTest && {
      defaultViewport: null,
      ignoreDefaultArgs: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling']
    }),
    args: [
      ...(occlusionTest ? ['--start-maximized'] : []),
      `--disable-extensions-except=${directory}`, `--load-extension=${directory}`
    ]
  });
  try {
    const home = await browser.newPage();
    await home.goto('chrome://newtab/');
    await home.waitForSelector('#folderDockList .folder-card');
    assert.equal(await home.evaluate(() => chrome.permissions.contains({ origins: ['<all_urls>'] })), true);
    const fixture = await home.evaluate(async({ origin, waitSeconds }) => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({
        settings: { ...settings, thumbnails_update_delay: waitSeconds },
        visitPreviewEnabled: false
      });
      const [tree] = await chrome.bookmarks.getTree();
      const dir = await chrome.bookmarks.create({ parentId: tree.children[0].id, title: 'Manual first screen' });
      const add = route => chrome.bookmarks.create({ parentId: dir.id, title: route, url: origin + route });
      return { folder: dir.id, first: await add('/prior'), slow: await add('/manual-early') };
    }, { origin, waitSeconds });
    await home.evaluate(id => { location.hash = id; }, fixture.folder);
    await home.waitForSelector(`#bookmarks [data-id="${fixture.slow.id}"]`);
    await home.bringToFront();
    await home.evaluate(async occlude => {
      const state = window.manualEarlyState = { opened: [], closed: [], blur: 0, focusChanges: [] };
      const { id } = await chrome.windows.getCurrent();
      if (occlude) {
        await chrome.windows.update(id, { state: 'maximized' });
        await chrome.windows.update(id, { focused: true });
        chrome.windows.onFocusChanged.addListener(id => state.focusChanges.push(id));
      }
      chrome.windows.onCreated.addListener(popup => {
        state.opened.push(popup.id);
        // Cover the unfocused popup before its first navigation, then let the extension handle it.
        if (occlude) chrome.windows.update(id, { focused: true });
      });
      chrome.windows.onRemoved.addListener(id => state.closed.push(id));
      window.addEventListener('blur', () => state.blur++);
    }, occlusionTest);
    await home.keyboard.down('Control');
    for (const item of [fixture.first, fixture.slow]) {
      await home.click(`#bookmarks [data-id="${item.id}"] .bookmark__stage`);
    }
    await home.keyboard.up('Control');
    const update = '#bookmarks-panel [data-action="update_thumbnails"]';
    await home.waitForSelector(update, { visible: true });
    await home.click(update);

    const deadline = Date.now() + (occlusionTest ? 26000 : 8500);
    let shot;
    while (!shot && Date.now() < deadline) {
      shot = await readImage(home, fixture.slow.url);
      if (!shot) await delay(125);
    }
    if (occlusionTest) assert.ok(coveredPageObserved, 'The fixture page must actually be occluded');
    assert.ok(slowResourceRequested, 'Manual capture must navigate to the new page with an unfinished resource');
    assert.ok(shot, 'Manual refresh waited for an unfinished resource instead of saving the visible first screen');
    const near = (sample, rgb) => sample?.pixel.every((component, index) => Math.abs(component - rgb[index]) < 20);
    assert.ok(near(shot, [42, 121, 163]), `Expected the new first screen, received ${shot.pixel}`);
    assert.ok(near(await readImage(home, fixture.first.url), [166, 52, 72]), 'Previous item must keep its own image');
    assert.ok(shot.timestamp >= firstContentSent + waitSeconds * 1000 - 50, 'Manual delay started before first content');
    await home.waitForFunction(() => window.manualEarlyState.closed.length > 0);
    await home.waitForFunction(id => document.querySelector(`#vb-${id} .bookmark__screenshot.is-ready img`)?.naturalWidth > 0,
      { timeout: 5000 }, fixture.slow.id);
    const audit = await home.evaluate(async () => {
      const { focused, id } = await chrome.windows.getCurrent();
      return { ...window.manualEarlyState, focused, source: id, active: (await chrome.tabs.getCurrent()).active };
    });
    assert.equal(audit.opened.length, 1, 'Both captures must share one temporary window');
    assert.deepEqual(audit.closed, audit.opened);
    if (!occlusionTest) assert.equal(audit.blur, 0, 'A visible capture did not require a focus change');
    assert.ok(audit.active && audit.focused, `The bookmark tab must regain focus: ${JSON.stringify(audit)}`);
    console.log(`PASS ${await browser.version()}: multi-select refresh captured the right first screen with an unfinished resource, `
      + `waited ${shot.timestamp - firstContentSent}ms from first content, retained both images, and left focus in place.`);
  } finally {
    await browser.close();
  }
}

(async() => {
  const temp = path.resolve(os.tmpdir());
  const directory = path.resolve(await fs.mkdtemp(path.join(temp, 'vb-manual-early-')));
  const server = http.createServer((request, response) => {
    if (request.url === '/covered') {
      coveredPageObserved = true;
      response.writeHead(204).end();
      return;
    }
    if (request.url === '/unfinished.gif') {
      slowResourceRequested = true;
      return;
    }
    if (request.url !== '/prior' && request.url !== '/manual-early') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    if (request.url === '/prior') {
      const observeVisibility = occlusionTest ? `<script>
        function report() { if (document.hidden) navigator.sendBeacon('/covered'); }
        document.addEventListener('visibilitychange', report); report();
      </script>` : '';
      response.end('<!doctype html><body style="background:#a63448"><main>Previous page</main>' + observeVisibility);
      return;
    }
    response.write('<!doctype html><title>First screen</title><body>');
    const timer = setTimeout(() => {
      firstContentSent = Date.now();
      response.end('<style>body{background:#2a79a3}</style><main>First screen</main><img src="/unfinished.gif">');
    }, 750);
    response.on('close', () => clearTimeout(timer));
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await fs.cp(build, directory, { recursive: true });
    const file = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    // Preauthorize only the temporary QA build. Automatic capture is disabled in the profile.
    manifest.host_permissions = ['<all_urls>'];
    await fs.writeFile(file, JSON.stringify(manifest));
    await run(directory, `http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    server.close();
    if (path.dirname(directory) === temp && path.basename(directory).startsWith('vb-manual-early-')) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
