const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const logger = require("../utils/logger");
const otaService = require("./otaService");
const notificacoesService = require("./notificacoesService");

const ARQUIVO_ROLLOUT = path.join(otaService.DIR_FIRMWARE, "rollout-ota.json");

const MAX_DISPOSITIVOS = 50;
const LOTE_MIN = 1;
const LOTE_MAX = 5;
const LOTE_PADRAO = Math.min(otaService.MAX_SIMULTANEOS, LOTE_MAX);
const GRACA_ESPERA_MS = 2 * 60 * 1000;

const ESTADOS_ATIVOS = new Set(["preflight", "canario", "lotes", "pausado"]);
const EM_VOO = new Set(["atualizando", "reiniciando"]);
const FALHAS = new Set(["falhou", "revertido", "indeterminado"]);
const TERMINAIS = new Set(["validado", "falhou", "revertido", "indeterminado", "ignorado", "cancelado"]);
const CODIGOS_TEMPORARIOS = new Set(["desconectado", "ota-em-andamento", "modo-config"]);

const ROTULOS_FALHA = {
  falhou: "falhou antes de gravar",
  revertido: "reverteu para a versão anterior",
  indeterminado: "não voltou a se conectar depois de gravar",
};

let rollout = null;
let processando = false;
let reavaliar = false;
let ouvindo = false;

function agora() {
  return new Date().toISOString();
}

function persistir() {
  try {
    fs.mkdirSync(otaService.DIR_FIRMWARE, { recursive: true, mode: 0o700 });
    const temporario = `${ARQUIVO_ROLLOUT}.tmp`;
    fs.writeFileSync(temporario, JSON.stringify(rollout, null, 2), { mode: 0o600 });
    fs.renameSync(temporario, ARQUIVO_ROLLOUT);
  } catch (erro) {
    logger.warn("ota-rollout-persistir-falhou", { mensagem: erro.message });
  }
}

function emitir() {
  try {
    require("./deviceHub").eventos.emit("ota-rollout", { rollout: atual() });
  } catch (erro) {
    logger.warn("ota-rollout-emitir-falhou", { mensagem: erro.message });
  }
}

function registrar() {
  rollout.atualizadoEm = agora();
  persistir();
  emitir();
}

function ativo() {
  return !!rollout && ESTADOS_ATIVOS.has(rollout.estado);
}

function atual() {
  return rollout ? JSON.parse(JSON.stringify(rollout)) : null;
}

function doLote(numero) {
  return rollout.dispositivos.filter((d) => d.lote === numero);
}

function ultimoLote() {
  return rollout.dispositivos.reduce((maior, d) => Math.max(maior, d.lote), 0);
}

function marcar(dispositivo, estado, motivo) {
  dispositivo.estado = estado;
  dispositivo.motivo = motivo || null;
  if (TERMINAIS.has(estado)) dispositivo.finalizadoEm = agora();
  registrar();
}

function erroConflito(mensagem) {
  const err = new Error(mensagem);
  err.conflito = true;
  return err;
}

function contarPorEstado() {
  const contagem = { validados: 0, falhas: 0, ignorados: 0, pendentes: 0, emAndamento: 0 };
  for (const d of rollout.dispositivos) {
    if (d.estado === "validado") contagem.validados += 1;
    else if (FALHAS.has(d.estado)) contagem.falhas += 1;
    else if (d.estado === "ignorado" || d.estado === "cancelado") contagem.ignorados += 1;
    else if (EM_VOO.has(d.estado)) contagem.emAndamento += 1;
    else contagem.pendentes += 1;
  }
  return contagem;
}

