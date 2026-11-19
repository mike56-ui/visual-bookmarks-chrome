const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { webcrypto } = require('node:crypto');
const vm = require('node:vm');

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32"/></svg>';
const decline = async() => false;
const accept = async() => true;
const declaration = (url) => ({url, type:'image/svg+xml', sizes:'any'});

async function fixture({ guard = true, response } = {}) {
  const requests = [];
  const records = new Map();
  const RequestWithAddressSpace = class extends Request {
    constructor(url, options) {
      super(url, options);
      if (guard) this.targetAddressSpace = options.targetAddressSpace;
    }
  };
  const context = vm.createContext({
    URL, Blob, crypto:webcrypto, Request:RequestWithAddressSpace, AbortController, setTimeout, clearTimeout,
    async fetch(request) {
      requests.push(request);
      const reply = response?.(request) ?? new Response(SVG, {headers:{'content-type':'image/svg+xml'}});
      if (!reply.url) Object.defineProperty(reply, 'url', {value:request.url});
      return reply;
    }
  });
  const source = readFileSync(join(__dirname, '../src/js/siteIconCapture.js'), 'utf8');
  const module = new vm.SourceTextModule(source, {context});
  const exports = {
    MAX_ICON_BYTES:128 * 1024,
    readSiteIcon:async origin => records.get(origin),
    saveSiteIcon:async (record,current) => {
      if (!current()) return false;
      records.set(record.origin, {...record, updated:Date.now()});
      return true;
    },
    siteOrigin(value) {
      try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
      } catch { return null; }
    }
  };
  await module.link(name => {
    assert.equal(name, './api/siteIcons');
    return new vm.SyntheticModule(Object.keys(exports), function() {
      for (const [key, value] of Object.entries(exports)) this.setExport(key,value);
    }, {context});
  });
  await module.evaluate();
  return {capture:module.namespace.cacheDeclaredSiteIcon, requests, records};
}

module.exports = async function checkSiteIconPolicy() {
  const site = 'https://github.com/';
  const github = 'https://github.githubassets.com/favicons/favicon.svg';
  let test = await fixture();
  const result = await test.capture(site,[declaration(github)],() => true,accept);
  assert.equal(result,'https://github.com');
  assert.equal(test.records.get(result).vector,true);
  assert.equal(test.requests.length,1);
  assert.equal(test.requests[0].url,github);
  assert.equal(test.requests[0].credentials,'omit');
  assert.equal(test.requests[0].referrerPolicy,'no-referrer');
  assert.equal(test.requests[0].redirect,'error');
  assert.equal(test.requests[0].targetAddressSpace,'public');
  await test.capture(site,[declaration(github)],() => true,accept);
  assert.equal(test.requests.length,1,'Cached icons are not refetched every visit');

  test = await fixture();
  const subdomainAsset = 'https://assets.contoso.com/images/brand.svg';
  const sameSite = await test.capture('https://contoso.com/',[declaration(subdomainAsset)],() => true,accept);
  assert.equal(sameSite,'https://contoso.com');
  assert.equal(test.requests[0].url,subdomainAsset);

  test = await fixture();
  await test.capture(site, [
    'http://github.githubassets.com/favicons/favicon.svg',
    'https://github.githubassets.com:444/favicons/favicon.svg',
    'https://username:password@github.githubassets.com/favicons/favicon.svg',
    'https://github.githubassets.com/favicons/favicon.svg?credential=example',
    'https://github.githubassets.com/anything-else/favicon.svg',
    'https://github.githubassets.com.example.com/favicons/favicon.svg',
    'https://example.org/favicon.svg',
    'https://127.0.0.1/favicon.svg',
    'https://[::1]/favicon.svg',
    'https://host.local/favicon.svg',
    'https://assets.github.com/icon.html'
  ].map(declaration),() => true,accept);
  assert.equal(test.requests.length,0,'Block unrelated, credentialed, non-image, insecure and private targets');
  test = await fixture();
  await test.capture('https://unrelated.example.com/',[declaration(github)],() => true,accept);
  assert.equal(test.requests.length,0,'CDN authorization is scoped to the declaring site');
  await test.capture('https://github.com:444/',[declaration(github)],() => true,accept);
  assert.equal(test.requests.length,0,'A nonstandard source port does not inherit the public CDN mapping');
  test = await fixture();
  await test.capture(site,[declaration(github)],() => true,decline);
  assert.equal(test.requests.length,0,'Never fetch without the active visit permission');

  test = await fixture({guard:false});
  await test.capture(site,[declaration(github)],() => true,accept);
  assert.equal(test.requests.length,0,'Do not fetch cross-origin without native public-address validation');
  const local = 'http://127.0.0.1:8000';
  await test.capture(local+'/',[declaration(local+'/brand.svg')],() => true,accept);
  assert.ok(test.records.has(local),'Preserve isolated same-origin icon support');

  for (const response of [
    () => new Response('<html/>',{headers:{'content-type':'text/html'}}),
    () => new Response(SVG,{headers:{'content-type':'image/svg+xml','content-length':String(128 * 1024 + 1)}}),
    () => new Response(SVG+' '.repeat(128 * 1024),{headers:{'content-type':'image/svg+xml'}}),
    () => {
      const redirect = new Response(SVG,{headers:{'content-type':'image/svg+xml'}});
      Object.defineProperty(redirect,'redirected',{value:true});
      Object.defineProperty(redirect,'url',{value:'https://example.com/favicon.svg'});
      return redirect;
    }
  ]) {
    test = await fixture({response});
    await test.capture(site,[declaration(github)],() => true,accept);
    assert.equal(test.records.size,0,'Reject unsupported, oversized or redirected content');
  }
  console.log('PASS: site-declared CDN policy, authorization, no credentials/referrer, same-origin fallback and payload bounds');
};
