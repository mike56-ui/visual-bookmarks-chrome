export const PREVIEW_CAPTURE_PORT = 'bookmark-preview-capture';
export const VISIBLE_PREVIEW_PORT = 'visible-bookmark-preview';

export function openPreviewCapture(name = PREVIEW_CAPTURE_PORT) {
  const port = browser.runtime.connect({ name });
  let pending;
  let closed = false;

  function finish(status) {
    const request = pending;
    if (!request) return;
    pending = undefined;
    clearTimeout(request.timer);
    request.resolve(status);
  }

  function close() {
    if (closed) return;
    closed = true;
    finish('stopped');
    port.disconnect();
  }

  port.onMessage.addListener(({ status }) => {
    if (['updated', 'unchanged', 'protected', 'unavailable', 'failed', 'stopped'].includes(status)) finish(status);
  });
  port.onDisconnect.addListener(() => {
    // Read lastError to prevent a rejected connection from logging an unchecked error.
    void browser.runtime.lastError;
    closed = true;
    finish('stopped');
  });

  return {
    capture({ id, url, mode }) {
      if (closed) return Promise.resolve('stopped');
      if (pending) return Promise.resolve('failed');
      return new Promise(resolve => {
        pending = { resolve, timer: setTimeout(close, 35000) };
        try {
          port.postMessage({ id, url, mode });
        } catch {
          close();
        }
      });
    },
    close
  };
}
