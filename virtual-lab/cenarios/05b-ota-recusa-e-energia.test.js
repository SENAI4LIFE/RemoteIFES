"use strict";

// OTA on the real firmware: offers refused before writing, and power cuts at exact points.
// Invariant, helpers and limits: see ota-comum.js.

const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { cenarioOta, emOperacao, reinicios, ultimoBomIntacto, desfechoOta, keepaliveDuranteDownload, otaValidoConclui, downloadPassou } = require("./ota-comum");

cenarioOta("OTA maior que a partição: recusado antes de gravar", {
  inicial: "Placa na versão de produção, conectada",
  falha: "o firmware publicado é uma imagem válida completada até passar do tamanho da partição ota_1 (0x1E0000)",
  exigido: ["a placa recusa a oferta pelo tamanho, sem baixar nem apagar nada", "ota_1 fica como estava"],
  proibido: ["qualquer download ou escrita em flash", "reinício"],
  recuperacao: "um OTA de tamanho válido conclui",
}, async (lab) => {
  const ctx = await emOperacao(lab);
  const grande = Buffer.alloc(0x1e0000 + 4096, 0);
  fs.readFileSync(ctx.candidato.app).copy(grande);
  const arquivo = path.join(os.tmpdir(), `remoteifes-lab-grande-${process.pid}.bin`);
  fs.writeFileSync(arquivo, grande);
  try {
    const [a, b, c] = ctx.candidato.versao.split(".").map(Number);
    await lab.publicarFirmware(arquivo, `${a}.${b}.${c + 7}`);
  } finally {
    fs.rmSync(arquivo, { force: true });
  }
  const antes = lab.slots(ctx.placa);
  const msgs = ctx.via.daPlaca.length;
  const desde = ctx.placa.marca();
  assert.equal((await lab.ofertarOta(ctx.sala)).status, 200);
  const resposta = await lab.aguardar(() => ctx.via.mensagensDaPlaca({ tipo: "ota_resultado" }, msgs)[0], { descricao: "ota_resultado" });
  lab.observar("respostaDaPlaca", resposta);
  assert.equal(resposta.resultado, "erro");
  assert.match(resposta.erro, /maior que a particao/);
  assert.equal(ctx.via.conexoesDo("firmware").length, 0, "nothing was downloaded");
  assert.equal(reinicios(ctx.placa, desde), 0);
  assert.deepEqual(lab.slots(ctx.placa), antes, "the flash layout is unchanged");
  await otaValidoConclui(lab, ctx);
});

cenarioOta("Oferta de versão menor: bloqueada no servidor e, forjada, recusada pela placa", {
  inicial: "Placa na versão de produção, conectada",
  falha: "publica-se uma versão menor que a da placa; depois uma oferta de versão menor é injetada diretamente na conexão (transporte sem TLS)",
  exigido: ["o servidor recusa ofertar rebaixamento", "a placa recusa a oferta forjada sem baixar nada"],
  proibido: ["download ou gravação", "reinício"],
  recuperacao: "a placa segue operando e aceita um OTA válido",
}, async (lab) => {
  const ctx = await emOperacao(lab);
  const [a, b, c] = ctx.base.versao.split(".").map(Number);
  const menor = c > 0 ? `${a}.${b}.${c - 1}` : `${a}.${b - 1}.99`;
  await lab.publicarFirmware(ctx.base.app, menor);
  const oferta = await lab.ofertarOta(ctx.sala);
  lab.observar("servidor", { status: oferta.status, erro: oferta.corpo.erro });
  assert.equal(oferta.status, 409);
  assert.match(oferta.corpo.erro, /downgrade bloqueado/);
  const msgs = ctx.via.daPlaca.length;
  const desde = ctx.placa.marca();
  await ctx.via.injetarTexto(JSON.stringify({ tipo: "ota_oferta", versao: menor, sha256: "0".repeat(64), tamanho: fs.statSync(ctx.base.app).size, caminho: "/dispositivo/firmware", tentativa: "lab-rebaixamento" }));
  const resposta = await lab.aguardar(() => ctx.via.mensagensDaPlaca({ tipo: "ota_resultado" }, msgs)[0], { descricao: "ota_resultado" });
  lab.observar("respostaDaPlaca", resposta);
  assert.match(resposta.erro, /downgrade de firmware bloqueado/);
  assert.equal(ctx.via.conexoesDo("firmware").length, 0);
  assert.equal(reinicios(ctx.placa, desde), 0);
  ultimoBomIntacto(lab, ctx.placa, "apos-oferta-forjada");
  await otaValidoConclui(lab, ctx);
});

