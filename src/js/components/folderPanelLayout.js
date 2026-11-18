import { containsPermissions, requestPermissions } from '../api/permissions';
import { storage } from '../api/storage';
import Toast from './toast';

const POSITION_KEY = 'visual-bookmarks-folder-panel';
const MARGIN = 16;
const DEFAULT_WIDTH = 268;
const TOOLBAR_CLEARANCE = 72;
const MIN_WIDTH = 220;
const MIN_HEIGHT = 220;
const MAX_WIDTH = 460;

function readPosition() {
  try {
    const state = JSON.parse(localStorage.getItem(POSITION_KEY));
    return state && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(state[key])) ? state : null;
  } catch {
    return null;
  }
}

function isChinese() {
  return document.documentElement.lang.startsWith('zh');
}

function setupActions(resetPanel) {
  const actions = document.getElementById('newtabActions');
  const toggle = document.getElementById('newtabActionsToggle');
  const list = document.getElementById('newtabActionsList');
  const optIn = document.getElementById('visitPreviewEnabled');
  const reset = list.querySelector('[data-newtab-action="reset"]');
  const restoreOrder = list.querySelector('[data-newtab-action="common-order"]');
  const close = focus => {
    if (list.hidden) return;
    list.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (focus) toggle.focus();
  };

  if (isChinese()) {
    toggle.setAttribute('aria-label', '更多操作');
    toggle.title = '更多操作';
    document.getElementById('visitPreviewLabel').textContent = '访问时更新预览';
    reset.textContent = '复位文件夹面板';
    restoreOrder.textContent = '恢复常用排序';
  }
  toggle.addEventListener('click', () => {
    if (!list.hidden) {
      close(false);
    } else {
      list.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
    }
  });
  document.addEventListener('pointerdown', event => {
    if (!actions.contains(event.target)) close(false);
  });
  actions.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !list.hidden) {
      event.stopPropagation();
      close(true);
    }
  });
  list.querySelector('[data-newtab-action="add"]').addEventListener('click', () => {
    close(true);
    document.dispatchEvent(new Event('newtab:add-bookmark'));
  });
  reset.addEventListener('click', () => {
    resetPanel();
    close(true);
  });
  restoreOrder.addEventListener('click', () => {
    close(true);
    document.dispatchEvent(new Event('newtab:restore-common-order'));
  });
  document.addEventListener('bookmark-order-mode', event => {
    restoreOrder.hidden = event.detail.mode !== 'manual';
  });

  const origins = ['<all_urls>'];
  const sync = async() => {
    const { visitPreviewEnabled } = await storage.local.get('visitPreviewEnabled');
    optIn.checked = Boolean(visitPreviewEnabled && await containsPermissions({ origins }));
  };
  sync().catch(() => { optIn.checked = false; });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.visitPreviewEnabled) sync().catch(() => { optIn.checked = false; });
  });
  browser.permissions.onRemoved?.addListener(() => sync().catch(() => { optIn.checked = false; }));
  optIn.addEventListener('change', async() => {
    optIn.disabled = true;
    try {
      const enabled = optIn.checked && await requestPermissions({ origins });
      await storage.local.set({ visitPreviewEnabled: enabled });
      optIn.checked = enabled;
    } catch {
      await sync().catch(() => { optIn.checked = false; });
      Toast.show(isChinese() ? '无法更改预览设置，请重试。' : 'Could not change the preview setting. Try again.');
    } finally {
      optIn.disabled = false;
    }
  });
}

