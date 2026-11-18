import './usageWorker';
import ImageDB from './api/imageDB';
import browserContextMenu from './plugins/browserContextMenu';
import { settings } from './settings';
import { storage } from './api/storage';
import {
  $notifications,
  $base64ToBlob,
  $resizeThumbnail
} from './utils';
import {
  create,
  flattenArrayBookmarks,
  search
} from './api/bookmark';
import {
  THUMBNAIL_POPUP_HEIGHT,
  THUMBNAIL_POPUP_WIDTH,
  NEWTAB_URLS,
  NEWTAB_EMPTY_URLS,
  FIREFOX_BROWSER
} from './constants';
import { containsPermissions } from './api/permissions';
import { isWebUrl, registerVisitPreview } from './visitPreview';

function browserActionHandler() {
  const bookmarkPage = browser.runtime.getURL('newtab.html');
  const edgeBookmarkPage = bookmarkPage.replace(/^chrome-extension:/, 'extension:');
  browser.tabs.query({ currentWindow: true }, function(tabs) {
    for (let tab of tabs) {
      // A browser new-tab URL may still show Edge's default page or another extension.
      const url = (tab.url || '').split(/[?#]/)[0];
      if (url === bookmarkPage || url === edgeBookmarkPage) {
        return browser.tabs.update(tab.id, { active: true });
      }
    }
    return browser.tabs.create({ url: bookmarkPage });
  });
}

async function initContextMenu() {
  const { settings } = await storage.local.get('settings');
  browserContextMenu.init(settings?.show_contextmenu_item);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function captureManualThumbnail({ id, captureUrl }) {
  if (!isWebUrl(captureUrl) || !await containsPermissions({ origins: ['<all_urls>'] })) {
    return { warning: 'Cannot access contents of URL' };
  }
  const [bookmark] = await browser.bookmarks.get(id);
  if (bookmark?.url !== captureUrl) return { warning: 'Bookmark address changed' };
  if ((await ImageDB.get(id))?.custom) return { warning: 'Custom cover preserved' };

  const { settings, screen } = await storage.local.get(['settings', 'screen']);
  const wait = Math.min(5000, Math.max(500, (Number(settings?.thumbnails_update_delay) || 0.5) * 1000));
  const size = {
    width: THUMBNAIL_POPUP_WIDTH,
    height: THUMBNAIL_POPUP_HEIGHT,
    ...(screen && {
      left: Math.max(0, screen.availWidth - THUMBNAIL_POPUP_WIDTH),
      top: Math.max(0, screen.availHeight - THUMBNAIL_POPUP_HEIGHT)
    })
  };
  const popup = await browser.windows.create({ url: captureUrl, type: 'popup', focused: true, ...size });
  try {
    const tabId = popup.tabs?.[0]?.id;
    if (tabId === undefined) return { warning: 'Could not open screenshot tab' };
    await browser.tabs.update(tabId, { muted: true });
    const deadline = Date.now() + 20000;
    let tab = await browser.tabs.get(tabId);
    while (tab.status !== 'complete' && Date.now() < deadline) {
      await delay(250);
      tab = await browser.tabs.get(tabId);
    }
    if (tab.status !== 'complete') return { warning: 'Timeout waiting for a screenshot' };
    await delay(wait);
    const visible = await browser.tabs.get(tabId);
    if (!visible.active || visible.status !== 'complete' || visible.url !== tab.url || !isWebUrl(visible.url)) {
      return { warning: 'The screenshot page changed' };
    }
    const data = await browser.tabs.captureVisibleTab(popup.id, { format: 'png' });
    const after = await browser.tabs.get(tabId);
    const [current] = await browser.bookmarks.get(id);
    if (!data || !after.active || after.url !== visible.url
      || after.status !== 'complete' || current?.url !== captureUrl) {
      return { warning: 'The screenshot page changed' };
    }
    const blob = await $resizeThumbnail($base64ToBlob(data, 'image/png'));
    return await ImageDB.putManualThumbnail(id, captureUrl, blob) ? 'success' : { warning: 'Custom cover preserved' };
  } finally {
    await browser.windows.remove(popup.id).catch(() => undefined);
  }
}

function handleCreateBookmark(data) {
  browser.tabs.query({ active: true, currentWindow: true }, async function(tabs){
    const matches = await search(data.pageUrl);
    if (!matches) return;

    const isExist = matches.some(match => match.url === data.pageUrl);
    if (isExist) {
      // Bookmarks exist
      $notifications(browser.i18n.getMessage('notice_bookmark_exist'));
    } else {
      const { settings } = await storage.local.get('settings');
      // ID of the item for subfolders starts with 'save-{parentId}'
      // to get a valid ID, remove the extra characters from the string
      // extra characters will be found in subfolders in the add item
      const menuItemId = data.menuItemId.replace('save-', '');

      const parentId = (menuItemId === 'current_folder')
        ? String(settings.default_folder_id)
        : menuItemId;

      // Create
      const response = await create({
        parentId,
        url: data.pageUrl,
        title: tabs[0].title
      }).catch(err => {
        console.warn(err);
      });

      if (!response) return;

      if (settings.close_tab_after_adding_bookmark) {
        browser.tabs.remove(tabs[0].id);
      }
      $notifications(browser.i18n.getMessage('notice_bookmark_created'));
    }
  });
}

async function handleCreatedTab(tab) {
  const { settings } = await storage.local.get('settings');
  if (!tab.incognito && settings?.search_autofocus && NEWTAB_EMPTY_URLS.includes(tab.pendingUrl)) {
    // bug in MS Edge causes runtime.getURL to return the chrome-extension namespace, while it opens through the extension namespace.
    const url = /Edg\//.test(navigator.userAgent)
      ? browser.runtime.getURL('newtab.html').replace(/^chrome-extension:/, 'extension:')
      : browser.runtime.getURL('newtab.html');

    browser.tabs.create({
      url
    });
    browser.tabs.remove(tab.id);
  }
}

async function handleBookmarks(eventType, id, bookmark) {
  if (eventType === 'removed') {
    const removed = [bookmark.node, ...flattenArrayBookmarks(bookmark.node.children ?? [], true)];
    await Promise.all(removed.map(node => ImageDB.delete(node.id)));
    const urls = new Set(removed.map(node => node.url).filter(Boolean));
    await Promise.all([...urls].map(async url => {
      if (!(await browser.bookmarks.search({ url })).some(node => node.url === url)) {
        await ImageDB.deleteVisitPreview(url);
      }
    }));
  } else if (eventType === 'changed' && bookmark.url) {
    await ImageDB.deleteMismatchedThumbnail(id, bookmark.url);
  }
  const { importingBookmarks } = await storage.local.get('importingBookmarks');
  if (importingBookmarks) return;

  const isBookmarkUrl = bookmark.url || bookmark.node?.url;
  // we will start rebuilding the list of folders only if an event happened to the folder
  // note: in the case of moving, it will also work with a bookmark
  if (!isBookmarkUrl || eventType === 'moved') {
    initContextMenu();
  }

  // to avoid duplicating actions when editing bookmarks,
  // we will ignore further execution if our application is in the active tab
  const tabs = await browser.tabs.query({ active: true });
  const tabUrl = tabs[0]?.url?.replace(/#\d*/, '');
  if (NEWTAB_URLS.includes(tabUrl)) return;
  await browser.runtime.sendMessage({ bookmarksUpdated: true }).catch(() => undefined);
}

browser.storage.onChanged.addListener((changes, area) => {
  // if storage changes from local
  // watching the settings parameter
  if (area === 'local' && changes?.settings?.oldValue) {
    // at the moment we only need to track changes for the show_contextmenu_item option
    const { show_contextmenu_item: newContextMenu } = changes.settings.newValue;
    const { show_contextmenu_item: oldContextMenu } = changes.settings.oldValue;
    // toggle the context menu only if show_contextmenu_item has changed
    if (newContextMenu !== oldContextMenu) {
      browserContextMenu.toggle(newContextMenu);
    }
  }
});

browser.runtime.onInstalled.addListener(async(event) => {
  if (event.reason === 'install') {
    await settings.init();
  }
  initContextMenu();
  if (event.reason === 'update') {
    const manifest = browser.runtime.getManifest();
    const [majorPrevious, minorPrevious] = event.previousVersion.split('.').map(Number);
    const [major, minor] = manifest.version.split('.').map(Number);

    if (major > majorPrevious || minor > minorPrevious) {
      storage.local.set({ extension_updated: true });
    }
    // return browser.tabs.create({ url: browser.runtime.getURL('options.html#changelog') });
  }
});

const bookmarkListener = event => (id, bookmark) => {
  handleBookmarks(event, id, bookmark).catch(error => console.warn(error));
};
browser.bookmarks.onCreated.addListener(bookmarkListener('created'));
browser.bookmarks.onChanged.addListener(bookmarkListener('changed'));
browser.bookmarks.onRemoved.addListener(bookmarkListener('removed'));
browser.bookmarks.onMoved.addListener(bookmarkListener('moved'));

if (!FIREFOX_BROWSER) {
  // firefox does not support onImportBegan and onImportEnded events
  browser.bookmarks.onImportBegan.addListener(() => {
    storage.local.set({ importingBookmarks: true });
  });
  browser.bookmarks.onImportEnded.addListener(() => {
    initContextMenu();
    setTimeout(() => {
      // avoid race conditions when the handleBookmarks process is running, but the flag has already been removed
      storage.local.remove('importingBookmarks');
    }, 500);
  });
}

browser.contextMenus.onClicked.addListener(handleCreateBookmark);
browser.action.onClicked.addListener(browserActionHandler);
browser.notifications.onClicked.addListener(browserActionHandler);
browser.notifications.onButtonClicked.addListener((id) => {
  // TODO: updates info
  // more about updates
  // go to options page with hash to show modal info
  if (id === 'changelog') {
    return browser.tabs.create({ url: browser.runtime.getURL('options.html#changelog') });
  }
});

browser.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  if (request.capture) {
    const extensionRoot = browser.runtime.getURL('');
    const edgeRoot = extensionRoot.replace(/^chrome-extension:/, 'extension:');
    if (sender.incognito || (!sender.url?.startsWith(extensionRoot) && !sender.url?.startsWith(edgeRoot))) {
      sendResponse({ warning: 'Screenshot request denied' });
      return;
    }
    captureManualThumbnail(request.capture)
      .catch(() => ({ warning: 'Could not update screenshot' }))
      .then(sendResponse);
    return true;
  }

  // Toggle contextmenu item
  if (request.showContextMenuItem) {
    const { checked } = request.showContextMenuItem;
    browserContextMenu.toggle(checked);
  }
});

browser.tabs.onCreated.addListener(handleCreatedTab);
registerVisitPreview();
