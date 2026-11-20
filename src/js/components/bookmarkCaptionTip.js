import { $createElement } from '../utils';

function readableAddress(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    if (['data:', 'javascript:'].includes(url.protocol)) return url.protocol;
    return url.href;
  } catch {
    return '';
  }
}

export function bindBookmarkCaptionTip(container) {
  const selector = '.bookmark:not([is-folder])';
  const scrollport = container.closest('.app') || document.documentElement;
  const title = $createElement('div', { class: 'bookmark-caption-tip__title', dir: 'auto' });
  const address = $createElement('div', { class: 'bookmark-caption-tip__url', dir: 'ltr' });
  const tip = $createElement('div', {
    id: 'bookmarkCaptionTip', class: 'bookmark-caption-tip', role: 'tooltip', 'aria-hidden': 'true'
  }, title, address);
  document.body.append(tip);
  let card;
  let openTimer;
  let closeTimer;

  function hide() {
    if (!card) return;
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    observer.disconnect();
    const remaining = (card.getAttribute('aria-describedby') || '').split(/\s+/)
      .filter(id => id && id !== tip.id).join(' ');
    if (remaining) card.setAttribute('aria-describedby', remaining);
    else card.removeAttribute('aria-describedby');
    card = null;
    tip.classList.remove('is-visible');
    tip.setAttribute('aria-hidden', 'true');
  }

  function available() {
    return card?.isConnected && !card.hidden && !card.hasOverlay && !container.classList.contains('has-dragging')
      && !container.querySelector('[data-selected]') && !document.querySelector('.context-menu--open');
  }

  function position(anchor) {
    const rect = anchor.getBoundingClientRect();
    const frame = scrollport.getBoundingClientRect();
    const margin = 10;
    const gap = 6;
    const below = frame.bottom - rect.bottom - gap - margin;
    const above = rect.top - frame.top - gap - margin;
    tip.style.setProperty('--caption-available-width', Math.max(1, scrollport.clientWidth - 2 * margin) + 'px');
    tip.style.maxHeight = '';
    const flip = tip.offsetHeight > below && above > below;
    tip.style.maxHeight = Math.max(1, Math.min(tip.offsetHeight, flip ? above : below)) + 'px';
    const centered = (rect.left + rect.right - tip.offsetWidth) / 2;
    const right = frame.left + scrollport.clientWidth - tip.offsetWidth - margin;
    tip.style.left = Math.round(Math.max(frame.left + margin, Math.min(centered, right))) + 'px';
    tip.style.top = Math.round(flip ? rect.top - gap - tip.offsetHeight : rect.bottom + gap) + 'px';
    tip.classList.toggle('is-above', flip);
  }

  function show() {
    if (!available()) return hide();
    const anchor = card.querySelector('.bookmark__caption');
    if (!anchor?.getClientRects().length) return hide();
    address.textContent = readableAddress(card.url);
    title.textContent = card.title || '';
    title.hidden = !title.textContent;
    address.hidden = !address.textContent || address.textContent === title.textContent;
    if (title.hidden && address.hidden) return hide();
    position(anchor);
    const ids = (card.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    if (!ids.includes(tip.id)) card.setAttribute('aria-describedby', [...ids, tip.id].join(' '));
    tip.setAttribute('aria-hidden', 'false');
    tip.classList.add('is-visible');
    observer.observe(container, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['title', 'href', 'hidden', 'data-selected', 'has-overlay']
    });
  }

  // Native bookmark edits and folder changes can reuse or detach the focused card.
  const observer = new MutationObserver(records => {
    if (!available()) hide();
    else if (records.some(record => record.target === card)) show();
  });

  function request(next, delay) {
    clearTimeout(closeTimer);
    if (!next || (card === next && tip.classList.contains('is-visible'))) return;
    hide();
    card = next;
    if (delay) openTimer = setTimeout(show, delay);
    else show();
  }

  function caption(target) {
    return target instanceof Element ? target.closest('.bookmark__caption') : null;
  }

  function leave() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    // Give the pointer time to cross the narrow gap to the selectable tooltip.
    if (card !== document.activeElement || !card?.matches(':focus-visible')) closeTimer = setTimeout(hide, 180);
  }

  container.addEventListener('pointerover', event => {
    if (event.pointerType !== 'mouse' || event.buttons || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const anchor = caption(event.target);
    if (anchor && anchor !== caption(event.relatedTarget)) request(anchor.closest(selector), 260);
  });
  container.addEventListener('pointerout', event => {
    const anchor = caption(event.target);
    if (anchor && anchor !== caption(event.relatedTarget) && !tip.contains(event.relatedTarget)) leave();
  });
  tip.addEventListener('pointerenter', () => clearTimeout(closeTimer));
  tip.addEventListener('pointerleave', leave);
  container.addEventListener('focusin', event => {
    if (event.target.matches(selector + ':focus-visible')) request(event.target, 0);
  });
  container.addEventListener('focusout', event => {
    if (event.target === card && !tip.matches(':hover')) hide();
  });

  function dismissOutside(event) {
    if (!tip.contains(event.target)) hide();
  }
  document.addEventListener('pointerdown', dismissOutside, true);
  document.addEventListener('scroll', dismissOutside, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' || event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) hide();
  });
  document.addEventListener('contextmenu', dismissOutside, true);
  container.addEventListener('dragstart', hide);
  window.addEventListener('resize', hide);
  window.addEventListener('blur', hide);
  document.addEventListener('visibilitychange', hide);
}
