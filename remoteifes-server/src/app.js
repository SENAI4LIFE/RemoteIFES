const crypto = require("crypto");
const express = require("express");
const cors = require("cors");

const { criarSchema } = require("./db/schema");
const { popularBanco } = require("./db/seed");
const { restringirRedeIFES } = require("./middlewares/rede");
const logger = require("./utils/logger");

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

const opcoesCors = NODE_ENV === "production"
  ? {
      origin(origin, callback) {
        if (!origin || origensPermitidas.includes(origin)) return callback(null, true);
        return callback(new Error("origem não permitida pelo CORS"));
      },
    }
  : {};

app.use(cors(opcoesCors));
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
  res.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  res.set("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=(), usb=()");
  if (NODE_ENV === "production") {
    res.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
});

app.use(require("./routes/dispositivoRoutes"));

app.use(restringirRedeIFES);

app.use(require("./routes/loginRoutes"));
app.use(require("./routes/salasRoutes"));
app.use(require("./routes/comandoRoutes"));
app.use(require("./routes/agendamentoRoutes"));
app.use(require("./routes/adminRoutes"));
app.use(require("./routes/esp32AdminRoutes"));

app.get("/", (req, res) => res.json({ ok: true, servico: "RemoteIFES API" }));

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
