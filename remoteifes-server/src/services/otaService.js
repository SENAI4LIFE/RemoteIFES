const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DIR_DADOS } = require("../config/paths");
const logger = require("../utils/logger");
const notificacoesService = require("./notificacoesService");

const DIR_FIRMWARE = process.env.REMOTEIFES_FIRMWARE_DIR
  ? path.resolve(process.env.REMOTEIFES_FIRMWARE_DIR)
  : path.join(DIR_DADOS, "firmware");
const ARQUIVO_MANIFESTO = path.join(DIR_FIRMWARE, "manifesto.json");
const ARQUIVO_ESTADOS = path.join(DIR_FIRMWARE, "estados-ota.json");

const RE_VERSAO = /^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/;
const TAMANHO_MIN_BIN = 64 * 1024;
const TAMANHO_MAX_BIN = 3 * 1024 * 1024;
const MAGIC_IMAGEM_ESP = 0xe9;

const FASES_ATIVAS = new Set(["ofertado", "baixando", "gravado", "reiniciando"]);
const FASES_TERMINAIS = new Set(["concluido", "falhou", "ocioso"]);
const OTA_MAX_SIMULTANEOS = 2;
const OTA_TIMEOUT_TRANSFERENCIA_MS = 4 * 60 * 1000;
const OTA_TIMEOUT_REINICIO_MS = 3 * 60 * 1000;
const OTA_ESTADO_TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CAMINHO_DOWNLOAD = "/dispositivo/firmware";

const estados = new Map();

function versaoSemantica(valor) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(valor || ""));
  return match ? match.slice(1).map(Number) : null;
}

function compararVersoes(a, b) {
  const va = versaoSemantica(a);
  const vb = versaoSemantica(b);
  if (!va || !vb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (va[i] !== vb[i]) return va[i] < vb[i] ? -1 : 1;
  }
  return 0;
}

function persistirEstados() {
  try {
    dirFirmware();
    const temporario = `${ARQUIVO_ESTADOS}.tmp`;
    fs.writeFileSync(temporario, JSON.stringify(Object.fromEntries(estados), null, 2), { mode: 0o600 });
    fs.renameSync(temporario, ARQUIVO_ESTADOS);
  } catch (erro) {
    logger.warn("ota-estados-persistir-falhou", { mensagem: erro.message });
  }
}

function carregarEstados() {
  let bruto;
  try {
    bruto = JSON.parse(fs.readFileSync(ARQUIVO_ESTADOS, "utf8"));
  } catch (erro) {
    if (erro.code !== "ENOENT") logger.warn("ota-estados-carregar-falhou", { mensagem: erro.message });
    return;
  }
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return;
  for (const [sala, estado] of Object.entries(bruto)) {
    if (typeof sala !== "string" || !sala || sala.length > 100 || !estado || typeof estado !== "object") continue;
    if (typeof estado.fase !== "string" || !Number.isFinite(new Date(estado.atualizadoEm).getTime())) continue;
    estados.set(sala, { ...estado });
  }
}

function erroConflito(mensagem) {
  const err = new Error(mensagem);
  err.conflito = true;
  return err;
}

function dirFirmware() {
  fs.mkdirSync(DIR_FIRMWARE, { recursive: true, mode: 0o700 });
  return DIR_FIRMWARE;
}

