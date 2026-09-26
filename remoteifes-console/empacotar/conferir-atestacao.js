#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// Verifies a release directory as an installed Console will: the attestation against the Sigstore
// trusted root, the identity policy, the manifest and each payload's digest, all with the
// Console's own code (src/atestacao.js). It also requires the attestation to cover every other
// file of the release (.deb, .zip, installer, provenance), which the Console never downloads but
// people do. The release workflow runs it before publishing.
//
// Usage: node empacotar/conferir-atestacao.js <dir-do-release> [--sem-rede]
//
// --sem-rede uses the trusted root the Console carries instead of refreshing it through TUF.

const dir = process.argv[2];
if (!dir) {
  process.stderr.write("uso: conferir-atestacao.js <dir-do-release> [--sem-rede]\n");
  process.exit(2);
}
// The TUF refresh keeps its copy in the state directory; outside an installation, a temporary one.
if (!process.env.CONSOLE_ESTADO_DIR) process.env.CONSOLE_ESTADO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "conferir-atestacao-"));

const atestacao = require("../src/atestacao");
const release = require("../src/release");

function falhar(mensagem) {
  process.stderr.write(`\n  ${mensagem}\n\n`);
  process.exit(1);
}

async function main() {
  const bytesManifesto = fs.readFileSync(path.join(dir, atestacao.ARQUIVO_MANIFESTO));
  const bytesAtestacao = fs.readFileSync(path.join(dir, atestacao.ARQUIVO_ATESTACAO));
  const { raiz, origem } = await atestacao.raizDeConfianca({ rede: !process.argv.includes("--sem-rede") });

  const v = atestacao.verificarPublicacao({ manifesto: bytesManifesto, atestacao: bytesAtestacao, raiz });
  if (!v.ok) falhar(`o console recusaria este release: ${v.motivo}`);
  for (const artefato of v.manifesto.artefatos) {
    const r = release.conferirArtefato(path.join(dir, artefato.arquivo), artefato);
    if (!r.ok) falhar(`${artefato.arquivo}: ${r.motivo}`);
  }

  const { sujeitos } = atestacao.verificarAssinatura(bytesAtestacao, raiz);
  let cobertos = 0;
  for (const nome of fs.readdirSync(dir).sort()) {
    if (nome === atestacao.ARQUIVO_ATESTACAO) continue;
    const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, nome))).digest("hex");
    if (sujeitos.get(nome) !== sha) falhar(`${nome} não está coberto pela atestação.`);
    cobertos += 1;
  }

  process.stdout.write(
    `release conferido: console ${v.manifesto.versao}, ${v.identidade.ref}, commit ${v.identidade.commit}\n` +
      `  assinante: ${v.identidade.assinante}\n` +
      `  execução: ${v.identidade.execucao || "?"}\n` +
      `  ${v.manifesto.artefatos.length} payload(s) e ${cobertos} arquivo(s) cobertos; raiz de confiança do Sigstore: ${origem}\n`
  );
}

main().catch((erro) => falhar(erro && erro.stack ? erro.stack : String(erro)));
