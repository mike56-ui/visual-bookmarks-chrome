const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const puppeteer = require('puppeteer');

const extension = path.resolve(process.env.VB_TEST_EXTENSION || 'extension_chrome');
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
const language = process.env.VB_TEST_LANG || 'zh-CN';
const settingsCopy = {
  'zh-CN': ['设置', '外观', '自动', '自动补全缺失的缩略图'],
  'zh-TW': ['設定', '外觀', '自動', '自動補上缺少的縮圖'],
  'en-US': ['Settings', 'Appearance', 'Automatic', 'Automatically fill missing thumbnails']
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function openSettings(page) {
  await page.click('#newtabActionsToggle');
  await page.waitForSelector('#settingsDrawer[open]');
  const frame = await (await page.$('#settingsDrawer iframe')).contentFrame();
  await frame.waitForSelector('[role="tab"][aria-selected="true"]');
  return frame;
}

async function verify() {
  const artifacts = await fs.mkdtemp(path.join(os.tmpdir(), 'vb-settings-qa-'));
  const fixture = path.join(artifacts, 'fixture.backup');
  const exported = path.join(artifacts, 'visual-bookmarks-settings.backup');
  const background = path.join(artifacts, 'background.png');
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    defaultViewport: { width: 1280, height: 800 },
    args: [`--lang=${language}`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('chrome://newtab/');
    await page.waitForSelector('#folderDockList .folder-card');
    const optionsURL = await page.evaluate(() => chrome.runtime.getURL('options.html'));
    const bookmarkId = await page.evaluate(async() => {
      const [tree] = await chrome.bookmarks.getTree();
      const root = tree.children[0];
      const bookmark = await chrome.bookmarks.create({
        parentId: root.id,
        title: 'Settings QA',
        url: 'http://127.0.0.1:9/settings-qa'
      });
      location.hash = root.id;
      window.settingsQAMarker = 'same-document';
      return bookmark.id;
    });
    const card = `#bookmarks [data-id="${bookmarkId}"]`;
    await page.waitForSelector(`${card} .bookmark__title`);
    assert.equal(await page.$('#settingsDrawer iframe[src]'), null, 'options must load on demand');
    const initialPages = (await browser.pages()).length;
    const initialHomeURL = page.url();
    const [title, appearance, automatic, fillMissing] = settingsCopy[language];
    assert.deepEqual(await page.$eval('#newtabActionsToggle', button => [
      button.getAttribute('aria-label'), button.getAttribute('aria-controls'), button.getAttribute('aria-haspopup')
    ]), [title, 'settingsDrawer', 'dialog']);

    const frame = await openSettings(page);
    assert.equal((await browser.pages()).length, initialPages);
    assert.equal(page.url(), initialHomeURL);
    assert.equal(await page.evaluate(() => document.activeElement.className), 'settings-drawer__close');
    assert.equal(await page.$eval('#newtabActionsToggle', button => button.getAttribute('aria-expanded')), 'true');
    assert.equal(await page.$('#settingsDrawer footer, #settingsDrawer [data-newtab-action]'), null);
    assert.equal(await page.$eval('#settingsDrawerTitle', heading => heading.textContent), title);
    assert.equal(await frame.$eval('#options-tab-0', tab => tab.textContent.trim()), appearance);
    assert.equal(await frame.$eval('#dial_columns', field => field.selectedOptions[0].textContent), automatic);
    assert.equal(await frame.$eval('#dial_width_value', output => output.textContent), automatic);
    assert.equal(await frame.$('#show_create_column'), null);
    assert.equal(await frame.$('#show_settings_icon'), null);
    await frame.waitForSelector('#visit_preview_preference_hint');
    assert.equal(await frame.$eval('#options-panel-0 > :last-child', row => row.id), 'setting_autoFillMissingPreviews');
    assert.equal(await frame.$eval('#setting-label-autoFillMissingPreviews', label => label.firstChild.textContent.trim()), fillMissing);
    assert.equal(await frame.$eval('#autoFillMissingPreviews', field => field.checked), false);
    // Exercise both outcomes of the native permission prompt without touching the host browser's permissions.
    await frame.evaluate(() => {
      const api = globalThis.browser.permissions;
      const request = api.request;
      const contains = api.contains;
      const stub = window.testPreviewPermission = { granted: false, calls: [] };
      api.request = async permission => {
        stub.calls.push({ origins: permission.origins, gesture: navigator.userActivation.isActive });
        if (stub.pending) await new Promise(resolve => { stub.release = resolve; });
        return stub.granted;
      };
      api.contains = permission => permission.origins?.includes('<all_urls>') ? Promise.resolve(stub.granted) : contains.call(api, permission);
      stub.restore = () => { api.request = request; api.contains = contains; };
    });
    const fillSwitch = 'label[for="autoFillMissingPreviews"]';
    const savedFill = expected => frame.waitForFunction(async value =>
      (await chrome.storage.local.get('autoFillMissingPreviews')).autoFillMissingPreviews === value
        && document.querySelector('#autoFillMissingPreviews').checked === value
        && !document.querySelector('#autoFillMissingPreviews').disabled, {}, expected);
    await frame.click(fillSwitch);
    await savedFill(false);
    await frame.evaluate(() => { Object.assign(window.testPreviewPermission, { granted: true, pending: true }); });
    await frame.click(fillSwitch);
    await frame.waitForFunction(() => document.querySelector('#autoFillMissingPreviews').disabled && window.testPreviewPermission.release);
    await frame.click(fillSwitch);
    assert.equal(await frame.evaluate(() => window.testPreviewPermission.calls.length), 2);
    await frame.evaluate(() => window.testPreviewPermission.release());
    await savedFill(true);
    await frame.click(fillSwitch);
    await savedFill(false);
    assert.deepEqual(await frame.evaluate(() => window.testPreviewPermission.calls), [
      { origins: ['<all_urls>'], gesture: true }, { origins: ['<all_urls>'], gesture: true }
    ]);
    await frame.evaluate(() => window.testPreviewPermission.restore());
    await frame.focus('#dial_width');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--dock-container-width') === '71%');
    assert.equal(await frame.$eval('#dial_width_value', output => output.textContent), '71%');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => !document.documentElement.style.getPropertyValue('--dock-container-width'));

    const initialTab = await frame.$eval('[role="tab"][aria-selected="true"]', tab => tab.id);
    await frame.focus('#' + initialTab);
    await page.keyboard.press('ArrowRight');
    assert.equal(await frame.$eval('[role="tab"][aria-selected="true"]', tab => tab.id), 'options-tab-1');
    assert.equal(await frame.$eval('#options-panel-0', panel => panel.inert), true);
    assert.equal(await frame.$eval('#thumbnails_update_delay', input => input.max), '15');
    assert.equal(await frame.$eval('#open_link_newtab', input => input.checked), true);
    await frame.click('label[for="open_link_newtab"]');
    await page.waitForFunction(selector => !document.querySelector(selector).target, {}, card);
    const siteAccess = await frame.evaluate(() => chrome.permissions.contains({ origins: ['<all_urls>'] }));
    const preference = '#visit_preview_preference';
    const togglePreference = 'label[for="visit_preview_preference"]';
    await frame.waitForFunction((selector, granted) => document.querySelector(selector).checked === granted, {}, preference, siteAccess);
    assert.equal(await frame.$eval('#visit_preview_preference_hint', label => label.hidden), siteAccess);
    if (siteAccess) {
      await frame.click(togglePreference);
      await page.waitForFunction(async() => (await chrome.storage.local.get('visitPreviewEnabled')).visitPreviewEnabled === false);
      assert.equal(await frame.$eval(preference, toggle => toggle.checked), false);
      await frame.click(togglePreference);
      await page.waitForFunction(async() => (await chrome.storage.local.get('visitPreviewEnabled')).visitPreviewEnabled === true);
      assert.equal(await frame.$eval(preference, toggle => toggle.checked), true);
    }

    await frame.click('#options-tab-0');
    await frame.select('#color_theme', 'dark');
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'));
    assert.equal(await frame.evaluate(() => document.documentElement.classList.contains('dark')), true);
    await frame.click('label[for="show_bookmark_title"]');
    await page.waitForFunction(selector => !document.querySelector(selector + ' .bookmark__title'), {}, card);
    assert.equal(await page.evaluate(() => window.settingsQAMarker), 'same-document');

    await frame.click('#options-tab-2');
    await fs.writeFile(fixture, JSON.stringify({color_theme:'light', show_bookmark_title:true, show_favicon:true}));
    await (await frame.$('#import')).uploadFile(fixture);
    await page.waitForFunction(selector => !document.documentElement.classList.contains('dark')
      && document.querySelector(selector + ' .bookmark__title'), {}, card);
    assert.equal(await frame.$eval('#color_theme', field => field.value), 'light');
    assert.equal(await frame.$eval('#show_bookmark_title', field => field.checked), true);

    const cdp = await page.target().createCDPSession();
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: artifacts });
    await frame.click('#export');
    let backup = null;
    for (let i = 0; i < 30 && !backup; i++) {
      backup = await fs.readFile(exported, 'utf8').then(JSON.parse).catch(() => null);
      if (!backup) await wait(100);
    }
    assert.equal(backup?.color_theme, 'light');
    assert.equal(backup?.show_bookmark_title, true);
    assert.equal(await page.evaluate(() => window.settingsQAMarker), 'same-document');

    await frame.click('#options-tab-0');
    await frame.select('#background_image', 'background_local');
    const png = await frame.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const context = canvas.getContext('2d');
      context.fillStyle = '#a1b4cf';
      context.fillRect(0, 0, 32, 32);
      return canvas.toDataURL().split(',')[1];
    });
    await fs.writeFile(background, Buffer.from(png, 'base64'));
    await (await frame.$('#bgFile')).uploadFile(background);
    await page.waitForFunction(() => document.body.classList.contains('has-image') && document.querySelector('#bg img'));
    await frame.hover('.c-upload__preview');
    await frame.click('#delete_upload');
    await frame.waitForSelector('#popup.is-shown [data-popup="resolve"]', { visible: true });
    await frame.click('#popup [data-popup="resolve"]');
    await page.waitForFunction(() => !document.body.classList.contains('has-image') && !document.querySelector('#bg img'));

    await frame.click('#options-tab-2');
    await frame.focus('#options-tab-2');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#settingsDrawer[open]', { hidden: true });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'newtabActionsToggle');
    assert.equal(await page.$eval('#newtabActionsToggle', button => button.getAttribute('aria-expanded')), 'false');

    for (const key of ['Enter', 'Space']) {
      await page.keyboard.press(key);
      await page.waitForSelector('#settingsDrawer[open]', { visible: true });
      assert.equal(await page.evaluate(() => document.activeElement.className), 'settings-drawer__close');
      if (key === 'Enter') await page.keyboard.press('Escape');
      else await page.mouse.click(20, 50);
      await page.waitForSelector('#settingsDrawer[open]', { hidden: true });
      assert.equal(await page.evaluate(() => document.activeElement.id), 'newtabActionsToggle');
    }
    await page.setViewport({ width: 390, height: 740 });
    await page.waitForSelector('#folderDockToggle', { visible: true });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.app')).marginLeft === '0px');
    const narrowFrame = await openSettings(page);
    const narrow = await page.$eval('#settingsDrawer', dialog => ({
      width: dialog.offsetWidth, windowWidth: window.innerWidth
    }));
    assert.equal(narrow.width, narrow.windowWidth);
    assert.equal(await narrowFrame.evaluate(() => document.body.scrollWidth <= innerWidth + 1), true);
    await narrowFrame.click('#options-tab-0');
    await narrowFrame.$eval('#setting_autoFillMissingPreviews', row => row.scrollIntoView({ block: 'end' }));
    await narrowFrame.waitForFunction(() => {
      const label = document.querySelector('label[for="autoFillMissingPreviews"]');
      const box = label.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && label.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    });
    await page.click('.settings-drawer__close');
    assert.equal(await page.evaluate(() => window.settingsQAMarker), 'same-document');

    const standalone = await browser.newPage();
    standalone.on('pageerror', error => errors.push(error.message));
    await standalone.goto(optionsURL);
    await standalone.waitForSelector('[role="tab"][aria-selected="true"]');
    assert.equal(await standalone.$eval('body', body => body.classList.contains('options-embedded')), false);
    assert.ok(await standalone.$('#show_create_column'));
    assert.ok(await standalone.$('#autoFillMissingPreviews'));
    assert.equal(await standalone.$eval('#color_theme', field => field.value), 'light');
    assert.equal(await standalone.$eval('#open_link_newtab', input => input.checked), false,
      'A deliberate switch back to opening in the current tab must survive reopening settings');
    assert.deepEqual(errors, []);
    console.log('PASS: settings drawer, keyboard and focus, live settings and background, import/export, 390px layout, standalone options');
  } finally {
    await browser.close();
    await fs.unlink(fixture).catch(() => {});
    await fs.unlink(exported).catch(() => {});
    await fs.unlink(background).catch(() => {});
    await fs.rmdir(artifacts).catch(() => {});
  }
}

verify().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
