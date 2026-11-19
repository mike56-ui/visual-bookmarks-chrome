import Toast from './toast';
import { reconcileChildren } from './domOrder';
import { rememberOrderUndo } from './orderUndo';
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
const PREVIEW_ICON_SIZE = 16;

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
    this.#renderTimer = window.setTimeout(() => {
      if (document.body.classList.contains('motion-drag-active')) this.scheduleRender();
      else this.render();
    }, 80);
  }

  async render() {
    window.clearTimeout(this.#renderTimer);
    this.#renderTimer = null;
    const renderVersion = ++this.#renderVersion;
    const [roots, orders] = await Promise.all([getThree(), readDockOrders().catch(() => ({}))]);
    if (renderVersion !== this.#renderVersion) return;
    const scrollTop = this.#list.scrollTop;
    const focused = this.#list.contains(document.activeElement) ? document.activeElement : null;
    this.#folders = flattenFolders(roots, orders);
    const activeId = this.#getActiveFolderId();
    const existing = new Map([...this.#list.children].map(card => [card.dataset.folderId, card]));
    const cards = this.#folders.map(folder => this.#renderCard(folder, activeId, existing.get(folder.id)));
    reconcileChildren(this.#list, cards);
    this.#list.scrollTop = scrollTop;

    const input = this.#list.querySelector('.folder-card__rename');
    if (input && input !== focused) {
      input.focus();
      input.select();
    } else if (focused?.isConnected && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
    }
  }

  #renderCard(folder, activeId, card) {
    if (!card) {
      card = document.createElement('div');
      card.className = 'folder-card';
      card.dataset.folderId = folder.id;
      card.innerHTML = '<button class="folder-card__open" type="button"></button>'
        + '<div class="folder-card__preview" aria-hidden="true"></div>'
        + '<div class="folder-card__meta"><span class="folder-card__name"></span>'
        + '<span class="folder-card__count"></span></div>';
    }

    const bookmarks = folder.children?.filter(child => child.url) ?? [];
    const protectedFolder = isProtectedFolder(folder);
    const active = folder.id === activeId;
    const unfiled = isRootFolder(folder) && folder.id === DEFAULT_BOOKMARKS_FOLDER;
    const title = unfiled ? text('未分组', 'Unfiled') : (folder.title || '未命名文件夹');
    const count = bookmarks.length + ' 项';

    card.dataset.folderParent = folder.parentId ?? '';
    card.classList.toggle('is-active', active);
    card.hidden = !!bookmarksToDelete[folder.id];
    card.toggleAttribute('data-no-folder-reorder', protectedFolder);
    card.toggleAttribute('data-no-bookmark-drop', !!folder.unmodifiable || card.hidden);
    if (unfiled) card.dataset.folderKind = 'unfiled';
    else delete card.dataset.folderKind;
    const open = card.querySelector('.folder-card__open');
    open.setAttribute('aria-label', title + '，' + count);
    if (active) open.setAttribute('aria-current', 'true');
    else open.removeAttribute('aria-current');

    this.#renderFolderName(card, title, this.#editingId === folder.id);
    const label = card.querySelector('.folder-card__count');
    if (label.textContent !== count) label.textContent = count;
    this.#renderPreview(card.querySelector('.folder-card__preview'), bookmarks);
    this.#renderActions(card, title, protectedFolder);
    return card;
  }

  #renderFolderName(card, title, editing) {
    const input = card.querySelector('.folder-card__rename');
    const name = card.querySelector('.folder-card__name');
    if (editing) {
      if (input) return;
      const edit = document.createElement('input');
      edit.className = 'folder-card__rename';
      edit.value = title;
      edit.setAttribute('aria-label', '重命名文件夹');
      name.replaceWith(edit);
      return;
    }

    if (input) {
      const label = document.createElement('span');
      label.className = 'folder-card__name';
      label.title = title;
      label.textContent = title;
      input.replaceWith(label);
    } else if (name && name.textContent !== title) {
      name.title = title;
      name.textContent = title;
    }
  }

  #renderPreview(preview, bookmarks) {
    const cells = [...preview.children];
    const icons = new Map(cells.filter(cell => cell.dataset.bookmarkId).map(cell => [cell.dataset.bookmarkId, cell]));
    const empty = cells.filter(cell => !cell.dataset.bookmarkId);
    const next = [];
    for (let index = 0; index < PREVIEW_SIZE; index++) {
      const bookmark = bookmarks[index];
      const existing = bookmark ? icons.get(bookmark.id) : empty.shift();
      if (existing && (!bookmark || existing.dataset.iconUrl === bookmark.url)) {
        if (bookmark) existing.title = bookmark.title;
        next.push(existing);
        continue;
      }

      const cell = document.createElement('span');
      cell.className = bookmark ? 'folder-card__cell' : 'folder-card__cell is-empty';
      if (bookmark) {
        cell.dataset.iconUrl = bookmark.url;
        cell.dataset.bookmarkId = bookmark.id;
        cell.title = bookmark.title;
        cell.append(createSiteIcon(bookmark.url, { size: PREVIEW_ICON_SIZE }));
      }
      next.push(cell);
    }
    reconcileChildren(preview, next);
  }

  #renderActions(card, title, protectedFolder) {
    let rename = card.querySelector('.folder-card__rename-button');
    let remove = card.querySelector('.folder-card__delete');
    if (protectedFolder) {
      rename?.remove();
      remove?.remove();
      return;
    }
    if (!rename) {
      rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'folder-card__rename-button';
      rename.title = '重命名 (F2)';
      rename.innerHTML = '<svg width="13" height="13" aria-hidden="true">'
        + '<use href="/img/symbol.svg#edit_outline"></use></svg>';
      card.append(rename);
    }
    if (!remove) {
      remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'folder-card__delete';
      remove.title = '删除文件夹';
      remove.textContent = '×';
      card.append(remove);
    }
    rename.setAttribute('aria-label', '重命名 ' + title);
    remove.setAttribute('aria-label', '删除 ' + title);
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
      rememberOrderUndo(() => this.#undoReorder(parent, changed));
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
      Toast.show(text('无法撤销文件夹顺序。', 'The folder order could not be undone.'));
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