function iniciarDispositivo(dispositivo, manifesto) {
  const elegibilidade = otaService.avaliarElegibilidade(dispositivo.sala, manifesto);
  if (!elegibilidade.elegivel) {
    if (!CODIGOS_TEMPORARIOS.has(elegibilidade.codigo)) {
      marcar(dispositivo, "ignorado", elegibilidade.motivo);
      return "ignorado";
    }
    if (dispositivo.aguardandoDesde && Date.now() - Date.parse(dispositivo.aguardandoDesde) >= GRACA_ESPERA_MS) {
      marcar(dispositivo, "ignorado", `${elegibilidade.motivo} após ${GRACA_ESPERA_MS / 60000} min de espera`);
      return "ignorado";
    }
    if (!dispositivo.aguardandoDesde || dispositivo.motivo !== elegibilidade.motivo) {
      dispositivo.aguardandoDesde = dispositivo.aguardandoDesde || agora();
      dispositivo.motivo = elegibilidade.motivo;
      registrar();
    }
    return "aguardando";
  }

  dispositivo.aguardandoDesde = null;
  dispositivo.versaoAnterior = elegibilidade.versaoDispositivo;
  dispositivo.iniciadoEm = agora();
  marcar(dispositivo, "atualizando", null);
  try {
    otaService.ofertar(dispositivo.sala);
  } catch (erro) {
    dispositivo.iniciadoEm = null;
    if (erro.limite) {
      marcar(dispositivo, "pendente", null);
      return "adiado";
    }
    marcar(dispositivo, "ignorado", erro.message);
    return "ignorado";
  }
  dispositivo.ofertadoEm = agora();
  registrar();
  logger.info("ota-rollout-dispositivo-iniciado", { rollout: rollout.id, sala: dispositivo.sala, lote: dispositivo.lote });
  return "iniciado";
}

function motivoDoLote(falhas) {
  const detalhes = falhas.map((d) => `${d.sala} ${ROTULOS_FALHA[d.estado] || d.estado}`).join("; ");
  return rollout.loteAtual === 0
    ? `o canário não passou na validação: ${detalhes}`
    : `falha no lote ${rollout.loteAtual}: ${detalhes}`;
}

function encerrar(estado, motivo) {
  rollout.estado = estado;
  rollout.motivoParada = motivo || null;
  rollout.finalizadoEm = agora();
  registrar();
  const resumo = contarPorEstado();
  logger.info("ota-rollout-encerrado", { rollout: rollout.id, estado, motivo: motivo || null, ...resumo });
  const texto = estado === "concluido"
    ? `Distribuição do firmware ${rollout.versao} concluída: ${resumo.validados} atualizado(s), ${resumo.ignorados} não atualizado(s).`
    : `Distribuição do firmware ${rollout.versao} ${estado === "cancelado" ? "cancelada" : "interrompida"}${motivo ? `: ${motivo}` : "."}`;
  try {
    notificacoesService.criar({ tipo: estado === "concluido" ? "esp32_ota_ok" : "esp32_ota_falha", mensagem: texto });
  } catch (erro) {
    logger.warn("ota-rollout-notificacao-falhou", { mensagem: erro.message });
  }
  if (estado === "interrompido") {
    try {
      require("./monitoramentoService").registrar("otaFalha", { rollout: rollout.id, motivo: motivo || null });
    } catch {}
  }
}

