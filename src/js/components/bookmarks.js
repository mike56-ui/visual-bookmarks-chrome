import { DragSortify } from '../plugins/dragSortify';
import { multiswap } from '../plugins/dragSortify/multiswap';
import Toast from './toast';
import ImageDB from '../api/imageDB';
import { readUsage } from '../api/usage';
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
  let searchTimer;
  let searchQuery = '';
  let organizing = false;
  let currentPage = null;
  let pageObserver;
  let nativeRefreshTimer;

  async function init() {
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

    // Dragging option
    if (
      settings.$.drag_and_drop &&
      !settings.$.sort_by_newest
    ) {
      initDrag(container);
    }

    // Create marker for the last active folder in advance to ensure the correct behavior when this option is used for the first time
    if (
      !localStorage.getItem(LAST_OPENED_FOLDER_ID) ||
      !settings.$.show_last_opened_folder
    ) {
      localStorage.setItem(LAST_OPENED_FOLDER_ID, settings.$.default_folder_id);
    }

    // Search bookmarks if toolbar enable
    if (settings.$.show_toolbar) {
      await import(/* webpackChunkName: "webcomponents/vb-header" */'./vb-header');
      const vbHeader = document.createElement('vb-header');
      vbHeader.setAttribute('placeholder', browser.i18n.getMessage('placeholder_input_search'));
      vbHeader.setAttribute('initial-folder-id', settings.$.default_folder_id);
      vbHeader.setAttribute('folder-id', startFolder());
      document.querySelector('header').append(vbHeader);

      vbHeader.addEventListener('vb:search', ({ detail }) => {
        const query = detail.isBookmarksEngine ? detail.search.trim() : '';
        if (query === searchQuery) return;
        searchQuery = query;
        viewRequest++;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(refresh, query ? 180 : 0);
      });
      vbHeader.addEventListener('vb:searchreset', () => {
        searchQuery = '';
        refresh();
      });
    }

    // Change the current dial if the page hash changes
    window.addEventListener('hashchange', refresh);

    document.addEventListener('bookmark-removed', ({ detail }) => {
      // on any action, folder change or bookmark removal (from DOM)
      // remove the previously created url of the blob object from memory
      if (!document.getElementById(`vb-${detail.id}`)) {
        URL.revokeObjectURL(detail.image);

        const thumbnail = THUMBNAILS_MAP.get(detail.id);
        if (thumbnail) {
          if (thumbnail.children) {
            // if there are thumbnails in the children, clear them from memory too
            thumbnail.children.forEach(item => {
              if (item.blobUrl) {
                URL.revokeObjectURL(item.blobUrl);
              }
            });
          }
          // delete an inaccessible item from Map
          THUMBNAILS_MAP.delete(detail.id);
        }
      }
    });

    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && currentPage && changes[bookmarkOrderKey(currentPage.folderId)] && !organizing) {
        refreshFromNative();
      }
    });

    // Create speeddial
    return refresh();
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
      ignoreSelectors: ['.bookmark__delete'],
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

  function genBookmark(bookmark) {
    let image;
    let custom = false;
    const thumbnail = THUMBNAILS_MAP.get(bookmark.id);
    if (thumbnail) {
      image = thumbnail.blobUrl;
      custom = thumbnail.custom;
    }

    const vbBookmark = document.createElement('a', { is: 'vb-bookmark' });
    Object.assign(vbBookmark, {
      id: bookmark.id,
      url: bookmark.url,
      title: bookmark.title,
      parentId: bookmark.parentId,
      image,
      isCustomImage: custom,
      externalLogo: settings.$.logo_external ? settings.$.logo_external_url : null,
      openNewTab: settings.$.open_link_newtab,
      hasTitle: settings.$.show_bookmark_title,
      hasFavicon: settings.$.show_favicon
    });
    vbBookmark.dataset.parentId = bookmark.parentId;
    return vbBookmark;
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
      if (!sameOrder(expected, actual)) return { synchronized: false, ids: null };
      try {
        const moved = await move(id, { parentId: folderId, index: insertion });
        if (moved.parentId !== folderId || moved.index !== to) return { synchronized: false, ids: null };
      } catch (error) {
        console.warn(error);
        return { synchronized: false, ids: expected };
      }
      expected.splice(from, 1);
      expected.splice(to, 0, id);
    }
    const actual = (await getChildren(folderId)).map(node => node.id);
    return { synchronized: sameOrder(expected, actual), ids: sameOrder(expected, actual) ? expected : null };
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
        let synchronized = false;
        if (process.env.BROWSER !== 'firefox' && sameOrder(original, links.map(node => node.id))
          && selected.every(id => !byId.get(id).unmodifiable)) {
          const priorNative = children.map(node => node.id);
          let slot = 0;
          const desiredNative = priorNative.map(id => byId.has(id) ? desired[slot++] : id);
          const barriers = new Set(children
            .filter(node => !byId.has(node.id) || node.unmodifiable).map(node => node.id));
          try {
            const sync = await applyNativeOrder(folderId, priorNative, desiredNative, selected, barriers);
            synchronized = sync.synchronized;
            if (sync.ids && !sameOrder(priorNative, sync.ids)) {
              native = { before: priorNative, after: sync.ids, selected, barriers };
            }
          } catch (error) {
            console.warn(error);
          }
        }
        return { folderId, previous, next, native, synchronized };
      });
      await refresh();
      if (!result) return false;
      $customTrigger('updateFolderList', document);
      const message = result.synchronized
        ? text('手动顺序已保存并同步到浏览器收藏夹。', 'Manual order saved and reflected in browser favorites.')
        : text('已保存此文件夹的手动显示顺序。', 'Manual display order saved for this folder.');
      showOrganizationUndo(message, () => undoOrdering(result.folderId, result.previous, result.next, result.native));
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
      showOrganizationUndo(text('已恢复常用优先。', 'Most used order restored.'),
        () => undoOrdering(view.folderId, previous, next));
      return true;
    } catch (error) {
      console.warn(error);
      showOperationFailure();
      return false;
    }
  }

  function bookmarkFragment(items, thumbnails) {
    const visible = items.filter(item => !Object.hasOwn(bookmarksToDelete, item.id));
    const visibleIds = new Set(visible.map(item => item.id));
    for (const thumbnail of thumbnails) {
      if (visibleIds.has(thumbnail.id) && thumbnail.blob instanceof Blob) {
        THUMBNAILS_MAP.set(thumbnail.id, {
          ...thumbnail,
          blobUrl: URL.createObjectURL(thumbnail.blob)
        });
      }
    }
    const fragment = document.createDocumentFragment();
    for (const item of visible) fragment.append(genBookmark(item));
    return fragment;
  }

  function addPageControl(page) {
    pageObserver?.disconnect();
    if (!hasMoreBookmarks()) return;

    const button = $createElement('button', {
      type: 'button', class: 'btn bookmarks-load-more'
    }, browser.i18n.getMessage('load_more_bookmarks'));
    button.style.gridColumn = '1 / -1';
    const load = async() => {
      if (button.disabled || page.request !== viewRequest) return;
      button.disabled = true;
      const items = page.items.slice(page.offset, page.offset + PAGE_SIZE);
      try {
        const thumbnails = await ImageDB.getForBookmarks(items).catch(() => []);
        if (page.request !== viewRequest) return;
        const fragment = bookmarkFragment(items, thumbnails);
        const first = fragment.firstElementChild;
        button.before(fragment);
        page.offset += items.length;
        if (document.activeElement === button) first?.focus();
        if (!hasMoreBookmarks()) {
          pageObserver?.disconnect();
          button.remove();
        }
      } finally {
        button.disabled = false;
      }
    };
    button.addEventListener('click', load);
    container.append(button);
    if (typeof IntersectionObserver === 'function') {
      pageObserver = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) load();
      }, { rootMargin: '160px' });
      pageObserver.observe(button);
    }
  }

  async function refresh() {
    if (organizing) return;
    clearTimeout(searchTimer);
    const request = ++viewRequest;
    const requestedId = startFolder();
    const query = searchQuery;
    const searching = query.length > 0;
    dialLoading.hidden = false;
    container.setAttribute('aria-busy', 'true');

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

      const limit = currentPage?.folderId === folder.id && currentPage.query === query
        ? Math.max(currentPage.offset, PAGE_SIZE)
        : PAGE_SIZE;
      const initialItems = visible.slice(0, limit);
      const thumbnails = await ImageDB.getForBookmarks(initialItems).catch(() => []);
      if (request !== viewRequest) return;
      currentPage = { request, items: visible, offset: initialItems.length, folderId: folder.id, query, order };
      container.dataset.orderMode = sort;
      $customTrigger('bookmark-order-mode', container, {
        detail: { folderId: folder.id, mode: sort },
        bubbles: true
      });

      $customTrigger('vb-bookmarks-panel:close', document);
      if (container.sortInstance?.isDisabled !== searching) {
        container.sortInstance?.toggleDisable(searching);
      }
      for (const thumbnail of THUMBNAILS_MAP.values()) {
        URL.revokeObjectURL(thumbnail.blobUrl);
      }
      THUMBNAILS_MAP.clear();
      applyFolder(folder, requestedId, searching);
      document.body.classList.toggle('has-search', searching);
      const fragment = document.createDocumentFragment();
      const parentId = container.dataset.parentFolder;
      if (window.location.hash && parentId && settings.$.show_back_column) {
        fragment.append($createElement('button', {
          id: 'bookmark-back',
          class: 'bookmark-btn bookmark-btn--back md-ripple',
          'aria-label': browser.i18n.getMessage('parent_folder')
        }, $createElement('span', {
          class: DROPZONE_SELECTOR.replace('.', ''),
          'data-id': parentId
        })));
      }
      const cards = bookmarkFragment(initialItems, thumbnails);
      if (cards.childElementCount) fragment.append(cards);
      else {
        fragment.append($createElement('div', { class: 'empty-search' }, browser.i18n.getMessage('empty_search')));
      }
      container.replaceChildren(fragment);
      addPageControl(currentPage);
    } catch (error) {
      if (request !== viewRequest) return;
      console.warn(error);
      pageObserver?.disconnect();
      currentPage = null;
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
    refresh();
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
    for (const { id, url } of bookmarks) {
      if (/^https?:\/\//i.test(url || '')) candidates.set(id, { id, url });
    }
    if (!candidates.size) return;

    isGeneratedThumbs = true;
    $customTrigger('thumbnails:updating', container);
    let progressToast;
    let failed = false;
    try {
      const protectedImages = await ImageDB.getForBookmarks([...candidates.values()]);
      for (const image of protectedImages) {
        if (image.custom) candidates.delete(image.id);
      }
      if (!candidates.size) return;

      progressToast = renderProgressToast(candidates.size);
      document.body.append(progressToast);
      const progressText = progressToast.querySelector('#progress-text');
      let index = 0;
      for (const bookmark of candidates.values()) {
        if (progressText) progressText.textContent = ++index;
        const success = await captureScreen(bookmark.url, bookmark.id);
        if (!success) failed = true;
      }
    } catch (error) {
      failed = true;
      console.warn(error);
    } finally {
      progressToast?.remove();
      isGeneratedThumbs = false;
      $customTrigger('thumbnails:updated', container);
      if (failed) {
        Toast.show(browser.i18n.getMessage('notice_screenshot_failed') || 'Some screenshots could not be saved.');
      }
      refresh();
    }
  }

  async function autoUpdateThumb() {
    if (isGeneratedThumbs) return;
    try {
      const folder = await readFolder(startFolder());
      if (!folder) return;
      const bookmarks = settings.$.thumbnails_update_recursive
        ? flattenArrayBookmarks(folder.children)
        : folder.children;
      await captureMultipleBookmarks(bookmarks);
    } catch (error) {
      console.warn(error);
      showOperationFailure();
    }
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
      const saved = await ImageDB.update({ id, blob, custom: true });
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

  function captureScreen(captureUrl, id) {
    return new Promise(resolve => {
      const timeout = setTimeout(() => resolve(false), 40000);
      const finish = success => {
        clearTimeout(timeout);
        resolve(success);
      };
      try {
        browser.runtime.sendMessage({ capture: { id, captureUrl } }, response => {
          if (browser.runtime.lastError) return finish(false);
          finish(response === 'success' || response?.ok === true);
        });
      } catch {
        finish(false);
      }
    });
  }

  async function createScreen(bookmark) {
    if (bookmark?.isConnected && await checkHostPermissions()) {
      await captureMultipleBookmarks([bookmark]);
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

  async function removeThumbnail(id, previewUrl) {
    try {
      await ImageDB.delete(id);
      if (previewUrl) await ImageDB.deleteVisitPreview(previewUrl);
      await refresh();
    } catch (error) {
      console.warn(error);
      showOperationFailure();
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
    refresh,
    refreshFromNative,
    createBookmark,
    updateBookmark,
    removeFromBrowser,
    removeBookmark,
    removeMultipleBookmarks,
    createScreen,
    uploadScreen,
    removeThumbnail,
    autoUpdateThumb,
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
