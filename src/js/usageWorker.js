import { readUsage, USAGE_KEY } from './api/usage';

// One writer serializes simultaneous opens and bookmark removals from different tabs.
let pending = Promise.resolve();
function changeCounts(update) {
  const operation = pending.then(async() => {
    const counts = await readUsage();
    if (update(counts)) await browser.storage.local.set({ [USAGE_KEY]: counts });
  });
  pending = operation.catch(() => {});
  return operation;
}

browser.runtime.onMessage.addListener((message, sender, respond) => {
  const id = message?.bookmarkOpened;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id) || sender.tab?.incognito) return;
  const source = (sender.url || '').replace(/^extension:/, 'chrome-extension:').split(/[?#]/)[0];
  if (source !== browser.runtime.getURL('newtab.html')) return;
  changeCounts(counts => {
    counts[id] = (Number(counts[id]) || 0) + 1;
    return true;
  }).then(() => respond(true), () => respond(false));
  return true;
});

browser.bookmarks.onRemoved.addListener((id, removed) => {
  changeCounts(counts => {
    const stack = [removed.node];
    let changed = false;
    while (stack.length) {
      const node = stack.pop();
      if (Object.hasOwn(counts, node.id)) {
        delete counts[node.id];
        changed = true;
      }
      if (node.children) stack.push(...node.children);
    }
    return changed;
  }).catch(() => {});
});
