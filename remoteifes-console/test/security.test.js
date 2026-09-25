const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ajuda = require("./helpers");

// Authentication, authorization, elevation and the Console's transport defenses.

test("the password is stored with scrypt and checked in constant time", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const hash = amb.auth.hashDeSenha("uma-senha-longa-o-bastante");
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(!hash.includes("uma-senha-longa"), "the hash must not contain the password");
  assert.equal(amb.auth.conferirSenha("uma-senha-longa-o-bastante", hash), true);
  assert.equal(amb.auth.conferirSenha("outra-coisa-qualquer-aqui", hash), false);
  assert.equal(amb.auth.conferirSenha("", hash), false);
  assert.equal(amb.auth.conferirSenha("x", "lixo"), false);
});

test("the application's known default passwords are refused as Console credentials", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  for (const proibida of ["admin", "superadmin", "SuperAdmin", "senha", "password"]) {
    assert.ok(amb.auth.validarForcaDaSenha(proibida), `should refuse "${proibida}"`);
  }
  assert.ok(amb.auth.validarForcaDaSenha("curta"), "a short password must be refused");
  assert.equal(amb.auth.validarForcaDaSenha("uma-senha-aceitavel-123"), null);
});

test("the operators file lives outside the checkout and without the plaintext password", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  amb.auth.criarOperador("operador", "senha-de-teste-12345");
  const arquivo = path.join(amb.estadoDir, "operadores.json");
  assert.ok(fs.existsSync(arquivo));
  const conteudo = fs.readFileSync(arquivo, "utf8");
  assert.ok(!conteudo.includes("senha-de-teste-12345"), "the plaintext password must not go to disk");
  assert.ok(!path.resolve(arquivo).startsWith(path.resolve(amb.checkout, "remoteifes-console")));
});

test("a session expires on idle and at the absolute deadline", (t) => {
  const amb = ajuda.ambiente({ sessaoOciosaS: 60, sessaoMaxS: 300 });
  t.after(() => amb.restaurar());

  amb.auth.criarOperador("operador", "senha-de-teste-12345");
  const { token } = amb.auth.criarSessao("operador");
  assert.ok(amb.auth.validarSessao(token));

  // Ages the session on disk beyond the idle limit.
  const arquivo = path.join(amb.estadoDir, "sessoes.json");
  const dados = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  const id = Object.keys(dados.sessoes)[0];
  dados.sessoes[id].vistaEm = Date.now() - 61_000;
  fs.writeFileSync(arquivo, JSON.stringify(dados));
  amb.auth.limparTudoParaTeste();
  assert.equal(amb.auth.validarSessao(token), null, "an idle session must be invalidated");

  const { token: t2 } = amb.auth.criarSessao("operador");
  const dados2 = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  for (const chave of Object.keys(dados2.sessoes)) dados2.sessoes[chave].expiraEm = Date.now() - 1000;
  fs.writeFileSync(arquivo, JSON.stringify(dados2));
  amb.auth.limparTudoParaTeste();
  assert.equal(amb.auth.validarSessao(t2), null, "an expired session must be invalidated");
});

test("changing the password revokes the operator's other sessions", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  amb.auth.criarOperador("operador", "senha-de-teste-12345");
  const a = amb.auth.criarSessao("operador");
  const b = amb.auth.criarSessao("operador");
  assert.ok(amb.auth.validarSessao(a.token) && amb.auth.validarSessao(b.token));

  amb.auth.trocarSenha("operador", "senha-de-teste-12345", "outra-senha-boa-123456");
  assert.equal(amb.auth.validarSessao(a.token), null);
  assert.equal(amb.auth.validarSessao(b.token), null);
  assert.ok(amb.auth.autenticar("operador", "outra-senha-boa-123456"));
  assert.equal(amb.auth.autenticar("operador", "senha-de-teste-12345"), null);
});

test("elevation expires by itself and is revoked on logout", (t) => {
  const amb = ajuda.ambiente({ elevacaoS: 60 });
  t.after(() => amb.restaurar());

  amb.auth.criarOperador("operador", "senha-de-teste-12345");
  const { token } = amb.auth.criarSessao("operador");
  assert.equal(amb.auth.validarSessao(token).elevada, false);

  assert.equal(amb.auth.elevar(token, "errada").ok, false);
  assert.equal(amb.auth.elevar(token, "senha-de-teste-12345").ok, true);
  assert.equal(amb.auth.validarSessao(token).elevada, true);

  amb.auth.encerrarElevacao(token);
  assert.equal(amb.auth.validarSessao(token).elevada, false);

  amb.auth.elevar(token, "senha-de-teste-12345");
  const arquivo = path.join(amb.estadoDir, "sessoes.json");
  const dados = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  for (const chave of Object.keys(dados.sessoes)) dados.sessoes[chave].elevadaAte = Date.now() - 1;
  fs.writeFileSync(arquivo, JSON.stringify(dados));
  assert.equal(amb.auth.validarSessao(token).elevada, false, "expired elevation is no longer valid");
});

