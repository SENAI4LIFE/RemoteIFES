const fs = require("fs");
const path = require("path");

const ARQUIVO = path.join(__dirname, "config.xml");

const BLOCO_DEV = [
  '<access origin="*" />',
  '<allow-intent href="http://*/*" />',
  '<allow-intent href="https://*/*" />',
  '<allow-navigation href="*" />',
];

const EDIT_CONFIG_CLEARTEXT = [
  '        <edit-config file="app/src/main/AndroidManifest.xml" mode="merge" target="/manifest/application" xmlns:android="http://schemas.android.com/apk/res/android">',
  '            <application android:usesCleartextTraffic="true" />',
  "        </edit-config>",
].join("\n");

const EDIT_CONFIG_IOS_LOCAL_NETWORK = [
  '        <edit-config file="*-Info.plist" mode="merge" target="NSAppTransportSecurity">',
  "            <dict>",
  "                <key>NSAllowsLocalNetworking</key>",
  "                <true />",
  "            </dict>",
  "        </edit-config>",
].join("\n");

const RE_BLOCO_REDE =
  /^([ \t]*)<access\b[^>]*\/>[ \t]*\n(?:[ \t]*<allow-intent\b[^>]*\/>[ \t]*\n)+[ \t]*<allow-navigation\b[^>]*\/>[ \t]*\n/m;
const RE_EDIT_CONFIG = /[ \t]*<edit-config\b[^>]*file="app\/src\/main\/AndroidManifest\.xml"[\s\S]*?<\/edit-config>\n?/;
const RE_IOS_EDIT_CONFIG = /[ \t]*<edit-config\b[^>]*file="\*-Info\.plist"[\s\S]*?<\/edit-config>\n?/;
const RE_MIN_SDK = /([ \t]*<preference name="android-minSdkVersion" value="24" \/>\n)/;
const RE_IOS_PLATFORM = /([ \t]*<platform name="ios">\n)/;
const RE_CLEARTEXT_ON = /usesCleartextTraffic\s*=\s*"true"/;

function uso() {
  console.log("Uso:");
  console.log("  node harden-config.js <origem-do-servidor>   restringe rede/navegação à origem de produção");
  console.log("  node harden-config.js --dev                  restaura a configuração permissiva de desenvolvimento");
  console.log("");
  console.log("Exemplos:");
  console.log("  node harden-config.js https://remoteifes.ifes.edu.br");
  console.log("  node harden-config.js http://192.168.1.50:8080");
  process.exit(1);
}

function abortar(mensagem, original) {
  if (original !== undefined) fs.writeFileSync(ARQUIVO, original);
  console.error(`harden-config: ${mensagem}`);
  console.error("Nenhuma alteração foi mantida em config.xml.");
  process.exit(1);
}

function normalizarOrigem(valor) {
  let url;
  try {
    url = new URL(valor);
  } catch {
    console.error(`Origem inválida: ${valor}`);
    process.exit(1);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    console.error("A origem deve começar com http:// ou https://");
    process.exit(1);
  }
  return { origem: `${url.protocol}//${url.host}`, cleartext: url.protocol === "http:" };
}

function trocarBlocoRede(xml, linhas, original) {
  if (!RE_BLOCO_REDE.test(xml)) {
    abortar("não encontrei o bloco <access>/<allow-intent>/<allow-navigation> contíguo esperado em config.xml.", original);
  }
  return xml.replace(RE_BLOCO_REDE, (_todo, indent) => linhas.map((l) => `${indent}${l}\n`).join(""));
}

function definirCleartext(xml, ativo, original) {
  let saida = xml.replace(RE_EDIT_CONFIG, "").replace(RE_IOS_EDIT_CONFIG, "");
  if (ativo) {
    if (!RE_MIN_SDK.test(saida)) {
      abortar('não encontrei <preference name="android-minSdkVersion" value="24" /> para reinserir o cleartext.', original);
    }
    saida = saida.replace(RE_MIN_SDK, `$1${EDIT_CONFIG_CLEARTEXT}\n`);
    if (!RE_IOS_PLATFORM.test(saida)) {
      abortar("não encontrei a plataforma iOS para habilitar a compatibilidade com rede local.", original);
    }
    saida = saida.replace(RE_IOS_PLATFORM, (_todo, indent) => indent + EDIT_CONFIG_IOS_LOCAL_NETWORK + "\n");
  }
  return saida;
}

const arg = process.argv[2];
if (!arg) uso();

const original = fs.readFileSync(ARQUIVO, "utf8");
let xml = original;

if (arg === "--dev") {
  xml = trocarBlocoRede(xml, BLOCO_DEV, original);
  xml = definirCleartext(xml, true, original);
  if (!RE_CLEARTEXT_ON.test(xml)) abortar("falha ao reativar o cleartext HTTP no Android.", original);
  fs.writeFileSync(ARQUIVO, xml);
  console.log("config.xml restaurado para desenvolvimento (rede/navegação liberadas, HTTP local ativo no Android e iOS).");
  process.exit(0);
}

const { origem, cleartext } = normalizarOrigem(arg);
const blocoProd = [
  `<access origin="${origem}/*" />`,
  `<allow-intent href="${origem}/*" />`,
  `<allow-navigation href="${origem}/*" />`,
];

xml = trocarBlocoRede(xml, blocoProd, original);
xml = definirCleartext(xml, cleartext, original);

if (cleartext && !RE_CLEARTEXT_ON.test(xml)) {
  abortar("esperava manter o cleartext HTTP para uma origem http:// e não consegui.", original);
}
if (!cleartext && RE_CLEARTEXT_ON.test(xml)) {
  abortar("a origem é HTTPS mas o cleartext HTTP continuou habilitado no Android — abortando (fail-closed).", original);
}
if (xml.includes('origin="*"') || xml.includes('href="*"') || xml.includes('href="http://*/*"') || xml.includes('href="https://*/*"')) {
  abortar("ainda há regras de rede curinga (*) em config.xml após o endurecimento.", original);
}

fs.writeFileSync(ARQUIVO, xml);

console.log(`config.xml endurecido para produção — origem única permitida: ${origem}`);
if (cleartext) {
  console.log("Aviso: a origem é HTTP; o tráfego em texto claro permanece habilitado para rede local no Android e iOS.");
  console.log("Prefira uma origem HTTPS sempre que o servidor tiver certificado.");
} else {
  console.log("Tráfego HTTP em texto claro desabilitado no Android.");
}
console.log("Para voltar ao modo de desenvolvimento: node harden-config.js --dev  (ou git checkout config.xml)");
