#!/usr/bin/env node
// Checks a running RemoteIFES installation from outside, as the deployment rehearsal needs after
// each step (ensaio-implantacao.sh): health (and the commit the process reports), the superadmin
// login, the frontend, data that must persist, and simulated boards that connect, receive a command
// and confirm it, directly or through a reverse proxy.
//
//   node test/support/verificar-implantacao.js --base http://127.0.0.1:8095 --senha <senha>
//        [--commit <sha>] [--marcar | --exigir-marca] [--dispositivos N] [--frontend]
//
// Prints one JSON line with what was checked; exits 1 on the first failure.

const { Bancada } = require("./bancada-dispositivos");

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : padrao;
}
const tem = (nome) => process.argv.includes(`--${nome}`);

const BASE = arg("base");
const SENHA = arg("senha");
const MARCA = "ensaio.implantacao";

async function json(resposta) {
  try {
    return await resposta.json();
  } catch {
    return null;
  }
}

async function principal() {
  if (!BASE || !SENHA) throw new Error("informe --base e --senha");
  const resultado = { base: BASE };

  let saude = null;
  for (let i = 0; i < 60 && !(saude && saude.ok); i += 1) {
    try {
      saude = await json(await fetch(`${BASE}/health`));
    } catch {}
    if (!(saude && saude.ok)) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!saude || saude.ok !== true) throw new Error(`/health não respondeu ok: ${JSON.stringify(saude)}`);
  resultado.saude = { ok: true, commit: saude.commit || null };
  const commit = arg("commit");
  if (commit && saude.commit !== commit) throw new Error(`o processo reporta ${saude.commit}, esperado ${commit}`);

  const login = await fetch(`${BASE}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ usuario: "superadmin", senha: SENHA }) });
  const token = (await json(login))?.token;
  if (!token) throw new Error(`login do superadministrador falhou (${login.status})`);
  resultado.login = true;
  const api = async (metodo, rota, corpo) => {
    const r = await fetch(`${BASE}${rota}`, { method: metodo, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    return { status: r.status, corpo: await json(r) };
  };

  if (tem("frontend")) {
    const pagina = await fetch(`${BASE}/`);
    const html = await pagina.text();
    if (pagina.status !== 200 || !/<html/i.test(html)) throw new Error(`o frontend não foi servido (${pagina.status})`);
    resultado.frontend = true;
  }

  const usuarios = (await api("GET", "/admin/usuarios")).corpo;
  const lista = Array.isArray(usuarios) ? usuarios : (usuarios && usuarios.usuarios) || [];
  const existe = lista.some((u) => u.usuario === MARCA);
  if (tem("marcar") && !existe) {
    const r = await api("POST", "/admin/usuarios", { usuario: MARCA, senha: "senha-do-ensaio-de-implantacao", nome: "Ensaio de implantação", podeControlar: true });
    if (r.status !== 200) throw new Error(`não foi possível criar a marca de persistência (${r.status})`);
    resultado.marca = "criada";
  } else if (tem("exigir-marca")) {
    if (!existe) throw new Error("a marca de persistência não está no banco: os dados não sobreviveram");
    resultado.marca = "presente";
  }

  const n = Number(arg("dispositivos", "0"));
  if (n > 0) {
    const url = new URL(BASE);
    const bancada = new Bancada({ porta: Number(url.port || 80), host: url.hostname });
    try {
      const corpo = (await api("GET", "/salas")).corpo;
      const salas = (Array.isArray(corpo) ? corpo : (corpo && corpo.salas) || []).slice(0, n).map((s) => s.sala);
      let confirmadas = 0;
      for (const sala of salas) {
        let c = await api("POST", `/admin/esp32/${encodeURIComponent(sala)}/credencial`, {});
        if (c.status !== 200) c = await api("POST", `/admin/esp32/${encodeURIComponent(sala)}/credencial/substituir`, {});
        if (c.status !== 200) throw new Error(`credencial de ${sala}: ${c.status}`);
        await api("POST", `/admin/esp32/${encodeURIComponent(sala)}/protocolo-ir`, { protocolo: 16 });
        const placa = bancada.placa({ credencial: { deviceId: c.corpo.deviceId, segredo: c.corpo.segredo }, sala, fw: "4.3.0" });
        await placa.conectar();
        const marca = placa.totalRecebidas;
        const r = await api("POST", "/comando", { sala, cmd: "ligar" });
        if (r.status !== 200) throw new Error(`comando para ${sala}: ${r.status}`);
        await placa.aguardar((m) => m.tipo === "send_known_state" && m.versao === r.corpo.sala.estadoVersao, { desde: marca, limiteMs: 10_000 });
        for (let i = 0; i < 50; i += 1) {
          const e = await api("GET", `/admin/esp32/${encodeURIComponent(sala)}/estado`);
          if (e.corpo && e.corpo.dispositivo.dispositivo.estadoConfirmado === true) {
            confirmadas += 1;
            break;
          }
          await new Promise((res) => setTimeout(res, 100));
        }
      }
      if (confirmadas !== salas.length) throw new Error(`${confirmadas} de ${salas.length} placas confirmaram o comando`);
      resultado.dispositivos = { conectadas: salas.length, confirmadas };
    } finally {
      const restos = await bancada.encerrar();
      if (restos.sockets || restos.timers) throw new Error(`a bancada deixou recursos abertos: ${JSON.stringify(restos)}`);
    }
  }
  return resultado;
}

principal()
  .then((r) => {
    process.stdout.write(`${JSON.stringify(r)}\n`);
  })
  .catch((erro) => {
    process.stderr.write(`verificação falhou: ${erro.message}\n`);
    process.exitCode = 1;
  });
