const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const puppeteer = require('puppeteer');

const extension = path.resolve(process.env.VB_TEST_EXTENSION || 'extension_chrome');
const edge = process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe');
const desktop = { width: 1440, height: 900 };
const storedLayout = 'visual-bookmarks-folder-panel';
const screenshotDirectory = process.env.VB_LAYOUT_SCREENSHOTS;

async function run() {
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || (edge && fs.existsSync(edge) ? edge : undefined),
    headless: 'new',
    args: ['--lang=zh-CN', '--disable-extensions-except=' + extension, '--load-extension=' + extension, '--host-resolver-rules=MAP *.test ~NOTFOUND']
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', reason => errors.push(reason.message));
    await page.setViewport(desktop);
    await page.goto('chrome://newtab/');
    await page.waitForSelector('#folderDockHandle');
    const source = await page.evaluate(async () => {
      const [tree] = await chrome.bookmarks.getTree();
      const root = tree.children[0].id;
      const folder = await chrome.bookmarks.create({ parentId: root, title: '工作书签' });
      await chrome.storage.local.set({ autoFillMissingPreviews: false, visitPreviewEnabled: false });
      const folders = ['稍后阅读', '设计工具', '项目文档', '前端开发', '效率工具', '写作灵感', '资料库', '产品分析',
        '工作计划', '客户案例', '财务', '团队协作', '摄影', '默认归档'];
      await Promise.all(folders.map(title => chrome.bookmarks.create({ parentId: root, title })));
      const samples = [
        ['原型与交互指南', 'design'], ['设计规范', 'system'], ['每周工作计划', 'plan'], ['图标资料库', 'icons'],
        ['项目进度看板', 'board'], ['团队会议记录', 'notes'], ['研发手册', 'dev'], ['产品研究报告', 'research'],
        ['配色工具', 'color'], ['阅读清单', 'reading'], ['团队知识库', 'wiki'], ['数据分析', 'data']
      ];
      await Promise.all(Array.from({ length: 72 }, (_, n) => chrome.bookmarks.create({
        parentId: folder.id, title: samples[n % samples.length][0] + ' · ' + (1 + Math.floor(n / samples.length)),
        url: 'https://' + samples[n % samples.length][1] + '.example.test/article/' + n
      })));
      return folder.id;
    });
    const extensionPage = await page.evaluate(() => chrome.runtime.getURL('newtab.html'));
    // Open the registered extension URL directly so the real browser zoom API is available.
    await page.goto('about:blank');
    await page.goto(extensionPage + '#' + source);
    await page.waitForSelector('#bookmarks .bookmark__stage', { visible: true });

    const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    async function screenshot(name) {
      if (!screenshotDirectory) return;
      fs.mkdirSync(screenshotDirectory, { recursive: true });
      await page.mouse.move(1, 1);
      await settle();
      await page.screenshot({ path: path.join(screenshotDirectory, name + '.png') });
    }
    const rect = () => page.$eval('#folderDock', panel => {
      const { x, y, width, height } = panel.getBoundingClientRect();
      return { x, y, width, height };
    });
    async function drag(x, y, dx, dy) {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y + dy, { steps: 12 });
      await page.mouse.up();
      await settle();
    }
    async function move(dx, dy) {
      const handle = await page.$('#folderDockHandle');
      const {x, y, width, height} = await handle.boundingBox();
      await drag(x + width / 2, y + height / 2, dx, dy);
    }
    async function geometry() {
      await settle();
      return page.evaluate(() => {
        const panel = document.querySelector('#folderDock').getBoundingClientRect();
        const cards = [...document.querySelectorAll('#bookmarks a.bookmark:not([hidden])')];
        const grid = document.querySelector('#bookmarks');
        const controls = [...document.querySelectorAll('#bookmarkSearch, #newtabActionsToggle, #bingResults')];
        const overlap = node => {
          const b = node.getBoundingClientRect();
          let { top, bottom, left, right } = b;
          for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
            const clip = parent.getBoundingClientRect();
            const style = getComputedStyle(parent);
            if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
              top = Math.max(top, clip.top);
              bottom = Math.min(bottom, clip.bottom);
            }
            if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
              left = Math.max(left, clip.left);
              right = Math.min(right, clip.right);
            }
          }
          return Math.max(0, Math.min(panel.right, right, innerWidth) - Math.max(panel.left, left, 0))
            * Math.max(0, Math.min(panel.bottom, bottom, innerHeight) - Math.max(panel.top, top, 0));
        };
        return {
          overlapCards: cards.filter(node => overlap(node) > 1).length,
          overlapControls: controls.filter(node => overlap(node) > 1).length,
          outside: panel.width > 0 && (panel.left < -1 || panel.right > document.documentElement.clientWidth + 1
            || panel.top < -1 || panel.bottom > document.documentElement.clientHeight + 1),
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
            || grid.scrollWidth > grid.clientWidth + 1,
          cards: cards.length
        };
      });
    }
    function verify(label, state) {
      assert.ok(state.cards > 0, label + ': missing bookmark fixtures');
      assert.deepEqual([state.overlapCards, state.overlapControls, state.outside, state.overflow],
        [0, 0, false, false], label + ' ' + JSON.stringify(state));
    }
    const reset = async () => {
      await page.evaluate(() => document.dispatchEvent(new Event('newtab:reset-panel')));
      await settle();
    };
    const dock = () => page.$eval('#folderDock', panel => panel.dataset.dock);
    async function dockAt(x, y) {
      const handle = await page.$('#folderDockHandle');
      const box = await handle.boundingBox();
      const originX = box.x + box.width / 2;
      const originY = box.y + box.height / 2;
      await drag(originX, originY, x - originX, y - originY);
    }
    async function scrollContent() {
      const side = await dock();
      const point = await page.$eval('#bookmarks', grid => {
        const stage = [...grid.querySelectorAll('.bookmark__stage')].map(node => node.getBoundingClientRect())
          .find(b => b.top >= 0 && b.bottom <= innerHeight);
        return { x: stage.x + stage.width / 2, y: stage.y + stage.height / 2 };
      });
      const firstY = () => page.$eval('#bookmarks a.bookmark', node => node.getBoundingClientRect().top);
      const toolbarControls = () => page.evaluate(() => ['#bookmarkSearch', '#newtabActionsToggle'].map(selector => {
        const node = document.querySelector(selector);
        const box = node.getBoundingClientRect();
        const x = box.left + box.width / 2, y = box.top + box.height / 2;
        return { x, y, hit: node.contains(document.elementFromPoint(x, y)) };
      }));
      const initialControls = await toolbarControls();
      const before = await firstY();
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel({ deltaY: 540 });
      await page.waitForFunction(y => document.querySelector('#bookmarks a.bookmark').getBoundingClientRect().top < y - 80, {}, before);
      verify(side + ' after scroll', await geometry());
      const controls = await toolbarControls();
      assert.deepEqual(controls, initialControls, 'scrolling moves only the results on ' + side);
      assert.ok(controls.every(control => control.hit), 'toolbar controls remain clickable on ' + side);
      await page.mouse.click(controls[0].x, controls[0].y);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'bookmarkSearch');
      await page.mouse.click(controls[1].x, controls[1].y);
      await page.waitForSelector('#settingsDrawer[open]', { visible: true });
      await page.click('.settings-drawer__close');
      await page.waitForSelector('#settingsDrawer[open]', { hidden: true });
      await page.mouse.move(point.x, point.y);
      if (side === 'right') {
        await page.mouse.wheel({ deltaY: 5000 });
        await page.waitForFunction(() => {
          const app = document.querySelector('.app');
          return app.scrollTop > 0 && app.scrollTop + app.clientHeight >= app.scrollHeight - 2;
        });
        await page.mouse.click(controls[0].x, controls[0].y);
        const input = await page.target().createCDPSession();
        await input.send('Input.insertText', { text: 'example.test' });
        await input.detach();
        await page.waitForFunction(() => {
          const first = document.querySelector('#bookmarks a.bookmark:not([hidden])');
          const toolbar = document.querySelector('.newtab-toolbar').getBoundingClientRect();
          return document.body.classList.contains('has-search') && first?.getBoundingClientRect().top >= toolbar.bottom - 1
            && first.getBoundingClientRect().bottom <= innerHeight;
        }, { timeout: 4000 });
        await page.click('#searchReset');
        await page.waitForSelector('#bingResults', { hidden: true });
      }
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel({ deltaY: -1200 });
      await page.waitForFunction(y => Math.abs(document.querySelector('#bookmarks a.bookmark').getBoundingClientRect().top - y) < 2, {}, before);
    }
    verify('initial', await geometry());
    assert.ok(await page.$eval('#folderDockResize', node => {
      const mark = getComputedStyle(node, '::after');
      return ['none', 'normal'].includes(mark.content) || mark.display === 'none' || mark.visibility === 'hidden';
    }), 'corner resize control has no visible decoration');
    const initial = await rect();
    await move(40, 98);
    const left = await rect();
    assert.ok(left.y > initial.y + 12, 'move handle must move vertically');
    const leftLayout = await geometry();
    await move(desktop.width - left.width - left.x - 24, 0);
    const right = await rect();
    assert.ok(right.x > desktop.width / 2, 'move handle must move to the right');
    const rightLayout = await geometry();
    console.log('Card overlaps, moved left / right:', leftLayout.overlapCards, '/', rightLayout.overlapCards);
    verify('moved left', leftLayout);
    verify('moved right', rightLayout);
    assert.equal(await dock(), 'right');
    await screenshot('right');
    await page.type('#bookmarkSearch', 'example.test');
    await page.waitForSelector('#bingResults', { visible: true });
    verify('right with search and Bing', await geometry());
    await page.click('#bookmarkSearch', { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.waitForSelector('#bingResults', { hidden: true });
    await scrollContent();
    for (const [side, x, y] of [['top', 720, 10], ['bottom', 720, 891], ['left', 20, 120]]) {
      await dockAt(x, y);
      assert.equal(await dock(), side);
      verify(side, await geometry());
      if (side === 'top') await screenshot('top');
      if (side === 'top' || side === 'bottom') {
        const bounds = await (await page.$('#folderDockList')).boundingBox();
        const list = '#folderDockList';
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.evaluate(() => {
          window.__lastLayoutWheel = null;
          window.addEventListener('wheel', event => {
            window.__lastLayoutWheel = { target: event.target.className, inList: Boolean(event.target.closest('#folderDockList')),
              x: event.deltaX, y: event.deltaY, cancelable: event.cancelable };
          }, { once: true, passive: true, capture: true });
        });
        await page.mouse.wheel({ deltaY: 260 });
        try {
          await page.waitForFunction(s => document.querySelector(s).scrollLeft > 50, { timeout: 3000 }, list);
        } catch (cause) {
          const metrics = await page.$eval(list, node => {
            const b = node.getBoundingClientRect();
            return [node.scrollLeft, node.clientWidth, node.scrollWidth, node.childElementCount,
              getComputedStyle(node).getPropertyValue('--folder-list-axis'), document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)?.className,
              window.__lastLayoutWheel];
          });
          throw new Error(side + ' folder strip wheel, metrics ' + JSON.stringify(metrics), { cause });
        }
        await page.mouse.wheel({ deltaY: -1200 });
        await page.waitForFunction(s => document.querySelector(s).scrollLeft < 1, { timeout: 3000 }, list);
      }
      await scrollContent();
    }
    await reset();
    assert.deepEqual(await rect(), initial, 'reset must restore default geometry');
    await move(114, 95);
    for (const edge of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
      const before = await rect();
      const dx = edge.includes('w') ? 19 : edge.includes('e') ? -19 : 0;
      const dy = edge.includes('n') ? 17 : edge.includes('s') ? -17 : 0;
      const handle = await page.waitForSelector('[data-resize-edge="' + edge + '"]', { visible: true });
      const box = await handle.boundingBox();
      // The movement grip may occupy the middle of the top border.
      const x = box.x + box.width * (edge === 'n' ? 0.25 : 0.5);
      const y = box.y + box.height / 2;
      assert.equal(await page.evaluate(({x, y}) => document.elementFromPoint(x, y)?.closest('[data-resize-edge]')?.dataset.resizeEdge, {x,y}),
        edge, edge + ' pointer hit');
      await drag(x, y, dx, dy);
      const after = await rect();
      const expected = {
        x: before.x + (edge.includes('w') ? dx : 0), y: before.y + (edge.includes('n') ? dy : 0),
        width: before.width - Math.abs(dx), height: before.height - Math.abs(dy)
      };
      for (const key of Object.keys(expected)) {
        assert.ok(Math.abs(expected[key] - after[key]) <= 1,
          edge + ' resize: ' + key + ' expected ' + expected[key] + ', got ' + after[key]);
      }
      verify('resize ' + edge, await geometry());
      await drag(x + dx, y + dy, -dx, -dy);
      assert.deepEqual(await rect(), before, edge + ' reverse resize');
    }
    const beforeKey = await rect();
    await page.focus('#folderDockResize');
    await page.keyboard.press('ArrowRight');
    const keyRect = await rect();
    assert.ok(keyRect.width > beforeKey.width && keyRect.x === beforeKey.x, 'keyboard resize');
    await page.focus('#folderDockHandle');
    await page.keyboard.press('ArrowDown');
    const saved = await rect();
    assert.ok(saved.y > keyRect.y && saved.height === keyRect.height, 'keyboard movement');
    await page.reload();
    await page.waitForSelector('#bookmarks a.bookmark', { visible: true });
    assert.deepEqual(await rect(), saved, 'saved move and resize after reload');

    const tabId = await page.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    async function zoom(factor, expectedRect) {
      await page.evaluate((id, factor) => chrome.tabs.setZoom(id, factor), tabId, factor);
      const view = { width: Math.round(desktop.width / factor), height: Math.round(desktop.height / factor) };
      // Chromium can acknowledge zoom and resize the viewport before delivering the window resize event.
      try {
        await page.waitForFunction(({ view, expectedRect }) => {
          if (innerWidth !== view.width || innerHeight !== view.height) return false;
          const box = document.querySelector('#folderDock').getBoundingClientRect();
          if (expectedRect) return Object.entries(expectedRect).every(([key, value]) => box[key] === value);
          return box.width > 0 && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
        }, { polling: 35, timeout: 4000 }, { view, expectedRect });
      } catch (cause) {
        const observed = await page.evaluate(async id => ({
          zoom: await chrome.tabs.getZoom(id), width: innerWidth, height: innerHeight,
          panel: document.querySelector('#folderDock').getBoundingClientRect().toJSON()
        }), tabId);
        throw new Error('Layout did not settle at ' + factor * 100 + '%: ' + JSON.stringify(observed), { cause });
      }
      assert.equal(await page.evaluate(id => chrome.tabs.getZoom(id), tabId), factor);
    }
    await zoom(1.5);
    verify('150% browser zoom', await geometry());
    await zoom(1, saved);

    await page.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({settings: { ...settings, dial_columns: 10 }});
    });
    await page.reload();
    await page.waitForSelector('#bookmarks a.bookmark', { visible: true });
    for (const size of [{width: 848, height: 643}, {width: 701, height: 420}, {width: 420, height: 800}]) {
      await page.setViewport(size);
      verify('viewport ' + size.width, await geometry());
      const width = await page.$eval('#bookmarks .bookmark__stage', node => node.getBoundingClientRect().width);
      assert.ok(width >= 100, 'card width in ' + size.width + 'px window: ' + width);
    }
    await page.click('#folderDockToggle');
    await page.waitForSelector('#folderDock', { visible: true });
    verify('small-screen panel opened', await geometry());
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement.id === 'folderDockToggle');
    assert.equal((await rect()).width, 0, 'small-screen panel dismissed');
    await page.setViewport(desktop);
    await settle();
    assert.deepEqual(await rect(), saved, 'desktop layout after restoring wide viewport');
    await page.evaluate(key => { localStorage.setItem(key, JSON.stringify({x: 1120, y: 125, width: 268, height: 545})); }, storedLayout);
    await page.reload();
    await page.waitForSelector('#bookmarks a.bookmark', { visible: true });
    assert.equal(await dock(), 'right', 'legacy right position');
    verify('migrated right', await geometry());
    await reset();
    assert.deepEqual(await rect(), initial);
    assert.deepEqual(errors, []);
    console.log('PASS four sides, eight resize handles, scrolling, persisted and legacy layouts, keyboard, browser zoom and narrow viewports.');
  } finally {
    await browser.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });

