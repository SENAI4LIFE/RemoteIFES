#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

// Confere uma instalação já montada, de fora dela.
//
// O que se prova aqui é a coerência que o resto do desenho pressupõe: o ponteiro da versão
// ativa aponta para um diretório que existe e que declara aquela mesma versão. Um ponteiro
// solto é o defeito silencioso do layout lado a lado — tudo parece instalado, e o programa
// carrega outra coisa (ou não carrega).
//
// Uso: node empacotar/conferir-instalacao.js <raiz-da-instalacao>

const raiz = process.argv[2];
if (!raiz) {
  process.stderr.write("uso: conferir-instalacao.js <raiz-da-instalacao>\n");
  process.exit(2);
}

function falhar(mensagem) {
  process.stderr.write(`\n  ${mensagem}\n\n`);
  process.exit(1);
}

const info = JSON.parse(fs.readFileSync(path.join(raiz, "estado-instalacao.json"), "utf8"));
if (!info.versaoAtiva) falhar("a instalação não registrou versão ativa.");
if (info.transacao && info.transacao.etapa && info.transacao.etapa !== "concluida") {
  falhar(`a instalação terminou com transação pendente em "${info.transacao.etapa}".`);
}

const dirAtiva = path.join(raiz, "versoes", info.versaoAtiva);
if (!fs.existsSync(dirAtiva)) falhar(`o ponteiro aponta para ${info.versaoAtiva}, que não está em versoes/.`);

const pacote = JSON.parse(fs.readFileSync(path.join(dirAtiva, "package.json"), "utf8"));
if (pacote.version !== info.versaoAtiva) {
  falhar(`versoes/${info.versaoAtiva} declara ser a versão ${pacote.version}.`);
}

// O verificador de releases viaja dentro do payload. Ele precisa ser resolvido a partir do próprio
// payload, nunca de um node_modules acima ou global, e carregar: um console que não o carrega nunca
// aceita uma atualização.
let verificador;
try {
  verificador = require.resolve("@sigstore/verify", { paths: [dirAtiva] });
} catch {
  falhar(`o verificador de releases (@sigstore/verify) não está em versoes/${info.versaoAtiva}.`);
}
if (!path.resolve(verificador).startsWith(path.resolve(dirAtiva) + path.sep)) {
  falhar(`o verificador de releases foi resolvido fora do payload: ${verificador}.`);
}
try {
  const { Verifier, toTrustMaterial } = require(verificador);
  const { TrustedRoot } = require(require.resolve("@sigstore/protobuf-specs", { paths: [dirAtiva] }));
  const sementes = require(require.resolve("@sigstore/tuf/seeds.json", { paths: [dirAtiva] }));
  const raizSigstore = Object.values(sementes)[0].targets["trusted_root.json"];
  new Verifier(toTrustMaterial(TrustedRoot.fromJSON(JSON.parse(Buffer.from(raizSigstore, "base64").toString("utf8")))));
} catch (erro) {
  falhar(`o verificador de releases do payload não carrega: ${erro.message}`);
}

// A camada estável é o que o pacote e as unidades do sistema conhecem: se ela não estiver aqui,
// nenhuma atualização futura consegue trocar de versão sem reescrever arquivo do gerenciador.
for (const exigido of ["console-bootstrap.js", "launcher-bootstrap.js"]) {
  if (!fs.existsSync(path.join(raiz, exigido))) falhar(`camada estável incompleta: falta ${exigido}.`);
}

// O bootstrap precisa conseguir resolver a versão ativa sem executar nada do payload.
const bootstrap = fs.readFileSync(path.join(raiz, "console-bootstrap.js"), "utf8");
if (!bootstrap.includes("estado-instalacao.json")) {
  falhar("a camada estável instalada não lê o ponteiro de versão; ela não é a desta distribuição.");
}

process.stdout.write(
  `instalação conferida: versão ativa ${info.versaoAtiva}` +
    `${info.versaoAnterior ? `, anterior ${info.versaoAnterior}` : ""}` +
    `${info.escopo ? `, escopo ${info.escopo}` : ""}, camada estável presente, verificador de releases carregado.\n`
);
