const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { run, tool, defaults, packageId } = require('./android-tools');

function inspect(apk, { mode = 'release', origin = process.env.REMOTEIFES_SERVER_URL } = {}) {
  apk = path.resolve(apk);
  if (!['debug', 'release', 'unsigned'].includes(mode)) throw new Error('mode must be debug, release or unsigned');
  const analyzer = tool('apkanalyzer');
  const manifest = field => run(analyzer, ['manifest', field, apk]);
  const xml = manifest('print');
  const value = (name) => xml.match(new RegExp(`android:${name}="([^"]+)"`))?.[1];
  const metadata = {
    package: xml.match(/\bpackage="([^"]+)"/)?.[1],
    version: value('versionName'), versionCode: Number(value('versionCode')),
    minSdk: Number(value('minSdkVersion')), targetSdk: Number(value('targetSdkVersion')),
    debuggable: value('debuggable') === 'true', cleartext: value('usesCleartextTraffic'),
    permissions: [...xml.matchAll(/<uses-permission\b[^>]*android:name="([^"]+)"/g)].map(m => m[1]),
    bytes: fs.statSync(apk).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(apk)).digest('hex'),
  };
  const requireThat = (ok, msg) => { if (!ok) throw new Error(`APK rejected: ${msg}`); };
  const { dados, problemas } = require('./android-version').verificar();
  requireThat(!problemas.length, problemas.join('; '));
  requireThat(metadata.package === packageId(), 'package ID differs from config.xml');
  requireThat(metadata.version === dados.versionName && metadata.versionCode === dados.versionCode, 'version mismatch');
  requireThat(metadata.minSdk === defaults().MIN_SDK_VERSION && metadata.targetSdk === defaults().SDK_VERSION, 'SDK mismatch');
  requireThat(metadata.debuggable === (mode === 'debug'), 'debuggable mismatch');
  requireThat(metadata.permissions.every(p => ['android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE', `${packageId()}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`].includes(p)), 'unexpected permission');
  const files = run(analyzer, ['files', 'list', apk]);
  requireThat(files.includes('/assets/www/plugins/cordova-plugin-statusbar/www/statusbar.js'), 'StatusBar plugin missing; regenerate platforms and plugins together');
  requireThat(!/\/(?:sw\.js|manifest\.webmanifest|[^/]+\.(?:jks|keystore)|\.env(?:\.[^/]*)?)$/m.test(files), 'PWA or secret file');
  const cat = file => run(analyzer, ['files', 'cat', '--file', file, apk]);
  const config = cat('/assets/www/js/config.js');
  const index = cat('/assets/www/index.html');
  requireThat(index.includes('<script src="cordova.js"></script>'), 'Cordova bootstrap missing');
  // Release resource optimization shortens file names; resolve xml/config from the APK resource table.
  const resources = run(tool('aapt2'), ['dump', 'resources', apk]);
  const configPath = resources.match(/\bxml\/config\r?\n[^\n]*\(file\) (\S+) type=XML/)?.[1];
  requireThat(configPath, 'native Cordova config resource missing');
  const nativeConfig = run(analyzer, ['resources', 'xml', '--file', `/${configPath}`, apk]);
  requireThat(nativeConfig.includes('value="org.apache.cordova.statusbar.StatusBar"'), 'native StatusBar registration missing');
  if (mode !== 'debug') {
    origin = require('./build-android-release').exigirOrigemPublicavel(origin);
    requireThat(config.includes(`empacotado ? ${JSON.stringify(origin)} : servidorPadraoDoNavegador()`), 'embedded server origin differs from release origin');
    requireThat(config.includes(`const appAndroidVersao = ${JSON.stringify(dados.versionName)};`) && config.includes(`const appAndroidBuild = ${JSON.stringify(String(dados.versionCode))};`), 'embedded version mismatch');
    requireThat(metadata.cleartext === String(origin.startsWith('http:')), 'cleartext policy mismatch');
    requireThat(!/<(?:access|allow-navigation)\b[^>]*(?:origin|href)="\*"/.test(nativeConfig), 'wildcard production navigation');
    requireThat(nativeConfig.includes(`origin="${origin}/*"`) && nativeConfig.includes(`href="${origin}/*"`), 'native origin mismatch');
    const schemeTag = nativeConfig.match(/<preference\b[^>]*name="scheme"[^>]*>/)?.[0];
    requireThat(schemeTag?.includes(`value="${new URL(origin).protocol.slice(0, -1)}"`), 'WebView scheme mismatch');
    metadata.serverOrigin = origin;
  }
  if (mode !== 'unsigned') {
    const cert = run(tool('apksigner'), ['verify', '--verbose', '--print-certs', apk]);
    metadata.certificateSha256 = cert.match(/certificate SHA-256 digest:\s*([a-f0-9]{64})/i)?.[1];
    requireThat(metadata.certificateSha256, 'signature not verified');
    metadata.signing = mode === 'debug' ? 'debug' : 'verified';
  } else metadata.signing = 'unsigned; not publishable';
  // Compare packaged web assets with this checkout, allowing only the build's three injections.
  requireThat(!files.split(/\r?\n/).some(f => f.split('/').includes('..')), 'unsafe archive entry');
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'remoteifes-apk-inspect-'));
  try {
    const javaHome = process.env.CORDOVA_JAVA_HOME || process.env.JAVA_HOME;
    const jar = javaHome ? path.join(javaHome, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar') : 'jar';
    run(jar, ['xf', apk, 'assets/www'], { cwd: extracted });
    let compared = 0;
    const allowed = new Set(['cordova.js', 'cordova_plugins.js', 'plugins/cordova-plugin-statusbar/www/statusbar.js']);
    function compare(folder, relative = '') {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        if (['sw.js', 'manifest.webmanifest', '.nojekyll'].includes(entry.name)) continue;
        const rel = path.join(relative, entry.name);
        if (entry.isDirectory()) { compare(path.join(folder, entry.name), rel); continue; }
        let expected = fs.readFileSync(path.join(folder, entry.name));
        if (rel === 'index.html') expected = Buffer.from(expected.toString().replace(/^([ \t]*)<script src="js\/version\.js(?:\?[^"]*)?"><\/script>$/m,
          '$1<script src="cordova.js"></script>\n$&'));
        if (rel === path.join('js', 'config.js') && mode !== 'debug') expected = Buffer.from(expected.toString()
          .replace('empacotado ? "" : servidorPadraoDoNavegador()', `empacotado ? ${JSON.stringify(origin)} : servidorPadraoDoNavegador()`)
          .replace('const appAndroidVersao = null;', `const appAndroidVersao = ${JSON.stringify(dados.versionName)};`)
          .replace('const appAndroidBuild = null;', `const appAndroidBuild = ${JSON.stringify(String(dados.versionCode))};`));
        const actual = path.join(extracted, 'assets', 'www', rel);
        requireThat(fs.existsSync(actual) && expected.equals(fs.readFileSync(actual)), `stale or changed asset: ${rel}`);
        allowed.add(rel.split(path.sep).join('/'));
        compared++;
      }
    }
    compare(path.join(__dirname, '..', 'remoteifes-web'));
    for (const file of files.split(/\r?\n/)) {
      if (file.startsWith('/assets/www/') && !file.endsWith('/')) requireThat(allowed.has(file.slice('/assets/www/'.length)), `unexpected bundled asset: ${file}`);
    }
    metadata.sourceAssetsCompared = compared;
  } finally { fs.rmSync(extracted, { recursive: true, force: true }); }
  return metadata;
}
if (require.main === module) {
  try { console.log(JSON.stringify(inspect(process.argv[2], { mode: process.argv[3] || 'release' }), null, 2)); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { inspect };
