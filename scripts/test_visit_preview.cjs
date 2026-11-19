const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const build = path.resolve(process.env.VB_TEST_EXTENSION || 'extension_chrome');
const exe = process.env.PUPPETEER_EXECUTABLE_PATH;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const requests = [];

async function countCaptureCalls(target) {
  const session = await target.createCDPSession();
  const evaluate = async expression => {
    const { result, exceptionDetails } = await session.send('Runtime.evaluate', { expression, returnByValue: true });
    assert.equal(exceptionDetails, undefined, 'Worker screenshot counter could not be installed or read');
    return result.value;
  };
  assert.equal(await evaluate(`(() => {
    const capture = chrome.tabs.captureVisibleTab;
    globalThis.testCaptureCalls = 0;
    chrome.tabs.captureVisibleTab = function(...args) {
      globalThis.testCaptureCalls++;
      return capture.apply(this, args);
    };
    return chrome.tabs.captureVisibleTab !== capture;
  })()`), true);
  return () => evaluate('globalThis.testCaptureCalls');
}

async function run(extension, origin, authorized, updateColor) {
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const target = await browser.waitForTarget(t => t.type() === 'service_worker');
    const getCaptureCalls = await countCaptureCalls(target);
    const pageUrl = target.url().replace(/\/background\.js$/, '/newtab.html');
    const home = await browser.newPage();
    const errors = [];
    home.on('pageerror', err => errors.push(err.message));
    // Enter the same new-tab override the user gets with Ctrl+T.
    await home.goto('chrome://newtab/');
    await home.waitForSelector('#folderDockList .folder-card');
    assert.equal(await home.evaluate(() => location.href), pageUrl);
    const ids = await home.evaluate(async origin => {
      const [tree] = await chrome.bookmarks.getTree();
      const folder = await chrome.bookmarks.create({parentId:tree.children[0].id, title:'Design QA'});
      const entries = [['Notes','/notes'],['Site','/site'],['Second copy','/site'],['Redirect','/redirect']];
      const ids = [];
      for (const [title, route] of entries) {
        const entry = await chrome.bookmarks.create({parentId:folder.id, title, url:origin+route});
        ids.push(entry.id);
      }
      return {folder:folder.id, first:ids[0], site:ids[1], duplicate:ids[2]};
    }, origin);
    await home.goto(pageUrl+'#'+ids.folder);
    await home.waitForSelector(`#bookmarks [data-id="${ids.site}"]`);
    await home.evaluate(() => { window.previewTestHome = true; });
    let shot = await browser.newPage();
    async function openCardInNewTab(from, id) {
      const sourceUrl = from.url();
      const selector = `#bookmarks [data-id="${id}"]`;
      const url = await from.$eval(selector, card => card.href);
      const existing = new Set(browser.targets());
      const [destination] = await Promise.all([
        browser.waitForTarget(t => !existing.has(t) && t.type() === 'page' && t.url() === url),
        from.click(selector + ' .bookmark__title')
      ]);
      await from.waitForFunction(async expected => {
        const [active] = await chrome.tabs.query({active:true, currentWindow:true});
        return active?.url === expected;
      }, {polling:100}, url);
      assert.equal(from.url(), sourceUrl, 'The original bookmark page must keep its folder');
      return destination.page();
    }
    const cardFor = id => `#bookmarks [data-id="${id}"]`;
    async function chooseCardAction(id, action = 'capture', keyboard = false) {
      const card = cardFor(id);
      const menuAction = `#bookmarkActionsMenu [data-action="${action}"]`;
      if (!keyboard) {
        await home.hover(card);
        await home.click(card + ' .bookmark__actions');
        await home.waitForSelector(menuAction, { visible: true });
        await home.click(menuAction);
        return;
      }
      await home.focus(card);
      await home.keyboard.down('Shift');
      await home.keyboard.press('F10');
      await home.keyboard.up('Shift');
      await home.waitForSelector(menuAction, { visible: true });
      const captureFocused = () => home.evaluate(selector => document.activeElement?.matches(selector), menuAction);
      for (let index = 0; index < 20 && !await captureFocused(); index++) await home.keyboard.press('ArrowDown');
      assert.equal(await captureFocused(), true, 'The update menu action must be reachable using the keyboard');
      await home.keyboard.press('Enter');
    }
    const readCardPixel = id => home.$eval(cardFor(id) + ' .bookmark__screenshot.is-ready img', image => {
      const canvas = new OffscreenCanvas(1, 1);
      const context = canvas.getContext('2d');
      context.drawImage(image, Math.floor(image.naturalWidth * .75), Math.floor(image.naturalHeight * .75), 1, 1, 0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    });
    const assertCardColor = async(id, rgb) => {
      const pixel = await readCardPixel(id);
      assert.ok(pixel.every((component, index) => Math.abs(component - rgb[index]) < 20), `Unexpected image color: ${pixel}`);
    };
    const getCache = () => home.evaluate(async () => {
      const databases = await indexedDB.databases();
      if (!databases.some(db => db.name === 'visual-bookmarks-visit-previews')) return [];
      return new Promise((resolve,reject) => {
        const request = indexedDB.open('visual-bookmarks-visit-previews');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const query = db.transaction('visitPreviews').objectStore('visitPreviews').getAll();
          query.onsuccess = () => { db.close(); resolve(query.result.map(({url,updated,digest}) => ({url,updated,digest}))); };
          query.onerror = () => reject(query.error);
        };
      });
    });
    const getCachedIcons = () => home.evaluate(async () => {
      const name = 'visual-bookmarks-site-icons';
      if (!(await indexedDB.databases()).some(db => db.name === name)) return [];
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const query = db.transaction('icons').objectStore('icons').getAll();
          query.onsuccess = () => {
            db.close();
            resolve(query.result.map(({origin, vector}) => ({origin, vector})));
          };
          query.onerror = () => { db.close(); reject(query.error); };
        };
      });
    });
    const poll = async (predicate, message) => {
      for (let i=0; i<35; i++) {
        const rows = await getCache();
        if (predicate(rows)) return rows;
        await sleep(200);
      }
      throw new Error(message);
    };
    const createSiteBookmark = title => home.evaluate(async ({ folder, origin, title }) =>
      (await chrome.bookmarks.create({ parentId: folder, title, url: origin + '/site' })).id, { folder: ids.folder, origin, title });
    // A clean pre-authorized QA manifest exercises the real capture API
    // unattended. The unmodified package never captures without permission.
    assert.equal(await home.evaluate(() => chrome.permissions.contains({origins:['<all_urls>']})), authorized);
    assert.equal(await home.evaluate(async () =>
      (await chrome.storage.local.get('visitPreviewEnabled')).visitPreviewEnabled), undefined);
    if (authorized) await home.evaluate(() => chrome.storage.local.set({visitPreviewEnabled:false}));
    await shot.bringToFront();
    await shot.goto(origin+'/site');
    const withheld = await createSiteBookmark('Capture access unavailable');
    await sleep(1300);
    assert.equal((await getCache()).length,0,'opt-out must never capture');
    assert.equal(await getCaptureCalls(), 0, 'A native save without capture access must not invoke the screenshot API');
    await home.evaluate(id => chrome.bookmarks.remove(id), withheld);
    if (authorized) {
      await home.evaluate(async ({ site, duplicate }) => {
        await chrome.bookmarks.remove(site);
        await chrome.bookmarks.remove(duplicate);
        await chrome.storage.local.remove('visitPreviewEnabled');
      }, ids);
    } else {
      // A migrated/stale true preference cannot bypass a missing permission.
      await home.evaluate(() => chrome.storage.local.set({visitPreviewEnabled:true}));
    }
    await shot.reload();
    if (!authorized) {
      const staleGrant = await createSiteBookmark('Invalid permission preference');
      await sleep(1500);
      assert.equal((await getCache()).length,0,'withheld access must never capture');
      assert.equal((await getCachedIcons()).length,0,'withheld access must not cache declared icon');
      assert.equal(await getCaptureCalls(), 0, 'Withheld permission must prevent even a screenshot API call');
      await home.evaluate(id => chrome.bookmarks.remove(id), staleGrant);
      await home.bringToFront();
      await home.setViewport({width:1280,height:800});
      await home.reload(); await home.waitForSelector('#bookmarks a.bookmark');
      assert.equal(await home.$('#bookmarks .bookmark__screenshot'), null, 'Uncached pages keep the native icon');
      const previewPath=path.resolve(process.env.VB_TEST_OUTPUT || 'output/playwright','visit-preview-edge.png');
      await fs.mkdir(path.dirname(previewPath),{recursive:true});
      await home.screenshot({path:previewPath});
      const opened = await openCardInNewTab(home, ids.site);
      await opened.close();
      await home.bringToFront();
      await home.waitForFunction(id=>document.querySelector('#bookmarks .bookmark')?.dataset.id===id,{},ids.site);
      assert.equal(await home.evaluate(async id=>(await chrome.storage.local.get('bookmarkOpenCounts')).bookmarkOpenCounts[id],ids.site),1);
      assert.deepEqual(errors,[]);
      console.log('PASS exact test package: opt-out, no grant, ordinary click counts once and sorts on return. Screenshot saved.');
      return;
    }
    const documentTime = await shot.evaluate(() => performance.timeOrigin);
    await sleep(900);
    assert.equal(await getCaptureCalls(), 0, 'An unbookmarked page must not invoke the screenshot API');
    ids.site = await createSiteBookmark('Site');
    const [first] = await poll(rows=>rows.length===1,'Native bookmark creation did not capture the open page');
    assert.equal(first.url,origin+'/site');
    assert.equal(await shot.evaluate(() => performance.timeOrigin), documentTime, 'Native creation must not navigate or reload the site');
    assert.equal(await getCaptureCalls(), 1, 'A new bookmark must invoke the screenshot API once');
    ids.duplicate = await createSiteBookmark('Second copy');
    for (let index = 0; index < 30 && !(await getCachedIcons()).length; index++) await sleep(120);
    assert.deepEqual(await getCachedIcons(), [{ origin, vector: true }], 'Fetch genuine high-resolution SVG from the site');
    await home.bringToFront();
    await home.waitForFunction(id => {
      const card = document.querySelector(`#bookmarks [data-id="${id}"]`);
      const screenshot = card?.querySelector('.bookmark__screenshot');
      const image = screenshot?.querySelector('img');
      return window.previewTestHome && !card?.matches(':hover') && image?.naturalWidth > 0
        && getComputedStyle(screenshot).opacity === '1';
    }, {}, ids.duplicate);
    await home.waitForFunction(({site, folder}) => {
      const left = document.querySelector(`[data-folder-id="${folder}"] [data-bookmark-id="${site}"] img`);
      const right = document.querySelector(`#bookmarks [data-id="${site}"] .site-icon__image`);
      return left?.dataset.iconSource === 'site-vector' && right?.dataset.iconSource === 'site-vector'
        && left.naturalWidth === 128 && right.naturalWidth === 128 && left.src === right.src;
    }, {}, ids);
    for (const dpr of [1, 2]) {
      await home.setViewport({ ...home.viewport(), deviceScaleFactor: dpr });
      const size = await home.evaluate(({ site, folder }) => {
        const cell = document.querySelector(`[data-folder-id="${folder}"] [data-bookmark-id="${site}"]`);
        const bounds = cell.getBoundingClientRect();
        const logo = cell.querySelector('.site-icon__image').getBoundingClientRect();
        return {
          width: logo.width, height: logo.height,
          contained: logo.left >= bounds.left && logo.right <= bounds.right
            && logo.top >= bounds.top && logo.bottom <= bounds.bottom
        };
      }, ids);
      assert.equal(size.contained, true);
      assert.deepEqual([size.width, size.height], [16, 16], `Folder logo size at ${dpr}x`);
    }
    await home.setViewport({ ...home.viewport(), deviceScaleFactor: 1 });
    await sleep(1000);
    assert.deepEqual(await getCache(),[first],'opening new tab overwrote cached preview');
    await shot.evaluate(() => { document.body.style.background = '#603fb0'; });
    await shot.bringToFront();
    assert.equal(await shot.$eval('body', body => getComputedStyle(body).backgroundColor), 'rgb(96, 63, 176)');
    await sleep(1250);
    assert.deepEqual(await getCache(),[first],'Returning to an already-open page changed its initial image or timestamp');
    assert.equal(await getCaptureCalls(), 1, 'An already-cached page must not invoke the screenshot API on activation');

    updateColor('#603fb0');
    await shot.close();
    await home.bringToFront();
    shot = await openCardInNewTab(home, ids.duplicate);
    assert.equal(await shot.$eval('body', body => getComputedStyle(body).backgroundColor), 'rgb(96, 63, 176)');
    await sleep(1300);
    assert.deepEqual(await getCache(),[first],'Reopening a bookmark changed its initial image or timestamp');
    assert.equal(await getCaptureCalls(), 1, 'Reopening an already-cached bookmark must not invoke the screenshot API');
    console.log('PASS native bookmark creation captures the open page once; reactivation and reopening use the original image without capture calls.');

    await shot.goto(origin+'/notes');
    await sleep(1400);
    assert.deepEqual(await getCache(), [first], 'Visiting an old bookmark without a preview must not capture');
    assert.equal(await getCaptureCalls(), 1, 'An ordinary visit to a saved page without a preview must not invoke capture');

    await home.bringToFront();
    await assertCardColor(ids.duplicate, [187, 34, 85]);
    await assertCardColor(ids.site, [187, 34, 85]);
    await home.evaluate(({ site, duplicate }) => {
      const image = id => document.querySelector(`#bookmarks [data-id="${id}"] .bookmark__screenshot.is-ready img`);
      window.singleUpdateFixture = { target: image(duplicate), sibling: image(site), siblingSrc: image(site).src };
    }, ids);
    updateColor('#147848');
    await chooseCardAction(ids.duplicate);
    await home.waitForFunction(id => {
      const next = document.querySelector(`#bookmarks [data-id="${id}"] .bookmark__screenshot.is-ready img`);
      return next?.naturalWidth > 0 && next !== window.singleUpdateFixture.target
        && next.src !== window.singleUpdateFixture.target.src;
    }, { timeout: 8000 }, ids.duplicate);
    await assertCardColor(ids.duplicate, [20, 120, 72]);
    await assertCardColor(ids.site, [187, 34, 85]);
    assert.equal(await home.evaluate(({ site }) => {
      const other = document.querySelector(`#bookmarks [data-id="${site}"] .bookmark__screenshot.is-ready img`);
      return other === window.singleUpdateFixture.sibling && other.src === window.singleUpdateFixture.siblingSrc;
    }, ids), true, 'A single update must preserve the other card with the same URL');
    assert.equal(await home.$(cardFor(ids.first) + ' .bookmark__screenshot'), null,
      'A single update must preserve an unrelated card with no cached image');
    assert.deepEqual(await getCache(), [first], 'A single update must not overwrite the shared URL cache');
    assert.equal(await getCaptureCalls(), 2, 'Explicitly updating one card must invoke capture once');
    console.log('PASS the card menu refreshes only its own preview. Its same-URL sibling and unrelated card stay unchanged.');

    const waitForImageCleared = id => home.waitForFunction(id => {
      const card = document.querySelector(`#bookmarks [data-id="${id}"]`);
      return card && !card.querySelector('.bookmark__screenshot');
    }, { timeout: 5000 }, id);
    await chooseCardAction(ids.duplicate, 'delete_thumbnail');
    await waitForImageCleared(ids.duplicate);
    await assertCardColor(ids.site, [187, 34, 85]);
    assert.deepEqual(await getCache(), [first], 'Clearing an independent card must not remove the shared image');
    await home.reload();
    await waitForImageCleared(ids.duplicate);
    await home.waitForSelector(cardFor(ids.site) + ' .bookmark__screenshot.is-ready img');
    await assertCardColor(ids.site, [187, 34, 85]);
    await chooseCardAction(ids.duplicate);
    await home.waitForSelector(cardFor(ids.duplicate) + ' .bookmark__screenshot.is-ready img');
    await assertCardColor(ids.duplicate, [20, 120, 72]);
    await chooseCardAction(ids.site, 'delete_thumbnail');
    await waitForImageCleared(ids.site);
    await assertCardColor(ids.duplicate, [20, 120, 72]);
    assert.deepEqual(await getCache(), [first], 'Clearing a shared image on one card must keep its URL cache');

    await chooseCardAction(ids.first);
    await home.waitForSelector(cardFor(ids.first) + ' .bookmark__screenshot.is-ready img');
    await chooseCardAction(ids.first, 'delete_thumbnail');
    await waitForImageCleared(ids.first);
    const callsAfterClear = await getCaptureCalls();
    assert.equal(await home.evaluate(({ id, url }) => chrome.runtime.sendMessage({ newBookmarkPreview: { id, url } }),
      { id: ids.first, url: origin + '/notes' }), true);
    await waitForImageCleared(ids.first);
    assert.equal(await getCaptureCalls(), callsAfterClear, 'A delayed initial-image request must respect an explicit clear');
    assert.deepEqual(await getCache(), [first], 'Clearing a single preview must not create or remove any shared image');
    console.log('PASS clearing a preview survives reload, preserves same-URL siblings, blocks initial capture, and permits a manual restore.');

    // Preserve a user-selected per-bookmark cover while a second bookmark
    // with the exact same URL continues to show the shared live preview.
    await home.evaluate(async id => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 20;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = 'darkorange';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('visual-bookmarks');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('images', 'readwrite');
          tx.objectStore('images').put({ id, blob, custom: true });
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onabort = () => { db.close(); reject(tx.error); };
        };
      });
    }, ids.site);
    await shot.goto(origin+'/redirect'); await sleep(1300);
    assert.deepEqual(await getCache(),[first],'redirected login page captured');
    await home.reload();
    await home.waitForFunction(({site, duplicate}) => {
      const custom = document.querySelector(`#bookmarks [data-id="${site}"] .bookmark__img--contain img`);
      const automatic = document.querySelector(`#bookmarks [data-id="${duplicate}"] .bookmark__screenshot:not(.bookmark__img--contain) img`);
      return custom?.naturalWidth === 20 && automatic?.naturalWidth > 0;
    }, {}, ids);
    await assertCardColor(ids.duplicate, [20, 120, 72]);
    await chooseCardAction(ids.site, 'capture', true);
    await home.waitForFunction(() => [...document.querySelectorAll('.toast__message')].some(node =>
      node.textContent === chrome.i18n.getMessage('notice_thumb_custom_kept')), { timeout: 5000 });
    assert.equal(await home.$eval(cardFor(ids.site) + ' .bookmark__img--contain img', image => image.naturalWidth), 20);
    assert.equal(await getCaptureCalls(), callsAfterClear, 'A custom cover must not invoke capture or be overwritten');
    const late = await home.evaluate(async ({folder, origin}) => {
      const copies = Array.from({length: 110}, (_, index) => ({parentId:folder, title:`Ordinary copy ${index}`, url:origin+'/notes'}));
      await Promise.all(copies.map(bookmark => chrome.bookmarks.create(bookmark)));
      return (await chrome.bookmarks.create({parentId:folder, title:'Unloaded card', url:origin+'/late'})).id;
    }, {folder:ids.folder, origin});
    await home.waitForSelector('.bookmarks-load-more');
    assert.equal(await home.$(`#bookmarks [data-id="${late}"]`),null,'Batch fixture must be outside the loaded page');
    const existingWindow = await home.evaluate(async url => {
      const popup = await chrome.windows.create({ url, type:'popup', focused:false });
      return { id:popup.id, tabId:popup.tabs[0].id };
    }, origin+'/existing-user-tab');
    await home.evaluate(async () => {
      const original = await chrome.tabs.getCurrent();
      const audit = window.captureAudit = { original, opened: [], closed: [], lostFocus: 0 };
      chrome.windows.onCreated.addListener(window => { audit.opened.push(window.id); });
      chrome.windows.onRemoved.addListener(id => { audit.closed.push(id); });
      window.addEventListener('blur', () => { audit.lostFocus++; });
    });
    const startBatch = async () => {
      await home.evaluate(() => {
        window.captureAudit.opened.length=0;
        window.captureAudit.closed.length=0;
        window.captureAudit.lostFocus=0;
      });
      await home.click('#newtabActionsToggle');
      await home.click('[data-newtab-action="refresh-previews"]');
    };
    const verifyWorkspace = async () => {
      await home.waitForFunction(() => window.captureAudit.opened.length === 1
        && window.captureAudit.closed.includes(window.captureAudit.opened[0]));
      const audit = await home.evaluate(async ({ id, tabId }) => {
        const { original, opened, closed, lostFocus } = window.captureAudit;
        const existing = await chrome.tabs.get(tabId);
        const owner = await chrome.windows.get(original.windowId);
        return { opened, closed, lostFocus, focus: owner.focused && document.hasFocus(), existing: existing.windowId === id };
      }, existingWindow);
      assert.equal(audit.opened.length,1,'A batch must create exactly one scratch window');
      assert.deepEqual(audit.closed,audit.opened,'Only the batch scratch window may close');
      assert.equal(audit.existing,true,'Pre-existing user tab must remain untouched');
      assert.equal(audit.focus,true,'The source tab must remain focused');
      assert.equal(audit.lostFocus,0,'The batch must not steal source tab focus even transiently');
    };
    updateColor('#2d61b5');
    await startBatch();
    const batch = await poll(rows => rows.length === 3
      && rows.some(row => row.url === origin+'/notes') && rows.some(row => row.url === origin+'/late')
      && rows.some(row => row.url === origin+'/site' && row.digest !== first.digest),
      'One-click refresh did not update existing and unloaded bookmarks');
    await home.waitForSelector('.progress-toast', {hidden:true});
    assert.ok(batch.every(row => !row.url.endsWith('/redirect')));
    await waitForImageCleared(ids.first);
    assert.equal(await home.$eval(`#bookmarks [data-id="${ids.site}"] .bookmark__img--contain img`,
      image => image.naturalWidth),20);
    await verifyWorkspace();
    console.log('PASS one-click folder refresh: uncached and unloaded cards, changed cached card, shared duplicates, protected cover and redirect skip.');
    const stopFolder = await home.evaluate(async ({ folder, origin }) => {
      const [parent] = await chrome.bookmarks.get(folder);
      const stop = await chrome.bookmarks.create({ parentId: parent.parentId, title: 'Cancellation fixture' });
      await chrome.bookmarks.create({ parentId:stop.id, title:'Slow job', url: origin+'/cancel-slow' });
      await chrome.bookmarks.create({ parentId:stop.id, title:'Must never start', url: origin+'/cancel-late' });
      return stop.id;
    }, {folder:ids.folder, origin});
    await home.evaluate(id => { location.hash = id; }, stopFolder);
    await home.waitForFunction(id => document.querySelector('#bookmarks').dataset.folder === id, {}, stopFolder);
    await startBatch();
    await home.waitForFunction(async () => {
      const [id] = window.captureAudit.opened;
      if (id === undefined) return false;
      const [tab] = await chrome.tabs.query({ windowId:id, active:true });
      return (tab?.pendingUrl || tab?.url)?.endsWith('/cancel-slow');
    });
    await home.click('.progress-toast__cancel');
    await verifyWorkspace();
    await sleep(1800);
    assert.deepEqual(await getCache(),batch,'A cancelled in-flight page must not replace cache');
    assert.ok(!requests.includes('/cancel-late'),'Stop must prevent navigating to remaining URLs');

    const race = await home.evaluate(async ({folder, origin}) => {
      const [parent] = await chrome.bookmarks.get(folder);
      const test = await chrome.bookmarks.create({parentId:parent.parentId,title:'Navigation fixture'});
      const entry = await chrome.bookmarks.create({parentId:test.id,title:'Race',url:origin+'/site'});
      return { id:test.id, bookmarkId:entry.id };
    }, {folder:ids.folder, origin});
    await home.evaluate(id => { location.hash = id; }, race.id);
    await home.waitForFunction(id => document.querySelector('#bookmarks').dataset.folder === id, {}, race.id);
    await startBatch();
    await home.waitForFunction(async () => {
      const [id] = window.captureAudit.opened;
      if (id === undefined) return false;
      const [tab] = await chrome.tabs.query({ windowId:id, active:true });
      return tab?.status === 'complete' && tab.url.endsWith('/site');
    });
    await home.evaluate(async url => {
      const [tab] = await chrome.tabs.query({windowId:window.captureAudit.opened[0],active:true});
      await chrome.tabs.update(tab.id, { url });
    }, origin+'/unrelated');
    await verifyWorkspace();
    assert.deepEqual(await getCache(),batch,'A different destination must not overwrite an existing preview');
    await home.evaluate(({url,id}) => chrome.runtime.sendMessage({capture:{captureUrl:url,id}}).catch(() => undefined),
      {url:origin+'/site',id:race.bookmarkId});
    await sleep(600);
    assert.deepEqual(await getCache(),batch,'An expired legacy command must not change cache');
    assert.equal(await home.evaluate(() => window.captureAudit.opened.length),1,'An expired command must not open a window');
    console.log('PASS one scratch window per batch, zero focus theft, clean cancel, old window preserved and stale/navigation writes rejected.');
    assert.deepEqual(errors,[]);
    console.log('PASS pre-authorized Edge: first image visible on return, genuine site vector shared by both panels, duplicate URL reuse, custom cover retained, login redirect skipped.');
  } finally { await browser.close(); }
}

