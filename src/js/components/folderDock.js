import Toast from './toast';
import { settings } from '../settings';
import { bookmarksToDelete } from '../state';
import {
  create,
  getThree,
  move,
  removeTree,
  update
} from '../api/bookmark';
import { createSiteIcon } from '../utils';

const DOCK_POSITIONS = ['left', 'right', 'bottom'];
const DOCK_POSITION_KEY = 'visual-bookmarks-folder-dock';
const PREVIEW_SIZE = 10;

function escapeHTML(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function flattenFolders(nodes, result = []) {
  nodes.forEach(node => {
    if (node.url) return;
    result.push(node);
    flattenFolders(node.children?.filter(child => !child.url) ?? [], result);
  });
  return result;
}

class FolderDock {
  #node;
  #list;
  #handle;
  #addButton;
  #folders = [];
  #editingId = null;
  #refreshBookmarks = null;
  #renderTimer = null;
  #clickTimer = null;
  #pendingFolderId = null;
  #dragOrigin = null;

  constructor(node, { refreshBookmarks } = {}) {
    this.#node = node;
    this.#list = node.querySelector('#folderDockList');
    this.#handle = node.querySelector('#folderDockHandle');
    this.#addButton = node.querySelector('#folderDockAdd');
    this.#refreshBookmarks = refreshBookmarks;
  }

  async init() {
    const savedPosition = localStorage.getItem(DOCK_POSITION_KEY) || 'left';
    this.#applyPosition(savedPosition, false);
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
    const scrollTop = this.#list.scrollTop;
    const roots = await getThree();
    this.#folders = flattenFolders(roots);
    const activeId = this.#getActiveFolderId();

    this.#list.innerHTML = this.#folders.map(folder => {
      const bookmarks = folder.children?.filter(child => child.url) ?? [];
      const previewItems = bookmarks.slice(0, PREVIEW_SIZE);
      const cells = Array.from({ length: PREVIEW_SIZE }, (_, index) => {
        const bookmark = previewItems[index];
        if (!bookmark) return '<span class="folder-card__cell is-empty"></span>';
        return `<span class="folder-card__cell" title="${escapeHTML(bookmark.title)}" data-icon-url="${escapeHTML(bookmark.url)}">
        </span>`;
      }).join('');
      const isProtected = folder.parentId === '0';
      const isActive = folder.id === activeId;
      const isPendingDelete = Boolean(bookmarksToDelete[folder.id]);
      const title = escapeHTML(folder.title || '未命名文件夹');
      const titleContent = this.#editingId === folder.id
        ? `<input class="folder-card__rename" value="${title}" aria-label="重命名文件夹">`
        : `<span class="folder-card__name" title="${title}">${title}</span>`;

      return `<div class="folder-card${isActive ? ' is-active' : ''}"
        data-folder-id="${escapeHTML(folder.id)}"
        ${isPendingDelete ? 'hidden' : ''}
        role="button"
        tabindex="0"
        aria-label="${title}，${bookmarks.length} 项">
        <div class="folder-card__preview">${cells}</div>
        <div class="folder-card__meta">
          ${titleContent}
          <span class="folder-card__count">${bookmarks.length} 项</span>
        </div>
        ${isProtected ? '' : `<button class="folder-card__delete" type="button" aria-label="删除 ${title}" title="删除文件夹">×</button>`}
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
    }
  }

  #attachEvents() {
    this.#list.addEventListener('click', event => this.#handleClick(event));
    this.#list.addEventListener('dblclick', event => this.#handleDoubleClick(event));
    this.#list.addEventListener('keydown', event => this.#handleKeydown(event));
    this.#list.addEventListener('dragover', event => this.#handleDragOver(event));
    this.#list.addEventListener('dragleave', event => this.#handleDragLeave(event));
    this.#list.addEventListener('drop', event => this.#handleDrop(event));
    this.#addButton.addEventListener('click', () => this.#createFolder());
    this.#handle.addEventListener('pointerdown', event => this.#startDockMove(event));
    document.addEventListener('pointerdown', event => this.#handleRenamePointerDown(event));
    window.addEventListener('hashchange', () => this.render());
    document.addEventListener('updateFolderList', () => this.scheduleRender());
  }

  #getActiveFolderId() {
    return window.location.hash.slice(1)
      || localStorage.getItem('last_opened_folder_id')
      || String(settings.$.default_folder_id);
  }

  #applyPosition(position, persist = true) {
    const nextPosition = DOCK_POSITIONS.includes(position) ? position : 'left';
    this.#node.dataset.dock = nextPosition;
    document.body.dataset.folderDock = nextPosition;
    if (persist) localStorage.setItem(DOCK_POSITION_KEY, nextPosition);
    window.dispatchEvent(new Event('resize'));
  }

  #startDockMove(event) {
    event.preventDefault();
    this.#dragOrigin = { x: event.clientX, y: event.clientY };
    this.#node.classList.add('is-moving');
    this.#handle.setPointerCapture(event.pointerId);

    const stopMove = pointerEvent => {
      this.#node.classList.remove('is-moving');
      this.#handle.releasePointerCapture(pointerEvent.pointerId);
      const moved = Math.hypot(
        pointerEvent.clientX - this.#dragOrigin.x,
        pointerEvent.clientY - this.#dragOrigin.y
      );
      this.#dragOrigin = null;
      if (moved < 8) return;

      if (pointerEvent.clientY > window.innerHeight * 0.68) {
        this.#applyPosition('bottom');
      } else if (pointerEvent.clientX < window.innerWidth / 2) {
        this.#applyPosition('left');
      } else {
        this.#applyPosition('right');
      }
    };

    this.#handle.addEventListener('pointerup', stopMove, { once: true });
    this.#handle.addEventListener('pointercancel', stopMove, { once: true });
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

    window.clearTimeout(this.#clickTimer);
    this.#pendingFolderId = card.dataset.folderId;
    this.#clickTimer = window.setTimeout(() => {
      window.location.hash = this.#pendingFolderId;
      this.#pendingFolderId = null;
      this.#clickTimer = null;
    }, 220);
  }

  #handleDoubleClick(event) {
    const card = event.target.closest('.folder-card');
    const folder = this.#folders.find(item => item.id === card?.dataset.folderId);
    if (!folder || folder.parentId === '0') return;
    event.preventDefault();
    window.clearTimeout(this.#clickTimer);
    this.#clickTimer = null;
    this.#pendingFolderId = null;
    this.#editingId = folder.id;
    this.render();
  }

  #handleKeydown(event) {
    const input = event.target.closest('.folder-card__rename');
    if (input) {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.#commitRename(input.closest('.folder-card').dataset.folderId, input.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.#editingId = null;
        this.render();
      }
      return;
    }

    const card = event.target.closest('.folder-card');
    if (card && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      window.location.hash = card.dataset.folderId;
    }
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
    await update(id, { title: nextTitle });
    document.dispatchEvent(new CustomEvent('updateFolderList'));
    await this.render();
    Toast.show(`文件夹已重命名为“${nextTitle}”`);
  }

  async #createFolder() {
    const roots = this.#folders.filter(folder => folder.parentId === '0');
    const parentId = this.#pendingFolderId || this.#getActiveFolderId() || roots[0]?.id;
    window.clearTimeout(this.#clickTimer);
    this.#clickTimer = null;
    this.#pendingFolderId = null;
    const folder = await create({ parentId, title: '未命名文件夹' });
    this.#editingId = folder.id;
    document.dispatchEvent(new CustomEvent('updateFolderList'));
    await this.render();
    this.#list.querySelector(`[data-folder-id="${CSS.escape(folder.id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  #deleteFolder(id) {
    const folder = this.#folders.find(item => item.id === id);
    if (!folder || folder.parentId === '0') return;
    const card = this.#list.querySelector(`[data-folder-id="${CSS.escape(id)}"]`);
    let shouldDelete = true;
    card.hidden = true;
    bookmarksToDelete[id] = { id, isFolder: true };

    Toast.show({
      message: `已删除文件夹“${escapeHTML(folder.title)}”`,
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
        delete bookmarksToDelete[id];
        await removeTree(id);
        if (this.#getActiveFolderId() === id) {
          window.location.hash = folder.parentId === '0'
            ? String(settings.$.default_folder_id)
            : folder.parentId;
        }
        document.dispatchEvent(new CustomEvent('updateFolderList'));
        await this.#refreshBookmarks?.();
      }
    });
  }

  #handleDragOver(event) {
    const card = event.target.closest('.folder-card');
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

  async #handleDrop(event) {
    const card = event.target.closest('.folder-card');
    if (!card) return;
    event.preventDefault();
    event.stopPropagation();
    card.classList.remove('is-drop-target');

    const grid = document.getElementById('bookmarks');
    const dragged = grid.querySelector('.bookmark.dragging');
    if (!dragged) return;
    const selected = grid.sortInstance?.draggingItems ?? [];
    const items = selected.includes(dragged) && selected.length ? selected : [dragged];
    const ids = [...new Set(items.map(item => item.dataset.id))]
      .filter(id => id && id !== card.dataset.folderId);
    if (!ids.length) return;

    await Promise.all(ids.map((id, index) => move(id, {
      parentId: card.dataset.folderId,
      ...(settings.$.move_to_start && { index })
    })));
    document.dispatchEvent(new CustomEvent('vb-bookmarks-panel:close'));
    document.dispatchEvent(new CustomEvent('updateFolderList'));
    await this.#refreshBookmarks?.();
    Toast.show(ids.length === 1 ? '已移动 1 个书签' : `已移动 ${ids.length} 个书签`);
  }
}

export default FolderDock;
