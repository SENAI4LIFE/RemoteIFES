const EventEmitter = require("events");
const db = require("../config/database");
const logger = require("../utils/logger");
const { utcSqlite } = require("../utils/tempo");

const eventos = new EventEmitter();

const PADROES = {
  timeoutInatividadeMinutos: 60,
  timeoutInatividadeAdminMinutos: 720,
  retencaoAuditoriaDias: 7,
  popupAvisoSegundos: 60,
  limiarOnlineMinutos: 5,
  temperaturaMinima: 23,
  temperaturaMaxima: 25,
  turboFuncaoExtra: "nenhuma",
  autoLigar: true,
  modoTeste: process.env.NODE_ENV !== "production",
  redesAutorizadas: [],
  modoManutencao: false,
  espCredenciaisObrigatorias: process.env.NODE_ENV !== "test",
  // Policy for the ESP32 local access point (RemoteIFES-Setup). Unrelated to device authentication
  // on the server, which remains in espCredenciaisObrigatorias.
  espApExigirCredencial: false,
  desligamentoDiario: { ativo: false, hora: "00:00", escopo: "todas", salas: [], vigenteDesde: null },
};

const ESCOPOS_DESLIGAMENTO_DIARIO = ["todas", "selecionadas"];
const HORA_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizarDesligamentoDiario(valor) {
  const padrao = PADROES.desligamentoDiario;
  const v = valor && typeof valor === "object" && !Array.isArray(valor) ? valor : {};
  return {
    ativo: v.ativo === true,
    hora: typeof v.hora === "string" && HORA_HHMM.test(v.hora) ? v.hora : padrao.hora,
    escopo: ESCOPOS_DESLIGAMENTO_DIARIO.includes(v.escopo) ? v.escopo : padrao.escopo,
    salas: Array.isArray(v.salas) ? v.salas.filter((sala) => typeof sala === "string" && sala) : [],
    vigenteDesde: typeof v.vigenteDesde === "string" ? v.vigenteDesde : null,
  };
}

// The effective-since instant is set by the server whenever the shutdown is enabled or its time or
// scope changes, so a change never applies retroactively to an occurrence already due.
function validarDesligamentoDiario(entrada, atual) {
  if (!entrada || typeof entrada !== "object" || Array.isArray(entrada)) {
    throw new Error("desligamentoDiario deve ser um objeto");
  }
  const proximo = { ...atual };
  if (Object.prototype.hasOwnProperty.call(entrada, "ativo")) {
    if (typeof entrada.ativo !== "boolean") throw new Error("desligamentoDiario.ativo deve ser verdadeiro ou falso");
    proximo.ativo = entrada.ativo;
  }
  if (Object.prototype.hasOwnProperty.call(entrada, "hora")) {
    if (typeof entrada.hora !== "string" || !HORA_HHMM.test(entrada.hora)) {
      throw new Error("desligamentoDiario.hora deve estar no formato HH:MM (00:00 a 23:59)");
    }
    proximo.hora = entrada.hora;
  }
  if (Object.prototype.hasOwnProperty.call(entrada, "escopo")) {
    if (!ESCOPOS_DESLIGAMENTO_DIARIO.includes(entrada.escopo)) {
      throw new Error(`desligamentoDiario.escopo deve ser um de: ${ESCOPOS_DESLIGAMENTO_DIARIO.join(", ")}`);
    }
    proximo.escopo = entrada.escopo;
  }
  if (Object.prototype.hasOwnProperty.call(entrada, "salas")) {
    const lista = entrada.salas;
    if (!Array.isArray(lista) || !lista.every((sala) => typeof sala === "string" && sala.trim())) {
      throw new Error("desligamentoDiario.salas deve ser uma lista de salas");
    }
    const unicas = [...new Set(lista.map((sala) => sala.trim()))];
    const existentes = new Set(db.prepare("SELECT sala FROM salas").all().map((r) => r.sala));
    const desconhecida = unicas.find((sala) => !existentes.has(sala));
    if (desconhecida) throw new Error(`sala desconhecida no desligamento diário: ${desconhecida}`);
    proximo.salas = unicas.sort();
  }
  if (proximo.ativo && proximo.escopo === "selecionadas" && proximo.salas.length === 0) {
    throw new Error("selecione ao menos uma sala para o desligamento diário");
  }
  const mudou = proximo.ativo !== atual.ativo
    || proximo.hora !== atual.hora
    || proximo.escopo !== atual.escopo
    || JSON.stringify(proximo.salas) !== JSON.stringify(atual.salas);
  if (!proximo.ativo) proximo.vigenteDesde = null;
  else if (mudou || !proximo.vigenteDesde) proximo.vigenteDesde = utcSqlite();
  return proximo;
}