test("repeated login attempts are limited per operator", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const chave = "login:alvo";
  assert.equal(amb.auth.bloqueado(chave), 0);
  for (let i = 0; i < 8; i += 1) amb.auth.registrarFalha(chave);
  assert.ok(amb.auth.bloqueado(chave) > 0, "must block after the attempts");
  amb.auth.limparTentativas(chave);
  assert.equal(amb.auth.bloqueado(chave), 0);
});

// --- Transport ---------------------------------------------------------------------------

test("an unexpected Host is refused with 421 (DNS rebinding defense)", async (t) => {
  const amb = ajuda.ambiente();
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });

  const r = await ajuda.pedir(s.porta, "/api/sessao", { host: "console.evil.example" });
  assert.equal(r.status, 421);
  const ok = await ajuda.pedir(s.porta, "/api/sessao", { host: `127.0.0.1:${s.porta}` });
  assert.equal(ok.status, 200);
});

test("a cross-origin Origin is refused even with a valid session", async (t) => {
  const amb = ajuda.ambiente();
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });

  const sessao = await ajuda.autenticar(amb, s.porta);
  const r = await ajuda.pedir(s.porta, "/api/painel", {
    cookie: sessao.cookie,
    origem: "http://evil.example",
  });
  assert.equal(r.status, 403);
  assert.match(r.json.erro, /origem/i);
});

test("a mutating method without the CSRF header is refused", async (t) => {
  const amb = ajuda.ambiente();
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });

  const sessao = await ajuda.autenticar(amb, s.porta);

  const semCsrf = await ajuda.pedir(s.porta, "/api/sessao", { metodo: "DELETE", cookie: sessao.cookie, origem: s.base });
  assert.equal(semCsrf.status, 403);

  const csrfErrado = await ajuda.pedir(s.porta, "/api/sessao", {
    metodo: "DELETE",
    cookie: sessao.cookie,
    csrf: "valor-invalido",
    origem: s.base,
  });
  assert.equal(csrfErrado.status, 403);

  const certo = await ajuda.pedir(s.porta, "/api/sessao", {
    metodo: "DELETE",
    cookie: sessao.cookie,
    csrf: sessao.csrf,
    origem: s.base,
  });
  assert.equal(certo.status, 200);
});

test("the session cookie is HttpOnly, SameSite=Strict and cleared on logout", async (t) => {
  const amb = ajuda.ambiente();
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });

  const sessao = await ajuda.autenticar(amb, s.porta);
  const bruto = sessao.resposta.cabecalhos["set-cookie"][0];
  assert.match(bruto, /HttpOnly/);
  assert.match(bruto, /SameSite=Strict/);
  assert.match(bruto, /Path=\//);

  const saida = await ajuda.pedir(s.porta, "/api/sessao", {
    metodo: "DELETE",
    cookie: sessao.cookie,
    csrf: sessao.csrf,
    origem: s.base,
  });
  assert.match(saida.cabecalhos["set-cookie"][0], /Max-Age=0/);
  assert.ok(saida.cabecalhos["clear-site-data"], "logout must ask to clear the origin's storage");

  const depois = await ajuda.pedir(s.porta, "/api/painel", { cookie: sessao.cookie, origem: s.base });
  assert.equal(depois.status, 401, "the revoked cookie must no longer be valid");
});

test("an unexpected content-type in a POST is refused", async (t) => {
  const amb = ajuda.ambiente();
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });

  const sessao = await ajuda.autenticar(amb, s.porta);
  const r = await ajuda.pedir(s.porta, "/api/sessao/elevar", {
    metodo: "POST",
    corpo: { senha: sessao.senha },
    cookie: sessao.cookie,
    csrf: sessao.csrf,
    origem: s.base,
    cabecalhos: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  assert.equal(r.status, 415);
});

test("security headers accompany every response", async (t) => {
  const amb = ajuda.ambiente();
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });

  const r = await ajuda.pedir(s.porta, "/api/sessao");
  assert.match(r.cabecalhos["content-security-policy"], /frame-ancestors 'none'/);
  assert.match(r.cabecalhos["content-security-policy"], /form-action 'none'/);
  assert.match(r.cabecalhos["content-security-policy"], /default-src 'none'/);
  assert.equal(r.cabecalhos["x-frame-options"], "DENY");
  assert.equal(r.cabecalhos["x-content-type-options"], "nosniff");
  assert.equal(r.cabecalhos["cache-control"], "no-store");
});

