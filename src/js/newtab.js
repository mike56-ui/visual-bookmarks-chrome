import '../css/newtab.css';
import './components/vb-select';
import './components/vb-context-menu';
import './components/vb-scrollup';
import './components/vb-bookmarks-panel';
import FolderDock from './components/folderDock';
import bindMotionDrag from './components/motionDrag';
import { bindBookmarkCaptionTip } from './components/bookmarkCaptionTip';
import initializeSettingsDrawer from './components/settingsDrawer';

import Gmodal from 'glory-modal';
import { settings } from './settings';
import Bookmarks from './components/bookmarks';
import Localization from './plugins/localization';
import { Validator } from './plugins/validator';
import UI from './components/ui';
import Ripple from './components/ripple';
import confirmPopup from './plugins/confirmPopup';
import { letItSnow } from './plugins/snow';
import {
  get,
  getSubTree,
  flattenArrayBookmarks,
  getFolders
} from './api/bookmark';
import {
  // $getDomain,
  $createElement,
  $copyStr,
  $unescapeHtml,
  asyncLoadComponents,
  $notifications,
  checkClipboardImage
} from './utils';
import { recordOpen, USAGE_KEY } from './api/usage';
import './trackBookmarkOpens';
import ImageDB from './api/imageDB';
import { CONTEXT_MENU, LOCAL_PROTOCOLS } from './constants';
import Toast from './components/toast';
import { storage } from './api/storage';
import { containsPermissions } from './api/permissions';

const container = document.getElementById('bookmarks');
const modal = document.getElementById('modal');
const form = document.getElementById('formBookmark');
const modalHead = document.getElementById('modalHead');
const modalSelectFolders = document.getElementById('modalSelectFolders');
const titleField = document.getElementById('title');
const urlField = document.getElementById('url');
const urlWrap = document.getElementById('urlWrap');
const customScreen = document.getElementById('customScreen');
const ctxMenuEl = document.getElementById('context-menu');
const upload = document.getElementById('upload');
const asideControlsNode = document.getElementById('aside_controls');
let multipleSelectedBookmarks = [];
let lastSelectedBookmark = null;
let selectionPanelRequest;
let isGenerateThumbs = false;
let modalApi;
let bookmarkModalOpened = Promise.resolve();
let generateThumbsBtn = null;
let nativeBookmarksRefreshTimer = null;
let previewRefreshTimer;
let gridRefreshPending = false;