function lerManifesto() {
  let bruto;
  try {
    bruto = fs.readFileSync(ARQUIVO_MANIFESTO, "utf8");
  } catch (erro) {
    if (erro.code === "ENOENT") return null;
    throw erro;
  }
  let manifesto;
  try {
    manifesto = JSON.parse(bruto);
  } catch (erro) {
    logger.warn("ota-manifesto-invalido", { mensagem: erro.message });
    return null;
  }
  if (!manifesto || typeof manifesto !== "object" || Array.isArray(manifesto)) return null;
  if (typeof manifesto.versao !== "string" || !RE_VERSAO.test(manifesto.versao)) return null;
  if (typeof manifesto.arquivo !== "string" || path.basename(manifesto.arquivo) !== manifesto.arquivo) return null;
  if (manifesto.arquivo !== `firmware-${manifesto.versao}.bin`) return null;
  if (!Number.isInteger(manifesto.tamanho) || manifesto.tamanho < TAMANHO_MIN_BIN || manifesto.tamanho > TAMANHO_MAX_BIN) return null;
  if (typeof manifesto.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifesto.sha256)) return null;
  const raiz = path.resolve(DIR_FIRMWARE);
  const arquivoBin = path.resolve(raiz, manifesto.arquivo);
  if (!arquivoBin.startsWith(`${raiz}${path.sep}`) || !fs.existsSync(arquivoBin)) return null;
  const stat = fs.statSync(arquivoBin);
  if (!stat.isFile()) return null;
  const bytes = stat.size;
  if (bytes !== manifesto.tamanho) {
    logger.warn("ota-manifesto-tamanho-divergente", { esperado: manifesto.tamanho, real: bytes });
    return null;
  }
  const fd = fs.openSync(arquivoBin, "r");
  try {
    const cabecalho = Buffer.alloc(1);
    fs.readSync(fd, cabecalho, 0, 1, 0);
    if (cabecalho[0] !== MAGIC_IMAGEM_ESP) return null;
  } finally {
    fs.closeSync(fd);
  }
  const hashReal = sha256Arquivo(arquivoBin);
  if (!crypto.timingSafeEqual(Buffer.from(hashReal, "hex"), Buffer.from(manifesto.sha256, "hex"))) {
    logger.warn("ota-manifesto-hash-divergente", { arquivo: manifesto.arquivo });
    return null;
  }
  return manifesto;
}

function caminhoBinPublicado() {
  const manifesto = lerManifesto();
  if (!manifesto) return null;
  return path.join(DIR_FIRMWARE, manifesto.arquivo);
}

function sha256Arquivo(arquivo) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(arquivo));
  return hash.digest("hex");
}

function publicarFirmware({ origem, versao, notas } = {}) {
  if (typeof versao !== "string" || !RE_VERSAO.test(versao)) {
    throw new Error("versão inválida (use apenas letras, números, ponto, hífen ou sublinhado; até 32 caracteres)");
  }
  if (!origem || !fs.existsSync(origem)) {
    throw new Error(`arquivo de firmware não encontrado: ${origem}`);
  }
  const bytes = fs.statSync(origem).size;
  if (bytes < TAMANHO_MIN_BIN || bytes > TAMANHO_MAX_BIN) {
    throw new Error(`tamanho do firmware fora da faixa esperada para um ESP32 (${TAMANHO_MIN_BIN}–${TAMANHO_MAX_BIN} bytes)`);
  }
  const fd = fs.openSync(origem, "r");
  try {
    const cabecalho = Buffer.alloc(1);
    fs.readSync(fd, cabecalho, 0, 1, 0);
    if (cabecalho[0] !== MAGIC_IMAGEM_ESP) {
      throw new Error("o arquivo não parece um binário de aplicação ESP32 (byte mágico 0xE9 ausente)");
    }
  } finally {
    fs.closeSync(fd);
  }

  const dir = dirFirmware();
  const nomeBin = `firmware-${versao}.bin`;
  const destino = path.join(dir, nomeBin);
  const temporario = path.join(dir, `.incoming-${process.pid}-${crypto.randomBytes(4).toString("hex")}.bin`);
  fs.copyFileSync(origem, temporario);
  fs.chmodSync(temporario, 0o600);
  const sha256 = sha256Arquivo(temporario);
  fs.renameSync(temporario, destino);

  const manifesto = {
    versao,
    arquivo: nomeBin,
    sha256,
    tamanho: bytes,
    notas: typeof notas === "string" ? notas.slice(0, 500) : "",
    publicadoEm: new Date().toISOString(),
  };
  const manifestoTmp = `${ARQUIVO_MANIFESTO}.tmp`;
  fs.writeFileSync(manifestoTmp, JSON.stringify(manifesto, null, 2), { mode: 0o600 });
  fs.renameSync(manifestoTmp, ARQUIVO_MANIFESTO);

  for (const nome of fs.readdirSync(dir)) {
    if (nome.startsWith("firmware-") && nome.endsWith(".bin") && nome !== nomeBin) {
      fs.rmSync(path.join(dir, nome), { force: true });
    }
  }

  logger.info("ota-firmware-publicado", { versao, tamanho: bytes, sha256 });
  return manifesto;
}

