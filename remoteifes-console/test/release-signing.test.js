const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync, execFileSync } = require("child_process");
const ajuda = require("./helpers");

// The release maintainer's side of the trust chain: key generation, signing and verification with
// empacotar/assinar-manifesto.js. Every key here is generated for the test and thrown away; the
// production private key never reaches CI.

const FERRAMENTA = path.join(ajuda.RAIZ, "empacotar", "assinar-manifesto.js");
const CONSTRUIR = path.join(ajuda.RAIZ, "empacotar", "construir.js");
// PEM armour of any private key. Assembled at run time so this file does not trip the Console's own
// committed-secret scan (integration.test.js).
const ARMADURA_PRIVADA = new RegExp(["-----BEGIN [A-Z ]*", "PRIVATE KEY-----"].join(""));

function ferramenta(args, env = {}) {
  const ambiente = { ...process.env, ...env };
  if (!env.CONSOLE_CHAVE_PRIVADA) delete ambiente.CONSOLE_CHAVE_PRIVADA;
  const r = spawnSync(process.execPath, [FERRAMENTA, ...args], { encoding: "utf8", timeout: 60_000, env: ambiente });
  return { codigo: r.status, saida: `${r.stdout}${r.stderr}` };
}

function novaChave(t) {
  const dir = path.join(ajuda.dirTemporario("console-chave-"), "chave");
  t.after(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));
  const r = ferramenta(["--gerar-chave", dir]);
  assert.equal(r.codigo, 0, r.saida);
  return {
    dir,
    saida: r.saida,
    privada: path.join(dir, "release-ed25519.privada.pem"),
    publica: path.join(dir, "release-ed25519.publica.b64"),
    publicaB64: fs.readFileSync(path.join(dir, "release-ed25519.publica.b64"), "utf8").trim(),
  };
}

// A release folder as the build leaves it: artifacts next to an unsigned manifest.
function publicacao(t, { versao = "2.0.0", proximaChave = null, artefatos = { "linux-x64": "payload linux", "windows-x64": "payload windows" } } = {}) {
  const dir = ajuda.dirTemporario("console-publicacao-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const lista = Object.entries(artefatos).map(([alvo, conteudo]) => {
    const arquivo = `remoteifes-console-${versao}-${alvo}.tar.gz`;
    fs.writeFileSync(path.join(dir, arquivo), conteudo);
    return { alvo, formato: "tar.gz", arquivo, sha256: crypto.createHash("sha256").update(conteudo).digest("hex"), bytes: Buffer.byteLength(conteudo) };
  });
  const manifesto = path.join(dir, "manifesto.json");
  fs.writeFileSync(
    manifesto,
    `${JSON.stringify({ esquema: 1, versao, canal: "estavel", expiraEm: new Date(Date.now() + 30 * 86400_000).toISOString(), proximaChave, artefatos: lista }, null, 2)}\n`
  );
  return { dir, manifesto, assinatura: `${manifesto}.sig`, artefatos: lista };
}

test("a key pair is generated outside any checkout, never over an existing key, readable only by its owner", (t) => {
  const par = novaChave(t);
  const pem = fs.readFileSync(par.privada, "utf8");
  assert.match(pem, ARMADURA_PRIVADA);
  assert.equal(crypto.createPrivateKey(pem).asymmetricKeyType, "ed25519");
  // The tool reports where the key is and which key it is, never the key itself.
  const corpo = pem.split("\n").slice(1, -2).join("");
  assert.ok(!par.saida.includes(corpo) && !ARMADURA_PRIVADA.test(par.saida), "the private key must not be printed");
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));
  assert.ok(par.saida.includes(release.idDaChave(par.publicaB64)));
  assert.ok(par.saida.includes(release.impressaoDaChave(par.publicaB64)));

  if (process.platform === "win32") {
    const acl = execFileSync("icacls", [par.privada], { encoding: "utf8" });
    const entradas = acl.split(/\r?\n/).map((l) => l.replace(par.privada, "").trim()).filter((l) => /:\(/.test(l));
    assert.equal(entradas.length, 1, `only the current user may read the key:\n${acl}`);
    assert.match(entradas[0], new RegExp(`${process.env.USERNAME}:\\(F\\)`, "i"));
  } else {
    assert.equal(fs.statSync(par.privada).mode & 0o777, 0o600);
    assert.equal(fs.statSync(par.dir).mode & 0o777, 0o700);
  }

  // A second generation into the same folder would replace the key installed consoles trust.
  const antes = fs.readFileSync(par.privada);
  const repetida = ferramenta(["--gerar-chave", par.dir]);
  assert.notEqual(repetida.codigo, 0);
  assert.match(repetida.saida, /já existe/);
  assert.deepEqual(fs.readFileSync(par.privada), antes);
});

