import { $customTrigger } from '../../utils';

const EVENTS = {
  OPEN: 'contextmenu:open',
  CLOSE: 'contextmenu:close',
  SELECTION: 'contextmenu:selection'
};

class ContextMenu {
  constructor(menu, options) {
    if (typeof menu === 'string') {
      menu = document.querySelector(menu);
    }
    if (!(menu instanceof HTMLElement)) {
      throw Error('Check the argument of the selector');
    }

    this.menu = menu;

    if (this.menu.active) return;

    this.menu.active = true;

    this.settings = Object.assign({
      tresholdMargin: 10,
      delegateSelector: 'html',
      scrollContainer: window
    }, options);

    this.init();
  }

  init() {
    this.state = false;
    this.trigger = null;

    if (this.settings.scrollContainer !== window) {
      const el = document.querySelector(this.settings.scrollContainer);
      this.scrollContainer = el ? el : window;
    } else {
      this.scrollContainer = window;
    }

    // Menu size
    this.menuWidth = null;
    this.menuHeight = null;

    // Mouse position
    this.menuX = null;
    this.menuY = null;

    this.attachEvents();
  }

  getDOMChildren() {
    this.items = Array.from(this.menu.querySelectorAll('.context-menu__link'));
  }

  attachEvents() {
    this.handlerTrigger = this.handlerTrigger.bind(this);
    this.handlerClick = this.handlerClick.bind(this);
    this.handlerKeyboard = this.handlerKeyboard.bind(this);
    this.handlerClose = this.handlerClose.bind(this);

    this.scrollContainer.addEventListener('scroll', this.handlerClose);
    window.addEventListener('resize', this.handlerClose);
    document.addEventListener('contextmenu', this.handlerTrigger);
    document.addEventListener('keydown', this.handlerKeyboard);
    document.addEventListener('click', this.handlerClick);
  }

  detachEvents() {
    this.scrollContainer.removeEventListener('scroll', this.handlerClose);
    window.removeEventListener('resize', this.handlerClose);
    document.removeEventListener('contextmenu', this.handlerTrigger);
    document.removeEventListener('keydown', this.handlerKeyboard);
    document.removeEventListener('click', this.handlerClick);
  }

  position(e, anchor) {
    this.menu.style.top = 0;
    this.menu.style.left = 0;

    if (anchor) {
      const pos = anchor.getBoundingClientRect();
      this.menuX = pos.left + window.scrollX;
      this.menuY = pos.bottom + window.scrollY + 4;
    } else if (!e.clientX && !e.clientY) {
      // trigger by key
      const target = e.target;
      const pos = target.getBoundingClientRect();
      this.menuX = pos.left + window.pageXOffset;
      this.menuY = pos.top + window.pageYOffset;
    } else {
      this.menuX = e.pageX;
      this.menuY = e.pageY;
    }

    this.menuWidth = this.menu.offsetWidth;
    this.menuHeight = this.menu.offsetHeight;

    const windowWidth = document.documentElement.clientWidth + window.pageXOffset;
    const windowHeight = document.documentElement.clientHeight + window.pageYOffset;

    if ((windowWidth - this.menuX) < this.menuWidth) {
      this.menu.style.left = `${Math.max(0, windowWidth - this.menuWidth - this.settings.tresholdMargin)}px`;
    } else {
      this.menu.style.left = `${this.menuX}px`;
    }

    if ((windowHeight - this.menuY) < this.menuHeight) {
      this.menu.style.top = `${Math.max(0, windowHeight - this.menuHeight - this.settings.tresholdMargin)}px`;
    } else {
      this.menu.style.top = `${this.menuY}px`;
    }
  }

  handlerClose() {
    this.close();
  }

  handlerKeyboard(e) {
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      const card = e.target.closest(this.settings.delegateSelector);
      if (card) this.handlerTrigger(e, e.target);
      return;
    }
    if (!this.state) return;
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault();
      this.close(true);
      return;
    }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;

    e.preventDefault();
    const items = this.enabledItems();
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    const offset = e.key === 'ArrowUp' ? -1 : 1;
    const next = e.key === 'Home' || index < 0 ? 0 : e.key === 'End' ? items.length - 1
      : (index + items.length + offset) % items.length;
    items[next].focus();
  }

  handlerClick(e) {
    if (!this.state) return;

    const menu = e.target.closest('.context-menu');

    if (!menu) {
      this.close();
      return;
    }

    e.preventDefault();
    const action = e.target.closest('.context-menu__link');
    this.select(action);
  }

  handlerTrigger(e, anchor) {
    if (!this.menu || !this.menu.active) return;

    const target = e.target.closest(this.settings.delegateSelector);
    if (target && !target.hidden && !target.hasOverlay) {
      e.preventDefault();
      if (anchor && this.state && anchor === this.anchor) {
        this.close(true);
        return;
      }
      this.close();
      this.trigger = target;
      this.anchor = anchor;
      this.open(e, anchor);
    } else {
      this.close();
    }
  }

  enabledItems() {
    return this.items.filter(item => !item.disabled && !item.classList.contains('is-disabled'));
  }

  select(action) {
    if (action && !action.disabled && !action.classList.contains('is-disabled')) {
      const trigger = this.trigger;
      this.close(true);
      $customTrigger(EVENTS.SELECTION, this.menu, {
        detail: {
          selection: action.dataset.action,
          trigger
        }
      });
    }
  }

  open(e, anchor) {
    if (this.state) return;

    this.state = true;
    this.menu.classList.add('context-menu--open');

    $customTrigger(EVENTS.OPEN, this.menu, {
      detail: {
        trigger: this.trigger
      }
    });
    this.position(e, anchor);

    this.getDOMChildren();
    this.enabledItems()[0]?.focus({ preventScroll: true });
  }

  close(restoreFocus = false) {
    if (!this.state) return;

    this.state = false;
    this.menu.classList.remove('context-menu--open');
    const opener = this.anchor ?? this.trigger;
    if (restoreFocus && opener.isConnected) opener.focus({ preventScroll: true });

    $customTrigger(EVENTS.CLOSE, this.menu, {
      detail: {
        trigger: this.trigger
      }
    });
  }

  destroy() {
    if (!this.menu || !this.menu.active) return;

    this.close();
    this.detachEvents();

    delete this.menu.active;
    Object.keys(this).forEach(property => {
      delete this[property];
    });
  }
}

export default ContextMenu;
