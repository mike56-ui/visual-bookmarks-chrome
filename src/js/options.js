import '../css/options.css';
import './components/vb-select';
import Gmodal from 'glory-modal';
import TabsSlider from 'tabs-slider';
import { settings } from './settings';
import Localization from './plugins/localization';
import Ripple from './components/ripple';
import Toast from './components/toast';
import confirmPopup from './plugins/confirmPopup.js';
import { getFolders } from './api/bookmark';
import {
  $notifications,
  $resizeThumbnail,
  $trigger,
  getVideoPoster
} from './utils';
import Range from './components/range';
import ImageDB from './api/imageDB';
import {
  FILES_ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  SEARCH_ENGINES
} from './constants';
import { storage } from './api/storage';
import settingsList from './constants/settingsList';
import drawerSettings from './constants/drawerSettings';
import { displaySettings } from './components/displaySettings';
import bindPreviewPreference from './components/visitPreviewSetting';
import { containsPermissions, removePermissions, requestPermissions } from './api/permissions';

let modalInstance = null;
let tabsSliderInstance = null;
let backgroundImage = null;
const embedded = new URLSearchParams(location.search).get('embedded') === '1';

function announceMediaChange(thumbnails = false) {
  if (!embedded) return;
  document.dispatchEvent(new CustomEvent('vb:settings-media', {
    detail: { backgroundMedia: {}, ...(thumbnails && { thumbnailMedia: {} }) }
  }));
}

function syncTabSelection(tabs, index) {
  tabs.querySelectorAll('[role="tab"]').forEach((tab, position) => {
    const active = index === position;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    panel.inert = !active;
    panel.setAttribute('aria-hidden', String(!active));
    if (embedded) panel.hidden = !active;
  });
}

async function init() {
  // Set lang attr
  // Replacement underscore on the dash because underscore is not a valid language subtag
  document.documentElement.setAttribute(
    'lang',
    browser.i18n.getMessage('@@ui_locale').replace('_', '-')
  );

  document.body.classList.toggle('options-embedded', embedded);
  document.getElementById('settings').innerHTML = displaySettings(embedded ? drawerSettings(settingsList) : settingsList);
  if (embedded) {
    const preference = document.getElementById('visit_preview_preference');
    const hint = document.querySelector('#setting_visit_preview_preference small');
    hint.id = 'visit_preview_preference_hint';
    preference.setAttribute('aria-describedby', hint.id);
    bindPreviewPreference(preference, 'visitPreviewEnabled', true, hint);
  }
  bindPreviewPreference(document.getElementById('autoFillMissingPreviews'), 'autoFillMissingPreviews', false);

  await settings.init();

  await window.vbToggleTheme();

  Localization();

  Ripple.init('.md-ripple');

  const background = await ImageDB.get('background');
  if (background) {
    backgroundImage = URL.createObjectURL(background.blobThumbnail);
  }

  // range settings
  Array.from(document.querySelectorAll('.js-range')).forEach(el => {
    const id = el.id;
    const automaticWidth = embedded && id === 'dial_width';
    const formatWidth = value => Number(value) === 70 ? browser.i18n.getMessage('settings_automatic') : value + '%';
    const describeWidth = event => el.setAttribute('aria-valuetext', formatWidth(event.target.value));
    new Range(el, {
      value: settings.$[id],
      postfix: automaticWidth ? '' : el.dataset.outputPostfix,
      ...(automaticWidth && { format: formatWidth, onInput: describeWidth }),
      onChange(e) {
        if (automaticWidth) describeWidth(e);
        const { value } = e.target;
        if (e.isTrusted) settings.updateKey(id, value).catch(console.warn);
      },
      ...('thumbnails_update_delay' === id) && {
        format(value) {
          return parseFloat(value).toFixed(1);
        }
      }
    });
  });

  // Tabs
  const tabs = document.querySelector('.tabs');
  const savedTab = Number.parseInt(localStorage.getItem('option_tab_slide'), 10);
  const controls = [...tabs.querySelectorAll('[role="tab"]')];
  const tabIndex = Math.max(0, Math.min(controls.length - 1, savedTab || 0));
  const activate = index => {
    if (tabsSliderInstance) {
      tabsSliderInstance.show(index);
    } else {
      syncTabSelection(tabs, index);
      localStorage.setItem('option_tab_slide', index);
      window.scrollTo(0, 0);
    }
  };
  if (!embedded) {
    tabsSliderInstance = new TabsSlider(tabs, {
      draggable: false,
      animate: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      slide: tabIndex
    });
  }
  syncTabSelection(tabs, tabIndex);
  const bar = tabs.querySelector('[role="tablist"]');
  if (embedded) bar.addEventListener('click', event => {
    const index = controls.indexOf(event.target.closest('[role="tab"]'));
    if (index !== -1) activate(index);
  });
  bar.addEventListener('keydown', event => {
    const active = controls.indexOf(event.target);
    if (active === -1) return;
    const byKey = {
      ArrowLeft: (active + controls.length - 1) % controls.length,
      ArrowRight: (active + 1) % controls.length,
      Home: 0,
      End: controls.length - 1
    };
    if (!Object.hasOwn(byKey, event.key)) return;
    event.preventDefault();
    const index = byKey[event.key];
    activate(index);
    controls[index].focus();
  });

  // Modal
  modalInstance = new Gmodal(document.getElementById('modal'), {
    closeBackdrop: false
  });
  modalInstance.element.addEventListener('gmodal:open', function() {
    storage.local.remove('extension_updated');
  });
  modalInstance.element.addEventListener('gmodal:close', function() {
    const video = modalInstance.element.querySelector('video');
    if (video) {
      video.pause();
      video.currentTime = 1;
    }
  });
  document.addEventListener('vb:drawer-hidden', () => Gmodal.closeAll());
  document.addEventListener('vb:drawer-shown', () => getOptions().catch(console.warn));

  const manifest = browser.runtime.getManifest();
  document.getElementById('ext_name').textContent = manifest.name;
  document.getElementById('ext_version').textContent = `${browser.i18n.getMessage('version')} ${manifest.version}`;
  document.getElementById('modal_changelog_version').textContent = manifest.version;

  tabs.addEventListener('tabChange', function(evt) {
    localStorage['option_tab_slide'] = evt.detail.currentIndex;
    syncTabSelection(tabs, evt.detail.currentIndex);
  });
  document.getElementById('custom_style').addEventListener('input', () => tabsSliderInstance?.recalcStyles());

  await getOptions();

  // Delegate change settings
  document.querySelector('.tabs').addEventListener('change', handleSetOptions);
  document.getElementById('background_local').addEventListener('click', handleRemoveFile);
  document.getElementById('restore_local').addEventListener('click', handleResetLocalSettings);
  document.getElementById('restore_sync').addEventListener('click', handleResetSyncSettings);
  document.getElementById('enable_sync').addEventListener('change', handleChangeSync);
  document.getElementById('clear_images').addEventListener('click', handleDeleteImages);
  document.getElementById('toggle_clipboard_access').addEventListener('change', handleToggleClipboardAccess);

  document.getElementById('export').addEventListener('click', handleExportSettings);
  document.getElementById('import').addEventListener('change', handleImportSettings);
  document.getElementById('bgFile').addEventListener('change', handleUploadFile);

  // TODO until full support is available https://developer.mozilla.org/en-US/docs/Web/API/Window/showOpenFilePicker
  document.getElementById('bgFile').setAttribute(
    'accept',
    FILES_ALLOWED_EXTENSIONS.map(ext => `.${ext}`).join(', ')
  );

  document.querySelector('.info-btn').addEventListener('click', () => {
    modalInstance.open();
  });
  if (window.location.hash === '#changelog') {
    modalInstance.open();
  }
}

