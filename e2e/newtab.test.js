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

  it('renders hundreds of native Edge bookmarks with a 2x5 folder preview', async() => {
    await extPage.click(`[data-folder-id="${data.sourceId}"]`);
    await extPage.waitForFunction(expected => {
      return document.querySelectorAll('#bookmarks .bookmark').length === expected;
    }, {}, 240);

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

    expect(state.bookmarkCount).toBe(240);
    expect(state.previewCells).toBe(10);
    expect(state.previewImages).toBe(10);
    expect(state.cardWidth).toBeGreaterThan(100);
    expect(state.titleOverflow).toBe(true);
  });

  it('shows hover delete, deletes safely, and restores through undo', async() => {
    const bookmarkSelector = `[data-id="${data.bookmarkIds[0]}"]`;
    const deleteSelector = `${bookmarkSelector} .bookmark__delete`;
    expect(await extPage.$eval(deleteSelector, node => getComputedStyle(node).opacity)).toBe('0');
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

    await extPage.evaluate(({ first, target }) => {
      const sourceNode = document.querySelector(first);
      const targetNode = document.querySelector(target);
      const dataTransfer = new DataTransfer();
      sourceNode.dispatchEvent(new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer
      }));
      targetNode.dispatchEvent(new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        dataTransfer
      }));
      targetNode.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer
      }));
      sourceNode.dispatchEvent(new DragEvent('dragend', {
        bubbles: true,
        cancelable: true,
        dataTransfer
      }));
    }, { first, target });

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
    await new Promise(resolve => setTimeout(resolve, 180));
    await extPage.click(`[data-folder-id="${data.sourceId}"]`);
    await extPage.click('#folderDockAdd');
    await extPage.waitForSelector('.folder-card__rename');
    await new Promise(resolve => setTimeout(resolve, 220));
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
    await new Promise(resolve => setTimeout(resolve, 180));
    await extPage.click(createdSelector, { clickCount: 2, delay: 80 });
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

    const [renamed] = await extPage.evaluate(id => browser.bookmarks.get(id), created.id);
    expect(renamed.title).toBe(`${TEST_PREFIX} Renamed`);
  });

  it('deletes a real folder tree after the safety delay', async() => {
    await new Promise(resolve => setTimeout(resolve, 300));
    const folderSelector = `[data-folder-id="${data.extraFolderIds[0]}"]`;
    const deleteSelector = `${folderSelector} .folder-card__delete`;
    await extPage.hover(folderSelector);
    await extPage.click(deleteSelector);
    await new Promise(resolve => setTimeout(resolve, 120));
    const pendingDeleteState = await extPage.evaluate(selector => {
      const card = document.querySelector(selector);
      return {
        isPending: !card || card.hidden,
        toastMessages: [...document.querySelectorAll('.toast__message')]
          .map(node => node.textContent)
      };
    }, folderSelector);
    expect(pendingDeleteState).toEqual(expect.objectContaining({ isPending: true }));

    await new Promise(resolve => setTimeout(resolve, 9000));
    const remainingIds = await extPage.evaluate(async() => {
      const [root] = await browser.bookmarks.getTree();
      const ids = [];
      const visit = nodes => nodes.forEach(node => {
        ids.push(node.id);
        if (node.children) visit(node.children);
      });
      visit([root]);
      return ids;
    });
    expect(remainingIds).not.toContain(data.extraFolderIds[0]);
    expect(remainingIds).not.toContain(data.removableBookmarkId);
  });

  it('shows a useful empty state for an empty real folder', async() => {
    await extPage.click(`[data-folder-id="${data.emptyId}"]`);
    await extPage.waitForFunction(() => {
      return document.querySelectorAll('#bookmarks .bookmark').length === 0
        && Boolean(document.querySelector('#bookmarks .empty-search'));
    });
  });

  it('moves the dock to bottom and right, then persists after reload', async() => {
    const handle = await extPage.$('#folderDockHandle');
    const box = await handle.boundingBox();
    await extPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await extPage.mouse.down();
    await extPage.mouse.move(720, 850, { steps: 12 });
    await extPage.mouse.up();
    await extPage.waitForFunction(() => document.body.dataset.folderDock === 'bottom');

    const bottomHandle = await extPage.$('#folderDockHandle');
    const bottomBox = await bottomHandle.boundingBox();
    await extPage.mouse.move(bottomBox.x + bottomBox.width / 2, bottomBox.y + bottomBox.height / 2);
    await extPage.mouse.down();
    await extPage.mouse.move(1390, 120, { steps: 12 });
    await extPage.mouse.up();
    await extPage.waitForFunction(() => document.body.dataset.folderDock === 'right');

    await extPage.reload({ waitUntil: 'load' });
    await extPage.waitForSelector('#folderDockList .folder-card');
    expect(await extPage.$eval('body', node => node.dataset.folderDock)).toBe('right');
  });

  it('keeps native bookmark changes after reload and remains usable at narrow width', async() => {
    const parents = await extPage.evaluate(async(ids) => {
      const nodes = await Promise.all(ids.map(id => browser.bookmarks.get(id)));
      return nodes.map(([node]) => node.parentId);
    }, data.bookmarkIds.slice(0, 2));
    expect(parents).toEqual([data.targetId, data.targetId]);

    await extPage.setViewport({ width: 848, height: 643 });
    await extPage.evaluate(() => localStorage.setItem('visual-bookmarks-folder-dock', 'left'));
    await extPage.reload({ waitUntil: 'load' });
    await extPage.waitForSelector('#folderDockList .folder-card');
    await extPage.click(`[data-folder-id="${data.sourceId}"]`);
    await extPage.waitForFunction(() => document.querySelectorAll('#bookmarks .bookmark').length === 238);
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
