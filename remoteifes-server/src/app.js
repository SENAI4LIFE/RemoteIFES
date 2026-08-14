const express = require("express");
const cors = require("cors");

const { criarSchema } = require("./db/schema");
const { popularBanco } = require("./db/seed");
const { restringirRedeIFES } = require("./middlewares/rede");

criarSchema();
popularBanco();

const app = express();
app.set("trust proxy", true);

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

app.use(require("./routes/dispositivoRoutes"));

app.use(restringirRedeIFES);

app.use(require("./routes/loginRoutes"));
app.use(require("./routes/salasRoutes"));
app.use(require("./routes/comandoRoutes"));
app.use(require("./routes/agendamentoRoutes"));
app.use(require("./routes/adminRoutes"));

app.get("/", (req, res) => res.json({ ok: true, servico: "RemoteIFES API" }));

app.use((err, req, res, next) => {
  if (err && err.message === "origem não permitida pelo CORS") {
    return res.status(403).json({ ok: false, erro: "origem não permitida" });
  }
  return res.status(500).json({ ok: false, erro: "erro interno do servidor" });
});

module.exports = app;
