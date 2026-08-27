process.env.REMOTEIFES_DB_PATH = process.env.REMOTEIFES_DB_PATH || ":memory:";
process.env.NODE_ENV = "test";

const http = require("http");
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

const db = require("../src/config/database");
const app = require("../src/app");
const usuariosService = require("../src/services/usuariosService");

let server;
let baseUrl;

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function login(usuario, senha) {
  const resp = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usuario, senha }),
  });
  return { status: resp.status, corpo: await resp.json() };
}

function authFetch(path, token, opcoes = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...opcoes,
    headers: {
      ...(opcoes.headers || {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function jsonPost(path, token, corpo) {
  const resp = await authFetch(path, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  });
  return { status: resp.status, corpo: await resp.json() };
}

let tokenSuper;
let tokenAdmin;
let tokenUsuario;

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  db.prepare(`UPDATE usuarios SET senhaHash = ? WHERE usuario = 'admin'`).run(bcrypt.hashSync("superSenha123", 10));

  const superLogin = await login("admin", "superSenha123");
  tokenSuper = superLogin.corpo.token;

  usuariosService.criar(
    { usuario: "relato-admin", senha: "senhaSegura123", nome: "Admin Relatos", isAdmin: true },
    { nivel: 3 }
  );
  tokenAdmin = (await login("relato-admin", "senhaSegura123")).corpo.token;

  usuariosService.criar(
    { usuario: "relato-user", senha: "senhaSegura123", nome: "Usuário Relatos", podeControlar: true },
    { nivel: 3 }
  );
  tokenUsuario = (await login("relato-user", "senhaSegura123")).corpo.token;
});

test("um usuário comum autenticado cria um relato e recebe id/status", async () => {
  const r = await jsonPost("/relatos", tokenUsuario, {
    titulo: "AC da sala não liga",
    descricao: "Cliquei em ligar várias vezes e o ar-condicionado da sala não responde.",
    categoria: "ar_condicionado",
  });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.ok, true);
  assert.ok(Number.isInteger(r.corpo.relato.id));
  assert.equal(r.corpo.relato.status, "novo");
});

test("relato exige título e descrição com tamanho mínimo", async () => {
  const semTitulo = await jsonPost("/relatos", tokenUsuario, { titulo: "ab", descricao: "descrição suficientemente longa aqui" });
  assert.equal(semTitulo.status, 400);
  assert.equal(semTitulo.corpo.ok, false);

  const semDescricao = await jsonPost("/relatos", tokenUsuario, { titulo: "título válido", descricao: "curta" });
  assert.equal(semDescricao.status, 400);
});

test("relato aplica limite de tamanho e remove caracteres de controle", async () => {
  const tituloEnorme = "T".repeat(500);
  const descricaoComControle = String.fromCharCode(0, 7) + "linha 1 com bytes de controle\\nlinha 2 " + "x".repeat(6000);
  const r = await jsonPost("/relatos", tokenUsuario, {
    titulo: tituloEnorme,
    descricao: descricaoComControle,
    categoria: "categoria-que-nao-existe",
  });
  assert.equal(r.status, 200);
  const detalhe = await authFetch(`/superadmin/relatos/${r.corpo.relato.id}`, tokenSuper);
  const { relato } = await detalhe.json();
  assert.ok(relato.titulo.length <= 140);
  assert.ok(relato.descricao.length <= 4000);
  assert.doesNotMatch(relato.descricao, new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]"));
  assert.equal(relato.categoria, "outro");
});

test("relato guarda o conteúdo textual verbatim (o escape acontece na renderização)", async () => {
  const payloadXss = '<img src=x onerror=alert(1)> <script>bad()</script>';
  const r = await jsonPost("/relatos", tokenUsuario, {
    titulo: "Teste de conteudo especial",
    descricao: `Reproducao: ${payloadXss} -- fim`,
  });
  assert.equal(r.status, 200);
  const detalhe = await authFetch(`/superadmin/relatos/${r.corpo.relato.id}`, tokenSuper);
  const { relato } = await detalhe.json();
  assert.match(relato.descricao, /<script>bad\(\)<\/script>/);
});

test("cliques repetidos de envio não geram relatos duplicados", async () => {
  const corpo = {
    titulo: "Relato duplicado de teste",
    descricao: "Este texto identico foi enviado duas vezes em sequencia por engano.",
  };
  const primeiro = await jsonPost("/relatos", tokenUsuario, corpo);
  const segundo = await jsonPost("/relatos", tokenUsuario, corpo);
  assert.equal(primeiro.status, 200);
  assert.equal(segundo.status, 200);
  assert.equal(segundo.corpo.duplicado, true);
  assert.equal(primeiro.corpo.relato.id, segundo.corpo.relato.id);
});

