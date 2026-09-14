const fs = require('fs');
const path = require('path');
const { run, sdk, tool, defaults } = require('./android-tools');
let failures = 0;
function check(name, fn) {
  try { console.log(`OK ${name}: ${fn() || 'present'}`); }
  catch (e) { failures++; console.error(`FAIL ${name}: ${e.message}`); }
}
check('Node', () => {
  const semver = require('semver');
  const range = require('cordova/package.json').engines.node;
  if (!semver.satisfies(process.version, range)) throw new Error(`requires ${range}`);
  return process.version;
});
check('JDK', () => {
  const javaHome = process.env.CORDOVA_JAVA_HOME || process.env.JAVA_HOME;
  const java = javaHome ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  run(java, ['-version']);
  const version = run(javaHome ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac') : 'javac', ['-version']);
  if (!/^javac 17\./.test(version)) throw new Error(`JDK 17 required; found ${version}`);
  return version;
});
check('SDK', sdk);
for (const component of [`platforms/android-${defaults().SDK_VERSION}/android.jar`, `build-tools/${defaults().MIN_BUILD_TOOLS_VERSION}/source.properties`]) {
  check(component, () => { if (!fs.existsSync(path.join(sdk(), component))) throw new Error('not installed'); });
}
for (const [name, args] of [['adb', ['version']], ['emulator', ['-version']], ['apksigner', ['version']], ['apkanalyzer', ['--version']]]) {
  check(name, () => run(tool(name), args).split('\n')[0]);
}
check('Gradle', () => run(process.platform === 'win32' ? 'gradle.bat' : 'gradle', ['--version']).match(/Gradle [\d.]+/)?.[0]);
check('Cordova', () => run(process.execPath, [require.resolve('cordova/bin/cordova'), '--version']));
check('configuration/version', () => {
  const { problemas } = require('./android-version').verificar();
  if (problemas.length) throw new Error(problemas.join('; '));
  const config = new (require('cordova-common').ConfigParser)(path.join(__dirname, 'config.xml'));
  if (!config.packageName() || Number(config.getPreference('android-minSdkVersion', 'android')) !== defaults().MIN_SDK_VERSION) {
    throw new Error('Invalid package ID or minimum SDK');
  }
});
if (process.argv.includes('--release')) {
  check('release origin', () => require('./build-android-release').exigirOrigemPublicavel(process.env.REMOTEIFES_SERVER_URL));
  check('signing inputs (values hidden)', () => {
    for (const name of ['KEYSTORE', 'KEY_ALIAS', 'STORE_PASSWORD', 'KEY_PASSWORD']) {
      if (!process.env[`REMOTEIFES_ANDROID_${name}`]) throw new Error(`missing REMOTEIFES_ANDROID_${name}`);
    }
    if (!fs.statSync(process.env.REMOTEIFES_ANDROID_KEYSTORE).isFile()) throw new Error('keystore missing');
  });
}
process.exitCode = failures ? 1 : 0;
