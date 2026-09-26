// Synthetic command latency through the server's software path, with simulated boards.
//
//   request sent → command enters the server's command path → frame dispatched to the channel →
//   simulated board receives it → board's confirmation reaches the server and is recorded
//
// Direct boards on /ws/dispositivo, and mesh nodes behind simulated gateways (sealed frames through
// the gateway relay). Steady state (one command at a time, round robin), a concurrent burst, and
// (direct) recovery after a drop: from reconnection to the restored state being confirmed.
//
// These are software-path numbers on one host over loopback: no radio, no Wi-Fi, no ESP32. They do
// not predict physical or RF latency. The server runs as an isolated process on a temporary data
// directory; a probe loaded only into that process timestamps the server-side stages.
//
//   node latencia-comandos.js [--dispositivos 1,10,50,100] [--amostras 60] [--rajada 20]
//                             [--transportes direto,malha] [--json resultado.json]

const fs = require("fs");
const os = require("os");
const http = require("http");
const { performance } = require("perf_hooks");
const { iniciarServidorIsolado } = require("./test/support/servidor-isolado");
const { Bancada } = require("./test/support/bancada-dispositivos");

const agora = () => performance.timeOrigin + performance.now();
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
// POST /comando allows 60 commands a minute per user and 1 200 per client address: the benchmark
// spreads commands over several accounts and never exceeds ~1 000 a minute.
const USUARIOS = 20;
const INTERVALO_MINIMO_MS = 60;
const NOS_POR_GATEWAY = 25;

function estatisticas(valores) {
  const v = valores.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const q = (p) => v[Math.min(v.length - 1, Math.ceil((p / 100) * v.length) - 1)];
  const r = (x) => Math.round(x * 100) / 100;
  return { n: v.length, mediana: r(q(50)), p95: r(q(95)), p99: r(q(99)), max: r(v[v.length - 1]), min: r(v[0]) };
}

