#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

// Stable entry point for the uninstaller, installed next to the stable layer by the Windows
// installer. `desinstalar.exe` cannot call the payload uninstaller directly because the payload
// lives in `versoes/<versao>/`, and that directory name changes with every update. This file reads
// the same version pointer the bootstrap reads and hands its arguments to the real uninstaller.

const RAIZ = __dirname;

function versoesPresentes() {
  try {
    return fs
      .readdirSync(path.join(RAIZ, "versoes"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function utilizavel(versao) {
  return Boolean(versao) && fs.existsSync(path.join(RAIZ, "versoes", versao, "instalacao", "desinstalar.js"));
}

function resolver() {
  let registrado = {};
  try {
    registrado = JSON.parse(fs.readFileSync(path.join(RAIZ, "estado-instalacao.json"), "utf8"));
  } catch {
    registrado = {};
  }
  // Active version first, then the previous one, then whatever is present: the uninstaller must
  // still work on an installation whose pointer is broken, which is when removal is most needed.
  const candidatas = [registrado.versaoAtiva, registrado.versaoAnterior, ...versoesPresentes()];
  return candidatas.find(utilizavel) || null;
}

const versao = resolver();
if (!versao) {
  process.stderr.write(
    `\nNenhuma versão do console foi encontrada em ${path.join(RAIZ, "versoes")}.\n` +
      "Não há programa para remover: apague a pasta da instalação se ela ainda existir.\n"
  );
  process.exit(1);
}

const alvo = path.join(RAIZ, "versoes", versao, "instalacao", "desinstalar.js");
const r = require("child_process").spawnSync(process.execPath, [alvo, ...process.argv.slice(2)], {
  stdio: "inherit",
  windowsHide: true,
});
process.exit(r.status === null ? 1 : r.status);
