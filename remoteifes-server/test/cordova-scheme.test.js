const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const raiz = path.join(__dirname, "../../remoteifes-cordova");
const original = fs.readFileSync(path.join(raiz, "config.xml"), "utf8");

for (const variante of ["ausente", "duplicado", "fora-android", "origem-invalida"]) {
  test(`endurecimento rejeita configuração ${variante} sem manter alterações`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-scheme-"));
    try {
      let xml = original;
      const preferencia = '<preference name="scheme" value="http" />';
      if (variante === "ausente") xml = xml.replace(preferencia, "");
      if (variante === "duplicado") xml = xml.replace(preferencia, preferencia + '\n<preference name="scheme" value="http" />');
      if (variante === "fora-android") xml = xml.replace(preferencia, "").replace('<platform name="ios">', '<platform name="ios">' + preferencia);
      const config = path.join(dir, "config.xml");
      fs.writeFileSync(config, xml);
      fs.copyFileSync(path.join(raiz, "harden-config.js"), path.join(dir, "harden-config.js"));
      const resultado = spawnSync(process.execPath, [path.join(dir, "harden-config.js"), variante === "origem-invalida" ? "invalid" : "https://example.invalid"], { encoding: "utf8" });
      assert.notEqual(resultado.status, 0, "configuração ambígua foi aceita");
      assert.equal(fs.readFileSync(config, "utf8"), xml);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
