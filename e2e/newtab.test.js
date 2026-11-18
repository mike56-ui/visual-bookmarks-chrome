import fs from 'fs';
import path from 'path';
import { bootstrap } from './bootstrap';
import { beforeAll, afterAll, describe, expect, it } from '@jest/globals';

const OUTPUT_DIR = path.join(process.cwd(), 'output', 'playwright');
const TEST_PREFIX = `Codex real data ${Date.now()}`;

describe('Chromium real-bookmark dock workflow', () => {
  let extPage;
  let browser;
  let data;
  const pageErrors = [];

  async function dragCard(sourceSelector, targetSelector, fraction = 0.5) {
    const source = await extPage.waitForSelector(sourceSelector);
    const target = await extPage.waitForSelector(targetSelector);
    await target.evaluate(node => node.scrollIntoView({ block: 'nearest' }));
    await source.evaluate(node => node.scrollIntoView({ block: 'nearest' }));
    const [a, b] = await Promise.all([source.boundingBox(), target.boundingBox()]);
    await extPage.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await extPage.mouse.down();
    await extPage.mouse.move(b.x + b.width * fraction, b.y + b.height / 2, { steps: 18 });
    await extPage.mouse.up();
  }

  async function loadAllBookmarks(expected) {
    await extPage.waitForFunction(() => document.querySelector('#bookmarks .bookmark'));
    for (;;) {
      const before = await extPage.$$eval('#bookmarks .bookmark', nodes => nodes.length);
      if (before >= expected) break;
      await extPage.waitForSelector('.bookmarks-load-more');
      await extPage.$eval('.bookmarks-load-more', button => button.click());
      await extPage.waitForFunction(count => document.querySelectorAll('#bookmarks .bookmark').length > count, {}, before);
    }
    expect(await extPage.$$eval('#bookmarks .bookmark', nodes => nodes.length)).toBe(expected);
    expect(await extPage.$('.bookmarks-load-more')).toBeNull();
  }

  beforeAll(async() => {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const context = await bootstrap();
    extPage = context.extPage;
    browser = context.browser;
    extPage.on('pageerror', error => pageErrors.push(error.message));
    await extPage.setViewport({ width: 1440, height: 900 });

    data = await extPage.evaluate(async(prefix) => {
      const [tree] = await browser.bookmarks.getTree();
      const root = tree.children.find(node => !node.url);
      const source = await browser.bookmarks.create({
        parentId: root.id,
        title: `${prefix} Source with an intentionally long folder title`
      });
      const target = await browser.bookmarks.create({
        parentId: root.id,
        title: `${prefix} Target`
      });
      const empty = await browser.bookmarks.create({
        parentId: root.id,
        title: `${prefix} Empty`
      });
      const nested = await browser.bookmarks.create({
        parentId: source.id,
        title: `${prefix} Nested`
      });
      const extraFolders = await Promise.all(Array.from({ length: 14 }, (_, index) => {
        return browser.bookmarks.create({
          parentId: root.id,
          title: `${prefix} Folder ${String(index + 1).padStart(2, '0')}`
        });
      }));
      const bookmarks = await Promise.all(Array.from({ length: 240 }, (_, index) => {
        return browser.bookmarks.create({
          parentId: source.id,
          title: index === 0
            ? `${prefix} A very long bookmark title that must truncate without breaking the layout`
            : `${prefix} Bookmark ${String(index + 1).padStart(3, '0')}`,
          url: `https://example.com/test-${index + 1}`
        });
      }));
      const removableBookmark = await browser.bookmarks.create({
        parentId: extraFolders[0].id,
        title: `${prefix} removable child`,
        url: 'https://example.com/removable-child'
      });

      return {
        rootId: root.id,
        sourceId: source.id,
        targetId: target.id,
        emptyId: empty.id,
        nestedId: nested.id,
        extraFolderIds: extraFolders.map(folder => folder.id),
        bookmarkIds: bookmarks.map(bookmark => bookmark.id),
        removableBookmarkId: removableBookmark.id
      };
    }, TEST_PREFIX);

    await extPage.reload({ waitUntil: 'load' });
    await extPage.waitForSelector(`[data-folder-id="${data.sourceId}"]`);
  });

  it('loads large folders in batches while keeping the native 2x5 folder preview', async() => {
    await extPage.click(`[data-folder-id="${data.sourceId}"]`);
    await extPage.waitForSelector(`#bookmarks [data-id="${data.bookmarkIds[0]}"]`);

    const state = await extPage.evaluate(sourceId => {
      const card = document.querySelector(`[data-folder-id="${sourceId}"]`);
      return {
        bookmarkCount: document.querySelectorAll('#bookmarks .bookmark').length,
        previewCells: card.querySelectorAll('.folder-card__cell').length,
        previewImages: card.querySelectorAll('.folder-card__cell img').length,
        cardWidth: document.querySelector('.bookmark__stage').getBoundingClientRect().width,
        titleOverflow: document.querySelector('.bookmark__title').scrollWidth
          > document.querySelector('.bookmark__title').clientWidth
      };
    }, data.sourceId);

    expect(state.bookmarkCount).toBeGreaterThan(0);
    expect(state.bookmarkCount).toBeLessThan(240);
    expect(state.previewCells).toBe(10);
    expect(state.previewImages).toBe(10);
    expect(state.cardWidth).toBeGreaterThan(100);
    expect(state.titleOverflow).toBe(true);
    const iconRequest = new URL(await extPage.$eval('#bookmarks .site-icon__image', image => image.src));
    expect(iconRequest.pathname).toBe('/_favicon/');
    expect(Number(iconRequest.searchParams.get('size'))).toBeGreaterThan(0);
    expect(iconRequest.searchParams.get('pageUrl')).toBe('https://example.com/test-1');
    expect(iconRequest.host).toBe(new URL(extPage.url()).host);
    const miniIconRequest = new URL(await extPage.$eval(
      `[data-folder-id="${data.sourceId}"] .folder-card__cell img`, image => image.src
    ));
    expect(miniIconRequest.pathname).toBe('/_favicon/');
    expect(miniIconRequest.host).toBe(iconRequest.host);
    await loadAllBookmarks(240);
  });

  it('reorders a large folder without disturbing nested folders and restores it with undo', async() => {
    // Reload to start with only the first page rendered.
    await extPage.reload({ waitUntil: 'load' });
    const [first, second, third] = data.bookmarkIds;
    await extPage.click(`[data-folder-id="${data.sourceId}"] .folder-card__open`);
    await extPage.waitForFunction(id => document.querySelector('#bookmarks .bookmark')?.dataset.id === id, {}, first);
    const original = await extPage.evaluate(async id => (await browser.bookmarks.getChildren(id)).map(node => node.id), data.sourceId);
    await dragCard(`#bookmarks [data-id="${first}"]`, `#bookmarks [data-id="${third}"]`, 0.84);
    await extPage.waitForFunction(({ first, second, third }) => {
      const ids = Array.from(document.querySelectorAll('#bookmarks .bookmark'), el => el.dataset.id);
      return ids.indexOf(first) === 2 && ids[0] === second && ids[1] === third;
    }, { timeout: 5000 }, { first, second, third }).catch(async error => {
      const ids = await extPage.$$eval('#bookmarks .bookmark', nodes => nodes.slice(0, 4).map(node => node.dataset.id));
      throw new Error(`Drop did not place ${first} after ${third}; first items: ${ids}. ${error}`);
    });
    const reordered = await extPage.evaluate(async id => (await browser.bookmarks.getChildren(id)).map(node => node.id), data.sourceId);
    expect(reordered.indexOf(data.nestedId)).toBe(original.indexOf(data.nestedId));
    expect(reordered.filter(id => ![first, second, third].includes(id))).toEqual(
      original.filter(id => ![first, second, third].includes(id))
    );
    const undo = await extPage.waitForSelector('.toast__action[data-action]', { visible: true, timeout: 5000 });
    await extPage.waitForFunction(button => {
      const rect = button.getBoundingClientRect();
      return getComputedStyle(button.closest('.toast')).transform === 'none'
        && button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    }, { timeout: 4000 }, undo);
    await undo.click();
    await extPage.waitForFunction(id => document.querySelector('#bookmarks .bookmark')?.dataset.id === id, { timeout: 5000 }, first)
      .catch(error => { throw new Error('Undo did not restore the original first bookmark. ' + error); });
    expect(await extPage.evaluate(async id => (await browser.bookmarks.getChildren(id)).map(node => node.id), data.sourceId)).toEqual(original);
  });

  it('keeps sharp uniform icons, previews and text in separate zones at high DPI', async() => {
    const screenshot = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#eaf2ff"/><path d="M0 180H1280M320 0V800M640 0V800" stroke="#3975ce" stroke-width="8"/><text x="60" y="120" font-size="56" fill="#174070">Clear page preview</text></svg>');
    await extPage.evaluate(image => {
      const logo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8" fill="#1266ef"/></svg>');
      const card = document.createElement('a', { is: 'vb-bookmark' });
      Object.assign(card, { id: 'quality-fixture', url: 'https://example.com/private?token=do-not-send',
        title: 'A long bookmark title for checking icon and label separation', hasTitle: true,
        image, isCustomImage: true });
      const host = document.createElement('div');
      host.id = 'quality-fixture-host';
      host.style.cssText = 'position:fixed;top:100px;right:40px;width:clamp(100px,12vw,180px);z-index:9999';
      host.append(card);
      document.body.append(host);
      card.querySelector('.site-icon__image').src = logo;
    }, screenshot);
    const selector = '[data-id="quality-fixture"]';
    try {
      await extPage.waitForFunction(() => {
        const image = document.querySelector('[data-id="quality-fixture"] .site-icon__image');
        const preview = document.querySelector('[data-id="quality-fixture"] .bookmark__screenshot img');
        return image?.complete && image.naturalWidth === 16 && !image.hidden && preview?.naturalWidth > 0;
      });
      for (const width of [1440, 848]) {
        await extPage.setViewport({ width, height: 900, deviceScaleFactor: 2 });
        await extPage.waitForFunction(() => getComputedStyle(document.querySelector('[data-id="quality-fixture"] .bookmark__screenshot')).opacity === '1');
        const geometry = await extPage.$eval(selector, card => {
          const rect = name => card.querySelector(name).getBoundingClientRect();
          const stage = rect('.bookmark__stage');
          const frame = rect('.site-icon');
          const title = rect('.bookmark__title');
          const domain = rect('.bookmark__domain');
          const icon = card.querySelector('.site-icon__image');
          return {
            separate: title.top >= stage.bottom && domain.top >= title.bottom,
            iconContained: frame.top >= stage.top && frame.bottom <= stage.bottom,
            noUpscaling: rect('.site-icon__image').width <= icon.naturalWidth,
            previewVisible: getComputedStyle(card.querySelector('.bookmark__screenshot')).opacity === '1',
            noOverflow: domain.right <= stage.right + 1 && title.right <= stage.right + 1
          };
        });
        expect(geometry).toEqual({ separate: true, iconContained: true,
          noUpscaling: true, previewVisible: true, noOverflow: true });
      }
      await extPage.hover(selector);
      await extPage.waitForFunction(() => getComputedStyle(document.querySelector('[data-id="quality-fixture"] .bookmark__screenshot')).opacity === '1');
      expect(await extPage.$eval(`${selector} .bookmark__caption`, node => node.getBoundingClientRect().top))
        .toBeGreaterThanOrEqual(await extPage.$eval(`${selector} .bookmark__stage`, node => node.getBoundingClientRect().bottom));
      await extPage.evaluate(() => {
        const image = document.querySelector('[data-id="quality-fixture"] .site-icon__image');
        image.dispatchEvent(new Event('error'));
      });
      expect(await extPage.$eval(`${selector} .site-icon__image`, node => node.hidden)).toBe(true);
      expect(await extPage.$eval(`${selector} .site-icon`, node => node.textContent.trim())).toBe('');
    } finally {
      await extPage.evaluate(() => document.querySelector('#quality-fixture-host')?.remove());
      await extPage.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    }
  });

  it('shows hover delete, deletes safely, and restores through undo', async() => {
    const bookmarkSelector = `[data-id="${data.bookmarkIds[0]}"]`;
    const deleteSelector = `${bookmarkSelector} .bookmark__delete`;
    await extPage.mouse.move(1000, 20);
    await extPage.waitForFunction(selector => getComputedStyle(document.querySelector(selector)).opacity === '0', {}, deleteSelector);
    await extPage.hover(bookmarkSelector);
    await extPage.waitForFunction(
      selector => getComputedStyle(document.querySelector(selector)).opacity === '1',
      {},
      deleteSelector
    );

    await extPage.click(deleteSelector);
    await extPage.waitForFunction(selector => document.querySelector(selector)?.hidden, {}, bookmarkSelector);
    const undoButton = await extPage.waitForSelector('.toast button');
    await undoButton.click();
    await extPage.waitForFunction(selector => !document.querySelector(selector)?.hidden, {}, bookmarkSelector);

    const [bookmark] = await extPage.evaluate(id => browser.bookmarks.get(id), data.bookmarkIds[0]);
    expect(bookmark.id).toBe(data.bookmarkIds[0]);
  });

  it('multi-selects with Ctrl and drags the group into a nearby folder', async() => {
    const first = `[data-id="${data.bookmarkIds[0]}"]`;
    const second = `[data-id="${data.bookmarkIds[1]}"]`;
    const target = `[data-folder-id="${data.targetId}"]`;

    await extPage.keyboard.down('Control');
    await extPage.click(first);
    await extPage.click(second);
    await extPage.keyboard.up('Control');
    expect(await extPage.$$eval('.bookmark[data-selected]', nodes => nodes.length)).toBe(2);

    await dragCard(first, target);

    await extPage.waitForFunction(async({ ids, targetId }) => {
      const nodes = await Promise.all(ids.map(id => browser.bookmarks.get(id)));
      return nodes.every(([node]) => node.parentId === targetId);
    }, {}, { ids: data.bookmarkIds.slice(0, 2), targetId: data.targetId });

    const parents = await extPage.evaluate(async(ids) => {
      const nodes = await Promise.all(ids.map(id => browser.bookmarks.get(id)));
      return nodes.map(([node]) => node.parentId);
    }, data.bookmarkIds.slice(0, 2));
    expect(parents).toEqual([data.targetId, data.targetId]);
  });

  it('creates and inline-renames a real nested folder', async() => {
    await extPage.click(`[data-folder-id="${data.sourceId}"]`);
    await extPage.click('#folderDockAdd');
    await extPage.waitForSelector('.folder-card__rename');
    await extPage.click('.folder-card__rename', { clickCount: 3 });
    await extPage.type('.folder-card__rename', `${TEST_PREFIX} Created`);
    await extPage.keyboard.press('Enter');

    await extPage.waitForFunction(async title => {
      const matches = await browser.bookmarks.search({ title });
      return matches.some(item => !item.url);
    }, {}, `${TEST_PREFIX} Created`);

    const [created] = await extPage.evaluate(title => {
      return browser.bookmarks.search({ title });
    }, `${TEST_PREFIX} Created`);
    expect(created.parentId).toBe(data.sourceId);

    const createdSelector = `[data-folder-id="${created.id}"]`;
    await extPage.focus(`${createdSelector} .folder-card__open`);
    await extPage.keyboard.press('F2');
    await extPage.waitForSelector(`${createdSelector} .folder-card__rename`);
    const renameState = await extPage.evaluate(selector => ({
      cardExists: Boolean(document.querySelector(selector)),
      inputExists: Boolean(document.querySelector(`${selector} .folder-card__rename`)),
      hash: window.location.hash
    }), createdSelector);
    expect(renameState).toEqual(expect.objectContaining({ inputExists: true }));
    const renameInput = await extPage.waitForSelector(`${createdSelector} .folder-card__rename`);
    await renameInput.click({ clickCount: 3 });
    await renameInput.type(`${TEST_PREFIX} Renamed`);
    await renameInput.press('Enter');

    await extPage.waitForFunction(async({ id, title }) => (await browser.bookmarks.get(id))[0].title === title,
      {}, { id: created.id, title: `${TEST_PREFIX} Renamed` });
    const [renamed] = await extPage.evaluate(id => browser.bookmarks.get(id), created.id);
    expect(renamed.title).toBe(`${TEST_PREFIX} Renamed`);
  });

  it('deletes a real folder tree after the safety delay', async() => {
    const folderId = data.extraFolderIds[0];
    const folderSelector = `[data-folder-id="${folderId}"]`;
    const deleteSelector = `${folderSelector} .folder-card__delete`;
    await extPage.waitForSelector(deleteSelector);
    await extPage.focus(deleteSelector);
    await extPage.keyboard.press('Enter');
    const confirm = await extPage.waitForSelector('#popup [data-popup="resolve"]', { visible: true });
    await extPage.waitForFunction(button => document.activeElement === button, {}, confirm);
    await confirm.click();
    await extPage.waitForFunction(selector => !document.querySelector('#popup')
      && document.querySelector(selector)?.hidden, {}, folderSelector);
    expect(await extPage.evaluate(id => browser.bookmarks.get(id).then(nodes => nodes[0]?.id), folderId)).toBe(folderId);

    await extPage.waitForFunction(async ids => {
      const results = await Promise.allSettled(ids.map(id => browser.bookmarks.get(id)));
      return results.every(result => result.status === 'rejected');
    }, { polling: 100, timeout: 12000 }, [folderId, data.removableBookmarkId]);
  });

  it('shows a useful empty state for an empty real folder', async() => {
    await extPage.evaluate(id => document.querySelector(`[data-folder-id="${id}"] .folder-card__open`).click(), data.emptyId);
    await extPage.waitForFunction(id => {
      const grid = document.getElementById('bookmarks');
      return grid.dataset.folder === id && !grid.querySelector('.bookmark') && grid.querySelector('.empty-search');
    }, {}, data.emptyId);
  });

  it('moves and resizes the folder panel freely, persists layout, and resets it from the menu', async() => {
    const rect = () => extPage.$eval('#folderDock', node => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    });
    const drag = async(selector, dx, dy) => {
      const el = await extPage.$(selector);
      const box = await el.boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await extPage.mouse.move(x, y);
      await extPage.mouse.down();
      await extPage.mouse.move(x + dx, y + dy, { steps: 12 });
      await extPage.mouse.up();
    };
    const initial = await rect();
    await drag('#folderDockHandle', 340, 104);
    const moved = await rect();
    expect(moved).toEqual({ ...initial, x: initial.x + 340, y: initial.y + 104 });
    await drag('#folderDockResize', 38, -72);
    const resized = await rect();
    expect(resized).toEqual({ ...moved, width: moved.width + 38, height: moved.height - 72 });
    await extPage.focus('#folderDockResize');
    await extPage.keyboard.press('ArrowRight');
    const keyboardResized = await rect();
    expect(keyboardResized.width).toBe(resized.width + 12);
    await extPage.reload({ waitUntil: 'load' });
    await extPage.waitForSelector('#folderDockList .folder-card');
    expect(await rect()).toEqual(keyboardResized);
    await extPage.click('#newtabActionsToggle');
    expect(await extPage.$eval('#visitPreviewEnabled', node => node.checked)).toBe(false);
    await extPage.click('[data-newtab-action="reset"]');
    expect(await rect()).toEqual(initial);
  });

  it('keeps native bookmark changes after reload and remains usable at narrow width', async() => {
    const parents = await extPage.evaluate(async(ids) => {
      const nodes = await Promise.all(ids.map(id => browser.bookmarks.get(id)));
      return nodes.map(([node]) => node.parentId);
    }, data.bookmarkIds.slice(0, 2));
    expect(parents).toEqual([data.targetId, data.targetId]);

    await extPage.setViewport({ width: 848, height: 643 });
    await extPage.reload({ waitUntil: 'load' });
    await extPage.waitForSelector('#folderDockList .folder-card');
    await extPage.click(`[data-folder-id="${data.sourceId}"]`);
    await extPage.waitForFunction(id => document.getElementById('bookmarks').dataset.folder === id,
      {}, data.sourceId);
    await loadAllBookmarks(238);
    await extPage.screenshot({
      path: path.join(OUTPUT_DIR, 'edge-real-data-848.png')
    });
    const narrowLayout = await extPage.evaluate(() => {
      const wrap = document.querySelector('.search-wrap').getBoundingClientRect();
      const input = document.querySelector('#bookmarkSearch').getBoundingClientRect();
      return {
        noHorizontalOverflow: document.body.scrollWidth <= document.body.clientWidth,
        searchContained: input.left >= wrap.left - 1 && input.right <= wrap.right + 1
      };
    });
    expect(narrowLayout).toEqual({ noHorizontalOverflow: true, searchContained: true });
    await extPage.setViewport({ width: 420, height: 800 });
    await extPage.waitForSelector('#folderDockToggle', { visible: true });
    expect(await extPage.$eval('#folderDock', panel => getComputedStyle(panel).display)).toBe('none');
    await extPage.click('#folderDockToggle');
    await extPage.waitForSelector('#folderDock', { visible: true });
    await extPage.keyboard.press('Escape');
    expect(await extPage.$eval('#folderDockToggle', node => node === document.activeElement)).toBe(true);
    expect(await extPage.$eval('.bookmark__stage', node => node.getBoundingClientRect().width)).toBeGreaterThan(140);

    await extPage.setViewport({ width: 1440, height: 900 });
    await extPage.reload({ waitUntil: 'load' });
    await extPage.waitForSelector('#folderDockList .folder-card');
    await extPage.screenshot({
      path: path.join(OUTPUT_DIR, 'edge-real-data-1440.png')
    });
    expect(pageErrors).toEqual([]);
  });

  afterAll(async() => {
    await browser?.close();
  });
});
