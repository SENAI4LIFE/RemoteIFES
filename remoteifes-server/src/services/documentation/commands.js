// Referência canônica para comandos repetidos no manual privilegiado.
// documentation.test.js confere os grupos críticos que também aparecem no README.
module.exports = Object.freeze({
  instalacao: Object.freeze([
    "cd remoteifes-server",
    "npm run setup",
    "npm start",
  ]),
  desenvolvimento: Object.freeze([
    "cd remoteifes-server",
    "npm start",
    "npm run dev",
  ]),
  servico: Object.freeze([
    "sudo bash install-service.sh",
    "sudo systemctl status remoteifes.service",
    "sudo systemctl start remoteifes.service",
    "sudo systemctl stop remoteifes.service",
    "sudo systemctl restart remoteifes.service",
    "sudo journalctl -u remoteifes.service -f",
    "npm run health",
  ]),
  proxy: Object.freeze([
    "sudo bash lan-setup.sh",
    "sudo bash https-setup.sh <dominio> <email>",
  ]),
  redes: Object.freeze([
    "npm run redes -- 10.10.0.0/16 192.168.0.0/16",
    "npm run redes",
    "sudo systemctl restart remoteifes.service",
  ]),
  backup: Object.freeze([
    "npm run backup",
    "npm run backup -- pre-migracao",
    "npm run restore",
    "npm run restore -- <arquivo>",
  ]),
  deploy: Object.freeze([
    "bash deploy.sh",
    "bash deploy.sh v3.1.0",
    "bash deploy.sh --offline",
    "bash rollback.sh",
    "bash rollback.sh v3.0.0",
    "bash release.sh 3.1.0",
  ]),
  firmwareUsb: Object.freeze([
    "cd remoteifes-esp32",
    "bash flash.sh",
    "bash flash.sh /dev/ttyUSB0",
    "pio run --target erase",
    "pio run",
    "pio run --target uploadfs",
    "pio run --target upload",
    "pio device monitor -b 115200",
    "pio device monitor -b 115200 -p /dev/ttyUSB0",
    "pio device list",
  ]),
  firmwareOta: Object.freeze([
    "pio run -d ../remoteifes-esp32",
    "npm run firmware",
    "npm run firmware -- ../remoteifes-esp32/.pio/build/esp32dev/firmware.bin 4.0.1 \"nota opcional\"",
  ]),
  credenciais: Object.freeze([
    "npm run credencial -- A-101 --provisionar",
    "npm run credencial -- A-101 --rotacionar",
    "npm run credencial -- A-101 --substituir",
    "npm run credencial -- A-101 --revogar",
    "npm run credencial -- A-101",
  ]),
  recuperacaoConta: Object.freeze([
    "npm run reset-admin -- umaSenhaEscolhida",
    "npm run reset-admin",
  ]),
  carga: Object.freeze([
    "npm run carga -- --salas 86 --minutos 2",
  ]),
  androidBasico: Object.freeze([
    "cd remoteifes-cordova",
    "npm ci",
    "npm run prepare-android",
    "npm run prepare-ios",
    "npm run build-android",
    "npm run build-android-release",
    "npm run run-android",
    "npm run build-ios",
    "npm run run-ios",
    "npm run validate",
  ]),
  androidVersao: Object.freeze([
    "npm run android-version",
    "npm run android-version -- 1.1.0",
    "npm run android-version -- --rebuild",
    "npm run android-version -- --verificar",
  ]),
  androidRede: Object.freeze([
    "npm run harden-config -- https://remoteifes.ifes.edu.br",
    "npm run harden-config -- http://192.168.1.50:8080",
    "npm run dev-config",
  ]),
  androidRecursos: Object.freeze([
    "npx cordova-res android --skip-config --copy",
    "npx cordova-res ios --skip-config --copy",
  ]),
  androidPublicacao: Object.freeze([
    "REMOTEIFES_ANDROID_APK=platforms/android/app/build/outputs/apk/release/app-release.apk \\\nREMOTEIFES_MOBILE_RELEASE_DIR=../remoteifes-server/data/releases/mobile \\\nREMOTEIFES_SERVER_URL=https://remoteifes.ifes.edu.br \\\nANDROID_APKSIGNER=$ANDROID_HOME/build-tools/36.0.0/apksigner \\\nANDROID_APKANALYZER=$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer \\\nnpm run publish-android-release",
  ]),
  testes: Object.freeze([
    "cd remoteifes-server && npm test",
    "cd e2e && npm install && npx playwright install chromium && npx playwright test",
    "cd remoteifes-cordova && npm ci && npm run validate",
    "cd remoteifes-esp32 && pio run",
    "python3 remoteifes-esp32/tools/serial-smoke.py /dev/ttyUSB0",
  ]),
  git: Object.freeze([
    "python export.py",
    "python import.py",
    "python clear.py",
  ]),
});
