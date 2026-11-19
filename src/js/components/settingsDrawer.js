const OPTIONS_PATH = '/options.html';

export default function initializeSettingsDrawer({ onSettingsChange } = {}) {
  const title = browser.i18n.getMessage('options') || 'Settings';
  const dialog = document.createElement('dialog');
  dialog.className = 'settings-drawer';
  dialog.id = 'settingsDrawer';
  dialog.setAttribute('aria-labelledby', 'settingsDrawerTitle');

  const header = document.createElement('header');
  header.className = 'settings-drawer__header';
  const heading = document.createElement('h1');
  heading.id = 'settingsDrawerTitle';
  heading.textContent = title;

  const closeButton = document.createElement('button');
  closeButton.className = 'settings-drawer__close';
  closeButton.type = 'button';
  closeButton.autofocus = true;
  closeButton.textContent = '×';
  closeButton.setAttribute('aria-label', browser.i18n.getMessage('btn_close') || 'Close');
  header.append(heading, closeButton);

  const frame = document.createElement('iframe');
  frame.className = 'settings-drawer__frame';
  frame.title = title;
  dialog.append(header, frame);
  document.body.append(dialog);

  let returnFocus = null;
  let openedUrl = '';
  let backdropPressed = false;
  function open(trigger, hash) {
    if (dialog.open) return;
    const menu = trigger?.closest('#newtabActionsList');
    returnFocus = menu ? document.getElementById('newtabActionsToggle') : trigger || document.activeElement;
    if (menu) {
      menu.hidden = true;
      returnFocus?.setAttribute('aria-expanded', 'false');
    }
    const url = OPTIONS_PATH + '?embedded=1' + (hash === '#changelog' ? hash : '');
    if (url !== openedUrl || hash === '#changelog') {
      openedUrl = url;
      frame.src = url;
    }
    dialog.showModal();
    closeButton.focus();
    frame.contentDocument?.dispatchEvent(new Event('vb:drawer-shown'));
  }

  function restoreFocus() {
    if (dialog.open || !returnFocus) return;
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
  // Some direct new-tab links open the same UI without first opening the menu.
  if (new URLSearchParams(location.search).get('settings') === '1') open(null, '');
}
