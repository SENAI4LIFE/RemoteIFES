const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawnSync } = require("child_process");

// setup.sh installs Node.js from nodejs.org with elevated privileges when the host lacks it. The
// archive must match the SHA-256 the release publishes before it is extracted. The function is taken
// from setup.sh as written and run against a local mirror (file://), so no network is involved.

const SETUP = fs.readFileSync(path.join(__dirname, "..", "setup.sh"), "utf8");
const temBash = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok";
const temCurl = spawnSync("curl", ["--version"], { encoding: "utf8" }).status === 0;

function funcaoDeVerificacao() {
  const m = SETUP.match(/^verify_node_archive\(\) \{\n[\s\S]*?\n\}\n/m);
  assert.ok(m, "setup.sh must define verify_node_archive");
  return m[0];
}

test("setup.sh verifies the downloaded archive before extracting it", () => {
  const instalar = SETUP.slice(SETUP.indexOf("install_node_linux() {"));
  const verificacao = instalar.indexOf('verify_node_archive "$version"');
  const extracao = instalar.indexOf("tar -xJf");
  assert.ok(verificacao > 0 && extracao > 0, "both steps must be present");
  assert.ok(verificacao < extracao, "the checksum is checked before the privileged extraction");
});

test("the archive check accepts only the exact published SHA-256, and fails closed", { skip: !(temBash && temCurl) }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remoteifes-node-dist-"));
  try {
    const versao = "22.99.0";
    const arquivo = `node-v${versao}-linux-x64.tar.xz`;
    const pasta = path.join(dir, "dist", `v${versao}`);
    fs.mkdirSync(pasta, { recursive: true });
    const conteudo = Buffer.from("conteudo do arquivo do node para o teste");
    const baixado = path.join(dir, "node.tar.xz");
    fs.writeFileSync(baixado, conteudo);
    const sha = crypto.createHash("sha256").update(conteudo).digest("hex");
    const somas = path.join(pasta, "SHASUMS256.txt");
    fs.writeFileSync(somas, `${"0".repeat(64)}  node-v${versao}-linux-arm64.tar.xz\n${sha}  ${arquivo}\n`);

    const base = pathToFileURL(path.join(dir, "dist")).href;
    const verificar = (nomeArquivo = arquivo) => spawnSync("bash", ["-c", `NODE_DIST_BASE="$1"\n${funcaoDeVerificacao()}verify_node_archive "$2" "$3" "$4"`, "bash", base, versao, nomeArquivo, baixado.replace(/\\/g, "/")], { encoding: "utf8" });

    assert.equal(verificar().status, 0, "the published SHA-256 matches");
    assert.equal(verificar(`node-v${versao}-linux-armv7l.tar.xz`).status, 1, "a file the release does not list is refused");

    fs.writeFileSync(baixado, Buffer.concat([conteudo, Buffer.from("x")]));
    assert.equal(verificar().status, 1, "an altered archive is refused");

    fs.writeFileSync(baixado, conteudo);
    fs.rmSync(somas);
    assert.equal(verificar().status, 1, "without the checksum file nothing is accepted");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
