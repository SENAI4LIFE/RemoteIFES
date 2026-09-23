const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ajuda = require("./ajuda");

// Autenticação, autorização, elevação e as defesas de transporte do console.

test("a senha é guardada com scrypt e conferida em tempo constante", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const hash = amb.auth.hashDeSenha("uma-senha-longa-o-bastante");
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(!hash.includes("uma-senha-longa"), "o hash não pode conter a senha");
  assert.equal(amb.auth.conferirSenha("uma-senha-longa-o-bastante", hash), true);
  assert.equal(amb.auth.conferirSenha("outra-coisa-qualquer-aqui", hash), false);
  assert.equal(amb.auth.conferirSenha("", hash), false);
  assert.equal(amb.auth.conferirSenha("x", "lixo"), false);
});

test("senhas padrão conhecidas da aplicação são recusadas como credencial do console", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  for (const proibida of ["admin", "superadmin", "SuperAdmin", "senha", "password"]) {
    assert.ok(amb.auth.validarForcaDaSenha(proibida), `deveria recusar "${proibida}"`);
  }
  assert.ok(amb.auth.validarForcaDaSenha("curta"), "senha curta deve ser recusada");
  assert.equal(amb.auth.validarForcaDaSenha("uma-senha-aceitavel-123"), null);
});

test("o arquivo de operadores fica fora do checkout e sem a senha em claro", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  amb.auth.criarOperador("operador", "senha-de-teste-12345");
  const arquivo = path.join(amb.estadoDir, "operadores.json");
  assert.ok(fs.existsSync(arquivo));
  const conteudo = fs.readFileSync(arquivo, "utf8");
  assert.ok(!conteudo.includes("senha-de-teste-12345"), "a senha em claro não pode ir para o disco");
  assert.ok(!path.resolve(arquivo).startsWith(path.resolve(amb.checkout, "remoteifes-console")));
});

test("sessão expira por ociosidade e por prazo absoluto", (t) => {
  const amb = ajuda.ambiente({ sessaoOciosaS: 60, sessaoMaxS: 300 });
  t.after(() => amb.restaurar());

  amb.auth.criarOperador("operador", "senha-de-teste-12345");
  const { token } = amb.auth.criarSessao("operador");
  assert.ok(amb.auth.validarSessao(token));

  // Envelhece a sessão no disco além do limite de ociosidade.
  const arquivo = path.join(amb.estadoDir, "sessoes.json");
  const dados = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  const id = Object.keys(dados.sessoes)[0];
  dados.sessoes[id].vistaEm = Date.now() - 61_000;
  fs.writeFileSync(arquivo, JSON.stringify(dados));
  amb.auth.limparTudoParaTeste();
  assert.equal(amb.auth.validarSessao(token), null, "sessão ociosa deve ser invalidada");

  const { token: t2 } = amb.auth.criarSessao("operador");
  const dados2 = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  for (const chave of Object.keys(dados2.sessoes)) dados2.sessoes[chave].expiraEm = Date.now() - 1000;
  fs.writeFileSync(arquivo, JSON.stringify(dados2));
  amb.auth.limparTudoParaTeste();
  assert.equal(amb.auth.validarSessao(t2), null, "sessão vencida deve ser invalidada");
});

test("a troca de senha revoga as demais sessões do operador", (t) => {
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

test("a elevação expira sozinha e é revogada ao encerrar", (t) => {
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
  assert.equal(amb.auth.validarSessao(token).elevada, false, "elevação vencida não vale mais");
});

test("tentativas repetidas de login são limitadas por operador", (t) => {
  const amb = ajuda.ambiente();
  t.after(() => amb.restaurar());

  const chave = "login:alvo";
  assert.equal(amb.auth.bloqueado(chave), 0);
  for (let i = 0; i < 8; i += 1) amb.auth.registrarFalha(chave);
  assert.ok(amb.auth.bloqueado(chave) > 0, "deve bloquear após as tentativas");
  amb.auth.limparTentativas(chave);
  assert.equal(amb.auth.bloqueado(chave), 0);
});

// --- Transporte ---------------------------------------------------------------------------

test("Host inesperado é recusado com 421 (defesa contra DNS rebinding)", async (t) => {
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

test("Origin de outra origem é recusado mesmo com sessão válida", async (t) => {
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

test("método mutante sem o cabeçalho CSRF é recusado", async (t) => {
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

test("o cookie de sessão é HttpOnly, SameSite=Strict e some no logout", async (t) => {
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
  assert.ok(saida.cabecalhos["clear-site-data"], "logout deve pedir limpeza de armazenamento da origem");

  const depois = await ajuda.pedir(s.porta, "/api/painel", { cookie: sessao.cookie, origem: s.base });
  assert.equal(depois.status, 401, "o cookie revogado não pode mais valer");
});

test("content-type inesperado num POST é recusado", async (t) => {
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

test("cabeçalhos de segurança acompanham toda resposta", async (t) => {
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

test("rota privilegiada sem sessão responde 401 e não vaza estado", async (t) => {
  const amb = ajuda.ambiente();
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });

  for (const rota of ["/api/painel", "/api/host", "/api/backups", "/api/logs", "/api/auditoria", "/api/acoes", "/api/trabalhos", "/api/terminal"]) {
    const r = await ajuda.pedir(s.porta, rota);
    assert.equal(r.status, 401, `${rota} deveria exigir sessão`);
    assert.equal(r.json.erro, "não autenticado");
  }
});

test("ação sensível exige elevação, não só sessão", async (t) => {
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

test("bootstrap exige o segredo de instalação e só funciona uma vez", async (t) => {
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
  assert.ok(!fs.existsSync(path.join(amb.estadoDir, "bootstrap-token")), "o segredo é consumido");

  const denovo = await ajuda.pedir(s.porta, "/api/bootstrap", {
    metodo: "POST",
    corpo: { segredo: "segredo-de-instalacao", nome: "outro", senha: "senha-de-teste-12345" },
    origem: s.base,
  });
  assert.equal(denovo.status, 409);
});

test("a auditoria registra metadados e nunca segredos", (t) => {
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

test("o token do GitHub nunca volta por API", async (t) => {
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
  assert.ok(!r.texto.includes("ghp_umtokenfalsoparateste1234567890"), "o valor do token não pode sair pela API");
  assert.equal(r.json.credencialGitHub.presente, true);
  assert.equal(r.json.credencialGitHub.githubToken, undefined);
});

test("arquivos do console não são servidos fora da pasta web", async (t) => {
  const amb = ajuda.ambiente();
  const s = await ajuda.subir(amb);
  t.after(async () => {
    await s.fechar();
    amb.restaurar();
  });

  for (const tentativa of ["/../package.json", "/..%2fpackage.json", "/../../remoteifes-server/.env", "/src/auth.js"]) {
    const r = await ajuda.pedir(s.porta, tentativa);
    assert.ok(r.status === 404 || r.status === 400, `${tentativa} não deveria ser servido (status ${r.status})`);
    assert.ok(!r.texto.includes("scrypt$"), "nenhum conteúdo sensível pode vazar");
  }
  const ok = await ajuda.pedir(s.porta, "/");
  assert.equal(ok.status, 200);
  assert.match(ok.cabecalhos["content-type"], /text\/html/);
});
