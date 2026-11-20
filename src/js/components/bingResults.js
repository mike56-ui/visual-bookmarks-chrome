import { bingSearchUrl, searchBing } from '../api/bingSearch';

const SITE = { origins: ['https://www.bing.com/*'] };
const message = key => browser.i18n.getMessage(key);

export function initializeBingResults() {
  const panel = document.getElementById('bingResults');
  const list = document.getElementById('bingResultList');
  const status = document.getElementById('bingStatus');
  const enable = document.getElementById('bingPermission');
  const more = document.getElementById('bingMore');
  let query = '';
  let phase = '';
  let revision = 0;
  let timer;
  let controller;

  function cancel() {
    revision++;
    clearTimeout(timer);
    controller?.abort();
  }
  function show(state, key) {
    phase = state;
    status.textContent = key ? message(key) : '';
    status.hidden = !key;
    enable.hidden = state !== 'permission';
    list.hidden = state !== 'results';
  }
  async function load(term, version) {
    const request = new AbortController();
    controller = request;
    const timeout = setTimeout(() => request.abort(), 9000);
    try {
      const granted = await browser.permissions.contains(SITE);
      if (version !== revision) return;
      if (!granted) {
        show('permission', 'bing_permission_hint');
        return;
      }
      const rows = await searchBing(term, request.signal);
      if (version !== revision) return;
      const links = rows.map(({ title, url }) => {
        const link = document.createElement('a');
        link.dataset.bingResult = '';
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        const name = document.createElement('span');
        name.className = 'bing-result__title';
        name.textContent = title;
        const domain = document.createElement('span');
        domain.className = 'bing-result__domain';
        domain.textContent = new URL(url).hostname;
        link.append(name, domain);
        return link;
      });
      list.replaceChildren(...links);
      if (links.length) show('results');
      else show('empty', 'bing_no_results');
    } catch {
      if (version === revision) show('error', 'bing_unavailable');
    } finally {
      clearTimeout(timeout);
      if (controller === request) controller = undefined;
    }
  }
  function update(term, immediate = false, refreshAccess = false) {
    if (!refreshAccess && term === query && !(term && immediate && (phase === 'queued' || phase === 'error'))) return;
    cancel();
    query = term;
    list.replaceChildren();
    panel.hidden = !term;
    if (!term) {
      more.removeAttribute('href');
      show('idle');
      return;
    }
    more.href = bingSearchUrl(term);
    show('queued', 'bing_loading');
    const version = revision;
    const start = () => {
      show('loading', 'bing_loading');
      load(term, version);
    };
    if (immediate) start();
    else timer = setTimeout(start, 650);
  }
  enable.addEventListener('click', async() => {
    enable.disabled = true;
    try {
      if (await browser.permissions.request(SITE) && query && phase === 'permission') {
        update(query, true, true);
      }
    } catch {
      if (query && phase === 'permission') show('permission', 'bing_permission_hint');
    } finally {
      enable.disabled = false;
    }
  });
  browser.permissions.onAdded.addListener(({ origins }) => {
    if (query && phase === 'permission' && origins?.length) update(query, true, true);
  });
  browser.permissions.onRemoved.addListener(async({ origins }) => {
    if (!query || !origins?.length) return;
    const version = revision;
    if (await browser.permissions.contains(SITE) || revision !== version) return;
    cancel();
    list.replaceChildren();
    show('permission', 'bing_permission_hint');
  });
  return update;
}