async function prepararContas(servidor) {
  const tokens = [];
  for (let i = 0; i < USUARIOS; i += 1) {
    const usuario = `latencia.${i}`;
    const senha = `senha-do-ensaio-de-latencia-${i}`;
    const r = await servidor.api("POST", "/admin/usuarios", { usuario, senha, nome: `Latência ${i}`, podeControlar: true, isAdmin: true });
    if (r.status !== 200) throw new Error(`criar ${usuario}: ${r.status} ${JSON.stringify(r.corpo)}`);
    const login = await fetch(`${servidor.base}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ usuario, senha }) });
    const token = (await login.json()).token;
    if (!token) throw new Error(`login de ${usuario}: ${login.status}`);
    tokens.push(token);
  }
  return tokens;
}

async function prepararSalas(servidor, quantidade) {
  const lista = (await servidor.api("GET", "/salas")).corpo;
  let salas = (Array.isArray(lista) ? lista : lista.salas).map((s) => s.sala);
  if (salas.length < quantidade) salas = salas.concat(await servidor.sondar("criar-salas", { quantidade: quantidade - salas.length, prefixo: "LATENCIA" }));
  const preparadas = [];
  for (const sala of salas.slice(0, quantidade)) {
    const c = await servidor.api("POST", `/admin/esp32/${encodeURIComponent(sala)}/credencial`, {});
    if (c.status !== 200) throw new Error(`credencial de ${sala}: ${c.status}`);
    const p = await servidor.api("POST", `/admin/esp32/${encodeURIComponent(sala)}/protocolo-ir`, { protocolo: 16 });
    if (p.status !== 200) throw new Error(`protocolo de ${sala}: ${p.status}`);
    preparadas.push({ sala, credencial: { deviceId: c.corpo.deviceId, segredo: c.corpo.segredo } });
  }
  return preparadas;
}

/** Connects a population and returns, per room, a function that resolves when that room's board receives version v. */
async function montar(servidor, bancada, tipo, salas, salasGateway) {
  const recebido = new Map(); // "sala|versao" -> instant
  const esperas = new Map();
  const marcar = (sala, versao) => {
    const chave = `${sala}|${versao}`;
    const t = agora();
    recebido.set(chave, t);
    for (const f of esperas.get(chave) || []) f(t);
    esperas.delete(chave);
  };
  const quando = (sala, versao, limiteMs = 8000) => {
    const chave = `${sala}|${versao}`;
    if (recebido.has(chave)) return Promise.resolve(recebido.get(chave));
    return new Promise((resolve, reject) => {
      const tempo = setTimeout(() => reject(new Error(`${chave} não chegou à placa`)), limiteMs);
      if (!esperas.has(chave)) esperas.set(chave, []);
      esperas.get(chave).push((t) => {
        clearTimeout(tempo);
        resolve(t);
      });
    });
  };
  const placas = [];
  if (tipo === "direto") {
    for (const s of salas) {
      const placa = bancada.placa({ credencial: s.credencial, sala: s.sala, fw: "4.3.0", reconectar: { atrasoMs: 0 } });
      placa.on("mensagem", (m) => {
        if (m.tipo === "send_known_state" && Number.isInteger(m.versao)) marcar(s.sala, m.versao);
      });
      placas.push(placa);
    }
    await Promise.all(placas.map((p) => p.conectar()));
  } else {
    const grupos = [];
    for (let i = 0; i < salas.length; i += NOS_POR_GATEWAY) grupos.push(salas.slice(i, i + NOS_POR_GATEWAY));
    const gwSalas = salasGateway.slice(0, grupos.length);
    for (let g = 0; g < grupos.length; g += 1) {
      const gateway = bancada.gateway({ credencial: gwSalas[g].credencial, sala: gwSalas[g].sala, fw: "4.3.0" });
      gateway.reanuncio.aposRecusaMs = 500;
      await gateway.conectar();
      const porNo = new Map();
      for (const s of grupos[g]) porNo.set(s.credencial.deviceId, s.sala);
      gateway.on("mensagem-no", (no, payload) => {
        if (payload.tipo === "send_known_state" && Number.isInteger(payload.versao)) marcar(porNo.get(no.deviceId), payload.versao);
      });
      for (const s of grupos[g]) gateway.anunciar(gateway.no({ deviceId: s.credencial.deviceId, segredo: s.credencial.segredo }));
      placas.push(gateway);
    }
  }
  const esperado = tipo === "direto" ? salas.length : salas.length + Math.ceil(salas.length / NOS_POR_GATEWAY);
  const limite = Date.now() + 60_000;
  while ((await servidor.metricas()).dispositivos.sessoes < esperado) {
    if (Date.now() > limite) throw new Error(`${tipo}: nem todos os dispositivos se conectaram`);
    await dormir(100);
  }
  return { placas, quando };
}

// A keep-alive agent, as a browser keeps its connection. The global fetch was measured adding about
// 17 ms per request on the client side on Windows, which would be charged to the server.
const AGENTE = new http.Agent({ keepAlive: true, maxSockets: 64 });

function postar(servidor, token, corpo) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: servidor.porta, path: "/comando", method: "POST", agent: AGENTE, headers: { "content-type": "application/json", authorization: `Bearer ${token}` } },
      (res) => {
        let texto = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (texto += d));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(texto);
          } catch {}
          resolve({ status: res.statusCode, corpo: json });
        });
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(corpo));
  });
}

let alternar = false;
async function medirComando(servidor, token, sala, quando) {
  alternar = !alternar;
  const t0 = agora();
  const resposta = await postar(servidor, token, { sala, cmd: alternar ? "ligar" : "desligar" });
  const tHttp = agora();
  const corpo = resposta.corpo;
  if (resposta.status !== 200) return { falha: `HTTP ${resposta.status}` };
  const versao = corpo.sala.estadoVersao;
  let tRecebido;
  let servidorLado;
  try {
    tRecebido = await quando(sala, versao);
    servidorLado = await servidor.sondar("aguardar-confirmacao", { sala, versao, limiteMs: 8000 });
  } catch (erro) {
    return { tempoEsgotado: erro.message };
  }
  return {
    t0,
    fim: servidorLado.confirmado,
    aceitacao: servidorLado.entrada - t0,
    caminho: servidorLado.despacho - servidorLado.entrada,
    entrega: tRecebido - servidorLado.despacho,
    confirmacao: servidorLado.confirmado - tRecebido,
    total: servidorLado.confirmado - t0,
    http: tHttp - t0,
  };
}

function resumir(amostras) {
  const boas = amostras.filter((a) => a.total !== undefined);
  const etapas = {};
  for (const etapa of ["aceitacao", "caminho", "entrega", "confirmacao", "total", "http"]) etapas[etapa] = estatisticas(boas.map((a) => a[etapa]));
  return {
    amostras: amostras.length,
    falhas: amostras.filter((a) => a.falha).length,
    tempoEsgotado: amostras.filter((a) => a.tempoEsgotado).length,
    etapasMs: etapas,
  };
}

async function executar({ populacoes = [1, 10, 50, 100], amostras = 60, rajada = 20, transportes = ["direto", "malha"], log = () => {} } = {}) {
  const inicio = Date.now();
  const servidor = await iniciarServidorIsolado({ sonda: true });
  const resultado = {
    ambiente: { so: `${os.platform()} ${os.release()}`, node: process.version, cpus: os.cpus().length, cpu: os.cpus()[0] && os.cpus()[0].model },
    configuracao: { populacoes, amostras, rajada, transportes },
    cargas: [],
  };
  try {
    await servidor.sondar("instrumentar-comandos");
    const tokens = await prepararContas(servidor);
    const maior = Math.max(...populacoes);
    const gateways = Math.ceil(maior / NOS_POR_GATEWAY);
    log(`Preparando ${maior + gateways} salas...`);
    const todas = await prepararSalas(servidor, maior + gateways);
    const salasGateway = todas.slice(maior);
    let proximoToken = 0;
    const token = () => tokens[proximoToken++ % tokens.length];

    for (const tipo of transportes) {
      for (const n of populacoes) {
        const bancada = new Bancada({ porta: servidor.porta });
        const salas = todas.slice(0, n);
        const carga = { transporte: tipo, dispositivos: n };
        try {
          const { placas, quando } = await montar(servidor, bancada, tipo, salas, salasGateway);
          // Warm-up, discarded.
          for (let i = 0; i < 3; i += 1) await medirComando(servidor, token(), salas[i % n].sala, quando);
          await servidor.sondar("latencias");

          const estavel = [];
          const inicioEstavel = agora();
          for (let i = 0; i < amostras; i += 1) {
            const antes = agora();
            estavel.push(await medirComando(servidor, token(), salas[i % n].sala, quando));
            const gasto = agora() - antes;
            if (gasto < INTERVALO_MINIMO_MS) await dormir(INTERVALO_MINIMO_MS - gasto);
          }
          carga.estavel = { ...resumir(estavel), duracaoMs: Math.round(agora() - inicioEstavel) };

          // Concurrent burst: one command to each of k rooms at once.
          const k = Math.min(n, rajada);
          await dormir(1000);
          const t0 = agora();
          const lote = await Promise.all(salas.slice(0, k).map((s) => medirComando(servidor, token(), s.sala, quando)));
          const fins = lote.filter((a) => a.fim).map((a) => a.fim);
          carga.rajada = {
            ...resumir(lote),
            concorrencia: k,
            vazaoComandosPorS: fins.length ? Math.round((fins.length / ((Math.max(...fins) - t0) / 1000)) * 10) / 10 : 0,
          };

          // Recovery (direct): boards drop and come back; time from reconnection to the restored
          // desired state being confirmed by the server.
          if (tipo === "direto") {
            const r = Math.min(n, 10);
            const medidas = [];
            await dormir(500);
            await Promise.all(placas.slice(0, r).map(async (placa, i) => {
              const sala = salas[i].sala;
              const aberta = new Promise((resolve) => placa.once("aberta", () => resolve(agora())));
              const restaurada = new Promise((resolve) => {
                const ouvir = (m) => {
                  if (m.tipo === "send_known_state" && m.restauracao === true) {
                    placa.off("mensagem", ouvir);
                    resolve({ t: agora(), versao: m.versao });
                  }
                };
                placa.on("mensagem", ouvir);
              });
              placa.derrubar();
              const tAberta = await aberta;
              const { t: tRestaurada, versao } = await restaurada;
              // The restored version was confirmed before the drop: only a confirmation after the
              // reconnection counts.
              const confirmado = await servidor.sondar("aguardar-confirmacao", { sala, versao, desde: tAberta, limiteMs: 8000 });
              medidas.push({ restauracao: tRestaurada - tAberta, confirmado: confirmado.confirmado - tAberta });
            }));
            carga.recuperacao = {
              placas: r,
              reconexaoAteRestauracaoMs: estatisticas(medidas.map((m) => m.restauracao)),
              reconexaoAteConfirmacaoMs: estatisticas(medidas.map((m) => m.confirmado)),
            };
          }
          await servidor.sondar("latencias");
        } catch (erro) {
          carga.erro = erro.message;
        } finally {
          await bancada.encerrar();
          const limite = Date.now() + 20_000;
          while ((await servidor.metricas()).dispositivos.sessoes > 0 && Date.now() < limite) await dormir(100);
        }
        resultado.cargas.push(carga);
        const e = carga.estavel && carga.estavel.etapasMs.total;
        log(e ? `${tipo.padEnd(6)} ${String(n).padStart(3)} dispositivos: total mediana ${e.mediana} ms, p95 ${e.p95} ms, p99 ${e.p99} ms` : `${tipo} ${n}: ${carga.erro}`);
      }
    }
  } finally {
    await servidor.encerrar().catch(() => {});
  }
  resultado.duracaoS = Math.round((Date.now() - inicio) / 1000);
  resultado.ok = resultado.cargas.every((c) => !c.erro && c.estavel && c.estavel.falhas === 0 && c.estavel.tempoEsgotado === 0);
  return resultado;
}

function tabela(r) {
  const linhas = ["--- Latência sintética de comandos (caminho de software, loopback; não é latência de rádio nem de ESP32) ---"];
  linhas.push(`Ambiente: ${r.ambiente.so}, Node ${r.ambiente.node}, ${r.ambiente.cpus} CPUs (${r.ambiente.cpu}); duração ${r.duracaoS} s`);
  linhas.push("transporte  disp.  fase     n    aceitação  caminho  entrega  confirmação | total mediana  p95     p99     máx     falhas");
  for (const c of r.cargas) {
    if (c.erro) {
      linhas.push(`${c.transporte.padEnd(10)} ${String(c.dispositivos).padStart(5)}  ERRO: ${c.erro}`);
      continue;
    }
    for (const [fase, d] of [["estável", c.estavel], ["rajada", c.rajada]]) {
      const e = d.etapasMs;
      const m = (x) => String(x && x.mediana !== undefined ? x.mediana : "-").padStart(7);
      linhas.push(
        `${c.transporte.padEnd(10)} ${String(c.dispositivos).padStart(5)}  ${fase.padEnd(7)} ${String(e.total.n).padStart(4)} ${m(e.aceitacao)}   ${m(e.caminho)}  ${m(e.entrega)}  ${m(e.confirmacao)}    | ${m(e.total)}  ${String(e.total.p95).padStart(6)}  ${String(e.total.p99).padStart(6)}  ${String(e.total.max).padStart(6)}  ${d.falhas + d.tempoEsgotado}` +
          (fase === "rajada" ? `  (${d.concorrencia} simultâneos, ${d.vazaoComandosPorS} cmd/s)` : "")
      );
    }
    if (c.recuperacao) {
      const rr = c.recuperacao;
      linhas.push(`${"".padEnd(10)} ${"".padStart(5)}  recuperação de ${rr.placas} placas: reconexão→restauração mediana ${rr.reconexaoAteRestauracaoMs.mediana} ms, →confirmação mediana ${rr.reconexaoAteConfirmacaoMs.mediana} ms (máx ${rr.reconexaoAteConfirmacaoMs.max} ms)`);
    }
  }
  linhas.push("Etapas em ms (medianas): aceitação = pedido HTTP até o comando entrar no servidor; caminho = até o quadro ir ao canal; entrega = até a placa simulada recebê-lo; confirmação = até o servidor registrar o relato da placa.");
  return linhas.join("\n");
}

if (require.main === module) {
  const ler = (nome) => {
    const i = process.argv.indexOf(`--${nome}`);
    return i >= 0 ? process.argv[i + 1] : null;
  };
  const opcoes = {};
  if (ler("dispositivos")) opcoes.populacoes = ler("dispositivos").split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 150);
  if (ler("amostras")) opcoes.amostras = Math.max(5, Math.min(2000, Number(ler("amostras"))));
  if (ler("rajada")) opcoes.rajada = Math.max(1, Math.min(50, Number(ler("rajada"))));
  if (ler("transportes")) opcoes.transportes = ler("transportes").split(",").filter((t) => t === "direto" || t === "malha");
  executar({ ...opcoes, log: (l) => console.log(l) })
    .then((r) => {
      console.log(`\n${tabela(r)}`);
      const json = ler("json");
      if (json) {
        fs.writeFileSync(json, `${JSON.stringify(r, null, 2)}\n`);
        console.log(`JSON: ${json}`);
      }
      process.exitCode = r.ok ? 0 : 1;
    })
    .catch((erro) => {
      console.error(`Medição interrompida: ${erro.stack || erro.message}`);
      process.exitCode = 1;
    });
}

module.exports = { executar, estatisticas, tabela };