const cortesDeEnergia = [
  {
    nome: "Energia cortada depois de aceitar a oferta, antes de gravar",
    trecho: "if (!Update.begin(tamanho)) {",
    onde: "na chamada de Update.begin, com a oferta aceita e o download aberto",
    candidatoInicia: false,
  },
  {
    nome: "Energia cortada no meio da gravação do firmware",
    trecho: "if (Update.write(buffer, lidos) != (size_t)lidos) {",
    ocorrencia: 700,
    onde: "na 700ª escrita de bloco (cerca de metade da imagem)",
    candidatoInicia: false,
  },
  {
    nome: "Energia cortada depois de gravar e antes de reiniciar",
    trecho: "agendarReinicio(1200);",
    onde: "com a imagem gravada e verificada e a partição de boot já trocada, antes do reinício agendado",
    candidatoInicia: true,
  },
];

for (const caso of cortesDeEnergia) {
  cenarioOta(caso.nome, {
    inicial: "Placa na versão de produção, conectada; candidato publicado e ofertado",
    falha: `corte de energia ${caso.onde} (ponto de parada exato por GDB)`,
    exigido: caso.candidatoInicia
      ? ["ao religar, o bootloader inicia o candidato completo, que passa pela autovalidação", "ota_0 intacto como retorno"]
      : ["ao religar, a placa inicia a versão de produção de ota_0", "o servidor não dá a atualização por concluída"],
    proibido: ["placa sem imagem inicializável", "laço de reinícios", "ota_0 alterado"],
    recuperacao: caso.candidatoInicia ? "o candidato conclui a validação com o servidor" : "um OTA válido conclui",
  }, async (lab) => {
    const ctx = await emOperacao(lab);
    await lab.publicarFirmware(ctx.candidato.app, ctx.candidato.versao);
    const parada = ctx.placa.pararEm(caso.trecho, { ocorrencia: caso.ocorrencia || 1, acao: "desligar" });
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal((await lab.ofertarOta(ctx.sala)).status, 200);
    await parada;
    const desligada = lab.slots(ctx.placa);
    lab.observar("slotsComAPlacaDesligada", desligada);
    assert.equal(desligada.conteudo.ota_0, "producao");
    const desde = ctx.placa.marca();
    await ctx.placa.ligar();
    if (caso.candidatoInicia) {
      assert.equal(desligada.boot, "ota_1", "Update.end already selected the new image");
      await ctx.placa.aguardarSerial(new RegExp(`fw ${ctx.candidato.versao.replace(/\./g, "\\.")}\\)`), { desde });
      await ctx.placa.aguardarSerial(/Autovalidacao OK: novo firmware confirmado/, { desde, limiteMs: 300_000 });
      const { final: ota, historico } = await desfechoOta(lab, ctx.sala);
      lab.observar("servidor", { fase: ota.fase, causa: ota.causa, erro: ota.erro, historico });
      assert.equal(ota.fase, "concluido");
      const s = lab.slots(ctx.placa);
      assert.equal(s.estado.ota_1, "VALID");
      assert.equal(s.conteudo.ota_0, "producao");
    } else {
      await ctx.placa.aguardarSerial(new RegExp(`fw ${ctx.base.versao.replace(/\./g, "\\.")}\\)`), { desde });
      await lab.aguardarConectada(ctx.sala, { limiteMs: 300_000 });
      assert.ok(reinicios(ctx.placa, desde) <= 1, "one power-on, no reset loop");
      const ota = await lab.aguardarFaseOta(ctx.sala, "falhou");
      lab.observar("servidor", { fase: ota.fase, causa: ota.causa, erro: ota.erro });
      ultimoBomIntacto(lab, ctx.placa, "apos-religar");
      await otaValidoConclui(lab, ctx);
    }
  });
}
