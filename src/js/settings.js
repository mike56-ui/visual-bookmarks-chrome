import { $uid } from './utils';
/**
 * TODO: temporary promise wrapper for asynchronous work with browser.storage in manifest v2
 * storage[local|sync][set|get]
 * remove after switching to a new manifest (v3)
 */
import { storage } from './api/storage';
import { DEFAULT_BOOKMARKS_FOLDER, SEARCH_ENGINES } from './constants';

const DEFAULTS = Object.freeze({
  color_theme: 'light',
  background_image: 'background_noimage',
  background_external: '',
  default_folder_id: DEFAULT_BOOKMARKS_FOLDER,
  show_last_opened_folder: false,
  dial_columns: 7,
  dial_width: 70, // value in percent (50,60,70,80,90)
  vertical_center: false,
  drag_and_drop: true,
  auto_generate_thumbnail: false,
  enable_sync: false,
  show_toolbar: true,
  show_contextmenu_item: true,
  show_settings_icon: true,
  show_back_column: true,
  show_create_column: true,
  show_bookmark_title: true,
  show_favicon: true,
  open_link_newtab: true,
  thumbnails_update_button: true,
  thumbnails_update_recursive: false,
  thumbnails_update_delay: 0.5,
  custom_style: '',
  without_confirmation: false,
  services_enable: false,
  services_list: [
    { id: $uid(), name: 'youtube', link: 'https://www.youtube.com' },
    { id: $uid(), name: 'search', link: 'https://google.com' },
    { id: $uid(), name: 'translate', link: 'https://translate.google.com' },
    { id: $uid(), name: 'gmail', link: 'https://mail.google.com/mail' },
    { id: $uid(), name: 'drive', link: 'https://drive.google.com/' },
    { id: $uid(), name: 'photos', link: 'https://photos.google.com' }
  ],
  folder_preview: false,
  close_tab_after_adding_bookmark: false,
  logo_external: false,
  logo_external_url: '',
  search_engine: 'bookmarks',
  move_to_start: false,
  sort_by: '', // '' | date | alphabet
  bookmarks_sorting_type: '',
  search_autofocus: false,
  enable_virtual_pagination: false,
  background_effect: 'none' // none | distortion
});

const SETTINGS_NOT_SYNCED = ['default_folder_id', 'enable_sync'];

const choices = {
  search_engine: SEARCH_ENGINES.map(engine => engine.value),
  color_theme: ['os', 'light', 'dark'],
  background_image: ['background_noimage', 'background_local', 'background_external', 'background_bing'],
  background_effect: ['none', 'distortion'],
  sort_by: ['', 'date', 'alphabet'],
  bookmarks_sorting_type: ['', 'folders_top', 'folders_bottom']
};
const ranges = { dial_columns: [1, 10], dial_width: [50, 99], thumbnails_update_delay: [0.5, 15] };

function validate(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('Invalid settings');
  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULTS, key)) continue;
    if (choices[key]) {
      clean[key] = choices[key].includes(value) ? value : DEFAULTS[key];
    } else if (ranges[key]) {
      const n = Number(value);
      clean[key] = Number.isFinite(n) ? Math.max(ranges[key][0], Math.min(n, ranges[key][1])) : DEFAULTS[key];
    } else if (key === 'services_list') {
      if (Array.isArray(value)) {
        clean[key] = value.filter(item => item && typeof item.name === 'string'
          && typeof item.id === 'string' && typeof item.link === 'string'
          && (item.link.startsWith('https://') || item.link.startsWith('http://')));
      }
    } else if (typeof value === typeof DEFAULTS[key]) {
      clean[key] = value;
    }
  }
  return clean;
}

function syncable(values) {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !SETTINGS_NOT_SYNCED.includes(key)));
}

const values = { ...DEFAULTS };
let observing = false;
const withSettingsLock = task => navigator.locks.request('visual-bookmarks-settings', task);

async function readLocal() {
  const saved = (await storage.local.get('settings')).settings;
  return { ...DEFAULTS, ...validate(saved || {}) };
}

async function change(patch) {
  const clean = validate(patch);
  await withSettingsLock(async() => {
    const current = await readLocal();
    const next = { ...current, ...clean };
    if (Object.keys(clean).some(key => current[key] !== next[key])) {
      await storage.local.set({ settings: next });
      const delta = syncable(clean);
      if (next.enable_sync && Object.keys(delta).length) {
        const remote = (await storage.sync.get('settings')).settings || {};
        await storage.sync.set({ settings: { ...syncable(current), ...remote, ...delta } });
      }
    }
    Object.assign(values, next);
  });
}

export const settings = {
  get $() { return values; },

  async init() {
    if (!observing) {
      observing = true;
      browser.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) {
          Object.assign(values, DEFAULTS, validate(changes.settings.newValue || {}));
        }
      });
    }
    await withSettingsLock(async() => {
      const saved = (await storage.local.get('settings')).settings;
      const local = { ...DEFAULTS, ...validate(saved || {}) };
      if (local.enable_sync) {
        const remote = (await storage.sync.get('settings')).settings;
        if (remote) Object.assign(local, syncable(validate(remote)));
      }
      Object.assign(values, local);
      if (!saved || (local.enable_sync && JSON.stringify(saved) !== JSON.stringify(local))) {
        await storage.local.set({ settings: local });
      }
    });
  },

  updateKey(key, value) { return change({ [key]: value }); },
  updateAll(patch) { return change(patch); },

  async syncToStorage() {
    await withSettingsLock(async() => storage.sync.set({ settings: syncable(await readLocal()) }));
  },

  async restoreFromSync() {
    const remote = (await storage.sync.get('settings')).settings;
    if (remote) await change(syncable(validate(remote)));
  },

  async resetLocal() {
    await withSettingsLock(async() => {
      await storage.local.set({
        settings: { ...DEFAULTS }, visitPreviewEnabled: false, autoFillMissingPreviews: false
      });
      Object.assign(values, DEFAULTS);
      localStorage.clear();
    });
  },

  resetSync() { return browser.storage.sync.clear(); }
};

export const LAST_OPENED_FOLDER_ID = 'last_opened_folder_id';
