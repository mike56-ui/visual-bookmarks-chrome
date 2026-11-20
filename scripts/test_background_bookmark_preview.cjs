const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const headed = process.argv.includes('--headed');
const slowOnly = process.argv.includes('--slow-only');
const build = path.resolve(process.env.VB_TEST_EXTENSION || 'extension_chrome');
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, ms = 18000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(80);
  }
  throw new Error(label);
}

async function image(home, id) {
  return home.evaluate(async id => {
    const open = indexedDB.open('visual-bookmarks');
    const row = await new Promise((resolve, reject) => {
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const read = db.transaction('images').objectStore('images').get(id);
        read.onerror = () => { db.close(); reject(read.error); };
        read.onsuccess = () => { db.close(); resolve(read.result); };
      };
    });
    if (!row?.blob) return null;
    const bitmap = await createImageBitmap(row.blob);
    try {
      const context = new OffscreenCanvas(1, 1).getContext('2d');
      const sample = y => {
        context.drawImage(bitmap, Math.floor(bitmap.width * .8), Math.floor(bitmap.height * y), 1, 1, 0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
      };
      return { digest: row.digest, capturedAt: row.capturedAt, upper: sample(.15), lower: sample(.85) };
    } finally {
      bitmap.close();
    }
  }, id);
}

async function checkSlowPreviews({ home, id, fixture, click, waitIdle, audit, near }) {
  const failures = [];
  const colors = { 'slow-shell': [20, 142, 136], 'slow-hero': [101, 75, 183], 'slow-background': [208, 119, 29] };
  for (const mode of [...Object.keys(colors), 'stuck-shell']) {
    fixture.mode = mode;
    const previous = await image(home, id);
    const started = Date.now();
    const target = await click();
    await until(async () => (await audit()).closed.includes(target.id), mode + ': background tab remained open',
      mode === 'stuck-shell' ? 30000 : 18000);
    await waitIdle();
    const saved = await image(home, id);
    const ms = Date.now() - started;
    const expected = colors[mode];
    const correct = mode === 'stuck-shell'
      ? saved?.digest === previous.digest && saved?.capturedAt === previous.capturedAt
      : saved?.digest !== previous.digest && near(saved.lower, expected);
    console.log((correct ? 'PASS ' : 'FAIL ') + mode + ' in ' + ms + 'ms: '
      + 'stored lower viewport RGB ' + saved?.lower + '; ' + (mode === 'stuck-shell' ? 'expected original thumbnail' : 'expected ' + expected));
    if (!correct) failures.push(mode);
  }
  fixture.mode = 'normal';
  const setWait = seconds => home.evaluate(async seconds => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, thumbnails_update_delay: seconds } });
  }, seconds);
  await setWait(6.5);
  try {
    const target = await click();
    await until(async () => (await audit()).closed.includes(target.id), 'Configured-delay tab remained open');
    await waitIdle();
    const saved = await image(home, id);
    const actual = saved.capturedAt - fixture.responseAt;
    const correct = actual >= 6400 && near(saved.lower, [41, 99, 161]);
    console.log((correct ? 'PASS ' : 'FAIL ') + 'configured minimum 6500ms: capture at ' + actual + 'ms after HTML response');
    if (!correct) failures.push('configured-delay');
  } finally {
    await setWait(.5);
  }
  assert.deepEqual(failures, [], 'Slow first-screen readiness regression');
}

