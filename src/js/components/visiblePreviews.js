import { openPreviewCapture, VISIBLE_PREVIEW_PORT } from '../api/previewCapture';

// Only cards in the active bookmark viewport can schedule a background visit.
export function watchVisiblePreviews(grid, hasPreview) {
  const visible = new Set();
  const attempted = new WeakMap();
  let enabled = false;
  let manual = false;
  let job;
  let timer;
  const available = () => enabled && !manual && !document.hidden && document.hasFocus()
    && !document.querySelector('dialog[open]') && !grid.classList.contains('has-dragging');
  function eligible(card) {
    return visible.has(card) && card.isConnected && !card.hidden && !hasPreview(card.id)
      && /^https?:\/\//i.test(card.url) && attempted.get(card) !== card.url;
  }
  function schedule(ms = 600) {
    clearTimeout(timer);
    if (job && (!available() || !eligible(job.card) || job.card.url !== job.url)) job.port.close();
    if (!job && available()) timer = setTimeout(next, ms);
  }
  async function next() {
    if (job || !available()) return;
    const card = Array.from(visible).find(eligible);
    if (!card) return;
    const { id, url } = card;
    let port;
    let retry = 700;
    try {
      port = openPreviewCapture(VISIBLE_PREVIEW_PORT);
      job = { card, url, port };
      const status = await port.capture({ id, url });
      if (status === 'stopped') retry = 2500;
      else attempted.set(card, url);
    } catch {
      // A bookmark tab can outlive its extension context after an unpacked update.
      setEnabled(false);
    } finally {
      port?.close();
      job = undefined;
      schedule(retry);
    }
  }
  const viewport = new IntersectionObserver(entries => {
    for (const { target, intersectionRatio } of entries) {
      if (intersectionRatio >= .25 && target.isConnected) visible.add(target);
      else visible.delete(target);
    }
    schedule();
  }, { threshold: .25 });
  const watch = card => {
    if (card.matches?.('.bookmark')) viewport.observe(card);
  };
  const changes = new MutationObserver(records => {
    for (const record of records) {
      for (const card of record.removedNodes) {
        if (card.nodeType !== Node.ELEMENT_NODE) continue;
        visible.delete(card);
        viewport.unobserve(card);
      }
      record.addedNodes.forEach(watch);
    }
    schedule();
  });
  function setEnabled(value) {
    if (enabled === value) return;
    enabled = value;
    if (enabled) {
      Array.from(grid.children).forEach(watch);
      changes.observe(grid, { childList: true });
    } else {
      changes.disconnect();
      viewport.disconnect();
      visible.clear();
    }
    schedule();
  }
  window.addEventListener('focus', () => schedule());
  window.addEventListener('blur', () => schedule());
  document.addEventListener('visibilitychange', () => schedule());
  document.addEventListener('toggle', () => schedule(), true);
  document.addEventListener('close', () => schedule(), true);
  grid.addEventListener('thumbnails:updating', () => {
    manual = true;
    schedule();
  });
  grid.addEventListener('thumbnails:updated', () => {
    manual = false;
    schedule();
  });
  let preferenceChanged = false;
  browser.storage.onChanged.addListener((delta, area) => {
    if (area !== 'local' || !delta.autoFillMissingPreviews) return;
    preferenceChanged = true;
    setEnabled(delta.autoFillMissingPreviews.newValue === true);
  });
  browser.storage.local.get('autoFillMissingPreviews').then(value => {
    if (!preferenceChanged) setEnabled(value.autoFillMissingPreviews === true);
  }).catch(() => undefined);
}
