import { DragSortify } from '../plugins/dragSortify';
import { multiswap } from '../plugins/dragSortify/multiswap';
import Toast from './toast';
import { reconcileChildren } from './domOrder';
import { rememberOrderUndo } from './orderUndo';
import ImageDB from '../api/imageDB';
import { readUsage } from '../api/usage';
import { openPreviewCapture } from '../api/previewCapture';
import { watchVisiblePreviews } from './visiblePreviews';
import { initializeBingResults } from './bingResults';
import { settings, LAST_OPENED_FOLDER_ID } from '../settings';
import { storage } from '../api/storage';
import {
  bookmarkOrderKey, orderAround, planNativeOrder, restoreOrder, sameOrder, withOrganizationLock
} from '../api/bookmarkOrder';
import {
  move,
  get,
  getChildren,
  getThree,
  getSubTree,
  search as searchBookmarks,
  remove,
  removeTree,
  create,
  update,
  flattenArrayBookmarks
} from '../api/bookmark';
import {
  $customTrigger,
  $createElement,
  $escapeHtml,
  $resizeThumbnail
} from '../utils';
import {
  DEFAULT_BOOKMARKS_FOLDER,
  ROOT_FOLDERS,
  SVG_LOADER
} from '../constants';
import { bookmarksToDelete } from '../state';
import  confirmPopup from '../plugins/confirmPopup.js';
import { requestPermissions } from '../api/permissions';
import './vb-bookmark';

/**
 * Bookmarks module
 */