export default function setupFolderPanelLayout(panel) {
  const toggle = document.getElementById('folderDockToggle');
  const narrow = window.matchMedia('(max-width: 700px), (max-height: 395px)');
  let requested = readPosition();
  let position;
  let pointerActive = false;

  const apply = () => {
    const viewport = document.documentElement;
    const defaults = {
      x: MARGIN,
      y: MARGIN,
      width: DEFAULT_WIDTH,
      height: Math.min(580, viewport.clientHeight - MARGIN * 2)
    };
    const desired = requested ?? defaults;
    const alignedLeft = !requested || (desired.x <= MARGIN + 8 && desired.y <= MARGIN + 8);
    const width = Math.min(Math.max(MIN_WIDTH, desired.width), MAX_WIDTH, Math.max(1, viewport.clientWidth - (alignedLeft && !narrow.matches ? 355 : MARGIN * 2)));
    const top = alignedLeft ? MARGIN : TOOLBAR_CLEARANCE;
    const height = Math.min(Math.max(MIN_HEIGHT, desired.height), Math.max(1, viewport.clientHeight - top - MARGIN));
    const x = alignedLeft ? MARGIN : Math.min(Math.max(MARGIN, desired.x), viewport.clientWidth - width - MARGIN);
    const y = alignedLeft ? MARGIN : Math.min(Math.max(top, desired.y), viewport.clientHeight - height - MARGIN);
    position = { x, y, width, height };

    for (const [key, value] of Object.entries(position)) {
      panel.style.setProperty(`--panel-${key}`, `${value}px`);
    }
    document.body.style.setProperty('--folder-dock-reserved', alignedLeft ? `${width + MARGIN * 2}px` : '0px');
  };

  const reset = () => {
    requested = null;
    localStorage.removeItem(POSITION_KEY);
    apply();
  };
  const persist = () => localStorage.setItem(POSITION_KEY, JSON.stringify(position));
  const closePanel = (focus = false) => {
    if (!narrow.matches || !panel.classList.contains('is-open')) return;
    panel.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    if (focus) toggle.focus();
  };
  const adjust = (resize, origin, dx, dy) => {
    if (resize) {
      requested = { ...origin, width: origin.width + dx, height: origin.height + dy };
    } else {
      requested = { ...origin, x: origin.x + dx, y: origin.y + dy };
    }
    apply();
  };

  function dragHandle(handle, resize) {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || pointerActive || narrow.matches) return;
      event.preventDefault();
      pointerActive = true;
      const origin = position;
      const previous = requested;
      const controller = new AbortController();
      handle.setPointerCapture(event.pointerId);
      panel.classList.add('is-moving');
      let moved = false;
      const stop = current => {
        if (current.pointerId !== event.pointerId) return;
        controller.abort();
        pointerActive = false;
        panel.classList.remove('is-moving');
        if (handle.hasPointerCapture(current.pointerId)) handle.releasePointerCapture(current.pointerId);
        if (current.type !== 'pointerup') {
          requested = previous;
          apply();
        } else if (moved) {
          requested = position;
          persist();
        }
      };
      handle.addEventListener('pointermove', current => {
        if (current.pointerId !== event.pointerId) return;
        const dx = current.clientX - event.clientX;
        const dy = current.clientY - event.clientY;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        adjust(resize, origin, dx, dy);
      }, { signal: controller.signal });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        handle.addEventListener(type, stop, { signal: controller.signal });
      }
    });
    handle.addEventListener('keydown', event => {
      const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const direction = directions[event.key];
      if (!direction || narrow.matches) return;
      event.preventDefault();
      const step = event.shiftKey ? 32 : 12;
      adjust(resize, position, direction[0] * step, direction[1] * step);
      requested = position;
      persist();
    });
  }

  if (isChinese()) {
    const move = document.getElementById('folderDockHandle');
    const resize = document.getElementById('folderDockResize');
    move.setAttribute('aria-label', '移动文件夹面板');
    move.title = '拖动或使用方向键移动';
    resize.setAttribute('aria-label', '调整文件夹面板大小');
    resize.title = '拖动或使用方向键调整大小';
  }
  toggle.setAttribute('aria-label', isChinese() ? '文件夹' : 'Folders');
  const updateMode = () => {
    toggle.hidden = !narrow.matches;
    panel.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    apply();
  };
  updateMode();
  narrow.addEventListener('change', updateMode);
  window.addEventListener('resize', apply);
  toggle.addEventListener('click', () => {
    if (panel.classList.contains('is-open')) {
      closePanel(true);
      return;
    }
    panel.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
    panel.querySelector('.is-active .folder-card__open, .folder-card__open')?.focus();
  });
  document.addEventListener('pointerdown', event => {
    if (!panel.contains(event.target) && !toggle.contains(event.target)) closePanel(panel.contains(document.activeElement));
  });
  window.addEventListener('hashchange', () => closePanel(panel.contains(document.activeElement)));
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented) closePanel(true);
  });
  const grid = document.getElementById('bookmarks');
  grid.addEventListener('keydown', event => {
    if (!event.target.matches('a.bookmark') || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
    if (!offset) return;
    const cards = [...grid.querySelectorAll('a.bookmark:not([hidden])')];
    const next = cards[cards.indexOf(event.target) + offset];
    if (!next) return;
    event.preventDefault();
    next.focus();
  });
  dragHandle(document.getElementById('folderDockHandle'), false);
  dragHandle(document.getElementById('folderDockResize'), true);
  setupActions(reset);
  return () => closePanel(panel.contains(document.activeElement));
}
