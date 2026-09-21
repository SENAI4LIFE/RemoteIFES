const salasService = require("./salasService");
const configuracoesService = require("./configuracoesService");
const deviceHub = require("./deviceHub");
const { validarToken, validarTokens } = require("./tokenService");
const { ipAutorizado, resolverIpCliente } = require("../utils/rede");

const REBROADCAST_MS = 30 * 1000;
const PING_MS = 30 * 1000;
const NIVEL_ADMIN = 2;
const NIVEL_SUPERADMIN = 3;
const JANELA_MENSAGENS_MS = 10 * 1000;
const MAX_MENSAGENS_POR_JANELA = 20;
const MAX_PAYLOAD_BYTES = 8 * 1024;

let wss = null;
let intervaloPing = null;
let intervaloRebroadcast = null;
const salaObservadaPorCliente = new WeakMap();
const dispositivosObservadosPorCliente = new WeakMap();
const janelaMensagensPorCliente = new WeakMap();

function limiteDeMensagensExcedido(ws) {
  const agora = Date.now();
  const janela = janelaMensagensPorCliente.get(ws);
  if (!janela || agora - janela.inicio >= JANELA_MENSAGENS_MS) {
    janelaMensagensPorCliente.set(ws, { inicio: agora, contagem: 1 });
    return false;
  }
  janela.contagem += 1;
  return janela.contagem > MAX_MENSAGENS_POR_JANELA;
}

const TRUST_PROXY_HOPS = process.env.TRUST_PROXY !== undefined ? process.env.TRUST_PROXY : "0";

function protocoloDaRequisicao(req) {
  const hops = Number(TRUST_PROXY_HOPS);
  if (Number.isInteger(hops) && hops > 0) {
    const encaminhado = req.headers["x-forwarded-proto"];
    if (typeof encaminhado === "string" && encaminhado) return encaminhado.split(",")[0].trim();
  }
  return req.socket.encrypted ? "https" : "http";
}

function origemPermitida(req) {
  if ((process.env.NODE_ENV || "development") !== "production") return true;
  const origin = req.headers.origin;
  if (!origin) return true;
  const origensPermitidas = (process.env.CORS_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (origensPermitidas.includes(origin)) return true;
  try {
    return !!req.headers.host && new URL(origin).origin === `${protocoloDaRequisicao(req)}://${req.headers.host}`;
  } catch (erro) {
    return false;
  }
}

function ipDoRequest(req) {
  return resolverIpCliente(req.headers["x-forwarded-for"], req.socket.remoteAddress, TRUST_PROXY_HOPS);
}

function redeAutorizada(req) {
  if ((process.env.NODE_ENV || "development") !== "production") return true;
  const { modoTeste, redesAutorizadas } = configuracoesService.acessoRestritoAtivo();
  if (modoTeste) return true;
  return ipAutorizado(ipDoRequest(req), redesAutorizadas);
}

function montarSalas(usuario, contexto) {
  const { salas, agendadas } = contexto;
  const controlaTodas = !!usuario.isAdmin;
  const controlaLivres = !controlaTodas && !!usuario.podeControlar;
  const acessos = controlaLivres && salas.some((s) => s.acessoRestrito) ? contexto.acessosDe(usuario.id) : null;
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
    podeControlarEsta: controlaTodas || (controlaLivres && (!s.acessoRestrito || acessos.has(s.sala))),
  }));
}