const Bookmarks = (() => {
  const THUMBNAILS_MAP = new Map();
  const DROPZONE_SELECTOR = '.dropzone-bookmark';
  const PAGE_SIZE = 96;
  const container = document.getElementById('bookmarks');
  const dialLoading = document.getElementById('dial_loading');
  let isGeneratedThumbs = false;
  let viewRequest = 0;
  let previewRead = 0;
  let searchTimer;
  let searchQuery = '';
  let organizing = false;
  let currentPage = null;
  let pageObserver;
  let pageControl;
  let nativeRefreshTimer;
  let toolbar;
  let toolbarLoading;
  let updateBingResults;

  async function init() {
    if (process.env.BROWSER !== 'firefox') watchVisiblePreviews(container, id => THUMBNAILS_MAP.has(id));
    // screen sizes needed for the service worker
    storage.local.set({
      screen: {
        availWidth: window.screen.availWidth,
        availHeight: window.screen.availHeight
      }
    });

    // Vertical center
    if (settings.$.vertical_center) {
      container.classList.add('grid--vcenter');
    }

    syncDragSettings(false);

    // Create marker for the last active folder in advance to ensure the correct behavior when this option is used for the first time
    if (
      !localStorage.getItem(LAST_OPENED_FOLDER_ID) ||
      !settings.$.show_last_opened_folder
    ) {
      localStorage.setItem(LAST_OPENED_FOLDER_ID, settings.$.default_folder_id);
    }

    await syncToolbar();

    // Change the current dial if the page hash changes
    window.addEventListener('hashchange', refresh);

    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && currentPage && changes[bookmarkOrderKey(currentPage.folderId)] && !organizing) {
        refreshFromNative();
      }
    });

    // Create speeddial
    return refresh();
  }

  async function installToolbar(header) {
    await import(/* webpackChunkName: "webcomponents/vb-header" */ './vb-header');
    toolbar = document.createElement('vb-header');
    toolbar.setAttribute('placeholder', browser.i18n.getMessage('placeholder_input_search'));
    toolbar.setAttribute('initial-folder-id', settings.$.default_folder_id);
    toolbar.setAttribute('folder-id', currentPage?.folderId ?? startFolder());
    updateBingResults = initializeBingResults();

    toolbar.addEventListener('vb:search', ({ detail }) => {
      if (!settings.$.show_toolbar) return;
      const query = detail.isBookmarksEngine ? detail.search.trim() : '';
      updateBingResults(query, detail.immediate);
      if (query === searchQuery && !(detail.immediate && searchTimer)) return;
      searchQuery = query;
      viewRequest++;
      clearTimeout(searchTimer);
      if (query && !detail.immediate) searchTimer = setTimeout(refresh, 180);
      else refresh();
    });
    toolbar.addEventListener('vb:searchreset', () => {
      updateBingResults('');
      searchQuery = '';
      refresh();
    });
    toolbar.addEventListener('vb:searchcomposing', () => updateBingResults(''));
    header.append(toolbar);
  }

  async function syncToolbar() {
    const header = document.querySelector('.newtab-toolbar header');
    const enabled = settings.$.show_toolbar;
    header.hidden = !enabled;
    document.body.classList.toggle('hidden-toolbar', !enabled);
    if (!enabled) {
      updateBingResults?.('');
      if (searchQuery) {
        searchQuery = '';
        viewRequest++;
        clearTimeout(searchTimer);
        refreshFromNative();
      }
      if (toolbar?.inputNode) {
        toolbar.inputNode.value = '';
        toolbar.resetNode?.classList.remove('is-show');
      }
      return;
    }
    if (!toolbar) {
      toolbarLoading ||= installToolbar(header).finally(() => {
        toolbarLoading = null;
      });
      await toolbarLoading;
    }
    if (!settings.$.show_toolbar || !toolbar?.formNode) return;
    const selectedEngine = toolbar.engineNodes[toolbar.engineIndex]?.dataset.engine;
    if (selectedEngine !== settings.$.search_engine) {
      toolbar.prevEngineIndex = toolbar.engineIndex;
      toolbar.engine = settings.$.search_engine;
    }
    if (settings.$.open_link_newtab && settings.$.search_engine !== 'bookmarks') {
      toolbar.formNode.target = '_blank';
    } else {
      toolbar.formNode.removeAttribute('target');
    }
  }

  function syncDragSettings(searching) {
    const enabled = settings.$.drag_and_drop && !settings.$.sort_by_newest;
    if (enabled && !container.sortInstance) initDrag(container);
    const disabled = !enabled || searching;
    if (container.sortInstance?.isDisabled !== disabled) container.sortInstance?.toggleDisable(disabled);
  }

  // helper to turn on the dropzone lighting
  function showDropzone(target) {
    [...container.querySelectorAll(DROPZONE_SELECTOR)]
      .forEach(el => {
        const bookmark = el.closest('.bookmark') || el.closest('.bookmark-btn--back');
        if (bookmark.dataset.id !== target.dataset.id) {
          el.classList.add('is-activate');
        }
      });
  }

  // helper to turn off the dropzone backlight
  function hideDropzone() {
    [...container.querySelectorAll('.is-activate')]
      .forEach(el => el.classList.remove('is-activate'));
  }

  function initDrag(el) {
    let ghost = null;
    el.addEventListener('drop', event => {
      const target = event.target.closest('.bookmark');
      const dragged = [...el.querySelectorAll('.bookmark.dragging')];
      if (!target || !dragged.length) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const rect = target.getBoundingClientRect();
      reorderBookmarks(dragged.map(item => item.dataset.id), target.dataset.id,
        event.clientX >= rect.left + rect.width / 2);
    }, true);
    el.sortInstance = new DragSortify(el, {
      draggableSelector: '.bookmark',
      ignoreSelectors: ['.bookmark__delete', '.bookmark__refresh'],
      plugin: multiswap,
      onDragStart({ event, draggedElement, draggingItems }) {
        container.classList.add('has-dragging');
        showDropzone(draggedElement);

        if (!draggingItems.includes(draggedElement)) {
          // if the item is not selected, hide action panel
          document.dispatchEvent(new CustomEvent('vb-bookmarks-panel:close'));
        }

        const classes = ['drag-ghost'];
        ghost = draggedElement.cloneNode(true);
        ghost.externalLogo = settings.$.logo_external ? settings.$.logo_external_url : null;
        document.body.appendChild(ghost);

        if (process.env.BROWSER === 'firefox') {
          classes.push('is-firefox');
        }
        if (draggingItems.length > 1) {
          classes.push('multiply-ghost');
          ghost.innerHTML += `<div class="multiply-drop-count">${draggingItems.length}</div>`;
        }
        ghost.classList.add(...classes);

        const wh = draggedElement.offsetHeight / draggedElement.offsetWidth;
        let width = 150;
        let height = 150 * wh;

        // In browsers, there is a limit on the size of the ghost, restrict it 180
        if (draggedElement.offsetWidth < 180) {
        // reduce the ghost(25px) for UX
          width = draggedElement.offsetWidth - 25;
          height = width * wh;
        }

        ghost.style.width = `${width}px`;
        ghost.style.height = `${height}px`;

        const rect = draggedElement.getBoundingClientRect();

        event.dataTransfer.setDragImage(
          ghost,
          (event.clientX - rect.left) - (rect.width / 2) + (width / 2),
          (event.clientY - rect.top) - (rect.height / 2) + ((height) / 2)
        );
      },
      onDragEnd() {
        container.classList.remove('has-dragging');
        hideDropzone();
        if (ghost) {
          ghost.remove();
          ghost = null;
        }
      },
      onAdd({ item, target }) {
        const dragged = [...el.querySelectorAll('.bookmark.dragging')];
        if (item === dragged[0]) moveBookmarks(dragged.map(card => card.dataset.id), target.dataset.id);
      }
    });
    document.addEventListener('vb:bookmarks:select', (e) => {
      el.sortInstance.setSelectedItems(e.detail);
    });
  }

  function startFolder() {
    let folderId = String(settings.$.default_folder_id);

    // If the "Last Opened Folder" option is enabled, get the ID of the last opened folder
    if (settings.$.show_last_opened_folder) {
      folderId = localStorage.getItem(LAST_OPENED_FOLDER_ID) ?? DEFAULT_BOOKMARKS_FOLDER;
    }

    if (window.location.hash !== '') {
      folderId = window.location.hash.slice(1);
    }
    return folderId;
  }

  function renderBookmark(bookmark, card) {
    if (!card) {
      card = document.createElement('a', { is: 'vb-bookmark' });
      card.id = bookmark.id;
    }
    if (card.hidden) card.hidden = false;
    if (card.openNewTab !== settings.$.open_link_newtab) card.openNewTab = settings.$.open_link_newtab;
    if (card.hasTitle !== settings.$.show_bookmark_title) card.hasTitle = settings.$.show_bookmark_title;
    if (card.hasFavicon !== settings.$.show_favicon) card.hasFavicon = settings.$.show_favicon;
    if (card.title !== bookmark.title) card.setAttribute('title', bookmark.title || '');
    if (card.url !== bookmark.url) card.url = bookmark.url;
    if (card.parentId !== bookmark.parentId) {
      card.parentId = bookmark.parentId;
      card.dataset.parentId = bookmark.parentId;
    }
    showBookmarkImage(card);
    return card;
  }

  function showBookmarkImage(card) {
    const thumbnail = THUMBNAILS_MAP.get(card.id);
    const image = thumbnail?.blobUrl;
    const custom = !!thumbnail?.custom;
    if (card.isCustomImage !== custom) card.isCustomImage = custom;
    if (card.image !== image && (card.image || image)) card.image = image;
  }

  async function readFolder(requestedId) {
    const candidates = new Set([requestedId, String(settings.$.default_folder_id), DEFAULT_BOOKMARKS_FOLDER]);
    for (const id of candidates) {
      try {
        const [folder] = await getSubTree(id);
        if (Array.isArray(folder?.children) && !ROOT_FOLDERS.includes(folder.id)) return folder;
      } catch {
        // A folder can disappear in another tab or device. Try the next candidate.
      }
    }
    const roots = await getThree();
    return roots.find(folder => Array.isArray(folder.children) && !folder.unmodifiable);
  }

  function applyFolder(folder, requestedId, searching) {
    const previousId = container.dataset.folder;
    container.dataset.folder = folder.id;
    if (!searching && folder.parentId && !ROOT_FOLDERS.includes(folder.parentId)) {
      container.dataset.parentFolder = folder.parentId;
    } else {
      delete container.dataset.parentFolder;
    }

    const recovered = requestedId !== folder.id;
    if (recovered) {
      history.replaceState(null, '', '#' + encodeURIComponent(folder.id));
      $customTrigger('updateFolderList', document);
      if (requestedId === String(settings.$.default_folder_id) && !folder.unmodifiable) {
        settings.updateKey('default_folder_id', folder.id).catch(console.warn);
      }
    }
    localStorage.setItem(LAST_OPENED_FOLDER_ID, folder.id);
    if (recovered || previousId !== folder.id) {
      $customTrigger('changeFolder', container, { detail: { folderId: folder.id }, bubbles: true });
    }
  }

  function hasMoreBookmarks() {
    return currentPage && currentPage.offset < currentPage.items.length;
  }

  function canReorder() {
    return Boolean(settings.$.drag_and_drop && currentPage && !searchQuery && !organizing
      && !isGeneratedThumbs && !container.hasAttribute('aria-busy'));
  }

  async function readOrderRecord(folderId) {
    const key = bookmarkOrderKey(folderId);
    const record = (await storage.local.get(key))[key];
    if (record?.mode === 'manual' && Array.isArray(record.ids)) return record;
    return record?.mode === 'common' ? record : null;
  }

  async function writeOrderRecord(folderId, record) {
    const key = bookmarkOrderKey(folderId);
    if (record) await storage.local.set({ [key]: record });
    else await storage.local.remove(key);
  }

  function sameOrderRecord(current, expected) {
    return current?.mode === expected?.mode
      && (current?.mode !== 'manual' || sameOrder(current.ids, expected.ids));
  }

  function organize(task) {
    return withOrganizationLock(async() => {
      organizing = true;
      try {
        return await task();
      } finally {
        organizing = false;
      }
    });
  }

  const text = (zh, en) => document.documentElement.lang.startsWith('zh') ? zh : en;

  function showOrganizationUndo(message, undo) {
    Toast.show({
      message,
      delay: 8500,
      progress: true,
      hideByClick: false,
      action: {
        html: browser.i18n.getMessage('undo'),
        class: ['btn', 'btn--clear', 'md-ripple'],
        callback(event, hideToast) {
          hideToast();
          undo().catch(error => {
            console.warn(error);
            showOperationFailure();
          });
        }
      }
    });
  }

  async function applyNativeOrder(folderId, before, desired, selected, barriers) {
    const plan = planNativeOrder(before, desired, selected, barriers);
    if (!plan) return { synchronized: false, ids: null };

    const expected = [...before];
    for (const { id, from, to, insertion } of plan) {
      const actual = (await getChildren(folderId)).map(node => node.id);
      if (!sameOrder(expected, actual)) return { synchronized: false, ids: null, failed: true };
      try {
        const moved = await move(id, { parentId: folderId, index: insertion });
        if (moved.parentId !== folderId || moved.index !== to) return { synchronized: false, ids: null, failed: true };
      } catch (error) {
        console.warn(error);
        return { synchronized: false, ids: expected, failed: true };
      }
      expected.splice(from, 1);
      expected.splice(to, 0, id);
    }
    const actual = (await getChildren(folderId)).map(node => node.id);
    const synchronized = sameOrder(expected, actual);
    return { synchronized, ids: synchronized ? expected : null, failed: !synchronized };
  }

  async function undoOrdering(folderId, previous, next, native) {
    const result = await organize(async() => {
      const saved = await readOrderRecord(folderId);
      if (!sameOrderRecord(saved, next)) return false;
      if (native) {
        const actual = (await getChildren(folderId).catch(() => [])).map(node => node.id);
        if (!sameOrder(actual, native.after)) return false;
        const restored = await applyNativeOrder(folderId, actual, native.before, native.selected, native.barriers);
        if (!restored.synchronized) return false;
      }
      await writeOrderRecord(folderId, previous);
      return true;
    });
    $customTrigger('updateFolderList', document);
    await refresh();
    if (!result) {
      Toast.show(text('收藏夹已发生变化，无法安全撤销。', 'Bookmarks changed elsewhere. The order could not be undone.'));
    }
  }

  async function reorderBookmarks(ids, targetId, after) {
    if (!canReorder()) return false;
    const view = currentPage;
    const selected = [...new Set(ids)];
    try {
      const result = await organize(async() => {
        if (currentPage !== view || searchQuery || container.dataset.folder !== view.folderId) return null;
        const { folderId } = view;
        const previous = await readOrderRecord(folderId);
        if (!sameOrderRecord(previous, view.order)) return null;
        const children = await getChildren(folderId);
        const links = children.filter(node => node.url && !Object.hasOwn(bookmarksToDelete, node.id));
        const byId = new Map(links.map(node => [node.id, node]));
        if (!byId.has(targetId) || !selected.every(id => byId.has(id))) return null;
        const original = restoreOrder(links.map(node => node.id), view.items.map(item => item.id));
        const desired = orderAround(original, selected, targetId, after);
        if (!desired || sameOrder(original, desired)) return null;
        const next = { mode: 'manual', ids: desired };
        await writeOrderRecord(folderId, next);

        let native;
        let nativeFailed = false;
        if (process.env.BROWSER !== 'firefox' && sameOrder(original, links.map(node => node.id))
          && selected.every(id => !byId.get(id).unmodifiable)) {
          const priorNative = children.map(node => node.id);
          let slot = 0;
          const desiredNative = priorNative.map(id => byId.has(id) ? desired[slot++] : id);
          const barriers = new Set(children
            .filter(node => !byId.has(node.id) || node.unmodifiable).map(node => node.id));
          try {
            const sync = await applyNativeOrder(folderId, priorNative, desiredNative, selected, barriers);
            nativeFailed = !!sync.failed;
            if (sync.ids && !sameOrder(priorNative, sync.ids)) {
              native = { before: priorNative, after: sync.ids, selected, barriers };
            }
          } catch (error) {
            console.warn(error);
            nativeFailed = true;
          }
        }
        return { folderId, previous, next, native, nativeFailed };
      });
      await refresh();
      if (!result) return false;
      $customTrigger('updateFolderList', document);
      rememberOrderUndo(() => undoOrdering(result.folderId, result.previous, result.next, result.native));
      if (result.nativeFailed) {
        Toast.show(text('未能同步浏览器收藏夹，插件内的手动顺序已保留。',
          'Browser favorites could not be reordered. The manual order is kept in the extension.'));
      }
      return true;
    } catch (error) {
      console.warn(error);
      showOperationFailure();
      await refresh();
      return false;
    }
  }

  async function restoreCommonOrder() {
    const view = currentPage;
    if (!view || view.query) return false;
    try {
      const next = { mode: 'common' };
      const previous = await organize(async() => {
        if (currentPage !== view) return null;
        const record = await readOrderRecord(view.folderId);
        if (record?.mode !== 'manual') return null;
        await writeOrderRecord(view.folderId, next);
        return record;
      });
      if (!previous) return false;
      await refresh();
      rememberOrderUndo(() => undoOrdering(view.folderId, previous, next));
      return true;
    } catch (error) {
      console.warn(error);
      showOperationFailure();
      return false;
    }
  }

  function readThumbnails(items) {
    return ImageDB.readBookmarkPreviews(items)
      .then(({ records, hiddenIds, complete }) => ({
        byId: new Map(records.map(record => [record.id, record])), hiddenIds, complete
      }))
      .catch(() => null);
  }

  function refreshMedia(bookmark, card, thumbnails) {
    const thumbnail = thumbnails?.byId.get(bookmark.id);
    const current = THUMBNAILS_MAP.get(bookmark.id);
    if (thumbnails?.hiddenIds.has(bookmark.id)) {
      if (current?.blobUrl) URL.revokeObjectURL(current.blobUrl);
      THUMBNAILS_MAP.set(bookmark.id, { source: 'bookmark' });
      return;
    }
    if (!thumbnails?.complete && current && card?.url === bookmark.url
      && !thumbnail?.custom && current.source !== thumbnail?.source) return;
    if (thumbnail?.blob instanceof Blob) {
      const key = JSON.stringify([thumbnail.revision, thumbnail.custom, thumbnail.blob.type, thumbnail.blob.size]);
      if (current?.key === key) {
        current.source = thumbnail.source;
        return;
      }
      THUMBNAILS_MAP.set(bookmark.id, {
        key, custom: thumbnail.custom, source: thumbnail.source, blobUrl: URL.createObjectURL(thumbnail.blob)
      });
    } else {
      THUMBNAILS_MAP.delete(bookmark.id);
    }
    if (current?.blobUrl) URL.revokeObjectURL(current.blobUrl);
  }

  function buildCards(items, thumbnails, existing = new Map()) {
    const cards = [];
    for (const item of items) {
      if (Object.hasOwn(bookmarksToDelete, item.id)) continue;
      const card = existing.get(item.id);
      refreshMedia(item, card, thumbnails);
      cards.push(renderBookmark(item, card));
    }
    return cards;
  }

  async function refreshVisiblePreviews() {
    const page = currentPage;
    if (!page) return;
    const request = ++previewRead;
    const cards = [...container.querySelectorAll(':scope > .bookmark:not([hidden])')];
    const items = cards.map(card => ({ id: card.id, url: card.url }));
    const thumbnails = await readThumbnails(items);
    if (request !== previewRead || page !== currentPage || !thumbnails) return;
    cards.forEach((card, index) => {
      const item = items[index];
      if (!container.contains(card) || card.hidden || card.url !== item.url) return;
      refreshMedia(item, card, thumbnails);
      showBookmarkImage(card);
    });
  }

  function trimMedia(cards) {
    const used = new Set(cards.map(card => card.id));
    for (const [id, record] of THUMBNAILS_MAP) {
      if (!used.has(id)) {
        if (record.blobUrl) URL.revokeObjectURL(record.blobUrl);
        THUMBNAILS_MAP.delete(id);
      }
    }
  }

  async function loadMore() {
    const page = currentPage;
    if (!page || !pageControl?.isConnected || pageControl.disabled || page.request !== viewRequest) return;
    pageControl.disabled = true;
    const items = page.items.slice(page.offset, page.offset + PAGE_SIZE);
    try {
      const thumbnails = await readThumbnails(items);
      if (page.request !== viewRequest) return;
      const focused = document.activeElement === pageControl;
      const cards = buildCards(items, thumbnails);
      pageControl.before(...cards);
      page.offset += items.length;
      if (focused) cards[0]?.focus();
      if (!hasMoreBookmarks()) {
        pageControl.remove();
        pageObserver?.disconnect();
        pageObserver = null;
      }
    } finally {
      pageControl.disabled = false;
      if (currentPage !== page && pageControl.isConnected && pageObserver) {
        pageObserver.unobserve(pageControl);
        pageObserver.observe(pageControl);
      }
    }
  }

  function getPageControl() {
    if (!pageControl) {
      pageControl = $createElement('button', {
        type: 'button', class: 'btn bookmarks-load-more'
      }, browser.i18n.getMessage('load_more_bookmarks'));
      pageControl.addEventListener('click', loadMore);
    }
    return pageControl;
  }

  function updatePageObserver() {
    if (!hasMoreBookmarks()) {
      pageObserver?.disconnect();
      pageObserver = null;
    } else if (!pageObserver && typeof IntersectionObserver === 'function') {
      pageObserver = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) loadMore();
      }, { rootMargin: '160px' });
      pageObserver.observe(pageControl);
    }
  }

  function backButton() {
    const parentId = container.dataset.parentFolder;
    if (!window.location.hash || !parentId || !settings.$.show_back_column) return null;
    const existing = container.querySelector('#bookmark-back');
    if (existing?.firstElementChild.dataset.id === parentId) return existing;
    return $createElement('button', {
      id: 'bookmark-back',
      class: 'bookmark-btn bookmark-btn--back md-ripple',
      'aria-label': browser.i18n.getMessage('parent_folder')
    }, $createElement('span', { class: DROPZONE_SELECTOR.slice(1), 'data-id': parentId }));
  }

  function showGrid(items, thumbnails, sameScope) {
    const existing = new Map([...container.children].filter(node => node.matches('.bookmark[data-id]'))
      .map(card => [card.id, card]));
    const focused = container.contains(document.activeElement) ? document.activeElement : null;
    const selected = [...existing.values()].filter(card => card.hasAttribute('data-selected'));
    let selectionChanged = !sameScope;
    if (sameScope && selected.length) {
      const incoming = new Map(items.map(item => [item.id, item]));
      selectionChanged = selected.some(card => {
        const item = incoming.get(card.id);
        return !item || Object.hasOwn(bookmarksToDelete, card.id)
          || card.title !== (item.title || '') || card.url !== item.url || card.parentId !== item.parentId;
      });
    }
    if (selectionChanged) $customTrigger('vb-bookmarks-panel:close', document);

    const cards = buildCards(items, thumbnails, existing);
    const back = backButton();
    const children = back ? [back, ...cards] : [...cards];
    if (!cards.length) {
      const empty = container.querySelector('.empty-search')
        || $createElement('div', { class: 'empty-search' }, browser.i18n.getMessage('empty_search'));
      children.push(empty);
    }
    if (hasMoreBookmarks()) children.push(getPageControl());
    reconcileChildren(container, children);
    trimMedia(cards);
    updatePageObserver();
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  }

  async function refresh({ passive = false } = {}) {
    clearTimeout(searchTimer);
    searchTimer = undefined;
    if (organizing) return;
    const request = ++viewRequest;
    const requestedId = startFolder();
    const query = searchQuery;
    const searching = query.length > 0;
    dialLoading.hidden = !!currentPage;
    const sameRequestedScope = currentPage?.folderId === requestedId && currentPage.query === query;
    if (!passive || !sameRequestedScope) container.setAttribute('aria-busy', 'true');

    try {
      const [folder, matches, usage] = await Promise.all([
        readFolder(requestedId),
        searching ? searchBookmarks(query) : Promise.resolve(null),
        Promise.resolve().then(readUsage).catch(() => ({}))
      ]);
      if (!folder) throw new Error('No available bookmarks folder');
      if (request !== viewRequest) return;

      let visible = (matches ?? folder.children).filter(item => item.type !== 'separator'
        && item.url && !Object.hasOwn(bookmarksToDelete, item.id));
      const order = searching ? null : await readOrderRecord(folder.id).catch(() => null);
      if (request !== viewRequest) return;
      const sort = order?.mode ?? (settings.$.sort_by || 'common');
      const count = item => Number(usage?.[item.id]) || 0;
      if (sort === 'manual') {
        const byId = new Map(visible.map(item => [item.id, item]));
        visible = restoreOrder([...byId.keys()], order.ids).map(id => byId.get(id));
      } else if (sort === 'date') {
        visible.sort((a, b) => b.dateAdded - a.dateAdded);
      } else if (sort === 'alphabet') {
        visible.sort((a, b) => a.title.localeCompare(b.title, undefined, {
          sensitivity: 'base',
          numeric: true
        }));
      } else {
        visible.sort((a, b) => count(b) - count(a));
      }

      const sameScope = currentPage?.folderId === folder.id && currentPage.query === query;
      const initialItems = visible.slice(0, sameScope ? Math.max(currentPage.offset, PAGE_SIZE) : PAGE_SIZE);
      const thumbnails = await readThumbnails(initialItems);
      if (request !== viewRequest) return;
      if (passive && sameScope && container.classList.contains('has-dragging')) {
        refreshFromNative();
        return;
      }
      const announceOrder = currentPage?.folderId !== folder.id || currentPage?.sort !== sort;
      const newSearch = searching && currentPage?.query !== query;
      currentPage = { request, items: visible, offset: initialItems.length, folderId: folder.id, query, order, sort };
      container.dataset.orderMode = sort;
      if (announceOrder) {
        $customTrigger('bookmark-order-mode', container, {
          detail: { folderId: folder.id, mode: sort },
          bubbles: true
        });
      }
      syncDragSettings(searching);
      applyFolder(folder, requestedId, searching);
      document.body.classList.toggle('has-search', searching);
      showGrid(initialItems, thumbnails, sameScope);
      if (newSearch) document.getElementById('main').scrollTop = 0;
    } catch (error) {
      if (request !== viewRequest) return;
      console.warn(error);
      pageObserver?.disconnect();
      pageObserver = null;
      currentPage = null;
      trimMedia([]);
      $customTrigger('vb-bookmarks-panel:close', document);
      container.replaceChildren($createElement('div', { class: 'not-found' },
        $createElement('p', { class: 'not-found__text' }, browser.i18n.getMessage('not_found_text'))));
    } finally {
      if (request === viewRequest) {
        dialLoading.hidden = true;
        container.removeAttribute('aria-busy');
      }
    }
  }

  function refreshFromNative() {
    clearTimeout(nativeRefreshTimer);
    if (container.classList.contains('has-dragging')) {
      nativeRefreshTimer = setTimeout(refreshFromNative, 80);
      return;
    }
    refresh({ passive: true });
  }

  /**
   * Create progress toast
   * @param {Number} number of bookmarks
   * @returns {HTMLElement} progress element
   */
  function renderProgressToast(sum) {
    const i18n = browser.i18n.getMessage(
      'thumbnails_creation',
      [
        '<strong id="progress-text">0</strong>',
        sum
      ]
    );
    const progressToast = $createElement(
      'div', {
        class: 'progress-toast'
      },
      {
        html:
          `<div class="progress-toast__icon">${SVG_LOADER}</div>` +
          `<div class="progress-toast__text">${i18n}</div>`
      }
    );
    return progressToast;
  }

  /**
   * Checks if the user has permission to access all URLs.
   * @return {Promise<boolean>} A promise that resolves to a boolean indicating whether the user has permission to access all URLs.
   */
  async function checkHostPermissions() {
    const allUrlsPermission = await requestPermissions({ origins: ['<all_urls>'] }).catch(() => false);
    if (!allUrlsPermission) {
      const message = browser.i18n.getMessage('notice_host_permissions')
        + `<br><br><button class="btn btn--primary md-ripple" data-permissions-info>${browser.i18n.getMessage('learn_more')}</button>`;

      Toast.show({
        message,
        delay: 7000
      });
    }
    return allUrlsPermission;
  }

  function showOperationFailure() {
    const message = browser.i18n.getMessage('notice_bookmark_operation_failed');
    Toast.show(message || 'The bookmark operation could not be completed.');
  }

  async function captureMultipleBookmarks(bookmarks) {
    if (isGeneratedThumbs) return;
    const candidates = new Map();
    const result = { updated: 0, unchanged: 0, protected: 0, unavailable: 0, failed: 0, stopped: false };
    const chinese = document.documentElement.lang.startsWith('zh');
    for (const { id, url } of bookmarks) {
      if (id && /^https?:\/\//i.test(url || '')) candidates.set(id, { id, url });
    }
    if (!candidates.size) {
      Toast.show(chinese ? '当前没有可更新缩略图的网页书签。' : 'There are no webpage bookmarks to update.');
      return result;
    }

    isGeneratedThumbs = true;
    $customTrigger('thumbnails:updating', container);
    let progressToast;
    let captures;
    try {
      // Read custom covers for the complete folder, including cards outside the current page.
      const protectedImages = await ImageDB.getForBookmarks([...candidates.values()]);
      for (const image of protectedImages) {
        if (image.custom && candidates.delete(image.id)) result.protected++;
      }
      const uniqueUrls = new Map([...candidates.values()].map(bookmark => [bookmark.url, bookmark]));
      if (!uniqueUrls.size) return result;

      captures = openPreviewCapture();
      progressToast = renderProgressToast(uniqueUrls.size);
      const cancel = $createElement('button', { type: 'button', class: 'btn btn--clear progress-toast__cancel' },
        chinese ? '停止' : 'Stop');
      cancel.addEventListener('click', () => {
        result.stopped = true;
        cancel.disabled = true;
        captures.close();
      });
      progressToast.append(cancel);
      document.body.append(progressToast);
      const progressText = progressToast.querySelector('#progress-text');
      let index = 0;
      for (const bookmark of uniqueUrls.values()) {
        if (result.stopped) break;
        if (progressText) progressText.textContent = ++index;
        const status = await captures.capture(bookmark);
        if (status === 'stopped') {
          result.stopped = true;
          break;
        }
        result[status]++;
      }
    } catch (error) {
      result.failed++;
      console.warn(error);
    } finally {
      captures?.close();
      progressToast?.remove();
      isGeneratedThumbs = false;
      $customTrigger('thumbnails:updated', container);
      const parts = chinese
        ? [result.stopped && '已停止', result.updated && `更新 ${result.updated} 个网址`,
          result.unchanged && `${result.unchanged} 个网址画面未变化`,
          result.unavailable && `${result.unavailable} 个网址返回错误页面`,
          result.protected && `保留 ${result.protected} 个自定义封面`, result.failed && `失败 ${result.failed} 个网址`]
        : [result.stopped && 'Stopped', result.updated && `Updated ${result.updated} URLs`,
          result.unchanged && `${result.unchanged} unchanged`,
          result.unavailable && `${result.unavailable} URLs returned an error page`,
          result.protected && `${result.protected} custom covers kept`, result.failed && `${result.failed} failed`];
      const message = parts.filter(Boolean).join(chinese ? '，' : ', ');
      if (message) Toast.show({ message, delay: 6000 });
      refresh();
    }
    return result;
  }

  async function autoUpdateThumb() {
    if (isGeneratedThumbs) return;
    try {
      const folder = await readFolder(startFolder());
      if (!folder) return;
      const bookmarks = settings.$.thumbnails_update_recursive
        ? flattenArrayBookmarks(folder.children)
        : folder.children;
      return await captureMultipleBookmarks(bookmarks);
    } catch (error) {
      console.warn(error);
      showOperationFailure();
    }
  }

  async function refreshCurrentThumbnails() {
    if (isGeneratedThumbs || !await checkHostPermissions()) return;
    return autoUpdateThumb();
  }

  async function updateSelectedThumbnails(selectedBookmarks) {
    await captureMultipleBookmarks(selectedBookmarks);
  }

  async function undoMove(entries, destinationId) {
    const restored = await organize(async() => {
      let count = 0;
      const ordered = [...entries].sort((a, b) => a.parentId.localeCompare(b.parentId) || a.index - b.index);
      for (const entry of ordered) {
        try {
          const [node] = await get(entry.id);
          if (node.parentId !== destinationId) continue;
          const children = await getChildren(entry.parentId);
          const positions = new Map(children.map((child, index) => [child.id, index]));
          const after = entry.siblings.slice(entry.index + 1).find(id => positions.has(id));
          const before = entry.siblings.slice(0, entry.index).reverse().find(id => positions.has(id));
          const index = after !== undefined ? positions.get(after)
            : before !== undefined ? positions.get(before) + 1 : Math.min(entry.index, children.length);
          await move(entry.id, { parentId: entry.parentId, index });
          count++;
        } catch (error) {
          console.warn(error);
        }
      }
      return count;
    });
    $customTrigger('updateFolderList', document);
    await refresh();
    if (restored === entries.length) {
      Toast.show(text('已撤销移动。', 'Move undone.'));
    } else {
      Toast.show(text('只能撤销 ' + restored + ' 项，其他书签已发生变化。',
        'Restored ' + restored + ' items. Other bookmarks changed elsewhere.'));
    }
  }

  async function moveBookmarks(ids, destinationId) {
    if (!destinationId || !ids.length) return false;
    try {
      const requested = [...new Set(ids)];
      const result = await organize(async() => {
        const [destination] = await get(destinationId);
        if (!destination || destination.url || destination.unmodifiable || ROOT_FOLDERS.includes(destination.id)
          || Object.hasOwn(bookmarksToDelete, destinationId)) return null;

        const moved = [];
        const sourceFolders = new Map();
        let failed = 0;
        for (const id of requested) {
          try {
            const [node] = await get(id);
            if (node.parentId === destinationId) continue;
            if (!node.url || node.unmodifiable || Object.hasOwn(bookmarksToDelete, node.id)) {
              failed++;
              continue;
            }
            if (!sourceFolders.has(node.parentId)) {
              sourceFolders.set(node.parentId, (await getChildren(node.parentId)).map(child => child.id));
            }
            const siblings = sourceFolders.get(node.parentId);
            const index = siblings.indexOf(id);
            if (index < 0) {
              failed++;
              continue;
            }
            await move(id, {
              parentId: destinationId,
              ...(settings.$.move_to_start && { index: moved.length })
            });
            moved.push({ id, parentId: node.parentId, index, siblings });
          } catch (error) {
            failed++;
            console.warn(error);
          }
        }
        return { moved, failed };
      });
      if (!result?.moved.length) {
        if (!result || result.failed) showOperationFailure();
        return false;
      }
      $customTrigger('updateFolderList', document);
      await refresh();
      const { moved, failed } = result;
      const zh = '已移动 ' + moved.length + ' 项书签' + (failed ? '，' + failed + ' 项未能移动。' : '。');
      const en = 'Moved ' + moved.length + ' bookmarks' + (failed ? '. ' + failed + ' could not be moved.' : '.');
      showOrganizationUndo(text(zh, en), () => undoMove(moved, destinationId));
      return true;
    } catch (error) {
      console.warn(error);
      showOperationFailure();
      await refresh();
      return false;
    }
  }

  function moveSelectedBookmarks(selectedBookmarks, destinationId) {
    return moveBookmarks(selectedBookmarks.map(bookmark => bookmark.id), destinationId);
  }

  /**
   * Upload user image for thumbnail
   * @param {Object} data
   * @param {HTMLInputElement} data.target - input file
   * @param {string} data.id
   * @param {(string|undefined)} data.site - domain
   */
  async function uploadScreen(bookmark, fileBlob) {
    bookmark.hasOverlay = true;
    try {
      const { id } = bookmark;
      const blob = await $resizeThumbnail(fileBlob);
      const saved = await ImageDB.update({ id, blob, custom: true, revision: crypto.randomUUID() });
      if (saved === undefined) throw new Error('Could not save custom image');
      Toast.show(browser.i18n.getMessage('notice_thumb_image_updated'));
      await refresh();
    } catch (error) {
      console.warn(error);
      showOperationFailure();
    } finally {
      bookmark.hasOverlay = false;
    }
  }

  async function createScreen(bookmark) {
    if (!bookmark?.isConnected || bookmark.hidden || !/^https?:\/\//i.test(bookmark.url || '')) return;
    const { id, url } = bookmark;
    const notify = key => Toast.show(browser.i18n.getMessage(key));
    if (THUMBNAILS_MAP.get(id)?.custom) {
      notify('notice_thumb_custom_kept');
      return;
    }
    if (isGeneratedThumbs) {
      notify('notice_thumb_busy');
      return;
    }

    isGeneratedThumbs = true;
    if (bookmark.contains(document.activeElement)) bookmark.focus({ preventScroll: true });
    bookmark.setAttribute('aria-busy', 'true');
    bookmark.hasOverlay = true;
    $customTrigger('thumbnails:updating', container);
    let capture;
    try {
      if (!await checkHostPermissions()) return;
      capture = openPreviewCapture();
      const status = await capture.capture({ id, url, mode: 'single' });
      if (status === 'updated') {
        await refreshVisiblePreviews();
        notify('notice_thumb_image_updated');
      } else if (status === 'unchanged') {
        notify('notice_thumb_unchanged');
      } else if (status === 'protected') {
        notify('notice_thumb_custom_kept');
      } else if (status === 'unavailable') {
        notify('notice_thumb_site_unavailable');
      } else {
        notify('notice_thumb_capture_failed');
      }
    } catch (error) {
      console.warn(error);
      notify('notice_thumb_capture_failed');
    } finally {
      capture?.close();
      bookmark.hasOverlay = false;
      bookmark.removeAttribute('aria-busy');
      isGeneratedThumbs = false;
      $customTrigger('thumbnails:updated', container);
    }
  }

  async function removeFromBrowser(bookmark, isFolder) {
    const id = bookmark.dataset.id;
    await (isFolder ? removeTree(id) : remove(id));
    $customTrigger('updateFolderList', document);
    await refresh();
  }

  function queueBookmarkDeletion(bookmarks, message) {
    const pending = new Map();
    for (const { id, isFolder, element } of bookmarks) {
      if (!id || !element.isConnected || Object.hasOwn(bookmarksToDelete, id)) continue;
      const entry = { id, isFolder };
      pending.set(id, entry);
      bookmarksToDelete[id] = entry;
      element.hidden = true;
    }
    if (!pending.size) return false;

    const forget = () => {
      for (const [id, entry] of pending) {
        if (bookmarksToDelete[id] === entry) delete bookmarksToDelete[id];
      }
    };
    let undone = false;
    Toast.show({
      message,
      delay: 8000,
      progress: true,
      hideByClick: false,
      action: {
        html: browser.i18n.getMessage('undo'),
        class: ['btn', 'btn--clear', 'md-ripple'],
        callback(event, hideToast) {
          undone = true;
          forget();
          refresh();
          hideToast();
        }
      },
      async onClose() {
        if (undone) return;
        try {
          const results = await Promise.allSettled([...pending.values()].map(async({ id, isFolder }) => {
            await (isFolder ? removeTree(id) : remove(id));
          }));
          if (results.some(result => result.status === 'rejected')) showOperationFailure();
        } finally {
          forget();
          $customTrigger('updateFolderList', document);
          refresh();
        }
      }
    });
    return true;
  }

  async function removeMultipleBookmarks(selectedBookmarks) {
    if (!settings.$.without_confirmation) {
      const confirmed = await confirmPopup(browser.i18n.getMessage('confirm_delete_selected_bookmarks'));
      if (!confirmed) return false;
    }

    return queueBookmarkDeletion(selectedBookmarks.map(element => ({
      id: element.id,
      isFolder: element.isFolder,
      element
    })), browser.i18n.getMessage('notice_selected_bookmarks_removed'));
  }

  async function removeBookmark(bookmark, isFolder = false, skipConfirmation = false) {
    if (!skipConfirmation && !settings.$.without_confirmation) {
      const confirmMessage = isFolder ? 'confirm_delete_folder' : 'confirm_delete_bookmark';
      if (!await confirmPopup(browser.i18n.getMessage(confirmMessage))) return;
    }

    const messageKey = isFolder ? 'notice_folder_removed' : 'notice_bookmark_removed';
    const message = browser.i18n.getMessage(messageKey, $escapeHtml(bookmark.title));
    queueBookmarkDeletion([{ id: bookmark.dataset.id, isFolder, element: bookmark }], message);
  }

  async function removeThumbnail(id) {
    try {
      const [bookmark] = await browser.bookmarks.get(id);
      if (bookmark?.url) await ImageDB.clearBookmarkPreview(id, bookmark.url);
      else await ImageDB.delete(id);
      await refresh();
      browser.runtime.sendMessage({ visitPreviewUpdated: true }).catch(() => undefined);
      return true;
    } catch (error) {
      console.warn(error);
      showOperationFailure();
      return false;
    }
  }

  async function createBookmark(title, url) {
    const folder = await readFolder(startFolder());
    if (!folder || folder.unmodifiable) throw new Error('No writable bookmark folder');
    const result = await create({ title, ...(url && { url }), parentId: folder.id });
    $customTrigger('updateFolderList', document);
    await refresh();
    return result;
  }

  async function updateBookmark(id, title, url, moveId) {
    const result = await update(id, { title, ...(url && { url }) });
    if (moveId && moveId !== id && moveId !== result.parentId) {
      await move(id, {
        parentId: moveId,
        ...(settings.$.move_to_start && { index: 0 })
      });
    }
    $customTrigger('updateFolderList', document);
    await refresh();
    Toast.show(browser.i18n.getMessage('notice_bookmark_updated'));
    return result;
  }

  return {
    init,
    syncToolbar,
    refresh,
    refreshFromNative,
    refreshVisiblePreviews,
    createBookmark,
    updateBookmark,
    removeFromBrowser,
    removeBookmark,
    removeMultipleBookmarks,
    createScreen,
    uploadScreen,
    removeThumbnail,
    autoUpdateThumb,
    refreshCurrentThumbnails,
    updateSelectedThumbnails,
    moveSelectedBookmarks,
    moveBookmarks,
    canReorder,
    reorderBookmarks,
    restoreCommonOrder,
    checkHostPermissions
  };
})();

export default Bookmarks;
