export const FOLDER_DOCK_ORDER_KEY = 'folderDockOrder';
export const bookmarkOrderKey = folderId => 'bookmarkOrder:' + folderId;
export const withOrganizationLock = task => navigator.locks.request('visual-bookmarks-organize', task);

export function sameOrder(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}
export function restoreOrder(ids, saved) {
  if (!Array.isArray(saved)) return ids;
  const available = new Set(ids);
  const ordered = saved.filter(id => available.delete(id));
  return ordered.concat([...available]);
}

export function orderAround(ids, selected, target, after) {
  const picked = new Set(selected);
  if (picked.has(target)) return null;
  const remaining = ids.filter(id => !picked.has(id));
  const index = remaining.indexOf(target);
  const moved = ids.filter(id => picked.has(id));
  if (index < 0 || !moved.length) return null;
  remaining.splice(index + Number(after), 0, ...moved);
  return remaining;
}

// Simulate Chromium's insertion indexes. Restrict synchronization to a small
// set of dragged rows whose moves never cross an unrendered native node.
export function planNativeOrder(before, after, selected, barriers) {
  const current = [...before];
  const moves = [];
  const picked = new Set(selected);
  for (let index = after.length - 1; index >= 0; index--) {
    const id = after[index];
    if (!picked.has(id)) continue;
    const from = current.indexOf(id);
    const anchor = after[index + 1];
    const insertion = anchor === undefined ? current.length : current.indexOf(anchor);
    if (from < 0 || insertion < 0) return null;
    const to = insertion - Number(from < insertion);
    if (from === to) continue;
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    if (current.slice(start, end + 1).some(node => barriers.has(node)) || moves.length === 24) return null;
    moves.push({ id, from, to, insertion });
    current.splice(from, 1);
    current.splice(to, 0, id);
  }
  return sameOrder(current, after) ? moves : null;
}
