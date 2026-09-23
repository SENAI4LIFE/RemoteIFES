#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const release = require("../src/release");

// Confere o que a etapa de construção declarou sobre si mesma, contra o diretório que ela gravou.
//
// Um manifesto que descreva outros arquivos é pior do que nenhum manifesto: a publicação o
// atesta, e um console instalado confia no que um manifesto atestado diz sobre digests. Por isso,
// antes de qualquer atestação, cada digest e tamanho declarados são recalculados aqui, o manifesto
// precisa ter a forma que o console aceita, e a procedência precisa dizer, em texto, o que falta
// aos executáveis (assinatura de código da plataforma).
//
// Uso: node empacotar/conferir-proveniencia.js <dir-da-saida>

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

// Cada digest declarado é recalculado.
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
