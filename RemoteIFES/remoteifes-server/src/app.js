const express = require("express");
const cors = require("cors");

const { criarSchema } = require("./db/schema");
const { popularBanco } = require("./db/seed");

criarSchema();
popularBanco();

const app = express();
app.use(cors());
app.use(express.json());

app.use(require("./routes/loginRoutes"));
app.use(require("./routes/salasRoutes"));
app.use(require("./routes/comandoRoutes"));
app.use(require("./routes/agendamentoRoutes"));
app.use(require("./routes/adminRoutes"));

app.get("/", (req, res) => res.json({ ok: true, servico: "RemoteIFES API" }));

module.exports = app;
