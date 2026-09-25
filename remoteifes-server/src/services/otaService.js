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

const FASES_ATIVAS = new Set(["ofertado", "baixando", "gravado", "reiniciando", "validando"]);
const FASES_TERMINAIS = new Set(["concluido", "falhou", "ocioso"]);
const OTA_MAX_SIMULTANEOS = 2;
const OTA_TIMEOUT_TRANSFERENCIA_MS = 4 * 60 * 1000;
const OTA_TIMEOUT_REINICIO_MS = 3 * 60 * 1000;
const OTA_TIMEOUT_VALIDACAO_MS = 4 * 60 * 1000;
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
    return true;
  } catch (erro) {
    logger.warn("ota-estados-persistir-falhou", { mensagem: erro.message });
    return false;
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
  const agora = new Date().toISOString();
  for (const [sala, estado] of Object.entries(bruto)) {
    if (typeof sala !== "string" || !sala || sala.length > 100 || !estado || typeof estado !== "object") continue;
    if (typeof estado.fase !== "string" || !Number.isFinite(new Date(estado.atualizadoEm).getTime())) continue;
    estados.set(sala, estado.fase === "validando" ? { ...estado, atualizadoEm: agora } : { ...estado });
  }
}

function erroConflito(mensagem, extras) {
  const err = new Error(mensagem);
  err.conflito = true;
  return Object.assign(err, extras || {});
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
  const hashReal = sha256ArquivoMemorizado(arquivoBin, stat);
  if (!crypto.timingSafeEqual(Buffer.from(hashReal, "hex"), Buffer.from(manifesto.sha256, "hex"))) {
    logger.warn("ota-manifesto-hash-divergente", { arquivo: manifesto.arquivo });
    return null;
  }
  return manifesto;
}

const hashesMemorizados = new Map();

function sha256Arquivo(arquivo) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(arquivo));
  return hash.digest("hex");
}

