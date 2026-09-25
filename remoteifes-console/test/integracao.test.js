const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ajuda = require("./ajuda");

// Complete flow of a managed operation through the API, and the Console's isolation guarantees with
// respect to the project's public surfaces.

function checkoutMinimo() {
  const raiz = ajuda.dirTemporario("console-int-");
  fs.mkdirSync(path.join(raiz, "remoteifes-server", "data", "backups"), { recursive: true });
  fs.writeFileSync(path.join(raiz, "remoteifes-server", "package.json"), JSON.stringify({ version: "3.0.0" }));
  fs.writeFileSync(path.join(raiz, "remoteifes-server", ".env"), "PORTA=8188\n");
  return raiz;
}

test("preparar uma ação devolve propósito, impacto e prontidão sem executar nada", async (t) => {
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
  assert.match(r.json.acao.impacto, /sess/i, "o impacto precisa falar das sessões de usuário");
  assert.equal(r.json.acao.exigeElevacao, true);
  assert.ok(r.json.prontidao, "a prontidão é avaliada antes de confirmar");
  assert.equal(Array.isArray(r.json.prontidao.bloqueios), true);
  assert.equal(r.json.elevada, false);
  assert.equal(amb.execucao.trabalhoAtivo(), null, "preparar não pode iniciar nada");
});

test("uma ação com confirmação textual recusa a palavra errada", async (t) => {
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

test("fluxo completo: elevar, executar, acompanhar a saída e ler o desfecho", async (t) => {
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
  assert.equal(saude.json.resultado.saude.respondeu, false, "sem aplicação no ar, o /health não responde");

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
  assert.ok(estadoFinal, "o trabalho precisa terminar");
  assert.equal(estadoFinal.estado, "falhou", "sem banco, o backup falha — e diz por quê");

  const saida = await ajuda.pedir(s.porta, `/api/trabalhos/${id}/saida`, { cookie: sessao.cookie, origem: s.base });
  assert.equal(saida.status, 200);
  assert.match(saida.json.texto, /Banco não encontrado/);

  const lista = await ajuda.pedir(s.porta, "/api/trabalhos", { cookie: sessao.cookie, origem: s.base });
  assert.equal(lista.json.trabalhos[0].id, id);
});

test("a saída de um trabalho é legível por posição, para retomar depois de uma desconexão", async (t) => {
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
  assert.ok(!parcial.json.texto.includes("PARTE-UM"), "a leitura por posição não repete o que já foi lido");
  assert.match(parcial.json.texto, /PARTE-DOIS/);
});

test("uma ação desconhecida ou com argumento a mais é recusada", async (t) => {
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

test("o console não é publicado pelo GitHub Pages nem entra no pacote Cordova", () => {
  const raiz = path.join(ajuda.RAIZ, "..");

  const pages = fs.readFileSync(path.join(raiz, ".github", "workflows", "pages.yml"), "utf8");
  assert.match(pages, /path:\s*remoteifes-web/, "o Pages publica apenas o frontend");
  assert.ok(!pages.includes("remoteifes-console"), "o console não pode entrar no artefato do Pages");

  const sync = fs.readFileSync(path.join(raiz, "remoteifes-cordova", "sync-www.js"), "utf8");
  assert.match(sync, /remoteifes-web/, "o Cordova empacota apenas o frontend");
  assert.ok(!sync.includes("remoteifes-console"), "o console não pode entrar no www do Cordova");

  // The application serves the frontend from remoteifes-web; the Console stays outside that root.
  const app = fs.readFileSync(path.join(raiz, "remoteifes-server", "src", "app.js"), "utf8");
  assert.match(app, /"remoteifes-web"/);
  assert.ok(!app.includes("remoteifes-console"), "o servidor da aplicação não serve arquivos do console");
});

test("o console não tem dependências npm", () => {
  const pacote = JSON.parse(fs.readFileSync(path.join(ajuda.RAIZ, "package.json"), "utf8"));
  assert.equal(pacote.dependencies, undefined, "o console não deve declarar dependências de runtime");
  assert.equal(pacote.devDependencies, undefined, "nem dependências de desenvolvimento");
  assert.match(pacote.engines.node, /22/);
});

test("nenhum arquivo de código do console contém byte nulo", () => {
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

test("nenhum segredo fica versionado no diretório do console", () => {
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
          assert.fail(`possível segredo em ${path.relative(ajuda.RAIZ, completo)}: ${achado[0].slice(0, 20)}…`);
        }
      }
    }
  }
  varrer(ajuda.RAIZ);
});
