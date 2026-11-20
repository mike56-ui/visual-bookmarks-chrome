// Move only the nodes whose positions changed. Keep live media, focus and
// custom element state when the browser supports state-preserving DOM moves.
export function reconcileChildren(parent, order) {
  const previous = [...parent.children];
  if (previous.length === order.length && previous.every((node, index) => order[index] === node)) return;
  parent.dispatchEvent(new Event('bookmark-list-before-reconcile', { bubbles: true }));
  const retained = new Set(order);
  for (const child of previous) {
    if (!retained.has(child)) child.remove();
  }

  let cursor = parent.firstElementChild;
  for (const node of order) {
    if (node === cursor) {
      cursor = cursor.nextElementSibling;
    } else if (node.parentElement === parent && typeof parent.moveBefore === 'function') {
      parent.moveBefore(node, cursor);
    } else {
      parent.insertBefore(node, cursor);
    }
  }
  parent.dispatchEvent(new Event('bookmark-list-after-reconcile', { bubbles: true }));
}
