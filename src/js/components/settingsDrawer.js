const OPTIONS_PATH = '/options.html';

export default function initializeSettingsDrawer({ onSettingsChange } = {}) {
  const title = browser.i18n.getMessage('options') || 'Settings';
  const dialog = document.getElementById('settingsDrawer');
  const toggle = document.getElementById('newtabActionsToggle');
  const closeButton = dialog.querySelector('.settings-drawer__close');
  const frame = dialog.querySelector('iframe');
  frame.title = title;
  toggle.title = title;
  toggle.setAttribute('aria-label', title);

  let returnFocus = null;
  let openedUrl = '';
  let backdropPressed = false;
  function open(trigger, hash) {
    if (dialog.open) return;
    returnFocus = trigger || toggle;
    const url = OPTIONS_PATH + '?embedded=1' + (hash === '#changelog' ? hash : '');
    if (url !== openedUrl || hash === '#changelog') {
      openedUrl = url;
      frame.src = url;
    }
    dialog.showModal();
    toggle.setAttribute('aria-expanded', 'true');
    closeButton.focus();
    frame.contentDocument?.dispatchEvent(new Event('vb:drawer-shown'));
  }

  function restoreFocus() {
    if (dialog.open || !returnFocus) return;
    toggle.setAttribute('aria-expanded', 'false');
    // The frame can retain form state while hidden. Stop any open changelog media.
    frame.contentDocument?.dispatchEvent(new Event('vb:drawer-hidden'));
    if (returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }

  function close() {
    if (!dialog.open) return;
    dialog.close();
    restoreFocus();
  }

  toggle.addEventListener('click', () => open(toggle));
  closeButton.addEventListener('click', close);
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('pointerdown', event => {
    backdropPressed = event.target === dialog;
  });
  dialog.addEventListener('click', event => {
    if (event.target === dialog && backdropPressed) close();
    backdropPressed = false;
  });
  dialog.addEventListener('close', restoreFocus);

  frame.addEventListener('load', () => {
    const child = frame.contentDocument;
    if (!child || !openedUrl) return;
    child.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.isComposing && !event.defaultPrevented && dialog.open) {
        event.preventDefault();
        close();
      }
    });
    child.addEventListener('vb:settings-media', event => {
      onSettingsChange?.(event.detail);
    });
  });

  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href]');
    if (!link) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || url.pathname !== OPTIONS_PATH) return;
    event.preventDefault();
    open(link, url.hash);
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.settings || changes.visitPreviewEnabled)) {
      onSettingsChange?.(changes);
    }
  });

  // The browser's own extension settings button still goes to options.html.
  if (new URLSearchParams(location.search).get('settings') === '1') open(null, '');
}