async function init() {
  // Set lang attr
  // Replacement underscore on the dash because underscore is not a valid language subtag
  document.documentElement.setAttribute(
    'lang',
    browser.i18n.getMessage('@@ui_locale').replace('_', '-')
  );

  window.addEventListener('resize', () => UI.calculateStyles());
  window.addEventListener('popstate', handlePopstate);
  window.addEventListener('load', handleLoad);
  window.addEventListener('hashchange', hideControlMultiplyBookmarks);

  /**
   * Settings
   */
  await settings.init();

  /**
   * UI
   */
  UI.userStyles();
  UI.calculateStyles();
  UI.setBG();

  const folderDock = new FolderDock(document.getElementById('folderDock'), {
    refreshBookmarks: () => Bookmarks.refresh()
  });
  await folderDock.init();
  bindBookmarkCaptionTip(container);
  bindMotionDrag({
    grid: container,
    folderList: document.getElementById('folderDockList'),
    canDrag: () => settings.$.drag_and_drop,
    canReorder: () => Bookmarks.canReorder(),
    reorderBookmarks: (ids, target, after) => Bookmarks.reorderBookmarks(ids, target, after),
    moveBookmarks: async(ids, destination) => {
      const moved = await Bookmarks.moveBookmarks(ids, destination);
      if (moved) await folderDock.render();
      return moved;
    },
    reorderFolders: (id, target, after) => folderDock.reorderFolders(id, target, after)
  });
  document.addEventListener('newtab:restore-common-order', () => {
    Bookmarks.restoreCommonOrder().catch(console.warn);
  });
  document.addEventListener('newtab:refresh-previews', handleGenerateThumbs);

  /**
   * Localization
   */
  Localization();

  /**
   * Ripple
   */
  Ripple.init('.md-ripple');

  Bookmarks.init().then(syncPagination);
  initializeSettingsDrawer({ onSettingsChange: changes => applySettingsChanges(changes, folderDock) });

  const scheduleGridRefresh = () => {
    window.clearTimeout(nativeBookmarksRefreshTimer);
    nativeBookmarksRefreshTimer = window.setTimeout(Bookmarks.refreshFromNative, 100);
  };
  const refreshNativeBookmarks = () => {
    folderDock.scheduleRender();
    scheduleGridRefresh();
  };
  browser.bookmarks.onCreated.addListener(refreshNativeBookmarks);
  browser.bookmarks.onChanged.addListener(refreshNativeBookmarks);
  browser.bookmarks.onRemoved.addListener(refreshNativeBookmarks);
  browser.bookmarks.onMoved.addListener(refreshNativeBookmarks);
  browser.bookmarks.onChildrenReordered?.addListener(refreshNativeBookmarks);

  modalApi = new Gmodal(modal, {
    stickySelectors: ['.sticky'],
    closeBackdrop: false
  });
  document.addEventListener('newtab:add-bookmark', () => {
    prepareModal();
    modalApi.open();
  });
  modalApi.element.addEventListener('gmodal:beforeopen', () => {
    bookmarkModalOpened = new Promise(resolve => {
      modalApi.element.addEventListener('gmodal:open', resolve, { once: true });
    });
    form.reset();
  });
  modalApi.element.addEventListener('gmodal:open', () => {
    // UX focus when modal open
    if (form.getAttribute('data-action') === 'New') {
      form.elements.title.focus();
    } else {
      form.elements.title.select();
    }
  });
  const modalPermissionsApi = new Gmodal('#modal-host-permissions', {
    stickySelectors: ['.sticky'],
    closeBackdrop: false
  });

  const formBookmarkEl = document.getElementById('formBookmark');

  Validator(formBookmarkEl, {
    onSuccess: handleSubmitForm
  });

  settings.$.services_enable && runServices();

  upload.addEventListener('change', handleUploadScreen);
  container.addEventListener('click', handleDelegateClick);
  container.addEventListener('auxclick', (event) => {
    if (event.button === 1 && event.target.closest('.bookmark__refresh')) event.preventDefault();
  });
  container.addEventListener('mousedown', handleOpenMousemiddle);
  ctxMenuEl.addEventListener('vb:contextmenu:select', handleMenuSelection);
  ctxMenuEl.addEventListener('vb:contextmenu:open', handleMenuOpen);
  document.getElementById('resetCustomImage').addEventListener('click', handleResetThumb);
  modal.addEventListener('gmodal:close', handleCloseModal);

  if (settings.$.show_settings_icon) {
    asideControlsNode.append($createElement('a', {
      id: 'settings_icon',
      class: 'circ-btn settings-link',
      ariaLabel: browser.i18n.getMessage('options'),
      href: 'options.html'
    }, {
      html: `<svg width="20" height="20"><use xlink:href="/img/symbol.svg#settings"/></svg>`
    }
    ));
  }

  // scrollup button component
  document.getElementById('aside_controls').insertAdjacentElement(
    'afterend',
    $createElement('vb-scrollup', { class: 'sticky', 'scroll-selector': '.app' })
  );

  // If thumbnail generation button
  if (settings.$.thumbnails_update_button) {
    generateThumbsBtn = $createElement('button', {
      class: 'circ-btn update-thumbnails',
      'aria-label': browser.i18n.getMessage('thumbnails_update')
    }, {
      html: `<svg width="20" height="20"><use xlink:href="/img/symbol.svg#capture_outline"/></svg>`
    });
    document.getElementById('aside_controls').appendChild(generateThumbsBtn);

    generateThumbsBtn.addEventListener('click', handleGenerateThumbs);
  }
  container.addEventListener('thumbnails:updating', () => {
    isGenerateThumbs = true;
    if (generateThumbsBtn) generateThumbsBtn.disabled = true;
  });
  container.addEventListener('thumbnails:updated', () => {
    isGenerateThumbs = false;
    if (generateThumbsBtn) generateThumbsBtn.disabled = false;
  });

  const schedulePreviewRefresh = () => {
    window.clearTimeout(previewRefreshTimer);
    if (!document.hidden) previewRefreshTimer = window.setTimeout(() => {
      if (!document.hidden) Bookmarks.refreshVisiblePreviews();
    }, 100);
  };
  const refreshGridWhenVisible = () => {
    if (document.hidden) return;
    if (gridRefreshPending) {
      gridRefreshPending = false;
      scheduleGridRefresh();
    } else schedulePreviewRefresh();
  };
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[USAGE_KEY]) gridRefreshPending = true;
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) refreshGridWhenVisible();
  });
  window.addEventListener('focus', refreshGridWhenVisible);
  document.addEventListener('visibilitychange', refreshGridWhenVisible);
  browser.runtime.onMessage.addListener(request => {
    if (request?.bookmarksUpdated) refreshNativeBookmarks();
    if (request?.visitPreviewUpdated) schedulePreviewRefresh();
  });

  // import(/* webpackChunkName: "webcomponents/vb-actions-panel" */'./components/vb-bookmarks-panel');
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-permissions-info]')) return;
    modalPermissionsApi.open();
  });
  container.addEventListener('click', handleSelectBookmark);
  document.addEventListener('vb-bookmarks-panel:action', handleMultipleBookmarks);
  document.addEventListener('vb-bookmarks-panel:close', hideControlMultiplyBookmarks);
  document.addEventListener('vb:search', hideControlMultiplyBookmarks);
  document.addEventListener('vb:searchreset', hideControlMultiplyBookmarks);
  document.addEventListener('keydown', ({ code }) => {
    code === 'Escape' && hideControlMultiplyBookmarks();
  });
}

