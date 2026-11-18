import Gmodal from 'glory-modal';
import { $createElement } from '../utils';

const template = /* html */
`<div class="gmodal__container gmodal__container--popup has-center">
  <div class="gmodal__dialog">
    <div class="gmodal__header">
      <div class="gmodal__title">${browser.i18n.getMessage('ext_name')}</div>
      <button type="button" class="gmodal__close md-ripple" data-popup="reject" data-ripple-center>
        <svg version="1.1" width="24" height="24" viewBox="0 0 24 24" fill="#000">
          <path d="M18.984 6.422l-5.578 5.578 5.578 5.578-1.406 1.406-5.578-5.578-5.578 5.578-1.406-1.406 5.578-5.578-5.578-5.578 1.406-1.406 5.578 5.578 5.578-5.578z"></path>
        </svg>
      </button>
    </div>
    <div class="gmodal__body" id="popupBody"></div>
    <div class="gmodal__footer text-right">
      <button type="button" class="btn btn--clear md-ripple" data-popup="reject">${browser.i18n.getMessage('btn_close')}</button>
      <button type="button" class="btn md-ripple" data-popup="resolve">Ok</button>
    </div>
  </div>
</div>`;

function confirmPopup(message) {
  let decision;
  let opened = false;
  const popupEl = $createElement('div',
    {
      class: 'gmodal gmodal--popup',
      id: 'popup'
    },
    {
      html: template
    }
  );
  document.body.appendChild(popupEl);

  const popupBody = popupEl.querySelector('#popupBody');
  const controls = Array.from(popupEl.querySelectorAll('[data-popup]'));
  const resolveControl = popupEl.querySelector('[data-popup="resolve"]');
  const popupInstance = new Gmodal(popupEl, {
    closeBackdrop: false
  });
  popupBody.textContent = message;

  return new Promise((resolve) => {
    const handleClick = function() {
      if (decision !== undefined) return;
      decision = this.dataset.popup === 'resolve';
      if (opened) popupInstance.close();
    };

    popupEl.addEventListener('gmodal:open', () => {
      opened = true;
      if (decision === undefined) resolveControl.focus();
      else popupInstance.close();
    }, { once: true });
    popupEl.addEventListener('gmodal:close', () => {
      controls.forEach(control => control.removeEventListener('click', handleClick));
      popupEl.remove();
      resolve(decision === true);
    }, { once: true });
    controls.forEach(control => control.addEventListener('click', handleClick));
    popupInstance.open();
  });
}


export default confirmPopup;
