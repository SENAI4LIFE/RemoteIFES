// Runs the simulator build on a booted iOS Simulator: install, launch, relaunch, screenshot and logs.
// Proves the native shell starts and keeps its WKWebView process; it does not inspect the page.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, packageId } = require('./android-tools');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const simctl = (...args) => run('xcrun', ['simctl', ...args]);
function findApp() {
  const dir = path.join(__dirname, 'platforms/ios/build/Debug-iphonesimulator');
  const app = fs.existsSync(dir) && fs.readdirSync(dir).find(name => name.endsWith('.app'));
  if (!app) throw new Error(`No simulator build in ${dir}; run "npm run build-ios -- --emulator" first`);
  return path.join(dir, app);
}
function pickDevice() {
  const requested = process.env.IOS_SIMULATOR_UDID;
  const list = JSON.parse(simctl('list', 'devices', 'available', '-j')).devices;
  const candidates = Object.entries(list)
    .filter(([runtime]) => /iOS/.test(runtime))
    .sort(([a], [b]) => b.localeCompare(a, undefined, { numeric: true }))
    .flatMap(([runtime, devices]) => devices.filter(d => d.isAvailable && /^iPhone/.test(d.name)).map(d => ({ ...d, runtime })));
  const device = requested ? candidates.find(d => d.udid === requested) : candidates[0];
  if (!device) throw new Error(requested ? `Simulator ${requested} is not an available iPhone` : 'No available iPhone simulator');
  return device;
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
async function launch(udid, bundle, settleMs) {
  const out = simctl('launch', udid, bundle);
  const pid = Number(out.match(/:\s*(\d+)\s*$/)?.[1]);
  if (!pid) throw new Error(`simctl launch did not return a pid: ${out}`);
  await sleep(settleMs);
  if (!processAlive(pid)) throw new Error(`App process ${pid} exited within ${settleMs}ms of launch`);
  return pid;
}
async function main() {
  const app = findApp();
  const bundle = packageId();
  const settleMs = Number(process.env.IOS_TEST_SETTLE_MS || 15000);
  const dir = path.join(__dirname, 'build', `ios-test-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const report = { started: new Date().toISOString(), app: path.basename(app), bundle, errors: [] };
  let udid;
  try {
    const device = pickDevice();
    udid = device.udid;
    report.device = { name: device.name, runtime: device.runtime, udid };
    if (device.state !== 'Booted') simctl('boot', udid);
    simctl('bootstatus', udid, '-b');
    report.install = simctl('install', udid, app) || 'ok';
    report.firstLaunch = { pid: await launch(udid, bundle, settleMs) };
    simctl('io', udid, 'screenshot', path.join(dir, 'first-launch.png'));
    simctl('terminate', udid, bundle);
    await sleep(1000);
    if (processAlive(report.firstLaunch.pid)) throw new Error('App process survived simctl terminate');
    report.relaunch = { pid: await launch(udid, bundle, settleMs) };
    simctl('io', udid, 'screenshot', path.join(dir, 'relaunch.png'));
    const log = simctl('spawn', udid, 'log', 'show', '--style', 'compact', '--last', '10m', '--predicate', `process == "${path.basename(app, '.app')}"`);
    fs.writeFileSync(path.join(dir, 'app-log.txt'), log);
    report.webViewEngineLogged = /Using WKWebView/.test(log);
    report.loadErrorLines = log.split('\n').filter(l => /Failed to load webpage/.test(l));
    if (!report.webViewEngineLogged) throw new Error('cordova-ios did not report starting its WKWebView engine');
    if (report.loadErrorLines.length) throw new Error('WKWebView reported load failures; see app-log.txt');
    const crashDir = path.join(os.homedir(), 'Library/Logs/DiagnosticReports');
    report.crashReports = fs.existsSync(crashDir) ? fs.readdirSync(crashDir).filter(f => f.startsWith(path.basename(app, '.app'))) : [];
    if (report.crashReports.length) throw new Error(`Crash reports found: ${report.crashReports.join(', ')}`);
    report.scope = 'simulator install, launch, terminate/relaunch, WKWebView start and screenshots; page content is not inspected';
  } catch (e) { report.errors.push(e.message); process.exitCode = 1; }
  finally {
    try { if (udid) simctl('terminate', udid, bundle); } catch (e) {}
    report.finished = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`iOS report: ${dir}`);
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
