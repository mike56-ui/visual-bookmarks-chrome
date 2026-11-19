import Toast from './toast';

const actions = [];
let busy = false;

function notify() {
  document.dispatchEvent(new CustomEvent('bookmark-order-undo-state', {
    detail: { available: !busy && actions.length > 0 }
  }));
}

export function rememberOrderUndo(action) {
  actions.push(action);
  if (actions.length > 20) actions.shift();
  notify();
}

async function undoLatestOrder() {
  if (busy || !actions.length) return;
  const undo = actions.pop();
  busy = true;
  notify();
  try {
    await undo();
  } catch (error) {
    console.warn(error);
    Toast.show(document.documentElement.lang.startsWith('zh') ? '无法撤销排序。' : 'Could not undo the sort.');
  } finally {
    busy = false;
    notify();
  }
}

document.addEventListener('newtab:undo-order', undoLatestOrder);
document.addEventListener('keydown', event => {
  const isEditor = event.target.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
  const dialog = document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]:not([hidden])');
  if (event.defaultPrevented || event.isComposing || event.repeat || !(event.ctrlKey || event.metaKey)
    || event.shiftKey || event.altKey || event.key?.toLowerCase() !== 'z' || isEditor || busy || !actions.length
    || dialog || document.body.classList.contains('gmodal-open')
    || document.querySelector('#bookmarks.has-dragging')) return;
  event.preventDefault();
  undoLatestOrder();
});
