const credenciaisService = require("./src/services/esp32CredenciaisService");
const salasService = require("./src/services/salasService");

function fecharBanco() {
  try {
    require("./src/config/database").close();
  } catch {}
}

function uso() {
  console.log("Uso:");
  console.log("  node credencial-esp32.js <sala>                estado da credencial da sala");
  console.log("  node credencial-esp32.js <sala> --provisionar  cria a credencial (mostra o segredo uma vez)");
  console.log("  node credencial-esp32.js <sala> --rotacionar   gera um novo segredo (o antigo vale por 24h)");
  console.log("  node credencial-esp32.js <sala> --substituir   novo deviceId + segredo (troca de hardware)");
  console.log("  node credencial-esp32.js <sala> --revogar      invalida a credencial e derruba a conexão");
}

const [sala, acao] = process.argv.slice(2);

if (!sala) {
  uso();
  fecharBanco();
  process.exit(process.argv.length > 2 ? 1 : 0);
}

if (!salasService.buscar(sala)) {
  console.error(`Sala não encontrada: ${sala}`);
  fecharBanco();
  process.exit(1);
}

try {
  if (!acao) {
    const estado = credenciaisService.estado(sala);
    if (!estado.provisionado) {
      console.log(`Sala ${sala}: sem credencial (autenticação por MAC).`);
    } else {
      console.log(`Sala ${sala}:`);
      console.log(`  deviceId:     ${estado.deviceId}`);
      console.log(`  criada em:    ${estado.criadoEm}`);
      console.log(`  rotacionada:  ${estado.rotacionadoEm || "nunca"}`);
      console.log(`  último uso:   ${estado.ultimoUsoEm || "nunca"}`);
      console.log(`  revogada:     ${estado.revogado ? estado.revogadoEm : "não"}`);
      console.log(`  grace ativo:  ${estado.graceRotacaoAtivo ? "sim (segredo anterior ainda aceito)" : "não"}`);
    }
  } else if (acao === "--provisionar") {
    const r = credenciaisService.provisionar(sala);
    imprimirSegredo(r);
  } else if (acao === "--rotacionar") {
    const r = credenciaisService.rotacionar(sala);
    imprimirSegredo(r);
  } else if (acao === "--substituir") {
    const r = credenciaisService.substituir(sala);
    imprimirSegredo(r);
  } else if (acao === "--revogar") {
    const r = credenciaisService.revogar(sala);
    console.log(`Credencial ${r.deviceId} revogada. A conexão atual do dispositivo foi encerrada.`);
  } else {
    console.error(`Ação desconhecida: ${acao}`);
    uso();
    fecharBanco();
    process.exit(1);
  }
  fecharBanco();
  process.exit(0);
} catch (erro) {
  console.error(`Falha: ${erro.message}`);
  fecharBanco();
  process.exit(1);
}

function imprimirSegredo(r) {
  console.log("");
  console.log("  deviceId: " + r.deviceId);
  console.log("  segredo:  " + r.segredo);
  console.log("");
  console.log(r.enviadoAoDispositivo
    ? "Enviado ao dispositivo conectado; ele vai reconectar já autenticado."
    : "Dispositivo offline: informe deviceId e segredo no portal de setup do ESP32.");
  console.log("Guarde o segredo agora — ele não é armazenado em texto e não será exibido de novo.");
}
