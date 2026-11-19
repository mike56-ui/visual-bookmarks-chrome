import '../vb-popup';
import html from './template.html';
import { $createElement } from '../../utils';
import { SEARCH_ENGINES } from '../../constants';
import { settings } from '../../settings';
import { containsPermissions, requestPermissions } from '../../api/permissions';

class VbHeader extends HTMLElement {
  formNode = null;
  inputNode = null;
  suggestNode = null;
  resetNode = null;
  vbPopup = null;
  vbPopupBtn = null;
  vbPopupContent = null;
  vbPopupActive = false;
  engineNodes = [];
  engineIndex = 0;
  prevEngineIndex = 0;
  inputValue = '';

  suggestIndex = -1;
  suggestList = [];
  abortController = null;

  connectedCallback() {
    this.#render();
  }

  disconnectedCallback() {
    this.#dettachEvents();
  }

  #render() {
    this.insertAdjacentHTML('afterbegin', html);
    // form nodes
    this.formNode = this.querySelector('form');
    this.inputNode = this.querySelector('input');
    this.inputNode.setAttribute('aria-label', browser.i18n.getMessage('search') || 'Search');
    this.permSuggestionsNode = this.querySelector('#searchSuggestions');
    this.resetNode = this.querySelector('#searchReset');
    this.buttonSubmitNode = this.querySelector('#searchSubmit');
    // get vb-popup
    this.vbPopup = this.querySelector('vb-popup');
    this.vbPopup.setAttribute('label', browser.i18n.getMessage('toggle_search_popup'));
    this.vbPopupBtn = this.vbPopup.popupTriger;
    this.vbPopupSlotBtn = this.vbPopup.querySelector('[slot="button"]');
    this.vbPopupContent = this.vbPopup.querySelector('[slot="content"]');

    this.#setSearchEngines();
    this.#attachEvents();

    if (settings.$.search_autofocus) {
      this.inputNode.focus();
    }

