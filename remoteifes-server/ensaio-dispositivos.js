// Soak of simulated devices: an isolated server process, simulated boards (direct and behind mesh
// gateways) and repeated controlled cycles of telemetry, commands, drops and reconnection. After
// each cycle, and after teardown, it reads the server's own metrics through a probe loaded into
// that process, and checks that the server returns to its baseline: no session, socket, handshake
// or queued frame left behind, and memory that does not keep growing across cycles.
//
// It looks for unbounded software growth and protocol degradation in the server. It is not an
// ESP32 soak: no board, radio or firmware runs here. It never touches a real database: the server
// runs on a temporary data directory, removed at the end.
//
//   node ensaio-dispositivos.js [--diretas 10] [--gateways 1] [--nos-por-gateway 4] [--ciclos 4]
//                               [--ciclo-s 20] [--telemetria-ms 5000] [--comandos-por-ciclo 10]
//                               [--quedas 0.3] [--json resultado.json]

const fs = require("fs");
const os = require("os");
const { iniciarServidorIsolado } = require("./test/support/servidor-isolado");
const { Bancada } = require("./test/support/bancada-dispositivos");

const PADRAO = { diretas: 10, gateways: 1, nosPorGateway: 4, ciclos: 4, cicloS: 20, telemetriaMs: 5000, comandosPorCiclo: 10, quedas: 0.3, prazoMs: 5000 };
// POST /comando allows 60 commands a minute per user; the soak stays under it.
const INTERVALO_MINIMO_COMANDO_MS = 1100;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function ate(condicao, limiteMs, passoMs = 100) {
  const limite = Date.now() + limiteMs;
  for (;;) {
    const valor = await condicao().catch(() => false);
    if (valor) return valor;
    if (Date.now() > limite) return false;
    await dormir(passoMs);
  }
}

function hexMac(n) {
  return `AA:E5:${[(n >> 16) & 255, (n >> 8) & 255, n & 255, 1].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":")}`;
}

async function prepararSalas(servidor, quantidade) {
  const lista = (await servidor.api("GET", "/salas")).corpo;
  let salas = (Array.isArray(lista) ? lista : lista.salas).map((s) => s.sala);
  if (salas.length < quantidade) salas = salas.concat(await servidor.sondar("criar-salas", { quantidade: quantidade - salas.length }));
  const preparadas = [];
  for (const sala of salas.slice(0, quantidade)) {
    const r = await servidor.api("POST", `/admin/esp32/${encodeURIComponent(sala)}/credencial`, {});
    if (r.status !== 200) throw new Error(`não foi possível provisionar ${sala} (${r.status})`);
    const p = await servidor.api("POST", `/admin/esp32/${encodeURIComponent(sala)}/protocolo-ir`, { protocolo: 16 });
    if (p.status !== 200) throw new Error(`não foi possível definir o protocolo IR de ${sala} (${p.status})`);
    preparadas.push({ sala, credencial: { deviceId: r.corpo.deviceId, segredo: r.corpo.segredo } });
  }
  return preparadas;
}

