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

  async function openFolder(id) {
    const selector = `[data-folder-id="${id}"] .folder-card__open`;
    await extPage.waitForSelector(selector, { visible: true });
    const point = await extPage.evaluate(selector => {
      const button = document.querySelector(selector);
      button.scrollIntoView({ block: 'nearest' });
      const box = button.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }, selector);
    await extPage.mouse.click(point.x, point.y);
    await extPage.waitForFunction(id => document.querySelector('#bookmarks').dataset.folder === id, {}, id);
  }

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
    await openFolder(data.sourceId);
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

  it('shows cached previews when returning to a visible tab, including legacy images', async() => {
    await openFolder(data.sourceId);
    const [legacyId, visitedId, customId] = data.bookmarkIds.slice(8, 11);
    const otherTab = await browser.newPage();
    try {
      await otherTab.bringToFront();
      await extPage.waitForFunction(() => document.hidden, { polling: 100 });
      await extPage.evaluate(async({ legacyId, visitedId, customId }) => {
        const legacyCard = document.getElementById('vb-' + legacyId);
        const visitedCard = document.getElementById('vb-' + visitedId);
        const customCard = document.getElementById('vb-' + customId);
        Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true });
        const canvas = document.createElement('canvas');
        canvas.width = 44;
        canvas.height = 30;
        canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        function seed(name, store, record) {
          return new Promise((resolve, reject) => {
            const open = indexedDB.open(name);
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
              const db = open.result;
              const tx = db.transaction(store, 'readwrite');
              tx.objectStore(store).put(record);
              tx.oncomplete = () => { db.close(); resolve(); };
              tx.onabort = () => { db.close(); reject(tx.error); };
            };
          });
        }
        window.returnPreviewFixture = { legacyCard, visitedCard, customCard, seed };
        // Simulate existing extension storage with no live worker notification.
        await seed('visual-bookmarks', 'images', { id: legacyId, blob, custom: false });
        await seed('visual-bookmarks', 'images', { id: customId, blob, custom: true });
        await seed('visual-bookmarks-visit-previews', 'visitPreviews', {
          url: visitedCard.url, blob, updated: Date.now()
        });
      }, { legacyId, visitedId, customId });
      await extPage.bringToFront();
      await extPage.waitForFunction(() => {
        const { legacyCard, visitedCard, customCard } = window.returnPreviewFixture;
        return !document.hidden && !document.hasFocus() && [legacyCard, visitedCard, customCard].every(card => {
          const screenshot = card.querySelector('.bookmark__screenshot.is-ready');
          return card.isConnected && screenshot?.querySelector('img')?.naturalWidth === 44
            && getComputedStyle(screenshot).opacity === '1';
        });
      }, { timeout: 5000 });

      await otherTab.bringToFront();
      await extPage.waitForFunction(() => document.hidden, { polling: 100 });
      await extPage.evaluate(async() => {
        const fixture = window.returnPreviewFixture;
        fixture.cover = fixture.customCard.querySelector('.bookmark__img--contain img');
        fixture.coverSrc = fixture.cover.src;
        const canvas = document.createElement('canvas');
        canvas.width = 48;
        canvas.height = 36;
        canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        for (const card of [fixture.visitedCard, fixture.customCard]) {
          await fixture.seed('visual-bookmarks-visit-previews', 'visitPreviews', {
            url: card.url, blob, updated: Date.now()
          });
        }
        const transaction = IDBDatabase.prototype.transaction;
        fixture.restoreImageRead = () => { IDBDatabase.prototype.transaction = transaction; };
        IDBDatabase.prototype.transaction = function(store, ...args) {
          if (this.name === 'visual-bookmarks' && store === 'images') {
            throw new DOMException('Fixture cover store unavailable');
          }
          return transaction.call(this, store, ...args);
        };
      });
      await extPage.bringToFront();
      await extPage.waitForFunction(() => {
        const { visitedCard } = window.returnPreviewFixture;
        return visitedCard.querySelector('.bookmark__screenshot.is-ready img')?.naturalWidth === 48;
      }, { timeout: 5000 });
      expect(await extPage.evaluate(() => {
        const { customCard, cover, coverSrc } = window.returnPreviewFixture;
        return customCard.querySelector('.bookmark__img--contain img') === cover
          && cover.src === coverSrc && cover.naturalWidth === 44;
      })).toBe(true);

      const legacyTab = await browser.newPage();
      try {
        await legacyTab.evaluateOnNewDocument(() => {
          const open = IDBFactory.prototype.open;
          IDBFactory.prototype.open = function(name, ...args) {
            if (name === 'visual-bookmarks-visit-previews') throw new DOMException('Fixture cache unavailable');
            return open.call(this, name, ...args);
          };
        });
        await legacyTab.goto(extPage.url());
        await legacyTab.waitForFunction(id =>
          document.querySelector(`#vb-${id} .bookmark__screenshot.is-ready img`)?.naturalWidth === 44,
        { timeout: 5000 }, legacyId);
      } finally {
        await legacyTab.close();
      }
    } finally {
      await extPage.evaluate(() => {
        window.returnPreviewFixture?.restoreImageRead?.();
        delete document.hasFocus;
        delete window.returnPreviewFixture;
      });
      await otherTab.close();
      await extPage.bringToFront();
    }
  });

  it('reorders and undoes a large folder without replacing live cards or their media', async() => {
    // Reload to start with only the first page rendered.
    await extPage.reload({ waitUntil: 'load' });
    const [first, second, third] = data.bookmarkIds;
    await openFolder(data.sourceId);
    await extPage.waitForFunction(id => document.querySelector('#bookmarks .bookmark')?.dataset.id === id, {}, first);
    await extPage.evaluate(async id => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('visual-bookmarks');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const canvas = document.createElement('canvas');
      canvas.width = 120;
      canvas.height = 80;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#5a80b5';
      ctx.fillRect(0, 0, 120, 80);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const tx = db.transaction('images', 'readwrite');
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.objectStore('images').put({ id, blob, custom: true, revision: 'reorder-test' });
      });
      db.close();
      const [bookmark] = await browser.bookmarks.get(id);
      await browser.bookmarks.update(id, { title: bookmark.title + ' ' });
    }, first);
    await extPage.waitForSelector(`#vb-${first} .bookmark__screenshot.is-ready img`);
    await extPage.evaluate(({ first, folderId }) => {
      const grid = document.getElementById('bookmarks');
      // Also exercise the fallback for Chromium builds without Element.moveBefore().
      Object.defineProperty(grid, 'moveBefore', { value: undefined, configurable: true });
      const folder = document.querySelector('[data-folder-id="' + folderId + '"]');
      window.sortCheck = {
        rows: [...grid.querySelectorAll('.bookmark')],
        icons: [...grid.querySelectorAll('.site-icon__image')],
        folder, miniIcons: [...folder.querySelectorAll('.site-icon__image')],
        preview: document.querySelector('#vb-' + first + ' .bookmark__screenshot img'),
        toasts: [...document.querySelectorAll('.toast')]
      };
    }, { first, folderId: data.sourceId });
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
    const retained = await extPage.evaluate(first => {
      const { rows, icons, folder, miniIcons, preview, toasts } = window.sortCheck;
      const current = document.querySelector('#vb-' + first + ' .bookmark__screenshot img');
      return rows.every(node => node.isConnected) && icons.every(node => node.isConnected)
        && folder.isConnected && miniIcons.every(node => node.isConnected)
        && current === preview && current.complete && current.naturalWidth > 0
        && [...document.querySelectorAll('.toast')].every(node => toasts.includes(node));
    }, first);
    expect(retained).toBe(true);
    await extPage.focus('#bookmarkSearch');
    await extPage.keyboard.down('Control');
    await extPage.keyboard.press('z');
    await extPage.keyboard.up('Control');
    expect(await extPage.$eval('#bookmarks .bookmark', card => card.dataset.id)).toBe(second);
    await extPage.click('#newtabActionsToggle');
    await extPage.click('[data-newtab-action="undo-order"]');
    await extPage.waitForFunction(id => document.querySelector('#bookmarks .bookmark')?.dataset.id === id, { timeout: 5000 }, first)
      .catch(error => { throw new Error('Undo did not restore the original first bookmark. ' + error); });
    expect(await extPage.evaluate(async id => (await browser.bookmarks.getChildren(id)).map(node => node.id), data.sourceId)).toEqual(original);
    await extPage.evaluate(() => {
      delete document.getElementById('bookmarks').moveBefore;
      delete window.sortCheck;
    });
  });

  it('keeps sharp uniform icons, previews and text in separate zones at high DPI', async() => {
    const screenshot = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><rect width="1280" height="800" fill="#eaf2ff"/><path d="M0 180H1280M320 0V800M640 0V800" stroke="#3975ce" stroke-width="8"/><text x="60" y="120" font-size="56" fill="#174070">Clear page preview</text></svg>');
    await extPage.evaluate(image => {
      const logo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8" fill="#1266ef"/></svg>');
      const card = document.createElement('a', { is: 'vb-bookmark' });
      Object.assign(card, { id: 'quality-fixture', url: 'https://example.com/private?token=do-not-send',
        title: 'A long bookmark title for checking icon and label separation', hasTitle: true,
        image, isCustomImage: true, hasFavicon: true });
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

  it('applies toolbar, caption, icon, navigation and drag settings without remounting cards', async() => {
    const first = data.bookmarkIds[0];
    const settings = await extPage.evaluate(async({ first, source }) => {
      const initial = (await browser.storage.local.get('settings')).settings;
      const card = document.getElementById('vb-' + first);
      window.settingCardCheck = {
        card,
        toolbar: document.querySelector('vb-header'),
        logo: card.querySelector('.site-icon__image'),
        preview: card.querySelector('.bookmark__screenshot img'),
        mini: document.querySelector('[data-folder-id="' + source + '"] .site-icon__image')
      };
      await browser.storage.local.set({ settings: { ...initial, show_toolbar: false,
        show_bookmark_title: false, show_favicon: false, open_link_newtab: false, drag_and_drop: false } });
      return initial;
    }, { first, source: data.sourceId });
    try {
      await extPage.waitForFunction(first => {
        const card = document.getElementById('vb-' + first);
        return !card.hasAttribute('target') && !card.querySelector('.bookmark__title')
          && getComputedStyle(card.querySelector('.bookmark__img--base')).display === 'none'
          && document.querySelector('.newtab-toolbar header').hidden
          && document.getElementById('bookmarks').sortInstance.isDisabled;
      }, {}, first);
      expect(await extPage.evaluate(() => {
        const { card, logo, preview, mini } = window.settingCardCheck;
        return card.isConnected && logo.isConnected && preview.isConnected && mini.isConnected;
      })).toBe(true);
    } finally {
      await extPage.evaluate(settings => browser.storage.local.set({ settings }), settings);
    }
    await extPage.waitForFunction(first => {
      const { card, toolbar } = window.settingCardCheck;
      return card === document.getElementById('vb-' + first) && card.querySelector('.bookmark__title')
        && !card.querySelector('.bookmark__img--base').hidden && card.target === '_blank'
        && !document.querySelector('.newtab-toolbar header').hidden
        && document.querySelectorAll('vb-header').length === 1
        && document.querySelector('vb-header') === toolbar && !document.getElementById('bookmarks').sortInstance.isDisabled;
    }, {}, first);
    await extPage.evaluate(() => { delete window.settingCardCheck; });
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
    await openFolder(data.sourceId);
    const first = `[data-id="${data.bookmarkIds[0]}"]`;
    const second = `[data-id="${data.bookmarkIds[1]}"]`;
    const target = `[data-folder-id="${data.targetId}"]`;
    const retainedId = data.bookmarkIds[2];
    await extPage.evaluate(id => {
      window.crossFolderRow = document.getElementById('vb-' + id);
      window.crossFolderIcon = window.crossFolderRow.querySelector('.site-icon__image');
      const animate = Element.prototype.animate;
      const motion = { movedCards: 0, fadedCards: 0, folderLanding: false };
      window.crossFolderMotion = motion;
      window.stopCrossFolderMotionCheck = () => {
        Element.prototype.animate = animate;
        delete window.crossFolderMotion;
        delete window.stopCrossFolderMotionCheck;
        return motion;
      };
      Element.prototype.animate = function(keyframes, options) {
        const animation = animate.call(this, keyframes, options);
        const frames = animation.effect.getKeyframes();
        if (this.matches('#bookmarks > .bookmark[data-id]')) {
          motion.movedCards += 1;
          if (frames.some(frame => Number(frame.opacity) < 1)) motion.fadedCards += 1;
        }
        if (this.matches('.motion-drag-lift')
          && frames.some(frame => frame.transform?.includes('scale(') && Number(frame.opacity) < 1)) {
          motion.folderLanding = true;
        }
        return animation;
      };
    }, retainedId);

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
    await extPage.waitForFunction(id => !document.getElementById('vb-' + id), {}, data.bookmarkIds[0]);
    await extPage.waitForFunction(() => window.crossFolderMotion.folderLanding, { timeout: 5000 });
    const motion = await extPage.evaluate(() => window.stopCrossFolderMotionCheck());
    expect(motion.movedCards).toBeGreaterThan(0);
    expect(motion.fadedCards).toBe(0);
    expect(await extPage.evaluate(() => window.crossFolderRow.isConnected && window.crossFolderIcon.isConnected))
      .toBe(true);
  });

  it('creates and inline-renames a real nested folder', async() => {
    await openFolder(data.sourceId);
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
    await openFolder(data.emptyId);
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
    await openFolder(data.sourceId);
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