    this.permSuggestionsNode.dataset.tooltip = browser.i18n.getMessage('search_suggestions_permission_tooltip');
    this.#suggestPermissionButtonVisibility();
  }

  get isBookmarksEngine() {
    return settings.$.search_engine === 'bookmarks';
  }

  get isBrowserEngine() {
    return settings.$.search_engine === 'browser';
  }

  set engine(engine) {
    this.engineNodes[this.prevEngineIndex].classList.remove('is-active');
    const engineObject = SEARCH_ENGINES.find((searchEngine, index) => {
      if (searchEngine.value === engine) {
        this.engineIndex = index;
        return true;
      }
      return false;
    }) ?? SEARCH_ENGINES[0];
    engine = engineObject.value;
    this.engineNodes[this.engineIndex].classList.add('is-active');

    const symbol = engineObject.value === 'browser' ? 'web_search' : engineObject.value;
    this.vbPopupSlotBtn.innerHTML = /* html */`<svg width="16" height="16"><use xlink:href="/img/symbol.svg#${symbol}"/></svg>`;

    const placeholderEngine = engineObject.value === 'bookmarks'
      ? browser.i18n.getMessage('placeholder_input_search_bookmarks')
      : engineObject.title;

    const updateEngine = settings.$.search_engine === engine
      ? Promise.resolve()
      : settings.updateKey('search_engine', engine);
    updateEngine.catch(() => {}).then(() => {
        this.inputNode.placeholder = engine !== 'browser'
          ? browser.i18n.getMessage('placeholder_input_search', [placeholderEngine])
          : browser.i18n.getMessage('search');

        this.inputNode.name = engineObject.name ?? 'bookmarks';
        this.formNode.action = engineObject.url ?? '';

        this.buttonSubmitNode.hidden = this.isBookmarksEngine;

        if (!this.isBookmarksEngine) {
          this.suggestNode?.remove();
          this.suggestNode = $createElement('div', {
            id: 'suggest',
            class: 'suggest',
            hidden: 'hidden'
          });
          this.formNode.append(this.suggestNode);
        } else {
          this.suggestNode?.remove();
          this.suggestNode = null;
        }

        if (settings.$.open_link_newtab) {
          !this.isBookmarksEngine
            ? this.formNode.setAttribute('target', '_blank')
            : this.formNode.removeAttribute('target');
        }

        // when switching engines
        // if search is active, we will display the actual results when the bookmark search returns
        // if we leave the search for bookmarks on the engine, then we need to reset the search results by bookmarks
        if (this.inputNode.value.trim()) {
          this.dispatchEvent(
            new CustomEvent('vb:search', {
              detail: {
                search: this.inputNode.value,
                isBookmarksEngine: this.isBookmarksEngine
              },
              bubbles: true,
              cancelable: true
            })
          );
        }
      });
  }

  async #suggestPermissionButtonVisibility() {
    const shouldCheckPermission = this.isBookmarksEngine;

    if (shouldCheckPermission) {
      this.permSuggestionsNode.hidden = true;
      return;
    }

    const hasSuggestPermission = await containsPermissions({
      origins: ['https://google.com/*']
    });

    this.permSuggestionsNode.hidden = hasSuggestPermission;

    this.inputNode.classList.toggle('lg-offset', !this.permSuggestionsNode.hidden);
  }

  #setSearchEngines() {
    this.vbPopupContent.innerHTML = SEARCH_ENGINES.map(engine => {
      const isActive = engine.value === settings.$.search_engine ? ' is-active' : '';
      return (/* html */
        `<div class="header__engine-item${isActive}" data-engine="${engine.value}">
          ${engine.title}
        </div>`
      );
    }).join('');
    this.engineNodes = Array.from(this.vbPopupContent.children);
    this.engine = settings.$.search_engine;
  }

  #attachEvents() {
    this.handleInput = this.handleInput.bind(this);
    this.inputNode.addEventListener('input', this.handleInput);
    this.permSuggestionsNode.addEventListener('click', this.handleSuggestPermission);

    this.handleReset = this.handleReset.bind(this);
    this.resetNode.addEventListener('click', this.handleReset);

    this.handleSubmit = this.handleSubmit.bind(this);
    this.formNode.addEventListener('submit', this.handleSubmit);

    this.handleClickEngine = this.handleClickEngine.bind(this);
    this.vbPopupContent.addEventListener('click', this.handleClickEngine);

    this.handleKeydownEngine = this.handleKeydownEngine.bind(this);
    this.vbPopup.addEventListener('keydown', this.handleKeydownEngine);

    this.handlePopupState = this.handlePopupState.bind(this);
    this.vbPopup.addEventListener('vb:popup:open', this.handlePopupState);
    this.vbPopup.addEventListener('vb:popup:close', this.handlePopupState);

    this.handleKeydown = this.handleKeydown.bind(this);
    this.inputNode.addEventListener('keydown', this.handleKeydown);

    this.handleClickSuggest = this.handleClickSuggest.bind(this);
    this.formNode.addEventListener('click', this.handleClickSuggest);

    this.handleDocumentKeydown = this.handleDocumentKeydown.bind(this);
    document.addEventListener('keydown', this.handleDocumentKeydown);

    this.handleDocClick = this.handleDocClick.bind(this);
    document.addEventListener('click', this.handleDocClick);
  }

  #dettachEvents() {
    this.inputNode.removeEventListener('input', this.handleInput);
    this.permSuggestionsNode.removeEventListener('click', this.handleSuggestPermission);
    this.resetNode.removeEventListener('click', this.handleReset);
    this.formNode.removeEventListener('submit', this.handleSubmit);
    this.vbPopupContent.removeEventListener('click', this.handleClickEngine);
    this.vbPopup.removeEventListener('keydown', this.handleKeydownEngine);
    this.vbPopup.removeEventListener('vb:popup:open', this.handlePopupState);
    this.vbPopup.removeEventListener('vb:popup:close', this.handlePopupState);
    this.inputNode.removeEventListener('keydown', this.handleKeydown);
    this.formNode.removeEventListener('click', this.handleClickSuggest);
    document.removeEventListener('keydown', this.handleDocumentKeydown);
    document.removeEventListener('click', this.handleDocClick);
  }

  handleSuggestPermission = async() => {
    if (!this.isBookmarksEngine) {
      const permissions = await requestPermissions({ origins: ['https://google.com/*'] });

      if (permissions) {
        this.#suggestPermissionButtonVisibility();
      }
    }
  };

  handlePopupState({ type }) {
    this.vbPopupActive = type === 'vb:popup:open';
  }

  handleKeydownEngine(e) {
    switch (e.code) {
      case 'ArrowUp':
        e.preventDefault();
        this.prevEngineIndex = this.engineIndex;
        this.engineIndex = this.engineIndex - 1;
        if (this.engineIndex < 0) {
          this.engineIndex = this.engineNodes.length - 1;
        }
        this.engine = SEARCH_ENGINES[this.engineIndex].value;
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.prevEngineIndex = this.engineIndex;
        this.engineIndex = (this.engineIndex + 1) % this.engineNodes.length;
        this.engine = SEARCH_ENGINES[this.engineIndex].value;
        break;
      case 'Enter':
      case 'Space':
        if (this.vbPopupActive) {
          this.inputNode.focus();
        }
        break;
    }
  }

  async handleSubmit(e) {
    e.preventDefault();
    if (this.isBookmarksEngine || !this.inputNode.value.trim()) {
      this.inputNode.focus();
      return;
    }
    if (this.isBrowserEngine) {
      const searchPermission = await requestPermissions({ permissions: ['search'] });

      if (searchPermission) {
        browser.search.query({
          text: this.inputNode.value.trim(),
          disposition: settings.$.open_link_newtab ? 'NEW_TAB' : 'CURRENT_TAB'
        });
      }
      return;
    }

    this.formNode.submit();
  }

  handleClickEngine(e) {
    const target = e.target.closest('.header__engine-item');
    if (!target) return;

    this.prevEngineIndex = this.engineNodes.findIndex(engineNode => {
      return engineNode.classList.contains('is-active');
    });
    this.engine = target.dataset.engine;
    this.#suggestPermissionButtonVisibility();
    this.vbPopup.hide();
    this.inputNode.focus();
  }

  handleReset() {
    this.inputNode.value = '';
    if (this.isBookmarksEngine) {
      this.inputNode.dispatchEvent(
        new CustomEvent('vb:searchreset', {
          bubbles: true,
          cancelable: true
        })
      );
    } else {
      this.closeSuggest();
    }

    this.resetNode.classList.remove('is-show');
    this.inputNode.focus();
  }

  handleInput(e) {
    if (e.isComposing) return;
    const search = e.target.value;
    if (this.isBookmarksEngine) {
      this.dispatchEvent(
        new CustomEvent('vb:search', {
          detail: {
            search,
            isBookmarksEngine: this.isBookmarksEngine
          },
          bubbles: true,
          cancelable: true
        })
      );
    } else {
      this.inputValue = e.target.value;
      this.permSuggestionsNode.hidden && this.suggestSearch(e.target.value.trim());
    }

    this.resetNode.classList.toggle('is-show', search.trim().length);
  }

  handleDocumentKeydown(e) {
    if (!settings.$.show_toolbar || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    const active = this.getActiveElement();
    const searchShortcut = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k';
    const slashShortcut = e.code === 'Slash' && !e.ctrlKey && !e.metaKey && !e.altKey
      && !active?.matches('input, textarea, select, [contenteditable]');

    if (e.key === 'Escape' && this.suggestList.length) {
      this.closeSuggest();
    } else if (e.key === 'Escape' && active === this.inputNode && this.inputNode.value) {
      this.handleReset();
    } else if (searchShortcut || slashShortcut) {
      e.preventDefault();
      this.inputNode.focus();
      this.inputNode.select();
    }
  }

  handleDocClick(e) {
    if (!e.target.closest('#searchForm')) {
      this.closeSuggest();
    }
  }

  handleKeydown(e) {
    if (e.isComposing || e.keyCode === 229 || !this.suggestList.length) return true;

    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowDown':
        this.gotoSuggest(e);
        break;
      case 'Enter': this.handleEnterSuggest(e); break;
    }
  }

  getActiveElement() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    }
    return el;
  }

  async suggestSearch(query) {
    this.suggestIndex = -1;
    if (this.abortController) {
      this.abortController.abort();
    }
    if (query.length > 0) {
      try {
        this.suggestList = await this.suggestRequest(query);
      } catch (error) {}
    } else {
      this.suggestList = [];
      this.suggestIndex = -1;
    }

    this.suggestNode.innerHTML = this.suggestList.map((suggest, index) => {
      return `<div data-suggest="${index}">${suggest}</div>`;
    }).join('');
    this.suggestNode.hidden = !this.suggestList.length;
  }

  suggestRequest(query) {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    return fetch(`https://google.com/complete/search?output=toolbar&q=${query}`, { signal })
      .then(response => {
        if (response.ok) {
          return response.text();
        }
        throw new Error(response.statusText);
      })
      .then(str => {
        const xmlDOM = new DOMParser().parseFromString(str, 'text/xml');
        const suggestions = Array
          .from(xmlDOM.querySelectorAll('[data]'))
          .map(suggestion => suggestion.getAttribute('data'));

        return suggestions;
      });
  }

  gotoSuggest(e) {
    e.preventDefault();
    const suggestedList = Array.from(this.suggestNode.querySelectorAll('[data-suggest]'));
    const prevIndex = this.suggestIndex;

    this.suggestIndex = e.key === 'ArrowUp'
      ? this.suggestIndex - 1
      : this.suggestIndex + 1;

    if (this.suggestIndex > this.suggestList.length - 1) {
      this.suggestIndex = -1;
    } else if (this.suggestIndex < -1) {
      this.suggestIndex = this.suggestList.length - 1;
    }

    this.inputNode.value = this.suggestIndex < 0
      ? this.inputValue
      : this.suggestList[this.suggestIndex];

    suggestedList[prevIndex]?.classList.remove('is-active');
    suggestedList[this.suggestIndex]?.classList.add('is-active');
  }

  handleEnterSuggest(e) {
    if (this.suggestIndex > -1) {
      e.preventDefault();
      this.inputNode.value = this.suggestList[this.suggestIndex];
      this.inputNode.focus();
      this.handleSubmit(new Event('submit'));
    }
    this.closeSuggest();
  }

  handleClickSuggest(e) {
    const target = e.target.closest('[data-suggest]');
    if (!target) return true;

    e.preventDefault();
    const selectedIndex = parseInt(target.dataset.suggest);
    this.inputNode.value = this.suggestList[selectedIndex];
    this.inputNode.focus();
    this.handleSubmit(new Event('submit'));
    this.closeSuggest();
  }

  closeSuggest() {
    if (!this.suggestNode || this.suggestNode.hidden) {
      return;
    }

    this.suggestNode.hidden = true;
    this.suggestList = [];
    this.suggestIndex = -1;
  }
}

window.customElements.define('vb-header', VbHeader);