async function executarEnsaio(entrada = {}, { log = () => {} } = {}) {
  const cfg = { ...PADRAO, ...entrada };
  const inicio = Date.now();
  const servidor = await iniciarServidorIsolado({ sonda: true });
  const bancada = new Bancada({ porta: servidor.porta });
  const contagens = {
    comandos: { solicitados: 0, aceitos: 0, despachados: 0, confirmados: 0, recusados: 0, tempoEsgotado: 0 },
    quedasInjetadas: 0,
    reentradasMalha: 0,
    mudancasDeRota: 0,
  };
  const resultado = { configuracao: cfg, ambiente: { so: `${os.platform()} ${os.release()}`, node: process.version, cpus: os.cpus().length }, contagens, ciclos: [] };

  try {
    resultado.linhaBase = await servidor.metricas({ gc: true, zerarLaco: true });
    const total = cfg.diretas + cfg.gateways * (1 + cfg.nosPorGateway);
    log(`Preparando ${total} salas (credenciais e protocolo IR)...`);
    const salas = await prepararSalas(servidor, total);

    let indice = 0;
    const diretas = salas.slice(0, cfg.diretas).map((s) => ({
      ...s,
      placa: bancada.placa({ credencial: s.credencial, sala: s.sala, mac: hexMac(++indice), telemetriaMs: cfg.telemetriaMs, reconectar: { atrasoMs: 1000 } }),
    }));
    let resto = salas.slice(cfg.diretas);
    const malhas = [];
    for (let g = 0; g < cfg.gateways; g += 1) {
      const [gw, ...nos] = resto.slice(0, 1 + cfg.nosPorGateway);
      resto = resto.slice(1 + cfg.nosPorGateway);
      const gateway = bancada.gateway({ credencial: gw.credencial, sala: gw.sala, mac: hexMac(++indice), telemetriaMs: cfg.telemetriaMs, reconectar: { atrasoMs: 1000 } });
      // More than eight nodes joining at once exceed the pending-handshake bound; like the firmware,
      // a node refused by it tries again (after 1 s here instead of the firmware's 30 s).
      gateway.reanuncio.aposRecusaMs = 1000;
      const refs = nos.map((n) => ({ ...n, gateway, no: gateway.no({ deviceId: n.credencial.deviceId, segredo: n.credencial.segredo }) }));
      // A gateway that comes back announces its nodes again, as the firmware does after a reconnection.
      gateway.on("aberta", () => refs.forEach((r) => gateway.anunciar(r.no)));
      malhas.push({ gw, gateway, refs });
    }
    const nosMalha = malhas.flatMap((m) => m.refs);
    const telemetriaMalha = bancada.intervalo(cfg.telemetriaMs, () => nosMalha.forEach((r) => r.gateway.telemetriaDoNo(r.no)));

    log(`Conectando ${diretas.length} placas diretas, ${malhas.length} gateway(s) e ${nosMalha.length} nós...`);
    await Promise.all([...diretas.map((d) => d.placa.conectar()), ...malhas.map((m) => m.gateway.conectar())]);
    const todasConectadas = () => ate(async () => (await servidor.metricas()).dispositivos.sessoes === total, 30_000);
    if (!(await todasConectadas())) throw new Error("nem todos os dispositivos se conectaram");

    // Commands go through the HTTP API, to rooms of either transport, alternating on and off.
    const alvos = [...diretas.map((d) => ({ sala: d.sala, recebeu: (v) => d.placa.aguardar((m) => m.tipo === "send_known_state" && m.versao === v, { limiteMs: cfg.prazoMs }) })),
      ...nosMalha.map((r) => ({ sala: r.sala, recebeu: (v) => aguardarNo(r, v, cfg.prazoMs) }))];
    let ligar = true;
    let contadorAlvos = 0;
    async function comandar(alvo) {
      contagens.comandos.solicitados += 1;
      const r = await servidor.api("POST", "/comando", { sala: alvo.sala, cmd: ligar ? "ligar" : "desligar" });
      ligar = !ligar;
      if (r.status !== 200) {
        contagens.comandos.recusados += 1;
        return;
      }
      contagens.comandos.aceitos += 1;
      const versao = r.corpo.sala.estadoVersao;
      try {
        await alvo.recebeu(versao);
        contagens.comandos.despachados += 1;
      } catch {
        contagens.comandos.tempoEsgotado += 1;
        return;
      }
      const confirmou = await ate(async () => {
        const e = await servidor.api("GET", `/admin/esp32/${encodeURIComponent(alvo.sala)}/estado`);
        return e.corpo.dispositivo.dispositivo.estadoConfirmado === true;
      }, cfg.prazoMs);
      if (confirmou) contagens.comandos.confirmados += 1;
      else contagens.comandos.tempoEsgotado += 1;
    }

    for (let ciclo = 1; ciclo <= cfg.ciclos; ciclo += 1) {
      const fimCiclo = Date.now() + cfg.cicloS * 1000;
      const intervalo = Math.max(INTERVALO_MINIMO_COMANDO_MS, Math.floor((cfg.cicloS * 1000) / Math.max(1, cfg.comandosPorCiclo)));
      let feitos = 0;
      while (Date.now() < fimCiclo) {
        if (feitos < cfg.comandosPorCiclo && alvos.length) {
          await comandar(alvos[contadorAlvos++ % alvos.length]);
          feitos += 1;
        }
        await dormir(Math.min(intervalo, Math.max(0, fimCiclo - Date.now())));
      }

      // Churn: direct boards lose their connection abruptly and come back by themselves; a node
      // leaves the mesh and joins again; another changes route. Chosen by rotation, not at random,
      // so two runs with the same configuration inject the same faults.
      const n = Math.round(diretas.length * cfg.quedas);
      const quedas = Array.from({ length: n }, (_, j) => diretas[(ciclo * n + j) % diretas.length]);
      quedas.forEach((d) => d.placa.derrubar());
      contagens.quedasInjetadas += quedas.length;
      const saiu = nosMalha[ciclo % Math.max(1, nosMalha.length)];
      if (saiu) {
        saiu.gateway.anunciar(saiu.no, "saiu");
        await dormir(200);
        saiu.gateway.anunciar(saiu.no);
        contagens.reentradasMalha += 1;
      }
      const moveu = nosMalha[(ciclo + 1) % Math.max(1, nosMalha.length)];
      if (moveu && moveu.no.sessao) {
        moveu.no.rota = { pai: ciclo % 2 ? "esp_00000000000000aa" : "gateway", saltos: 1 + (ciclo % 2), rssi: -60 - ciclo };
        moveu.gateway.telemetriaDoNo(moveu.no);
        contagens.mudancasDeRota += 1;
      }
      const reconectou = await todasConectadas();
      const metricas = await servidor.metricas({ gc: true, zerarLaco: true });
      resultado.ciclos.push({ ciclo, reconectou: !!reconectou, metricas });
      log(
        `Ciclo ${ciclo}/${cfg.ciclos}: ${metricas.dispositivos.sessoes}/${total} sessões, ` +
          `heap ${metricas.memoria.heapUsadoMB} MB, RSS ${metricas.memoria.rssMB} MB, laço p99 ${metricas.laco.p99Ms} ms`
      );
    }

    // Teardown and return to baseline.
    bancada.cancelar(telemetriaMalha);
    const restos = await bancada.encerrar();
    resultado.bancadaAoEncerrar = restos;
    const base = resultado.linhaBase;
    const voltou = await ate(async () => {
      const m = await servidor.metricas();
      return m.dispositivos.sessoes === 0 && m.malha.handshakesPendentes === 0 && m.malha.filaPendente === 0 && (m.recursos.TCPSocketWrap || 0) <= (base.recursos.TCPSocketWrap || 0);
    }, 20_000, 250);
    resultado.final = await servidor.metricas({ gc: true, zerarLaco: true });
    resultado.invariantes = avaliar(resultado, { voltou: !!voltou, restos });
  } finally {
    await bancada.encerrar().catch(() => {});
    await servidor.encerrar().catch(() => {});
  }
  resultado.duracaoS = Math.round((Date.now() - inicio) / 1000);
  resultado.ok = !!resultado.invariantes && resultado.invariantes.every((i) => i.ok);
  return resultado;
}

