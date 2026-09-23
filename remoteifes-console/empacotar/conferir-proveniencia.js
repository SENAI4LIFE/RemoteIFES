#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Confere o que a etapa de construção declarou sobre si mesma.
//
// Existe porque a afirmação mais perigosa de um pipeline de distribuição é a que ninguém checa:
// um artefato de CI que se apresente como assinado passaria a ser aceito como release de
// produção sem nunca ter visto uma chave. Aqui a declaração é confrontada com o diretório.
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

if (proveniencia.assinado !== false) {
  falhar("a construção se declarou assinada; a assinatura é etapa credenciada, separada do build.");
}
if (!/NÃO ASSINADOS/.test(proveniencia.observacao || "")) {
  falhar("a procedência precisa dizer, em texto, que estes artefatos não são de produção.");
}
if (fs.existsSync(path.join(dir, "manifesto.json.sig"))) {
  falhar("o build produziu uma assinatura; a chave de publicação não deve estar acessível aqui.");
}
if (proveniencia.versao !== manifesto.versao) {
  falhar(`procedência diz ${proveniencia.versao} e o manifesto diz ${manifesto.versao}.`);
}
if (!manifesto.artefatos.length) falhar("o manifesto não lista nenhum artefato.");

// Cada digest declarado é recalculado: um manifesto que descreva outro arquivo é pior do que
// nenhum manifesto, porque passa confiança.
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

const validade = Date.parse(manifesto.expiraEm);
if (!Number.isFinite(validade) || validade <= Date.now()) falhar("o manifesto nasceu sem validade futura.");

process.stdout.write(
  `procedência conferida: ${proveniencia.versao} (${proveniencia.alvo}), ` +
    `${proveniencia.artefatos.length} artefato(s), assinado=false, digests conferem.\n`
);
