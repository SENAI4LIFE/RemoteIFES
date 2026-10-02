const crypto = require("crypto");
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

module.exports = { gerarHash, conferir, LIMITE_BCRYPT, PREFIXO_LONGA };
