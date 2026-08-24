const salasService = require("./salasService");
const agendamentosService = require("./agendamentosService");
const configuracoesService = require("./configuracoesService");
const { validarToken } = require("./tokenService");
const { ipAutorizado, resolverIpCliente } = require("../utils/rede");

const REBROADCAST_MS = 30 * 1000;
const PING_MS = 30 * 1000;
const NIVEL_ADMIN = 2;

let wss = null;
const salaObservadaPorCliente = new WeakMap();

function origemPermitida(origin) {
  if ((process.env.NODE_ENV || "development") !== "production") return true;
  if (!origin) return true;
  const origensPermitidas = (process.env.CORS_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (origensPermitidas.length === 0) return true;
  return origensPermitidas.includes(origin);
}

const TRUST_PROXY_HOPS = process.env.TRUST_PROXY !== undefined ? process.env.TRUST_PROXY : "0";

function ipDoRequest(req) {
  return resolverIpCliente(req.headers["x-forwarded-for"], req.socket.remoteAddress, TRUST_PROXY_HOPS);
}

function redeAutorizada(req) {
  if ((process.env.NODE_ENV || "development") !== "production") return true;
  const { modoTeste, redesAutorizadas } = configuracoesService.acessoRestritoAtivo();
  if (modoTeste) return true;
  return ipAutorizado(ipDoRequest(req), redesAutorizadas);
}

function montarSalas(usuario) {
  const salas = salasService.listar({});
  const agendadas = agendamentosService.salasComAgendamentoAtivo();
  return salas.map((s) => ({
    sala: s.sala,
    nome: s.nome,
    bloco: s.bloco,
    andar: s.andar,
    online: !!s.online,
    ligado: !!s.ligado,
    agendadaAgora: !!agendadas[s.sala],
    latitude: s.latitude,
    longitude: s.longitude,
    acessoRestrito: !!s.acessoRestrito,
    podeControlarEsta: salasService.usuarioPodeControlarSala(usuario, s.sala),
  }));
}

function enviar(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function statusServidorPayload(usuario) {
  const manutencaoAtiva = configuracoesService.modoManutencaoAtivo();
  const isAdmin = !!(usuario && usuario.nivel >= NIVEL_ADMIN);
  return { tipo: "servidor", online: true, manutencao: manutencaoAtiva && !isAdmin };
}

function enviarStatusServidor(ws) {
  enviar(ws, statusServidorPayload(ws.usuario));
}

function notificarCliente(ws) {
  enviarStatusServidor(ws);
  if (!ws.usuario) return;
  enviar(ws, { tipo: "salas", salas: montarSalas(ws.usuario) });
  const sala = salaObservadaPorCliente.get(ws);
  if (sala) {
    const status = salasService.statusCompleto(sala, ws.usuario);
    if (status) enviar(ws, { tipo: "status", status });
  }
}

function notificarTodos() {
  if (!wss) return;
  wss.clients.forEach((ws) => {
    if (ws.usuario) notificarCliente(ws);
  });
}

function notificarStatusServidorParaTodos() {
  if (!wss) return;
  wss.clients.forEach((ws) => enviar(ws, statusServidorPayload(ws.usuario)));
}

function iniciar(server) {
  const { WebSocketServer } = require("ws");
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    if (!origemPermitida(req.headers.origin) || !redeAutorizada(req)) {
      ws.close(4003, "acesso não permitido");
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    const usuario = token ? validarToken(token) : null;
    // Sem token: conexão pública, usada pela tela de status do servidor
    // (pré-login) para saber se o backend está no ar / em manutenção.
    // Não fechamos mais a conexão nesse caso.
    ws.usuario = usuario || null;
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("message", (dados) => {
      let msg;
      try {
        msg = JSON.parse(dados.toString());
      } catch (err) {
        return;
      }
      if (msg && msg.tipo === "observar") {
        if (msg.sala && typeof msg.sala === "string") {
          salaObservadaPorCliente.set(ws, msg.sala);
        } else {
          salaObservadaPorCliente.delete(ws);
        }
        notificarCliente(ws);
      }
    });

    ws.on("close", () => {
      salaObservadaPorCliente.delete(ws);
    });

    notificarCliente(ws);
  });

  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, PING_MS);

  setInterval(notificarTodos, REBROADCAST_MS);

  salasService.eventos.on("mudanca", notificarTodos);
  configuracoesService.eventos.on("mudanca-manutencao", notificarStatusServidorParaTodos);
}

module.exports = { iniciar };
