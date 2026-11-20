export const USAGE_KEY = 'bookmarkOpenCounts';

export async function readUsage() {
  const result = await browser.storage.local.get(USAGE_KEY);
  return result[USAGE_KEY] || {};
}

export function recordOpen(id, sameTabBookmarkUrl) {
  if (!id || browser.extension?.inIncognitoContext) return;
  const message = { bookmarkOpened: id };
  if (sameTabBookmarkUrl) message.sameTabBookmarkUrl = sameTabBookmarkUrl;
  browser.runtime.sendMessage(message).catch(() => {});
}
