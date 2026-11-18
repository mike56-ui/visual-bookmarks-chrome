const BOOKMARK = ':scope > .bookmark[data-id]:not([hidden])';
const FOLDER = ':scope > .folder-card[data-folder-id]:not([hidden])';
const THRESHOLD = 6;
const EASE = 'cubic-bezier(.2,.78,.22,1)';

const translate = (x, y) => `translate3d(${x}px, ${y}px, 0)`;
const inside = (rect, x, y) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
const folderId = node => node.dataset.folderId;
const bookmarkId = node => node.dataset.id;

function originOf(list) {
  const rect = list.getBoundingClientRect();
  return { x: rect.left + list.clientLeft - list.scrollLeft, y: rect.top + list.clientTop - list.scrollTop };
}

function restSlot(node) {
  return { x: node.offsetLeft, y: node.offsetTop, w: node.offsetWidth, h: node.offsetHeight };
}

function slide(node, fromX, fromY, toX, toY, width) {
  const wraps = Math.abs(fromX - toX) > width * 1.35 && Math.abs(fromY - toY) > 20;
  if (!wraps) {
    return node.animate([{ transform: translate(fromX, fromY) }, { transform: translate(toX, toY) }],
      { duration: 175, easing: EASE });
  }
  // At a row boundary, let the card leave one edge and enter the next row.
  const edge = fromX > toX ? 12 : -12;
  return node.animate([
    { transform: translate(fromX, fromY), opacity: 1 },
    { offset: .46, transform: translate(fromX + edge, fromY), opacity: 0 },
    { offset: .47, transform: translate(toX - edge, toY), opacity: 0 },
    { transform: translate(toX, toY), opacity: 1 }
  ], { duration: 170, easing: EASE });
}

function nearestSlot(nodes, slots, origin, x, y, accepts) {
  let target = null;
  let distance = Infinity;
  for (const node of nodes) {
    if (!accepts(node)) continue;
    const { x: left, y: top, w, h } = slots.get(node);
    const dx = (x - origin.x - left) / w - .5;
    const dy = (y - origin.y - top) / h - .5;
    const score = dx * dx + dy * dy;
    if (score < distance) {
      target = node;
      distance = score;
    }
  }
  return target;
}

function subtreeOf(node, nodes) {
  const branch = new Set([folderId(node)]);
  return nodes.filter(candidate => {
    if (candidate === node || branch.has(candidate.dataset.folderParent)) {
      branch.add(folderId(candidate));
      return true;
    }
    return false;
  });
}

function insertedOrder(nodes, moving, target, after, tail = target) {
  const order = nodes.filter(node => !moving.has(node));
  const index = order.indexOf(after ? tail : target);
  if (index < 0) return nodes;
  order.splice(index + Number(after), 0, ...moving);
  return order;
}

function makeLift(source, count) {
  const lift = document.createElement('div');
  const surface = document.createElement('div');
  lift.className = 'motion-drag-lift';
  lift.inert = true;
  lift.setAttribute('aria-hidden', 'true');
  surface.className = source.matches('.folder-card') ? 'folder-card motion-drag-surface' : 'bookmark motion-drag-surface';
  surface.append(...[...source.children].filter(node =>
    !node.matches('button, input, .bookmark__overlay')).map(node => node.cloneNode(true)));
  for (const node of surface.querySelectorAll('[id], button, input, .dropzone-bookmark')) {
    if (node.matches('button, input, .dropzone-bookmark')) node.remove();
    else node.removeAttribute('id');
  }
  if (count > 1) {
    const badge = document.createElement('span');
    badge.className = 'motion-drag-count';
    badge.textContent = String(count);
    surface.append(badge);
  }
  lift.append(surface);
  return lift;
}

function scrollSpeed(position, start, end) {
  const margin = Math.min(56, (end - start) / 3);
  if (margin <= 0) return 0;
  if (position < start + margin) return -Math.ceil(16 * (start + margin - position) / margin);
  if (position > end - margin) return Math.ceil(16 * (position - end + margin) / margin);
  return 0;
}