// Waits for a mesh node to receive a desired state of version `versao`.
function aguardarNo(ref, versao, limiteMs) {
  const achou = () => ref.no.recebidos.some((m) => m.tipo === "send_known_state" && m.versao === versao);
  if (achou()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const ouvir = () => {
      if (!achou()) return;
      clearTimeout(tempo);
      ref.gateway.off("mensagens-no", ouvir);
      resolve();
    };
    const tempo = setTimeout(() => {
      ref.gateway.off("mensagens-no", ouvir);
      reject(new Error("tempo esgotado"));
    }, limiteMs);
    ref.gateway.on("mensagens-no", ouvir);
  });
}

function avaliar(r, { voltou, restos }) {
  const { comandos } = r.contagens;
  const heap = r.ciclos.map((c) => c.metricas.memoria.heapUsadoMB);
  const crescimento = heap.length > 1 ? Math.round((heap[heap.length - 1] - heap[0]) * 10) / 10 : 0;
  const sempreSubiu = heap.length > 2 && heap.every((h, i) => i === 0 || h > heap[i - 1]);
  // Generous on purpose: garbage collection and JIT make a few MB of noise on any runner. What this
  // catches is memory that keeps climbing cycle after cycle.
  const tolerancia = Math.max(5, heap[0] * 0.15);
  const f = r.final;
  const base = r.linhaBase;
  return [
    { nome: "todos os dispositivos reconectaram após cada ciclo", ok: r.ciclos.every((c) => c.reconectou) },
    { nome: "todo comando aceito chegou à placa e foi confirmado", ok: comandos.aceitos === comandos.confirmados && comandos.aceitos > 0, detalhe: comandos },
    { nome: "nenhuma sessão de dispositivo após o encerramento", ok: voltou && f.dispositivos.sessoes === 0, detalhe: f.dispositivos },
    { nome: "nenhum handshake nem quadro de malha pendente", ok: f.malha.handshakesPendentes === 0 && f.malha.filaPendente === 0, detalhe: f.malha },
    { nome: "nós observados dentro do limite da topologia", ok: f.malha.nosObservados <= f.malha.limiteObservados, detalhe: f.malha.nosObservados },
    { nome: "sockets TCP do servidor de volta à linha de base", ok: (f.recursos.TCPSocketWrap || 0) <= (base.recursos.TCPSocketWrap || 0), detalhe: { base: base.recursos.TCPSocketWrap || 0, final: f.recursos.TCPSocketWrap || 0 } },
    { nome: "nenhuma atualização OTA ativa", ok: f.ota.ativas === 0 },
    { nome: "a bancada não deixou sockets, timers nem esperas", ok: restos.sockets + restos.timers + restos.esperas === 0, detalhe: restos },
    { nome: "heap sem crescimento contínuo entre ciclos", ok: !(sempreSubiu && crescimento > tolerancia), detalhe: { heapPorCicloMB: heap, crescimentoMB: crescimento, toleranciaMB: Math.round(tolerancia * 10) / 10 } },
  ];
}