async function handleImportSettings(e) {
  const input = e.target;
  const file = input.files?.[0];
  if (!file) return;
  try {
    await settings.updateAll(JSON.parse(await file.text()));
    await window.vbToggleTheme();
    await getOptions();
    const message = browser.i18n.getMessage('import_settings_success');
    if (embedded) Toast.show(message);
    else $notifications(message);
  } catch (error) {
    Toast.show(browser.i18n.getMessage('import_settings_failed'));
    console.warn(error);
  } finally {
    input.value = '';
  }
}

function handleExportSettings() {
  const data = Object.keys(settings.$).reduce((acc, cur) => {
    if (
      ![
        'default_folder_id',
        'custom_dials',
        'background_local'
      ].includes(cur)
    ) {
      acc[cur] = settings.$[cur];
    }
    return acc;
  }, {});

  const file = new Blob([JSON.stringify(data)], { type: 'text/plain' });
  // TODO: permission is required to download
  // browser.downloads.download({
  //   url: URL.createObjectURL(file),
  //   filename: 'visual-bookmarks-settings.backup'
  // });
  const a = document.createElement('a');
  const url = URL.createObjectURL(file);
  a.href = url;
  a.download = 'visual-bookmarks-settings.backup';
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function getOptions() {
  generateSearchEngineList();


  for (let id of Object.keys(settings.$)) {
    const elOption = document.getElementById(id);

    // goto next if element not type
    if (!elOption || !elOption.type) continue;

    if (/checkbox|radio/.test(elOption.type)) {
      elOption.checked = settings.$[id];
    } else {
      elOption.value = settings.$[id];

      // update range slider
      if (elOption.type === 'range') {
        $trigger('change', elOption);
      }
    }
  }
  await Promise.all([generateFolderList(), getPermissions()]);
}

/**
 * Toggle background settings
 * @param {string} value - localStorage background_image value
 */
function toggleBackgroundControls(value) {
  Array.from(document.querySelectorAll('.js-background-settings')).forEach((item) => {
    item.hidden = true;
  });
  if (value === 'background_local') {
    if (backgroundImage) {
      document.getElementById('preview_upload').innerHTML = /* html */
        `<div class="c-upload__preview-image" style="background-image: url(${backgroundImage});"><div>`;
    } else {
      document.getElementById('preview_upload').innerHTML = '';
    }
    document.querySelector('.c-upload__preview').hidden = !backgroundImage;
  }
  document.getElementById(value).hidden = false;

  const showImageEffectSetting = ['background_local', 'background_external', 'background_bing'].includes(value);
  document.getElementById('setting_background_effect').hidden = !showImageEffectSetting;

  tabsSliderInstance?.recalcStyles();
}

function relationToggleOption(target) {
  // Settings that depend on each other.
  // When enabling one setting, the related setting must be disabled
  if (target.dataset.relationToggleId) {
    const checkedRegexp = /checkbox|radio/;
    // association can be with multiple selectors
    // create an array of settings IDs from the string
    const ids = target.dataset.relationToggleId.split(',');
    // get value regardless of element type
    const value = checkedRegexp.test(target.type) ? target.checked : target.value;
    ids.forEach(id => {
      const relationEl = document.getElementById(id);

      // This whole relationship-handling logic needs to be reworked.
      // For now, this is a dirty workaround for the relation item's action
      if (target.dataset.relationAction) {
        relationEl[target.dataset.relationAction] = target.checked;
        return;
      }

      // disable the related option only if it was initially enabled
      // if relation element => checkbox|radio
      if (checkedRegexp.test(relationEl.type) && relationEl.checked) {
        // if relation with boolean type
        if (typeof value === 'boolean') {
          relationEl.checked = !target.checked;
        } else {
        // otherwise we try to get the string value of the data attribute
        // convert string to array
        // and search by keyword
        // if array includes keyword, we need to turn off the setting
          const values = target.dataset.relationToggleValues.split(',');
          relationEl.checked = !values.includes(value);
        }
        // update extension setting
        settings.updateKey(id, relationEl.checked);
      } else {
        // if relation element => select
        if (relationEl.tagName === 'SELECT') {
          relationEl.selectedIndex = 0;
        } else {
        // if relation element => input
          relationEl.value = '';
        }
        // update extension setting
        settings.updateKey(id, relationEl.value);
      }
    });
  }
}

async function handleSetOptions(e) {
  const target = e.target.closest('.js-change');
  if (!target) return;

  const id = target.id;
  if (id === 'visit_preview_preference' || id === 'autoFillMissingPreviews') return;

  if (/checkbox|radio/.test(target.type)) {
    await settings.updateKey(id, target.checked);
  } else {
    if (id === 'background_image') {
      if (target.value === 'background_bing') {
        const bingHostPermission = await requestPermissions({ origins: ['https://www.bing.com/*'] });
        if (!bingHostPermission) {
          target.value = 'background_local';
        }
      }

      toggleBackgroundControls(target.value);
    }

    await settings.updateKey(id, target.value);
  }

  relationToggleOption(target);

  // dark theme
  if (target.id === 'color_theme') {
    window.vbToggleTheme();
  }
}

async function handleUploadFile() {
  const form = this.closest('form');
  const file = this.files[0];
  if (!file) return;

  form.reset();

  const isSizeExceeded = MAX_FILE_SIZE_BYTES < file.size;
  const isAllowedType = FILES_ALLOWED_EXTENSIONS.some(type => file.type.endsWith(type));
  if (!isAllowedType) {
    return Toast.show(browser.i18n.getMessage(
      'alert_file_type_fail_type',
      [FILES_ALLOWED_EXTENSIONS.join(' | ')]
    ));
  }
  if (isSizeExceeded) {
    return Toast.show(browser.i18n.getMessage(
      'alert_file_type_fail_size',
      [MAX_FILE_SIZE_BYTES / 10 ** 6]
    ));
  }

  form.classList.add('is-upload');

  const blob = new Blob([new Uint8Array(await file.arrayBuffer())], {
    type: file.type
  });
  const blobThumbnail = file.type.startsWith('video')
    ? await getVideoPoster(file)
    : await $resizeThumbnail(blob);

  if (backgroundImage) {
    URL.revokeObjectURL(backgroundImage);
  }
  backgroundImage = URL.createObjectURL(blobThumbnail);
  await ImageDB.update({
    id: 'background',
    blob,
    blobThumbnail
  });

  form.classList.remove('is-upload');

  document.querySelector('.c-upload__preview').hidden = false;
  document.getElementById('preview_upload').innerHTML = /* html */
          `<div class="c-upload__preview-image"
            style="background-image: url(${backgroundImage});">
          <div>`;

  Toast.show(browser.i18n.getMessage('notice_bg_image_updated'));
  announceMediaChange();
  tabsSliderInstance?.recalcStyles();
}

async function handleRemoveFile(evt) {
  const target = evt.target.closest('#delete_upload');
  if (!target) return;

  const confirmAction = await confirmPopup(browser.i18n.getMessage('confirm_delete_image'));
  if (!confirmAction) return;

  evt.preventDefault();
  const preview = document.getElementById('preview_upload');
  const previewParent = preview.closest('.c-upload__preview');

  await ImageDB.delete('background');
  if (backgroundImage) {
    URL.revokeObjectURL(backgroundImage);
    backgroundImage = null;
  }

  preview.innerHTML = '';
  previewParent.hidden = true;
  tabsSliderInstance?.recalcStyles();
  Toast.show(browser.i18n.getMessage('notice_image_removed'));
  announceMediaChange();
}

async function handleDeleteImages(evt) {
  evt.preventDefault();

  const confirmAction = await confirmPopup(browser.i18n.getMessage('confirm_delete_images'));
  if (!confirmAction) return;

  if (!await ImageDB.clear()) return;
  if (backgroundImage) {
    URL.revokeObjectURL(backgroundImage);
    backgroundImage = null;
    toggleBackgroundControls(settings.$.background_image);
  }
  Toast.show(browser.i18n.getMessage('notice_images_removed'));
  announceMediaChange(true);
}

async function handleResetLocalSettings() {
  const confirmAction = await confirmPopup(browser.i18n.getMessage('confirm_restore_default_settings'));
  if (!confirmAction) return;

  await settings.resetLocal();

  window.vbToggleTheme();
  getOptions();
  Toast.show(browser.i18n.getMessage('notice_reset_default_settings'));
}
async function handleResetSyncSettings() {
  const confirmAction = await confirmPopup(browser.i18n.getMessage('confirm_clear_sync_settings'));
  if (!confirmAction) return;

  await settings.resetSync();
  Toast.show(browser.i18n.getMessage('notice_sync_settings_cleared'));
}
function handleChangeSync() {
  if (this.checked) {
    browser.storage.sync.getBytesInUse(null, async(bytes) => {
      if (bytes > 0) {
        const confirmAction = await confirmPopup(browser.i18n.getMessage('confirm_sync_remote_settings'));

        if (confirmAction) {
          await settings.restoreFromSync();
          getOptions();
          window.vbToggleTheme();
        } else {
          this.checked = false;
          settings.updateKey('enable_sync', false);
        }
      } else {
        settings.syncToStorage();
      }
    });
  }
}
async function handleToggleClipboardAccess(e) {
  e.preventDefault();
  const clipboardInput = document.getElementById('toggle_clipboard_access');

  if (clipboardInput.dataset.active !== 'true') {
    const requestPermission = await requestPermissions({ permissions: ['clipboardRead'] });
    clipboardInput.dataset.active = requestPermission;
  } else {
    const removePermission = await removePermissions({ permissions: ['clipboardRead'] });
    clipboardInput.dataset.active = !removePermission;
  }
  clipboardInput.checked = clipboardInput.dataset.active === 'true';
}

async function getPermissions() {
  const clipboardInput = document.getElementById('toggle_clipboard_access');
  const clipboardReadPermission = await containsPermissions({ permissions: ['clipboardRead'] });
  clipboardInput.checked = clipboardReadPermission;
  clipboardInput.dataset.active = clipboardReadPermission;

  const optionBackgroundSelect = document.getElementById('background_image');
  let selectedBackgroundValue = settings.$.background_image;
  if (selectedBackgroundValue === 'background_bing') {
    const bingHostPermission = await containsPermissions({ origins: ['https://www.bing.com/*'] });
    if (!bingHostPermission) {
      selectedBackgroundValue = 'background_local';
      settings.updateKey('background_image', selectedBackgroundValue);
    }
  }
  optionBackgroundSelect.value = selectedBackgroundValue;
  toggleBackgroundControls(selectedBackgroundValue);
}

async function generateFolderList() {
  const folders = await getFolders().catch(console.warn);
  if (folders) {
    const vbSelect = document.getElementById('default_folder_id');
    vbSelect.value = settings.$.default_folder_id;
    vbSelect.folders = folders;
    vbSelect.disabled = settings.$.show_last_opened_folder;
  }
}

function generateSearchEngineList() {
  const select = document.getElementById('search_engine');
  const localBookmarks = browser.i18n.getMessage('placeholder_input_search_bookmarks');
  select.replaceChildren(...SEARCH_ENGINES.map(engine =>
    new Option(engine.value === 'bookmarks' ? localBookmarks || engine.title : engine.title, engine.value)));
}

init();