function enviar(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function statusServidorPayload(usuario, cfg = null) {
  const manutencaoAtiva = configuracoesService.modoManutencaoAtivo(cfg);
  const isAdmin = !!(usuario && usuario.nivel >= NIVEL_ADMIN);
  return { tipo: "servidor", online: true, manutencao: manutencaoAtiva && !isAdmin };
}

function enviarStatusServidor(ws, cfg = null) {
  enviar(ws, statusServidorPayload(ws.usuario, cfg));
}

function revalidarCliente(ws, atualizarUso = false, cfg = null, validadas = null) {
  if (!ws.token) return true;
  const usuario = validadas && validadas.has(ws.token) ? validadas.get(ws.token) : validarToken(ws.token, { atualizarUso, cfg });
  if (!usuario) {
    ws.usuario = null;
    salaObservadaPorCliente.delete(ws);
    dispositivosObservadosPorCliente.delete(ws);
    ws.close(4001, "sessao invalida ou expirada");
    return false;
  }
  ws.usuario = usuario;
  return true;
}

function notificarCliente(ws, contexto = null, validadas = null) {
  const ctx = contexto || salasService.contextoBroadcast();
  if (!revalidarCliente(ws, false, ctx.cfg, validadas)) return;
  enviarStatusServidor(ws, ctx.cfg);
  if (!ws.usuario) return;
  enviar(ws, { tipo: "salas", salas: montarSalas(ws.usuario, ctx) });
  const sala = salaObservadaPorCliente.get(ws);
  if (sala) {
    const status = salasService.statusCompleto(sala, ws.usuario, ctx);
    if (status) enviar(ws, { tipo: "status", status });
  }
}

function notificarTodos() {
  if (!wss) return;
  const destinatarios = [...wss.clients].filter((ws) => ws.usuario);
  if (!destinatarios.length) return;
  const contexto = salasService.contextoBroadcast();
  const validadas = validarTokens(destinatarios.map((ws) => ws.token), { cfg: contexto.cfg });
  contexto.precarregarAcessos(
    [...validadas.values()].filter((u) => u && !u.isAdmin && u.podeControlar).map((u) => u.id)
  );
  destinatarios.forEach((ws) => notificarCliente(ws, contexto, validadas));
}

function notificarObservadoresDaSala({ sala }) {
  if (!wss) return;
  const observadores = [...wss.clients].filter((ws) => ws.usuario && salaObservadaPorCliente.get(ws) === sala);
  if (!observadores.length) return;
  const contexto = salasService.contextoBroadcast();
  const validadas = validarTokens(observadores.map((ws) => ws.token), { cfg: contexto.cfg });
  observadores.forEach((ws) => {
    if (!revalidarCliente(ws, false, contexto.cfg, validadas) || !ws.usuario) return;
    const status = salasService.statusCompleto(sala, ws.usuario, contexto);
    if (status) enviar(ws, { tipo: "status", status });
  });
}

function notificarAdministradores(payload) {
  if (!wss) return;
  wss.clients.forEach((ws) => {
    if (!revalidarCliente(ws)) return;
    if (ws.usuario && ws.usuario.nivel >= NIVEL_ADMIN) enviar(ws, payload);
  });
}

function notificarCadastroDeDispositivo({ sala }) {
  const cadastro = salasService.buscarAdministrativo(sala);
  if (!cadastro) return;
  notificarAdministradores({ tipo: "dispositivo_cadastro", sala, cadastro });
}

function notificarStatusServidorParaTodos() {
  if (!wss) return;
  wss.clients.forEach((ws) => {
    if (revalidarCliente(ws)) enviar(ws, statusServidorPayload(ws.usuario));
  });
}

function selecionarSubprotocolo(protocolos) {
  if (!protocolos || protocolos.size === 0) return false;
  return protocolos.values().next().value;
}

function iniciar(server) {
  const { WebSocketServer } = require("ws");
  wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    handleProtocols: (protocolos) => selecionarSubprotocolo(protocolos),
  });

  server.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      ({ pathname } = new URL(req.url, "http://localhost"));
    } catch (erro) {
      socket.destroy();
      return;
    }
    if (pathname !== "/ws") return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws, req) => {
    if (!origemPermitida(req) || !redeAutorizada(req)) {
      ws.close(4003, "acesso não permitido");
      return;
    }

    const token = ws.protocol || null;
    const usuario = token ? validarToken(token) : null;
    if (token && !usuario) {
      ws.close(4001, "sessao invalida ou expirada");
      return;
    }
    ws.token = token;
    ws.usuario = usuario || null;
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("error", () => {
      try {
        ws.terminate();
      } catch (erro) {}
    });

    ws.on("message", (dados) => {
      if (!revalidarCliente(ws, true)) return;
      if (limiteDeMensagensExcedido(ws)) {
        ws.close(4008, "limite de mensagens excedido");
        return;
      }
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
      } else if (msg && msg.tipo === "observar_dispositivo") {
        const ehSuperAdmin = !!(ws.usuario && ws.usuario.nivel === NIVEL_SUPERADMIN);
        if (ehSuperAdmin && msg.sala && typeof msg.sala === "string") {
          let salas = dispositivosObservadosPorCliente.get(ws);
          if (!salas) {
            salas = new Set();
            dispositivosObservadosPorCliente.set(ws, salas);
          }
          salas.add(msg.sala);
          enviar(ws, { tipo: "dispositivo_status", sala: msg.sala, estado: deviceHub.estadoPublico(msg.sala) });
        } else {
          dispositivosObservadosPorCliente.delete(ws);
        }
      } else if (msg && msg.tipo === "observar_dispositivos") {
        const ehSuperAdmin = !!(ws.usuario && ws.usuario.nivel === NIVEL_SUPERADMIN);
        const salasValidas = Array.isArray(msg.salas)
          ? msg.salas.filter((sala) => typeof sala === "string" && sala.length <= 100).slice(0, 200)
          : null;
        if (ehSuperAdmin && salasValidas) {
          dispositivosObservadosPorCliente.set(ws, new Set(salasValidas));
        } else {
          dispositivosObservadosPorCliente.delete(ws);
        }
      }
    });

    ws.on("close", () => {
      salaObservadaPorCliente.delete(ws);
      dispositivosObservadosPorCliente.delete(ws);
      janelaMensagensPorCliente.delete(ws);
    });

    notificarCliente(ws);
  });

  intervaloPing = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, PING_MS);
  intervaloPing.unref();

  intervaloRebroadcast = setInterval(notificarTodos, REBROADCAST_MS);
  intervaloRebroadcast.unref();

  salasService.eventos.on("mudanca", notificarTodos);
  salasService.eventos.on("mudanca-sala", notificarObservadoresDaSala);
  salasService.eventos.on("cadastro-dispositivo", notificarCadastroDeDispositivo);
  configuracoesService.eventos.on("mudanca-manutencao", notificarStatusServidorParaTodos);
}

