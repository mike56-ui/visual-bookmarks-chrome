import { containsPermissions, requestPermissions } from '../api/permissions';
import { storage } from '../api/storage';
import Toast from './toast';

const origins = ['<all_urls>'];

export default function bindPreviewPreference(input, key, defaultEnabled, permissionHint) {
  if (!input) return;
  if (permissionHint) permissionHint.textContent = browser.i18n.getMessage('settings_visit_permission');
  input.disabled = true;
  let changing = false;
  let checkId = 0;
  const sync = async() => {
    const id = ++checkId;
    try {
      const [preference, granted] = await Promise.all([
        storage.local.get(key), containsPermissions({ origins })
      ]);
      if (id !== checkId) return;
      input.checked = (preference[key] ?? defaultEnabled) === true && granted;
      if (permissionHint) permissionHint.hidden = granted;
    } catch {
      if (id !== checkId) return;
      input.checked = false;
      if (permissionHint) permissionHint.hidden = false;
    } finally {
      if (id === checkId && !changing) input.disabled = false;
    }
  };
  sync();
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[key]) sync();
  });
  browser.permissions.onRemoved?.addListener(sync);
  browser.permissions.onAdded?.addListener(sync);
  input.addEventListener('change', async(event) => {
    if (!event.isTrusted) {
      await sync();
      return;
    }
    changing = true;
    input.disabled = true;
    try {
      const requested = input.checked;
      // Invoke the permission request directly in the user's change event.
      const enabled = requested && await requestPermissions({ origins });
      await storage.local.set({ [key]: enabled });
    } catch {
      Toast.show(browser.i18n.getMessage('settings_visit_error'));
    } finally {
      changing = false;
      await sync();
    }
  });
}
