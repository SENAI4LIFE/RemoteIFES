const salasService = require("./salasService");
const agendamentosService = require("./agendamentosService");
const configuracoesService = require("./configuracoesService");
const deviceHub = require("./deviceHub");
const { validarToken } = require("./tokenService");
const { ipAutorizado, resolverIpCliente } = require("../utils/rede");

const REBROADCAST_MS = 30 * 1000;
const PING_MS = 30 * 1000;
const NIVEL_ADMIN = 2;
const NIVEL_SUPERADMIN = 3;
const JANELA_MENSAGENS_MS = 10 * 1000;
const MAX_MENSAGENS_POR_JANELA = 20;
// Clientes só enviam { tipo: "observar" | "observar_dispositivo", sala }.
// 8 KiB é folga larga; frames maiores são recusados pelo `ws` sem parse.
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
    if (!origemPermitida(req.headers.origin) || !redeAutorizada(req)) {
      ws.close(4003, "acesso não permitido");
      return;
    }

    const token = ws.protocol || null;
    const usuario = token ? validarToken(token) : null;
    ws.usuario = usuario || null;
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    // Sem este handler, um erro de socket (reset abrupto, frame maior que o
    // limite, erro de protocolo) vira 'uncaughtException' e derruba o processo.
    ws.on("error", () => {
      try {
        ws.terminate();
      } catch (erro) {
        /* já encerrado */
      }
    });

    ws.on("message", (dados) => {
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
  configuracoesService.eventos.removeListener("mudanca-manutencao", notificarStatusServidorParaTodos);
  if (wss) {
    wss.clients.forEach((ws) => {
      try {
        ws.close(1001, "servidor encerrando");
      } catch (erro) {
        /* ignora sockets já fechados */
      }
    });
    try {
      wss.close();
    } catch (erro) {
      /* ignora */
    }
  }
}

function notificarObservadoresDeDispositivo(sala, payload) {
  if (!wss) return;
  wss.clients.forEach((ws) => {
    if (dispositivosObservadosPorCliente.get(ws)?.has(sala)) enviar(ws, payload);
  });
}

deviceHub.eventos.on("telemetria", ({ sala, estado }) => {
  notificarObservadoresDeDispositivo(sala, { tipo: "dispositivo_status", sala, estado });
});

deviceHub.eventos.on("captura", ({ sala, captura }) => {
  notificarObservadoresDeDispositivo(sala, { tipo: "dispositivo_captura", sala, captura });
});

deviceHub.eventos.on("erro", ({ sala, mensagem }) => {
  notificarObservadoresDeDispositivo(sala, { tipo: "dispositivo_erro", sala, mensagem });
});

deviceHub.eventos.on("conexao", ({ sala }) => {
  notificarObservadoresDeDispositivo(sala, { tipo: "dispositivo_status", sala, estado: deviceHub.estadoPublico(sala) });
});

module.exports = { iniciar, encerrar };
