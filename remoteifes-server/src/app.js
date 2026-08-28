const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");

const db = require("./config/database");
const { criarSchema } = require("./db/schema");
const { popularBanco } = require("./db/seed");
const { restringirRedeIFES } = require("./middlewares/rede");
const logger = require("./utils/logger");

const INICIO_PROCESSO = Date.now();

criarSchema();
popularBanco();

const app = express();

const TRUST_PROXY_HOPS = process.env.TRUST_PROXY !== undefined ? process.env.TRUST_PROXY : "0";
app.set("trust proxy", /^\d+$/.test(TRUST_PROXY_HOPS) ? Number(TRUST_PROXY_HOPS) : TRUST_PROXY_HOPS);

const NODE_ENV = process.env.NODE_ENV || "development";
const origensPermitidas = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SERVIR_FRONTEND =
  String(process.env.SERVIR_FRONTEND ?? (NODE_ENV === "production" ? "true" : "false")).toLowerCase() === "true";
const FRONTEND_DIR = process.env.FRONTEND_DIR
  ? path.resolve(process.env.FRONTEND_DIR)
  : path.join(__dirname, "..", "..", "remoteifes-web");
const frontendDisponivel = SERVIR_FRONTEND && fs.existsSync(path.join(FRONTEND_DIR, "index.html"));
if (SERVIR_FRONTEND && !frontendDisponivel) {
  logger.warn("frontend-nao-encontrado", { dir: FRONTEND_DIR });
}

const CSP_API = "default-src 'none'; frame-ancestors 'none'";
const CSP_APP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; " +
  "base-uri 'none'; object-src 'none'; frame-ancestors 'none'";

function mesmaOrigem(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (!origin || !host) return false;
  try {
    return new URL(origin).origin === `${req.protocol}://${host}`;
  } catch (erro) {
    return false;
  }
}

function resolverCorsProducao(req, callback) {
  const origin = req.headers.origin;
  const permitido =
    !origin || origensPermitidas.includes(origin) || mesmaOrigem(req);
  if (!permitido) return callback(new Error("origem não permitida pelo CORS"));
  callback(null, { origin: true, credentials: false });
}

app.use(NODE_ENV === "production" ? cors(resolverCorsProducao) : cors());
app.use(express.json({ limit: "100kb" }));

app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.set("X-Request-Id", req.id);
  next();
});

app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "same-origin");
  res.set("Content-Security-Policy", frontendDisponivel ? CSP_APP : CSP_API);
  res.set("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=(), usb=()");
  if (NODE_ENV === "production" && req.secure) {
    res.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
});

app.get("/health", (req, res) => {
  let banco = "ok";
  try {
    db.prepare("SELECT 1 AS ok").get();
  } catch (erro) {
    banco = "erro";
    logger.error("health-banco-indisponivel", { mensagem: erro && erro.message });
  }
  const saudavel = banco === "ok";
  res.status(saudavel ? 200 : 503).json({
    ok: saudavel,
    servico: "RemoteIFES API",
    banco,
    ambiente: NODE_ENV,
    uptimeSegundos: Math.round((Date.now() - INICIO_PROCESSO) / 1000),
  });
});

app.use(require("./routes/dispositivoRoutes"));

if (frontendDisponivel) {
  app.use(express.static(FRONTEND_DIR, { index: "index.html" }));
}

app.use(restringirRedeIFES);

app.use(require("./routes/loginRoutes"));
app.use(require("./routes/salasRoutes"));
app.use(require("./routes/comandoRoutes"));
app.use(require("./routes/agendamentoRoutes"));
app.use(require("./routes/adminRoutes"));
app.use(require("./routes/esp32AdminRoutes"));
app.use(require("./routes/relatoRoutes"));

if (!frontendDisponivel) {
  app.get("/", (req, res) => res.json({ ok: true, servico: "RemoteIFES API" }));
}

app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, erro: "corpo da requisição inválido" });
  }
  if (err && err.message === "origem não permitida pelo CORS") {
    return res.status(403).json({ ok: false, erro: "origem não permitida" });
  }
  logger.error("erro-nao-tratado", { requestId: req.id, metodo: req.method, rota: req.originalUrl, mensagem: err && err.message });
  return res.status(500).json({ ok: false, erro: "erro interno do servidor" });
});

module.exports = app;
