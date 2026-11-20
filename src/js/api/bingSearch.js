const MAX_FEED_BYTES = 256 * 1024;
const MAX_RESULTS = 3;

export function bingSearchUrl(query) {
  const url = new URL('https://www.bing.com/search');
  url.searchParams.set('q', query.trim());
  return url.href;
}

async function readFeed(response) {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > MAX_FEED_BYTES) {
    await response.body?.cancel();
    throw new Error('Bing search feed unavailable');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let xml = '';
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      const { value } = chunk;
      size += value.byteLength;
      if (size > MAX_FEED_BYTES) {
        await reader.cancel();
        throw new Error('Bing search feed exceeded the size limit');
      }
      xml += decoder.decode(value, { stream: true });
    }
    return xml + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function plainText(item, field, limit) {
  let value = item.querySelector(':scope > ' + field)?.textContent || '';
  // RSS can carry escaped HTML. Template contents stay inert and never enter the page.
  if (/<[a-z!/]|&(?:#\d+|#x[\da-f]+|\w+);/i.test(value)) {
    const template = document.createElement('template');
    template.innerHTML = value;
    template.content.querySelectorAll('script,style,noscript').forEach(node => node.remove());
    value = template.content.textContent;
  }
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

export async function searchBing(query, signal) {
  if (!query.trim()) return [];
  const url = new URL(bingSearchUrl(query));
  url.searchParams.set('format', 'rss');
  const response = await fetch(url.href, {
    signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store'
  });
  const xml = await readFeed(response);
  if (/<!DOCTYPE\b/i.test(xml)) throw new Error('Unexpected Bing search document');
  const feed = new DOMParser().parseFromString(xml, 'application/xml');
  const channel = feed.documentElement.localName === 'rss' && feed.documentElement.querySelector(':scope > channel');
  if (!channel || feed.querySelector('parsererror')) throw new Error('Invalid Bing search feed');

  const results = [];
  const seen = new Set();
  for (const item of channel.querySelectorAll(':scope > item')) {
    let link;
    try {
      link = new URL(item.querySelector(':scope > link')?.textContent.trim());
    } catch {
      continue;
    }
    if (!['https:', 'http:'].includes(link.protocol) || link.username || link.password || seen.has(link.href)) continue;
    const title = plainText(item, 'title', 300);
    if (!title) continue;
    seen.add(link.href);
    results.push({ title, url: link.href, description: plainText(item, 'description', 400) });
    if (results.length === MAX_RESULTS) break;
  }
  return results;
}
