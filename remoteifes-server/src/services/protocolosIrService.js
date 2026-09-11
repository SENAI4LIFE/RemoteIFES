const db = require("../config/database");
const logger = require("../utils/logger");

const CHAVE_CLONADOR = "espClonador";
const MAX_RAW = 1024;
const MAX_PULSO = 65535;
const CARRIER_PADRAO = 38000;
const CARRIER_MIN = 20000;
const CARRIER_MAX = 60000;
const LABEL_MIN = 2;
const LABEL_MAX = 80;

let clonadorCache;

function normalizarLabel(label) {
  if (typeof label !== "string") throw new Error("label é obrigatório");
  const valor = label.normalize("NFKC").replace(/[\x00-\x1F\x7F]/g, " ").trim().replace(/\s+/g, " ");
  if (valor.length < LABEL_MIN || valor.length > LABEL_MAX) {
    throw new Error(`label deve ter entre ${LABEL_MIN} e ${LABEL_MAX} caracteres`);
  }
  return valor;
}

function chaveLabel(label) {
  return label.normalize("NFKC").toLocaleLowerCase("pt-BR");
}

function garantirLabelDisponivel(label, ignorarId = null) {
  const chave = chaveLabel(label);
  const conflito = db.prepare("SELECT id, label FROM protocolos_ir").all()
    .find((row) => row.id !== ignorarId && chaveLabel(row.label) === chave);
  if (conflito) throw new Error("já existe um protocolo com esse label");
}

function validarRaw(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_RAW) {
    throw new Error(`raw deve possuir entre 1 e ${MAX_RAW} pulsos`);
  }
  if (!raw.every((n) => Number.isInteger(n) && n >= 0 && n <= MAX_PULSO)) {
    throw new Error(`raw deve conter apenas inteiros entre 0 e ${MAX_PULSO}`);
  }
  return raw;
}

function validarCarrierHz(valor) {
  const carrierHz = valor === undefined || valor === null ? CARRIER_PADRAO : Number(valor);
  if (!Number.isInteger(carrierHz) || carrierHz < CARRIER_MIN || carrierHz > CARRIER_MAX) {
    throw new Error(`carrierHz deve ser um inteiro entre ${CARRIER_MIN} e ${CARRIER_MAX}`);
  }
  return carrierHz;
}

function lerClonadorDoBanco() {
  const row = db.prepare("SELECT valor FROM configuracoes WHERE chave = ?").get(CHAVE_CLONADOR);
  if (!row || row.valor == null) return null;
  try {
    const valor = JSON.parse(row.valor);
    if (!valor || typeof valor !== "object" || typeof valor.sala !== "string" || !valor.sala) return null;
    return {
      sala: valor.sala,
      mac: typeof valor.mac === "string" && valor.mac ? valor.mac.toUpperCase() : null,
      deviceId: typeof valor.deviceId === "string" && valor.deviceId ? valor.deviceId : null,
      definidoEm: typeof valor.definidoEm === "string" ? valor.definidoEm : null,
    };
  } catch (erro) {
    logger.warn("clonador-configuracao-invalida", { mensagem: erro.message });
    return null;
  }
}

function obterClonador() {
  if (clonadorCache === undefined) clonadorCache = lerClonadorDoBanco();
  return clonadorCache;
}

function identidadeDaSala(salaRow) {
  if (!salaRow) return null;
  const credencial = db.prepare(
    "SELECT deviceId FROM esp_credenciais WHERE sala = ? AND revogadoEm IS NULL"
  ).get(salaRow.sala);
  return { mac: salaRow.mac ? salaRow.mac.toUpperCase() : null, deviceId: credencial ? credencial.deviceId : null };
}

function definirClonador(sala) {
  let valor = null;
  if (sala !== null && sala !== undefined && sala !== "") {
    if (typeof sala !== "string") throw new Error("sala do clonador inválida");
    const salaRow = require("./salasService").buscar(sala);
    if (!salaRow) throw new Error("sala do clonador não encontrada");
    if (!salaRow.mac) throw new Error("a sala escolhida ainda não possui ESP32 cadastrado");
    const identidade = identidadeDaSala(salaRow);
    valor = { sala: salaRow.sala, mac: identidade.mac, deviceId: identidade.deviceId, definidoEm: new Date().toISOString() };
  }
  db.prepare(`
    INSERT INTO configuracoes (chave, valor) VALUES (?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor
  `).run(CHAVE_CLONADOR, JSON.stringify(valor));
  clonadorCache = valor;
  return valor;
}