test("a private key is never generated inside a working tree", (t) => {
  const checkout = ajuda.dirTemporario("console-checkout-");
  t.after(() => fs.rmSync(checkout, { recursive: true, force: true }));
  fs.mkdirSync(path.join(checkout, ".git"));
  const alvo = path.join(checkout, "remoteifes-console", ".signing");
  const r = ferramenta(["--gerar-chave", alvo]);
  assert.notEqual(r.codigo, 0);
  assert.match(r.saida, /dentro de um repositório/);
  assert.equal(fs.existsSync(alvo), false);
  // And never inside this package, whose files are what gets built and published.
  const dentro = path.join(ajuda.RAIZ, "dist", "chave-de-teste");
  assert.notEqual(ferramenta(["--gerar-chave", dentro]).codigo, 0);
  assert.equal(fs.existsSync(dentro), false);
});

test("signing checks the key, the manifest and every artifact before writing a signature", (t) => {
  const par = novaChave(t);
  const outra = novaChave(t);

  // No --publica: the signature must verify against the key embedded in this code.
  let pub = publicacao(t);
  let r = ferramenta(["--manifesto", pub.manifesto, "--chave", par.privada]);
  assert.notEqual(r.codigo, 0);
  assert.match(r.saida, /chave pública esperada/);
  assert.equal(fs.existsSync(pub.assinatura), false);

  // A private key that is not the expected one.
  r = ferramenta(["--manifesto", pub.manifesto, "--chave", outra.privada, "--publica", par.publica]);
  assert.notEqual(r.codigo, 0);
  assert.match(r.saida, /recusado: a chave privada é/);

  // An artifact that changed after the build, or is missing.
  fs.appendFileSync(path.join(pub.dir, pub.artefatos[0].arquivo), "x");
  r = ferramenta(["--manifesto", pub.manifesto, "--chave", par.privada, "--publica", par.publica]);
  assert.notEqual(r.codigo, 0);
  assert.match(r.saida, /tamanho divergente/);
  pub = publicacao(t);
  fs.rmSync(path.join(pub.dir, pub.artefatos[1].arquivo));
  r = ferramenta(["--manifesto", pub.manifesto, "--chave", par.privada, "--publica", par.publica]);
  assert.notEqual(r.codigo, 0);
  assert.match(r.saida, /ausentes ao lado do manifesto/);

  // A manifest the console would refuse.
  pub = publicacao(t, { proximaChave: { publica: "não é chave" } });
  r = ferramenta(["--manifesto", pub.manifesto, "--chave", par.privada, "--publica", par.publica]);
  assert.notEqual(r.codigo, 0);
  assert.match(r.saida, /proximaChave recusada/);
  assert.equal(fs.existsSync(pub.assinatura), false);

  // The private key comes from the environment as well as from a file, never from argv.
  pub = publicacao(t);
  r = ferramenta(["--manifesto", pub.manifesto, "--publica", par.publica], { CONSOLE_CHAVE_PRIVADA: fs.readFileSync(par.privada, "utf8") });
  assert.equal(r.codigo, 0, r.saida);
  assert.match(r.saida, /Assinado com ed25519:/);
});

test("verification authenticates the manifest first and then every artifact present", (t) => {
  const par = novaChave(t);
  const outra = novaChave(t);
  const pub = publicacao(t);
  const assinatura = ferramenta(["--manifesto", pub.manifesto, "--chave", par.privada, "--publica", par.publica]);
  assert.equal(assinatura.codigo, 0, assinatura.saida);

  let r = ferramenta(["--verificar", pub.manifesto, pub.assinatura, par.publica]);
  assert.equal(r.codigo, 0, r.saida);
  assert.match(r.saida, /2 artefato\(s\) conferido\(s\)/);

  // Wrong key, and the embedded production key, which never signed this.
  r = ferramenta(["--verificar", pub.manifesto, pub.assinatura, outra.publica]);
  assert.notEqual(r.codigo, 0);
  assert.match(r.saida, /não confere/);
  r = ferramenta(["--verificar", pub.manifesto, pub.assinatura]);
  assert.notEqual(r.codigo, 0);

  // Artifact tampering.
  const artefato = path.join(pub.dir, pub.artefatos[0].arquivo);
  const original = fs.readFileSync(artefato);
  const trocado = Buffer.from(original);
  trocado[0] ^= 0x01;
  fs.writeFileSync(artefato, trocado);
  r = ferramenta(["--verificar", pub.manifesto, pub.assinatura, par.publica]);
  assert.notEqual(r.codigo, 0);
  assert.match(r.saida, /SHA-256 divergente/);
  fs.writeFileSync(artefato, original);

  // Manifest tampering, then a malformed signature file.
  const manifesto = fs.readFileSync(pub.manifesto, "utf8");
  fs.writeFileSync(pub.manifesto, manifesto.replace('"estavel"', '"beta"'));
  r = ferramenta(["--verificar", pub.manifesto, pub.assinatura, par.publica]);
  assert.notEqual(r.codigo, 0);
  assert.match(r.saida, /não confere/);
  fs.writeFileSync(pub.manifesto, manifesto);
  fs.writeFileSync(pub.assinatura, "isto não é uma assinatura\n");
  r = ferramenta(["--verificar", pub.manifesto, pub.assinatura, par.publica]);
  assert.notEqual(r.codigo, 0);
  assert.match(r.saida, /assinatura malformada/);
});

