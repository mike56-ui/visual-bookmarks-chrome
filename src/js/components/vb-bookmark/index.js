import { $createElement, $getDomain, faviconURL, createSiteIcon } from '../../utils';
import { SVG_LOADER } from '../../constants';

class VbBookmark extends HTMLAnchorElement {
  #isRendered = false;
  #overlayEl = null;
  #_folderChildren = [];
  #iconMap = {
    chrome: '/img/chrome.svg',
    about: '/img/firefox.svg',
    edge: '/img/edge.svg',
    file: '/img/file-open.svg',
    default: '/img/protocol.svg'
  };

  connectedCallback() {
    if (this.#isRendered) return;
    this.#render();
    this.#isRendered = true;
  }

  static get observedAttributes() {
    return [
      'href',
      'title',
      'image',
      'has-overlay',
      'open-newtab',
      'has-title',
      'has-favicon'
    ];
  }

  get #hasChildren() {
    return Boolean(this.#_folderChildren.length);
  }

  #toggleOverlay(isActive) {
    if (isActive) {
      this.#overlayEl = $createElement('div', {
        class: 'bookmark__overlay'
      }, {
        html: SVG_LOADER
      });
      this.appendChild(this.#overlayEl);
      this.classList.add('disable-events');
    } else {
      this.#overlayEl?.remove();
      this.classList.remove('disable-events');
    }
  }

  #updateLogo() {
    const logo = this.querySelector('.bookmark__img--base');
    if (logo) this.#renderLogo(logo);
  }

  #renderLogo(logo) {
    logo.hidden = !this.hasFavicon;
    logo.style.display = logo.hidden ? 'none' : '';
    if (!this.hasFavicon || logo.dataset.pageUrl === this.url && logo.firstElementChild) return;
    logo.dataset.pageUrl = this.url;
    logo.replaceChildren(createSiteIcon(this.url, { source: this.#getLogoUrl(this.url) }));
  }

  attributeChangedCallback(attr, oldValue, newValue) {
    if (!this.#isRendered) return;
    if (oldValue === newValue) return;

    if (attr === 'has-overlay') this.#toggleOverlay(this.hasOverlay);
    if (attr === 'open-newtab') this.#updateLinkTarget();
    if (attr === 'has-title') this.#updateTitleVisibility();
    if (attr === 'has-favicon') this.#updateLogo();
    if (attr === 'title') {
      const titleEl = this.querySelector('.bookmark__title');
      if (titleEl) {
        titleEl.textContent = newValue;
      }
      this.querySelector('.bookmark__delete')?.setAttribute('aria-label', `删除 ${newValue}`);
      this.#updateAccessibleName();
    }
    if (attr === 'image') {
      const imageEl = this.querySelector('[data-thumb]');
      if (this.isFolder) imageEl?.replaceWith(this.#createBookmarkThumbnail());
      else if (imageEl) this.#updateScreenshot(imageEl);
    }
    if (
      attr === 'href' &&
      !this.isFolder
    ) {
      this.#updateLogo();
      const refresh = this.querySelector('.bookmark__refresh');
      if (refresh) refresh.hidden = !this.#canDisplayLogo(this.url);
      const domainEl = this.querySelector('.bookmark__domain');
      if (domainEl) {
        domainEl.textContent = $getDomain(this.url);
      }
      this.#updateAccessibleName();
    }
  }

  #renderFolderPreview() {
    if (this.#hasChildren) {
      const fragment = document.createDocumentFragment();
      const bookmark = $createElement('div', { class: 'bookmark__img bookmark__img--children' });

      this.#_folderChildren.forEach(child => {
        const el = bookmark.cloneNode(true);
        el.append(createSiteIcon(child.url, { size: 20, source: this.#getLogoUrl(child.url) }));
        fragment.appendChild(el);
      });

      return fragment;
    }
    return null;
  }

  #createDeleteButton() {
    return $createElement('button', {
      type: 'button',
      class: 'bookmark__delete',
      title: '删除书签',
      'aria-label': `删除 ${this.title}`
    }, '×');
  }

  #createRefreshButton() {
    const label = browser.i18n.getMessage('contextmenu_capture') || 'Refresh this bookmark thumbnail';
    const button = $createElement('button', {
      type: 'button',
      class: 'bookmark__refresh',
      title: label,
      'aria-label': label
    }, { html: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
      + 'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
      + '<path d="M20 5v5h-5"/><path d="M20 10a8 8 0 1 0 .1 4"/></svg>' });
    button.hidden = !this.#canDisplayLogo(this.url);
    return button;
  }

  #createBookmarkCaption() {
    const caption = $createElement('div', {
      class: 'bookmark__caption',
      title: this.isFolder ? null : ''
    });
    if (this.hasTitle) caption.appendChild(this.#createTitle());
    caption.appendChild(this.#createDomain());

    return caption;
  }

  #createTitle() {
    return $createElement('span', { class: 'bookmark__title' }, this.title);
  }

  #updateTitleVisibility() {
    const caption = this.querySelector('.bookmark__caption');
    if (!caption) return;
    const title = caption.querySelector('.bookmark__title');
    if (!this.hasTitle) title?.remove();
    else if (!title) caption.prepend(this.#createTitle());
  }

  #createBookmarkThumbnail() {
    const thumbnail = $createElement('div', { 'data-thumb': '', class: 'bookmark__img' });

    if (this.isFolder) {
      if (this.hasFolderPreview) {
        thumbnail.classList.add('bookmark__summary-folder');
        const children = this.#renderFolderPreview();
        if (children) {
          thumbnail.appendChild(children);
        } else {
          thumbnail.classList.add('bookmark__img--folder');
        }
      } else {
        thumbnail.classList.add('bookmark__img--folder');
      }
    } else {
      const logo = $createElement('div', { class: 'bookmark__img--base bookmark__img--logo' });
      this.#renderLogo(logo);
      thumbnail.appendChild(logo);
      this.#updateScreenshot(thumbnail);
    }

    return thumbnail;
  }

  #updateScreenshot(thumbnail) {
    thumbnail.querySelector('.bookmark__screenshot')?.remove();
    if (!this.image) return;
    const screenshot = $createElement('div', {
      class: `bookmark__screenshot${this.isCustomImage ? ' bookmark__img--contain' : ''}`
    });
    const preview = $createElement('img', {
      alt: '', loading: 'lazy', decoding: 'async', draggable: 'false'
    });
    preview.addEventListener('load', () => screenshot.classList.add('is-ready'), { once: true });
    preview.addEventListener('error', () => screenshot.remove(), { once: true });
    preview.src = this.image;
    screenshot.append(preview);
    thumbnail.appendChild(screenshot);
  }

  #createDomain() {
    return $createElement('div', {
      class: 'bookmark__domain',
      title: this.isFolder ? this.url : null
    }, this.isFolder ? this.title : $getDomain(this.url));
  }

  #updateAccessibleName() {
    this.setAttribute('aria-label', this.title || this.url || '');
  }

  #updateLinkTarget() {
    if (this.openNewTab && !this.isFolder) {
      this.setAttribute('target', '_blank');
      this.setAttribute('rel', 'noopener');
    } else {
      this.removeAttribute('target');
      this.removeAttribute('rel');
    }
  }

  #render() {
    this.innerHTML = '';
    this.classList.add('bookmark');
    this.#updateAccessibleName();
    this.#updateLinkTarget();

    const stage = $createElement('div', { class: 'bookmark__stage' });
    if (!this.isFolder) stage.append(this.#createRefreshButton());
    stage.append(
      this.#createDeleteButton(),
      this.#createBookmarkThumbnail()
    );

    if (this.isDND) {
      stage.append($createElement('div', {
        class: 'dropzone-bookmark',
        'data-id': this.id
      }));
    }

    this.append(stage);

    this.append(this.#createBookmarkCaption());
  }

  #canDisplayLogo(url) {
    const urlLink = url ?? this.url;
    return /^https?:\/\/.+/.test(urlLink);
  }

  #getDefaultIconForUrl(url) {
    const key = url?.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
    return this.#iconMap[key] ?? this.#iconMap.default;
  }

  #getLogoUrl(url) {
    if (!this.#canDisplayLogo(url)) {
      return this.#getDefaultIconForUrl(url);
    }

    return faviconURL(url, 32);
  }

  get hasOverlay() {
    return this.hasAttribute('has-overlay');
  }
  set hasOverlay(value) {
    if (value) {
      this.setAttribute('has-overlay', '');
    } else {
      this.removeAttribute('has-overlay');
    }
  }

  get isFolder() {
    return this.hasAttribute('is-folder');
  }
  set isFolder(value) {
    if (value) {
      this.setAttribute('is-folder', '');
    } else {
      this.removeAttribute('is-folder');
    }
  }

  get id() {
    return this.getAttribute('data-id');
  }
  set id(value) {
    if (value) {
      this.setAttribute('id', `vb-${value}`);
      this.setAttribute('data-id', value);
    }
  }

  get url() {
    return this.getAttribute('href');
  }
  set url(value) {
    if (value) {
      this.setAttribute('href', value);
    }
  }

  get title() {
    return this.getAttribute('title') || ``;
  }
  set title(value) {
    if (value) {
      this.setAttribute('title', value);
    }
  }

  get image() {
    return this.getAttribute('image');
  }
  set image(value) {
    if (value) {
      this.setAttribute('image', value);
    } else {
      this.removeAttribute('image', value);
    }
  }

  get isCustomImage() {
    return this.hasAttribute('is-custom-image');
  }
  set isCustomImage(value) {
    if (value) {
      this.setAttribute('is-custom-image', '');
    } else {
      this.removeAttribute('is-custom-image');
    }
  }

  get openNewTab() {
    return this.hasAttribute('open-newtab');
  }
  set openNewTab(value) {
    if (value) {
      this.setAttribute('open-newtab', '');
    } else {
      this.removeAttribute('open-newtab');
    }
  }

  get hasTitle() {
    return this.hasAttribute('has-title');
  }
  set hasTitle(value) {
    if (value) {
      this.setAttribute('has-title', '');
    } else {
      this.removeAttribute('has-title');
    }
  }

  get hasFavicon() {
    return this.hasAttribute('has-favicon');
  }
  set hasFavicon(value) {
    if (value) {
      this.setAttribute('has-favicon', '');
    } else {
      this.removeAttribute('has-favicon');
    }
  }

  get isDND() {
    return this.hasAttribute('is-dnd');
  }
  set isDND(value) {
    if (value) {
      this.setAttribute('is-dnd', '');
    } else {
      this.removeAttribute('is-dnd');
    }
  }

  get hasFolderPreview() {
    return this.hasAttribute('has-folder-preview');
  }
  set hasFolderPreview(value) {
    if (value) {
      this.setAttribute('has-folder-preview', '');
    } else {
      this.removeAttribute('has-folder-preview');
    }
  }

  get folderChidlren() {
    return this.#_folderChildren;
  }
  set folderChidlren(children) {
    this.#_folderChildren = children;
  }
}

window.customElements.define('vb-bookmark', VbBookmark, { extends: 'a' });