function passo() {
  while (ativo()) {
    const lote = doLote(rollout.loteAtual);
    const emVoo = lote.filter((d) => EM_VOO.has(d.estado)).length;

    if (rollout.cancelamentoSolicitado) {
      if (emVoo > 0) return;
      encerrar("cancelado", rollout.motivoParada);
      return;
    }
    if (rollout.pausaSolicitada && rollout.dispositivos.some((d) => d.estado === "pendente")) {
      if (emVoo > 0) return;
      if (rollout.estado !== "pausado") {
        rollout.estado = "pausado";
        registrar();
      }
      return;
    }

    const pendentes = lote.filter((d) => d.estado === "pendente");
    if (pendentes.length) {
      const manifesto = otaService.lerManifesto();
      if (!manifesto || manifesto.sha256 !== rollout.sha256 || manifesto.versao !== rollout.versao) {
        encerrar("interrompido", "o firmware publicado mudou durante a distribuição");
        return;
      }
      let vagas = otaService.vagasDisponiveis();
      if (vagas <= 0) return;
      let progrediu = false;
      for (const dispositivo of pendentes) {
        if (vagas <= 0) break;
        const resultado = iniciarDispositivo(dispositivo, manifesto);
        if (resultado === "adiado") return;
        if (resultado === "iniciado") {
          vagas -= 1;
          progrediu = true;
        } else if (resultado === "ignorado") {
          progrediu = true;
        }
      }
      if (!progrediu) return;
      continue;
    }
    if (emVoo > 0) return;

    const falhas = lote.filter((d) => FALHAS.has(d.estado));
    if (falhas.length) {
      encerrar("interrompido", motivoDoLote(falhas));
      return;
    }
    if (rollout.loteAtual === 0 && !lote.some((d) => d.estado === "validado")) {
      const canario = lote[0];
      encerrar("interrompido", `o canário ${canario ? canario.sala : ""} não foi atualizado: ${canario && canario.motivo ? canario.motivo : "sem resultado"}`);
      return;
    }
    if (rollout.loteAtual >= ultimoLote()) {
      encerrar("concluido", null);
      return;
    }
    rollout.loteAtual += 1;
    rollout.estado = "lotes";
    registrar();
  }
}

function avancar() {
  if (processando) {
    reavaliar = true;
    return;
  }
  processando = true;
  try {
    do {
      reavaliar = false;
      passo();
    } while (reavaliar);
  } finally {
    processando = false;
  }
}

function estadoDeDispositivo(ota) {
  if (!ota) return null;
  if (ota.fase === "ofertado" || ota.fase === "baixando") return { estado: "atualizando", motivo: null };
  if (ota.fase === "gravado" || ota.fase === "reiniciando") return { estado: "reiniciando", motivo: null };
  if (ota.fase === "concluido") return { estado: "validado", motivo: null };
  if (ota.fase !== "falhou") return null;
  if (ota.causa === "rollback") return { estado: "revertido", motivo: ota.erro || null };
  if (ota.causa === "reinicio") return { estado: "indeterminado", motivo: ota.erro || null };
  return { estado: "falhou", motivo: ota.erro || null };
}

function aplicarOta(dispositivo, ota) {
  if (TERMINAIS.has(dispositivo.estado) || dispositivo.estado === "pendente") return;
  const proximo = estadoDeDispositivo(ota);
  if (!proximo || proximo.estado === dispositivo.estado) return;
  marcar(dispositivo, proximo.estado, proximo.motivo);
}

function aoEventoOta({ sala, estado }) {
  if (!ativo()) return;
  const dispositivo = rollout.dispositivos.find((d) => d.sala === sala);
  if (dispositivo) aplicarOta(dispositivo, estado);
  avancar();
}

function aoEventoConexao({ conectado }) {
  if (!ativo() || !conectado) return;
  avancar();
}

function ouvirEventos() {
  if (ouvindo) return;
  ouvindo = true;
  const { eventos } = require("./deviceHub");
  eventos.on("ota", aoEventoOta);
  eventos.on("conexao", aoEventoConexao);
}

function carregar() {
  let bruto;
  try {
    bruto = JSON.parse(fs.readFileSync(ARQUIVO_ROLLOUT, "utf8"));
  } catch (erro) {
    if (erro.code !== "ENOENT") logger.warn("ota-rollout-carregar-falhou", { mensagem: erro.message });
    return;
  }
  if (!bruto || typeof bruto !== "object" || typeof bruto.id !== "string" || typeof bruto.estado !== "string") return;
  if (!Array.isArray(bruto.dispositivos) || !bruto.dispositivos.every((d) => d && typeof d.sala === "string" && typeof d.estado === "string")) return;
  rollout = bruto;
}

