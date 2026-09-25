const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ajuda = require("./helpers");

// Complete flow of a managed operation through the API, and the Console's isolation guarantees with
// respect to the project's public surfaces.

function checkoutMinimo() {
  const raiz = ajuda.dirTemporario("console-int-");
  fs.mkdirSync(path.join(raiz, "remoteifes-server", "data", "backups"), { recursive: true });
  fs.writeFileSync(path.join(raiz, "remoteifes-server", "package.json"), JSON.stringify({ version: "3.0.0" }));
  fs.writeFileSync(path.join(raiz, "remoteifes-server", ".env"), "PORTA=8188\n");
  return raiz;
}

test("preparing an action returns purpose, impact and readiness without running anything", async (t) => {
  const checkout = checkoutMinimo();
  const amb = ajuda.ambiente({ checkout });
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const sessao = await ajuda.autenticar(amb, s.porta);
  const r = await ajuda.pedir(s.porta, "/api/acoes/servico.reiniciar/preparar", {
    metodo: "POST",
    corpo: { argumentos: {} },
    cookie: sessao.cookie,
    csrf: sessao.csrf,
    origem: s.base,
  });

  assert.equal(r.status, 200);
  assert.ok(r.json.acao.proposito);
  assert.match(r.json.acao.impacto, /sess/i, "the impact must mention user sessions");
  assert.equal(r.json.acao.exigeElevacao, true);
  assert.ok(r.json.prontidao, "readiness is evaluated before confirmation");
  assert.equal(Array.isArray(r.json.prontidao.bloqueios), true);
  assert.equal(r.json.elevada, false);
  assert.equal(amb.execucao.trabalhoAtivo(), null, "preparing must not start anything");
});

test("an action with textual confirmation refuses the wrong word", async (t) => {
  const checkout = checkoutMinimo();
  const amb = ajuda.ambiente({ checkout });
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const sessao = await ajuda.autenticar(amb, s.porta);
  await ajuda.elevar(amb, s.porta, sessao);

  const errada = await ajuda.pedir(s.porta, "/api/acoes/servico.parar/executar", {
    metodo: "POST",
    corpo: { argumentos: {}, confirmacao: "sim" },
    cookie: sessao.cookie,
    csrf: sessao.csrf,
    origem: s.base,
  });
  assert.equal(errada.status, 400);
  assert.match(errada.json.erro, /digite "parar"/);
  assert.equal(amb.execucao.trabalhoAtivo(), null);
});

