const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { DIR_DADOS } = require("../config/paths");
const { normalizarIp } = require("../utils/rede");
const deviceHub = require("../services/deviceHub");
const otaService = require("../services/otaService");
const otaRolloutService = require("../services/otaRolloutService");
const logger = require("../utils/logger");

const router = express.Router();

// Readiness contract for the Operations Console.
//
// It exists because the state that decides whether stopping is safe belongs to the process, not the
// database: `deviceHub.conexoes`, `otaService.estados` and the rollout live in memory in this
// process. An external observer cannot read them from SQLite, and having the Console load
// `src/app.js` would create/migrate the database from another process.
//
// Deliberately minimal:
//  - answers only on loopback and only with the shared secret in <DIR_DADOS>/.console-token;
//  - without the secret file the route does not exist (404): installations without the Console pay
//    nothing;
//  - reads only in-memory structures: no history query, no aggregation.

const CAMINHO_TOKEN = path.join(DIR_DADOS, ".console-token");
const FASES_ATIVAS = ["ofertado", "baixando", "gravado", "reiniciando", "validando"];

let tokenCache = { valor: null, mtimeMs: 0, verificadoEm: 0 };

function lerToken() {
  const agora = Date.now();
  if (agora - tokenCache.verificadoEm < 5000) return tokenCache.valor;
  tokenCache.verificadoEm = agora;
  try {
    const info = fs.statSync(CAMINHO_TOKEN);
    if (info.mtimeMs === tokenCache.mtimeMs && tokenCache.valor) return tokenCache.valor;
    const valor = fs.readFileSync(CAMINHO_TOKEN, "utf8").trim();
    tokenCache = { valor: valor || null, mtimeMs: info.mtimeMs, verificadoEm: agora };
  } catch {
    tokenCache = { valor: null, mtimeMs: 0, verificadoEm: agora };
  }
  return tokenCache.valor;
}

function comparacaoConstante(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function autorizar(req, res, next) {
  const esperado = lerToken();
  if (!esperado) return res.status(404).json({ ok: false, erro: "não encontrado" });
  // The IP is the socket's: TRUST_PROXY must not turn a remote client into loopback here.
  const enderecoSocket = normalizarIp(req.socket && req.socket.remoteAddress);
  if (enderecoSocket !== "127.0.0.1") {
    return res.status(403).json({ ok: false, erro: "disponível apenas no host" });
  }
  const header = req.headers.authorization || "";
  const [tipo, token] = header.split(" ");
  if (tipo !== "Bearer" || !comparacaoConstante(token, esperado)) {
    logger.warn("prontidao-nao-autorizada", { requestId: req.id });
    return res.status(401).json({ ok: false, erro: "não autenticado" });
  }
  next();
}

router.get("/manutencao/prontidao", autorizar, (req, res) => {
  const estadosDispositivos = deviceHub.listarEstados();
  const salas = Object.keys(estadosDispositivos);
  const canaisDeComando = salas.filter((sala) => deviceHub.canalDeComandos(sala));

  const estadosOta = otaService.listarEstados();
  const porFase = {};
  for (const fase of FASES_ATIVAS) porFase[fase] = 0;
  const salasComOtaAtiva = [];
  for (const [sala, estado] of Object.entries(estadosOta)) {
    if (!estado || !FASES_ATIVAS.includes(estado.fase)) continue;
    porFase[estado.fase] += 1;
    salasComOtaAtiva.push(sala);
  }

  const rollout = otaRolloutService.atual();
  const rolloutResumo = rollout
    ? {
        ativo: otaRolloutService.ativo(),
        estado: rollout.estado || null,
        versao: rollout.versao || null,
        pausado: rollout.estado === "pausado",
        // A paused rollout with pending work touches devices again when resumed: it counts as
        // conflicting maintenance even while stopped.
        //
        // The count comes from `rollout.dispositivos[].estado`, the service's actual structure.
        pendentes: Array.isArray(rollout.dispositivos)
          ? rollout.dispositivos.filter((d) => d && d.estado === "pendente").length
          : null,
        emAndamento: Array.isArray(rollout.dispositivos)
          ? rollout.dispositivos.filter((d) => d && ["atualizando", "reiniciando", "validando"].includes(d.estado)).length
          : null,
      }
    : null;

  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    em: new Date().toISOString(),
    dispositivos: {
      conectados: salas.length,
      // Presence in the hub is not an open command channel: an HTTP heartbeat keeps the device
      // "online" with no socket to send a command through.
      canaisDeComando: canaisDeComando.length,
      salas: canaisDeComando.slice(0, 200),
    },
    ota: {
      ativos: salasComOtaAtiva.length,
      porFase,
      salas: salasComOtaAtiva.slice(0, 200),
    },
    rollout: rolloutResumo,
  });
});

module.exports = router;