(async () => {
  let color='#bb2255';
  const server=http.createServer((req,res)=>{
    requests.push(req.url);
    if (req.url==='/redirect') {res.writeHead(302,{location:'/login'});res.end();return;}
    if (req.url==='/brand.svg') {
      res.writeHead(200,{'content-type':'image/svg+xml'});
      res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2647e2"/><path fill="#fff" d="M7 10h5l4 11 4-11h5l-7 14h-4Z"/></svg>');
      return;
    }
    const respond = () => {
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
      res.end(`<!doctype html><title>Preview fixture</title><link rel="icon" type="image/svg+xml" sizes="any" href="/brand.svg"><body style="margin:0;background:${color}"><main>Local preview test</main>`);
    };
    if (req.url === '/cancel-slow') setTimeout(respond,1500);
    else respond();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const dir=path.resolve(await fs.mkdtemp(path.join(os.tmpdir(),'vb-capture-qa-')));
  try {
    await run(build,origin,false,()=>{});
    await fs.cp(build,dir,{recursive:true});
    const file=path.join(dir,'manifest.json');
    const manifest=JSON.parse(await fs.readFile(file,'utf8'));
    manifest.host_permissions=['<all_urls>'];
    await fs.writeFile(file,JSON.stringify(manifest));
    await run(dir,origin,true,next=>{color=next;});
  } finally {
    server.close();
    if (path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith('vb-capture-qa-')) {
      await fs.rm(dir,{recursive:true,force:true});
    }
  }
})().catch(err=>{console.error(err);process.exitCode=1;});
