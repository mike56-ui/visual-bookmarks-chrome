import { $createElement } from '../utils';
import { settings } from '../settings';
import Toast from '../components/toast';
import ImageDB from '../api/imageDB';
import { getBingImage } from '../api/bingImageDay';
import { containsPermissions } from '../api/permissions';

function createBingInfo(image) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('viewBox', '0 0 20 20');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  // eslint-disable-next-line max-len
  path.setAttribute('d', 'M10 18c.87 0 1.71-.14 2.494-.396a8 8 0 0 1-.974-1.63C11.024 16.675 10.486 17 10 17c-.657 0-1.407-.59-2.022-1.908A9.3 9.3 0 0 1 7.42 13.5h3.584q.019-.514.137-1H7.206A15 15 0 0 1 7 10c0-.883.073-1.725.206-2.5h5.588c.12.704.192 1.463.204 2.258q.453-.31.986-.5a16 16 0 0 0-.177-1.758h2.733c.21.549.353 1.131.419 1.736q.562.193 1.037.517A8 8 0 1 0 10 18m0-15c.657 0 1.407.59 2.022 1.908.217.466.406 1.002.559 1.592H7.419c.153-.59.342-1.126.56-1.592C8.592 3.59 9.342 3 10 3M7.072 4.485A10.5 10.5 0 0 0 6.389 6.5H3.936a7.02 7.02 0 0 1 3.778-3.118c-.241.33-.456.704-.642 1.103M6.192 7.5A16 16 0 0 0 6 10c0 .87.067 1.712.193 2.5H3.46A7 7 0 0 1 3 10c0-.88.163-1.724.46-2.5zm.197 6c.176.743.407 1.422.683 2.015.186.399.401.773.642 1.103A7.02 7.02 0 0 1 3.936 13.5zm5.897-10.118A7.02 7.02 0 0 1 16.064 6.5H13.61a10.5 10.5 0 0 0-.683-2.015 6.6 6.6 0 0 0-.642-1.103M19 13.682c0-2.033-1.465-3.681-3.499-3.681S12 11.649 12 13.682c0 1.524.982 3.53 3.256 5.236.145.11.345.11.49 0C18.022 17.212 19 15.206 19 13.682m-2-.182a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0');
  svg.appendChild(path);

  const copyright = image.copyright.match(/\(([^)]*)\)/)?.[1];

  return $createElement('a',
    {
      class: 'bing-info',
      href: image.copyrightlink,
      title: image.copyright.replace(/\(.+\)/, '')
    },
    svg,
    $createElement('div',
      {
        class: 'bing-info__text'
      },
      $createElement('div', { class: 'bing-info__title' }, image.title),
      $createElement('div', { class: 'bing-info__copy' }, copyright)
    )
  );
}

let userStyle;
let background;
let bingRequest;
let toldBingPermission = false;
let dockGrid;
let dockColumns = 7;
let dockObserver;

function releaseBackground() {
  if (!background) return;
  const { controller, image, video, effect, objectUrl, attribution } = background;
  background = undefined;
  controller.abort();
  effect?.destroy();
  image?.removeAttribute('src');
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  attribution?.remove();
}

function clearBackground(bg) {
  releaseBackground();
  bg?.replaceChildren();
  bg?.style.removeProperty('opacity');
  document.body.classList.remove('has-image');
}

function reveal(bg, session) {
  if (background !== session || session.controller.signal.aborted) return;
  document.body.classList.add('has-image');
  bg.style.opacity = '1';
}

async function decodeImage(session, src, cors) {
  const image = new Image();
  session.image = image;
  if (cors) image.crossOrigin = 'anonymous';
  image.decoding = 'async';
  image.src = src;
  try {
    await image.decode();
    if (!session.controller.signal.aborted) return image;
  } catch {
    image.removeAttribute('src');
  }
}

function showVideo(bg, session, src) {
  const video = $createElement('video');
  const { signal } = session.controller;
  session.video = video;
  video.muted = true;
  video.loop = true;
  video.autoplay = true;
  video.playsInline = true;
  video.addEventListener('canplay', () => reveal(bg, session), { once: true, signal });
  video.addEventListener('error', () => {
    if (background === session) clearBackground(bg);
  }, { once: true, signal });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) video.pause();
    else video.play().catch(() => undefined);
  }, { signal });
  video.src = src;
  bg.append(video);
}

async function showImage(bg, session, src, distortion) {
  const isRemote = /^https?:/i.test(src);
  let animate = distortion;
  let image = await decodeImage(session, src, animate && isRemote);
  if (session.controller.signal.aborted) return false;
  // A still image remains available when the server does not allow WebGL textures.
  if (!image && animate && isRemote) {
    animate = false;
    image = await decodeImage(session, src, false);
  }
  if (!image || session.controller.signal.aborted) return false;

  if (animate) {
    try {
      const { default: DistortionEffect } = await import('../plugins/effects/distortion');
      if (session.controller.signal.aborted) return false;
      session.effect = new DistortionEffect(image);
    } catch {
      // Fall back to the decoded still image if WebGL is unavailable.
    }
  }
  bg.append(session.effect?.canvas ?? image);
  reveal(bg, session);
  return true;
}

