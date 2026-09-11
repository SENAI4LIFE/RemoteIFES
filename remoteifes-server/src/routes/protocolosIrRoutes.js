const express = require("express");
const { exigirLogin, exigirAdmin, exigirSuperAdmin } = require("../middlewares/auth");
const protocolos = require("../services/protocolosIrService");
const deviceHub = require("../services/deviceHub");
const salasService = require("../services/salasService");
const auditoriaService = require("../services/auditoriaService");
const { compararVersoes } = require("../services/otaService");
const logger = require("../utils/logger");

const router = express.Router();
router.use("/admin/protocolos-ir", exigirLogin, exigirAdmin, exigirSuperAdmin);

const FIRMWARE_COM_MODO_CLONE = "4.1.0";

function auditar(dados) {
  try { auditoriaService.registrar(dados); } catch (erro) { logger.warn("auditoria-registro-falhou", { tipo: dados.tipo, mensagem: erro.message }); }
}

function estadoClonador() {
  const estado = protocolos.estadoClonador();
  return { ...estado, dispositivo: estado.sala ? deviceHub.estadoPublico(estado.sala) : null };
}

function responderEstado(res, extras = {}) {
  const clonador = estadoClonador();
  res.json({ ok: true, clonador, capturas: clonador.sala ? deviceHub.capturasRecentes(clonador.sala) : [], protocolos: protocolos.listar(), ...extras });
}

function capturaDoClonador(req, res) {
  const clonador = protocolos.obterClonador();
  if (!clonador) {
    res.status(409).json({ ok: false, erro: "nenhum módulo clonador foi definido" });
    return null;
  }
  const captura = deviceHub.capturaRecente(clonador.sala, req.body?.capturaId);
  if (!captura) {
    res.status(404).json({ ok: false, erro: "captura não encontrada no histórico recente da clonadora; capture o sinal novamente" });
    return null;
  }
  return captura;
}

function comandosModoClone(ativo, fwVersao) {
  if (!ativo) return [{ tipo: "exit_operation" }];
  const comparacao = compararVersoes(fwVersao, FIRMWARE_COM_MODO_CLONE);
  if (comparacao === null || comparacao < 0) {
    return [{ tipo: "enter_config" }, { tipo: "set_mode", modo: "clone" }, { tipo: "start_capture" }];
  }
  return [{ tipo: "enter_clone" }];
}

router.get("/admin/protocolos-ir", (req, res) => {
  responderEstado(res);
});

