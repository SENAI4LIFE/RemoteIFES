const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

// Compiles the firmware's mesh protocol module for the host and runs it against the vectors the
// server produced. It is the only executable check of the firmware's crypto that does not need a
// board: the radio and the ESP-WIFI-MESH integration still require hardware (MESH.md).

const RAIZ = path.join(__dirname, "..");
const VETORES = JSON.parse(fs.readFileSync(path.join(__dirname, "mesh-vetores.json"), "utf8"));

function compilador() {
  for (const candidato of [process.env.CXX, "g++", "c++", "clang++"].filter(Boolean)) {
    const r = spawnSync(candidato, ["--version"], { stdio: "ignore" });
    if (!r.error && r.status === 0) return candidato;
  }
  return null;
}

test("the firmware's mesh protocol reproduces the server's vectors", (t) => {
  const cxx = compilador();
  if (!cxx) {
    t.skip("nenhum compilador C++ disponível nesta máquina");
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-protocolo-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const binario = path.join(dir, "mesh_protocolo_test");

  try {
    execFileSync(
      cxx,
      [
        "-std=c++17",
        "-O1",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-DMESH_CRYPTO_OPENSSL",
        "-o",
        binario,
        path.join(__dirname, "mesh_protocolo_test.cpp"),
        path.join(RAIZ, "src", "mesh_protocolo.cpp"),
        "-lcrypto",
      ],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }
    );
  } catch (erro) {
    const detalhe = `${erro.stdout || ""}${erro.stderr || ""}`;
    if (/openssl|crypto/i.test(detalhe) && /No such file|cannot find|not found/i.test(detalhe)) {
      t.skip(`OpenSSL de desenvolvimento ausente: ${detalhe.trim().split("\n").slice(0, 2).join(" ")}`);
      return;
    }
    throw new Error(`a compilação do teste falhou: ${detalhe}`);
  }

  const r = spawnSync(
    binario,
    [
      VETORES.segredo,
      VETORES.no,
      VETORES.gateway,
      VETORES.ns,
      VETORES.nn,
      VETORES.chave,
      VETORES.chaveSessao,
      VETORES.provaOla,
      VETORES.provaAceito,
      String(VETORES.quadroDoNo.seq),
      VETORES.quadroDoNo.dados,
      VETORES.quadroDoNo.tag,
      VETORES.quadroDoNo.texto,
      String(VETORES.quadroDoServidor.seq),
      VETORES.quadroDoServidor.dados,
      VETORES.quadroDoServidor.tag,
      VETORES.quadroDoServidor.texto,
    ],
    { encoding: "utf8", timeout: 60_000 }
  );
  assert.equal(r.status, 0, `${r.stdout || ""}${r.stderr || ""}`);
});
