#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Assinatura do manifesto de release.
//
// Produz `manifesto.json` (bytes exatos) e `manifesto.json.sig` (Ed25519, base64). A assinatura
// cobre os **bytes do arquivo**, não um objeto reserializado: qualquer reformatação depois de
// assinar invalida a assinatura, que é exatamente o que se quer.
//
// A chave privada nunca é lida de argumento de linha de comando — só de arquivo ou da variável
// CONSOLE_CHAVE_PRIVADA. Argumento de processo aparece em `ps` e em logs de CI.
//
// Uso:
//   node empacotar/assinar-manifesto.js --gerar-chave <dir>
//   node empacotar/assinar-manifesto.js --manifesto <arquivo> --chave <arquivo-privado>
//   node empacotar/assinar-manifesto.js --verificar <manifesto> <assinatura> <chave-publica>

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

function gerarChave(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const privado = path.join(dir, "release-ed25519.privada.pem");
  const publico = path.join(dir, "release-ed25519.publica.b64");
  fs.writeFileSync(privado, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const publicoB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  fs.writeFileSync(publico, `${publicoB64}\n`, { mode: 0o644 });
  process.stdout.write(`Chave privada: ${privado}  (0600, NUNCA versionar)\n`);
  process.stdout.write(`Chave pública: ${publico}\n\n`);
  process.stdout.write("Publique a chave pública em src/release.js (CHAVE_PUBLICA_OFICIAL):\n\n");
  process.stdout.write(`  const CHAVE_PUBLICA_OFICIAL = "${publicoB64}";\n\n`);
  return 0;
}

function carregarPrivada() {
  const doAmbiente = process.env.CONSOLE_CHAVE_PRIVADA;
  if (doAmbiente) return crypto.createPrivateKey(doAmbiente);
  const arquivo = arg("chave");
  if (!arquivo) {
    process.stderr.write("informe --chave <arquivo> ou a variável CONSOLE_CHAVE_PRIVADA\n");
    process.exit(2);
  }
  return crypto.createPrivateKey(fs.readFileSync(arquivo, "utf8"));
}

function assinar() {
  const caminho = arg("manifesto");
  if (!caminho) {
    process.stderr.write("informe --manifesto <arquivo>\n");
    return 2;
  }
  const bytes = fs.readFileSync(caminho);
  // Conferência de forma antes de assinar: assinar um manifesto inválido só adiaria a falha
  // para o console do operador.
  const manifesto = JSON.parse(bytes.toString("utf8"));
  for (const campo of ["esquema", "versao", "expiraEm", "artefatos"]) {
    if (manifesto[campo] === undefined) {
      process.stderr.write(`manifesto sem campo obrigatório: ${campo}\n`);
      return 1;
    }
  }
  if (Date.parse(manifesto.expiraEm) <= Date.now()) {
    process.stderr.write("manifesto já nasce expirado; ajuste expiraEm\n");
    return 1;
  }
  const assinatura = crypto.sign(null, bytes, carregarPrivada()).toString("base64");
  const destino = `${caminho}.sig`;
  fs.writeFileSync(destino, `${assinatura}\n`);
  process.stdout.write(`Assinado: ${destino}\n`);
  return 0;
}

function verificar() {
  const i = process.argv.indexOf("--verificar");
  const [manifesto, assinatura, chave] = process.argv.slice(i + 1);
  if (!manifesto || !assinatura || !chave) {
    process.stderr.write("uso: --verificar <manifesto> <assinatura> <chave-publica-b64>\n");
    return 2;
  }
  const publica = crypto.createPublicKey({
    key: Buffer.from(fs.readFileSync(chave, "utf8").trim(), "base64"),
    format: "der",
    type: "spki",
  });
  const ok = crypto.verify(null, fs.readFileSync(manifesto), publica, Buffer.from(fs.readFileSync(assinatura, "utf8").trim(), "base64"));
  process.stdout.write(ok ? "assinatura confere\n" : "ASSINATURA NÃO CONFERE\n");
  return ok ? 0 : 1;
}

const gerar = arg("gerar-chave");
if (gerar) process.exitCode = gerarChave(gerar);
else if (process.argv.includes("--verificar")) process.exitCode = verificar();
else process.exitCode = assinar();
