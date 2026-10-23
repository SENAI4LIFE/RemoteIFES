const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

function compilador() {
  for (const candidato of [process.env.CXX, "g++", "c++", "clang++"].filter(Boolean)) {
    const r = spawnSync(candidato, ["--version"], { stdio: "ignore" });
    if (!r.error && r.status === 0) return candidato;
  }
  return null;
}

function funcao(fonte, assinatura) {
  const m = fonte.match(new RegExp(`^${assinatura} \\{\\n[\\s\\S]*?\\n\\}\\n`, "m"));
  assert.ok(m, `${assinatura} exists`);
  return m[0];
}

test("the station reissues its connection once it stays unassociated past the retry interval", (t) => {
  const cxx = compilador();
  if (!cxx) {
    t.skip("nenhum compilador C++ disponível nesta máquina");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reconexao-wifi-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binario = path.join(dir, "reconexao_wifi_test");
  execFileSync(cxx, ["-std=c++17", "-O1", "-Wall", "-Wextra", "-Werror", "-o", binario, path.join(__dirname, "reconexao_wifi_test.cpp")], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  const r = spawnSync(binario, [], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, `${r.stdout || ""}${r.stderr || ""}`);
  assert.equal(r.stdout.trim(), "ok");
});

test("the firmware reissues the connection only through that decision, with the saved network and without touching the access point", () => {
  const fonte = fs.readFileSync(path.join(__dirname, "..", "src", "main.ino"), "utf8").replace(/\r\n/g, "\n");
  const gerenciar = funcao(fonte, "void gerenciarConexaoWifi\\(\\)");
  assert.match(
    gerenciar,
    /\n    ultimaTentativaReconexao = agora;\n    if \(deveReemitirConexaoWifi\(agora, wifiDesconectadoDesde, INTERVALO_RECONEXAO_WIFI_MS, meshModo\(\) == MESH_MODO_DIRETO\)\) \{\n      reemitirConexaoWifi\(agora - wifiDesconectadoDesde\);\n    \} else \{\n      Serial\.println\("Tentando WiFi\.reconnect\(\)\.\.\."\);\n      WiFi\.reconnect\(\);\n    \}\n  \}\n\}\n$/,
    "the decision alone chooses between reissuing and reconnecting, at the existing retry interval",
  );
  assert.equal((gerenciar.match(/reemitirConexaoWifi\(/g) || []).length, 1);

  const reemitir = funcao(fonte, "void reemitirConexaoWifi\\(unsigned long semAssociacaoMs\\)");
  assert.match(reemitir, /preferences\.getString\("ssid"/);
  assert.match(
    reemitir,
    /\n  if \(apIniciado\) \{\n    WiFi\.disconnect\(false, false\);\n  \} else \{\n    WiFi\.disconnect\(true, false\);\n    WiFi\.mode\(WIFI_STA\);\n  \}\n  WiFi\.begin\(ssid\.c_str\(\), senha\.c_str\(\)\);\n\}\n$/,
    "with the access point open only the station is disconnected; without it the radio is restarted in station mode before begin()",
  );
  assert.doesNotMatch(reemitir, /softAP|WIFI_AP|ESP\.restart|agendarReinicio/, "the access point and the board are left as they are");
});