function applyDockColumns() {
  if (!dockGrid) return;
  const style = dockGrid.style;
  const gap = Number.parseFloat(window.getComputedStyle(dockGrid).columnGap) || 16;
  const fits = Math.max(1, Math.floor((dockGrid.clientWidth + gap) / (112 + gap)));
  const columns = String(Math.min(dockColumns, fits));
  if (style.getPropertyValue('--dock-grid-columns') !== columns) style.setProperty('--dock-grid-columns', columns);
}

function customizeDockGrid(grid, columns) {
  dockColumns = columns;
  if (columns === 7) {
    dockObserver?.disconnect();
    dockGrid = undefined;
    grid.style.removeProperty('--dock-grid-columns');
    grid.style.removeProperty('--dock-grid-min-width');
    return;
  }
  grid.style.setProperty('--dock-grid-min-width', '112px');
  if (dockGrid !== grid) {
    dockObserver?.disconnect();
    dockGrid = grid;
    if (typeof ResizeObserver === 'function') {
      dockObserver ||= new ResizeObserver(applyDockColumns);
      dockObserver.observe(grid);
    }
  }
  applyDockColumns();
}

export default {
  userStyles() {
    const styles = settings.$.custom_style || '';
    if (!styles.trim()) {
      userStyle?.remove();
      userStyle = undefined;
      return;
    }
    if (!userStyle) {
      userStyle = $createElement('style', { 'data-user-style': '' });
      document.head.append(userStyle);
    }
    if (userStyle.textContent !== styles) userStyle.textContent = styles;
  },
  async setBG() {
    const bg = document.getElementById('bg');
    clearBackground(bg);
    if (!bg) return;

    const { background_image: mode, background_external: external, background_effect: effect } = settings.$;
    if (mode !== 'background_bing') toldBingPermission = false;
    if (!['background_local', 'background_external', 'background_bing'].includes(mode)) return;

    const session = { controller: new AbortController() };
    background = session;
    const { signal } = session.controller;
    let mounted = false;
    try {
      let src;
      let video = false;
      let card;
      if (mode === 'background_local') {
        const image = await ImageDB.get('background');
        if (signal.aborted || !image?.blob) return;
        src = session.objectUrl = URL.createObjectURL(image.blob);
        video = image.blob.type.startsWith('video/');
      } else if (mode === 'background_external') {
        src = external;
      } else {
        const granted = await containsPermissions({ origins: ['https://www.bing.com/*'] });
        if (signal.aborted) return;
        if (!granted) {
          if (!toldBingPermission) Toast.show(browser.i18n.getMessage('bing_permission_toast'));
          toldBingPermission = true;
          return;
        }
        toldBingPermission = false;
        bingRequest ||= getBingImage().finally(() => {
          bingRequest = undefined;
        });
        card = await bingRequest;
        src = card?.imageurl;
      }
      if (!src || signal.aborted) return;

      if (video) {
        showVideo(bg, session, src);
        mounted = true;
      } else {
        const distortion = effect === 'distortion' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        mounted = await showImage(bg, session, src, distortion);
      }
      if (mounted && !signal.aborted && card) {
        session.attribution = createBingInfo(card);
        document.body.append(session.attribution);
      }
    } catch (error) {
      if (!signal.aborted) console.warn(error);
    } finally {
      if (!mounted && background === session) releaseBackground();
    }
  },
  calculateStyles() {
    const doc = document.documentElement;
    const grid = document.getElementById('bookmarks');
    if (!grid) return;
    const scrollport = document.getElementById('main');
    doc.style.setProperty('--bookmark-scrollbar-gutter', (scrollport.offsetWidth - scrollport.clientWidth) + 'px');

    const styles = window.getComputedStyle(doc);
    const gap = Number.parseInt(styles.getPropertyValue('--grid-gap'), 10) || 0;
    const columns = Number.parseInt(settings.$.dial_columns, 10) || 7;
    const width = Number.parseInt(settings.$.dial_width, 10) || 70;
    const containerWidth = window.matchMedia('(width > 480px)').matches ? width : 100;
    doc.style.setProperty('--container-width', containerWidth + '%');

    const narrowDock = window.matchMedia('(max-width: 700px), (max-height: 395px)').matches;
    if (!narrowDock && width !== 70) doc.style.setProperty('--dock-container-width', width + '%');
    else doc.style.removeProperty('--dock-container-width');
    customizeDockGrid(grid, columns);

    const hasControls = settings.$.show_settings_icon
      || settings.$.thumbnails_update_button || settings.$.services_enable;
    if (hasControls && width >= 85) {
      const buttonSize = Number.parseInt(styles.getPropertyValue('--circ-btn-size'), 10) || 0;
      doc.style.setProperty('--container-padding-inline', buttonSize + 20 + 'px');
    } else {
      doc.style.removeProperty('--container-padding-inline');
    }

    const colWidth = Math.floor((grid.offsetWidth - ((columns - 1) * gap)) / columns);
    if (colWidth < 80) doc.style.removeProperty('--grid-columns');
    else doc.style.setProperty('--grid-columns', columns);
  }
};
