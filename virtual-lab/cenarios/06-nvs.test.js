"use strict";

// The firmware's persistent state (ESP-IDF NVS, namespace "remoteifes") damaged in controlled ways
// while the board is off, then the board powered on. Edits keep NVS's own CRCs valid where the point
// is to see what the FIRMWARE does with a well-formed but wrong value; electrical flash damage under
// a real power cut is not modelled.

const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { cenario } = require("../lib/laboratorio");
const flash = require("../lib/flash");
const { diretorioTrabalho } = require("../lib/ambiente");

function reinicios(placa, desde = 0) {
  return placa.contarSerial(/rst:0x/, desde);
}

async function editarNvs(lab, placa, editar) {
  await placa.desligar();
  const imagem = lab.lerFlash(placa);
  editar(imagem);
  lab.gravarFlash(placa, imagem);
}

/**
 * The board boots into its setup access point and stays there: one boot, the portal answers, and it
 * tries no server at all.
 */
async function entraEmConfiguracao(lab, placa, via) {
  const desde = placa.marca();
  const conexoes = via.conexoes.length;
  await placa.ligar();
  await placa.aguardarSerial(/Ponto de Acesso 'RemoteIFES-Setup' ativo no IP: 192\.168\.4\.1/, { desde });
  const r = await fetch(`http://127.0.0.1:${placa.portaPortal}/`, { signal: AbortSignal.timeout(30_000) });
  assert.equal(r.status, 200, "the setup portal answers");
  await placa.aguardarVirtual(60_000);
  assert.equal(reinicios(placa, desde), 1, "one boot, no reset loop");
  assert.equal(via.conexoes.length, conexoes, "no server connection attempted without a valid configuration");
}

/** Recovery through the portal, as an installer on site would do it. */
async function reconfigura(lab, placa, sala) {
  const c = await lab.api("POST", `/admin/esp32/${encodeURIComponent(sala)}/credencial/substituir`);
  assert.equal(c.status, 200, JSON.stringify(c.corpo));
  require("../lib/ambiente").registrarSegredo(c.corpo.segredo);
  await lab.configurarPeloPortal(placa, { credencial: { deviceId: c.corpo.deviceId, segredo: c.corpo.segredo } });
  await lab.aguardarConectada(sala, { limiteMs: 300_000 });
}

const configuracoesInvalidas = [
  {
    nome: "NVS apagada: a placa volta à configuração inicial",
    falha: "a partição NVS inteira é apagada",
    editar: (img) => flash.apagarNvs(img),
  },
  {
    nome: "Configuração parcial na NVS: sem o endereço do servidor",
    falha: "a chave host é apagada; SSID, senha, porta e credencial continuam",
    editar: (img) => flash.apagarChaveNvs(img, "remoteifes", "host"),
  },
  {
    nome: "Porta do servidor gravada com o tipo errado",
    falha: "a chave porta (i32) passa a ser um u8 válido para a NVS",
    editar: (img) => flash.trocarTipoNvs(img, "remoteifes", "porta", "i32", "u8"),
  },
];

for (const caso of configuracoesInvalidas) {
  cenario(caso.nome, {
    inicial: "Placa configurada e conectada",
    falha: caso.falha,
    exigido: ["a placa entra no RemoteIFES-Setup (estado de configuração explícito e recuperável) e o portal responde", "nenhuma tentativa de servidor com configuração inválida", "um único boot"],
    proibido: ["laço de reinícios", "valor padrão inseguro usado para conectar"],
    recuperacao: "o portal reconfigura a placa e ela volta a operar",
  }, async (lab) => {
    const { placa, sala, via } = await lab.placaEmOperacao();
    await editarNvs(lab, placa, caso.editar);
    await entraEmConfiguracao(lab, placa, via);
    await reconfigura(lab, placa, sala);
  });
}