router.put("/admin/protocolos-ir/clonador", (req, res) => {
  try {
    const anterior = protocolos.obterClonador();
    const novo = protocolos.definirClonador(req.body?.sala ?? null);
    const sala = novo ? novo.sala : null;

    if (anterior && anterior.sala !== sala) {
      deviceHub.limparCapturas(anterior.sala);
      if (deviceHub.dispositivoConectado(anterior.sala)) {
        deviceHub.enviarComando(anterior.sala, { tipo: "exit_operation" });
        deviceHub.sincronizarPapel(anterior.sala);
      }
    }
    if (sala) deviceHub.sincronizarPapel(sala);

    auditar({
      tipo: sala ? "esp32_clonador_definido" : "esp32_clonador_removido",
      ator: req.usuario,
      alvoTipo: "esp32",
      alvoId: sala || anterior?.sala || null,
      alvoRotulo: sala || anterior?.sala || "nenhum",
      descricao: sala ? `Modulo clonador IR definido como ${sala} (${novo.mac})` : "Modulo clonador IR removido",
      camposAlterados: ["espClonador"],
    });
    responderEstado(res);
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.post("/admin/protocolos-ir/clonador/modo-clone", (req, res) => {
  const estado = protocolos.estadoClonador();
  if (!estado.sala) return res.status(409).json({ ok: false, erro: "nenhum módulo clonador foi definido" });
  if (!estado.vinculoValido) {
    return res.status(409).json({ ok: false, erro: "o ESP32 vinculado à sala mudou; confirme a clonadora novamente" });
  }
  const ativo = req.body?.ativo;
  if (typeof ativo !== "boolean") return res.status(400).json({ ok: false, erro: "ativo deve ser true ou false" });
  const dispositivo = deviceHub.estadoPublico(estado.sala);
  if (!dispositivo.conectado) return res.status(409).json({ ok: false, erro: "o módulo clonador não está conectado" });
  if (dispositivo.role !== "cloner") {
    return res.status(409).json({ ok: false, erro: "o dispositivo conectado nesta sala não é o ESP32 autorizado como clonador" });
  }

  deviceHub.sincronizarPapel(estado.sala);
  for (const comando of comandosModoClone(ativo, dispositivo.fwVersao)) {
    if (!deviceHub.enviarComando(estado.sala, comando)) {
      return res.status(409).json({ ok: false, erro: "não foi possível enviar o comando ao módulo clonador" });
    }
  }

  auditar({
    tipo: ativo ? "esp32_clonagem_ativada" : "esp32_clonagem_desativada",
    ator: req.usuario,
    alvoTipo: "esp32",
    alvoId: estado.sala,
    alvoRotulo: estado.sala,
    descricao: ativo ? `Modo clone ativado em ${estado.sala}` : `Modo clone encerrado em ${estado.sala}`,
  });
  res.json({ ok: true, ativo, clonador: estadoClonador() });
});

router.post("/admin/protocolos-ir", (req, res) => {
  const captura = capturaDoClonador(req, res);
  if (!captura) return;
  try {
    const protocolo = protocolos.criar({ label: req.body?.label, captura });
    auditar({ tipo: "protocolo_ir_criado", ator: req.usuario, alvoTipo: "protocolo_ir", alvoId: String(protocolo.id), alvoRotulo: protocolo.label, descricao: `Protocolo IR "${protocolo.label}" salvo a partir de ${captura.sala}`, camposAlterados: ["label", "raw", "protocolId"] });
    res.status(201).json({ ok: true, protocolo });
  } catch (err) {
    res.status(400).json({ ok: false, erro: err.message });
  }
});

router.put("/admin/protocolos-ir/:id/failsafe", (req, res) => {
  const captura = capturaDoClonador(req, res);
  if (!captura) return;
  try {
    const protocolo = protocolos.definirFailsafe(req.params.id, captura);
    const sincronizados = salasService.sincronizarFailsafeIRPorProtocolo(protocolo.id);
    auditar({ tipo: "protocolo_ir_failsafe_definido", ator: req.usuario, alvoTipo: "protocolo_ir", alvoId: String(protocolo.id), alvoRotulo: protocolo.label, descricao: `Failsafe OFF do protocolo IR "${protocolo.label}" atualizado (${protocolo.failsafe.raw.length} pulsos)`, camposAlterados: ["failsafeRaw", "failsafeCarrierHz"] });
    res.json({ ok: true, protocolo, sincronizados });
  } catch (err) {
    res.status(/não encontrado/.test(err.message) ? 404 : 400).json({ ok: false, erro: err.message });
  }
});

router.delete("/admin/protocolos-ir/:id/failsafe", (req, res) => {
  try {
    const protocolo = protocolos.limparFailsafe(req.params.id);
    const sincronizados = salasService.sincronizarFailsafeIRPorProtocolo(protocolo.id);
    auditar({ tipo: "protocolo_ir_failsafe_removido", ator: req.usuario, alvoTipo: "protocolo_ir", alvoId: String(protocolo.id), alvoRotulo: protocolo.label, descricao: `Failsafe OFF do protocolo IR "${protocolo.label}" removido`, camposAlterados: ["failsafeRaw", "failsafeCarrierHz"] });
    res.json({ ok: true, protocolo, sincronizados });
  } catch (err) {
    res.status(404).json({ ok: false, erro: err.message });
  }
});

router.patch("/admin/protocolos-ir/:id", (req, res) => {
  try {
    const protocolo = protocolos.renomear(req.params.id, req.body?.label);
    auditar({ tipo: "protocolo_ir_renomeado", ator: req.usuario, alvoTipo: "protocolo_ir", alvoId: String(protocolo.id), alvoRotulo: protocolo.label, descricao: `Protocolo IR renomeado para "${protocolo.label}"`, camposAlterados: ["label"] });
    res.json({ ok: true, protocolo });
  } catch (err) {
    res.status(/não encontrado/.test(err.message) ? 404 : 400).json({ ok: false, erro: err.message });
  }
});

router.delete("/admin/protocolos-ir/:id", (req, res) => {
  try {
    const salasAfetadas = protocolos.salasAtribuidas(req.params.id);
    const protocolo = protocolos.excluir(req.params.id);
    for (const sala of salasAfetadas) salasService.enviarFailsafeIRParaDispositivo(salasService.buscar(sala));
    auditar({ tipo: "protocolo_ir_excluido", ator: req.usuario, alvoTipo: "protocolo_ir", alvoId: String(protocolo.id), alvoRotulo: protocolo.label, descricao: `Protocolo IR "${protocolo.label}" excluido${salasAfetadas.length ? ` (failsafe removido de ${salasAfetadas.join(", ")})` : ""}` });
    res.json({ ok: true, salasAfetadas });
  } catch (err) {
    res.status(404).json({ ok: false, erro: err.message });
  }
});

router.post("/admin/protocolos-ir/:id/transmitir", (req, res) => {
  const protocolo = protocolos.buscar(req.params.id);
  if (!protocolo) return res.status(404).json({ ok: false, erro: "protocolo não encontrado" });
  const sala = req.body?.sala;
  if (typeof sala !== "string" || !salasService.buscar(sala)) return res.status(400).json({ ok: false, erro: "sala de destino inválida" });
  if (!deviceHub.dispositivoConectado(sala)) return res.status(409).json({ ok: false, erro: "o ESP32 de destino não está conectado" });
  if (!deviceHub.enviarComando(sala, { tipo: "send_raw", raw: protocolo.raw, carrierHz: protocolo.carrierHz })) {
    return res.status(409).json({ ok: false, erro: "não foi possível enviar ao dispositivo" });
  }
  auditar({ tipo: "protocolo_ir_transmitido", ator: req.usuario, alvoTipo: "esp32", alvoId: sala, alvoRotulo: sala, descricao: `Protocolo IR "${protocolo.label}" transmitido por ${sala}` });
  res.json({ ok: true });
});

router.post("/admin/protocolos-ir/:id/aplicar/:sala", (req, res) => {
  const protocolo = protocolos.buscar(req.params.id);
  if (!protocolo) return res.status(404).json({ ok: false, erro: "protocolo não encontrado" });
  if (!protocolo.isKnown || !Number.isInteger(protocolo.protocolId)) {
    return res.status(400).json({ ok: false, erro: "somente protocolos reconhecidos pela biblioteca podem ser o protocolo operacional da sala" });
  }
  try {
    const sala = salasService.definirProtocoloIR(req.params.sala, protocolo.protocolId, protocolo.id);
    auditar({ tipo: "esp32_protocolo_alterado", ator: req.usuario, alvoTipo: "esp32", alvoId: sala.sala, alvoRotulo: sala.sala, descricao: `Protocolo IR "${protocolo.label}" aplicado em ${sala.sala}${protocolo.failsafe ? " com failsafe OFF" : " sem failsafe OFF"}`, camposAlterados: ["irProtocolo", "irProtocoloRegistroId"] });
    res.json({ ok: true, sala: { sala: sala.sala, irProtocolo: sala.irProtocolo, irProtocoloRegistroId: sala.irProtocoloRegistroId }, failsafeSincronizado: deviceHub.dispositivoConectado(sala.sala) });
  } catch (err) {
    res.status(/não encontrada/.test(err.message) ? 404 : 400).json({ ok: false, erro: err.message });
  }
});

module.exports = router;
