"use strict";

// Makes the process it is loaded into behave like a host with no Internet. Tests load it with
// `node --require` (or NODE_OPTIONS) to prove that RemoteIFES and the Operations Console work on a
// campus LAN with no way out. Loopback is untouched; every other destination fails the way a real
// host fails:
//
//   SEM_INTERNET=dns       names do not resolve (EAI_AGAIN): no DNS server reachable
//   SEM_INTERNET=rota      nothing off the host is reachable (ENETUNREACH): no default route
//   SEM_INTERNET=silencio  connections off the host never complete: a black hole
//
// SEM_INTERNET_REGISTRO names a file that receives one JSON line per attempt to leave the host, with
// a short stack, so a test can prove which code paths tried and which never did.
//
// ativar()/desativar() do the same inside a test process.

const dns = require("dns");
const net = require("net");
const fs = require("fs");

let modo = null;
let registro = null;
let originais = null;

function loopback(host) {
  if (host === undefined || host === null || host === "") return true;
  const h = String(host).replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (net.isIPv4(h)) return h.startsWith("127.");
  if (net.isIPv6(h)) return h === "::1" || h.startsWith("::ffff:127.");
  return false;
}

function registrar(tipo, destino) {
  if (!registro) return;
  // Deep enough to get past Node's own http/net/dns frames to the code that asked.
  const limite = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const bruta = new Error().stack;
  Error.stackTraceLimit = limite;
  const pilha = String(bruta)
    .split("\n")
    .slice(3)
    .map((l) => l.trim())
    .filter((l) => !l.includes("node:internal/"));
  try {
    fs.appendFileSync(registro, `${JSON.stringify({ pid: process.pid, tipo, destino, pilha })}\n`);
  } catch {}
}

function falha(codigo, syscall, destino) {
  const erro = new Error(`${syscall} ${codigo} ${destino}`);
  erro.code = codigo;
  erro.errno = codigo === "EAI_AGAIN" ? -3001 : -101;
  erro.syscall = syscall;
  if (syscall === "getaddrinfo") erro.hostname = destino;
  return erro;
}

/** The destination of a Socket#connect call, in any of the forms Node accepts. */
function destinoDe(args) {
  let primeiro = args[0];
  if (Array.isArray(primeiro)) primeiro = primeiro[0];
  if (primeiro && typeof primeiro === "object") return { host: primeiro.host, porta: primeiro.port, caminho: primeiro.path };
  if (typeof primeiro === "number" || /^\d+$/.test(String(primeiro))) return { host: typeof args[1] === "string" ? args[1] : undefined, porta: Number(primeiro) };
  return { caminho: primeiro };
}

function ativar(opcoes = {}) {
  if (originais) desativar();
  modo = opcoes.modo || "dns";
  registro = opcoes.registro || null;
  originais = {
    lookup: dns.lookup,
    lookupPromessa: dns.promises.lookup,
    connect: net.Socket.prototype.connect,
  };

  dns.lookup = function lookup(host, opcoesDns, retorno) {
    if (typeof opcoesDns === "function") {
      retorno = opcoesDns;
      opcoesDns = {};
    }
    if (loopback(host)) return originais.lookup.call(this, host, opcoesDns, retorno);
    registrar("dns", String(host));
    process.nextTick(retorno, falha("EAI_AGAIN", "getaddrinfo", host));
    return {};
  };
  dns.promises.lookup = async function lookup(host, opcoesDns) {
    if (loopback(host)) return originais.lookupPromessa.call(this, host, opcoesDns);
    registrar("dns", String(host));
    throw falha("EAI_AGAIN", "getaddrinfo", host);
  };

  net.Socket.prototype.connect = function connect(...args) {
    const alvo = destinoDe(args);
    if (alvo.caminho || loopback(alvo.host)) return originais.connect.apply(this, args);
    // A name goes to the (failing) resolver in "dns" mode, as it would on a real host.
    if (modo === "dns" && !net.isIP(String(alvo.host))) return originais.connect.apply(this, args);
    const destino = `${alvo.host}:${alvo.porta}`;
    registrar("conexao", destino);
    this.connecting = true;
    if (modo !== "silencio") process.nextTick(() => this.destroy(falha("ENETUNREACH", "connect", destino)));
    return this;
  };
}

function desativar() {
  if (!originais) return;
  dns.lookup = originais.lookup;
  dns.promises.lookup = originais.lookupPromessa;
  net.Socket.prototype.connect = originais.connect;
  originais = null;
}

if (process.env.SEM_INTERNET) {
  ativar({ modo: process.env.SEM_INTERNET, registro: process.env.SEM_INTERNET_REGISTRO || null });
  // SEM_INTERNET_MARCA receives one line per process under simulation, so a test that finds no
  // attempt can also prove the simulation was there to record one.
  if (process.env.SEM_INTERNET_MARCA) {
    try {
      fs.appendFileSync(process.env.SEM_INTERNET_MARCA, `${process.pid} ${process.argv.slice(1).map((a) => a.split(/[\\/]/).pop()).join(" ")}\n`);
    } catch {}
  }
}

module.exports = { ativar, desativar, loopback };
