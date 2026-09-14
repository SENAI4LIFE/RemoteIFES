const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function run(command, args = [], options = {}) {
  let result;
  if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(command)) {
    if (!path.isAbsolute(command)) {
      const found = (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, command)).find(file => fs.existsSync(file));
      if (!found) throw new Error(`${command} is not on PATH`);
      command = path.resolve(found);
    }
    const quote = value => {
      if (/["%\r\n!^&|<>]/.test(value)) throw new Error('Unsupported shell character in Android tool argument');
      return `"${value}"`;
    };
    result = spawnSync('cmd.exe', ['/d', '/q', '/s', '/c', `"${[command, ...args].map(quote).join(' ')}"`],
      { encoding: 'utf8', windowsVerbatimArguments: true, ...options });
  } else result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(command)} failed: ${result.error?.message || result.stderr || result.stdout || result.status}`);
  return (result.stdout || '').trim();
}

function sdk() {
  const root = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!root || !fs.existsSync(root)) throw new Error('Set ANDROID_HOME to the installed Android SDK; doctor never installs dependencies.');
  return root;
}

function defaults() { return require('cordova-android/framework/cdv-gradle-config-defaults.json'); }
function tool(name) {
  const override = process.env[`ANDROID_${name.toUpperCase()}`];
  if (override) return override;
  const ext = process.platform === 'win32' ? (['apksigner', 'apkanalyzer'].includes(name) ? '.bat' : '.exe') : '';
  const locations = {
    adb: 'platform-tools', emulator: 'emulator',
    apksigner: `build-tools/${defaults().MIN_BUILD_TOOLS_VERSION}`,
    aapt2: `build-tools/${defaults().MIN_BUILD_TOOLS_VERSION}`,
    apkanalyzer: 'cmdline-tools/latest/bin',
  };
  const file = path.join(sdk(), locations[name], name + ext);
  if (!fs.existsSync(file)) throw new Error(`Missing ${name}; install the required SDK component or set ANDROID_${name.toUpperCase()}.`);
  return file;
}
function packageId() { return fs.readFileSync(path.join(__dirname, 'config.xml'), 'utf8').match(/<widget\s+id="([^"]+)"/)[1]; }
module.exports = { run, sdk, tool, defaults, packageId };
