export const USAGE_KEY = 'bookmarkOpenCounts';

export async function readUsage() {
  const result = await browser.storage.local.get(USAGE_KEY);
  return result[USAGE_KEY] || {};
}

export function recordOpen(id) {
  if (!id || browser.extension?.inIncognitoContext) return;
  browser.runtime.sendMessage({ bookmarkOpened: id }).catch(() => {});
}