function estadoDaSala(sala) {
  const estado = estados.get(sala);
  if (!estado) return { fase: "ocioso" };
  return { ...estado };
}

function listarEstados() {
  const saida = {};
  estados.forEach((estado, sala) => {
    saida[sala] = { ...estado };
  });
  return saida;
}

function contarAtivos() {
  let total = 0;
  estados.forEach((estado) => {
    if (FASES_ATIVAS.has(estado.fase)) total += 1;
  });
  return total;
}

function emitir(sala) {
  const deviceHub = require("./deviceHub");
  deviceHub.eventos.emit("ota", { sala, estado: estadoDaSala(sala) });
}

function definirEstado(sala, patch) {
  const anterior = estados.get(sala) || {};
  const proximo = { ...anterior, ...patch, atualizadoEm: new Date().toISOString() };
  estados.set(sala, proximo);
  persistirEstados();
  if (proximo.fase === "falhou" && anterior.fase !== "falhou") {
    try {
      require("./monitoramentoService").registrar("otaFalha", { sala, erro: proximo.erro });
    } catch {}
  }
  emitir(sala);
  return proximo;
}

function ofertar(sala) {
  const manifesto = lerManifesto();
  if (!manifesto) {
    throw erroConflito("nenhum firmware publicado — publique um com `npm run firmware` antes de ofertar a atualização");
  }
  const deviceHub = require("./deviceHub");
  if (!deviceHub.dispositivoConectado(sala)) {
    throw erroConflito("dispositivo não está conectado no momento");
  }
  const atual = estados.get(sala);
  if (atual && FASES_ATIVAS.has(atual.fase)) {
    throw erroConflito("já existe uma atualização de firmware em andamento para esta sala");
  }
  if (contarAtivos() >= OTA_MAX_SIMULTANEOS) {
    throw erroConflito(`limite de ${OTA_MAX_SIMULTANEOS} atualizações simultâneas atingido — aguarde as em andamento terminarem`);
  }

  const versaoDispositivo = deviceHub.estadoPublico(sala).fwVersao || null;
  if (compararVersoes(manifesto.versao, versaoDispositivo) === -1) {
    throw erroConflito(`downgrade bloqueado: dispositivo em ${versaoDispositivo}, firmware publicado ${manifesto.versao}`);
  }
  definirEstado(sala, {
    fase: "ofertado",
    versao: manifesto.versao,
    versaoAnterior: versaoDispositivo,
    total: manifesto.tamanho,
    recebido: 0,
    erro: null,
    iniciadoEm: new Date().toISOString(),
  });

  const enviado = deviceHub.enviarComando(sala, {
    tipo: "ota_oferta",
    versao: manifesto.versao,
    tamanho: manifesto.tamanho,
    sha256: manifesto.sha256,
    caminho: CAMINHO_DOWNLOAD,
  });
  if (!enviado) {
    estados.delete(sala);
    persistirEstados();
    emitir(sala);
    throw erroConflito("dispositivo não está conectado no momento");
  }
  logger.info("ota-ofertada", { sala, versao: manifesto.versao });
  return estadoDaSala(sala);
}

function registrarProgresso(sala, msg) {
  const estado = estados.get(sala);
  if (!estado || (estado.fase !== "ofertado" && estado.fase !== "baixando")) return;
  const recebido = Number(msg.recebido);
  const recebidoValido = Number.isFinite(recebido)
    ? Math.min(estado.total, Math.max(estado.recebido || 0, recebido))
    : estado.recebido;
  definirEstado(sala, {
    fase: "baixando",
    recebido: recebidoValido,
    total: estado.total,
  });
}

function registrarResultado(sala, msg) {
  const estado = estados.get(sala);
  if (!estado || (estado.fase !== "ofertado" && estado.fase !== "baixando")) return;
  const resultado = typeof msg.resultado === "string" ? msg.resultado : "";
  if (resultado === "ok" || resultado === "gravado") {
    definirEstado(sala, { fase: "gravado", recebido: estado.total });
    logger.info("ota-gravada", { sala, versao: estado.versao });
    return;
  }
  const erro = typeof msg.erro === "string" ? msg.erro.slice(0, 200) : "falha não especificada";
  definirEstado(sala, { fase: "falhou", erro });
  logger.warn("ota-falhou", { sala, versao: estado.versao, erro });
  notificarConcluido(sala, false, `A atualização de firmware da sala ${sala} falhou: ${erro}`);
}

