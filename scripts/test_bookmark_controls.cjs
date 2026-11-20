const assert = require('node:assert/strict');
const path = require('node:path');
const puppeteer = require('puppeteer');

const extension = path.resolve(process.env.VB_TEST_EXTENSION || 'extension_chrome');
const visibleTip = '#bookmarkCaptionTip.is-visible';
const title = '精选开源 AI 产品与工具 · 开发者资源导航';
const url = 'https://app.aibase.com/zh/tools/open-source';

async function run() {
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, headless: 'new',
    defaultViewport: { width: 1280, height: 780, deviceScaleFactor: 1.5 },
    args: ['--lang=zh-CN', '--disable-extensions-except=' + extension, '--load-extension=' + extension]
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('chrome://newtab/');
    await page.waitForSelector('#folderDockList .folder-card');
    const folder = await page.evaluate(async ({title, url}) => {
      const [root] = await chrome.bookmarks.getTree();
      const folder = await chrome.bookmarks.create({ parentId: root.children[0].id, title: '交互测试' });
      const add = (title, url) => chrome.bookmarks.create({ parentId: folder.id, title, url });
      await add('SaaSHub · 软件目录', 'https://www.saashub.com/');
      const main = await add(title, url);
      await add('首页 · Vue.js', 'https://cn.vuejs.org/');
      return { id: folder.id, bookmark: main.id };
    }, {title, url});
    await page.goto(page.url().split('#')[0] + '#' + folder.id);
    const card = '#vb-' + folder.bookmark;
    const caption = card + ' .bookmark__caption';
    const action = card + ' .bookmark__refresh';
    const hoverTip = async selector => {
      const point = await page.$eval(selector, async node => {
        node.scrollIntoView({block:'nearest', inline:'nearest', behavior:'instant'});
        let previous, settled = 0;
        const end = performance.now() + 4000;
        while (performance.now() < end) {
          await new Promise(resolve => requestAnimationFrame(resolve));
          const rect = node.getBoundingClientRect();
          const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
          const key = x + '/' + y;
          settled = (key === previous && node.contains(document.elementFromPoint(x, y))) ? settled + 1 : 0;
          if (settled >= 12) return [x, y];
          previous = key;
        }
        throw new Error('The caption did not settle in the visible viewport');
      });
      await page.mouse.move(...point);
      await page.waitForSelector(visibleTip);
      const info = await page.$eval(visibleTip, tip => {
        const title = tip.querySelector('.bookmark-caption-tip__title');
        const url = tip.querySelector('.bookmark-caption-tip__url');
        const box = tip.getBoundingClientRect();
        return { title: title.textContent, url: url.textContent, font: parseFloat(getComputedStyle(title).fontSize),
          inside: box.left >= 0 && box.right <= innerWidth + 1 && box.top >= 0 && box.bottom <= innerHeight + 1 };
      });
      assert.equal(info.title, title);
      assert.ok(info.url.includes('app.aibase.com/zh/tools/open-source'));
      assert.ok(info.font >= 15 && info.inside, JSON.stringify(info));
    };
    await page.waitForSelector(action);
    assert.equal(await page.$eval(caption, element => element.getAttribute('title')), '');
    assert.equal(await page.$eval(action, button => button.hasAttribute('aria-haspopup')), false);
    await hoverTip(card + ' .bookmark__title');
    await page.mouse.move(...await page.$eval(visibleTip, tip => {
      const box = tip.getBoundingClientRect();
      return [box.left + box.width / 2, box.top + box.height / 2];
    }));
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.ok(await page.$(visibleTip), 'The pointer can move onto the panel to read the address');
    await page.keyboard.press('Escape');
    await page.waitForFunction(selector => !document.querySelector(selector), {}, visibleTip);
    await hoverTip(card + ' .bookmark__domain');
    if (process.env.VB_CONTROLS_SCREENSHOT) {
      await page.$eval(visibleTip, async tip => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.all(tip.getAnimations().map(animation => animation.finished));
      });
      await page.waitForFunction(selector => Number(getComputedStyle(document.querySelector(selector)).opacity) === 1,
        {}, visibleTip);
      const clip = await page.evaluate(({card, visibleTip}) => {
        const a = document.querySelector(card).getBoundingClientRect();
        const b = document.querySelector(visibleTip).getBoundingClientRect();
        const x = Math.max(0, Math.floor(Math.min(a.left, b.left) - 24));
        const y = Math.max(0, Math.floor(Math.min(a.top, b.top) - 14));
        return { x, y, width: Math.min(innerWidth - x, Math.ceil(Math.max(a.right, b.right) - x + 24)),
          height: Math.min(innerHeight - y, Math.ceil(Math.max(a.bottom, b.bottom) - y + 14)) };
      }, {card, visibleTip});
      await page.screenshot({path: process.env.VB_CONTROLS_SCREENSHOT, clip, captureBeyondViewport: false});
    }
    await page.click(caption, {button:'right'});
    await page.waitForSelector('.context-menu--open #bookmarkActionsMenu');
    await page.waitForFunction(selector => !document.querySelector(selector), {}, visibleTip);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.context-menu--open'));
    await page.mouse.move(0,0);
    await page.keyboard.press('Tab');
    await page.focus(card);
    await page.waitForSelector(visibleTip);
    await page.keyboard.press('Escape');
    await page.setViewport({width:390, height:700, deviceScaleFactor:2});
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
    await page.mouse.move(0,0);
    await hoverTip(card + ' .bookmark__domain');
    const duration = await page.$eval(visibleTip, tip => parseFloat(getComputedStyle(tip).transitionDuration));
    assert.ok(duration < 0.02, 'Reduced motion removes the entrance transition');
    assert.deepEqual(errors, []);
    console.log('PASS ' + await browser.version() + ': full caption, tooltip hover and focus, Escape, context menu, narrow screen, reduced motion.');
  } finally {
    await browser.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
