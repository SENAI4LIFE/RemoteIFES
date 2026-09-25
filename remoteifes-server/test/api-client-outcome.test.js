const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const API_JS = fs.readFileSync(path.join(__dirname, "..", "..", "remoteifes-web", "js", "api.js"), "utf8");

// Loads the shared api.js (PWA and Cordova) in an isolated context with a controlled fetch: each
// case describes what the browser sees, headers that arrive and a body that fails afterwards.
function carregarApi(fetchFalso) {
  const contexto = vm.createContext({
    window: { RemoteIFESConfig: { serverUrl: "http://servidor.teste" }, location: { origin: "http://servidor.teste" }, addEventListener() {}, dispatchEvent() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    CustomEvent: class { constructor(tipo, init) { this.type = tipo; this.detail = init && init.detail; } },
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: fetchFalso,
  });
  vm.runInContext(API_JS, contexto, { filename: "api.js" });
  return vm.runInContext("Object.assign(Api, { chamar })", contexto);
}

function respostaCom(status, lerCorpo) {
  return { status, ok: status >= 200 && status < 300, json: lerCorpo };
}

test("a mutation whose body is lost after the headers has an unknown outcome and is not treated as not done", async () => {
  const chamadas = [];
  const api = carregarApi(async (url, opcoes) => {
    chamadas.push({ url, method: opcoes.method || "GET" });
    // The server accepted (200) and the connection dropped while reading the body.
    return respostaCom(200, () => Promise.reject(new TypeError("network error")));
  });
  const resultado = await api.enviarComando("A-101", "ligar");
  assert.equal(resultado.ok, false);
  assert.equal(resultado.desfechoDesconhecido, true);
  assert.equal(resultado.respostaIncompleta, true);
  assert.match(resultado.erro, /chegou incompleta \(status 200\); o pedido pode ter sido aplicado — confira o estado antes de repetir/);
  assert.equal(chamadas.length, 1, "no automatic retry");
});

test("an unusable body (truncated JSON) on an accepted mutation also preserves the uncertainty; a 4xx is a refusal", async () => {
  const truncado = carregarApi(async () => respostaCom(200, () => Promise.reject(new SyntaxError("Unexpected end of JSON input"))));
  const r1 = await truncado.criarAgendamento({ sala: "A-101" });
  assert.equal(r1.desfechoDesconhecido, true);
  assert.match(r1.erro, /pode ter sido aplicado/);

  const recusa = carregarApi(async () => respostaCom(404, () => Promise.reject(new SyntaxError("Unexpected token <"))));
  const r2 = await recusa.removerAgendamento(7);
  assert.equal(r2.ok, false);
  assert.equal(r2.desfechoDesconhecido, false, "the server itself refused: nothing was applied");
  assert.equal(r2.erro, "resposta inválida do servidor (status 404)");

  const intermediario = carregarApi(async () => respostaCom(502, () => Promise.reject(new SyntaxError("Unexpected token <"))));
  const r3 = await intermediario.enviarComando("A-101", "desligar");
  assert.equal(r3.desfechoDesconhecido, true, "an intermediary 5xx does not prove the server did not apply it");
});

test("a query with an invalid body remains just an invalid response", async () => {
  const api = carregarApi(async () => respostaCom(200, () => Promise.reject(new SyntaxError("Unexpected token <"))));
  const resultado = await api.statusSala("A-101");
  assert.equal(resultado.ok, false);
  assert.equal(resultado.desfechoDesconhecido, false);
  assert.equal(resultado.erro, "resposta inválida do servidor (status 200)");
});

test("the call deadline covers reading the body, and an intact response passes unchanged", async () => {
  const lenta = carregarApi(async (url, opcoes) => respostaCom(200, () => new Promise((resolve, reject) => {
    opcoes.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  })));
  const inicio = Date.now();
  const r1 = await lenta.chamar("/comando", { method: "POST", tempoLimiteMs: 50 });
  assert.ok(Date.now() - inicio < 5000, "a body that never ends is aborted by the deadline");
  assert.equal(r1.semResposta, true);
  assert.equal(r1.tempoEsgotado, true);
  assert.equal(r1.desfechoDesconhecido, true);

  const integra = carregarApi(async () => respostaCom(200, async () => ({ ok: true, sala: { sala: "A-101", ligado: true } })));
  const r2 = await integra.enviarComando("A-101", "ligar");
  assert.deepEqual(r2, { ok: true, sala: { sala: "A-101", ligado: true } });
});
