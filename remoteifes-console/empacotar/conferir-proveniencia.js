#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const release = require("../src/release");

// Checks what the build step declared about itself, against the directory it wrote.
//
// A manifest describing other files is worse than no manifest: the release workflow attests it,
// and an installed Console trusts whatever an attested manifest says about digests. So before
// anything is attested, every declared digest and size is recomputed here, the manifest must have
// the shape the Console accepts, and the provenance file must say, in text, what the executables
// lack (a platform code signature).
//
// Usage: node empacotar/conferir-proveniencia.js <dir-da-saida>

const dir = process.argv[2];
if (!dir) {
  process.stderr.write("uso: conferir-proveniencia.js <dir-da-saida>\n");
  process.exit(2);
}

function falhar(mensagem) {
  process.stderr.write(`\n  ${mensagem}\n\n`);
  process.exit(1);
}

const proveniencia = JSON.parse(fs.readFileSync(path.join(dir, "proveniencia.json"), "utf8"));
const manifesto = JSON.parse(fs.readFileSync(path.join(dir, "manifesto.json"), "utf8"));

const estrutura = release.validarEstrutura(manifesto);
if (!estrutura.ok) falhar(`o manifesto não é aceito pelo console: ${estrutura.motivo}.`);
if (proveniencia.assinaturaDeCodigo !== false || !/SEM ASSINATURA DE CÓDIGO/.test(proveniencia.observacao || "")) {
  falhar("a procedência precisa declarar, em texto, que os executáveis não têm assinatura de código da plataforma.");
}
if (proveniencia.versao !== manifesto.versao) {
  falhar(`procedência diz ${proveniencia.versao} e o manifesto diz ${manifesto.versao}.`);
}
if (proveniencia.commit !== manifesto.commit) {
  falhar(`procedência diz commit ${proveniencia.commit} e o manifesto diz ${manifesto.commit}.`);
}

// Every declared digest is recomputed.
for (const artefato of [...manifesto.artefatos, ...proveniencia.artefatos]) {
  const arquivo = path.join(dir, artefato.arquivo);
  if (!fs.existsSync(arquivo)) falhar(`o manifesto cita ${artefato.arquivo}, que não foi construído.`);
  const conteudo = fs.readFileSync(arquivo);
  const sha = crypto.createHash("sha256").update(conteudo).digest("hex");
  if (sha !== artefato.sha256) falhar(`digest divergente em ${artefato.arquivo}: declarado ${artefato.sha256}, real ${sha}.`);
  if (artefato.bytes !== undefined && artefato.bytes !== conteudo.length) {
    falhar(`tamanho divergente em ${artefato.arquivo}: declarado ${artefato.bytes}, real ${conteudo.length}.`);
  }
}

process.stdout.write(
  `procedência conferida: ${proveniencia.versao} (${proveniencia.alvo}), commit ${manifesto.commit.slice(0, 12)}, ` +
    `${proveniencia.artefatos.length} artefato(s), digests conferem.\n`
);
