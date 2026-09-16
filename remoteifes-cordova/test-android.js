// Run only on a dedicated test emulator/device. Never clears data implicitly.
const fs = require('fs');
const path = require('path');
const { tool, packageId } = require('./android-tools');
const execFile = require('util').promisify(require('child_process').execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })]); }
  finally { clearTimeout(timer); }
}
// Lowest Chromium/WebView major the frontend supports; index.html feature-detects the same boundary.
const MIN_WEBVIEW_MAJOR = 108;
function webviewVersion(report) {
  const current = report.webview.match(/Current WebView package \(name, version\): \(([^,]+), ([^)]+)\)/);
  if (current) return { pkg: current[1], version: current[2] };
  for (const [pkg, version] of Object.entries(report.webviewPackages || {})) if (version) return { pkg, version };
  return null;
}
async function main() {
  const serial = process.env.ANDROID_SERIAL;
  if (!serial) throw new Error('Set ANDROID_SERIAL explicitly to a dedicated test device.');
  const apk = process.argv[2];
  if (!apk) throw new Error('Usage: npm run test-android -- <apk> [--webview]');
  const count = Number(process.env.ANDROID_TEST_CYCLES || 10);
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('ANDROID_TEST_CYCLES must be 1..1000');
  const pkg = packageId();
  const adb = async (...args) => {
    try {
      const { stdout } = await execFile(tool('adb'), ['-s', serial, ...args], { timeout: 60000, maxBuffer: 32 * 1024 * 1024 });
      return stdout.trim();
    } catch (e) { throw new Error(`ADB ${args.slice(0, 3).join(' ')} failed: ${e.message}`); }
  };
  const shell = (...args) => adb('shell', ...args);
  const dir = path.join(__dirname, 'build', `android-test-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const dumpUi = async (name) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const dumped = await shell('uiautomator', 'dump', '/sdcard/remoteifes-smoke.xml');
      if (/dumped to:/.test(dumped)) {
        await adb('pull', '/sdcard/remoteifes-smoke.xml', path.join(dir, `${name}.xml`));
        const ui = fs.readFileSync(path.join(dir, `${name}.xml`), 'utf8');
        if ([...ui.matchAll(/<node\b[^>]*>/g)].some(([node]) => node.includes(`package="${pkg}"`) && /text="[^"]+"/.test(node))) return ui;
      }
      await sleep(1000);
    }
    return '';
  };
  const report = { started: new Date().toISOString(), serial, apk: path.basename(apk),
    apkSha256: require('crypto').createHash('sha256').update(fs.readFileSync(apk)).digest('hex'), cycles: [], errors: [] };
  const previous = {
    rotation: await shell('settings', 'get', 'system', 'user_rotation'),
    auto: await shell('settings', 'get', 'system', 'accelerometer_rotation'),
  };
  let browser;
  try {
    report.api = await shell('getprop', 'ro.build.version.sdk');
    report.android = await shell('getprop', 'ro.build.version.release');
    report.webview = await shell('dumpsys', 'webviewupdate');
    // Android 7 images may not implement dumpsys webviewupdate.
    if (!report.webview.trim()) {
      report.webviewPackages = {};
      for (const candidate of ['com.google.android.webview', 'com.android.webview', 'com.android.chrome']) {
        const details = await shell('dumpsys', 'package', candidate);
        report.webviewPackages[candidate] = details.match(/versionName=([^\s]+)/)?.[1] || null;
      }
    }
    report.size = await shell('wm', 'size'); report.density = await shell('wm', 'density');
    report.install = await adb('install', '-r', path.resolve(apk));
    await adb('logcat', '-c');
    const launch = () => shell('am', 'start', '-n', `${pkg}/.MainActivity`);
    await shell('am', 'force-stop', pkg);
    report.coldStart = await shell('am', 'start', '-W', '-n', `${pkg}/.MainActivity`);
    if (!/Status: ok/.test(report.coldStart)) throw new Error('Android did not confirm a successful cold start');
    await sleep(process.argv.includes('--webview') ? 5000 : 2000);
    const webview = webviewVersion(report);
    const major = webview ? Number(webview.version.split('.')[0]) : null;
    report.webviewVersion = webview;
    report.incompatibilityScreen = /text="Navegador desatualizado"/.test(await dumpUi('start-ui'));
    if (report.incompatibilityScreen && !webview) throw new Error('The app showed the incompatibility screen and the WebView version could not be determined');
    if (report.incompatibilityScreen && major >= MIN_WEBVIEW_MAJOR) throw new Error(`WebView ${webview.version} is supported but the app showed the incompatibility screen`);
    if (!report.incompatibilityScreen && major !== null && major < MIN_WEBVIEW_MAJOR) throw new Error(`WebView ${webview.version} is below the minimum ${MIN_WEBVIEW_MAJOR} but the app did not show the incompatibility screen`);
    if (report.incompatibilityScreen && process.argv.includes('--webview')) throw new Error(`--webview diagnostics need WebView ${MIN_WEBVIEW_MAJOR}+; this device has ${webview.version}`);
    let scenario;
    if (process.argv.includes('--webview')) {
      const { connect } = require('./test-android-webview');
      scenario = await bounded(connect({ adb, shell, pkg, dir }), 45000, 'WebView connection');
      browser = scenario;
      report.uiFlows = await scenario.prepare();
    }
    await shell('settings', 'put', 'system', 'accelerometer_rotation', '0');
    for (let i = 0; i < count; i++) {
      const started = Date.now();
      if (scenario) await scenario.cycle(i);
      await shell('settings', 'put', 'system', 'user_rotation', String(i % 2));
      await shell('input', 'keyevent', 'KEYCODE_HOME'); await sleep(500);
      await launch(); await sleep(500);
      if (scenario) await scenario.check();
      const pid = await shell('pidof', pkg);
      if (!pid) throw new Error(`App process absent in cycle ${i + 1}`);
      const memory = await shell('dumpsys', 'meminfo', pkg);
      fs.writeFileSync(path.join(dir, `memory-${i + 1}.txt`), memory);
      report.cycles.push({ cycle: i + 1, elapsedMs: Date.now() - started, pid,
        totalPssKb: Number(memory.match(/TOTAL PSS:\s*(\d+)/)?.[1] || memory.match(/TOTAL\s+(\d+)/)?.[1]) || null,
        ...(scenario ? await scenario.metrics() : {}) });
      fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
      console.log(`Android cycle ${i + 1}/${count} completed`);
    }
    if (scenario && process.env.ANDROID_TEST_SCREENS !== '0') report.screenMatrix = await scenario.screens();
    if (scenario) await bounded(scenario.close(), 10000, 'WebView disconnect');
    browser = null;
    await shell('am', 'force-stop', pkg); report.processRestart = await launch();
    let restarted = false;
    for (let attempt = 0; attempt < 15; attempt++) {
      await sleep(1000);
      try { if (await shell('pidof', pkg)) { restarted = true; break; } } catch (_) {}
    }
    if (!restarted) throw new Error('No process within 15 seconds after restart');
    const finalUi = await dumpUi('final-ui');
    report.finalUiTextNodes = [...finalUi.matchAll(/<node\b[^>]*>/g)]
      .filter(([node]) => node.includes(`package="${pkg}"`) && /text="[^"]+"/.test(node)).length;
    if (!report.finalUiTextNodes) throw new Error('No accessible text in final UI; a live process alone is insufficient');
    if (report.incompatibilityScreen && !/text="Navegador desatualizado"/.test(finalUi)) throw new Error('The incompatibility screen did not survive the lifecycle cycles');
    await shell('screencap', '-p', '/sdcard/remoteifes-smoke.png');
    await adb('pull', '/sdcard/remoteifes-smoke.png', path.join(dir, 'final-screen.png'));
    report.scope = report.incompatibilityScreen ? `WebView ${webview.version} is below the minimum ${MIN_WEBVIEW_MAJOR}: the app showed the incompatibility screen and stayed alive; nothing else is validated on this device`
      : scenario ? 'UI flows plus native lifecycle; see uiFlows and screenMatrix for actual coverage' : 'native install/launch/lifecycle only; does not prove login, network or UI correctness';
  } catch (e) { report.errors.push(e.message); process.exitCode = 1; }
  finally {
    try { if (browser) await bounded(browser.close(), 10000, 'WebView disconnect'); } catch (_) {}
    for (const [key, value] of [['user_rotation', previous.rotation], ['accelerometer_rotation', previous.auto]]) {
      try {
        await shell('settings', ...(value === 'null' ? ['delete', 'system', key] : ['put', 'system', key, value]));
      } catch (e) { report.errors.push(e.message); process.exitCode = 1; }
    }
    try {
      const logs = await adb('logcat', '-d', '-v', 'threadtime');
      fs.writeFileSync(path.join(dir, 'logcat.txt'), logs);
      report.fatalLogLines = logs.split('\n').filter(l => /FATAL EXCEPTION|ANR in |am_anr|Render process.*crash|Fatal signal/.test(l));
      if (report.fatalLogLines.length) { report.errors.push('Fatal log entries require review'); process.exitCode = 1; }
      report.webviewErrorLines = logs.split('\n').filter(l => /INFO:CONSOLE.*Uncaught |deviceready has not fired/.test(l));
      if (report.webviewErrorLines.length) { report.errors.push('WebView errors require review'); process.exitCode = 1; }
    } catch (e) { report.errors.push(e.message); process.exitCode = 1; }
    report.finished = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`Android report: ${dir}`);
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => process.exit(process.exitCode || 0));