test("um usuário comum não acessa a lista global nem relatos de outros", async () => {
  const alheio = await jsonPost("/relatos", tokenAdmin, {
    titulo: "Relato do administrador",
    descricao: "Conteudo que um usuario comum nao pode ler pelo endpoint de superadmin.",
  });
  const idAlheio = alheio.corpo.relato.id;

  const lista = await authFetch("/superadmin/relatos", tokenUsuario);
  assert.equal(lista.status, 403);

  const contagem = await authFetch("/superadmin/relatos/contagem", tokenUsuario);
  assert.equal(contagem.status, 403);

  const detalhe = await authFetch(`/superadmin/relatos/${idAlheio}`, tokenUsuario);
  assert.equal(detalhe.status, 403);

  const patch = await authFetch(`/superadmin/relatos/${idAlheio}`, tokenUsuario, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "resolvido" }),
  });
  assert.equal(patch.status, 403);
});

test("um administrador comum (nível 2) também não acessa o painel de relatos de superadmin", async () => {
  const lista = await authFetch("/superadmin/relatos", tokenAdmin);
  assert.equal(lista.status, 403);
  const patch = await authFetch(`/superadmin/relatos/1`, tokenAdmin, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "resolvido" }),
  });
  assert.equal(patch.status, 403);
});

test("requisições sem autenticação são rejeitadas", async () => {
  const criar = await fetch(`${baseUrl}/relatos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ titulo: "sem token", descricao: "descricao longa o suficiente para passar" }),
  });
  assert.equal(criar.status, 401);
  const lista = await fetch(`${baseUrl}/superadmin/relatos`);
  assert.equal(lista.status, 401);
});

test("o superadmin lista, abre, revisa e resolve relatos; abrir marca como aberto", async () => {
  const criado = await jsonPost("/relatos", tokenUsuario, {
    titulo: "Fluxo completo de status",
    descricao: "Relato usado para exercitar novo -> aberto -> em_analise -> resolvido.",
    categoria: "interface",
  });
  const id = criado.corpo.relato.id;

  const antes = await (await authFetch("/superadmin/relatos/contagem", tokenSuper)).json();
  assert.ok(antes.novos >= 1);

  const abertura = await (await authFetch(`/superadmin/relatos/${id}`, tokenSuper)).json();
  assert.equal(abertura.relato.status, "aberto");
  assert.equal(abertura.relato.autor.login, "relato-user");

  const analise = await authFetch(`/superadmin/relatos/${id}`, tokenSuper, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "em_analise" }),
  });
  assert.equal((await analise.json()).relato.status, "em_analise");

  const resolvido = await authFetch(`/superadmin/relatos/${id}`, tokenSuper, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "resolvido", resposta: "Reiniciamos o ESP32 da sala e o problema foi corrigido." }),
  });
  const corpoResolvido = (await resolvido.json()).relato;
  assert.equal(corpoResolvido.status, "resolvido");
  assert.match(corpoResolvido.resposta, /Reiniciamos o ESP32/);
});

test("status inválido no PATCH é rejeitado", async () => {
  const criado = await jsonPost("/relatos", tokenUsuario, {
    titulo: "Relato para status invalido",
    descricao: "Verifica que valores fora do enum de status sao recusados pelo backend.",
  });
  const patch = await authFetch(`/superadmin/relatos/${criado.corpo.relato.id}`, tokenSuper, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "arquivado" }),
  });
  assert.equal(patch.status, 400);
});

test("o usuário vê apenas os próprios relatos em /relatos/meus", async () => {
  const meus = await (await authFetch("/relatos/meus", tokenUsuario)).json();
  assert.ok(Array.isArray(meus));
  assert.ok(meus.length >= 1);

  const meusAdmin = await (await authFetch("/relatos/meus", tokenAdmin)).json();
  const idsAdmin = new Set(meusAdmin.map((r) => r.id));
  for (const r of meus) {
    assert.equal(idsAdmin.has(r.id), false);
  }
});

test("troca de senha continua exigindo admin e respeita os limites de tamanho", async () => {
  const alvo = usuariosService.criar(
    { usuario: "relato-troca-senha", senha: "senhaSegura123", nome: "Alvo Troca Senha", podeControlar: true },
    { nivel: 3 }
  );

  const semPermissao = await authFetch(`/admin/usuarios/${alvo.id}/senha`, tokenUsuario, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ novaSenha: "outraSenhaForte123" }),
  });
  assert.equal(semPermissao.status, 403);

  const curta = await authFetch(`/admin/usuarios/${alvo.id}/senha`, tokenAdmin, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ novaSenha: "curta" }),
  });
  assert.equal(curta.status, 400);

  const longa = await authFetch(`/admin/usuarios/${alvo.id}/senha`, tokenAdmin, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ novaSenha: "x".repeat(200) }),
  });
  assert.equal(longa.status, 400);

  const ok = await authFetch(`/admin/usuarios/${alvo.id}/senha`, tokenAdmin, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ novaSenha: "novaSenhaForte123" }),
  });
  assert.equal(ok.status, 200);

  const relogin = await login("relato-troca-senha", "novaSenhaForte123");
  assert.equal(relogin.status, 200);
});