function handleSelectBookmark(e) {
  if (isGenerateThumbs) return;
  const bookmark = e.target.closest('.bookmark');
  if (!bookmark || bookmark.hidden || e.target.closest('.bookmark__refresh, .bookmark__delete')) return true;

  if (!e.shiftKey && !e.ctrlKey && !e.metaKey) return true;

  e.preventDefault();

  let rangeBookmarks = [];
  const isSelected = bookmark.hasAttribute('data-selected');

  if (e.shiftKey && container.contains(lastSelectedBookmark) && !lastSelectedBookmark.hidden) {
    const bookmarkNodes = Array.from(container.querySelectorAll('.bookmark:not([hidden])'));
    // find a range of bookmarks
    const startIndex = bookmarkNodes.findIndex(bookmarkNode => bookmarkNode === bookmark);
    const endIndex = bookmarkNodes.findIndex(bookmarkNode => bookmarkNode === (lastSelectedBookmark ?? bookmark));
    rangeBookmarks = bookmarkNodes.slice(Math.min(startIndex, endIndex), Math.max(startIndex, endIndex) + 1);
  } else {
    rangeBookmarks = [bookmark];
  }

  rangeBookmarks.forEach(rangeBookmark => {
    if (isSelected) {
      rangeBookmark.removeAttribute('data-selected');
      multipleSelectedBookmarks = multipleSelectedBookmarks.filter(bs => bs !== rangeBookmark);
    } else {
      rangeBookmark.setAttribute('data-selected', '');
      // add to the array a range of bookmarks that do not exist yet
      !multipleSelectedBookmarks.includes(rangeBookmark) && multipleSelectedBookmarks.push(rangeBookmark);
    }
  });

  if (multipleSelectedBookmarks.length) {
    lastSelectedBookmark = bookmark;
    showControlMultiplyBookmarks();
  } else {
    lastSelectedBookmark = null;
    hideControlMultiplyBookmarks();
  }
}

