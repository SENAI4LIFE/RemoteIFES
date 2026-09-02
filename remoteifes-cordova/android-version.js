const fs = require("fs");
const path = require("path");

const ARQUIVO = path.join(__dirname, "android-release.json");
const CONFIG = path.join(__dirname, "config.xml");
const RE_VERSAO = /^(\d+)\.(\d+)\.(\d+)$/;

function ler() {
  const dados = JSON.parse(fs.readFileSync(ARQUIVO, "utf8"));
  if (!RE_VERSAO.test(String(dados.versionName || ""))) throw new Error(`versionName inválido em ${path.basename(ARQUIVO)}: use x.y.z.`);
  if (!Number.isInteger(dados.versionCode) || dados.versionCode <= 0) throw new Error("versionCode deve ser um inteiro positivo.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dados.releaseDate || ""))) throw new Error("releaseDate deve estar no formato AAAA-MM-DD.");
  if (!Array.isArray(dados.notes) || dados.notes.some((n) => typeof n !== "string" || !n.trim())) {
    throw new Error("notes deve ser uma lista de textos não vazios.");
  }
  return dados;
}

// O versionCode nasce da própria versão (1.2.3 -> 10203), o que o torna previsível e
// legível; recompilar a mesma versão apenas avança em um, porque o Android recusa
// instalar por cima um pacote cujo versionCode não cresceu.
function codigoDerivado(versionName) {
  const [, maior, menor, correcao] = versionName.match(RE_VERSAO).map(Number);
  if (menor > 99 || correcao > 99) throw new Error("menor e correção precisam ficar entre 0 e 99 para gerar o versionCode.");
  return maior * 10000 + menor * 100 + correcao;
}

function proximoCodigo(versionName, codigoAtual) {
  return Math.max(codigoDerivado(versionName), codigoAtual + 1);
}

function lerConfig() {
  const xml = fs.readFileSync(CONFIG, "utf8");
  const versao = xml.match(/<widget\b[^>]*\sversion="([^"]*)"/);
  const codigo = xml.match(/<widget\b[^>]*\sandroid-versionCode="([^"]*)"/);
  return { xml, versao: versao && versao[1], codigo: codigo && codigo[1] };
}

function gravarConfig(versionName, versionCode) {
  const { xml } = lerConfig();
  let saida = xml.replace(/(<widget\b[^>]*\sversion=")[^"]*(")/, `$1${versionName}$2`);
  if (/<widget\b[^>]*\sandroid-versionCode="/.test(saida)) {
    saida = saida.replace(/(<widget\b[^>]*\sandroid-versionCode=")[^"]*(")/, `$1${versionCode}$2`);
  } else {
    saida = saida.replace(/(<widget\b[^>]*\sversion="[^"]*")/, `$1 android-versionCode="${versionCode}"`);
  }
  if (saida === xml) throw new Error("não encontrei o atributo version do <widget> em config.xml.");
  fs.writeFileSync(CONFIG, saida);
}

function gravar(dados) {
  fs.writeFileSync(ARQUIVO, `${JSON.stringify(dados, null, 2)}\n`);
  gravarConfig(dados.versionName, dados.versionCode);
}

function verificar() {
  const dados = ler();
  const config = lerConfig();
  const problemas = [];
  if (config.versao !== dados.versionName) problemas.push(`config.xml declara version="${config.versao}" e ${path.basename(ARQUIVO)} declara "${dados.versionName}"`);
  if (config.codigo !== String(dados.versionCode)) problemas.push(`config.xml declara android-versionCode=${config.codigo === null ? "(ausente)" : `"${config.codigo}"`} e ${path.basename(ARQUIVO)} declara "${dados.versionCode}"`);
  return { dados, problemas };
}

function uso() {
  console.log("Uso:");
  console.log("  node android-version.js                 mostra a versão Android publicável");
  console.log("  node android-version.js <x.y.z>         define a versão e avança o versionCode");
  console.log("  node android-version.js --rebuild       mantém a versão e avança o versionCode");
  console.log("  node android-version.js --verificar     confere config.xml contra android-release.json");
  process.exit(1);
}

function hojeISO() {
  return new Date().toISOString().slice(0, 10);
}

function main() {
  const arg = process.argv[2];
  if (arg === "--ajuda" || arg === "-h") uso();

  if (!arg) {
    const { dados, problemas } = verificar();
    console.log(`versionName ${dados.versionName} · versionCode ${dados.versionCode} · ${dados.releaseDate}`);
    problemas.forEach((p) => console.error(`aviso: ${p}`));
    return;
  }

  if (arg === "--verificar") {
    const { dados, problemas } = verificar();
    if (problemas.length) {
      problemas.forEach((p) => console.error(`android-version: ${p}`));
      console.error("Rode `npm run android-version -- --rebuild` (ou informe a versão) para sincronizar.");
      process.exit(1);
    }
    console.log(`android-version: config.xml e android-release.json concordam (${dados.versionName} / ${dados.versionCode}).`);
    return;
  }

  const atual = ler();
  let versionName = atual.versionName;
  if (arg !== "--rebuild") {
    if (!RE_VERSAO.test(arg)) uso();
    versionName = arg;
  }
  const versionCode = proximoCodigo(versionName, atual.versionCode);
  gravar({ ...atual, versionName, versionCode, releaseDate: hojeISO() });
  console.log(`Versão Android definida: ${versionName} (versionCode ${versionCode}).`);
  console.log(`Revise as notas de versão em ${path.basename(ARQUIVO)} antes de publicar.`);
}

if (require.main === module) {
  try {
    main();
  } catch (erro) {
    console.error(`android-version: ${erro.message}`);
    process.exit(1);
  }
}

module.exports = { ler, verificar, codigoDerivado, proximoCodigo, ARQUIVO };
