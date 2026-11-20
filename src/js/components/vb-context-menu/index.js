import ContextMenu from './contextmenu';
import { $createElement } from '../../utils';

class VbContextMenu extends HTMLElement {
  containerNode = null;
  menuNode = null;
  items = [];

  constructor() {
    super();
  }

  connectedCallback() {
    this.render();

    this.menuInstance = new ContextMenu(this.containerNode, {
      delegateSelector: this.triggerSelector,
      scrollContainer: '.app'
    });
    this.handleMenuOpen = this.handleMenuOpen.bind(this);
    this.handleMenuSelect = this.handleMenuSelect.bind(this);
    this.containerNode.addEventListener('contextmenu:open', this.handleMenuOpen);
    this.containerNode.addEventListener('contextmenu:selection', this.handleMenuSelect);
  }

  disconnectedCallback() {
    this.menuInstance.destroy();
    delete this.menuInstance;
  }

  get listItems() {
    return this.items;
  }

  set listItems(items) {
    if (!this.diffItems(items)) return;

    this.items = structuredClone(items);
    this.setItems();
  }

  get triggerSelector() {
    return this.getAttribute('trigger-selector');
  }

  set triggerSelector(value) {
    this.setAttribute('trigger-selector', value);
  }

  render() {
    this.containerNode = $createElement('div', {
      class: 'context-menu'
    });
    this.menuNode = $createElement('ul', {
      class: 'context-menu__list',
      id: 'bookmarkActionsMenu',
      role: 'menu',
      'aria-label': browser.i18n.getMessage('bookmark_actions') || 'Bookmark actions'
    });
    this.containerNode.append(this.menuNode);
    this.append(this.containerNode);
  }

  setItems() {
    const list = this.items.map(item => {
      const isDisabled = item.disabled ? 'is-disabled' : '';

      if (item.divider) {
        return '<li class="context-menu__item context-menu__item--divider" role="separator"></li>';
      }
      return `<li class="context-menu__item" role="none">
          <button class="context-menu__link ${ isDisabled }" type="button" role="menuitem" tabindex="-1"
            data-action="${ item.action }" ${item.disabled ? 'disabled' : ''}>
            <span class="context-menu__icon" aria-hidden="true">${ item.icon ? item.icon : '' }</span>
            <span>${ item.title }</span>
          </button>
        </li>`;
    }).join('');
    this.menuNode.innerHTML = list;
    this.menuInstance.getDOMChildren();
  }

  close() {
    this.menuInstance.close();
  }

  handleMenuOpen(evt) {
    this.dispatchEvent(
      new CustomEvent('vb:contextmenu:open', {
        detail: evt.detail.trigger,
        bubbles: true,
        cancelable: true
      })
    );
  }

  handleMenuSelect(evt) {
    this.dispatchEvent(
      new CustomEvent('vb:contextmenu:select', {
        detail: {
          trigger: evt.detail.trigger,
          selection: evt.detail.selection
        },
        bubbles: true,
        cancelable: true
      })
    );
  }

  diffItems(newArr) {
    return JSON.stringify(this.listItems) !== JSON.stringify(newArr);

    // if (this.items.length !== newArr.length) {
    //   return true;
    // }

    // const resultArr = this.items.filter(currentItem => {
    //   return !newArr.some(newItem => newItem.action === currentItem.action);
    // });

    // return resultArr.length > 0;
  }
}

window.customElements.define('vb-context-menu', VbContextMenu);