async function test(extension, origin, fixture) {
  const browser = await puppeteer.launch({
    executablePath, headless: headed ? false : 'new', defaultViewport: null,
    ignoreDefaultArgs: ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling'],
    args: ['--window-size=1150,820', '--no-first-run', '--disable-extensions-except=' + extension, '--load-extension=' + extension]
  });
  try {
    const work = await browser.newPage();
    await work.goto(origin + '/work');
    const home = await browser.newPage();
    await home.goto('chrome://newtab/');
    await home.waitForSelector('#folderDockList .folder-card');
    const ids = await home.evaluate(async origin => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ visitPreviewEnabled: false, settings: { ...settings, thumbnails_update_delay: .5 } });
      const [tree] = await chrome.bookmarks.getTree();
      const parent = await chrome.bookmarks.create({ parentId: tree.children[0].id, title: 'Quick refresh QA' });
      const item = await chrome.bookmarks.create({ parentId: parent.id, title: 'Test subject', url: origin + '/subject' });
      const sibling = await chrome.bookmarks.create({ parentId: parent.id, title: 'Second copy', url: item.url });
      const current = await chrome.tabs.getCurrent();
      const userTab = (await chrome.tabs.query({ windowId: current.windowId })).find(tab => tab.url === origin + '/work');
      return { folder: parent.id, book: item.id, sibling: sibling.id, home: current.id, work: userTab.id, window: current.windowId };
    }, origin);
    await home.evaluate(id => { location.hash = id; }, ids.folder);
    const selector = '#bookmarks [data-id="' + ids.book + '"]';
    await home.waitForSelector(selector);
    await home.bringToFront();
    await home.evaluate(() => {
      window.previewAudit = { windows: [], tabs: [], closed: [], activated: [] };
      chrome.windows.onCreated.addListener(win => previewAudit.windows.push(win.id));
      chrome.tabs.onCreated.addListener(tab => previewAudit.tabs.push({ id: tab.id, windowId: tab.windowId, active: tab.active }));
      chrome.tabs.onRemoved.addListener(id => previewAudit.closed.push(id));
      chrome.tabs.onActivated.addListener(({ tabId }) => previewAudit.activated.push(tabId));
    });
    const audit = () => home.evaluate(() => window.previewAudit);
    const click = async () => {
      const before = (await audit()).tabs.length;
      await home.hover(selector);
      await home.click(selector + ' .bookmark__refresh');
      return until(async () => (await audit()).tabs[before], 'No temporary background tab was created');
    };
    const waitIdle = () => until(() => home.$eval(selector, card => card.getAttribute('aria-busy') !== 'true'),
      'The bookmark refresh action never finished');
    const closeObserved = (id, max) => until(async () => (await audit()).closed.includes(id), 'The temporary tab remained open', max);

    fixture.hold = true;
    const first = await click();
    await until(() => fixture.respond, 'The target did not request the fixture');
    assert.equal(first.active, false, 'The target was created in the foreground');
    assert.equal(first.windowId, ids.window);
    const before = await home.evaluate(async id => {
      const tab = await chrome.tabs.get(id);
      return { muted: tab.mutedInfo.muted, active: tab.active, sourceActive: (await chrome.tabs.getCurrent()).active };
    }, first.id);
    assert.deepEqual(before, { muted: true, active: false, sourceActive: true });
    // Change to another existing tab and perform a real edit while the requested site is loading.
    await home.evaluate(id => chrome.tabs.update(id, { active: true }), ids.work);
    await work.type('#edit', 'still typing');
    assert.equal(await work.$eval('#edit', field => field.value), 'still typing');
    assert.equal(await home.evaluate(id => chrome.tabs.get(id).then(tab => !tab.active && tab.mutedInfo.muted), first.id), true);
    fixture.respond();
    let saved = await until(() => image(home, ids.book), 'No screenshot was saved while another tab was being used');
    await closeObserved(first.id);
    const near = (pixel, target) => pixel.every((value, i) => Math.abs(value - target[i]) < 20);
    assert.ok(near(saved.upper, [30, 121, 76]), 'Wrong top pixels: ' + saved.upper);
    assert.ok(near(saved.lower, [41, 99, 161]), 'Wrong lower pixels in first viewport: ' + saved.lower);
    assert.ok(fixture.pendingImage, 'The target must have an unfinished resource when its first screen is saved');
    assert.equal(await image(home, ids.sibling), null);
    assert.deepEqual((await audit()).activated, [ids.work], 'Refresh stole focus');
    assert.deepEqual((await audit()).windows, [], 'Refresh created another window');
    console.log('PASS ' + await browser.version() + ': background tab muted; original tab usable; foreground edit preserved; '
      + 'correct first viewport while a resource is loading; temporary tab closed; no new window or unexpected activation.');

    await home.bringToFront();
    await waitIdle();
    await checkSlowPreviews({ home, id: ids.book, fixture, click, waitIdle, audit, near });
    if (slowOnly) return;
    saved = await image(home, ids.book);
    fixture.status = 503;
    const failed = await click();
    await closeObserved(failed.id);
    await waitIdle();
    assert.deepEqual(await image(home, ids.book), saved, 'An error page replaced the previous screenshot');
    console.log('PASS HTTP 503 keeps the previous image and cleans up the background tab.');

    fixture.status = 200;
    fixture.mode = 'redirect';
    const redirected = await click();
    await closeObserved(redirected.id);
    await waitIdle();
    assert.deepEqual(await image(home, ids.book), saved, 'The unrelated redirect replaced the previous image');
    fixture.mode = 'blank';
    const blank = await click();
    await closeObserved(blank.id, 30000);
    await waitIdle();
    assert.deepEqual(await image(home, ids.book), saved, 'A blank viewport replaced the previous image');
    console.log('PASS blank viewport and unrelated redirect keep the previous screenshot and release the unclaimed tab.');

    fixture.mode = 'script-redirect';
    const replaced = await click();
    await until(() => fixture.releaseRedirect, 'The fixture did not initiate the client-side redirect');
    await until(() => home.evaluate(async ({ id, url }) => (await chrome.tabs.get(id)).url === url,
      { id: replaced.id, url: origin + '/subject' }), 'The original document never committed');
    fixture.releaseRedirect();
    await closeObserved(replaced.id);
    await waitIdle();
    assert.deepEqual(await image(home, ids.book), saved, 'A client-side redirect replaced the previous image');
    console.log('PASS a page which commits and then redirects itself leaves no leftover tab or incorrect screenshot.');

    fixture.mode = 'normal';
    fixture.hold = true;
    const taken = await click();
    await until(() => fixture.respond, 'Takeover fixture was not loading');
    await home.evaluate(id => chrome.tabs.update(id, { active: true }), taken.id);
    // Model the user's next navigation after taking over that specific temporary tab.
    await home.evaluate(({ id, url }) => chrome.tabs.update(id, { url }), { id: taken.id, url: origin + '/work?taken' });
    await waitIdle();
    const remaining = await home.evaluate(id => chrome.tabs.get(id).then(tab => ({
      url: tab.url, active: tab.active, muted: tab.mutedInfo.muted
    })), taken.id);
    assert.deepEqual(remaining, { url: origin + '/work?taken', active: true, muted: false });
    assert.ok(!(await audit()).closed.includes(taken.id), 'The extension closed a tab the user had claimed');
    assert.deepEqual(await image(home, ids.book), saved, 'Capturing the user-controlled target corrupted the cache');
    assert.deepEqual((await audit()).windows, []);
    console.log('PASS activating and navigating the temporary tab preserves that tab, its destination, and the previous image.');

    // A second extension page observes IndexedDB after the initiating page and its Port are gone.
    const observer = await browser.newPage();
    await observer.goto(await home.evaluate(() => chrome.runtime.getURL('newtab.html')));
    await observer.waitForSelector('#folderDockList .folder-card');
    await home.bringToFront();
    fixture.respond = undefined;
    fixture.hold = true;
    fixture.mode = 'revised';
    const detached = await click();
    await until(() => fixture.respond, 'The fixture did not start the detached request');
    await work.bringToFront();
    await home.close();
    fixture.respond();
    const revised = await until(async () => {
      const record = await image(observer, ids.book);
      return record && record.digest !== saved.digest ? record : null;
    }, 'Closing the originating bookmark page cancelled its requested refresh');
    assert.ok(near(revised.upper, [110, 61, 168]));
    await until(() => observer.evaluate(id => chrome.tabs.get(id).then(() => false, () => true), detached.id),
      'The detached capture left its temporary tab open');
    assert.equal(await work.$eval('#edit', field => field.value), 'still typing');
    console.log('PASS the refresh completes and releases its temporary tab after the user closes the original bookmarks page.');
  } finally {
    await browser.close();
  }
}

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vb-silent-refresh-'));
  const fixture = { hold: false, mode: 'normal', status: 200, pendingImage: false };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/work')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<body style="background:#ec6818"><input id="edit">Foreground</body>');
      return;
    }
    if (req.url === '/unfinished') { fixture.pendingImage = true; return; }
    if (['/slow-content', '/slow-hero.svg', '/slow-background.svg'].includes(req.url)) {
      const timer = setTimeout(() => {
        if (req.url === '/slow-content') {
          res.writeHead(200, { 'content-type': 'text/html' }).end('<main style="min-height:100vh;background:#148e88">'
            + '<h1>Journal</h1><p>A complete story with its first section ready to read.</p></main>');
        } else {
          const color = req.url === '/slow-background.svg' ? '#d0771d' : '#654bb7';
          res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
            + '<rect width="100" height="100" fill="' + color + '"/><circle cx="20" cy="20" r="15" fill="#ffb854"/></svg>');
        }
      }, 3300);
      res.once('close', () => clearTimeout(timer));
      return;
    }
    if (req.url === '/redirect-gate') {
      fixture.releaseRedirect = () => { res.writeHead(200).end(); fixture.releaseRedirect = undefined; };
      return;
    }
    if (req.url !== '/subject') { res.writeHead(404).end(); return; }
    const send = () => {
      fixture.responseAt = Date.now();
      fixture.respond = undefined;
      if (fixture.mode === 'redirect') { res.writeHead(302, { location: '/work?login' }).end(); return; }
      res.writeHead(fixture.status, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      if (fixture.mode === 'slow-shell' || fixture.mode === 'stuck-shell') {
        const hydrate = fixture.mode === 'slow-shell'
          ? '<script>const watch=new IntersectionObserver(([entry])=>{if(!entry.isIntersecting)return;watch.disconnect();'
            + 'requestAnimationFrame(()=>requestAnimationFrame(()=>fetch("/slow-content").then(r=>r.text())'
            + '.then(content=>document.body.innerHTML=content)));});watch.observe(document.querySelector("main"));</script>' : '';
        res.end('<!doctype html><style>*{margin:0}.skeleton{height:100vh;background:#c65c53}.line{width:75%;height:16px;background:#ffe9ce}</style>'
          + '<main class="skeleton" aria-busy="true"><p role="status">Loading…</p><div class="line"></div></main>' + hydrate);
        return;
      }
      if (fixture.mode === 'slow-hero') {
        res.end('<!doctype html><style>*{margin:0}h1{height:15vh;background:#eedab3}img{display:block;width:100%;height:85vh;object-fit:cover;background:#d4be97}</style>'
          + '<h1>Exhibition catalogue</h1><img src="/slow-hero.svg" alt="Featured artwork">');
        return;
      }
      if (fixture.mode === 'slow-background') {
        res.end('<!doctype html><style>*{margin:0}main{min-height:100vh;background:#d4be97 url(/slow-background.svg) center/cover no-repeat}</style>'
          + '<main><h1>Design collection</h1><p>Discover our annual selection of featured illustrations and exhibits.</p></main>');
        return;
      }
      if (fixture.mode === 'blank') {
        res.end('<!doctype html><body><main style="opacity:0">Content that has not been painted</main></body>');
        return;
      }
      if (fixture.mode === 'script-redirect') {
        res.end('<!doctype html><body><div></div><script>fetch("/redirect-gate").then(()=>location.replace("/work?redirected"))</script></body>');
        return;
      }
      const upper = fixture.mode === 'revised' ? '#6e3da8' : '#1e794c';
      res.end('<!doctype html><style>*{margin:0}.top,.bottom{height:50vh}.top{background:' + upper + '}'
        + '.bottom{background:#2963a1}footer{height:180vh;background:#cf352a}</style>'
        + '<main class="top">Subject top</main><div class="bottom">Subject bottom</div><footer>Below the fold</footer>'
        + (fixture.status === 200 ? '<img src="/unfinished">' : ''));
    };
    if (fixture.hold) { fixture.hold = false; fixture.respond = send; }
    else send();
  });
  try {
    await fs.cp(build, directory, { recursive: true });
    const manifest = path.join(directory, 'manifest.json');
    const content = JSON.parse(await fs.readFile(manifest, 'utf8'));
    assert.ok(content.permissions.includes('debugger'), 'The provided package is missing the required debugger permission');
    // Preauthorize only this loopback test package's existing optional host permission.
    content.host_permissions = ['<all_urls>'];
    await fs.writeFile(manifest, JSON.stringify(content));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await test(directory, 'http://127.0.0.1:' + server.address().port, fixture);
  } finally {
    server.closeAllConnections();
    server.close();
    if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('vb-silent-refresh-')) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
