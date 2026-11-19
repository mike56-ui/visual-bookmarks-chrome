import { recordOpen } from './api/usage';

function trackOpen(event) {
  if (event.defaultPrevented || !event.isTrusted || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
  const card = event.target.closest('#bookmarks a.bookmark[href]');
  if (!card || event.target.closest('button, input') || card.hidden) return;
  const opensHere = event.button === 0 && !card.target && ['https:', 'http:'].includes(card.protocol);
  recordOpen(card.dataset.id, opensHere ? card.href : undefined);
}

document.addEventListener('click', event => {
  if (event.button === 0) trackOpen(event);
});
document.addEventListener('auxclick', event => {
  if (event.button === 1) trackOpen(event);
});