function aoDesconectarDispositivo(sala) {
  const estado = estados.get(sala);
  if (!estado) return;
  if (estado.fase === "ofertado" || estado.fase === "baixando") {
    definirEstado(sala, { fase: "falhou", erro: "a conexão do dispositivo caiu durante a transferência do firmware" });
    logger.warn("ota-conexao-perdida", { sala, versao: estado.versao });
  } else if (estado.fase === "gravado") {
    definirEstado(sala, { fase: "reiniciando" });
  }
}

function aoReconectarDispositivo(sala, fwVersao) {
  const estado = estados.get(sala);
  if (!estado || estado.fase === "concluido" || estado.fase === "ocioso") return;
  if (fwVersao && estado.versao && fwVersao === estado.versao) {
    definirEstado(sala, { fase: "concluido", recebido: estado.total, erro: null });
    logger.info("ota-concluida", { sala, versao: estado.versao });
    notificarConcluido(sala, true, `A sala ${sala} foi atualizada para o firmware ${estado.versao}.`);
    return;
  }
  if (estado.fase !== "gravado" && estado.fase !== "reiniciando") return;
  const erro = "o dispositivo voltou com a versão anterior após a atualização (rollback automático)";
  definirEstado(sala, { fase: "falhou", erro });
  logger.warn("ota-rollback", { sala, versaoAlvo: estado.versao, versaoAtual: fwVersao || null });
  notificarConcluido(sala, false, `A atualização da sala ${sala} não foi validada e o dispositivo reverteu para a versão anterior.`);
}

function notificarConcluido(sala, sucesso, mensagem) {
  try {
    notificacoesService.criar({ tipo: sucesso ? "esp32_ota_ok" : "esp32_ota_falha", sala, mensagem });
  } catch (erro) {
    logger.warn("ota-notificacao-falhou", { sala, mensagem: erro.message });
  }
}

function verificarTimeouts() {
  const agora = Date.now();
  let removeuTerminal = false;
  estados.forEach((estado, sala) => {
    const idadeMs = agora - new Date(estado.atualizadoEm).getTime();
    if (FASES_TERMINAIS.has(estado.fase) && idadeMs > OTA_ESTADO_TERMINAL_TTL_MS) {
      estados.delete(sala);
      removeuTerminal = true;
      return;
    }
    if ((estado.fase === "ofertado" || estado.fase === "baixando") && idadeMs > OTA_TIMEOUT_TRANSFERENCIA_MS) {
      definirEstado(sala, { fase: "falhou", erro: "tempo esgotado durante a transferência do firmware" });
      logger.warn("ota-timeout-transferencia", { sala, versao: estado.versao });
      notificarConcluido(sala, false, `A atualização de firmware da sala ${sala} expirou durante a transferência.`);
    } else if ((estado.fase === "gravado" || estado.fase === "reiniciando") && idadeMs > OTA_TIMEOUT_REINICIO_MS) {
      definirEstado(sala, { fase: "falhou", erro: "o dispositivo não voltou a se conectar após gravar o firmware" });
      logger.warn("ota-timeout-reinicio", { sala, versao: estado.versao });
      notificarConcluido(sala, false, `A sala ${sala} não voltou a se conectar após gravar o firmware.`);
    }
  });
  if (removeuTerminal) persistirEstados();
}

function limparEstado(sala) {
  if (estados.delete(sala)) {
    persistirEstados();
    emitir(sala);
  }
}

carregarEstados();

module.exports = {
  DIR_FIRMWARE,
  ARQUIVO_ESTADOS,
  CAMINHO_DOWNLOAD,
  publicarFirmware,
  lerManifesto,
  caminhoBinPublicado,
  ofertar,
  registrarProgresso,
  registrarResultado,
  aoDesconectarDispositivo,
  aoReconectarDispositivo,
  verificarTimeouts,
  estadoDaSala,
  listarEstados,
  limparEstado,
};