function dispatchSelectedBookmarks() {
  document.dispatchEvent(
    new CustomEvent('vb:bookmarks:select', {
      detail: multipleSelectedBookmarks
    })
  );
}

async function showControlMultiplyBookmarks() {
  dispatchSelectedBookmarks();
  if (document.getElementById('bookmarks-panel') || selectionPanelRequest) return;

  const request = {};
  selectionPanelRequest = request;
  try {
    const folders = await getFolders();
    if (selectionPanelRequest !== request || !multipleSelectedBookmarks.length) return;

    const panel = $createElement('vb-bookmarks-panel', {
      id: 'bookmarks-panel',
      class: 'bookmarks-panel'
    });
    const parents = new Set(multipleSelectedBookmarks.map(bookmark => bookmark.parentId));
    panel.selectedFolder = parents.size === 1 ? multipleSelectedBookmarks[0].parentId : '';
    panel.folders = folders;
    document.body.append(panel);
    panel.show();
  } catch (error) {
    console.warn(error);
    if (selectionPanelRequest === request) hideControlMultiplyBookmarks();
  } finally {
    if (selectionPanelRequest === request) selectionPanelRequest = null;
  }
}

async function hideControlMultiplyBookmarks() {
  const panel = document.getElementById('bookmarks-panel');
  selectionPanelRequest = null;
  lastSelectedBookmark = null;
  multipleSelectedBookmarks.forEach(bookmark => delete bookmark.dataset.selected);
  multipleSelectedBookmarks = [];
  dispatchSelectedBookmarks();

  if (!panel) return;
  panel.removeAttribute('id');
  await panel.hide();
  panel.remove();
}

function handleMultipleBookmarks(evt) {
  const { action, destFolder } = evt.detail;
  const selected = multipleSelectedBookmarks.filter(bookmark => container.contains(bookmark) && !bookmark.hidden);
  if (!action || !selected.length) return;

  switch (action) {
    case 'open_all':
    case 'open_all_window':
    case 'new_window_incognito': openSelectedBookmarks(selected, action); break;
    case 'remove': removeSelectedBookmarks(selected); break;
    case 'update_thumbnails': updateSelectedThumbnails(selected); break;
    case 'move_bookmarks': movedSelectedBookmarks(selected, destFolder); break;
    default: break;
  }
}

async function movedSelectedBookmarks(multipleSelectedBookmarks, destFolder) {
  try {
    await Bookmarks.moveSelectedBookmarks(multipleSelectedBookmarks, destFolder);
  } catch (error) {
    console.warn(error);
    Toast.show(browser.i18n.getMessage('notice_bookmark_operation_failed') || 'Some bookmarks could not be moved.');
  } finally {
    hideControlMultiplyBookmarks();
    Bookmarks.refresh();
  }
}

async function updateSelectedThumbnails(multipleSelectedBookmarks) {
  if (!(await Bookmarks.checkHostPermissions())) {
    return;
  }

  await Bookmarks.updateSelectedThumbnails(multipleSelectedBookmarks);
  hideControlMultiplyBookmarks();
}

async function handleLoad() {
  // show a notification with a link to the description of the update
  const { extension_updated } = await storage.local.get('extension_updated');
  if (extension_updated) {
    const text = browser.i18n.getMessage('extension_updated_notification');
    const linkText = browser.i18n.getMessage('whats_new');
    Toast.show({
      message: `${text}.&nbsp;&nbsp;<a href="/options.html#changelog">${linkText}</a>`,
      delay: 0,
      onClose() {
        storage.local.remove('extension_updated');
      }
    });
  }

  letItSnow();
}

function handlePopstate() {
  // when navigating through the history
  // hide the context menu or the modal window if they are active
  ctxMenuEl.close();
  modalApi.close();
}