function encerrar() {
  if (intervaloPing) {
    clearInterval(intervaloPing);
    intervaloPing = null;
  }
  if (intervaloRebroadcast) {
    clearInterval(intervaloRebroadcast);
    intervaloRebroadcast = null;
  }
  salasService.eventos.removeListener("mudanca", notificarTodos);
  salasService.eventos.removeListener("mudanca-sala", notificarObservadoresDaSala);
  salasService.eventos.removeListener("cadastro-dispositivo", notificarCadastroDeDispositivo);
  configuracoesService.eventos.removeListener("mudanca-manutencao", notificarStatusServidorParaTodos);
  if (wss) {
    wss.clients.forEach((ws) => {
      try {
        ws.close(1001, "servidor encerrando");
      } catch (erro) {}
    });
    try {
      wss.close();
    } catch (erro) {}
  }
}

function fecharConexoes(codigo = 1001, motivo = "conexão encerrada para teste") {
  if (!wss) return;
  wss.clients.forEach((ws) => {
    try {
      ws.close(codigo, motivo);
    } catch (erro) {}
  });
}

function notificarObservadoresDeDispositivo(sala, payload) {
  if (!wss) return;
  wss.clients.forEach((ws) => {
    if (!revalidarCliente(ws)) return;
    if (ws.usuario?.nivel === NIVEL_SUPERADMIN && dispositivosObservadosPorCliente.get(ws)?.has(sala)) enviar(ws, payload);
  });
}

deviceHub.eventos.on("telemetria", ({ sala, estado }) => {
  notificarObservadoresDeDispositivo(sala, { tipo: "dispositivo_status", sala, estado });
});

deviceHub.eventos.on("captura", ({ sala, captura }) => {
  notificarObservadoresDeDispositivo(sala, { tipo: "dispositivo_captura", sala, captura });
});

deviceHub.eventos.on("ota", ({ sala, estado }) => {
  notificarObservadoresDeDispositivo(sala, { tipo: "dispositivo_ota", sala, ota: estado });
});

deviceHub.eventos.on("ota-rollout", ({ rollout }) => {
  if (!wss) return;
  wss.clients.forEach((ws) => {
    if (!revalidarCliente(ws)) return;
    if (ws.usuario?.nivel === NIVEL_SUPERADMIN) enviar(ws, { tipo: "dispositivo_rollout", rollout });
  });
});

deviceHub.eventos.on("erro", ({ sala, mensagem }) => {
  notificarObservadoresDeDispositivo(sala, { tipo: "dispositivo_erro", sala, mensagem });
});

deviceHub.eventos.on("conexao", ({ sala }) => {
  notificarObservadoresDeDispositivo(sala, { tipo: "dispositivo_status", sala, estado: deviceHub.estadoPublico(sala) });
  notificarObservadoresDaSala({ sala });
});

module.exports = { iniciar, encerrar, fecharConexoes };
