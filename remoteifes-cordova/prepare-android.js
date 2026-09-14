const fs = require('fs');
const path = require('path');
const { run } = require('./android-tools');
const cordova = require.resolve('cordova/bin/cordova');
try {
  run(process.execPath, [path.join(__dirname, 'sync-www.js')], { stdio: 'inherit' });
  if (!fs.existsSync(path.join(__dirname, 'platforms/android'))) {
    // Without its native platform, this generated bookkeeping is stale and would
    // make Cordova skip reinstalling native plugin files into the new platform.
    fs.rmSync(path.join(__dirname, 'plugins', 'android.json'), { force: true });
    // Use the package installed by npm ci instead of resolving the semver range again.
    const installedAndroid = `cordova-android@${require('cordova-android/package.json').version}`;
    run(process.execPath, [cordova, 'platform', 'add', installedAndroid, '--nosave'], { stdio: 'inherit' });
  }
  run(process.execPath, [cordova, 'prepare', 'android'], { stdio: 'inherit' });
} catch (e) { console.error(e.message); process.exitCode = 1; }
