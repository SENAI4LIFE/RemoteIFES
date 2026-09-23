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

// Contrato de prontidão para o Console de Operações.
//
// Existe porque os estados que decidem se uma parada é segura são de processo, não de banco:
// `deviceHub.conexoes`, `otaService.estados` e o rollout vivem em memória neste processo. Um
// observador externo não consegue lê-los pelo SQLite, e mandar o console abrir `src/app.js`
// criaria/migraria o banco a partir de outro processo.
//
// Desenho deliberadamente mínimo:
//  - só responde no loopback e só com o segredo compartilhado em <DIR_DADOS>/.console-token;
//  - sem o arquivo de segredo a rota não existe (404): quem não instalou o console não paga nada;
//  - lê apenas estruturas em memória — nenhuma consulta de histórico, nenhuma agregação.

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
  // O IP é o do socket: TRUST_PROXY não pode transformar um cliente remoto em loopback aqui.
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
        // Um rollout pausado com trabalho pendente volta a mexer em dispositivos quando for
        // retomado: ele conta como manutenção conflitante, mesmo parado agora.
        pendentes: Array.isArray(rollout.pendentes)
          ? rollout.pendentes.length
          : Array.isArray(rollout.fila)
            ? rollout.fila.length
            : null,
      }
    : null;

  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    em: new Date().toISOString(),
    dispositivos: {
      conectados: salas.length,
      // Presença no hub não é o mesmo que canal de comandos aberto: um heartbeat HTTP deixa
      // o dispositivo "online" sem haver socket por onde mandar comando.
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