test("a privileged route without a session answers 401 and does not leak state", async (t) => {
  const amb = ajuda.ambiente();
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });

  for (const rota of ["/api/painel", "/api/host", "/api/backups", "/api/logs", "/api/auditoria", "/api/acoes", "/api/trabalhos", "/api/terminal", "/api/rede/acesso"]) {
    const r = await ajuda.pedir(s.porta, rota);
    assert.equal(r.status, 401, `${rota} should require a session`);
    assert.equal(r.json.erro, "não autenticado");
  }
});

test("a sensitive action requires elevation, not only a session", async (t) => {
  const amb = ajuda.ambiente();
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });

  const sessao = await ajuda.autenticar(amb, s.porta);
  const semElevacao = await ajuda.pedir(s.porta, "/api/acoes/servico.reiniciar/executar", {
    metodo: "POST",
    corpo: { argumentos: {} },
    cookie: sessao.cookie,
    csrf: sessao.csrf,
    origem: s.base,
  });
  assert.equal(semElevacao.status, 403);
  assert.equal(semElevacao.json.precisaElevacao, true);
});

test("bootstrap requires the installation secret and works only once", async (t) => {
  const amb = ajuda.ambiente();
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });

  fs.writeFileSync(path.join(amb.estadoDir, "bootstrap-token"), "segredo-de-instalacao\n");

  const errado = await ajuda.pedir(s.porta, "/api/bootstrap", {
    metodo: "POST",
    corpo: { segredo: "chute", nome: "operador", senha: "senha-de-teste-12345" },
    origem: s.base,
  });
  assert.equal(errado.status, 403);

  const certo = await ajuda.pedir(s.porta, "/api/bootstrap", {
    metodo: "POST",
    corpo: { segredo: "segredo-de-instalacao", nome: "operador", senha: "senha-de-teste-12345" },
    origem: s.base,
  });
  assert.equal(certo.status, 201);
  assert.ok(!fs.existsSync(path.join(amb.estadoDir, "bootstrap-token")), "the secret is consumed");

  const denovo = await ajuda.pedir(s.porta, "/api/bootstrap", {
    metodo: "POST",
    corpo: { segredo: "segredo-de-instalacao", nome: "outro", senha: "senha-de-teste-12345" },
    origem: s.base,
  });
  assert.equal(denovo.status, 409);
});

test("the audit records metadata and never secrets", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  amb.estado.auditar("teste", { operador: "op", senha: "nao-deve-aparecer", githubToken: "ghp_secreto", ok: true });
  const itens = amb.estado.lerAuditoria(10);
  assert.equal(itens[0].evento, "teste");
  assert.equal(itens[0].operador, "op");
  assert.equal(itens[0].senha, "[omitido]");
  assert.equal(itens[0].githubToken, "[omitido]");
  const bruto = fs.readFileSync(path.join(amb.estadoDir, "auditoria.log"), "utf8");
  assert.ok(!bruto.includes("nao-deve-aparecer"));
  assert.ok(!bruto.includes("ghp_secreto"));
});

test("the GitHub token never returns through the API", async (t) => {
  const amb = ajuda.ambiente();
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });

  amb.github.gravarToken("ghp_umtokenfalsoparateste1234567890");
  const sessao = await ajuda.autenticar(amb, s.porta);
  const r = await ajuda.pedir(s.porta, "/api/mobile", { cookie: sessao.cookie, origem: s.base });
  assert.equal(r.status, 200);
  assert.ok(!r.texto.includes("ghp_umtokenfalsoparateste1234567890"), "the token value must not leave through the API");
  assert.equal(r.json.credencialGitHub.presente, true);
  assert.equal(r.json.credencialGitHub.githubToken, undefined);
});

test("Console files are not served outside the web folder", async (t) => {
  const amb = ajuda.ambiente();
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });

  for (const tentativa of ["/../package.json", "/..%2fpackage.json", "/../../remoteifes-server/.env", "/src/auth.js"]) {
    const r = await ajuda.pedir(s.porta, tentativa);
    assert.ok(r.status === 404 || r.status === 400, `${tentativa} should not be served (status ${r.status})`);
    assert.ok(!r.texto.includes("scrypt$"), "no sensitive content may leak");
  }
  const ok = await ajuda.pedir(s.porta, "/");
  assert.equal(ok.status, 200);
  assert.match(ok.cabecalhos["content-type"], /text\/html/);
});
