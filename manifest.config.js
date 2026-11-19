// CI adds a fourth component so every released package has an increasing version.
const releaseBuild = process.env.RELEASE_BUILD;
if (releaseBuild && (!/^[1-9]\d*$/.test(releaseBuild) || Number(releaseBuild) > 65535)) {
  throw new Error('RELEASE_BUILD must be an integer between 1 and 65535');
}

const common = {
  manifest_version: 3,
  default_locale: 'en',
  name: '__MSG_ext_name__',
  description: '__MSG_ext_desc__',
  version: releaseBuild ? `7.7.7.${releaseBuild}` : '7.7.7',
  icons: {
    16: 'icons/icon16.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png'
  },
  chrome_url_overrides: {
    newtab: 'newtab.html'
  },
  options_ui: {
    page: 'options.html',
    open_in_tab: true
  },
  action: {
    default_title: '__MSG_default_title__'
  },
  permissions: [
    'scripting',
    'background',
    'bookmarks',
    'storage',
    'unlimitedStorage',
    'tabs',
    'notifications',
    'contextMenus'
  ],
  optional_permissions: [
    'clipboardRead',
    'search'
  ],
  optional_host_permissions: [
    'https://google.com/*',
    'https://www.bing.com/*',
    '<all_urls>'
  ]
};

export const MIN_BROWSER_VERSION = process.env.BROWSER === 'firefox' ? '128.0' : '105';

/** @param {'chrome' | 'firefox'} browser */
export function getManifest(browser) {
  if (browser === 'firefox') {
    return {
      ...common,
      background: {
        scripts: ['background.js']
      },
      permissions: common.permissions.filter((p) => p !== 'background'),
      browser_specific_settings: {
        gecko: {
          id: '{876119d0-ddb9-47bb-9620-bc8d2489e857}',
          strict_min_version: MIN_BROWSER_VERSION
        }
      }
    };
  }

  return {
    ...common,
    permissions: [...common.permissions, 'favicon'],
    background: {
      service_worker: 'background.js',
      type: 'module'
    },
    minimum_chrome_version: MIN_BROWSER_VERSION
  };
}
