import { readSiteIcon, siteOrigin } from '../api/siteIcons';

const CACHE_SIZE = 192;
const cachedIcons = new Map();
const upgradeIcon = new WeakMap();
let listening = false;

async function renderVector(blob) {
  const url = URL.createObjectURL(blob);
  try {
    // Use SVG only in image mode, then expose the rendered PNG to the card.
    const image = new Image();
    image.src = url;
    await image.decode();
    const factor = 128 / Math.max(image.naturalWidth, image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(factor * image.naturalWidth));
    canvas.height = Math.max(1, Math.round(factor * image.naturalHeight));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function forget(origin) {
  const pending = cachedIcons.get(origin);
  cachedIcons.delete(origin);
  pending?.then(icon => {
    if (icon) URL.revokeObjectURL(icon.src);
  });
}

function localIcon(origin) {
  if (!cachedIcons.has(origin)) {
    if (cachedIcons.size >= CACHE_SIZE) forget(cachedIcons.keys().next().value);
    const pending = readSiteIcon(origin).then(async icon => {
      if (!icon?.blob) return;
      const blob = icon.vector ? await renderVector(icon.blob) : icon.blob;
      if (blob && cachedIcons.get(origin) === pending) {
        return { src: URL.createObjectURL(blob), type: icon.vector ? 'site-vector' : 'site-raster' };
      }
    }).catch(() => undefined);
    cachedIcons.set(origin, pending);
  }
  return cachedIcons.get(origin);
}

export function loadSiteIcon(image, url, fallback, size) {
  const origin = siteOrigin(url);
  let selectedIcon;
  let triedCache = false;

  const improve = async() => {
    if (!origin || !image.isConnected) return;
    triedCache = true;
    const pending = localIcon(origin);
    const icon = await pending;
    if (!icon || !image.isConnected || cachedIcons.get(origin) !== pending || selectedIcon?.src === icon.src) return;
    selectedIcon = icon;
    image.src = icon.src;
  };

  if (origin) {
    image.dataset.siteOrigin = origin;
    upgradeIcon.set(image, improve);
    if (!listening) {
      listening = true;
      browser.runtime.onMessage.addListener(request => {
        const changed = request?.siteIconUpdated;
        if (typeof changed !== 'string') return;
        forget(changed);
        for (const current of document.querySelectorAll('.site-icon__image[data-site-origin]')) {
          if (current.dataset.siteOrigin === changed && (current.complete || current.classList.contains('is-loaded'))) {
            upgradeIcon.get(current)?.();
          }
        }
      });
    }
  }

  image.addEventListener('load', () => {
    const { naturalWidth, naturalHeight } = image;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const scale = Math.min(1 / ratio, size / naturalWidth, size / naturalHeight);
    if (!naturalWidth || !naturalHeight) return;
    image.style.width = `${Math.max(1, Math.floor(naturalWidth * scale))}px`;
    image.style.height = `${Math.max(1, Math.floor(naturalHeight * scale))}px`;
    image.dataset.iconSource = selectedIcon?.type ?? 'browser';
    image.classList.add('is-loaded');
    image.hidden = false;
    if (!triedCache) improve();
  });
  image.addEventListener('error', () => {
    if (selectedIcon) {
      selectedIcon = undefined;
      image.src = fallback;
      return;
    }
    image.hidden = true;
    if (!triedCache) improve();
  });
  image.src = fallback;
}
