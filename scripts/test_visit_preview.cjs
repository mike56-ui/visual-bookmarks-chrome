const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const build = path.resolve(process.env.VB_TEST_EXTENSION || 'extension_chrome');
const exe = process.env.PUPPETEER_EXECUTABLE_PATH;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(extension, origin, authorized, updateColor) {
  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: 'new',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const target = await browser.waitForTarget(t => t.type() === 'service_worker');
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
    const shot = await browser.newPage();
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
    // Grant and switch are independent. In this pass a clean, pre-authorized
    // QA manifest exercises the real OS browser screenshot API unattended.
    assert.equal(await home.evaluate(() => chrome.permissions.contains({origins:['<all_urls>']})), authorized);
    await shot.bringToFront();
    await shot.goto(origin+'/site');
    await sleep(1300);
    assert.equal((await getCache()).length,0,'opt-out must never capture');
    assert.equal((await getCachedIcons()).length,0,'opt-out must not cache declared icon');
    if (authorized) {
      await home.bringToFront();
      await home.click('#newtabActionsToggle');
      await home.click('#visitPreviewEnabled');
      await home.waitForFunction(async () => (await chrome.storage.local.get('visitPreviewEnabled')).visitPreviewEnabled === true);
      await home.click('#newtabActionsToggle');
      await shot.bringToFront();
    } else {
      // A migrated/stale true preference cannot bypass a missing permission.
      await home.evaluate(() => chrome.storage.local.set({visitPreviewEnabled:true}));
    }
    await shot.reload();
    if (!authorized) {
      await sleep(1500);
      assert.equal((await getCache()).length,0,'withheld access must never capture');
      assert.equal((await getCachedIcons()).length,0,'withheld access must not cache declared icon');
      await home.bringToFront();
      await home.setViewport({width:1280,height:800});
      await home.reload(); await home.waitForSelector('#bookmarks a.bookmark');
      assert.equal(await home.$('#bookmarks .bookmark__screenshot'), null, 'Uncached pages keep the native icon');
      const previewPath=path.resolve(process.env.VB_TEST_OUTPUT || 'output/playwright','visit-preview-edge.png');
      await fs.mkdir(path.dirname(previewPath),{recursive:true});
      await home.screenshot({path:previewPath});
      await home.click(`#bookmarks [data-id="${ids.site}"] .bookmark__title`);
      await home.waitForFunction(url=>location.href===url,{},origin+'/site');
      await home.goto(pageUrl+'#'+ids.folder);
      await home.waitForFunction(id=>document.querySelector('#bookmarks .bookmark')?.dataset.id===id,{},ids.site);
      assert.equal(await home.evaluate(async id=>(await chrome.storage.local.get('bookmarkOpenCounts')).bookmarkOpenCounts[id],ids.site),1);
      assert.deepEqual(errors,[]);
      console.log('PASS exact test package: opt-out, no grant, ordinary click counts once and sorts on return. Screenshot saved.');
      return;
    }
    const [first] = await poll(rows=>rows.length===1,'first foreground visit missing');
    assert.equal(first.url,origin+'/site');
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
    await sleep(1000);
    assert.deepEqual(await getCache(),[first],'opening new tab overwrote cached preview');
    await shot.bringToFront();
    await shot.reload(); await sleep(2400);
    assert.deepEqual(await getCache(),[first],'identical pixels were written again');
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
    updateColor();
    await shot.reload();
    const [second] = await poll(rows=>rows.length===1 && rows[0].digest!==first.digest,'changed visit did not update image');
    assert.ok(second.updated>first.updated);
    await shot.goto(origin+'/redirect'); await sleep(1300);
    assert.deepEqual(await getCache(),[second],'redirected login page captured');
    await shot.goto(origin+'/notes'); await home.bringToFront(); await sleep(1350);
    assert.deepEqual(await getCache(),[second],'captured after leaving before stabilization');
    await home.reload();
    await home.waitForFunction(({site, duplicate}) => {
      const custom = document.querySelector(`#bookmarks [data-id="${site}"] .bookmark__img--contain img`);
      const automatic = document.querySelector(`#bookmarks [data-id="${duplicate}"] .bookmark__screenshot:not(.bookmark__img--contain) img`);
      return custom?.naturalWidth === 20 && automatic?.naturalWidth > 0;
    }, {}, ids);
    assert.deepEqual(errors,[]);
    console.log('PASS pre-authorized Edge: real visit capture, visible on ordinary return, genuine site vector shared by both panels, duplicate URL reuse, same image no write, changed image replaced, custom cover retained, login redirect skipped, leave-page cancellation.');
  } finally { await browser.close(); }
}

(async () => {
  let color='#bb2255';
  const server=http.createServer((req,res)=>{
    if (req.url==='/redirect') {res.writeHead(302,{location:'/login'});res.end();return;}
    if (req.url==='/brand.svg') {
      res.writeHead(200,{'content-type':'image/svg+xml'});
      res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#2647e2"/><path fill="#fff" d="M7 10h5l4 11 4-11h5l-7 14h-4Z"/></svg>');
      return;
    }
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
    res.end(`<!doctype html><title>Preview fixture</title><link rel="icon" type="image/svg+xml" sizes="any" href="/brand.svg"><body style="margin:0;background:${color}"><main>Local preview test</main>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'vb-capture-qa-'));
  try {
    await run(build,origin,false,()=>{});
    await fs.cp(build,dir,{recursive:true});
    const file=path.join(dir,'manifest.json');
    const manifest=JSON.parse(await fs.readFile(file,'utf8'));
    manifest.host_permissions=['<all_urls>'];
    await fs.writeFile(file,JSON.stringify(manifest));
    await run(dir,origin,true,()=>{color='#147848';});
  } finally {
    server.close();
    await fs.rm(dir,{recursive:true,force:true});
  }
})().catch(err=>{console.error(err);process.exitCode=1;});
