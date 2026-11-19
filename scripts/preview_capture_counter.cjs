const assert = require('node:assert/strict');

module.exports = async function countCaptureCalls(home) {
  // Wake the extension before attaching. Edge can expose a worker target before its API bindings exist.
  const url = await home.evaluate(async() => {
    await chrome.runtime.sendMessage({qaWorkerReady:true}).catch(() => undefined);
    return chrome.runtime.getURL('background.js');
  });
  const target = await home.browser().waitForTarget(t => t.type() === 'service_worker' && t.url() === url);
  const session = await target.createCDPSession();
  const evaluate = async expression => {
    const {result, exceptionDetails} = await session.send('Runtime.evaluate', {expression, returnByValue:true});
    assert.equal(exceptionDetails, undefined, 'Failed to inspect the extension screenshot counter');
    return result.value;
  };
  const deadline = Date.now() + 15000;
  while (!await evaluate("typeof globalThis.chrome?.tabs?.captureVisibleTab === 'function'")) {
    assert.ok(Date.now() < deadline, 'The extension worker did not initialize its tabs API');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await evaluate(`(() => {
    const capture = chrome.tabs.captureVisibleTab;
    globalThis.testCaptureCalls = 0;
    chrome.tabs.captureVisibleTab = function(...args) {
      globalThis.testCaptureCalls++;
      return capture.apply(this, args);
    };
    return chrome.tabs.captureVisibleTab !== capture;
  })()`), true);
  return () => evaluate('globalThis.testCaptureCalls');
};