test("a rotation manifest is signed by the current key and names its successor", (t) => {
  const atual = novaChave(t);
  const sucessora = novaChave(t);
  const pub = publicacao(t, { proximaChave: { publica: sucessora.publicaB64 } });
  const r = ferramenta(["--manifesto", pub.manifesto, "--chave", atual.privada, "--publica", atual.publica]);
  assert.equal(r.codigo, 0, r.saida);
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));
  assert.ok(r.saida.includes(`anuncia a sucessora ${release.idDaChave(sucessora.publicaB64)}`));
  // A successor equal to the signer is refused before signing.
  const mesma = publicacao(t, { proximaChave: { publica: atual.publicaB64 } });
  assert.notEqual(ferramenta(["--manifesto", mesma.manifesto, "--chave", atual.privada, "--publica", atual.publica]).codigo, 0);
});

test("one release manifest covers every target, and each console finds its own artifact", (t) => {
  const saida = ajuda.dirTemporario("console-dist-alvos-");
  t.after(() => fs.rmSync(saida, { recursive: true, force: true }));
  const alvos = ["linux-arm64", "linux-x64", "windows-x64", "macos-arm64"];
  execFileSync(process.execPath, [CONSTRUIR, "--saida", saida, "--alvo", alvos.join(","), "--formato", "payload"], { stdio: "pipe", timeout: 300_000 });
  const manifesto = JSON.parse(fs.readFileSync(path.join(saida, "manifesto.json"), "utf8"));
  assert.deepEqual(manifesto.artefatos.map((a) => a.alvo), alvos);
  execFileSync(process.execPath, [path.join(ajuda.RAIZ, "empacotar", "conferir-proveniencia.js"), saida], { stdio: "pipe" });

  const par = novaChave(t);
  const assinatura = ferramenta(["--manifesto", path.join(saida, "manifesto.json"), "--chave", par.privada, "--publica", par.publica]);
  assert.equal(assinatura.codigo, 0, assinatura.saida);

  const amb = ajuda.ambiente({ env: { CONSOLE_CHAVE_RELEASE: par.publicaB64 } });
  t.after(() => amb.restaurar());
  const release = require(path.join(ajuda.RAIZ, "src", "release.js"));
  const verificacao = release.verificarManifesto(fs.readFileSync(path.join(saida, "manifesto.json")), fs.readFileSync(path.join(saida, "manifesto.json.sig"), "utf8"));
  assert.equal(verificacao.ok, true, verificacao.motivo);
  for (const alvo of alvos) {
    const escolha = release.escolherArtefato(verificacao.manifesto, alvo);
    assert.equal(escolha.ok, true);
    assert.equal(release.conferirArtefato(path.join(saida, escolha.artefato.arquivo), escolha.artefato).ok, true);
  }
});

test("no private key material is tracked in the repository", (t) => {
  const repositorio = path.join(ajuda.RAIZ, "..");
  let listados;
  try {
    listados = execFileSync("git", ["ls-files", "-z"], { cwd: repositorio, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return t.skip("git is not available here");
  }
  // PEM armour of any private key, and the fixed prefix of a DER Ed25519 private key in base64,
  // which is what a key pasted without its armour starts with.
  const derEd25519 = Buffer.from("302e020100300506032b6570042204", "hex").toString("base64");
  const padroes = [ARMADURA_PRIVADA, new RegExp(derEd25519.replace(/[+/]/g, "\\$&"))];
  const achados = [];
  for (const arquivo of listados.split("\0").filter(Boolean)) {
    const completo = path.join(repositorio, arquivo);
    let conteudo;
    try {
      if (fs.statSync(completo).size > 4 * 1024 * 1024) continue;
      conteudo = fs.readFileSync(completo, "latin1");
    } catch {
      continue;
    }
    if (padroes.some((p) => p.test(conteudo))) achados.push(arquivo);
  }
  assert.deepEqual(achados, []);
});
