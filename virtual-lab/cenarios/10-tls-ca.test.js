"use strict";

// The verified transport (tls = ca), the mode production boards use: the board accepts a server only
// if its chain ends in a root the firmware ships, and only for the address the board dials.
//
// The boards here run the producaoRaizDeTeste / candidatoRaizDeTeste builds, which trust the lab's own
// root CA next to ISRG Root X1. What this proves is the firmware's TLS stack (mbedTLS of the core it is
// built on) deciding chains and names for both the WebSocket and the HTTPS firmware download. It does
// not prove the public certificate chain of a real installation, which only a physical board against
// that server shows.

const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { cenario } = require("../lib/laboratorio");
const { diretorioTrabalho } = require("../lib/ambiente");
const { raizDeTeste } = require("../lib/firmware");
const { reinicios, desfechoOta } = require("./ota-comum");

const ENDERECO = "192.168.4.9";

function openssl(args) {
  const r = spawnSync("openssl", args, { encoding: "utf8" });
  assert.equal(r.status, 0, `openssl ${args[0]}: ${r.stderr}`);
}

/** Issues certificates into a throwaway directory of this scenario. */
function emissor() {
  const dir = path.join(diretorioTrabalho(), `pki-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const emitir = ({ cn, por, ca = false, san = null }) => {
    const base = path.join(dir, `c${++n}`);
    const ext = `${base}.ext`;
    fs.writeFileSync(ext, ca
      ? "basicConstraints=critical,CA:true,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n"
      : `basicConstraints=CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`);
    openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${base}.key`, "-out", `${base}.csr`, "-subj", `/CN=${cn}`]);
    openssl(["x509", "-req", "-in", `${base}.csr`, "-CA", por.cert, "-CAkey", por.chave, "-set_serial", String(Date.now() * 100 + n), "-days", "2", "-sha256", "-extfile", ext, "-out", `${base}.pem`]);
    return { cert: `${base}.pem`, chave: `${base}.key` };
  };
  const raizPropria = (cn) => {
    const base = path.join(dir, `r${++n}`);
    openssl(["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "2", "-keyout", `${base}.key`, "-out", `${base}.pem`, "-subj", `/CN=${cn}`,
      "-addext", "basicConstraints=critical,CA:true", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
    return { cert: `${base}.pem`, chave: `${base}.key` };
  };
  return { emitir, raizPropria };
}

/** The TLS options of a server presenting `folha`, followed by the intermediates in `cadeia`. */
function opcoes(folha, cadeia = []) {
  return { key: fs.readFileSync(folha.chave), cert: Buffer.concat([folha.cert, ...cadeia.map((c) => c.cert)].map((f) => fs.readFileSync(f))) };
}

function sanDoServidor(endereco) {
  return `DNS:${endereco},IP:${endereco}`;
}

/** The heap the board reported when its latest session opened, from the server's diagnostic log. */
function ultimoDiagnostico(lab, sala) {
  const linhas = String(lab.servidor.saida || "").split("\n").filter((l) => l.includes("[device-ws-diagnostico]"));
  for (const l of linhas.reverse()) {
    try {
      const d = JSON.parse(l.slice(l.indexOf("{")));
      if (d.sala === sala && Number.isInteger(d.heapLivre)) return { heapLivre: d.heapLivre, heapMaiorBloco: d.heapMaiorBloco, uptimeS: d.uptimeS };
    } catch {}
  }
  return null;
}

async function placaVerificada(lab, via, variante, sala = "A-103a") {
  const credencial = await lab.prepararSala(sala);
  const placa = lab.novaPlaca({ variante, via });
  await placa.ligar();
  await lab.configurarPeloPortal(placa, { credencial, tls: "ca" });
  await lab.aguardarConectada(sala, { limiteMs: 300_000 });
  return { placa, sala };
}

cenario("Transporte verificado (ca): a cadeia da raiz confiável abre a sessão e a OTA baixa por HTTPS verificado", {
  firmware: ["producaoRaizDeTeste", "candidatoRaizDeTeste"],
  inicial: "Placa de fábrica configurada pelo portal com tls = ca; o servidor apresenta folha (IP e DNS do endereço discado) e intermediária emitidas pela raiz em que o firmware confia",
  falha: "nenhuma",
  exigido: ["a sessão WebSocket abre sobre TLS verificado", "com a sessão aberta e novas conexões recebendo um certificado para outro endereço, o download da OTA é recusado e a imagem instalada fica", "com a cadeia válida, o candidato é baixado pelo HTTPS verificado, grava, inicia, se autovalida e reconecta no mesmo modo"],
  proibido: ["aviso de transporte sem validação", "handshake recusado com a cadeia válida", "imagem baixada por uma conexão que a verificação deveria recusar"],
  recuperacao: "a OTA com a cadeia válida conclui depois da recusada",
}, async (lab) => {
  const pki = emissor();
  const intermediaria = pki.emitir({ cn: "RemoteIFES lab intermediate", por: raizDeTeste(), ca: true });
  const folha = pki.emitir({ cn: ENDERECO, por: intermediaria, san: sanDoServidor(ENDERECO) });
  const via = await lab.intermediario({ tlsOpcoes: opcoes(folha, [intermediaria]) });
  const { placa, sala } = await placaVerificada(lab, via, "producaoRaizDeTeste");
  assert.doesNotMatch(placa.serial, /AVISO DE SEGURANCA/);
  assert.equal(via.conexoesDo("tls-recusada").length, 0, "the valid chain was accepted on every handshake");

  const candidato = lab.firmware("candidatoRaizDeTeste");
  await lab.publicarFirmware(candidato.app, candidato.versao);

  // The session stays open on the valid chain while new connections get a certificate for another
  // address: the download, a new HTTPS connection, must be refused by the same verification.
  via.servidor.setSecureContext(opcoes(pki.emitir({ cn: "outro-servidor.invalid", por: intermediaria, san: "DNS:outro-servidor.invalid,IP:192.168.4.10" }), [intermediaria]));
  const recusadasAntes = via.conexoesDo("tls-recusada").length;
  const recusa = await lab.ofertarOta(sala);
  assert.equal(recusa.status, 200, JSON.stringify(recusa.corpo));
  const { final: semCadeia } = await desfechoOta(lab, sala);
  lab.observar("otaComOutroNome", { fase: semCadeia.fase, erro: semCadeia.erro, causa: semCadeia.causa });
  assert.equal(semCadeia.fase, "falhou", "a download from a server the certificate does not name fails");
  assert.ok(via.conexoesDo("tls-recusada").length > recusadasAntes, "the download's handshake was refused");
  assert.equal(via.conexoesDo("firmware").length, 0, "no image byte crossed an unverified connection");
  const intacto = lab.slots(placa);
  assert.equal(intacto.boot, "ota_0");
  assert.equal(intacto.conteudo.ota_0, "producaoRaizDeTeste");
  via.servidor.setSecureContext(opcoes(folha, [intermediaria]));
  await lab.aguardarConectada(sala, { limiteMs: 300_000 });

  const desde = placa.marca();
  const recusadasNaOta = via.conexoesDo("tls-recusada").length;
  const oferta = await lab.ofertarOta(sala);
  assert.equal(oferta.status, 200, JSON.stringify(oferta.corpo));
  const { final, historico } = await desfechoOta(lab, sala);
  lab.observar("ota", { fase: final.fase, erro: final.erro, historico });
  assert.equal(final.fase, "concluido", `the OTA over the verified transport completes (${final.erro})`);
  assert.ok(via.conexoesDo("firmware").some((c) => c.corpoParaPlaca >= fs.statSync(candidato.app).size), "the image crossed the verified HTTPS download");
  await placa.aguardarSerial(/Autovalidacao OK: novo firmware confirmado/, { desde });
  const s = lab.slots(placa);
  lab.observar("slots", s);
  assert.equal(s.boot, "ota_1");
  assert.equal(s.conteudo.ota_1, "candidatoRaizDeTeste");
  const estado = await lab.aguardarConectada(sala, { limiteMs: 300_000 });
  assert.equal(estado.dispositivo.fwVersao, candidato.versao);
  assert.equal(via.conexoesDo("tls-recusada").length, recusadasNaOta, "the valid chain was accepted on every handshake of the update");
  assert.equal(reinicios(placa, desde), 1, "exactly one restart: the one into the candidate");
});

cenario("Transporte verificado (ca) recusa cadeia de outra raiz, nome de outro servidor e cadeia sem intermediária", {
  firmware: ["producaoRaizDeTeste"],
  inicial: "Placa conectada com tls = ca à cadeia válida (controle)",
  falha: "o servidor passa a apresentar, um de cada vez: folha de uma raiz desconhecida; folha da raiz confiável para outro endereço; a folha válida sem a intermediária. A cada troca as conexões vivas caem",
  exigido: ["cada handshake das três falhas é recusado pela placa", "nenhuma sessão abre durante as falhas", "com a cadeia válida de volta a sessão reabre sozinha"],
  proibido: ["sessão aberta com certificado que não fecha a cadeia ou não nomeia o servidor", "reinício"],
  recuperacao: "a cadeia válida volta e a placa reconecta sem intervenção",
}, async (lab) => {
  const pki = emissor();
  const intermediaria = pki.emitir({ cn: "RemoteIFES lab intermediate", por: raizDeTeste(), ca: true });
  const valida = opcoes(pki.emitir({ cn: ENDERECO, por: intermediaria, san: sanDoServidor(ENDERECO) }), [intermediaria]);
  const estranha = pki.raizPropria("Unknown root");
  const intermediariaEstranha = pki.emitir({ cn: "Unknown intermediate", por: estranha, ca: true });
  const falhas = [
    { nome: "outra raiz", tls: opcoes(pki.emitir({ cn: ENDERECO, por: intermediariaEstranha, san: sanDoServidor(ENDERECO) }), [intermediariaEstranha]) },
    { nome: "outro servidor", tls: opcoes(pki.emitir({ cn: "outro-servidor.invalid", por: intermediaria, san: "DNS:outro-servidor.invalid,IP:192.168.4.10" }), [intermediaria]) },
    { nome: "sem intermediaria", tls: opcoes(pki.emitir({ cn: ENDERECO, por: intermediaria, san: sanDoServidor(ENDERECO) })) },
  ];

  const via = await lab.intermediario({ tlsOpcoes: valida });
  const { placa, sala } = await placaVerificada(lab, via, "producaoRaizDeTeste");
  // Heap diagnostics exist from firmware 4.5.1; an older installed release (base_ref) skips the heap check.
  const heapAntes = await lab.aguardar(() => ultimoDiagnostico(lab, sala), { descricao: "the board's diagnostics of the control session", limiteMs: 60_000 }).catch(() => null);
  const desde = placa.marca();
  const observado = [];
  for (const falha of falhas) {
    via.servidor.setSecureContext(falha.tls);
    const inicio = via.conexoes.length;
    via.cortarTudo();
    await lab.aguardarDesconectada(sala);
    await lab.aguardar(() => via.conexoesDo("tls-recusada", inicio).length >= 2, { descricao: `two refused handshakes (${falha.nome})`, limiteMs: 300_000 });
    const tipos = via.conexoes.slice(inicio).map((c) => c.tipo);
    observado.push({ falha: falha.nome, conexoes: tipos });
    assert.ok(tipos.every((t) => t === "tls-recusada"), `${falha.nome}: every handshake was refused (${tipos.join(", ")})`);
    assert.equal((await lab.estado(sala)).dispositivo.conectado, false, `${falha.nome}: no session`);
  }
  lab.observar("falhas", observado);
  via.servidor.setSecureContext(valida);
  await lab.aguardarConectada(sala, { limiteMs: 300_000 });
  assert.equal(reinicios(placa, desde), 0);
  if (!heapAntes) return lab.observar("heap", "firmware sem diagnóstico de heap");
  const heapDepois = await lab.aguardar(() => {
    const d = ultimoDiagnostico(lab, sala);
    return d && d.uptimeS > heapAntes.uptimeS ? d : false;
  }, { descricao: "the board's diagnostics of the recovered session" });
  const recusados = observado.reduce((n, o) => n + o.conexoes.length, 0);
  lab.observar("heap", { antes: heapAntes, depois: heapDepois, handshakesRecusados: recusados });
  assert.ok(heapAntes.heapLivre - heapDepois.heapLivre < 16 * 1024, `refused handshakes do not drain the heap: ${JSON.stringify({ heapAntes, heapDepois, recusados })}`);
});