cenario("Modo de transporte desconhecido na NVS não desliga a verificação do certificado", {
  inicial: "Placa configurada com TLS sem verificação (inseguro), explícito, conectando a um servidor com certificado autoassinado",
  falha: "o valor de tls na NVS vira um texto desconhecido do mesmo tamanho",
  exigido: ["com o valor explícito a sessão TLS abre (controle: o TLS do emulador funciona)", "com o valor desconhecido a placa trata o transporte como verificado e recusa o certificado"],
  proibido: ["sessão aberta com certificado não confiável a partir de um valor corrompido"],
  recuperacao: "não se aplica: o valor corrompido não pode reabrir o canal",
}, async (lab) => {
  const dir = path.join(diretorioTrabalho(), `tls-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  const chave = path.join(dir, "chave.pem");
  const cert = path.join(dir, "cert.pem");
  const r = spawnSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", chave, "-out", cert, "-days", "1", "-subj", "/CN=remoteifes-virtual-lab.invalid"], { encoding: "utf8" });
  assert.equal(r.status, 0, `openssl: ${r.stderr}`);
  const via = await lab.intermediario({ tlsOpcoes: { key: fs.readFileSync(chave), cert: fs.readFileSync(cert) } });
  const credencial = await lab.prepararSala("A-103a");
  const placa = lab.novaPlaca({ via });
  await placa.ligar();
  await lab.configurarPeloPortal(placa, { credencial, tls: "inseguro" });
  await lab.aguardarConectada("A-103a", { limiteMs: 300_000 });
  lab.observar("controleInseguroConectou", true);
  await editarNvs(lab, placa, (img) => flash.substituirStringNvs(img, "remoteifes", "tls", "insegur0"));
  const desde = placa.marca();
  const tentativas = via.conexoes.length;
  await lab.aguardarDesconectada("A-103a");
  await placa.ligar();
  await placa.aguardarSerial(/IP: 192\.168\.4\.15/, { desde });
  await placa.aguardarVirtual(90_000);
  const depois = via.conexoes.slice(tentativas);
  lab.observar("conexoesComValorDesconhecido", depois.map((c) => c.tipo));
  assert.ok(depois.length >= 1, "the board tried to reach the server");
  assert.ok(depois.every((c) => c.tipo === "tls-recusada"), "every TLS handshake failed on the certificate");
  assert.equal((await lab.estado("A-103a")).dispositivo.conectado, false, "no session through an untrusted certificate");
  assert.doesNotMatch(placa.serial.slice(desde), /transporte sem validacao de certificado foi selecionado/);
});

cenario("Registro do failsafe corrompido na NVS nunca é transmitido", {
  inicial: "Placa com failsafe OFF gravado (registro fsRec com CRC próprio)",
  falha: "um byte do RAW dentro de fsRec é alterado (CRC da NVS refeito, CRC do registro não); a placa liga sem servidor",
  exigido: ["a placa descarta o registro (CRC do firmware) e o segurar do botão não transmite nada", "com o servidor de volta, o failsafe é reenviado e volta a valer"],
  proibido: ["IR transmitido a partir de um registro corrompido"],
  recuperacao: "failsafe válido de novo e transmitido pelo botão",
}, async (lab) => {
  const via = await lab.intermediario();
  const { placa, sala } = await lab.placaEmOperacao({ via });
  const raw = [9000, 4500, 560, 560, 560, 1690, 560, 560, 560, 1690, 560];
  await lab.definirFailsafe(sala, { raw, carrierHz: 38000 });
  await lab.aguardar(async () => (await lab.estado(sala)).dispositivo.failsafe.configurado === true, { descricao: "failsafe stored on the board" });
  await editarNvs(lab, placa, (img) => flash.alterarBlobNvs(img, "remoteifes", "fsRec", 20 + 4));
  via.modo = "recusar";
  const desde = placa.marca();
  await placa.ligar();
  await placa.aguardarSerial(/Registro de failsafe invalido na NVS/, { desde });
  const bordas = placa.bordas.length;
  await placa.pressionarBotao(6000);
  await placa.aguardarSerial(/Failsafe ignorado: nenhum RAW OFF salvo na NVS/, { desde });
  assert.equal(placa.bordasDe(4, bordas).length, 0, "nothing was transmitted from the damaged record");
  via.modo = "normal";
  await lab.aguardar(async () => (await lab.estado(sala)).dispositivo.failsafe.configurado === true, { descricao: "failsafe re-sent and stored", limiteMs: 300_000 });
  const antes = placa.bordas.length;
  await placa.pressionarBotao(6000);
  await placa.aguardarSerial(/Failsafe OFF transmitido localmente/, { desde });
  const ir = placa.bordasDe(4, antes).length;
  lab.observar("bordasIrFailsafeValido", ir);
  assert.ok(ir > 0);
});

cenario("Energia cortada no meio da gravação do failsafe na NVS", {
  inicial: "Placa com failsafe A gravado",
  falha: "o servidor envia um failsafe B e a energia é cortada dentro da escrita da NVS (entre gravar os blocos novos e apagar os antigos)",
  exigido: ["ao religar, o registro lido é A ou B inteiro, com CRC válido", "o botão transmite exatamente esse registro"],
  proibido: ["registro misto aceito", "laço de reinícios"],
  recuperacao: "a placa opera e o failsafe atual é o do servidor",
}, async (lab) => {
  const via = await lab.intermediario();
  const { placa, sala } = await lab.placaEmOperacao({ via });
  const a = [9000, 4500, 560, 560, 560, 1690, 560, 560, 560];
  const b = [8000, 4000, 600, 600, 600, 1600, 600, 1600, 600, 600, 600];
  await lab.definirFailsafe(sala, { raw: a });
  await lab.aguardar(async () => (await lab.estado(sala)).dispositivo.failsafe.pulsos === a.length, { descricao: "failsafe A stored" });
  const parada = placa.pararEm(null, { funcao: "nvs::Page::eraseItem", acao: "desligar" });
  await new Promise((r) => setTimeout(r, 1500));
  await lab.definirFailsafe(sala, { raw: b });
  await parada;
  const ns = lab.nvs(placa);
  lab.observar("nvsAposCorte", { duplicadas: ns.duplicadas, corrompidas: ns.corrompidas });
  via.modo = "recusar";
  const desde = placa.marca();
  await placa.ligar();
  const m = await placa.aguardarSerial(/Failsafe OFF persistido na NVS: (\d+) pulsos|Failsafe OFF nao configurado|Registro de failsafe invalido/, { desde });
  lab.observar("lidoAposCorte", m[0]);
  const pulsos = m[1] ? Number(m[1]) : null;
  assert.ok(pulsos === a.length || pulsos === b.length, `the record after the cut is A or B, whole (${m[0]})`);
  const antes = placa.bordas.length;
  await placa.pressionarBotao(6000);
  await placa.aguardarSerial(/Failsafe OFF transmitido localmente/, { desde });
  assert.ok(placa.bordasDe(4, antes).length > 0);
  assert.equal(reinicios(placa, desde), 1);
  via.modo = "normal";
  await lab.aguardar(async () => (await lab.estado(sala)).dispositivo.failsafe.pulsos === b.length, { descricao: "B stored after reconnection", limiteMs: 300_000 });
});

cenario("Credencial pela metade na NVS: sem segredo a placa não entra, e o local recupera", {
  inicial: "Placa configurada com credencial; credencial obrigatória no servidor",
  falha: "a chave devSec é apagada; devId continua",
  exigido: ["o servidor recusa a placa sem credencial completa", "a placa não reinicia em laço", "um toque no botão abre o RemoteIFES-Setup e a reconfiguração local a traz de volta"],
  proibido: ["sessão sem credencial", "placa inalcançável até pelo portal"],
  recuperacao: "placa conectada com a credencial nova",
}, async (lab) => {
  const { placa, sala, via } = await lab.placaEmOperacao();
  await editarNvs(lab, placa, (img) => flash.apagarChaveNvs(img, "remoteifes", "devSec"));
  const desde = placa.marca();
  await placa.ligar();
  await placa.aguardarVirtual(60_000);
  assert.equal((await lab.estado(sala)).dispositivo.conectado, false, "no session without the secret");
  const semCredencial = via.conexoes.filter((c) => c.cabecalhos && !c.cabecalhos["x-device-secret"]).length;
  lab.observar("tentativasSemSegredo", semCredencial);
  assert.equal(reinicios(placa, desde), 1);
  await placa.pressionarBotao(300);
  await placa.aguardarSerial(/Switch: RemoteIFES-Setup aberto temporariamente/, { desde });
  await reconfigura(lab, placa, sala);
});