const TURBO_FUNCOES_EXTRAS_VALIDAS = ["nenhuma", "swing"];

const CHAVES_NUMERICAS = ["timeoutInatividadeMinutos", "timeoutInatividadeAdminMinutos", "retencaoAuditoriaDias", "popupAvisoSegundos", "limiarOnlineMinutos"];
const CHAVES_BOOLEANAS_CRITICAS = ["modoTeste", "modoManutencao", "espCredenciaisObrigatorias", "espApExigirCredencial", "autoLigar"];
const CHAVES_NUMERICAS_CRITICAS = ["temperaturaMinima", "temperaturaMaxima"];
const CHAVES_LISTA_CRITICAS = ["redesAutorizadas"];
const CHAVES_TEXTO_CRITICAS = ["turboFuncaoExtra"];
const CHAVES_OBJETO = ["desligamentoDiario"];

function obter() {
  const linhas = db.prepare(`SELECT chave, valor FROM configuracoes`).all();
  const armazenado = {};
  for (const { chave, valor } of linhas) {
    if (valor === null) {
      armazenado[chave] = null;
      continue;
    }
    try {
      armazenado[chave] = JSON.parse(valor);
    } catch (erro) {
      logger.warn("configuracao-valor-invalido", { chave, mensagem: erro.message });
    }
  }
  const configuracoes = { ...PADROES, ...armazenado };
  configuracoes.desligamentoDiario = normalizarDesligamentoDiario(configuracoes.desligamentoDiario);
  if (!(Number(configuracoes.timeoutInatividadeMinutos) > 0)) {
    configuracoes.timeoutInatividadeMinutos = PADROES.timeoutInatividadeMinutos;
  }
  if (!Object.prototype.hasOwnProperty.call(armazenado, "timeoutInatividadeAdminMinutos")
    && armazenado.adminSujeitoTimeout === true
    && Number(armazenado.timeoutInatividadeMinutos) > 0) {
    configuracoes.timeoutInatividadeAdminMinutos = Number(armazenado.timeoutInatividadeMinutos);
  }
  if (!(Number(configuracoes.timeoutInatividadeAdminMinutos) > 0)) {
    configuracoes.timeoutInatividadeAdminMinutos = PADROES.timeoutInatividadeAdminMinutos;
  }
  return configuracoes;
}

function timeoutEfetivoParaUsuario(isAdmin, cfg = null) {
  const atual = cfg || obter();
  return isAdmin ? atual.timeoutInatividadeAdminMinutos : atual.timeoutInatividadeMinutos;
}

function limitesTemperatura() {
  const cfg = obter();
  return { minima: cfg.temperaturaMinima, maxima: cfg.temperaturaMaxima };
}

function limitesEfetivosDaSala(salaRow, cfg = null) {
  const { minima, maxima } = cfg ? { minima: cfg.temperaturaMinima, maxima: cfg.temperaturaMaxima } : limitesTemperatura();
  return {
    minima: Number.isFinite(salaRow?.temperaturaMinima) ? salaRow.temperaturaMinima : minima,
    maxima: Number.isFinite(salaRow?.temperaturaMaxima) ? salaRow.temperaturaMaxima : maxima,
  };
}

