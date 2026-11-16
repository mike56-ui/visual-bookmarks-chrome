import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

const EXTENSION_DIR = path.join(process.cwd(), '/extension_chrome');

function getChromiumPath() {
  const configuredPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;

  try {
    const bundledPath = puppeteer.executablePath();
    if (fs.existsSync(bundledPath)) return bundledPath;
  } catch {
    // Continue to the shared Playwright cache fallback below.
  }

  const playwrightCache = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (fs.existsSync(playwrightCache)) {
    const cachedChromium = fs.readdirSync(playwrightCache)
      .filter(name => name.startsWith('chromium-'))
      .sort()
      .reverse()
      .map(name => path.join(playwrightCache, name, 'chrome-win64', 'chrome.exe'))
      .find(candidate => fs.existsSync(candidate));
    if (cachedChromium) return cachedChromium;
  }

  throw new Error('Chromium executable not found. Set PUPPETEER_EXECUTABLE_PATH.');
}

async function bootstrap(options = {}) {
  const { devtools = false, slowMo = false } = options;
  const browser = await puppeteer.launch({
    executablePath: getChromiumPath(),
    headless: false,
    pipe: true,
    timeout: 60000,
    devtools,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`
    ],
    ...(slowMo && { slowMo })
  });

  const backgroundPageTarget = await browser.waitForTarget(
    target => target.type() === 'service_worker'
  );
  const extensionId = backgroundPageTarget.url().split('/')[2];
  const extPage = await browser.newPage();
  const extensionUrl = `chrome-extension://${extensionId}/newtab.html`;
  await extPage.goto(extensionUrl, { waitUntil: 'load' });
  await extPage.waitForSelector('#folderDock', { timeout: 30000 });

  return {
    browser,
    extensionUrl,
    extPage
  };
}

export { bootstrap };