async function handleGenerateThumbs() {
  if (!isGenerateThumbs) await Bookmarks.refreshCurrentThumbnails();
}

function handleDelegateClick(evt) {
  const refresh = evt.target.closest('.bookmark__refresh');
  if (refresh) {
    evt.preventDefault();
    evt.stopPropagation();
    ctxMenuEl.close();
    const bookmark = refresh.closest('.bookmark');
    if (!bookmark.hasOverlay) Bookmarks.createScreen(bookmark);
  } else if (evt.target.closest('#bookmark-back')) {
    evt.preventDefault();
    window.location.hash = container.dataset.parentFolder;
  } else if (evt.target.closest('#add')) {
    evt.preventDefault();
    prepareModal();
    modalApi.open();
  } else if (evt.target.closest('.bookmark__delete')) {
    evt.preventDefault();
    evt.stopPropagation();
    const bookmark = evt.target.closest('.bookmark');
    Bookmarks.removeBookmark(bookmark, false, true);
  } else if (evt.target.closest('.bookmark')) {
    const url = evt.target.closest('.bookmark').href;

    if (checkLocalProtocol(url) && !evt.shiftKey) {
      evt.preventDefault();
      openLocalProtocol(url);
    }
  }
}

function handleOpenMousemiddle(evt) {
  if (evt.target.closest('.bookmark__refresh')) return;
  if (evt.target.closest('.bookmark') && evt.button === 1) {
    const url = evt.target.closest('.bookmark').href;

    if (checkLocalProtocol(url)) {
      evt.preventDefault();
      openLocalProtocol(url);
    }
  }
}

function checkLocalProtocol(url) {
  return LOCAL_PROTOCOLS.some(proto => url.startsWith(proto));
}

function openLocalProtocol(url) {
  // This trick won't work in Firefox; it doesn't allow opening local files.
  const open = settings.$.open_link_newtab ? browser.tabs.create : browser.tabs.update;

  open({
    url
  });
}

async function handleMenuOpen(evt) {
  // when opening the context menu,
  // hide the quick action bar to avoid side effects
  hideControlMultiplyBookmarks();

  let items;
  if (evt.detail.isFolder) {
    items = CONTEXT_MENU.filter(item => !item.isBookmark);
  } else {
    items = CONTEXT_MENU.filter(item => !item.isFolder);
  }
  if (!evt.detail.image) {
    // hide the menu item if there is no thumbnail
    items = items.filter(item => item.action !== 'delete_thumbnail');
  }
  if (!['https:', 'http:'].includes(evt.detail.protocol)) {
    items = items.filter(item => item.action !== 'capture');
  }

  // render menu items
  ctxMenuEl.listItems = items;

  // Moved the asynchronous permission check code below the render, as the menu positioning might not work correctly.
  const pasteItem = ctxMenuEl.querySelector('[data-action="paste_image"]');
  if (pasteItem) {
    // check if the permission is granted
    // else disable the menu item
    const clipboardReadPermission = await containsPermissions({ permissions: ['clipboardRead'] });
    const disabled = !clipboardReadPermission || !(await checkClipboardImage());
    pasteItem.classList.toggle('is-disabled', disabled);
    pasteItem.disabled = disabled;
  }
}

async function handleMenuSelection(evt) {
  const target = evt.detail.trigger;
  const action = evt.detail.selection;

  switch (action) {
    case 'new_window':
    case 'new_window_incognito':
      openWindow(target.href, action, target.id);
      break;
    case 'open_all':
    case 'open_all_window':
      openAll(target.id, action);
      break;
    case 'new_tab':
      openTab(target.href, {}, target.id);
      break;
    case 'edit':
      prepareModal(target);
      modalApi.open();
      break;
    case 'move':
      multipleSelectedBookmarks = [target];
      lastSelectedBookmark = target;
      target.setAttribute('data-selected', '');
      await showControlMultiplyBookmarks();
      document.querySelector('#bookmarks-panel select')?.focus();
      break;
    case 'copy_link':
      $copyStr(target.href);
      Toast.show(browser.i18n.getMessage('notice_link_copied'));
      break;
    case 'capture': {
      Bookmarks.createScreen(target);
      break;
    }
    case 'upload': {
      upload.dataset.id = target.id;
      upload.click();
      break;
    }
    case 'paste_image': {
      if (!(await containsPermissions({ permissions: ['clipboardRead'] }))) {
        return;
      }
      pasteImage(target);
      break;
    }
    case 'delete_thumbnail': {
      Bookmarks.removeThumbnail(target.id);
      break;
    }
    case 'remove': {
      Bookmarks.removeBookmark(target, target.isFolder);
      break;
    }
  }
}

