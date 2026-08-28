const EventEmitter = require("events");
const db = require("../config/database");
const logger = require("../utils/logger");

const eventos = new EventEmitter();

const PADROES = {
  timeoutInatividadeMinutos: null,
  timeoutInatividadeMinutosSugestao: 15,
  adminSujeitoTimeout: false,
  popupAvisoSegundos: 60,
  limiarOnlineMinutos: 5,
  temperaturaMinima: 23,
  temperaturaMaxima: 25,
  turboFuncaoExtra: "nenhuma",
  modoTeste: process.env.NODE_ENV !== "production",
  redesAutorizadas: [],
  modoManutencao: false,
  espCredenciaisObrigatorias: false,
};

const TURBO_FUNCOES_EXTRAS_VALIDAS = ["nenhuma", "swing"];

const CHAVES_NUMERICAS_ANULAVEIS = ["timeoutInatividadeMinutos"];
const CHAVES_NUMERICAS = ["popupAvisoSegundos", "limiarOnlineMinutos"];
const CHAVES_BOOLEANAS = ["adminSujeitoTimeout"];
const CHAVES_BOOLEANAS_CRITICAS = ["modoTeste", "modoManutencao", "espCredenciaisObrigatorias"];
const CHAVES_NUMERICAS_CRITICAS = ["temperaturaMinima", "temperaturaMaxima"];
const CHAVES_LISTA_CRITICAS = ["redesAutorizadas"];
const CHAVES_TEXTO_CRITICAS = ["turboFuncaoExtra"];

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
  return { ...PADROES, ...armazenado };
}

function timeoutEfetivoParaUsuario(isAdmin) {
  const cfg = obter();
  if (!cfg.timeoutInatividadeMinutos) return null;
  if (isAdmin && !cfg.adminSujeitoTimeout) return null;
  return cfg.timeoutInatividadeMinutos;
}

function limitesTemperatura() {
  const cfg = obter();
  return { minima: cfg.temperaturaMinima, maxima: cfg.temperaturaMaxima };
}

function limitesEfetivosDaSala(salaRow) {
  const { minima, maxima } = limitesTemperatura();
  return {
    minima: Number.isFinite(salaRow?.temperaturaMinima) ? salaRow.temperaturaMinima : minima,
    maxima: Number.isFinite(salaRow?.temperaturaMaxima) ? salaRow.temperaturaMaxima : maxima,
  };
}

function turboFuncaoExtra() {
  return obter().turboFuncaoExtra;
}

function acessoRestritoAtivo() {
  const cfg = obter();
  return { modoTeste: !!cfg.modoTeste, redesAutorizadas: cfg.redesAutorizadas || [] };
}

function modoManutencaoAtivo() {
  return !!obter().modoManutencao;
}

function validarEAtualizar(patch, requisitante) {
  const souSuperAdmin = !!requisitante && requisitante.nivel === 3;
  if (!souSuperAdmin) {
    const erro = new Error("apenas o administrador principal pode alterar configurações do sistema");
    erro.permissao = true;
    throw erro;
  }

  const atual = obter();
  const proximo = { ...atual };

  if (Object.prototype.hasOwnProperty.call(patch, "timeoutInatividadeMinutos")) {
    const v = patch.timeoutInatividadeMinutos;
    if (v === null || v === "" || v === undefined) {
      proximo.timeoutInatividadeMinutos = null;
    } else {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error("tempo de inatividade deve ser um número de minutos maior que zero (ou vazio para indefinido)");
      }
      proximo.timeoutInatividadeMinutos = n;
    }
  }

  for (const chave of CHAVES_NUMERICAS) {
    if (Object.prototype.hasOwnProperty.call(patch, chave)) {
      const n = Number(patch[chave]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`${chave} deve ser um número maior que zero`);
      }
      proximo[chave] = n;
    }
  }

  for (const chave of CHAVES_BOOLEANAS) {
    if (Object.prototype.hasOwnProperty.call(patch, chave)) {
      proximo[chave] = !!patch[chave];
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
    ...CHAVES_NUMERICAS_ANULAVEIS,
    ...CHAVES_NUMERICAS,
    ...CHAVES_BOOLEANAS,
    ...CHAVES_BOOLEANAS_CRITICAS,
    ...CHAVES_NUMERICAS_CRITICAS,
    ...CHAVES_LISTA_CRITICAS,
    ...CHAVES_TEXTO_CRITICAS,
  ];
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
    db.exec("COMMIT");
  } catch (erro) {
    db.exec("ROLLBACK");
    throw erro;
  }

  const configuracoes = obter();
  if (Object.prototype.hasOwnProperty.call(patch, "modoManutencao")) {
    eventos.emit("mudanca-manutencao", !!configuracoes.modoManutencao);
  }
  const estadoIRAlterado = proximo.temperaturaMinima !== atual.temperaturaMinima
    || proximo.temperaturaMaxima !== atual.temperaturaMaxima
    || proximo.turboFuncaoExtra !== atual.turboFuncaoExtra;
  if (estadoIRAlterado) {
    const salasService = require("./salasService");
    const deviceHub = require("./deviceHub");
    salasService.eventos.emit("mudanca");
    for (const sala of salasService.listar()) {
      const comando = salasService.comandoEstadoIR(sala);
      if (comando) deviceHub.enviarComando(sala.sala, comando);
    }
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
  acessoRestritoAtivo,
  modoManutencaoAtivo,
  eventos,
  PADROES,
};
