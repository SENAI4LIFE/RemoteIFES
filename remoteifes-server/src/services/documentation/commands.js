// Canonical reference for commands repeated in the privileged manual. documentation.test.js checks
// the critical groups that also appear in the README. Each smaller group is one manual block;
// mutually alternative or destructive operations have their own groups so they are never read as a
// sequence.
const congelar = (lista) => Object.freeze(lista);

const instalacao = congelar(["cd remoteifes-server", "npm run setup", "npm start"]);
const iniciar = congelar(["cd remoteifes-server", "npm start"]);
const desenvolvimento = congelar(["npm run dev"]);

const servicoInstalar = congelar(["sudo bash install-service.sh"]);
const servicoConsultar = congelar(["sudo systemctl status remoteifes.service", "sudo journalctl -u remoteifes.service -f", "npm run health"]);
const servicoControlar = congelar(["sudo systemctl start remoteifes.service", "sudo systemctl stop remoteifes.service", "sudo systemctl restart remoteifes.service"]);

const proxy = congelar(["sudo bash lan-setup.sh", "sudo bash https-setup.sh <dominio> <email>"]);
const redes = congelar(["npm run redes -- 10.10.0.0/16 192.168.0.0/16", "npm run redes", "sudo systemctl restart remoteifes.service"]);

// Operations Console: installation, access and repair. The Console is the normal path for service
// control, updates, backup/restore and account recovery; the commands below are what still runs
// from a terminal.
const consoleInstalar = congelar(["cd remoteifes-console", "sudo node instalacao/instalar.js --escopo sistema"]);
const consoleAcesso = congelar(["ssh -L 8099:127.0.0.1:8099 <usuario>@<host-do-pi>"]);
const consoleReparo = congelar([
  "sudo systemctl status remoteifes-console.socket",
  "sudo journalctl -u remoteifes-console.service -e",
  "sudo node /opt/remoteifes-console/versoes/<versao>/instalacao/instalar.js --escopo sistema --forcar",
]);
const consoleRemover = congelar([
  "sudo node /opt/remoteifes-console/versoes/<versao>/instalacao/desinstalar.js --simular",
  "sudo node /opt/remoteifes-console/versoes/<versao>/instalacao/desinstalar.js --sim",
]);

const backupCriar = congelar(["npm run backup", "npm run backup -- pre-migracao"]);
const backupRestaurar = congelar(["npm run restore", "npm run restore -- <arquivo>"]);

const deployAtualizar = congelar(["bash deploy.sh", "bash deploy.sh v3.1.0", "bash deploy.sh --offline"]);
const deployReverter = congelar(["bash rollback.sh", "bash rollback.sh v3.0.0"]);
const release = congelar(["bash release.sh 3.1.0"]);

const firmwareUsbFluxo = congelar(["cd remoteifes-esp32", "bash flash.sh", "bash flash.sh /dev/ttyUSB0"]);
const firmwareUsbEtapas = congelar(["pio run", "pio run --target uploadfs", "pio run --target upload"]);
const firmwareUsbSerial = congelar(["pio device monitor -b 115200", "pio device monitor -b 115200 -p /dev/ttyUSB0", "pio device list"]);
const firmwareUsbErase = congelar(["pio run --target erase"]);

const firmwareOta = congelar([
  "pio run -d ../remoteifes-esp32",
  "npm run firmware",
  "npm run firmware -- ../remoteifes-esp32/.pio/build/esp32dev/firmware.bin 4.3.0 \"nota opcional\"",
]);

const credenciaisConsultar = congelar(["npm run credencial -- A-101"]);
const credenciaisEmitir = congelar(["npm run credencial -- A-101 --provisionar", "npm run credencial -- A-101 --rotacionar"]);
const credenciaisDerrubar = congelar(["npm run credencial -- A-101 --substituir", "npm run credencial -- A-101 --revogar"]);

const recuperacaoConta = congelar(["npm run reset-admin -- umaSenhaEscolhida", "npm run reset-admin"]);
const carga = congelar(["npm run carga -- --salas 86 --minutos 2"]);

const androidPreparo = congelar(["cd remoteifes-cordova", "npm ci", "npm run validate"]);
const androidDesenvolvimento = congelar(["npm run prepare-android", "npm run build-android", "npm run run-android"]);
const iosDesenvolvimento = congelar(["npm run prepare-ios", "npm run build-ios", "npm run run-ios"]);
const androidVersao = congelar([
  "npm run android-version",
  "npm run android-version -- 1.1.0",
  "npm run android-version -- --rebuild",
  "npm run android-version -- --verificar",
]);
const androidRede = congelar([
  "npm run harden-config -- https://remoteifes.ifes.edu.br",
  "npm run harden-config -- http://192.168.1.50:8080",
  "npm run dev-config",
]);
const androidRecursos = congelar(["npx cordova-res android --skip-config --copy", "npx cordova-res ios --skip-config --copy"]);
const androidPublicacao = congelar([
  "REMOTEIFES_ANDROID_APK=platforms/android/app/build/outputs/apk/release/app-release.apk \\\nREMOTEIFES_MOBILE_RELEASE_DIR=../remoteifes-server/data/releases/mobile \\\nREMOTEIFES_SERVER_URL=https://remoteifes.ifes.edu.br \\\nANDROID_APKSIGNER=$ANDROID_HOME/build-tools/36.0.0/apksigner \\\nANDROID_APKANALYZER=$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer \\\nnpm run publish-android-release",
]);

const testes = congelar([
  "cd remoteifes-server && npm test",
  "cd remoteifes-server && npm ci && cd ../e2e && npm ci && npx playwright install chromium && npx playwright test",
  "cd remoteifes-cordova && npm ci && npm run validate",
  "cd remoteifes-esp32 && pio run",
  "python3 remoteifes-esp32/tools/serial-smoke.py /dev/ttyUSB0",
]);

const gitSincronizar = congelar(["python3 export.py", "python3 import.py"]);
const gitRecriar = congelar(["python3 clear.py"]);

module.exports = Object.freeze({
  instalacao,
  consoleInstalar,
  consoleAcesso,
  consoleReparo,
  consoleRemover,
  iniciar,
  desenvolvimento,
  servicoInstalar,
  servicoConsultar,
  servicoControlar,
  proxy,
  redes,
  backupCriar,
  backupRestaurar,
  deployAtualizar,
  deployReverter,
  release,
  firmwareUsbFluxo,
  firmwareUsbEtapas,
  firmwareUsbSerial,
  firmwareUsbErase,
  firmwareOta,
  credenciaisConsultar,
  credenciaisEmitir,
  credenciaisDerrubar,
  recuperacaoConta,
  carga,
  androidPreparo,
  androidDesenvolvimento,
  iosDesenvolvimento,
  androidVersao,
  androidRede,
  androidRecursos,
  androidPublicacao,
  testes,
  gitSincronizar,
  gitRecriar,
});