function sha256ArquivoMemorizado(arquivo, stat) {
  const identidade = `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
  const guardado = hashesMemorizados.get(arquivo);
  if (guardado && guardado.identidade === identidade) return guardado.sha256;
  const sha256 = sha256Arquivo(arquivo);
  hashesMemorizados.set(arquivo, { identidade, sha256 });
  return sha256;
}

function esquecerHashes() {
  hashesMemorizados.clear();
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
  // An offer in progress must keep downloading exactly what it was offered: the same version name
  // with different bytes would overwrite its artifact.
  const emVoo = artefatosReferenciados().get(nomeBin);
  if (emVoo && emVoo !== sha256) {
    fs.rmSync(temporario, { force: true });
    throw new Error(`a versão ${versao} está em andamento em uma atualização com outro conteúdo; aguarde ela terminar ou publique com outro número de versão`);
  }
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
  esquecerHashes();
  limparArtefatosObsoletos(nomeBin);

  logger.info("ota-firmware-publicado", { versao, tamanho: bytes, sha256 });
  return manifesto;
}

// Artifacts that offers still transferring expect to find on disk (name -> sha256).
function artefatosReferenciados() {
  const referencias = new Map();
  estados.forEach((estado) => {
    if ((estado.fase === "ofertado" || estado.fase === "baixando") && typeof estado.versao === "string" && typeof estado.sha256 === "string") {
      referencias.set(`firmware-${estado.versao}.bin`, estado.sha256);
    }
  });
  return referencias;
}

// Keeps on disk only the published binary and those still being downloaded by an active offer; the
// set is bounded by the concurrent update cap and the transfer deadline.
function limparArtefatosObsoletos(nomePublicado) {
  let publicado = nomePublicado;
  if (!publicado) {
    const manifesto = lerManifesto();
    if (!manifesto) return;
    publicado = manifesto.arquivo;
  }
  const referenciados = artefatosReferenciados();
  let nomes;
  try {
    nomes = fs.readdirSync(DIR_FIRMWARE);
  } catch (erro) {
    if (erro.code !== "ENOENT") logger.warn("ota-limpeza-artefatos-falhou", { mensagem: erro.message });
    return;
  }
  for (const nome of nomes) {
    if (!nome.startsWith("firmware-") || !nome.endsWith(".bin") || nome === publicado || referenciados.has(nome)) continue;
    try {
      fs.rmSync(path.join(DIR_FIRMWARE, nome), { force: true });
      hashesMemorizados.delete(path.join(DIR_FIRMWARE, nome));
    } catch (erro) {
      logger.warn("ota-artefato-remover-falhou", { arquivo: nome, mensagem: erro.message });
    }
  }
}

// What the room must download: the artifact of its offer in progress (even if other firmware was
// published afterwards) or, without an active offer, the published firmware. `indisponivel` flags
// an offer whose artifact is no longer intact on disk.
function artefatoParaDownload(sala) {
  const estado = estados.get(sala);
  if (estado && (estado.fase === "ofertado" || estado.fase === "baixando") && typeof estado.versao === "string" && typeof estado.sha256 === "string") {
    const caminho = path.join(DIR_FIRMWARE, `firmware-${estado.versao}.bin`);
    let stat = null;
    try {
      stat = fs.statSync(caminho);
    } catch (erro) {
      if (erro.code !== "ENOENT") throw erro;
    }
    if (stat && stat.isFile() && stat.size === estado.total && sha256ArquivoMemorizado(caminho, stat) === estado.sha256) {
      return { caminho, versao: estado.versao, sha256: estado.sha256, tamanho: estado.total, indisponivel: false };
    }
    logger.warn("ota-artefato-ofertado-indisponivel", { sala, versao: estado.versao });
    return { caminho: null, versao: estado.versao, sha256: estado.sha256, tamanho: estado.total, indisponivel: true };
  }
  const manifesto = lerManifesto();
  if (!manifesto) return null;
  return { caminho: path.join(DIR_FIRMWARE, manifesto.arquivo), versao: manifesto.versao, sha256: manifesto.sha256, tamanho: manifesto.tamanho, indisponivel: false };
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

function vagasDisponiveis() {
  return Math.max(0, OTA_MAX_SIMULTANEOS - contarAtivos());
}

function avaliarElegibilidade(sala, manifestoAtual) {
  const manifesto = manifestoAtual === undefined ? lerManifesto() : manifestoAtual;
  const deviceHub = require("./deviceHub");
  const publico = deviceHub.estadoPublico(sala);
  const base = {
    versaoPublicada: manifesto ? manifesto.versao : null,
    versaoDispositivo: publico.fwVersao || null,
    conectado: !!publico.conectado,
  };
  const recusar = (codigo, motivo) => ({ elegivel: false, codigo, motivo, ...base });
  if (!manifesto) return recusar("sem-firmware", "nenhum firmware publicado");
  if (!deviceHub.dispositivoConectado(sala)) return recusar("desconectado", "dispositivo não está conectado no momento");
  const atual = estados.get(sala);
  if (atual && FASES_ATIVAS.has(atual.fase)) return recusar("ota-em-andamento", "já existe uma atualização de firmware em andamento para esta sala");
  if (publico.modo && publico.modo !== "operation") return recusar("modo-config", "dispositivo em modo de configuração");
  if (base.versaoDispositivo === manifesto.versao) return recusar("ja-atualizado", "já está na versão publicada");
  if (compararVersoes(manifesto.versao, base.versaoDispositivo) === -1) {
    return recusar("downgrade", `downgrade bloqueado: dispositivo em ${base.versaoDispositivo}, firmware publicado ${manifesto.versao}`);
  }
  return { elegivel: true, codigo: null, motivo: null, ...base };
}

function emitir(sala) {
  const deviceHub = require("./deviceHub");
  deviceHub.eventos.emit("ota", { sala, estado: estadoDaSala(sala) });
}

function definirEstado(sala, patch, exigirPersistencia = false) {
  const anterior = estados.get(sala) || {};
  const proximo = { ...anterior, ...patch, atualizadoEm: new Date().toISOString() };
  estados.set(sala, proximo);
  if (!persistirEstados() && exigirPersistencia) {
    if (anterior.fase) estados.set(sala, anterior);
    else estados.delete(sala);
    throw erroConflito("não foi possível persistir a atualização; nenhuma oferta enviada");
  }
  if (proximo.fase === "falhou" && anterior.fase !== "falhou") {
    try {
      require("./monitoramentoService").registrar("otaFalha", { sala, erro: proximo.erro });
    } catch {}
  }
  emitir(sala);
  return proximo;
}

function identidadeDaSala(sala) {
  const linha = require("./salasService").buscar(sala);
  if (!linha || !linha.mac) return null;
  const credencial = require("./esp32CredenciaisService").estado(sala);
  return crypto.createHash("sha256").update(JSON.stringify([linha.mac.toUpperCase(), credencial.deviceId || null, !!credencial.revogado])).digest("hex");
}

function ofertar(sala, { rolloutId, tentativa, sha256 } = {}) {
  const reserva = require("./otaRolloutService").reserva(sala);
  if (reserva && reserva !== rolloutId) throw erroConflito("dispositivo reservado pela distribuição em andamento");
  const manifesto = lerManifesto();
  if (!manifesto) {
    throw erroConflito("nenhum firmware publicado — publique um com `npm run firmware` antes de ofertar a atualização");
  }
  if (sha256 && manifesto.sha256 !== sha256) throw erroConflito("o firmware publicado mudou durante a distribuição");
  const deviceHub = require("./deviceHub");
  if (!deviceHub.dispositivoConectado(sala)) {
    throw erroConflito("dispositivo não está conectado no momento");
  }
  const atual = estados.get(sala);
  if (atual && FASES_ATIVAS.has(atual.fase)) {
    throw erroConflito("já existe uma atualização de firmware em andamento para esta sala");
  }
  if (contarAtivos() >= OTA_MAX_SIMULTANEOS) {
    throw erroConflito(`limite de ${OTA_MAX_SIMULTANEOS} atualizações simultâneas atingido — aguarde as em andamento terminarem`, { limite: true });
  }

  const versaoDispositivo = deviceHub.estadoPublico(sala).fwVersao || null;
  if (compararVersoes(manifesto.versao, versaoDispositivo) === -1) {
    throw erroConflito(`downgrade bloqueado: dispositivo em ${versaoDispositivo}, firmware publicado ${manifesto.versao}`);
  }
  definirEstado(sala, {
    fase: "ofertado",
    tentativa: tentativa || crypto.randomUUID(),
    identidade: identidadeDaSala(sala),
    sha256: manifesto.sha256,
    versao: manifesto.versao,
    versaoAnterior: versaoDispositivo,
    total: manifesto.tamanho,
    recebido: 0,
    erro: null,
    causa: null,
    iniciadoEm: new Date().toISOString(),
  }, true);

  const enviado = deviceHub.enviarComando(sala, {
    tipo: "ota_oferta",
    versao: manifesto.versao,
    tamanho: manifesto.tamanho,
    sha256: manifesto.sha256,
    caminho: CAMINHO_DOWNLOAD,
    tentativa: estados.get(sala).tentativa,
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
  if (recebidoValido <= (estado.recebido || 0)) return;
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
  definirEstado(sala, { fase: "falhou", erro, causa: "transferencia" });
  logger.warn("ota-falhou", { sala, versao: estado.versao, erro });
  notificarConcluido(sala, false, `A atualização de firmware da sala ${sala} falhou: ${erro}`);
}

function aoDesconectarDispositivo(sala) {
  const estado = estados.get(sala);
  if (!estado) return;
  if (estado.fase === "ofertado" || estado.fase === "baixando") {
    definirEstado(sala, { fase: "falhou", erro: "a conexão do dispositivo caiu durante a transferência do firmware", causa: "transferencia" });
    logger.warn("ota-conexao-perdida", { sala, versao: estado.versao });
  } else if (estado.fase === "gravado") {
    definirEstado(sala, { fase: "reiniciando" });
  }
}

function concluir(sala, estado, evidencia) {
  definirEstado(sala, { fase: "concluido", recebido: estado.total, erro: null, causa: null, evidencia });
  logger.info("ota-concluida", { sala, versao: estado.versao, evidencia });
  notificarConcluido(sala, true, `A sala ${sala} foi atualizada para o firmware ${estado.versao}.`);
}

function reverter(sala, estado, fwVersao, erro, mensagem) {
  definirEstado(sala, { fase: "falhou", erro, causa: "rollback", versaoReportada: fwVersao || null });
  logger.warn("ota-revertida", { sala, versaoAlvo: estado.versao, versaoAtual: fwVersao || null });
  notificarConcluido(sala, false, mensagem);
}

function aoReconectarDispositivo(sala, fwVersao, capacidades = {}) {
  const estado = estados.get(sala);
  if (!estado || estado.fase === "ocioso") return;
  if (estado.identidade && estado.identidade !== identidadeDaSala(sala)) return;
  const voltouAoAnterior = !!fwVersao && !!estado.versaoAnterior && fwVersao === estado.versaoAnterior && fwVersao !== estado.versao;
  if (estado.fase === "concluido") {
    if (voltouAoAnterior && estado.evidencia === "boot") {
      reverter(sala, estado, fwVersao, "o dispositivo voltou à versão anterior depois de a atualização ter sido validada",
        `A sala ${sala} voltou ao firmware ${fwVersao} depois de a atualização para ${estado.versao} ter sido validada.`);
    }
    return;
  }
  if (estado.fase === "falhou") return;
  if (fwVersao && estado.versao && fwVersao === estado.versao) {
    if (capacidades && capacidades.validacaoOta) {
      if (estado.fase !== "validando") {
        definirEstado(sala, { fase: "validando", recebido: estado.total, validandoDesde: new Date().toISOString() });
        logger.info("ota-validando", { sala, versao: estado.versao });
      }
      return;
    }
    concluir(sala, estado, "versao");
    return;
  }
  if (estado.fase !== "gravado" && estado.fase !== "reiniciando" && estado.fase !== "validando") return;
  if (voltouAoAnterior && (estado.fase === "validando" || (capacidades && capacidades.validacaoOta))) {
    reverter(sala, estado, fwVersao, "o dispositivo reverteu para a versão anterior sem validar o novo firmware",
      `A atualização da sala ${sala} foi revertida pelo próprio dispositivo: o firmware ${estado.versao} não passou na validação de boot.`);
    return;
  }
  const erro = "o dispositivo reportou uma versão inesperada após a gravação; rollback não comprovado";
  definirEstado(sala, { fase: "falhou", erro, causa: "indeterminado" });
  logger.warn("ota-versao-inesperada", { sala, versaoAlvo: estado.versao, versaoAtual: fwVersao || null });
  notificarConcluido(sala, false, `A atualização da sala ${sala} não foi confirmada: versão inesperada após a gravação.`);
}

function registrarValidacao(sala, msg) {
  const estado = estados.get(sala);
  if (!estado || !msg || typeof msg.tentativa !== "string" || !msg.tentativa) return false;
  if (estado.tentativa !== msg.tentativa) {
    logger.warn("ota-validacao-tentativa-divergente", { sala, esperada: estado.tentativa || null, recebida: msg.tentativa.slice(0, 64) });
    return false;
  }
  if (typeof msg.sha256 === "string" && msg.sha256.toLowerCase() !== estado.sha256) {
    logger.warn("ota-validacao-hash-divergente", { sala });
    return false;
  }
  if (typeof msg.versao === "string" && msg.versao !== estado.versao) {
    logger.warn("ota-validacao-versao-divergente", { sala, esperada: estado.versao, recebida: msg.versao.slice(0, 32) });
    return false;
  }
  if (estado.fase === "concluido") return true;
  if (estado.fase !== "validando" && estado.fase !== "gravado" && estado.fase !== "reiniciando") return false;
  if (estado.identidade && estado.identidade !== identidadeDaSala(sala)) return false;
  concluir(sala, estado, "boot");
  return true;
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
      definirEstado(sala, { fase: "falhou", erro: "tempo esgotado durante a transferência do firmware", causa: "transferencia" });
      logger.warn("ota-timeout-transferencia", { sala, versao: estado.versao });
      notificarConcluido(sala, false, `A atualização de firmware da sala ${sala} expirou durante a transferência.`);
    } else if ((estado.fase === "gravado" || estado.fase === "reiniciando") && idadeMs > OTA_TIMEOUT_REINICIO_MS) {
      definirEstado(sala, { fase: "falhou", erro: "o dispositivo não voltou a se conectar após gravar o firmware", causa: "reinicio" });
      logger.warn("ota-timeout-reinicio", { sala, versao: estado.versao });
      notificarConcluido(sala, false, `A sala ${sala} não voltou a se conectar após gravar o firmware.`);
    } else if (estado.fase === "validando" && idadeMs > OTA_TIMEOUT_VALIDACAO_MS) {
      definirEstado(sala, { fase: "falhou", erro: "o dispositivo não confirmou a validação de boot do novo firmware", causa: "validacao" });
      logger.warn("ota-timeout-validacao", { sala, versao: estado.versao });
      notificarConcluido(sala, false, `A sala ${sala} reiniciou com o firmware ${estado.versao}, mas não confirmou a validação de boot.`);
    }
  });
  if (removeuTerminal) persistirEstados();
  limparArtefatosObsoletos();
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
  MAX_SIMULTANEOS: OTA_MAX_SIMULTANEOS,
  publicarFirmware,
  lerManifesto,
  esquecerHashes,
  artefatoParaDownload,
  compararVersoes,
  ofertar,
  vagasDisponiveis,
  avaliarElegibilidade,
  identidadeDaSala,
  registrarProgresso,
  registrarResultado,
  aoDesconectarDispositivo,
  aoReconectarDispositivo,
  registrarValidacao,
  verificarTimeouts,
  estadoDaSala,
  listarEstados,
  limparEstado,
};