async function handleUploadScreen(evt) {
  evt.preventDefault();

  const input = evt.target;
  const file = input.files[0];
  if (!file) return;
  const { id } = input.dataset;
  const bookmark = document.getElementById(`vb-${id}`);

  if (!bookmark) return;

  input.value = '';
  const blob = new Blob([new Uint8Array(await file.arrayBuffer())], {
    type: file.type
  });

  Bookmarks.uploadScreen(bookmark, blob);
}

async function pasteImage(target) {
  try {
    const [clipboardItem] = await navigator.clipboard.read();
    const imageType = clipboardItem.types.find(type => type.startsWith('image/'));

    if (!imageType) {
      return;
    }

    const blob = await clipboardItem.getType(imageType);
    Bookmarks.uploadScreen(target, blob);
  } catch (err) {
    console.error(err.name, err.message);
  }
}

function handleCloseModal() {
  modal.classList.remove('has-edit', 'has-add');
  customScreen.style.display = '';
  form.reset();
}

// TODO: experiment webcomponents
function syncPagination() {
  if (!settings.$.enable_virtual_pagination) {
    document.querySelector('vb-virtual-pagination')?.remove();
    return;
  }
  asyncLoadComponents(() => import(
    /* webpackChunkName: "webcomponents/vb-virtual-pagination" */'./components/vb-virtual-pagination'))
    .then(() => {
      if (settings.$.enable_virtual_pagination && !document.querySelector('vb-virtual-pagination')) {
        document.body.append($createElement('vb-virtual-pagination', { 'scrollable-selector': '.app' }));
      }
    });
}

function applySettingsChanges(changes, folderDock) {
  const before = changes.settings?.oldValue || {};
  const after = changes.settings?.newValue || {};
  const changed = (...keys) => keys.some(key => before[key] !== after[key]);
  if (changed('color_theme')) window.vbToggleTheme?.();
  if (changed('custom_style')) UI.userStyles();
  if (changes.backgroundMedia || changed('background_image', 'background_external', 'background_effect')) UI.setBG();
  if (changed('dial_columns', 'dial_width', 'services_enable', 'show_settings_icon', 'thumbnails_update_button')) {
    UI.calculateStyles();
  }
  if (changed('show_toolbar', 'search_engine', 'open_link_newtab')) Bookmarks.syncToolbar();
  if (changed('vertical_center')) container.classList.toggle('grid--vcenter', settings.$.vertical_center);
  if (changed('enable_virtual_pagination')) syncPagination();
  if (changed('services_enable') || JSON.stringify(before.services_list) !== JSON.stringify(after.services_list)) {
    document.querySelector('vb-services')?.remove();
    if (settings.$.services_enable) runServices();
  }
  if (changes.thumbnailMedia || changed('open_link_newtab', 'show_bookmark_title', 'show_favicon',
    'sort_by', 'bookmarks_sorting_type', 'default_folder_id', 'show_last_opened_folder',
    'folder_preview', 'drag_and_drop')) {
    Bookmarks.refreshFromNative();
  }
  if (changed('default_folder_id', 'show_last_opened_folder')) folderDock.scheduleRender();
}

