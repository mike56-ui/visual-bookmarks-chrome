import { recordOpen } from './api/usage';

function trackOpen(event) {
  if (event.defaultPrevented || !event.isTrusted || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
  const card = event.target.closest('#bookmarks a.bookmark[href]');
  if (!card || event.target.closest('button, input') || card.hidden) return;
  recordOpen(card.dataset.id);
}

document.addEventListener('click', event => {
  if (event.button === 0) trackOpen(event);
});
document.addEventListener('auxclick', event => {
  if (event.button === 1) trackOpen(event);
});
