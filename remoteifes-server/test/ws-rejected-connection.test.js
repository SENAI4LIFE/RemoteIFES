const crypto = require("crypto");
const net = require("net");
const test = require("node:test");
const assert = require("node:assert/strict");

const { iniciarServidorIsolado } = require("./support/servidor-isolado");

// A refused WebSocket is still open while it closes. A client that sends a malformed frame in that
// window makes the `ws` library emit "error" on the socket; without a listener that is an uncaught
// exception, and server.js exits on those. These cases run the real server.js, in production, as a
// child process: the server must refuse each connection and keep running.

function upgradeComQuadroInvalido(porta, caminho, cabecalhosExtras) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(porta, "127.0.0.1");
    let resposta = "";
    let quadroEnviado = false;
    const limite = setTimeout(() => {
      socket.destroy();
      reject(new Error(`sem resposta ao upgrade de ${caminho}`));
    }, 10_000);
    socket.on("error", () => {});
    socket.on("connect", () => {
      socket.write([
        `GET ${caminho} HTTP/1.1`,
        `Host: 127.0.0.1:${porta}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}`,
        "Sec-WebSocket-Version: 13",
        ...cabecalhosExtras,
        "",
        "",
      ].join("\r\n"));
    });
    socket.on("data", (dados) => {
      resposta += dados.toString("latin1");
      if (quadroEnviado || !resposta.includes("\r\n\r\n")) return;
      quadroEnviado = true;
      // Masked frame with a reserved opcode (0x3): the receiver must reject it.
      socket.write(Buffer.concat([Buffer.from([0x83, 0x80]), crypto.randomBytes(4)]));
    });
    socket.on("close", () => {
      clearTimeout(limite);
      resolve(resposta.split("\r\n")[0]);
    });
  });
}

test("refused WebSocket connections that send a malformed frame do not stop the server", async (t) => {
  const servidor = await iniciarServidorIsolado({ env: { NODE_ENV: "production", CORS_ORIGIN: "" } });
  t.after(() => servidor.encerrar());

  const casos = [
    { nome: "browser socket from a foreign origin", caminho: "/ws", cabecalhos: ["Origin: https://origem-alheia.example"] },
    { nome: "browser socket with an invalid session token", caminho: "/ws", cabecalhos: ["Sec-WebSocket-Protocol: token-invalido"] },
    // Refused by the network restriction: a loopback peer forwarding for a client, no proxy declared.
    { nome: "browser socket refused by the network restriction", caminho: "/ws", cabecalhos: ["X-Forwarded-For: 203.0.113.10"] },
    { nome: "device socket without a credential", caminho: "/ws/dispositivo", cabecalhos: [] },
  ];

  for (const caso of casos) {
    const linhaStatus = await upgradeComQuadroInvalido(servidor.porta, caso.caminho, caso.cabecalhos);
    assert.match(linhaStatus, /^HTTP\/1\.1 101 /, `${caso.nome}: the upgrade itself is accepted and then refused`);
    // A crash would show as the child exiting shortly after the socket closes.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(servidor.filho.exitCode, null, `${caso.nome}: the server exited\n${servidor.saida.slice(-1500)}`);
    const saude = await fetch(`${servidor.base}/health`);
    assert.equal(saude.status, 200, `${caso.nome}: /health stops answering`);
  }
  assert.doesNotMatch(servidor.saida, /uncaught-exception/);
});