function runServices() {
  import(/* webpackChunkName: "webcomponents/vb-services" */'./components/vb-services').then(() => {
    if (!settings.$.services_enable || document.querySelector('vb-services')) return;
    const el = document.createElement('vb-services');
    el.classList.add('sticky');
    el.servicesList = settings.$.services_list;
    document.body.append(el);

    // update storage after sorting
    el.addEventListener('update', e => {
      settings.updateKey('services_list', e.detail.services);
    });
  }).catch(err => {
    console.warn(err);
  });
}

async function removeSelectedBookmarks(multipleSelectedBookmarks) {
  // if (!settings.$.without_confirmation) {
  //   const confirmAction = await confirmPopup(browser.i18n.getMessage('confirm_delete_selected_bookmarks'));
  //   if (!confirmAction) return;
  // }
  // await Promise.all(
  //   multipleSelectedBookmarks.map(bookmark => {
  //     return Bookmarks.removeFromBrowser(bookmark, bookmark.isFolder);
  //   })
  // );

  const selectedBookmarks = [...multipleSelectedBookmarks];
  const confirm = await Bookmarks.removeMultipleBookmarks(selectedBookmarks);
  confirm && hideControlMultiplyBookmarks();
}

function openSelectedBookmarks(multipleSelectedBookmarks, action) {
  if (['open_all_window', 'new_window_incognito'].includes(action)) {
    const isIncognitoMode = action === 'new_window_incognito';
    browser.windows.create({
      focused: true,
      state: 'maximized',
      incognito: isIncognitoMode
    })
      .then(win => {
        multipleSelectedBookmarks.forEach(bookmark => {
          openTab(bookmark.url, { windowId: win.id }, win.incognito ? null : bookmark.id);
        });
      })
      .catch(() => {
        isIncognitoMode && $notifications(browser.i18n.getMessage('incognito_access_note'));
      });
  } else if (action === 'open_all') {
    multipleSelectedBookmarks.forEach(bookmark => {
      openTab(bookmark.url, {}, bookmark.id);
    });
  }
}

/**
 * Open all bookmarks from a folder
 * @param {string} id - folder id
 * @param {string} action - action to run
 */
function openAll(id, action) {
  getSubTree(id)
    .then(childrens => {
      if (!childrens.length) return;

      const bookmarks = flattenArrayBookmarks(childrens);

      if (action === 'open_all_window') {
        browser.windows.create({
          focused: true
        })
          .then(win => {
            bookmarks.forEach(bookmark => openTab(bookmark.url, { windowId: win.id }, bookmark.id));
          });
      } else {
        bookmarks.forEach(bookmark => openTab(bookmark.url, {}, bookmark.id));
      }
    });
}

/**
 * Open a bookmark in a new window
 * @param {string} url - bookmark URL
 * @param {string} action - action to run
 */
function openWindow(url, action, id) {
  const isIncognitoMode = action === 'new_window_incognito';

  browser.windows.create({
    url: url,
    state: 'maximized',
    incognito: isIncognitoMode
  }).then(() => { if (!isIncognitoMode) recordOpen(id); })
    .catch(() => {
      isIncognitoMode && $notifications(browser.i18n.getMessage('incognito_access_note'));
    });
}

/**
 * Open a bookmark in a new tab
 * @param {string} url - bookmark URL
 * @param {object} [options={}] - options for creating a tab
 * @param {boolean} [options.active]
 * @param {number} [options.index]
 * @param {number} [options.openerTabId]
 * @param {boolean} [options.pinned]
 * @param {string} [options.url]
 * @param {number} [options.windowId]
 */
function openTab(url, options = {}, id) {
  if (url.startsWith('#')) {
    url = `newtab.html${url}`;
  }

  const defaults = {
    url: url,
    active: false
  };
  browser.tabs.create({ ...defaults, ...options }).then(() => recordOpen(id)).catch(() => {});
}

