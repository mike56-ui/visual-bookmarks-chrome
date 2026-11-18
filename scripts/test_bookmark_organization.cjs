// Real bookmark mutations in an isolated Chromium profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

function chromium() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const cached = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (fs.existsSync(cached)) {
    for (const name of fs.readdirSync(cached).reverse()) {
      const file = path.join(cached, name, 'chrome-win64', 'chrome.exe');
      if (name.startsWith('chromium-') && fs.existsSync(file)) return file;
    }
  }
  return puppeteer.executablePath();
}

(async() => {
  const extension = path.resolve(process.env.VB_TEST_EXTENSION || 'extension_chrome');
  const browser = await puppeteer.launch({
    executablePath: chromium(), headless: 'new',
    args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension]
  });
  try {
    const worker = await browser.waitForTarget(target => target.type() === 'service_worker', { timeout: 12000 });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(worker.url().split('/').slice(0, 3).join('/') + '/newtab.html');
    await page.waitForSelector('[data-folder-kind="unfiled"]');
    const data = await page.evaluate(async() => {
      const [{ children:[bar] }] = await chrome.bookmarks.getTree();
      const folder = (parentId, title) => chrome.bookmarks.create({ parentId, title });
      const link = (parentId, title) => chrome.bookmarks.create({
        parentId, title, url: 'https://example.invalid/' + encodeURIComponent(title)
      });
      const groupA = await folder(bar.id, 'Alpha');
      const groupB = await folder(bar.id, 'Beta');
      const groupC = await folder(bar.id, 'Gamma');
      const marker0 = await folder(groupA.id, 'Subtree before links');
      const first = await link(groupA.id, 'A');
      const second = await link(groupA.id, 'B');
      const third = await link(groupA.id, 'C');
      const marker1 = await folder(groupA.id, 'Subtree between links');
      const fourth = await link(groupA.id, 'D');
      await Promise.all(Array.from({ length: 115 }, (_, index) => link(groupA.id, 'Fixture ' + index)));
      const left = await link(bar.id, 'First unfiled');
      const right = await link(bar.id, 'Second unfiled');
      return {
        bar: bar.id, barTitle: bar.title,
        a: groupA.id, b: groupB.id, c: groupC.id,
        marker0: marker0.id, marker1: marker1.id,
        first: first.id, second: second.id, third: third.id, fourth: fourth.id,
        left: left.id, right: right.id
      };
    });

    const folder = id => '[data-folder-id="' + id + '"]';
    const card = id => '#bookmarks .bookmark[data-id="' + id + '"]';
    const raw = id => page.evaluate(async id => (await chrome.bookmarks.getChildren(id)).map(item => item.id), id);
    const visible = () => page.$$eval('#bookmarks .bookmark[data-id]', items => items.map(item => item.dataset.id));
    const leftOrder = () => page.$$eval('#folderDockList .folder-card', items => items.map(item => item.dataset.folderId));
    const waitGrid = async expected => {
      await page.waitForFunction(ids => {
        const nodes = document.querySelectorAll('#bookmarks .bookmark');
        return ids.every((id, index) => nodes[index]?.dataset.id === id);
      }, { timeout: 8000 }, expected).catch(async(error) => {
        throw new Error('Grid expected ' + expected + ', received ' + (await visible()).slice(0, 4) + ': ' + error);
      });
    };
    const selectFolder = async id => {
      await page.$eval(folder(id) + ' .folder-card__open', element => element.click());
      await page.waitForFunction(id => document.getElementById('bookmarks').dataset.folder === id, { timeout: 8000 }, id);
    };
    const latestUndo = async() => {
      const latest = '.toast:not(.is-deleting):last-child';
      await page.waitForFunction(latest => [...document.querySelectorAll(latest)].some(toast =>
        toast.querySelector('.toast__action') && getComputedStyle(toast).transform === 'none'),
      { timeout: 5000 }, latest);
      await page.click(latest + ' .toast__action');
    };
    const drag = async(source, target, xRatio = 0.8, yRatio = 0.5) => {
      const start = await page.$eval(source, item => {
        const rect = item.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      const end = await page.$eval(target, (item, ratios) => {
        const rect = item.getBoundingClientRect();
        return { x: rect.left + rect.width * ratios[0], y: rect.top + rect.height * ratios[1] };
      }, [xRatio, yRatio]);
      assert.deepEqual(await page.evaluate(({ start, end }) => {
        return [!!document.elementFromPoint(start.x, start.y), !!document.elementFromPoint(end.x, end.y)];
      }, { start, end }), [true, true], 'gesture remains in the viewport');
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 15 });
      await page.mouse.up();
    };

    await page.waitForSelector(folder(data.c));
    // Let the native observer finish the bulk fixture import before beginning a pointer gesture.
    await page.waitForTimeout(180);
    await selectFolder(data.a);
    await waitGrid([data.first, data.second, data.third]);
    assert.ok((await visible()).length < 118);
    const original = await raw(data.a);
    assert.deepEqual(original.slice(0, 6),
      [data.marker0, data.first, data.second, data.third, data.marker1, data.fourth]);

    await drag(card(data.first) + ' .bookmark__stage', card(data.third) + ' .bookmark__stage');
    await waitGrid([data.second, data.third, data.first, data.fourth]);
    assert.equal(await page.$eval('#bookmarks', node => node.dataset.orderMode), 'manual');
    const synced = [...original];
    synced.splice(1, 3, data.second, data.third, data.first);
    assert.deepEqual(await raw(data.a), synced, 'compatible reordering preserves folders at exact native slots');
    await latestUndo();
    await waitGrid([data.first, data.second, data.third]);
    assert.deepEqual(await raw(data.a), original);

    await drag(card(data.first) + ' .bookmark__stage', card(data.fourth) + ' .bookmark__stage');
    await waitGrid([data.second, data.third, data.fourth, data.first]);
    assert.deepEqual(await raw(data.a), original, 'crossing an unseen subfolder saves display order only');
    await page.reload();
    await waitGrid([data.second, data.third, data.fourth, data.first]);
    assert.equal(await page.$eval('#bookmarks', node => node.dataset.orderMode), 'manual');
    await page.click('#newtabActionsToggle');
    await page.click('[data-newtab-action="common-order"]');
    await waitGrid([data.first, data.second, data.third]);
    assert.equal(await page.$eval('#bookmarks', node => node.dataset.orderMode), 'common');

    await selectFolder(data.bar);
    await waitGrid([data.left, data.right]);
    assert.equal(await page.evaluate(async id => (await chrome.bookmarks.get(id))[0].title, data.bar), data.barTitle);
    const initialBar = await raw(data.bar);
    await page.keyboard.down('Control');
    await page.click(card(data.left) + ' .bookmark__stage');
    await page.click(card(data.right) + ' .bookmark__stage');
    await page.keyboard.up('Control');
    assert.equal(await page.$$eval('#bookmarks .bookmark[data-selected]', items => items.length), 2);
    await drag(card(data.left) + ' .bookmark__stage', folder(data.b) + ' .folder-card__open', 0.5);
    await page.waitForFunction(ids => ids.every(id => !document.getElementById('vb-' + id)), { timeout: 8000 },
      [data.left, data.right]);
    assert.deepEqual(await raw(data.b), [data.left, data.right]);
    assert.deepEqual(await raw(data.bar), initialBar.filter(id => id !== data.left && id !== data.right));
    await page.waitForFunction(({ a, b }) => {
      const count = id => document.querySelector('[data-folder-id="' + id + '"] .folder-card__count')?.textContent;
      return count(a)?.trim().startsWith('0') && count(b)?.trim().startsWith('2');
    }, { timeout: 8000 }, { a: data.bar, b: data.b });
    await latestUndo();
    await waitGrid([data.left, data.right]);
    assert.deepEqual(await raw(data.b), []);
    assert.deepEqual(await raw(data.bar), initialBar, 'undo uses original sibling anchors');

    const rootBefore = await leftOrder();
    const index = rootBefore.indexOf(data.a);
    await drag(folder(data.c) + ' .folder-card__open', folder(data.a) + ' .folder-card__open', 0.5, 0.2);
    await page.waitForFunction(({ id, index }) => document.querySelectorAll('#folderDockList .folder-card')[index]
      ?.dataset.folderId === id, { timeout: 8000 }, { id: data.c, index });
    const dataAfter = await leftOrder();
    assert.ok(dataAfter.indexOf(data.marker0) > dataAfter.indexOf(data.a));
    assert.deepEqual(await raw(data.bar), initialBar, 'left display sorting does not change the native tree');
    await page.reload();
    await page.waitForSelector(folder(data.c));
    assert.deepEqual(await leftOrder(), dataAfter);

    await page.evaluate(id => chrome.storage.local.set({ bookmarkOpenCounts: { [id]: 10 } }), data.third);
    await selectFolder(data.a);
    await waitGrid([data.third, data.first, data.second]);
    await drag(card(data.third) + ' .bookmark__stage', card(data.second) + ' .bookmark__stage');
    await waitGrid([data.first, data.second, data.third]);
    assert.equal(await page.$eval('#bookmarks', node => node.dataset.orderMode), 'manual');
    assert.deepEqual(await raw(data.a), original, 'usage-ranked sort never rewrites native bookmarks');
    await latestUndo();
    await waitGrid([data.third, data.first, data.second]);
    assert.equal(await page.$eval('#bookmarks', node => node.dataset.orderMode), 'common');
    assert.deepEqual(errors, []);

    console.log('PASS: pointer-driven partial-grid reorder, native folder slots, saved local order, common restore, multiselect move, counts, undo, and left order.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
