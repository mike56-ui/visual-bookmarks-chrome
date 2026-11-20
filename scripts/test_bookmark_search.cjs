const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const extension = path.resolve(process.env.VB_TEST_EXTENSION || 'extension_chrome');
const input = '#bookmarkSearch';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(directory, granted) {
  const browser = await puppeteer.launch({
    executablePath:process.env.PUPPETEER_EXECUTABLE_PATH,
    headless:'new', args:['--lang=zh-CN', '--host-resolver-rules=MAP *.test ~NOTFOUND,MAP www.bing.com ~NOTFOUND',
      '--disable-extensions-except=' + directory, '--load-extension=' + directory]
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const traffic = [];
    let releaseSlow;
    let releaseQuick;
    const quickResponse = new Promise(resolve => { releaseQuick = resolve; });
    let failFor;
    const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const linkFor = query => 'https://search-result.test/article?q=' + encodeURIComponent(query);
    const intercept = await page.target().createCDPSession();
    await intercept.send('Fetch.enable', {patterns:[{urlPattern:'https://www.bing.com/*'}]});
    intercept.on('Fetch.requestPaused', async ({requestId, request}) => {
      try {
        const url = new URL(request.url);
        const q = url.searchParams.get('q');
        assert.equal(url.pathname, '/search');
        assert.equal(url.searchParams.get('format')?.toLowerCase(), 'rss');
        traffic.push(q);
        if (q === 'slow search') await new Promise(resolve => { releaseSlow = resolve; });
        if (q === 'quick') await quickResponse;
        const extra = q === 'quick' ? [2, 3].map(n =>
          '<item><title>Web result ' + n + '</title><link>' + xml(linkFor(q) + '&row=' + n) + '</link></item>'
        ).join('') : '';
        const rss = '<rss version="2.0"><channel><title>Bing</title>'
          + '<item><title>' + xml('Result ' + q + ' & <em>detail</em>') + '</title><link>'
          + xml(linkFor(q)) + '</link><description>A fixture result</description></item>'
          + '<item><title>Invalid scheme</title><link>javascript:void(0)</link></item>' + extra + '</channel></rss>';
        await intercept.send('Fetch.fulfillRequest',{requestId, responseCode:q === failFor ? 503 : 200,
          responseHeaders:[{name:'Content-Type',value:'application/rss+xml; charset=utf-8'}],
          body:Buffer.from(rss).toString('base64')});
      } catch (error) {
        // A superseded request can be cancelled before its deliberately delayed response.
        if (!/Invalid InterceptionId|Invalid requestId/i.test(error.message)) errors.push(error.message);
      }
    });
    await page.goto('chrome://newtab/');
    await page.waitForSelector(input, {visible:true});
    const ids = await page.evaluate(async () => {
      const [tree] = await chrome.bookmarks.getTree();
      const root = tree.children[0].id;
      const folder = title => chrome.bookmarks.create({parentId:root, title});
      const daily = await folder('日常');
      const reference = await folder('资料');
      const add = async (parentId,title,url) => (await chrome.bookmarks.create({parentId,title,url})).id;
      return {
        daily:daily.id,
        notes:await add(daily.id,'每周工作安排', 'https://schedule.test/weekly'),
        tea:await add(daily.id,'Tea tasting notes', 'https://tealens.test/journal'),
        ai:await add(reference.id,'精选开源AI产品与工具 · 开发手册', 'https://app.aibase.test/catalogue/developer-tools?mode=quick'),
        code:await add(reference.id,'版本管理文档', 'https://docs.github-lab.test/reference/quick-start')
      };
    });
    await page.goto(page.url().split('#')[0] + '#' + ids.daily);
    await page.waitForSelector(input, {visible:true});
    assert.equal(await page.evaluate(async () => (await chrome.storage.local.get('settings')).settings.search_engine), 'bookmarks');
    assert.equal(await page.evaluate(() => chrome.permissions.contains({origins:['https://www.bing.com/*']})), granted);
    const source = page.url();
    const tabIds = () => page.evaluate(async () => (await chrome.tabs.query({})).map(tab => tab.id).sort());
    const originalTabs = await tabIds();
    await page.evaluate(() => { window.searchFixtureDocument = 'original'; });

    async function results(query, expected, filtering = Boolean(query.trim())) {
      try {
        await page.waitForFunction(({query, expected, folder, filtering}) => {
          const grid = document.querySelector('#bookmarks');
          const visible = [...grid.querySelectorAll(':scope > a.bookmark:not([hidden])')].map(card => card.dataset.id).sort();
          return document.querySelector('#bookmarkSearch').value === query && grid.dataset.folder === folder
            && document.body.classList.contains('has-search') === filtering
            && Boolean(grid.querySelector('.empty-search')) === !expected.length
            && JSON.stringify(visible) === JSON.stringify(expected);
        }, {timeout:4000,polling:60}, {query,expected:[...expected].sort(),folder:ids.daily,filtering});
      } catch (cause) {
        const shown = await page.$$eval('#bookmarks a.bookmark:not([hidden])', cards => cards.map(card => card.title));
        throw new Error('Wrong results for ' + JSON.stringify(query) + ', showing ' + JSON.stringify(shown), {cause});
      }
    }
    const selectText = async () => {
      await page.focus(input);
      await page.keyboard.down('Control');
      await page.keyboard.press('a');
      await page.keyboard.up('Control');
    };
    const cdp = await page.target().createCDPSession();
    const setQuery = async query => {
      await selectText();
      // Paste-style trusted text insertion through Edge without using the user's system clipboard.
      await cdp.send('Input.insertText', {text:query});
    };
    const bing = async query => {
      await page.waitForFunction(({query, link}) => {
        const matches = [...document.querySelectorAll('#bingResults a[data-bing-result]')];
        return matches.length === 1 && matches[0].getBoundingClientRect().height > 0
          && matches[0].href === link && matches[0].textContent.includes('Result ' + query)
          && !matches[0].querySelector('em');
      }, {timeout:5000}, {query,link:linkFor(query)});
    };
    const noWebRows = () => page.waitForFunction(() => !document.querySelector('#bingResults a[data-bing-result]'));
    async function checkResultsLayout() {
      const state = await page.evaluate(() => {
        const local = document.querySelector('#bookmarks');
        const web = document.querySelector('#bingResults');
        const strip = document.querySelector('#bingResultList');
        const items = Array.from(strip.querySelectorAll('[data-bing-result]'), n => n.getBoundingClientRect());
        return {
          localFirst: !!(local.compareDocumentPosition(web) & Node.DOCUMENT_POSITION_FOLLOWING)
            && local.getBoundingClientRect().bottom <= web.getBoundingClientRect().top + 1,
          row: items.every((b,i) => !i || (Math.abs(b.y - items[0].y) <= 1 && b.x >= items[i - 1].right - 1)),
          noPageOverflow: document.querySelector('.app').scrollWidth <= document.querySelector('.app').clientWidth + 1
        };
      });
      assert.deepEqual(state, {localFirst:true, row:true, noPageOverflow:true});
    }
    async function chooseEngine(engine) {
      const popup = 'vb-header vb-popup';
      await page.waitForFunction(selector => !document.querySelector(selector).isTransition, {}, popup);
      const point = await page.$eval(popup, node => {
        const box = node.popupTriger.getBoundingClientRect();
        return {x:box.left + box.width / 2, y:box.top + box.height / 2};
      });
      await page.mouse.click(point.x, point.y);
      const selector = 'vb-header [data-engine="' + engine + '"]';
      await page.waitForSelector(selector,{visible:true});
      await page.waitForFunction(selector => !document.querySelector(selector).isTransition, {}, popup);
      await page.click(selector);
      await page.waitForFunction(async value => (await chrome.storage.local.get('settings')).settings.search_engine === value,
        {timeout:3000}, engine);
    }
    await results('', [ids.notes,ids.tea]);
    await setQuery('源AI产');
    await results('源AI产',[ids.ai]);
    if (!granted) {
      await page.waitForSelector('#bingPermission', {visible:true});
      await pause(700);
      assert.deepEqual(traffic, []);
      assert.deepEqual(await tabIds(), originalTabs);
      assert.deepEqual(errors, []);
      console.log('PASS original package: local matches with no Bing permission, no Bing request and no tab navigation.');
      return;
    }
    await bing('源AI产');
    await selectText();
    await page.keyboard.type('IBAS');
    await results('IBAS',[ids.ai]);
    await setQuery('veloper-too');
    await results('veloper-too',[ids.ai]);
    await setQuery('开发 quick');
    await results('开发 quick',[ids.ai]);
    await setQuery('quick');
    await results('quick',[ids.ai,ids.code]);
    await noWebRows();
    releaseQuick();
    await page.waitForFunction(() => document.querySelectorAll('#bingResults [data-bing-result]').length === 3);
    const originalViewport = page.viewport();
    for (const width of [1440, 390]) {
      await page.setViewport({width, height:800});
      await page.waitForFunction(w => innerWidth === w &&
        document.querySelector('#folderDockToggle').hidden === (w > 700), {timeout:4000}, width);
      await checkResultsLayout();
      if (width === 1440 && process.env.VB_SEARCH_SCREENSHOT) {
        const file = path.resolve(process.env.VB_SEARCH_SCREENSHOT);
        await fs.mkdir(path.dirname(file), {recursive:true});
        await page.mouse.move(1, 1);
        await page.screenshot({path:file});
      }
      const links = '#bingResultList [data-bing-result]';
      await page.focus(links);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      const reachable = await page.evaluate(() => {
        const links = document.querySelectorAll('#bingResultList [data-bing-result]');
        const last = links[links.length - 1], box = last.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return last === document.activeElement && last.contains(hit);
      });
      assert.ok(reachable, 'keyboard navigation reveals the last horizontal web result at width ' + width);
    }
    await page.setViewport(originalViewport);
    await setQuery('unfindable-96');
    await results('unfindable-96',[]);
    await bing('unfindable-96');
    await checkResultsLayout();
    await page.click('#searchReset');
    await results('',[ids.notes,ids.tea]);
    await noWebRows();
    console.log('PASS cross-folder title, case-insensitive domain, path fragments, mixed terms, empty results and reset.');

    await selectText();
    await cdp.send('Input.imeSetComposition', {text:'kaiyuan',selectionStart:6,selectionEnd:6});
    await pause(800);
    assert.ok(!traffic.includes('kaiyuan'));
    await cdp.send('Input.insertText', {text:'开源'});
    await results('开源',[ids.ai]);
    await bing('开源');
    // Some IMEs finish with compositionend after the last composing input.
    await page.$eval(input, field => {
      field.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      field.value = 'gongzuo';
      field.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'gongzuo'}));
      // Enter can submit a form while an IME is still confirming its candidate.
      field.form.requestSubmit();
      field.value = '工作';
      field.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'工作'}));
    });
    await results('工作',[ids.notes]);
    await bing('工作');
    assert.ok(!traffic.includes('gongzuo'));
    // Submit must read the value already visible in the field even when a final input event was coalesced.
    await page.$eval(input, field => { field.value = '版本'; });
    await page.keyboard.press('Enter');
    await results('版本',[ids.code]);
    await bing('版本');
    assert.equal(page.url(),source);
    assert.equal(await page.evaluate(() => window.searchFixtureDocument),'original');
    assert.deepEqual(await tabIds(), originalTabs);
    await setQuery('quic');
    await setQuery('unfindable-97');
    await setQuery('tealens');
    await results('tealens',[ids.tea]);
    await bing('tealens');
    assert.ok(!traffic.includes('quic') && !traffic.includes('unfindable-97'), 'Debounce sent intermediate inputs');
    assert.equal(traffic.filter(q => q === 'tealens').length, 1);
    const tabsBeforeSwitch = await tabIds();
    await chooseEngine('duckduckgo');
    await results('tealens',[ids.notes, ids.tea],false);
    await page.waitForSelector('#bingResults',{hidden:true});
    await chooseEngine('bookmarks');
    await results('tealens',[ids.tea]);
    await bing('tealens');
    assert.deepEqual(await tabIds(), tabsBeforeSwitch);
    assert.equal(page.url(), source);
    console.log('PASS engine changes keep the typed text, restore the folder and then restore bookmark and Bing matches.');
    await setQuery('slow search');
    for (let n = 0; !releaseSlow && n < 100; n++) await pause(50);
    assert.ok(releaseSlow, 'The intentionally slow Bing request must have started');
    const special = '测试 C++ & #?';
    await setQuery(special);
    await results(special,[]);
    await bing(special);
    releaseSlow();
    await pause(250);
    await bing(special);
    assert.ok(traffic.includes(special), 'Bing must receive the full, correctly encoded keyword');
    await page.click('#bingResults a[data-bing-result]');
    await page.waitForFunction(url => chrome.tabs.query({}).then(tabs => tabs.some(tab =>
      tab.url === url || tab.pendingUrl === url)), {polling:80, timeout:5000}, linkFor(special));
    assert.equal((await tabIds()).length, originalTabs.length + 1);
    assert.equal(page.url(),source);
    assert.equal(await page.evaluate(() => window.searchFixtureDocument),'original');
    await page.bringToFront();
    failFor = 'schedule';
    await setQuery(failFor);
    await results(failFor,[ids.notes]);
    await page.waitForFunction(() => {
      const status = document.querySelector('#bingStatus');
      return status.getBoundingClientRect().height > 0 && status.textContent === chrome.i18n.getMessage('bing_unavailable');
    }, {timeout:5000});
    assert.ok(traffic.includes(failFor));
    await noWebRows();
    await setQuery('tealens');
    await results('tealens',[ids.tea]);
    await bing('tealens');
    await selectText();
    await page.keyboard.press('Backspace');
    await results('',[ids.notes,ids.tea]);
    await noWebRows();
    assert.ok(traffic.every(q => q && q.trim()));
    assert.deepEqual(errors,[]);
    console.log('PASS ' + await browser.version() + ': local and Bing rows on one page, debounced committed IME input,'
      + ' Enter, encoded terms, stale and failed responses, clear/reset, safe links and opening a result in a new tab.');
  } finally {
    await browser.close();
  }
}
(async () => {
  await run(extension, false);
  const grantedCopy = await fs.mkdtemp(path.join(os.tmpdir(), 'vb-search-bing-'));
  try {
    await fs.cp(extension, grantedCopy, {recursive:true});
    const file = path.join(grantedCopy,'manifest.json');
    const manifest = JSON.parse(await fs.readFile(file,'utf8'));
    assert.ok(manifest.optional_host_permissions.includes('https://www.bing.com/*'));
    manifest.host_permissions = [...(manifest.host_permissions || []),'https://www.bing.com/*'];
    await fs.writeFile(file, JSON.stringify(manifest));
    await run(grantedCopy, true);
  } finally {
    if (path.dirname(path.resolve(grantedCopy)) === path.resolve(os.tmpdir())
      && path.basename(grantedCopy).startsWith('vb-search-bing-')) {
      await fs.rm(grantedCopy, {recursive:true, force:true});
    }
  }
})().catch(error => { console.error(error); process.exitCode=1; });
