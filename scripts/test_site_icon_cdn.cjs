const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const build = path.resolve(process.env.VB_TEST_EXTENSION || 'extension_chrome');
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
const site = 'https://github.com/';
const origin = new URL(site).origin;
const cdn = 'https://github.githubassets.com';

async function run(directory) {
  const browser = await puppeteer.launch({
    executablePath, headless:'new',
    args: [`--disable-extensions-except=${directory}`, `--load-extension=${directory}`]
  });
  try {
    const target = await browser.waitForTarget(worker => worker.type() === 'service_worker');
    const newtab = target.url().replace(/\/background\.js$/, '/newtab.html');
    const home = await browser.newPage();
    const errors = [];
    home.on('pageerror', err => errors.push(err.message));
    await home.goto(newtab);
    await home.waitForSelector('#folderDockList .folder-card');
    assert.equal(await home.evaluate(() => chrome.permissions.contains({origins:['<all_urls>']})), true);
    const ids = await home.evaluate(async url => {
      const [tree] = await chrome.bookmarks.getTree();
      const folder = await chrome.bookmarks.create({parentId:tree.children[0].id, title:'CDN icon fixture'});
      const bookmark = await chrome.bookmarks.create({parentId:folder.id, title:'GitHub', url});
      return {folder:folder.id, bookmark:bookmark.id};
    }, site);
    await home.goto(newtab + '#' + ids.folder);
    await home.waitForSelector(`#bookmarks [data-id="${ids.bookmark}"]`);
    const [destination] = await Promise.all([
      browser.waitForTarget(tab => tab.type() === 'page' && tab.url() === site),
      home.click(`#bookmarks [data-id="${ids.bookmark}"] .bookmark__title`)
    ]);
    const live = await destination.page();
    await live.waitForSelector('head link[rel~="icon"]');
    const declared = await live.$$eval('head link[rel~="icon"]', icons => icons.map(icon => icon.href));
    const asset = declared.find(url => new URL(url).origin === cdn
      && new URL(url).pathname.endsWith('.svg'));
    assert.ok(asset, 'The visited GitHub page must itself declare the CDN image');
    await home.waitForFunction(async origin => {
      const name = 'visual-bookmarks-site-icons';
      if (!(await indexedDB.databases()).some(database => database.name === name)) return false;
      return new Promise((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const query = db.transaction('icons').objectStore('icons').get(origin);
          query.onsuccess = () => {
            db.close();
            resolve(query.result?.vector === true && query.result.blob?.size > 0);
          };
          query.onerror = () => {
            db.close();
            reject(query.error);
          };
        };
      });
    }, {polling:200, timeout:18000}, origin);
    // Merely opening this pre-existing bookmark may refresh its icon. Only saving a bookmark takes a screenshot.
    const hasScreenshot = async url => new Promise((resolve, reject) => {
      const open = indexedDB.open('visual-bookmarks-visit-previews');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const request = db.transaction('visitPreviews').objectStore('visitPreviews').get(url);
        request.onsuccess = () => { db.close(); resolve(!!request.result?.blob?.size); };
        request.onerror = () => { db.close(); reject(request.error); };
      };
    });
    assert.equal(await home.evaluate(hasScreenshot, site), false);
    await home.evaluate(({folder, url}) => chrome.bookmarks.create({parentId:folder, url, title:'Saved while viewing GitHub'}), {
      folder:ids.folder, url:site
    });
    await home.waitForFunction(hasScreenshot, {polling:100, timeout:15000}, site);
    await home.bringToFront();
    assert.equal(home.url(), newtab + '#' + ids.folder);
    const shot = await home.waitForFunction(id => {
      const cover = document.querySelector(`#bookmarks [data-id="${id}"] .bookmark__screenshot.is-ready`);
      const image = cover?.querySelector('img');
      return image?.naturalWidth > 0 && getComputedStyle(cover).opacity === '1'
        && [image.naturalWidth, image.naturalHeight];
    }, {}, ids.bookmark);
    const visible = await home.waitForFunction(({folder, bookmark}) => {
      const left = document.querySelector(`[data-folder-id="${folder}"] [data-bookmark-id="${bookmark}"] img`);
      const right = document.querySelector(`#bookmarks [data-id="${bookmark}"] .site-icon__image`);
      if (left?.dataset.iconSource !== 'site-vector' || right?.dataset.iconSource !== 'site-vector'
        || left.naturalWidth !== 128 || right.naturalWidth !== 128 || left.src !== right.src) return false;
      return { left:left.naturalWidth, right:right.naturalWidth, shared:right.src.startsWith('blob:') };
    }, {}, ids);
    assert.deepEqual(await visible.jsonValue(), {left:128, right:128, shared:true});
    assert.deepEqual(errors, []);
    console.log(`PASS ${await browser.version()}: GitHub opened in a new tab, the original card displayed a ${(await shot.jsonValue()).join('x')} screenshot, and both panels reused ${asset}.`);
  } finally {
    await browser.close();
  }
}

(async () => {
  const directory = path.resolve(await fs.mkdtemp(path.join(os.tmpdir(), 'vb-site-icon-qa-')));
  try {
    await fs.cp(build, directory, {recursive:true});
    const file = path.join(directory, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    // Pre-authorize just this isolated copy. No browser permission prompt is automated.
    manifest.host_permissions = ['<all_urls>'];
    await fs.writeFile(file, JSON.stringify(manifest));
    await run(directory);
  } finally {
    if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('vb-site-icon-qa-')) {
      await fs.rm(directory,{recursive:true,force:true});
    }
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
