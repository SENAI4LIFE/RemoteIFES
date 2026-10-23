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

test("the AHT10 driver converts the datasheet's 20-bit readings and discards a busy sample", (t) => {
  const cxx = compilador();
  if (!cxx) {
    t.skip("nenhum compilador C++ disponível nesta máquina");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aht10-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binario = path.join(dir, "aht10_test");
  execFileSync(cxx, ["-std=c++17", "-O1", "-Wall", "-Wextra", "-Werror", "-o", binario, path.join(__dirname, "aht10_test.cpp")], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  const r = spawnSync(binario, [], { encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, `${r.stdout || ""}${r.stderr || ""}`);
  assert.equal(r.stdout.trim(), "ok");
});

test("the firmware uses the AHT10 only when it answers at boot and otherwise keeps the DHT11", () => {
  const fonte = fs.readFileSync(path.join(__dirname, "..", "src", "main.ino"), "utf8").replace(/\r\n/g, "\n");
  assert.match(funcao(fonte, "void setup\\(\\)"), /\n  aht10Presente = iniciarAht10\(\);\n  if \(aht10Presente\) \{\n[^\n]*\n  \} else \{\n    dht\.begin\(\);\n  \}\n/);

  const iniciar = funcao(fonte, "bool iniciarAht10\\(\\)");
  assert.match(iniciar, /Wire\.setTimeOut\(AHT10_I2C_TIMEOUT_MS\);\n  if \(!Wire\.begin\(AHT10_SDA_PIN, AHT10_SCL_PIN\)\) return false;/);
  assert.match(iniciar, /Wire\.end\(\);\n  return false;\n\}\n$/, "without an answer the bus is released");

  const ler = funcao(fonte, "void atualizarLeituraSensores\\(\\)");
  assert.match(ler, /\n  ultimaLeituraTemp = dht\.readTemperature\(\);\n  ultimaLeituraHum = dht\.readHumidity\(\);\n\}\n$/, "the DHT11 read is unchanged");
  assert.match(ler, /escreverComandoAht10\(AHT10_COMANDO_MEDIR\)/);

  const loop = funcao(fonte, "void loop\\(\\)");
  assert.match(
    loop,
    /\n  unsigned long agora = millis\(\);\n  if \(aht10MedicaoPendente && aht10MedicaoPronta\(agora, aht10MedicaoDisparadaEm, AHT10_ESPERA_MEDICAO_MS\)\) \{\n    concluirMedicaoAht10\(\);\n  \} else if \(agora - lastSensorRead >= SENSOR_READ_INTERVAL\) \{\n    lastSensorRead = agora;\n    atualizarLeituraSensores\(\);\n  \}\n/,
    "a pending sample is read before a new trigger, never in the pass that triggered it, with the clock taken at the start of the pass",
  );
  assert.match(ler, /aht10MedicaoDisparadaEm = millis\(\);/, "the trigger time is taken after the pass clock, so the same pass never sees 80 ms");
  assert.equal((fonte.match(/concluirMedicaoAht10\(\);/g) || []).length, 2, "declared once and called only from the loop");
  assert.match(fonte, /const unsigned long AHT10_ESPERA_MEDICAO_MS = 80;/);

  for (const nome of ["bool iniciarAht10\\(\\)", "bool escreverComandoAht10\\(const uint8_t comando\\[3\\]\\)", "void concluirMedicaoAht10\\(\\)", "void atualizarLeituraSensores\\(\\)"]) {
    assert.doesNotMatch(funcao(fonte, nome), /delay\(/, `${nome} never blocks the loop`);
  }
  const concluir = funcao(fonte, "void concluirMedicaoAht10\\(\\)");
  assert.match(concluir, /float temperatura = NAN;\n  float umidade = NAN;/, "a failed read yields NAN");
  assert.match(concluir, /ultimaLeituraTemp = temperatura;\n  ultimaLeituraHum = umidade;\n\}\n$/);
});
