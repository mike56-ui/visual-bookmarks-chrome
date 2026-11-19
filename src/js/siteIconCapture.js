import { MAX_ICON_BYTES, readSiteIcon, saveSiteIcon, siteOrigin } from './api/siteIcons';

const RECHECK_INTERVAL = 7 * 24 * 60 * 60 * 1000;
const RETRY_INTERVAL = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const nextTry = new Map();
const approvedTypes = new Set(['image/png', 'image/webp', 'image/jpeg', 'image/svg+xml',
  'image/x-icon', 'image/vnd.microsoft.icon']);
const githubPages = new Set(['github.com', 'www.github.com']);
const publicHostname = /^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z](?:[a-z\d-]{0,61}[a-z\d])?$/i;
const localHostname = /(?:^|\.)(?:localhost|local|internal|lan|corp|home|test|invalid|example|onion)$/i;
const staticImagePath = /\.(?:ico|svg|png|webp|jpe?g)$/i;

function iconTarget(origin, declared) {
  if (typeof declared !== 'string' || declared.length > 2048 || !siteOrigin(declared)) return;
  const icon = new URL(declared);
  icon.hash = '';
  if (icon.origin === origin) return { url: icon.href, cdn: false };

  const page = new URL(origin);
  if (icon.protocol !== 'https:' || page.port || icon.port || icon.search || !staticImagePath.test(icon.pathname)
    || !publicHostname.test(icon.hostname) || localHostname.test(icon.hostname)
    || !publicHostname.test(page.hostname) || localHostname.test(page.hostname)) return;

  // An arbitrary link in an editable page is not sufficient to authorize a cross-origin fetch.
  const knownGitHubAsset = githubPages.has(page.hostname) && icon.hostname === 'github.githubassets.com'
    && /^\/favicons\/favicon(?:-[a-z\d_-]+)?\.(?:svg|png|ico)$/i.test(icon.pathname);
  if (knownGitHubAsset || icon.hostname.endsWith('.' + page.hostname)) return { url: icon.href, cdn: true };
}

function declarationScore({ url, sizes, type }) {
  if (type === 'image/svg+xml' || /\.svg(?:$|[?#])/i.test(url)) return 1024;
  const possibleSizes = Array.from(sizes.matchAll(/(\d+)x(\d+)/gi),
    match => Math.min(Number(match[1]), Number(match[2])));
  return Math.min(768, Math.max(0, ...possibleSizes)) || 32;
}

async function fetchImage(url, cdn) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  let reader;
  try {
    const request = new Request(url, {
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal,
      ...(cdn && { targetAddressSpace: 'public' })
    });
    // On browsers without an address-space guard, leave cross-origin icons to their native favicon cache.
    if (cdn && request.targetAddressSpace !== 'public') return;
    const response = await fetch(request);
    const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    const length = Number(response.headers.get('content-length'));
    if (!response.ok || response.redirected || response.url !== request.url
      || !approvedTypes.has(type) || length > MAX_ICON_BYTES || !response.body) return;
    reader = response.body.getReader();
    const parts = [];
    let total = 0;
    while (total <= MAX_ICON_BYTES) {
      const { done, value } = await reader.read();
      if (done) return new Blob(parts, { type });
      total += value.byteLength;
      parts.push(value);
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
    reader?.releaseLock();
  }
}

async function imageDetails(blob) {
  const vector = blob.type === 'image/svg+xml';
  if (vector) {
    const svg = await blob.text();
    if (!/<svg(?:\s|>)/i.test(svg) || /<!DOCTYPE|<!ENTITY|<(?:[\w.-]+:)?(?:image|feImage|script|foreignObject)\b/i.test(svg)) {
      return;
    }
    return { blob, vector, score: 1024 };
  }
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = bitmap;
    const score = Math.min(width, height);
    if (score >= 32 && width <= 1024 && height <= 1024) return { blob, vector, width, height, score };
  } finally {
    bitmap.close();
  }
}

export async function cacheDeclaredSiteIcon(pageUrl, declarations, current, isAuthorized) {
  const origin = siteOrigin(pageUrl);
  if (!origin || !declarations?.length || (nextTry.get(origin) ?? 0) > Date.now()) return;
  if (nextTry.size >= 256) nextTry.delete(nextTry.keys().next().value);
  nextTry.set(origin, Date.now() + RETRY_INTERVAL);

  const cached = await readSiteIcon(origin);
  if (cached && Date.now() - cached.updated < RECHECK_INTERVAL) return;
  const unique = new Map();
  for (const declaration of declarations) {
    const target = iconTarget(origin, declaration.url);
    if (target) unique.set(target.url, { ...declaration, ...target });
  }
  const candidates = [...unique.values()].sort((a, b) => declarationScore(b) - declarationScore(a));
  let best;
  for (const { url, cdn } of candidates.slice(0, MAX_ATTEMPTS)) {
    if (!current() || !await isAuthorized() || !current()) return;
    try {
      const blob = await fetchImage(url, cdn);
      if (!blob?.size) continue;
      const image = await imageDetails(blob);
      if (image && (!best || best.score < image.score)) best = image;
      if (best?.score >= 96) break;
    } catch {
      // Keep the native browser favicon if an icon is unavailable or unreadable.
    }
  }
  if (!best || !current()) return;
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await best.blob.arrayBuffer()));
  const digest = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
  if (!await isAuthorized() || !current()) return;
  const { blob, vector, width, height } = best;
  return await saveSiteIcon({ origin, blob, vector, width, height, digest }, current) ? origin : undefined;
}
