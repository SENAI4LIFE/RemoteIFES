const path = require("path");
const otaService = require("./src/services/otaService");

function uso() {
  console.log("Uso:");
  console.log("  node firmware-esp32.js                              mostra o firmware publicado");
  console.log("  node firmware-esp32.js <arquivo.bin> <versao> [nota]  publica um firmware para OTA");
  console.log("");
  console.log("Exemplo:");
  console.log("  node firmware-esp32.js ../remoteifes-esp32/.pio/build/esp32dev/firmware.bin 4.0.0 \"correção do watchdog\"");
}

const args = process.argv.slice(2);

if (args.length === 0) {
  const manifesto = otaService.lerManifesto();
  if (!manifesto) {
    console.log("Nenhum firmware publicado.");
  } else {
    console.log(`Versão publicada: ${manifesto.versao}`);
    console.log(`Arquivo:          ${manifesto.arquivo}`);
    console.log(`Tamanho:          ${(manifesto.tamanho / 1024).toFixed(1)} KiB`);
    console.log(`SHA-256:          ${manifesto.sha256}`);
    console.log(`Publicado em:     ${manifesto.publicadoEm}`);
    if (manifesto.notas) console.log(`Notas:            ${manifesto.notas}`);
  }
  console.log("");
  uso();
  process.exit(0);
}

if (args.length < 2) {
  console.error("Informe o caminho do .bin e a versão.");
  uso();
  process.exit(1);
}

const [origem, versao, ...resto] = args;

try {
  const manifesto = otaService.publicarFirmware({
    origem: path.resolve(origem),
    versao,
    notas: resto.join(" "),
  });
  console.log(`Firmware publicado: versão ${manifesto.versao}`);
  console.log(`Tamanho: ${(manifesto.tamanho / 1024).toFixed(1)} KiB`);
  console.log(`SHA-256: ${manifesto.sha256}`);
  console.log("");
  console.log("Ofereça a atualização por sala em Administração > Dispositivos > Firmware / OTA ou pela rota POST /admin/esp32/:sala/ota.");
  process.exit(0);
} catch (erro) {
  console.error(`Falha ao publicar firmware: ${erro.message}`);
  process.exit(1);
}
