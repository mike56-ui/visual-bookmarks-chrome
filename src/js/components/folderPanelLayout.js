const POSITION_KEY = 'visual-bookmarks-folder-panel';
const MARGIN = 16;
const SNAP_DISTANCE = 38;
const DEFAULT_WIDTH = 268;
const DEFAULT_HEIGHT = 580;
const MAX_SIDE_WIDTH = 460;
const GEOMETRY = ['x', 'y', 'width', 'height'];
const SIDES = ['left', 'right', 'top', 'bottom'];

function readPosition() {
  try {
    const state = JSON.parse(localStorage.getItem(POSITION_KEY));
    return state && GEOMETRY.every(key => Number.isFinite(state[key])) ? state : null;
  } catch {
    return null;
  }
}

function isChinese() {
  return document.documentElement.lang.startsWith('zh');
}

function isHorizontal(side) {
  return side === 'top' || side === 'bottom';
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function viewport() {
  return { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
}

function sizeLimits(horizontal, view) {
  const maxWidth = horizontal ? view.width - MARGIN * 2 : Math.min(MAX_SIDE_WIDTH, view.width - 360);
  const maxHeight = horizontal ? Math.floor(view.height * 0.48) : view.height - MARGIN * 2;
  return { minWidth: 220, maxWidth, minHeight: horizontal ? 148 : 220, maxHeight };
}

function closerSide(offset, length, available, first, last, previous) {
  const balance = 2 * offset + length - available;
  if (!balance && previous === last) return last;
  return balance > 0 ? last : first;
}

// Fit restored coordinates before deciding which side has room for the bookmarks.
function fit(rect, side, view) {
  const limits = sizeLimits(isHorizontal(side), view);
  const width = clamp(rect.width, limits.minWidth, limits.maxWidth);
  const height = clamp(rect.height, limits.minHeight, limits.maxHeight);
  const x = clamp(rect.x, MARGIN, view.width - width - MARGIN);
  const y = clamp(rect.y, MARGIN, view.height - height - MARGIN);
  const dock = isHorizontal(side) ? closerSide(y, height, view.height, 'top', 'bottom', side) :
    closerSide(x, width, view.width, 'left', 'right', side);
  return { x, y, width, height, dock };
}

// Move the selected edge only. Once it reaches its limit the opposite edge stays fixed.
function resizeRect(rect, edge, dx, dy, view) {
  const { minWidth, maxWidth, minHeight, maxHeight } = sizeLimits(isHorizontal(rect.dock), view);
  let { x, y, width, height } = rect;
  if (edge.includes('w')) {
    width = clamp(width - dx, minWidth, Math.min(maxWidth, x + width - MARGIN));
    x += rect.width - width;
  }
  if (edge.includes('e')) width = clamp(width + dx, minWidth, Math.min(maxWidth, view.width - x - MARGIN));
  if (edge.includes('n')) {
    height = clamp(height - dy, minHeight, Math.min(maxHeight, y + height - MARGIN));
    y += rect.height - height;
  }
  if (edge.includes('s')) height = clamp(height + dy, minHeight, Math.min(maxHeight, view.height - y - MARGIN));
  return fit({ x, y, width, height }, rect.dock, view);
}

export default function setupFolderPanelLayout(panel) {
  const toggle = document.getElementById('folderDockToggle');
  const narrow = window.matchMedia('(max-width: 700px), (max-height: 395px)');
  let saved = readPosition();
  let position;
  let cancelDrag;

  function render(rect, view) {
    position = rect;
    const { x, y, width, height, dock } = rect;
    panel.dataset.dock = document.body.dataset.folderDock = dock;
    for (const key of GEOMETRY) panel.style.setProperty(`--panel-${key}`, `${rect[key]}px`);
    const distance = { left: x + width, right: view.width - x, top: y + height, bottom: view.height - y };
    for (const side of SIDES) {
      document.body.style.setProperty(`--folder-dock-${side}`, side === dock ? `${distance[side] + MARGIN}px` : '0px');
    }
  }

  function restore() {
    if (narrow.matches) {
      panel.dataset.dock = document.body.dataset.folderDock = 'left';
      for (const key of GEOMETRY) panel.style.removeProperty(`--panel-${key}`);
      for (const side of SIDES) document.body.style.removeProperty(`--folder-dock-${side}`);
      return;
    }
    const view = viewport();
    const desired = saved ?? { x: MARGIN, y: MARGIN, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
    const rect = { ...desired };
    // Old installations have absolute coordinates only. Newly saved right/bottom docks remember their edge distance.
    if (Number.isFinite(desired.right)) {
      if (isHorizontal(desired.dock)) {
        rect.width = view.width - desired.x - desired.right;
      } else {
        const limits = sizeLimits(false, view);
        rect.width = clamp(rect.width, limits.minWidth, limits.maxWidth);
        const freeWidth = view.width - rect.width;
        rect.x = desired.dock === 'right' ? Math.max(freeWidth / 2, freeWidth - desired.right) :
          Math.min(freeWidth / 2, rect.x);
      }
    }
    if (isHorizontal(desired.dock) && Number.isFinite(desired.bottom)) {
      const limits = sizeLimits(true, view);
      rect.height = clamp(rect.height, limits.minHeight, limits.maxHeight);
      const freeHeight = view.height - rect.height;
      rect.y = desired.dock === 'bottom' ? Math.max(freeHeight / 2, freeHeight - desired.bottom) :
        Math.min(freeHeight / 2, rect.y);
    }
    render(fit(rect, desired.dock, view), view);
    if (saved && !SIDES.includes(saved.dock)) persist();
  }

  function persist() {
    const view = viewport();
    const { x, y, width, height, dock } = position;
    const right = view.width - x - width;
    const bottom = view.height - y - height;
    const vertical = isHorizontal(dock) ? saved?.vertical : { width, height };
    const rail = isHorizontal(dock) ? { x, right, height } : saved?.rail;
    saved = { ...position, right, bottom, vertical, rail };
    try {
      localStorage.setItem(POSITION_KEY, JSON.stringify(saved));
    } catch {
      // The current tab can still use its layout if storage is unavailable.
    }
  }

  function dockTo(side, view, origin) {
    if (isHorizontal(side)) {
      const rail = saved?.rail;
      const x = Number.isFinite(rail?.x) ? rail.x : MARGIN;
      const right = Number.isFinite(rail?.right) ? rail.right : MARGIN;
      const height = clamp(rail?.height || 220, 148, sizeLimits(true, view).maxHeight);
      const y = side === 'top' ? MARGIN : view.height - MARGIN - height;
      return fit({ x, y, width: view.width - x - right, height }, side, view);
    }
    const size = isHorizontal(origin.dock) ? saved?.vertical : origin;
    const limits = sizeLimits(false, view);
    const width = clamp(size?.width || DEFAULT_WIDTH, limits.minWidth, limits.maxWidth);
    const height = size?.height || DEFAULT_HEIGHT;
    const x = side === 'left' ? MARGIN : view.width - width - MARGIN;
    return fit({ x, y: origin.y, width, height }, side, view);
  }

  function moveRect(origin, start, point, commit, view) {
    const dx = point.x - start.x;
    const dy = point.y - start.y;
    const central = point.x > view.width * 0.23 && point.x < view.width * 0.77;
    let snap;
    if (central && point.y <= SNAP_DISTANCE) snap = 'top';
    if (central && point.y >= view.height - SNAP_DISTANCE) snap = 'bottom';
    if (snap) {
      panel.dataset.snap = snap;
      if (commit) return dockTo(snap, view, origin);
    } else {
      delete panel.dataset.snap;
    }

    const horizontal = isHorizontal(origin.dock);
    if (horizontal && central && Math.abs(dy) < SNAP_DISTANCE) {
      return fit({ ...origin, x: origin.x + dx, y: origin.y + dy }, origin.dock, view);
    }
    const size = horizontal ? saved?.vertical : origin;
    const width = size?.width || DEFAULT_WIDTH;
    const height = size?.height || DEFAULT_HEIGHT;
    // The handle is centered horizontally in both layouts and sits at the same offset below the top.
    const x = point.x - (start.x - origin.x - origin.width / 2) - width / 2;
    const y = origin.y + dy;
    return fit({ x, y, width, height }, 'left', view);
  }

  function dragHandle(handle, edge) {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || cancelDrag || narrow.matches) return;
      event.preventDefault();
      const origin = position;
      const start = { x: event.clientX, y: event.clientY };
      const controller = new AbortController();
      const finish = () => {
        controller.abort();
        cancelDrag = undefined;
        delete panel.dataset.snap;
        panel.classList.remove('is-moving');
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      };
      cancelDrag = () => {
        finish();
        restore();
      };
      handle.setPointerCapture(event.pointerId);
      panel.classList.add('is-moving');
      let moved = false;
      const update = current => {
        const view = viewport();
        const point = { x: current.clientX, y: current.clientY };
        const dx = point.x - start.x;
        const dy = point.y - start.y;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        const rect = edge ? resizeRect(origin, edge, dx, dy, view) :
          moveRect(origin, start, point, current.type === 'pointerup', view);
        render(rect, view);
      };
      const track = current => {
        if (current.pointerId !== event.pointerId) return;
        if (current.type === 'pointermove') {
          update(current);
        } else if (current.type === 'pointerup') {
          update(current);
          finish();
          if (moved) persist();
        } else {
          cancelDrag();
        }
      };
      for (const type of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
        handle.addEventListener(type, track, { signal: controller.signal });
      }
    });

    handle.addEventListener('keydown', event => {
      const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const direction = directions[event.key];
      if (!direction || narrow.matches || cancelDrag) return;
      event.preventDefault();
      const view = viewport();
      const step = event.shiftKey ? 32 : 12;
      const [dx, dy] = direction.map(value => value * step);
      if (!edge && event.altKey) {
        const sides = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom' };
        render(dockTo(sides[event.key], view, position), view);
      } else if (edge) {
        render(resizeRect(position, edge, dx, dy, view), view);
      } else {
        render(fit({ ...position, x: position.x + dx, y: position.y + dy }, position.dock, view), view);
      }
      persist();
    });
  }

  const move = document.getElementById('folderDockHandle');
  const resize = document.getElementById('folderDockResize');
  if (isChinese()) {
    move.setAttribute('aria-label', '移动文件夹面板');
    resize.setAttribute('aria-label', '调整文件夹面板大小');
    resize.title = '拖动或使用方向键调整大小';
  }
  move.title = isChinese() ? '拖动或使用方向键移动，Alt + 方向键停靠' : 'Drag or use arrow keys; Alt + arrow to dock';
  dragHandle(move);
  for (const grip of panel.querySelectorAll('.folder-dock__resize')) {
    dragHandle(grip, grip.dataset.resizeEdge || 'se');
  }

  function reset() {
    cancelDrag?.();
    saved = null;
    localStorage.removeItem(POSITION_KEY);
    restore();
  }
  const closePanel = (focus = false) => {
    if (!narrow.matches || !panel.classList.contains('is-open')) return;
    panel.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    if (focus) toggle.focus();
  };
  toggle.setAttribute('aria-label', isChinese() ? '文件夹' : 'Folders');
  const updateMode = () => {
    cancelDrag?.();
    toggle.hidden = !narrow.matches;
    panel.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    restore();
  };
  updateMode();
  narrow.addEventListener('change', updateMode);
  window.addEventListener('resize', () => {
    if (cancelDrag) cancelDrag();
    else restore();
  });
  toggle.addEventListener('click', () => {
    if (panel.classList.contains('is-open')) {
      closePanel(true);
      return;
    }
    panel.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
    panel.querySelector('.is-active .folder-card__open, .folder-card__open')?.focus();
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
  document.addEventListener('newtab:reset-panel', reset);
  return () => closePanel(panel.contains(document.activeElement));
}