test("complete flow: elevate, run, follow the output and read the outcome", async (t) => {
  const checkout = checkoutMinimo();
  const amb = ajuda.ambiente({ checkout });
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const sessao = await ajuda.autenticar(amb, s.porta);

  // The immediate read action does not require elevation.
  const saude = await ajuda.pedir(s.porta, "/api/acoes/saude.verificar/executar", {
    metodo: "POST",
    corpo: { argumentos: {} },
    cookie: sessao.cookie,
    csrf: sessao.csrf,
    origem: s.base,
  });
  assert.equal(saude.status, 202);
  assert.equal(saude.json.imediata, true);
  assert.equal(saude.json.resultado.saude.respondeu, false, "without the application running, /health does not answer");

  // A real job: a backup without a database fails with a useful message, and the engine's full
  // cycle (record, output to file, outcome) is exercised through the API.
  const elev = await ajuda.elevar(amb, s.porta, sessao);
  assert.equal(elev.status, 200);

  const exec = await ajuda.pedir(s.porta, "/api/acoes/backup.criar/executar", {
    metodo: "POST",
    corpo: { argumentos: { rotulo: "teste" }, aceitarAvisos: true },
    cookie: sessao.cookie,
    csrf: sessao.csrf,
    origem: s.base,
  });
  assert.equal(exec.status, 202);
  const id = exec.json.trabalho.id;
  assert.ok(id);

  let estadoFinal = null;
  for (let i = 0; i < 100; i += 1) {
    const r = await ajuda.pedir(s.porta, `/api/trabalhos/${id}`, { cookie: sessao.cookie, origem: s.base });
    if (r.json.estado !== "executando") {
      estadoFinal = r.json;
      break;
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.ok(estadoFinal, "the job must finish");
  assert.equal(estadoFinal.estado, "falhou", "without a database, the backup fails and says why");

  const saida = await ajuda.pedir(s.porta, `/api/trabalhos/${id}/saida`, { cookie: sessao.cookie, origem: s.base });
  assert.equal(saida.status, 200);
  assert.match(saida.json.texto, /Banco não encontrado/);

  const lista = await ajuda.pedir(s.porta, "/api/trabalhos", { cookie: sessao.cookie, origem: s.base });
  assert.equal(lista.json.trabalhos[0].id, id);
});

test("a job's output is readable by offset, to resume after a disconnect", async (t) => {
  const checkout = checkoutMinimo();
  const amb = ajuda.ambiente({ checkout });
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const sessao = await ajuda.autenticar(amb, s.porta);
  const trabalho = amb.execucao.iniciar({
    acao: "teste.saida",
    rotulo: "Saída em partes",
    operador: sessao.nome,
    executavel: process.execPath,
    argumentos: ["-e", "console.log('PARTE-UM'); console.log('PARTE-DOIS');"],
    cwd: checkout,
    exigeTrava: false,
  });

  for (let i = 0; i < 60; i += 1) {
    if (amb.execucao.obter(trabalho.id).estado !== "executando") break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const tudo = await ajuda.pedir(s.porta, `/api/trabalhos/${trabalho.id}/saida`, { cookie: sessao.cookie, origem: s.base });
  assert.match(tudo.json.texto, /PARTE-UM/);
  assert.match(tudo.json.texto, /PARTE-DOIS/);

  const posicao = tudo.json.texto.indexOf("PARTE-DOIS");
  const parcial = await ajuda.pedir(s.porta, `/api/trabalhos/${trabalho.id}/saida?desde=${posicao}`, { cookie: sessao.cookie, origem: s.base });
  assert.ok(!parcial.json.texto.includes("PARTE-UM"), "reading by offset does not repeat what was already read");
  assert.match(parcial.json.texto, /PARTE-DOIS/);
});

test("an unknown action or one with an extra argument is refused", async (t) => {
  const checkout = checkoutMinimo();
  const amb = ajuda.ambiente({ checkout });
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
    fs.rmSync(checkout, { recursive: true, force: true });
  });

  const sessao = await ajuda.autenticar(amb, s.porta);

  const inexistente = await ajuda.pedir(s.porta, "/api/acoes/nao.existe/executar", {
    metodo: "POST",
    corpo: { argumentos: {} },
    cookie: sessao.cookie,
    csrf: sessao.csrf,
    origem: s.base,
  });
  assert.equal(inexistente.status, 404);

  const extra = await ajuda.pedir(s.porta, "/api/acoes/backup.criar/preparar", {
    metodo: "POST",
    corpo: { argumentos: { rotulo: "ok", comando: "rm -rf /" } },
    cookie: sessao.cookie,
    csrf: sessao.csrf,
    origem: s.base,
  });
  assert.equal(extra.status, 400);
  assert.match(extra.json.erro, /não reconhecido/);
});

// --- Console isolation from public surfaces ------------------------------------

test("the Console is not published by GitHub Pages and does not enter the Cordova package", () => {
  const raiz = path.join(ajuda.RAIZ, "..");

  const pages = fs.readFileSync(path.join(raiz, ".github", "workflows", "pages.yml"), "utf8");
  assert.match(pages, /path:\s*remoteifes-web/, "o Pages publica apenas o frontend");
  assert.ok(!pages.includes("remoteifes-console"), "the Console must not enter the Pages artifact");

  const sync = fs.readFileSync(path.join(raiz, "remoteifes-cordova", "sync-www.js"), "utf8");
  assert.match(sync, /remoteifes-web/, "o Cordova empacota apenas o frontend");
  assert.ok(!sync.includes("remoteifes-console"), "the Console must not enter the Cordova www");

  // The application serves the frontend from remoteifes-web; the Console stays outside that root.
  const app = fs.readFileSync(path.join(raiz, "remoteifes-server", "src", "app.js"), "utf8");
  assert.match(app, /"remoteifes-web"/);
  assert.ok(!app.includes("remoteifes-console"), "the application server does not serve Console files");
});

test("the Console has no npm dependencies", () => {
  const pacote = JSON.parse(fs.readFileSync(path.join(ajuda.RAIZ, "package.json"), "utf8"));
  assert.equal(pacote.dependencies, undefined, "the Console must not declare runtime dependencies");
  assert.equal(pacote.devDependencies, undefined, "nor development dependencies");
  assert.match(pacote.engines.node, /22/);
});

test("no Console source file contains a NUL byte", () => {
  // A stray NUL makes Git treat the file as binary: the diff stops being reviewable.
  const ignorar = new Set(["node_modules", ".git"]);
  const varrer = (dir) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignorar.has(entrada.name)) continue;
      const completo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) {
        varrer(completo);
        continue;
      }
      if (!/\.(js|json|md|sh|ps1|css|html|modelo|socket|plist|yml)$/.test(entrada.name)) continue;
      const bytes = fs.readFileSync(completo);
      assert.equal(bytes.indexOf(0), -1, `byte nulo em ${path.relative(ajuda.RAIZ, completo)}`);
    }
  };
  varrer(ajuda.RAIZ);
});

test("no secret is committed in the Console directory", () => {
  // The patterns describe **real** secrets, not anything similar. A real scrypt hash has an N of
  // four or more digits and long base64 salt/key; `scrypt$1$1$1$a$b` is a test fixture and nobody's
  // credential. Loosening here would lose protection; being specific keeps it without false alarms.
  const proibidos = [
    /-----BEGIN [A-Z ]*PRIVATE KEY/,
    /gh[pousr]_[A-Za-z0-9]{30,}/,
    /scrypt\$\d{4,}\$\d+\$\d+\$[A-Za-z0-9+/=]{20,}\$[A-Za-z0-9+/=]{20,}/,
    /AKIA[0-9A-Z]{16}/,
  ];
  const ignorar = new Set(["node_modules", ".git"]);

  function varrer(dir) {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignorar.has(entrada.name)) continue;
      const completo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) {
        varrer(completo);
        continue;
      }
      if (!/\.(js|json|md|sh|ps1|css|html|modelo|socket|plist|yml)$/.test(entrada.name)) continue;
      const texto = fs.readFileSync(completo, "utf8");
      for (const padrao of proibidos) {
        // The security test uses synthetic tokens on purpose; they are recognizable.
        const achado = padrao.exec(texto);
        if (achado && !/tokenfalso|umtokenfalso|teste/i.test(achado[0])) {
          assert.fail(`possible secret in ${path.relative(ajuda.RAIZ, completo)}: ${achado[0].slice(0, 20)}…`);
        }
      }
    }
  }
  varrer(ajuda.RAIZ);
});