function avaliarVinculo(sala, salaRow = null) {
  const clonador = obterClonador();
  if (!clonador || !sala || clonador.sala !== sala) return { ok: false, motivo: "nao-designado" };
  const row = salaRow || require("./salasService").buscar(sala);
  if (!row) return { ok: false, motivo: "sala-inexistente" };
  const atual = identidadeDaSala(row);
  if (!atual.mac || atual.mac !== clonador.mac) return { ok: false, motivo: "mac-alterado" };
  if (clonador.deviceId && atual.deviceId !== clonador.deviceId) return { ok: false, motivo: "credencial-alterada" };
  return { ok: true, motivo: null };
}

function vinculoClonadorValido(sala, salaRow = null) {
  return avaliarVinculo(sala, salaRow).ok;
}

function conexaoAutorizadaComoClonador(sala, conexao, salaRow = null) {
  if (!conexao || !vinculoClonadorValido(sala, salaRow)) return false;
  const clonador = obterClonador();
  const mac = typeof conexao.mac === "string" ? conexao.mac.toUpperCase() : null;
  if (!mac || mac !== clonador.mac) return false;
  if (clonador.deviceId && conexao.deviceId !== clonador.deviceId) return false;
  return true;
}

function papelDaSala(sala, salaRow = null) {
  return vinculoClonadorValido(sala, salaRow) ? "cloner" : "transmitter";
}

function papelDaConexao(sala, conexao, salaRow = null) {
  return conexaoAutorizadaComoClonador(sala, conexao, salaRow) ? "cloner" : "transmitter";
}

function estadoClonador() {
  const clonador = obterClonador();
  if (!clonador) return { sala: null, mac: null, deviceId: null, definidoEm: null, vinculoValido: false, motivo: "nao-designado" };
  const vinculo = avaliarVinculo(clonador.sala);
  return { ...clonador, vinculoValido: vinculo.ok, motivo: vinculo.motivo };
}

function parseRawJson(valor) {
  if (!valor) return [];
  try {
    const raw = JSON.parse(valor);
    return Array.isArray(raw) ? raw : [];
  } catch (erro) {
    return [];
  }
}

function linhaPublica(row) {
  if (!row) return null;
  const failsafeRaw = parseRawJson(row.failsafeRawJson);
  return {
    id: row.id,
    label: row.label,
    isKnown: !!row.isKnown,
    protocolId: Number.isInteger(row.protocolId) ? row.protocolId : null,
    protocol: row.protocol || null,
    hex: row.hex || null,
    raw: parseRawJson(row.rawJson),
    carrierHz: Number.isInteger(row.carrierHz) ? row.carrierHz : CARRIER_PADRAO,
    failsafe: failsafeRaw.length > 0 ? {
      raw: failsafeRaw,
      carrierHz: Number.isInteger(row.failsafeCarrierHz) ? row.failsafeCarrierHz : CARRIER_PADRAO,
      atualizadoEm: row.failsafeAtualizadoEm || null,
    } : null,
    origemSala: row.origemSala || null,
    origemMac: row.origemMac || null,
    salas: salasAtribuidas(row.id),
    criadoEm: row.criadoEm,
    atualizadoEm: row.atualizadoEm,
  };
}

function listar() {
  return db.prepare("SELECT * FROM protocolos_ir ORDER BY label COLLATE NOCASE, id").all().map(linhaPublica);
}

function buscar(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return null;
  return linhaPublica(db.prepare("SELECT * FROM protocolos_ir WHERE id = ?").get(n));
}

function exigirCapturaDoClonador(captura) {
  if (!captura || typeof captura !== "object") throw new Error("captura é obrigatória");
  const clonador = obterClonador();
  if (!clonador) throw new Error("nenhum módulo clonador foi definido");
  if (!vinculoClonadorValido(clonador.sala)) throw new Error("o vínculo do módulo clonador mudou; confirme a clonadora novamente");
  if (captura.sala && captura.sala !== clonador.sala) throw new Error("a captura não veio do módulo clonador definido");
  return clonador;
}