function turboFuncaoExtra() {
  return obter().turboFuncaoExtra;
}

function autoLigarAtivo(cfg = null) {
  return (cfg || obter()).autoLigar !== false;
}

function politicaApDispositivo() {
  return { tipo: "config_ap", exigirCredencial: !!obter().espApExigirCredencial };
}

function acessoRestritoAtivo() {
  const cfg = obter();
  return { modoTeste: !!cfg.modoTeste, redesAutorizadas: cfg.redesAutorizadas || [] };
}

function modoManutencaoAtivo(cfg = null) {
  return !!(cfg || obter()).modoManutencao;
}

function validarEAtualizar(patch, requisitante) {
  const souSuperAdmin = !!requisitante && requisitante.nivel === 3;
  if (!souSuperAdmin) {
    const erro = new Error("apenas o superadministrador pode alterar configurações do sistema");
    erro.permissao = true;
    throw erro;
  }

  const atual = obter();
  const proximo = { ...atual };

  for (const chave of CHAVES_NUMERICAS) {
    if (Object.prototype.hasOwnProperty.call(patch, chave)) {
      const n = Number(patch[chave]);
      if (chave === "retencaoAuditoriaDias" && (!Number.isInteger(n) || n < 1 || n > 365)) {
        throw new Error("retencaoAuditoriaDias deve ser um inteiro entre 1 e 365");
      }
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`${chave} deve ser um número maior que zero`);
      }
      proximo[chave] = n;
    }
  }

  for (const chave of CHAVES_BOOLEANAS_CRITICAS) {
    if (Object.prototype.hasOwnProperty.call(patch, chave)) {
      proximo[chave] = !!patch[chave];
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "temperaturaMinima") || Object.prototype.hasOwnProperty.call(patch, "temperaturaMaxima")) {
    const min = Object.prototype.hasOwnProperty.call(patch, "temperaturaMinima") ? Number(patch.temperaturaMinima) : atual.temperaturaMinima;
    const max = Object.prototype.hasOwnProperty.call(patch, "temperaturaMaxima") ? Number(patch.temperaturaMaxima) : atual.temperaturaMaxima;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 16 || max > 30 || min >= max) {
      throw new Error("limites de temperatura inválidos (mínima deve ser menor que máxima, entre 16 e 30)");
    }
    proximo.temperaturaMinima = min;
    proximo.temperaturaMaxima = max;
  }

  if (Object.prototype.hasOwnProperty.call(patch, "redesAutorizadas")) {
    const lista = patch.redesAutorizadas;
    if (!Array.isArray(lista) || !lista.every((v) => typeof v === "string" && v.trim())) {
      throw new Error("redesAutorizadas deve ser uma lista de faixas de IP (ex: 10.0.0.0/8)");
    }
    proximo.redesAutorizadas = lista.map((v) => v.trim());
  }

  if (Object.prototype.hasOwnProperty.call(patch, "desligamentoDiario")) {
    proximo.desligamentoDiario = validarDesligamentoDiario(patch.desligamentoDiario, atual.desligamentoDiario);
  }

  if (Object.prototype.hasOwnProperty.call(patch, "turboFuncaoExtra")) {
    if (!TURBO_FUNCOES_EXTRAS_VALIDAS.includes(patch.turboFuncaoExtra)) {
      throw new Error(`turboFuncaoExtra deve ser um de: ${TURBO_FUNCOES_EXTRAS_VALIDAS.join(", ")}`);
    }
    proximo.turboFuncaoExtra = patch.turboFuncaoExtra;
  }

  const salasComLimitesInvalidos = db.prepare(`
    SELECT sala FROM salas
    WHERE COALESCE(temperaturaMinima, ?) >= COALESCE(temperaturaMaxima, ?)
  `).all(proximo.temperaturaMinima, proximo.temperaturaMaxima);
  if (salasComLimitesInvalidos.length > 0) {
    throw new Error(`os novos limites globais entram em conflito com os limites da sala ${salasComLimitesInvalidos[0].sala}`);
  }

  const gravar = db.prepare(
    `INSERT INTO configuracoes (chave, valor) VALUES (?, ?)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`
  );

  const chavesArmazenaveis = [
    ...CHAVES_NUMERICAS,
    ...CHAVES_BOOLEANAS_CRITICAS,
    ...CHAVES_NUMERICAS_CRITICAS,
    ...CHAVES_LISTA_CRITICAS,
    ...CHAVES_TEXTO_CRITICAS,
    ...CHAVES_OBJETO,
  ];
  const estadoIRAlterado = proximo.temperaturaMinima !== atual.temperaturaMinima
    || proximo.temperaturaMaxima !== atual.temperaturaMaxima
    || proximo.turboFuncaoExtra !== atual.turboFuncaoExtra;
  db.exec("BEGIN");
  try {
    for (const chave of chavesArmazenaveis) {
      gravar.run(chave, JSON.stringify(proximo[chave]));
    }
    db.prepare(`
      UPDATE salas
      SET temperaturaAlvo = MAX(
        COALESCE(temperaturaMinima, ?),
        MIN(COALESCE(temperaturaMaxima, ?), temperaturaAlvo)
      )
    `).run(proximo.temperaturaMinima, proximo.temperaturaMaxima);
    db.prepare(`
      UPDATE agendamentos
      SET temperatura = MAX(
        COALESCE((SELECT temperaturaMinima FROM salas WHERE salas.sala = agendamentos.sala), ?),
        MIN(
          COALESCE((SELECT temperaturaMaxima FROM salas WHERE salas.sala = agendamentos.sala), ?),
          temperatura
        )
      )
    `).run(proximo.temperaturaMinima, proximo.temperaturaMaxima);
    // The rooms' desired state changes together with these limits/functions: the version advances
    // in the same transaction, so an echo of the previous version never confirms the new state.
    if (estadoIRAlterado) db.prepare(`UPDATE salas SET estadoVersao = estadoVersao + 1 WHERE irProtocolo IS NOT NULL`).run();
    db.exec("COMMIT");
  } catch (erro) {
    db.exec("ROLLBACK");
    throw erro;
  }

  const configuracoes = obter();
  if (Object.prototype.hasOwnProperty.call(patch, "modoManutencao")) {
    eventos.emit("mudanca-manutencao", !!configuracoes.modoManutencao);
  }
  if (proximo.espApExigirCredencial !== atual.espApExigirCredencial) {
    require("./deviceHub").difundirPoliticaAp(!!configuracoes.espApExigirCredencial);
  }
  if (estadoIRAlterado) {
    const salasService = require("./salasService");
    salasService.eventos.emit("mudanca");
    salasService.reenviarEstadoIRParaTodas();
  } else if (proximo.autoLigar !== atual.autoLigar) {
    require("./salasService").eventos.emit("mudanca");
  }
  if (JSON.stringify(proximo.desligamentoDiario) !== JSON.stringify(atual.desligamentoDiario)) {
    eventos.emit("mudanca-desligamento-diario", configuracoes.desligamentoDiario);
  }
  logger.info("configuracoes-alteradas", { chaves: Object.keys(patch), por: requisitante.id });
  return configuracoes;
}

module.exports = {
  obter,
  validarEAtualizar,
  timeoutEfetivoParaUsuario,
  limitesTemperatura,
  limitesEfetivosDaSala,
  turboFuncaoExtra,
  autoLigarAtivo,
  politicaApDispositivo,
  acessoRestritoAtivo,
  modoManutencaoAtivo,
  normalizarDesligamentoDiario,
  eventos,
  PADROES,
};
