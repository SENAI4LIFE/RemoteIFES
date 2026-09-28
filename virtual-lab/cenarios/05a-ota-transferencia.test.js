"use strict";

// OTA on the real firmware: a valid update, and transfers that fail on the way.
// Invariant, helpers and limits: see ota-comum.js.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cenarioOta, emOperacao, reinicios, ultimoBomIntacto, desfechoOta, keepaliveDuranteDownload, otaValidoConclui, downloadPassou } = require("./ota-comum");

cenarioOta("OTA válido: download, gravação, boot do candidato e autovalidação", {
  inicial: "Placa na versão de produção (ota_0), conectada; candidato (mesma fonte, versão +1) publicado",
  falha: "nenhuma",
  exigido: ["o candidato é gravado em ota_1 e o bootloader passa a iniciá-lo", "o candidato fica pendente até a própria autovalidação e só então é confirmado", "o servidor conclui a atualização pela evidência de boot"],
  proibido: ["candidato confirmado antes da autovalidação", "ota_0 alterado"],
  recuperacao: "não se aplica",
}, async (lab) => {
  const ctx = await emOperacao(lab);
  const desde = ctx.placa.marca();
  await otaValidoConclui(lab, ctx);
  const serial = ctx.placa.serial.slice(desde);
  assert.ok(serial.indexOf("aguardando autovalidacao") >= 0, "the new image booted pending verification");
  assert.ok(serial.indexOf("aguardando autovalidacao") < serial.indexOf("Autovalidacao OK"), "it was confirmed only by the self-test");
  assert.equal(lab.slots(ctx.placa).conteudo.ota_0, "producao", "the previous image stays in ota_0");
});

const falhasDeTransferencia = [
  {
    nome: "OTA com um byte alterado no caminho: o SHA-256 recusa a imagem",
    falha: "um byte da imagem é invertido durante o download (offset 700000)",
    armar: (via) => { via.firmware = { corromperByte: 700_000 }; },
    erro: /sha256 divergente/,
  },
  {
    nome: "OTA truncado: conexão cortada no meio do download",
    falha: "a conexão do download é cortada depois de 700000 bytes",
    armar: (via) => { via.firmware = { cortarApos: 700_000 }; },
    erro: /conexao encerrada antes do fim|tempo esgotado durante o download/,
  },
  {
    nome: "OTA parado no meio: o servidor para de enviar e a placa desiste no prazo",
    falha: "o download para de fluir depois de 700000 bytes, com a conexão aberta",
    armar: (via) => { via.firmware = { pararApos: 700_000 }; },
    erro: /tempo esgotado durante o download/,
    prazoVirtual: true,
  },
  {
    nome: "OTA com tamanho declarado diferente da oferta",
    falha: "o Content-Length do download difere, em um byte, do tamanho ofertado",
    armar: (via, candidato) => { via.firmware = { tamanhoDeclarado: fs.statSync(candidato.app).size + 1 }; },
    erro: /tamanho do download difere da oferta/,
  },
];

for (const caso of falhasDeTransferencia) {
  cenarioOta(caso.nome, {
    inicial: "Placa na versão de produção, conectada; candidato publicado",
    falha: caso.falha,
    exigido: ["a placa rejeita a imagem, relata o erro e continua na versão atual sem reiniciar", "o servidor registra a falha", "ota_0 intacto e escolhido pelo bootloader"],
    proibido: ["gravação concluída de imagem inválida", "reinício para o candidato", "ota_0 alterado"],
    recuperacao: "com a rede normal, um OTA válido conclui",
  }, async (lab) => {
    const ctx = await emOperacao(lab);
    await lab.publicarFirmware(ctx.candidato.app, ctx.candidato.versao);
    caso.armar(ctx.via, ctx.candidato);
    const desde = ctx.placa.marca();
    const msgs = ctx.via.daPlaca.length;
    const oferta = await lab.ofertarOta(ctx.sala);
    assert.equal(oferta.status, 200, JSON.stringify(oferta.corpo));
    let inicioParada = null;
    if (caso.prazoVirtual) {
      await lab.aguardar(() => ctx.via.conexoesDo("firmware").some((c) => c.parado), { descricao: "download stalled", limiteMs: 300_000, intervaloMs: 100 });
      inicioParada = await ctx.placa.agoraMs();
    }
    // A failure inside the download loop is logged on the serial console; one detected before it (the
    // declared size) is only reported to the server. Either is the board's own account.
    const erroNaPlaca = await lab.aguardar(() => {
      const m = /OTA: falhou \(([^)]*)\)\. Firmware atual mantido\./.exec(ctx.placa.serial.slice(desde));
      if (m) return m[1];
      const r = ctx.via.mensagensDaPlaca({ tipo: "ota_resultado", resultado: "erro" }, msgs)[0];
      return r ? r.erro : false;
    }, { descricao: "the board's own OTA error", limiteMs: 600_000, intervaloMs: 200 });
    lab.observar("erroNaPlaca", erroNaPlaca);
    assert.match(erroNaPlaca, caso.erro);
    if (inicioParada !== null) {
      const esperaMs = (await ctx.placa.agoraMs()) - inicioParada;
      lab.observar("esperaAteDesistirMsVirtual", Math.round(esperaMs));
      assert.ok(esperaMs >= 18_000 && esperaMs <= 60_000, `gave up after ${Math.round(esperaMs)} ms of board time (limit 20 s)`);
    }
    assert.equal(reinicios(ctx.placa, desde), 0, "the board did not restart");
    const ota = await lab.aguardarFaseOta(ctx.sala, "falhou");
    lab.observar("servidor", { fase: ota.fase, causa: ota.causa, erro: ota.erro });
    ultimoBomIntacto(lab, ctx.placa, "apos-falha");
    await otaValidoConclui(lab, ctx);
  });
}

cenarioOta("OTA com o servidor morto (SIGKILL) no meio do download", {
  inicial: "Placa na versão de produção, conectada; candidato publicado",
  falha: "o processo do servidor é morto com SIGKILL no meio do download e religado",
  exigido: ["a placa abandona o download, mantém a versão atual e volta a conectar quando o servidor retorna", "o servidor, ao voltar, não dá a atualização por concluída"],
  proibido: ["candidato gravado ou iniciado", "ota_0 alterado"],
  recuperacao: "um OTA válido conclui depois do reinício do servidor",
}, async (lab) => {
  const ctx = await emOperacao(lab);
  await lab.publicarFirmware(ctx.candidato.app, ctx.candidato.versao);
  const desde = ctx.placa.marca();
  assert.equal((await lab.ofertarOta(ctx.sala)).status, 200);
  await downloadPassou(lab, ctx.via, 600_000);
  await lab.servidor.parar("SIGKILL");
  const m = await ctx.placa.aguardarSerial(/OTA: falhou \(([^)]*)\)/, { desde, limiteMs: 600_000 });
  lab.observar("erroNaPlaca", m[1]);
  assert.equal(reinicios(ctx.placa, desde), 0);
  await lab.servidor.subir();
  await lab.aguardarConectada(ctx.sala, { limiteMs: 300_000 });
  const ota = await lab.aguardarFaseOta(ctx.sala, "falhou");
  lab.observar("servidorAposReinicio", { fase: ota.fase, causa: ota.causa, erro: ota.erro });
  ultimoBomIntacto(lab, ctx.placa, "apos-falha");
  await otaValidoConclui(lab, ctx);
});
