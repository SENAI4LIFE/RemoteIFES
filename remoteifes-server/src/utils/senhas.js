const crypto = require("crypto");
const { Worker, parentPort } = require("node:worker_threads");
const bcrypt = require("bcryptjs");

// Account password hashes.
//
// bcrypt uses only the first 72 bytes of what it hashes, and a password may have up to 128
// characters (several bytes each in UTF-8). A longer one is therefore first reduced with
// HMAC-SHA-256 keyed by the bcrypt salt, so every byte counts and the reduction is different in each
// hash; the stored hash says so with a prefix. Up to 72 bytes the hash stays plain bcrypt, so every
// existing hash keeps verifying, as do those written by an older server or by the Console's account
// recovery against one. A long password stored before this change still verifies the way it was
// stored (its first 72 bytes) until it is changed.

const CUSTO = 10;
const LIMITE_BCRYPT = 72;
const PREFIXO_LONGA = "hmac-sha256+";

function reduzir(senha, sal) {
  return crypto.createHmac("sha256", sal).update(senha, "utf8").digest("base64");
}

function gerarHash(senha) {
  if (Buffer.byteLength(senha, "utf8") <= LIMITE_BCRYPT) return bcrypt.hashSync(senha, CUSTO);
  const sal = bcrypt.genSaltSync(CUSTO);
  return PREFIXO_LONGA + bcrypt.hashSync(reduzir(senha, sal), sal);
}

function conferir(senha, hash) {
  if (typeof senha !== "string" || typeof hash !== "string") return false;
  if (!hash.startsWith(PREFIXO_LONGA)) return bcrypt.compareSync(senha, hash);
  const hashBcrypt = hash.slice(PREFIXO_LONGA.length);
  // "$2b$10$" and the 22 characters of the salt.
  return bcrypt.compareSync(reduzir(senha, hashBcrypt.slice(0, 29)), hashBcrypt);
}

const verificadores = [];
const MAX_VERIFICADORES = 2;
const MAX_PENDENTES_POR_VERIFICADOR = 10;

function criarVerificador() {
  const worker = new Worker(__filename);
  const pendentes = [];
  const verificador = { worker, pendentes };
  verificadores.push(verificador);

  worker.on("message", (valida) => {
    pendentes.shift().resolve(valida);
    if (!pendentes.length) worker.unref();
  });
  function encerrar(erro) {
    const indice = verificadores.indexOf(verificador);
    if (indice < 0) return;
    verificadores.splice(indice, 1);
    for (const pedido of pendentes.splice(0)) pedido.reject(erro);
  }
  worker.once("error", encerrar);
  worker.once("exit", () => encerrar(new Error("verificador de senha encerrado")));
  return verificador;
}

function conferirLogin(senha, hash) {
  let verificador = verificadores.reduce((menor, atual) =>
    !menor || atual.pendentes.length < menor.pendentes.length ? atual : menor, null);
  if (!verificador || (verificador.pendentes.length && verificadores.length < MAX_VERIFICADORES)) {
    verificador = criarVerificador();
  }
  if (verificador.pendentes.length >= MAX_PENDENTES_POR_VERIFICADOR) return null;
  return new Promise((resolve, reject) => {
    verificador.worker.postMessage({ senha, hash });
    verificador.pendentes.push({ resolve, reject });
    verificador.worker.ref();
  });
}

if (require.main === module && parentPort) {
  parentPort.on("message", ({ senha, hash }) => parentPort.postMessage(conferir(senha, hash)));
}

module.exports = { gerarHash, conferir, conferirLogin, LIMITE_BCRYPT, PREFIXO_LONGA };