export default function bindMotionDrag({
  grid, folderList, canDrag, canReorder, reorderBookmarks, moveBookmarks, reorderFolders
}) {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const app = grid.closest('.app') || document.scrollingElement;
  const capture = document.body;
  let gesture = null;
  let settling = false;
  let suppressClick = false;
  let scrollFrame = 0;
  let flight = null;
  const finalSlides = new Map();

  const bookmarkCards = () => [...grid.querySelectorAll(BOOKMARK)].filter(node => node.offsetWidth);
  const folderCards = () => [...folderList.querySelectorAll(FOLDER)].filter(node => node.offsetWidth);
  const listNodes = g => g.folder ? folderCards() : bookmarkCards();
  const allCards = () => [...folderCards(), ...bookmarkCards()];
  const keyOf = node => node.matches('.folder-card') ? 'f' + folderId(node) : 'b' + bookmarkId(node);
  const indexChanged = (first, second) => first.some((node, index) => second[index] !== node);

  function removeFlight() {
    if (!flight) return;
    const old = flight;
    flight = null;
    old.animation.cancel();
    old.lift.remove();
    old.receiver?.classList.remove('motion-drag-arriving');
  }

  function updateLayout(g) {
    const nodes = listNodes(g);
    if (!nodes.includes(g.node) || [...g.moving].some(node => !nodes.includes(node))) return false;
    g.nodes = nodes;
    g.slots = new Map(nodes.map(node => [node, restSlot(node)]));
    return true;
  }

  function start(g) {
    removeFlight();
    for (const effect of finalSlides.values()) effect.cancel();
    finalSlides.clear();
    capture.classList.add('motion-drag-active');
    grid.classList.add('has-dragging');
    const nodes = listNodes(g);
    g.moving = new Set(g.folder ? subtreeOf(g.node, nodes)
      : nodes.filter(node => node === g.node || g.node.hasAttribute('data-selected') && node.hasAttribute('data-selected')));
    if (!updateLayout(g)) {
      grid.classList.remove('has-dragging');
      capture.classList.remove('motion-drag-active');
      return false;
    }
    const rect = g.node.getBoundingClientRect();
    g.offsetX = g.startX - rect.left;
    g.offsetY = g.startY - rect.top;
    g.lift = makeLift(g.node, g.folder ? 1 : g.moving.size);
    g.lift.style.width = rect.width + 'px';
    g.lift.style.height = rect.height + 'px';
    g.markers = [...g.moving].map(node => {
      const marker = document.createElement('div');
      marker.className = 'motion-drag-slot';
      marker.setAttribute('aria-hidden', 'true');
      node.classList.add('motion-drag-held');
      capture.append(marker);
      return marker;
    });
    g.slides = new Map();
    g.shifted = new Map();
    capture.append(g.lift);
    g.active = true;
    capture.setPointerCapture(g.pointerId);
    suppressClick = true;
    return true;
  }

  function positionCards(g, order, origin, groupTarget) {
    let markerIndex = 0;
    for (const [index, node] of order.entries()) {
      const dest = g.slots.get(g.nodes[index]);
      if (g.moving.has(node)) {
        const marker = g.markers[markerIndex++];
        marker.hidden = groupTarget;
        Object.assign(marker.style, {
          width: dest.w + 'px', height: dest.h + 'px',
          transform: translate(origin.x + dest.x, origin.y + dest.y)
        });
        continue;
      }
      const from = g.slots.get(node);
      const x = dest.x - from.x;
      const y = dest.y - from.y;
      if ((g.shifted.get(node) || '0,0') === `${x},${y}`) continue;
      const displayed = node.getBoundingClientRect();
      const fromX = displayed.left - origin.x - from.x;
      const fromY = displayed.top - origin.y - from.y;
      g.slides.get(node)?.cancel();
      g.shifted.set(node, `${x},${y}`);
      node.classList.add('motion-drag-shifted');
      node.style.setProperty('--motion-drag-shift', translate(x, y));
      if (!reduced.matches && Math.abs(fromX - x) + Math.abs(fromY - y) > 1) {
        g.slides.set(node, slide(node, fromX, fromY, x, y, from.w));
      }
    }
  }

  function setReceive(g, folder) {
    if (g.receive === folder) return;
    g.receive?.classList.remove('motion-drag-receive');
    folder?.classList.add('motion-drag-receive');
    g.receive = folder;
  }

  function mouseTrack(g, x, y) {
    g.x = x;
    g.y = y;
    g.lift.style.transform = translate(x - g.offsetX, y - g.offsetY);
    const origin = originOf(g.list);
    const hit = document.elementFromPoint(x, y)?.closest('.folder-card[data-folder-id]');
    const receive = !g.folder && folderList.contains(hit) && !hit.hasAttribute('data-no-bookmark-drop')
      && [...g.moving].some(node => (node.parentId ?? node.dataset.parentId ?? grid.dataset.folder) !== folderId(hit))
      ? hit
      : null;
    setReceive(g, receive);
    let order = g.nodes;
    g.drop = null;
    if (receive) {
      g.drop = { destination: folderId(receive) };
    } else if (inside(g.list.getBoundingClientRect(), x, y)
      && inside((g.folder ? folderList : app).getBoundingClientRect(), x, y) && (g.folder || canReorder())) {
      const target = nearestSlot(g.nodes, g.slots, origin, x, y, node => {
        if (!g.folder) return true;
        const slot = g.slots.get(node);
        const localY = y - origin.y;
        return node.dataset.folderParent === g.node.dataset.folderParent && !node.hasAttribute('data-no-folder-reorder')
          && localY >= slot.y - 8 && localY <= slot.y + slot.h + 8;
      });
      if (target && !g.moving.has(target)) {
        const slot = g.slots.get(target);
        const ratio = g.folder ? (y - origin.y - slot.y) / slot.h : (x - origin.x - slot.x) / slot.w;
        const after = g.lastTarget === target && Math.abs(.5 - ratio) < .08 ? g.after : ratio >= .5;
        g.lastTarget = target;
        g.after = after;
        const tail = g.folder && after ? subtreeOf(target, g.nodes).at(-1) : target;
        order = insertedOrder(g.nodes, g.moving, target, after, tail);
        if (indexChanged(g.nodes, order)) g.drop = { target: g.folder ? folderId(target) : bookmarkId(target), after };
      }
    }
    positionCards(g, order, origin, !!receive);
  }

  function scrollWhileDragging() {
    scrollFrame = 0;
    const g = gesture;
    if (!g?.active) return;
    if (!g.node.isConnected || grid.hasAttribute('aria-busy') && !g.folder) {
      cancel();
      return;
    }
    const side = folderList.getBoundingClientRect();
    const main = app.getBoundingClientRect();
    const target = inside(side, g.x, g.y) ? folderList
      : !g.folder && inside(main, g.x, g.y) ? app : null;
    if (target) {
      const frame = target === folderList ? side : main;
      const speed = scrollSpeed(g.y, Math.max(0, frame.top), Math.min(window.innerHeight, frame.bottom));
      const previous = target.scrollTop;
      if (speed) target.scrollTop += speed;
      if (target.scrollTop !== previous) mouseTrack(g, g.x, g.y);
    }
    if (target) {
      const frame = target === folderList ? side : main;
      if (scrollSpeed(g.y, frame.top, frame.bottom)) scrollFrame = requestAnimationFrame(scrollWhileDragging);
    }
  }

  function release(g) {
    if (capture.hasPointerCapture(g.pointerId)) capture.releasePointerCapture(g.pointerId);
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
  }

  function clean(g) {
    setReceive(g, null);
    for (const anim of g.slides.values()) anim.cancel();
    for (const node of g.nodes) {
      node.classList.remove('motion-drag-held', 'motion-drag-shifted');
      node.style.removeProperty('--motion-drag-shift');
    }
    for (const marker of g.markers) marker.remove();
    grid.classList.remove('has-dragging');
    capture.classList.remove('motion-drag-active');
  }

  function settleOthers(previous, sourceKey) {
    if (reduced.matches) return;
    for (const node of allCards()) {
      const key = keyOf(node), old = previous.get(key);
      if (!old || key === sourceKey) continue;
      const next = node.getBoundingClientRect();
      const x = old.left - next.left, y = old.top - next.top;
      if (Math.abs(x) + Math.abs(y) > 1) {
        const animation = slide(node, x, y, 0, 0, next.width);
        finalSlides.set(node, animation);
        animation.finished.catch(() => {}).then(() => {
          if (finalSlides.get(node) === animation) finalSlides.delete(node);
        });
      }
    }
  }

  async function finish(g, commit) {
    const drop = commit && g.drop;
    const sourceKey = keyOf(g.node);
    const previous = new Map(allCards().map(node => [keyOf(node), node.getBoundingClientRect()]));
    const start = g.lift.getBoundingClientRect();
    gesture = null;
    settling = true;
    release(g);
    let accepted = false;
    try {
      const ids = [...g.moving].map(bookmarkId);
      if (drop?.destination) accepted = await moveBookmarks(ids, drop.destination);
      else if (drop?.target) {
        accepted = g.folder
          ? await reorderFolders(folderId(g.node), drop.target, drop.after)
          : await reorderBookmarks(ids, drop.target, drop.after);
      }
    } catch (error) {
      console.warn(error);
    } finally {
      clean(g);
      settling = false;
    }
    const cross = accepted && drop?.destination;
    let receiver;
    if (cross) {
      const folder = folderCards().find(node => folderId(node) === drop.destination);
      const id = CSS.escape(bookmarkId(g.node));
      receiver = folder?.querySelector(`[data-bookmark-id="${id}"] .site-icon__image:not([hidden])`)
        || folder?.querySelector('.folder-card__preview');
    } else {
      receiver = allCards().find(node => keyOf(node) === sourceKey);
    }
    const end = receiver?.getBoundingClientRect();
    settleOthers(previous, sourceKey);
    if (reduced.matches || !end?.width || !end.height) {
      g.lift.remove();
      return;
    }
    const scale = cross ? Math.min(end.width / start.width, end.height / start.height, .32) : 1;
    const left = end.left + (end.width - start.width * scale) / 2;
    const top = end.top + (end.height - start.height * scale) / 2;
    const session = { lift: g.lift, receiver: cross ? null : receiver };
    session.receiver?.classList.add('motion-drag-arriving');
    session.animation = g.lift.animate([
      { transform: translate(start.left, start.top), opacity: 1 },
      { transform: translate(left, top) + ` scale(${scale})`, opacity: cross ? .12 : 1 }
    ], { duration: cross ? 185 : 150, easing: EASE, fill: 'forwards' });
    flight = session;
    session.animation.finished.catch(() => {}).then(() => {
      if (flight === session) removeFlight();
    });
  }

  function cancel() {
    const g = gesture;
    gesture = null;
    if (g?.active) {
      release(g);
      clean(g);
      g.lift.remove();
    }
    removeFlight();
  }

  // Pointer input owns the desktop gesture. Keep the existing non-mouse drag
  // handlers available, but never let the native mouse drag run alongside it.
  document.addEventListener('dragstart', event => {
    if (!gesture) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    suppressClick = false;
    if (!event.isPrimary || event.pointerType !== 'mouse' || gesture || settling || !canDrag()) return;
    if (event.altKey ||
      event.target.closest('input, textarea, .bookmark__delete, .folder-card__delete, .folder-card__rename-button')) return;
    const leftNode = event.target.closest('.folder-card[data-folder-id]');
    const rightNode = event.target.closest('.bookmark[data-id]');
    const folder = folderList.contains(leftNode);
    const node = folder ? leftNode : grid.contains(rightNode) ? rightNode : null;
    if (!node || node.hidden || (folder
      ? node.hasAttribute('data-no-folder-reorder') || !node.hasAttribute('data-folder-parent')
      : node.classList.contains('disable-events') || grid.hasAttribute('aria-busy'))) return;
    gesture = {
      node, folder, list: folder ? folderList : grid, pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY, active: false
    };
  }, true);
  document.addEventListener('pointermove', event => {
    const g = gesture;
    if (!g || g.pointerId !== event.pointerId) return;
    if (!(event.buttons & 1) || !g.node.isConnected) {
      cancel();
      return;
    }
    if (!g.active) {
      if (Math.hypot(event.clientX - g.startX, event.clientY - g.startY) < THRESHOLD) return;
      if (!start(g)) {
        cancel();
        return;
      }
    }
    event.preventDefault();
    mouseTrack(g, event.clientX, event.clientY);
    if (!scrollFrame) scrollFrame = requestAnimationFrame(scrollWhileDragging);
  }, { passive: false });
  document.addEventListener('pointerup', event => {
    const g = gesture;
    if (!g || g.pointerId !== event.pointerId || event.button !== 0) return;
    if (!g.active) {
      gesture = null;
      return;
    }
    mouseTrack(g, event.clientX, event.clientY);
    finish(g, true);
  }, true);
  document.addEventListener('click', event => {
    if (!event.isTrusted || !event.detail || !suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !gesture) return;
    event.preventDefault();
    const g = gesture;
    if (g.active) {
      event.stopPropagation();
      finish(g, false);
    } else {
      cancel();
    }
  }, true);
  const pointerLost = event => {
    if (gesture?.pointerId === event.pointerId) cancel();
  };
  document.addEventListener('pointercancel', pointerLost);
  capture.addEventListener('lostpointercapture', pointerLost);
  window.addEventListener('blur', cancel);
  window.addEventListener('resize', cancel);
  document.addEventListener('scroll', () => {
    const g = gesture;
    if (g?.active) mouseTrack(g, g.x, g.y);
  }, true);
  const observer = new MutationObserver(() => {
    const g = gesture;
    if (!g?.active) return;
    if (!updateLayout(g)) cancel();
    else mouseTrack(g, g.x, g.y);
  });
  observer.observe(grid, { childList: true });
  observer.observe(folderList, { childList: true });
}