async function handleSubmitForm(evt) {
  evt.preventDefault();
  const form = evt.target;
  if (form.dataset.saving) return;
  const id = form.getAttribute('data-action');
  const title = form.title.value.trim();
  const url = form.url.value.trim();
  const opened = bookmarkModalOpened;
  form.dataset.saving = 'true';
  try {
    if (id === 'New') {
      const bookmark = await Bookmarks.createBookmark(title, url);
      if (bookmark.url) {
        browser.runtime.sendMessage({ newBookmarkPreview: { id: bookmark.id, url: bookmark.url } }).catch(console.warn);
      }
    } else {
      await Bookmarks.updateBookmark(id, title, url, modalSelectFolders.value);
    }
    // Gmodal ignores close() while its opening transition is in progress.
    await opened;
    if (opened === bookmarkModalOpened) modalApi.close();
  } catch (error) {
    console.warn(error);
    Toast.show(browser.i18n.getMessage('notice_bookmark_operation_failed') || 'The bookmark could not be saved.');
  } finally {
    delete form.dataset.saving;
  }
}

async function handleResetThumb(evt) {
  if (!settings.$.without_confirmation) {
    const confirmAction = await confirmPopup(browser.i18n.getMessage('confirm_delete_image'));
    if (!confirmAction) return;
  }

  evt.preventDefault();
  const id = this.getAttribute('data-bookmark');

  if (await Bookmarks.removeThumbnail(id)) this.closest('#customScreen').style.display = '';
}

async function prepareModal(target) {
  if (target) {
    modal.classList.add('has-edit');

    const bookmarkNode = await get(target.id).catch(err => console.warn(err));
    if (!bookmarkNode) return;

    const { id, url, parentId } = bookmarkNode[0];
    const title = $unescapeHtml(bookmarkNode[0].title);
    const imageData = await ImageDB.get(id);

    // generate bookmark folder list
    modalSelectFolders.setAttribute('parent-folder-id', parentId);
    modalSelectFolders.setAttribute('bookmark-id', id);
    modalSelectFolders.folders = await getFolders();

    if (imageData?.blob) {
      const image = URL.createObjectURL(imageData.blob);
      const imgElement = customScreen.querySelector('img');

      customScreen.style.display = 'block';
      imgElement.onload = () => {
        URL.revokeObjectURL(image);
      };
      imgElement.src = image;
      customScreen.querySelector('#resetCustomImage').setAttribute('data-bookmark', id);
    }

    modalHead.textContent = browser.i18n.getMessage('edit_bookmark');
    titleField.value = title;

    if (url) {
      urlWrap.style.display = '';
      urlField.value = url;
      form.dataset.oldUrl = url;
    } else {
      urlWrap.style.display = 'none';
    }
    form.setAttribute('data-action', id);
  } else {
    modal.classList.add('has-add');
    modalHead.textContent = browser.i18n.getMessage('add_bookmark');
    urlWrap.style.display = '';
    titleField.value = '';
    urlField.value = '';
    form.setAttribute('data-action', 'New');
  }
}

async function reloadUpdatedDevelopmentCopy(version) {
  const self = await browser.management?.getSelf();
  if (self?.installType !== 'development') return;
  // The installer finishes by replacing manifest.json. Avoid a reload during a partial copy.
  const response = await fetch(browser.runtime.getURL('manifest.json'), { cache: 'no-store' });
  if (!response.ok || (await response.json()).version !== version) return;
  const key = 'lastUnpackedReload';
  const [lastVersion, lastTime] = (localStorage.getItem(key) || '').split('/');
  if (lastVersion === version && Date.now() - Number(lastTime) < 30000) return;
  localStorage.setItem(key, `${version}/${Date.now()}`);
  browser.runtime.reload();
  return true;
}

async function startNewTab() {
  const version = process.env.BOOKMARK_BUILD_VERSION;
  if (process.env.BROWSER === 'chrome' && browser.runtime.getManifest().version !== version) {
    try {
      if (await reloadUpdatedDevelopmentCopy(version)) return;
    } catch (error) {
      console.warn(error);
    }
  }
  return init();
}

startNewTab();