function criar({ label, captura }) {
  const nome = normalizarLabel(label);
  garantirLabelDisponivel(nome);
  const clonador = exigirCapturaDoClonador(captura);
  const raw = validarRaw(captura.raw);
  const carrierHz = validarCarrierHz(captura.carrierHz);
  const isKnown = captura.isKnown === true;
  const protocolId = isKnown && Number.isInteger(captura.protocolId) && captura.protocolId >= 0 ? captura.protocolId : null;
  if (isKnown && protocolId === null) throw new Error("protocolo reconhecido precisa de protocolId válido");
  const protocol = typeof captura.protocol === "string" ? captura.protocol.slice(0, 80) : null;
  const hex = typeof captura.hex === "string" ? captura.hex.slice(0, 4096) : null;

  try {
    const info = db.prepare(`
      INSERT INTO protocolos_ir (label, isKnown, protocolId, protocol, hex, rawJson, carrierHz, origemSala, origemMac)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(nome, isKnown ? 1 : 0, protocolId, protocol, hex, JSON.stringify(raw), carrierHz, clonador.sala, clonador.mac);
    return buscar(Number(info.lastInsertRowid));
  } catch (erro) {
    if (/UNIQUE/i.test(erro.message)) throw new Error("já existe um protocolo com esse label");
    throw erro;
  }
}

function definirFailsafe(id, captura) {
  const atual = buscar(id);
  if (!atual) throw new Error("protocolo não encontrado");
  exigirCapturaDoClonador(captura);
  const raw = validarRaw(captura.raw);
  const carrierHz = validarCarrierHz(captura.carrierHz);
  db.prepare(`
    UPDATE protocolos_ir
    SET failsafeRawJson = ?, failsafeCarrierHz = ?, failsafeAtualizadoEm = datetime('now'), atualizadoEm = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(raw), carrierHz, atual.id);
  return buscar(atual.id);
}

function limparFailsafe(id) {
  const atual = buscar(id);
  if (!atual) throw new Error("protocolo não encontrado");
  db.prepare(`
    UPDATE protocolos_ir
    SET failsafeRawJson = NULL, failsafeCarrierHz = NULL, failsafeAtualizadoEm = NULL, atualizadoEm = datetime('now')
    WHERE id = ?
  `).run(atual.id);
  return buscar(atual.id);
}

function salasAtribuidas(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return [];
  return db.prepare("SELECT sala FROM salas WHERE irProtocoloRegistroId = ? ORDER BY sala").all(n).map((row) => row.sala);
}

function renomear(id, label) {
  const atual = buscar(id);
  if (!atual) throw new Error("protocolo não encontrado");
  const nome = normalizarLabel(label);
  garantirLabelDisponivel(nome, atual.id);
  try {
    db.prepare("UPDATE protocolos_ir SET label = ?, atualizadoEm = datetime('now') WHERE id = ?").run(nome, atual.id);
  } catch (erro) {
    if (/UNIQUE/i.test(erro.message)) throw new Error("já existe um protocolo com esse label");
    throw erro;
  }
  return buscar(atual.id);
}

function excluir(id) {
  const atual = buscar(id);
  if (!atual) throw new Error("protocolo não encontrado");
  db.prepare("UPDATE salas SET irProtocoloRegistroId = NULL, atualizadoEm = datetime('now') WHERE irProtocoloRegistroId = ?").run(atual.id);
  db.prepare("DELETE FROM protocolos_ir WHERE id = ?").run(atual.id);
  return atual;
}

module.exports = {
  obterClonador,
  definirClonador,
  estadoClonador,
  avaliarVinculo,
  vinculoClonadorValido,
  conexaoAutorizadaComoClonador,
  papelDaSala,
  papelDaConexao,
  listar,
  buscar,
  criar,
  definirFailsafe,
  limparFailsafe,
  salasAtribuidas,
  renomear,
  excluir,
  validarRaw,
  validarCarrierHz,
  normalizarLabel,
  MAX_RAW,
  CARRIER_PADRAO,
};
