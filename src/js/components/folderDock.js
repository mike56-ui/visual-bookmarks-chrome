import Toast from './toast';
import Bookmarks from './bookmarks';
import { DEFAULT_BOOKMARKS_FOLDER, ROOT_FOLDERS } from '../constants';
import { storage } from '../api/storage';
import {
  FOLDER_DOCK_ORDER_KEY, orderAround, restoreOrder, sameOrder, withOrganizationLock
} from '../api/bookmarkOrder';
import setupFolderPanelLayout from './folderPanelLayout';
import confirmPopup from '../plugins/confirmPopup';
import { settings } from '../settings';
import { bookmarksToDelete } from '../state';
import {
  create,
  getThree,
  getChildren,
  removeTree,
  update
} from '../api/bookmark';
import { createSiteIcon } from '../utils';

const PREVIEW_SIZE = 10;

function escapeHTML(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function flattenFolders(nodes, orders, result = []) {
  const folders = nodes.filter(node => !node.url);
  const siblings = new Map(folders.map(folder => [folder.id, folder]));
  const parentId = folders[0]?.parentId;
  const sorted = restoreOrder([...siblings.keys()], orders[parentId]);
  for (const id of sorted) {
    const folder = siblings.get(id);
    result.push(folder);
    flattenFolders(folder.children ?? [], orders, result);
  }
  return result;
}

const isRootFolder = folder => ROOT_FOLDERS.includes(folder.parentId);
const isProtectedFolder = folder => isRootFolder(folder) || !!folder.unmodifiable;
const text = (zh, en) => document.documentElement.lang.startsWith('zh') ? zh : en;

async function readDockOrders() {
  return (await storage.local.get(FOLDER_DOCK_ORDER_KEY))[FOLDER_DOCK_ORDER_KEY] || {};
}

class FolderDock {
  #node;
  #list;
  #addButton;
  #folders = [];
  #editingId = null;
  #refreshBookmarks = null;
  #renderTimer = null;
  #renderVersion = 0;
  #closePanel;
  #ordering = false;

  constructor(node, { refreshBookmarks } = {}) {
    this.#node = node;
    this.#list = node.querySelector('#folderDockList');
    this.#addButton = node.querySelector('#folderDockAdd');
    this.#refreshBookmarks = refreshBookmarks;
  }

  async init() {
    this.#closePanel = setupFolderPanelLayout(this.#node);
    this.#attachEvents();
    await this.render();
  }

  scheduleRender() {
    if (this.#editingId) return;
    window.clearTimeout(this.#renderTimer);
    this.#renderTimer = window.setTimeout(() => this.render(), 80);
  }

  async render() {
    window.clearTimeout(this.#renderTimer);
    this.#renderTimer = null;
    const renderVersion = ++this.#renderVersion;
    const [roots, orders] = await Promise.all([getThree(), readDockOrders().catch(() => ({}))]);
    if (renderVersion !== this.#renderVersion) return;
    const scrollTop = this.#list.scrollTop;
    const focused = document.activeElement;
    const focusedCard = this.#list.contains(focused) && focused.closest('.folder-card');
    const focusTarget = focusedCard && ['folder-card__open', 'folder-card__rename-button', 'folder-card__delete']
      .find(className => focused.classList.contains(className));
    this.#folders = flattenFolders(roots, orders);
    const activeId = this.#getActiveFolderId();

    this.#list.innerHTML = this.#folders.map(folder => {
      const bookmarks = folder.children?.filter(child => child.url) ?? [];
      const previewItems = bookmarks.slice(0, PREVIEW_SIZE);
      const cells = Array.from({ length: PREVIEW_SIZE }, (_, index) => {
        const bookmark = previewItems[index];
        if (!bookmark) return '<span class="folder-card__cell is-empty"></span>';
        return `<span class="folder-card__cell" title="${escapeHTML(bookmark.title)}"
          data-bookmark-id="${escapeHTML(bookmark.id)}" data-icon-url="${escapeHTML(bookmark.url)}">
        </span>`;
      }).join('');
      const isProtected = isProtectedFolder(folder);
      const isActive = folder.id === activeId;
      const isPendingDelete = Boolean(bookmarksToDelete[folder.id]);
      const unfiled = isRootFolder(folder) && folder.id === DEFAULT_BOOKMARKS_FOLDER;
      const title = escapeHTML(unfiled ? text('未分组', 'Unfiled') : (folder.title || '未命名文件夹'));
      const titleContent = this.#editingId === folder.id
        ? `<input class="folder-card__rename" value="${title}" aria-label="重命名文件夹">`
        : `<span class="folder-card__name" title="${title}">${title}</span>`;

      return `<div class="folder-card${isActive ? ' is-active' : ''}"
        data-folder-id="${escapeHTML(folder.id)}"
        data-folder-parent="${escapeHTML(folder.parentId)}"
        ${isProtected ? 'data-no-folder-reorder' : ''}
        ${folder.unmodifiable || isPendingDelete ? 'data-no-bookmark-drop' : ''}
        ${unfiled ? 'data-folder-kind="unfiled"' : ''}
        ${isPendingDelete ? 'hidden' : ''}>
        <button class="folder-card__open" type="button" aria-label="${title}，${bookmarks.length} 项"${isActive ? ' aria-current="true"' : ''}></button>
        <div class="folder-card__preview" aria-hidden="true">${cells}</div>
        <div class="folder-card__meta">
          ${titleContent}
          <span class="folder-card__count">${bookmarks.length} 项</span>
        </div>
        ${isProtected ? '' : `
          <button class="folder-card__rename-button" type="button" aria-label="重命名 ${title}" title="重命名 (F2)">
            <svg width="13" height="13" aria-hidden="true"><use href="/img/symbol.svg#edit_outline"></use></svg>
          </button>
          <button class="folder-card__delete" type="button" aria-label="删除 ${title}" title="删除文件夹">×</button>`}
      </div>`;
    }).join('');

    this.#list.scrollTop = scrollTop;
    this.#list.querySelectorAll('[data-icon-url]').forEach(cell => {
      cell.append(createSiteIcon(cell.dataset.iconUrl, { size: 18 }));
    });

    const input = this.#list.querySelector('.folder-card__rename');
    if (input) {
      input.focus();
      input.select();
    } else if (focusTarget) {
      const id = CSS.escape(focusedCard.dataset.folderId);
      this.#list.querySelector(`[data-folder-id="${id}"]:not([hidden]) .${focusTarget}`)?.focus({ preventScroll: true });
    }
  }

  #attachEvents() {
    this.#list.addEventListener('click', event => this.#handleClick(event));
    this.#list.addEventListener('keydown', event => this.#handleKeydown(event));
    this.#list.addEventListener('dragover', event => this.#handleDragOver(event));
    this.#list.addEventListener('dragleave', event => this.#handleDragLeave(event));
    this.#list.addEventListener('drop', event => this.#handleDrop(event));
    this.#addButton.addEventListener('click', () => this.#createFolder());
    document.addEventListener('pointerdown', event => this.#handleRenamePointerDown(event));
    window.addEventListener('hashchange', () => this.#updateActiveFolder());
    document.addEventListener('updateFolderList', () => this.scheduleRender());
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[FOLDER_DOCK_ORDER_KEY] && !this.#ordering) this.scheduleRender();
    });
  }

  #getActiveFolderId() {
    const id = window.location.hash.slice(1)
      || (settings.$.show_last_opened_folder && localStorage.getItem('last_opened_folder_id'))
      || String(settings.$.default_folder_id);
    return this.#folders.find(folder => folder.id === id)?.id
      || this.#folders.find(folder => isRootFolder(folder) && !folder.unmodifiable)?.id;
  }

  #updateActiveFolder() {
    const activeId = this.#getActiveFolderId();
    this.#list.querySelector('.is-active')?.classList.remove('is-active');
    this.#list.querySelector('[aria-current]')?.removeAttribute('aria-current');
    const active = this.#list.querySelector(`[data-folder-id="${CSS.escape(activeId ?? '')}"]`);
    active?.classList.add('is-active');
    active?.querySelector('.folder-card__open').setAttribute('aria-current', 'true');
  }

  #handleClick(event) {
    const card = event.target.closest('.folder-card');
    if (!card || event.target.closest('.folder-card__rename')) return;

    if (event.target.closest('.folder-card__delete')) {
      event.preventDefault();
      event.stopPropagation();
      this.#deleteFolder(card.dataset.folderId);
      return;
    }

    if (event.target.closest('.folder-card__rename-button')) {
      this.#startRename(card.dataset.folderId);
      return;
    }
    window.location.hash = card.dataset.folderId;
    this.#closePanel();
  }

  #startRename(id) {
    const folder = this.#folders.find(item => item.id === id);
    if (!folder || isProtectedFolder(folder)) return;
    this.#editingId = folder.id;
    this.render();
  }

  #handleKeydown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    const input = event.target.closest('.folder-card__rename');
    if (input) {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.#commitRename(input.closest('.folder-card').dataset.folderId, input.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.#editingId = null;
        const id = input.closest('.folder-card').dataset.folderId;
        this.render().then(() => this.#focusFolder(id));
      }
      return;
    }

    const open = event.target.closest('.folder-card__open');
    if (open && event.key === 'F2') {
      event.preventDefault();
      this.#startRename(open.closest('.folder-card').dataset.folderId);
    }
  }

  #focusFolder(id) {
    this.#list.querySelector(`[data-folder-id="${CSS.escape(id)}"] .folder-card__open`)?.focus();
  }

  #handleRenamePointerDown(event) {
    const input = this.#list.querySelector('.folder-card__rename');
    if (!input || event.target === input) return;
    this.#commitRename(input.closest('.folder-card').dataset.folderId, input.value);
  }

  async #commitRename(id, title) {
    if (this.#editingId !== id) return;
    const nextTitle = title.trim() || '未命名文件夹';
    this.#editingId = null;
    try {
      await update(id, { title: nextTitle });
      document.dispatchEvent(new CustomEvent('updateFolderList'));
    } catch {
      Toast.show('无法重命名文件夹，请重试。');
    } finally {
      const wasEditing = document.activeElement?.matches('.folder-card__rename');
      await this.render();
      if (wasEditing && document.activeElement === document.body) this.#focusFolder(id);
    }
  }

  async #createFolder() {
    if (this.#addButton.disabled) return;
    this.#addButton.disabled = true;
    try {
      const folder = await create({ parentId: this.#getActiveFolderId(), title: '未命名文件夹' });
      this.#editingId = folder.id;
      document.dispatchEvent(new CustomEvent('updateFolderList'));
      await this.render();
      this.#list.querySelector(`[data-folder-id="${CSS.escape(folder.id)}"]`)?.scrollIntoView({ block: 'nearest' });
    } catch {
      Toast.show('无法创建文件夹，请重试。');
    } finally {
      this.#addButton.disabled = false;
    }
  }

  async #deleteFolder(id) {
    const folder = this.#folders.find(item => item.id === id);
    if (!folder || isProtectedFolder(folder) || bookmarksToDelete[id]) return;
    const confirmMessage = browser.i18n.getMessage('confirm_delete_folder');
    if (!settings.$.without_confirmation && !await confirmPopup(confirmMessage)) return;
    if (bookmarksToDelete[id]) return;
    const card = this.#list.querySelector(`[data-folder-id="${CSS.escape(id)}"]`);
    let shouldDelete = true;
    if (card) card.hidden = true;
    bookmarksToDelete[id] = { id, isFolder: true };

    Toast.show({
      message: `即将删除文件夹“${escapeHTML(folder.title)}”`,
      delay: 8000,
      progress: true,
      hideByClick: false,
      action: {
        html: browser.i18n.getMessage('undo'),
        class: ['btn', 'btn--clear', 'md-ripple'],
        callback: (event, hideToast) => {
          shouldDelete = false;
          delete bookmarksToDelete[id];
          this.render();
          hideToast();
        }
      },
      onClose: async() => {
        if (!shouldDelete) return;
        try {
          await removeTree(id);
          if (this.#getActiveFolderId() === id) {
            window.location.hash = folder.parentId;
          }
        } catch {
          Toast.show('无法删除文件夹，已恢复显示。');
        } finally {
          delete bookmarksToDelete[id];
          document.dispatchEvent(new CustomEvent('updateFolderList'));
          await this.#refreshBookmarks?.();
        }
      }
    });
  }

  async reorderFolders(sourceId, targetId, after) {
    if (sourceId === targetId || this.#ordering || this.#editingId) return false;
    const source = this.#folders.find(folder => folder.id === sourceId);
    const target = this.#folders.find(folder => folder.id === targetId);
    if (!source || !target || source.parentId !== target.parentId
      || isProtectedFolder(source) || isProtectedFolder(target)) return false;

    this.#ordering = true;
    try {
      const parent = source.parentId;
      const changed = await withOrganizationLock(async() => {
        const children = (await getChildren(parent)).filter(folder => !folder.url);
        const allowed = folder => folder && !isProtectedFolder(folder) && !bookmarksToDelete[folder.id];
        if (!allowed(children.find(folder => folder.id === sourceId))
          || !allowed(children.find(folder => folder.id === targetId))) return null;
        const orders = await readDockOrders();
        const previous = orders[parent];
        const current = restoreOrder(children.map(folder => folder.id), previous);
        const next = orderAround(current, [sourceId], targetId, after);
        if (!next || sameOrder(current, next)) return null;
        await storage.local.set({ [FOLDER_DOCK_ORDER_KEY]: { ...orders, [parent]: next } });
        return { previous, next };
      });
      if (!changed) return false;
      await this.render();
      Toast.show({
        message: text('文件夹顺序已保存。', 'Folder order saved.'),
        delay: 8500,
        progress: true,
        hideByClick: false,
        action: {
          html: browser.i18n.getMessage('undo'),
          class: ['btn', 'btn--clear', 'md-ripple'],
          callback: (event, hideToast) => {
            hideToast();
            this.#undoReorder(parent, changed);
          }
        }
      });
      return true;
    } catch (error) {
      console.warn(error);
      Toast.show(text('无法保存文件夹顺序。', 'The folder order could not be saved.'));
      return false;
    } finally {
      this.#ordering = false;
    }
  }

  async #undoReorder(parent, { previous, next }) {
    try {
      const restored = await withOrganizationLock(async() => {
        const orders = await readDockOrders();
        if (!Array.isArray(orders[parent]) || !sameOrder(orders[parent], next)) return false;
        if (previous) orders[parent] = previous;
        else delete orders[parent];
        await storage.local.set({ [FOLDER_DOCK_ORDER_KEY]: orders });
        return true;
      });
      await this.render();
      if (!restored) Toast.show(text('文件夹顺序已在其他页面变更。', 'Folders were reordered in another tab.'));
    } catch (error) {
      console.warn(error);
    }
  }

  #handleDragOver(event) {
    const card = event.target.closest('.folder-card:not([data-no-bookmark-drop])');
    if (!card || !document.querySelector('.bookmark.dragging')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    this.#list.querySelectorAll('.is-drop-target').forEach(node => {
      if (node !== card) node.classList.remove('is-drop-target');
    });
    card.classList.add('is-drop-target');
  }

  #handleDragLeave(event) {
    const card = event.target.closest('.folder-card');
    if (card && !card.contains(event.relatedTarget)) card.classList.remove('is-drop-target');
  }

  #handleDrop(event) {
    const card = event.target.closest('.folder-card:not([data-no-bookmark-drop])');
    if (!card) return;
    const dragged = [...document.querySelectorAll('#bookmarks .bookmark.dragging')];
    if (!dragged.length) return;
    event.preventDefault();
    event.stopPropagation();
    card.classList.remove('is-drop-target');
    Bookmarks.moveBookmarks(dragged.map(item => item.dataset.id), card.dataset.folderId);
  }
}

export default FolderDock;