function reconciliar() {
  if (!ativo()) return;
  let mudou = false;
  for (const dispositivo of rollout.dispositivos) {
    if (TERMINAIS.has(dispositivo.estado) || dispositivo.estado === "pendente") continue;
    const ota = otaService.estadoDaSala(dispositivo.sala);
    if (ota.fase === "ocioso") {
      if (dispositivo.ofertadoEm) {
        dispositivo.estado = "indeterminado";
        dispositivo.motivo = "o servidor reiniciou sem registro do desfecho desta atualização";
        dispositivo.finalizadoEm = agora();
      } else {
        dispositivo.estado = "pendente";
        dispositivo.iniciadoEm = null;
      }
      mudou = true;
      continue;
    }
    const proximo = estadoDeDispositivo(ota);
    if (proximo && proximo.estado !== dispositivo.estado) {
      dispositivo.estado = proximo.estado;
      dispositivo.motivo = proximo.motivo;
      if (TERMINAIS.has(proximo.estado)) dispositivo.finalizadoEm = agora();
      mudou = true;
    }
  }
  logger.info("ota-rollout-reconciliado", { rollout: rollout.id, estado: rollout.estado, ...contarPorEstado() });
  if (mudou) registrar();
}

function validarSelecao(salas) {
  const salasService = require("./salasService");
  if (!Array.isArray(salas) || salas.length === 0) throw new Error("selecione ao menos um dispositivo");
  if (salas.length > MAX_DISPOSITIVOS) throw new Error(`selecione no máximo ${MAX_DISPOSITIVOS} dispositivos por distribuição`);
  const vistas = new Set();
  const linhas = [];
  for (const sala of salas) {
    if (typeof sala !== "string" || !sala || sala.length > 100) throw new Error("lista de salas inválida");
    if (vistas.has(sala)) throw new Error(`sala repetida na seleção: ${sala}`);
    vistas.add(sala);
    const salaRow = salasService.buscar(sala);
    if (!salaRow) throw new Error(`sala não encontrada: ${sala}`);
    if (!salaRow.mac) throw new Error(`sala sem ESP32 cadastrado: ${sala}`);
    linhas.push(salaRow);
  }
  return linhas;
}