function resumo(r) {
  const linhas = [];
  const c = r.configuracao;
  const f = r.final || {};
  linhas.push("--- Ensaio de dispositivos simulados (servidor e protocolo; não é ensaio de hardware ESP32) ---");
  linhas.push(`Ambiente.............. ${r.ambiente.so}, Node ${r.ambiente.node}, ${r.ambiente.cpus} CPUs`);
  linhas.push(`Dispositivos.......... ${c.diretas} diretos, ${c.gateways} gateway(s) x ${c.nosPorGateway} nós`);
  linhas.push(`Ciclos................ ${c.ciclos} x ${c.cicloS} s, telemetria a cada ${c.telemetriaMs} ms, duração ${r.duracaoS} s`);
  const k = r.contagens.comandos;
  linhas.push(`Comandos.............. ${k.solicitados} solicitados, ${k.aceitos} aceitos, ${k.despachados} entregues, ${k.confirmados} confirmados, ${k.tempoEsgotado} sem resposta`);
  linhas.push(`Falhas injetadas...... ${r.contagens.quedasInjetadas} quedas, ${r.contagens.reentradasMalha} reentradas na malha, ${r.contagens.mudancasDeRota} mudanças de rota`);
  if (r.linhaBase && f.memoria) {
    linhas.push(`Memória (após GC)..... heap ${r.linhaBase.memoria.heapUsadoMB} → ${r.ciclos.map((x) => x.metricas.memoria.heapUsadoMB).join(" → ")} → ${f.memoria.heapUsadoMB} MB`);
    linhas.push(`RSS................... ${r.linhaBase.memoria.rssMB} → ${Math.max(...r.ciclos.map((x) => x.metricas.memoria.rssMB))} (máx.) → ${f.memoria.rssMB} MB`);
    linhas.push(`Laço de eventos p99... máx. ${Math.max(...r.ciclos.map((x) => x.metricas.laco.p99Ms))} ms entre ciclos`);
    linhas.push(`Banco................. ${r.linhaBase.banco.arquivoMB} → ${f.banco.arquivoMB} MB (+WAL ${f.banco.walMB} MB); linhas ${JSON.stringify(diferenca(r.linhaBase.banco.linhas, f.banco.linhas))}`);
  }
  for (const i of r.invariantes || []) linhas.push(`${i.ok ? "ok " : "FALHOU"} ${i.nome}`);
  linhas.push(r.ok ? "Resultado: nenhum crescimento sem limite nem estado residual detectado." : "Resultado: FALHOU");
  return linhas.join("\n");
}

function diferenca(antes, depois) {
  const saida = {};
  for (const [t, n] of Object.entries(depois || {})) if (n !== null && antes && antes[t] !== null) saida[t] = `+${n - antes[t]}`;
  return saida;
}

function argumentos(argv) {
  const ler = (nome, padrao, min, max) => {
    const i = argv.indexOf(`--${nome}`);
    if (i < 0) return padrao;
    const n = Number(argv[i + 1]);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${nome} deve estar entre ${min} e ${max}`);
    return n;
  };
  const i = argv.indexOf("--json");
  return {
    diretas: ler("diretas", PADRAO.diretas, 0, 150),
    gateways: ler("gateways", PADRAO.gateways, 0, 10),
    nosPorGateway: ler("nos-por-gateway", PADRAO.nosPorGateway, 0, 32),
    ciclos: ler("ciclos", PADRAO.ciclos, 1, 1000),
    cicloS: ler("ciclo-s", PADRAO.cicloS, 2, 3600),
    telemetriaMs: ler("telemetria-ms", PADRAO.telemetriaMs, 200, 600_000),
    comandosPorCiclo: ler("comandos-por-ciclo", PADRAO.comandosPorCiclo, 0, 1000),
    quedas: ler("quedas", PADRAO.quedas, 0, 1),
    json: i >= 0 ? argv[i + 1] : null,
  };
}

if (require.main === module) {
  let cfg;
  try {
    cfg = argumentos(process.argv.slice(2));
  } catch (erro) {
    console.error(erro.message);
    process.exit(2);
  }
  const { json, ...opcoes } = cfg;
  executarEnsaio(opcoes, { log: (l) => console.log(l) })
    .then((r) => {
      console.log(`\n${resumo(r)}`);
      if (json) {
        fs.writeFileSync(json, `${JSON.stringify(r, null, 2)}\n`);
        console.log(`JSON: ${json}`);
      }
      process.exitCode = r.ok ? 0 : 1;
    })
    .catch((erro) => {
      console.error(`Ensaio interrompido: ${erro.stack || erro.message}`);
      process.exitCode = 1;
    });
}

module.exports = { executarEnsaio, resumo, PADRAO };
