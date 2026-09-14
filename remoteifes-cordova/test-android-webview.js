// Optional DOM diagnostics for the installed DEBUG APK, using existing e2e tooling.
// Release builds remain non-debuggable and use the native smoke/manual procedure.
const path = require('path');
const { _android: android, expect } = require('../e2e/node_modules/@playwright/test');
const fs = require('fs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect({ adb, shell, pkg, dir }) {
  const devices = await android.devices();
  let device = devices.find(d => d.serial() === process.env.ANDROID_SERIAL);
  if (!device) throw new Error('Android device unavailable to Playwright');
  const webview = await device.webView({ pkg });
  let page = await webview.page();
  // Cordova's native bridge also uses prompt(); it can already be handled by the WebView.
  page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
  page.setDefaultTimeout(20000);
  let requests = 0;
  const sockets = new Set();
  const errors = [];
  page.on('request', () => requests++);
  page.on('pageerror', e => errors.push(e.message));
  page.on('websocket', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  async function reconnectAfterDisplayChange() {
    await device.close();
    await shell('am', 'force-stop', pkg);
    await shell('am', 'start', '-n', `${pkg}/.MainActivity`);
    // Attach after Cordova's prompt-based native bridge has initialized.
    await pause(5000);
    device = (await android.devices()).find(d => d.serial() === process.env.ANDROID_SERIAL);
    page = await (await device.webView({ pkg }, { timeout: 30000 })).page();
    page.setDefaultTimeout(20000);
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    page.on('pageerror', e => errors.push(e.message));
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('#mainApp')).toBeVisible({ timeout: 30000 });
  }
  const visible = selector => expect(page.locator(selector)).toBeVisible({ timeout: 30000 });
  const login = async () => {
    await visible('#screen-portal');
    await page.locator('.portal-option[data-tipo="admin"]').click();
    await page.locator('#username').fill(process.env.ANDROID_TEST_USER || 'superadmin');
    await page.locator('#password').fill(process.env.ANDROID_TEST_PASSWORD || 'admin');
    await page.locator('#loginForm button[type=submit]').click();
    await visible('#mainApp');
  };
  const route = async (hash, selector) => {
    await page.evaluate(hash => { location.hash = hash; }, hash);
    await visible(selector);
    await pause(300);
  };
  return {
    async prepare() {
      if (await page.locator('#screen-server-config').isVisible()) {
        await page.locator('#serverConfigUrl').fill(process.env.ANDROID_TEST_ORIGIN || 'http://10.0.2.2:8791');
        await page.locator('#serverConfigForm button[type=submit]').click();
      }
      if (await page.locator('#screen-portal').isVisible()) await login();
      await visible('#mainApp');
      return { url: page.url(), userAgent: await page.evaluate(() => navigator.userAgent) };
    },
    async cycle(i) {
      await route('/sala/A-108', '#screen-panel');
      await expect(page.locator('#panelRoomName')).toContainText('A-108');
      await route('/admin/status', '#adminSub-status');
      await route('/admin/esp32', '#adminSub-esp32');
      await page.locator('#accountMenuBtn').click();
      await page.locator('[data-account-action="logout"]').click();
      await login();
      if (i % 3 === 0) {
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
        await pause(1500);
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 200, downloadThroughput: 1000000, uploadThroughput: 1000000 });
        await route('/salas', '#mainApp');
      }
    },
    async check() { await visible('#mainApp'); if (errors.length) throw new Error(errors.join('; ')); },
    async metrics() {
      const { metrics } = await cdp.send('Performance.getMetrics');
      return { requests, observedOpenSockets: sockets.size,
        ...Object.fromEntries(metrics.filter(m => ['JSHeapUsedSize', 'Nodes', 'JSEventListeners'].includes(m.name)).map(m => [m.name, m.value])) };
    },
    async screens() {
      const results = [];
      const oldSize = await shell('wm', 'size'); const oldDensity = await shell('wm', 'density');
      const oldFont = await shell('settings', 'get', 'system', 'font_scale');
      const oldApp = await page.evaluate(() => Object.fromEntries(['remoteifes_font_scale', 'remoteifes_font_type', 'remoteifes_high_contrast'].map(k => [k, localStorage.getItem(k)])));
      try {
        await shell('settings', 'put', 'system', 'user_rotation', '0');
        await shell('wm', 'density', '160');
        for (const [w, h] of [[320, 800], [360, 800], [400, 900], [480, 960], [800, 1280], [900, 400]]) {
          await shell('wm', 'size', `${w}x${h}`); await pause(1000);
          await reconnectAfterDisplayChange();
          for (const [hash, selector] of [['/sala/A-108', '#screen-panel'], ['/admin/status/sistema', '#statusAba-sistema'], ['/admin/esp32', '#adminSub-esp32'], ['/admin/protocolos', '#adminSub-protocolos']]) {
            await route(hash, selector);
            const layout = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
            results.push({ requested: `${w}x${h}`, hash, restartAfterDisplayChange: true, ...layout, overflow: layout.scrollWidth > layout.width + 1 });
            await page.screenshot({ path: path.join(dir, `screen-${w}-${h}-${hash.split('/').pop()}.png`), fullPage: true });
          }
        }
        await shell('settings', 'put', 'system', 'font_scale', '1.5');
        results.push({ androidFontScale: 1.5, note: 'Applied; screenshot only, no TalkBack validation' });
        await pause(1000);
        await reconnectAfterDisplayChange();
        await page.screenshot({ path: path.join(dir, 'font-scale-1.5.png') });
        await shell('wm', 'size', '360x800'); await pause(1000);
        await reconnectAfterDisplayChange();
        for (const family of ['default', 'serif', 'sans', 'dyslexic']) {
          for (const contrast of [false, true]) {
            await page.evaluate(({ family, contrast }) => {
              const slider = document.getElementById('a11yFontSlider');
              slider.value = '2'; slider.dispatchEvent(new Event('change', { bubbles: true }));
              document.querySelector(`[data-font-type="${family}"]`).click();
              if (document.body.classList.contains('a11y-high-contrast') !== contrast) document.getElementById('a11yContrastToggleBtn').click();
            }, { family, contrast });
            await route('/admin/status/sistema', '#statusAba-sistema');
            const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
            results.push({ androidFontScale: 1.5, appFontScale: 2, family, contrast, ...layout, overflow: layout.scrollWidth > layout.width + 1 });
            await page.screenshot({ path: path.join(dir, `a11y-${family}-${contrast}.png`), fullPage: true });
          }
        }
      } finally {
        if (!page.isClosed()) await page.evaluate(old => {
          for (const [k, value] of Object.entries(old)) { if (value === null) localStorage.removeItem(k); else localStorage.setItem(k, value); }
        }, oldApp).catch(() => {});
        await shell('wm', 'size', oldSize.match(/Override size: (\S+)/)?.[1] || 'reset');
        await shell('wm', 'density', oldDensity.match(/Override density: (\S+)/)?.[1] || 'reset');
        await shell('settings', 'put', 'system', 'font_scale', oldFont);
        fs.writeFileSync(path.join(dir, 'screens.json'), JSON.stringify(results, null, 2));
      }
      if (results.some(r => r.overflow)) throw new Error('Horizontal overflow detected; see screens.json');
      return results;
    },
    async close() {
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
      await device.close();
    },
  };
}
module.exports = { connect };
