"use strict";

// The real firmware against the production installation: server.js as the systemd unit
// install-service.sh writes, behind the nginx site lan-setup.sh writes, on a disposable runner. It runs
// inside the deployment rehearsal (remoteifes-server/ensaio-implantacao.sh, step 6b), which sets
// LAB_SERVIDOR_BASE; elsewhere it is skipped.
//
// What only this shows: the nginx WebSocket proxy carrying the firmware's own client (its headers and
// upgrade), and the firmware riding out a systemd restart, a killed process restarted by systemd, and
// the proxy going away, with the unit's real restart policy.

const assert = require("node:assert/strict");
const { cenario } = require("../lib/laboratorio");

function reinicios(placa, desde = 0) {
  return placa.contarSerial(/rst:0x/, desde);
}

cenario("Firmware real contra a instalação de produção: nginx, reinício, processo morto e proxy fora", {
  inicial: "Instalação do ensaio no ar (unidade systemd, nginx na porta 80); placa de fábrica configurada pelo portal apontando para o nginx",
  falha: "systemctl restart do serviço; SIGKILL do processo (o systemd o relança); nginx parado por 1 minuto (tempo da placa) e religado",
  exigido: [
    "sessão WebSocket autenticada através do nginx e comando confirmado",
    "depois de cada falha a placa reconecta sozinha e o estado confirmado volta a ser a intenção",
    "com o nginx fora, tentativas espaçadas (no máximo 20 por minuto)",
  ],
  proibido: ["reinício da placa", "intenção perdida", "laço de tentativas"],
  recuperacao: "estado confirmado ligado ao fim",
}, async (lab) => {
  const salas = (await lab.api("GET", "/admin/salas")).corpo;
  const lista = Array.isArray(salas) ? salas : salas.salas;
  // The rehearsal's own simulated boards take the first rooms; the lab takes the last.
  const sala = lista[lista.length - 1].sala;
  const via = await lab.intermediario();
  const { placa } = await lab.placaEmOperacao({ sala, via });
  lab.observar("sala", sala);
  const inicio = placa.marca();
  assert.equal((await lab.api("POST", "/comando", { sala, cmd: "ligar" })).status, 200);
  await lab.aguardarConfirmada(sala, { limiteMs: 300_000 });

  const passos = [];
  const recuperar = async (rotulo) => {
    const t0 = await placa.agoraMs();
    await lab.servidor.saudavel();
    await lab.aguardarIntencaoAplicada(sala, true);
    passos.push({ rotulo, reconexaoMsVirtual: Math.round((await placa.agoraMs()) - t0) });
  };

  lab.servidor.servico("restart");
  await recuperar("systemctl restart");

  lab.servidor.servico("kill", "--signal=SIGKILL");
  await placa.aguardarVirtual(2000);
  await recuperar("SIGKILL + Restart=always");

  const antes = via.conexoes.length;
  lab.servidor.proxy("stop");
  const t0 = await placa.agoraMs();
  await placa.aguardarVirtual(60_000);
  const minutos = ((await placa.agoraMs()) - t0) / 60_000;
  const porMinuto = (via.conexoes.length - antes) / minutos;
  passos.push({ rotulo: "nginx fora", tentativasPorMinuto: Math.round(porMinuto * 10) / 10 });
  assert.ok(porMinuto <= 20, `${porMinuto.toFixed(1)} attempts per minute of board time with the proxy down`);
  lab.servidor.proxy("start");
  await recuperar("nginx de volta");

  lab.observar("passos", passos);
  assert.equal(reinicios(placa, inicio), 0, "the board never restarted");
}, { skip: !process.env.LAB_SERVIDOR_BASE && "runs inside the deployment rehearsal (LAB_SERVIDOR_BASE)" });