function iniciar({ salas, canario, tamanhoLote, ator } = {}) {
  if (ativo()) throw erroConflito("já existe uma distribuição de firmware em andamento");
  const manifesto = otaService.lerManifesto();
  if (!manifesto) throw erroConflito("nenhum firmware publicado — publique um com `npm run firmware` antes de distribuir");

  const linhas = validarSelecao(salas);
  const lote = tamanhoLote === undefined || tamanhoLote === null ? LOTE_PADRAO : Number(tamanhoLote);
  if (!Number.isInteger(lote) || lote < LOTE_MIN || lote > LOTE_MAX) {
    throw new Error(`tamanho de lote deve ser um inteiro entre ${LOTE_MIN} e ${LOTE_MAX}`);
  }
  if (canario !== undefined && canario !== null && !linhas.some((l) => l.sala === canario)) {
    throw new Error("o canário precisa estar entre os dispositivos selecionados");
  }

  const avaliacoes = new Map(linhas.map((l) => [l.sala, otaService.avaliarElegibilidade(l.sala, manifesto)]));
  const salaCanario = canario || (linhas.find((l) => avaliacoes.get(l.sala).elegivel) || {}).sala;
  if (!salaCanario) throw erroConflito("nenhum dispositivo selecionado está apto a receber a atualização agora");
  const avaliacaoCanario = avaliacoes.get(salaCanario);
  if (!avaliacaoCanario.elegivel) throw erroConflito(`o canário ${salaCanario} não está apto: ${avaliacaoCanario.motivo}`);

  const ordenados = [linhas.find((l) => l.sala === salaCanario), ...linhas.filter((l) => l.sala !== salaCanario)];

  rollout = {
    id: `rol_${crypto.randomBytes(6).toString("hex")}`,
    versao: manifesto.versao,
    sha256: manifesto.sha256,
    tamanhoLote: lote,
    estado: "preflight",
    loteAtual: 0,
    motivoParada: null,
    pausaSolicitada: false,
    cancelamentoSolicitado: false,
    criadoEm: agora(),
    atualizadoEm: agora(),
    finalizadoEm: null,
    iniciadoPor: ator && ator.usuario ? String(ator.usuario).slice(0, 60) : null,
    dispositivos: ordenados.map((linha, indice) => {
      const avaliacao = avaliacoes.get(linha.sala);
      const inapto = !avaliacao.elegivel && !CODIGOS_TEMPORARIOS.has(avaliacao.codigo);
      const numeroLote = indice === 0 ? 0 : Math.floor((indice - 1) / lote) + 1;
      return {
        sala: linha.sala,
        nome: linha.nome || linha.sala,
        lote: numeroLote,
        etapa: numeroLote === 0 ? "canario" : "lote",
        estado: inapto ? "ignorado" : "pendente",
        motivo: avaliacao.elegivel ? null : avaliacao.motivo,
        versaoAnterior: avaliacao.versaoDispositivo,
        aguardandoDesde: null,
        iniciadoEm: null,
        ofertadoEm: null,
        finalizadoEm: inapto ? agora() : null,
      };
    }),
  };
  rollout.estado = "canario";
  registrar();
  logger.info("ota-rollout-iniciado", {
    rollout: rollout.id,
    versao: rollout.versao,
    canario: salaCanario,
    dispositivos: rollout.dispositivos.length,
    tamanhoLote: lote,
  });
  avancar();
  return atual();
}

function pausar() {
  if (!ativo()) throw erroConflito("não há distribuição de firmware em andamento");
  if (rollout.cancelamentoSolicitado) throw erroConflito("a distribuição já está sendo cancelada");
  if (!rollout.pausaSolicitada) {
    rollout.pausaSolicitada = true;
    registrar();
    avancar();
  }
  return atual();
}

function retomar() {
  if (!ativo() || (rollout.estado !== "pausado" && !rollout.pausaSolicitada)) throw erroConflito("não há distribuição pausada");
  rollout.pausaSolicitada = false;
  rollout.estado = rollout.loteAtual === 0 ? "canario" : "lotes";
  registrar();
  avancar();
  return atual();
}

function cancelar() {
  if (!ativo()) throw erroConflito("não há distribuição de firmware em andamento");
  rollout.cancelamentoSolicitado = true;
  rollout.pausaSolicitada = false;
  rollout.motivoParada = "cancelada pelo superadministrador";
  for (const dispositivo of rollout.dispositivos) {
    if (dispositivo.estado === "pendente") {
      dispositivo.estado = "cancelado";
      dispositivo.motivo = "cancelado antes de iniciar";
      dispositivo.finalizadoEm = agora();
    }
  }
  registrar();
  avancar();
  return atual();
}

function tick() {
  if (!ativo()) return;
  avancar();
}

function elegibilidade(salaRow, manifesto) {
  const avaliacao = otaService.avaliarElegibilidade(salaRow.sala, manifesto);
  const noRollout = ativo() && rollout.dispositivos.some((d) => d.sala === salaRow.sala && !TERMINAIS.has(d.estado));
  return { sala: salaRow.sala, nome: salaRow.nome || salaRow.sala, noRollout, ...avaliacao };
}

carregar();
ouvirEventos();
reconciliar();

module.exports = {
  ARQUIVO_ROLLOUT,
  LOTE_MIN,
  LOTE_MAX,
  LOTE_PADRAO,
  MAX_DISPOSITIVOS,
  GRACA_ESPERA_MS,
  iniciar,
  pausar,
  retomar,
  cancelar,
  atual,
  ativo,
  tick,
  elegibilidade,
};
