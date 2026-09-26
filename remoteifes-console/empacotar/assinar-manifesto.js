#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const release = require("../src/release");

// Release manifest signing: the release maintainer's tool.
//
// Produces `manifesto.json.sig` (Ed25519, base64) over the **file bytes** of `manifesto.json`, not
// over a reserialized object: any reformatting after signing invalidates the signature, which is
// intended. Installing or running the Console never calls this; installed copies only carry the
// public key (src/release.js).
//
// The private key is never read from a command-line argument, only from a file or the
// CONSOLE_CHAVE_PRIVADA variable. Process arguments appear in `ps` and in CI logs. Nothing here
// prints it.
//
// Usage:
//   node empacotar/assinar-manifesto.js --gerar-chave <dir fora do repositório>
//   node empacotar/assinar-manifesto.js --manifesto <arquivo> --chave <arquivo-privado> [--publica <arquivo.b64>]
//   node empacotar/assinar-manifesto.js --verificar <manifesto> <assinatura> [<chave-publica.b64>]
//
// Signing checks, before writing the signature, what the Console will check after downloading it:
// the manifest's shape and validity, every listed artifact next to the manifest (size and SHA-256),
// and that the private key is the one the Console trusts (the embedded key, or --publica for a test
// key or for the manifest that announces a rotation).

const ARQ_PRIVADA = "release-ed25519.privada.pem";
const ARQ_PUBLICA = "release-ed25519.publica.b64";

function arg(nome, padrao = null) {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

function erro(mensagem) {
  process.stderr.write(`${mensagem}\n`);
  return 1;
}

function publicaB64De(chave) {
  return crypto.createPublicKey(chave).export({ type: "spki", format: "der" }).toString("base64");
}

// A private key inside a working tree is one `git add -A` away from a commit, and one inside a
// build output travels with the artifacts.
function dentroDeRepositorio(dir) {
  for (let atual = path.resolve(dir); ; atual = path.dirname(atual)) {
    if (fs.existsSync(path.join(atual, ".git"))) return atual;
    if (path.dirname(atual) === atual) return null;
  }
}

// POSIX modes mean nothing on NTFS: the folder gets an ACL for the current user only, inherited by
// what is created in it, and the key file gets the same explicitly.
function restringirNoWindows(alvo, { pasta = false } = {}) {
  const usuario = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
  if (!usuario) throw new Error("usuário atual desconhecido");
  const acesso = pasta ? `${usuario}:(OI)(CI)F` : `${usuario}:F`;
  execFileSync("icacls", [alvo, "/inheritance:r", "/grant:r", acesso], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

function gerarChave(dirInformado) {
  const dir = path.resolve(dirInformado);
  const repositorio = dentroDeRepositorio(dir);
  if (repositorio || dir.startsWith(path.resolve(__dirname, "..") + path.sep)) {
    return erro(`recusado: ${dir} está dentro de um repositório (${repositorio || path.resolve(__dirname, "..")}). Gere a chave privada fora de qualquer checkout e de qualquer saída de build.`);
  }
  const privado = path.join(dir, ARQ_PRIVADA);
  const publico = path.join(dir, ARQ_PUBLICA);
  // An existing key may already be the one installed consoles trust: replacing it would strand them.
  for (const existente of [privado, publico]) {
    if (fs.existsSync(existente)) return erro(`recusado: ${existente} já existe. Uma chave de publicação não é substituída por cima; use outro diretório.`);
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  else {
    try {
      restringirNoWindows(dir, { pasta: true });
    } catch (falha) {
      return erro(`não foi possível restringir as permissões de ${dir} (${falha.message}); nada foi gerado.`);
    }
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(privado, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  if (process.platform === "win32") {
    // A key that could not be protected is removed rather than left readable.
    try {
      restringirNoWindows(privado);
    } catch (falha) {
      fs.rmSync(privado, { force: true });
      return erro(`não foi possível restringir as permissões da chave (${falha.message}); nada foi gerado.`);
    }
  }
  const publicoB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  fs.writeFileSync(publico, `${publicoB64}\n`, { mode: 0o644, flag: "wx" });

  process.stdout.write(`Chave privada: ${privado}  (somente o usuário atual; NUNCA versionar, nunca na CI)\n`);
  process.stdout.write(`Chave pública: ${publico}\n`);
  process.stdout.write(`Identificador: ${release.idDaChave(publicoB64)}\n`);
  process.stdout.write(`Impressão SHA-256: ${release.impressaoDaChave(publicoB64)}\n\n`);
  process.stdout.write("Para que as instalações confiem nela, embuta a pública em src/release.js:\n\n");
  process.stdout.write(`  const CHAVE_PUBLICA_OFICIAL = "${publicoB64}";\n\n`);
  process.stdout.write("Guarde uma cópia cifrada da chave privada fora desta máquina (DISTRIBUICAO.md, seção 5).\n");
  return 0;
}

function carregarPrivada() {
  const doAmbiente = process.env.CONSOLE_CHAVE_PRIVADA;
  const arquivo = arg("chave");
  if (!doAmbiente && !arquivo) throw new Error("informe --chave <arquivo> ou a variável CONSOLE_CHAVE_PRIVADA");
  const chave = crypto.createPrivateKey(doAmbiente || fs.readFileSync(arquivo, "utf8"));
  if (chave.asymmetricKeyType !== "ed25519") throw new Error(`a chave privada é ${chave.asymmetricKeyType}, não Ed25519`);
  return chave;
}

function lerPublica(arquivo) {
  const base64 = fs.readFileSync(arquivo, "utf8").trim();
  release.chaveDeBase64(base64);
  return base64;
}

// Every artifact the manifest lists, as the Console will check it after authenticating the manifest.
function conferirArtefatos(manifesto, dir, { exigirTodos }) {
  const conferidos = [];
  const ausentes = [];
  for (const artefato of manifesto.artefatos) {
    const caminho = path.join(dir, artefato.arquivo);
    if (!fs.existsSync(caminho)) {
      ausentes.push(artefato.arquivo);
      continue;
    }
    const r = release.conferirArtefato(caminho, artefato);
    if (!r.ok) throw new Error(`${artefato.arquivo}: ${r.motivo}`);
    conferidos.push(artefato.arquivo);
  }
  if (exigirTodos && ausentes.length) throw new Error(`artefatos listados e ausentes ao lado do manifesto: ${ausentes.join(", ")}`);
  return { conferidos, ausentes };
}

function assinar() {
  const caminho = arg("manifesto");
  if (!caminho) return erro("informe --manifesto <arquivo>");
  const bytes = fs.readFileSync(caminho);
  let manifesto;
  try {
    manifesto = JSON.parse(bytes.toString("utf8"));
  } catch {
    return erro("o manifesto não é JSON válido");
  }

  let privada;
  let esperada;
  try {
    privada = carregarPrivada();
    esperada = arg("publica") ? lerPublica(arg("publica")) : release.CHAVE_PUBLICA_OFICIAL;
    release.chaveDeBase64(esperada || "");
  } catch (falha) {
    return erro(`não foi possível carregar as chaves: ${falha.message}`);
  }
  const doPar = publicaB64De(privada);
  const idAssinante = release.idDaChave(doPar);
  // Signing with a key the consoles do not trust would only move the failure to every host.
  if (idAssinante !== release.idDaChave(esperada)) {
    return erro(`recusado: a chave privada é ${idAssinante}, e a chave pública esperada é ${release.idDaChave(esperada)}.`);
  }

  // Signing an invalid manifest would only defer the failure to the operator's Console.
  const estrutura = release.validarEstrutura(manifesto, { idAssinante });
  if (!estrutura.ok) return erro(`manifesto recusado: ${estrutura.motivo}`);
  if (Date.parse(manifesto.expiraEm) <= Date.now()) return erro("manifesto já nasce expirado; ajuste expiraEm");
  try {
    conferirArtefatos(manifesto, path.dirname(path.resolve(caminho)), { exigirTodos: true });
  } catch (falha) {
    return erro(`manifesto recusado: ${falha.message}`);
  }

  const assinatura = crypto.sign(null, bytes, privada).toString("base64");
  const verificacao = release.verificarManifesto(bytes, assinatura, {
    chaves: [{ chave: release.chaveDeBase64(esperada), id: idAssinante, origem: "esperada" }],
  });
  if (!verificacao.ok) return erro(`a assinatura produzida não confere: ${verificacao.motivo}`);

  const embutida = release.CHAVE_PUBLICA_OFICIAL;
  const proxima = manifesto.proximaChave && manifesto.proximaChave.publica;
  if (embutida && idAssinante !== release.idDaChave(embutida) && !(proxima && release.idDaChave(proxima) === release.idDaChave(embutida))) {
    process.stdout.write(
      `aviso: o código desta versão embute ${release.idDaChave(embutida)}; instalações novas deste pacote não reconhecerão ${idAssinante}.\n`
    );
  }
  const destino = `${caminho}.sig`;
  fs.writeFileSync(destino, `${assinatura}\n`);
  process.stdout.write(`Assinado com ${idAssinante}: ${destino}\n`);
  if (proxima) process.stdout.write(`O manifesto anuncia a sucessora ${release.idDaChave(proxima)}.\n`);
  return 0;
}

function verificar() {
  const i = process.argv.indexOf("--verificar");
  const [manifesto, assinatura, chave] = process.argv.slice(i + 1);
  if (!manifesto || !assinatura) return erro("uso: --verificar <manifesto> <assinatura> [<chave-publica-b64>]");
  let publica;
  try {
    publica = chave ? lerPublica(chave) : release.CHAVE_PUBLICA_OFICIAL;
    release.chaveDeBase64(publica || "");
  } catch (falha) {
    return erro(`chave pública inválida: ${falha.message}`);
  }
  const id = release.idDaChave(publica);
  const r = release.verificarManifesto(fs.readFileSync(manifesto), fs.readFileSync(assinatura, "utf8"), {
    chaves: [{ chave: release.chaveDeBase64(publica), id, origem: chave ? "informada" : "embutida" }],
  });
  if (!r.ok) {
    process.stdout.write(`RECUSADO (${id}): ${r.motivo}\n`);
    return 1;
  }
  let artefatos;
  try {
    artefatos = conferirArtefatos(r.manifesto, path.dirname(path.resolve(manifesto)), { exigirTodos: false });
  } catch (falha) {
    process.stdout.write(`RECUSADO: ${falha.message}\n`);
    return 1;
  }
  process.stdout.write(
    `assinatura confere (${id}); manifesto ${r.manifesto.versao} válido até ${r.manifesto.expiraEm}; ` +
      `${artefatos.conferidos.length} artefato(s) conferido(s)` +
      `${artefatos.ausentes.length ? `, ${artefatos.ausentes.length} ausente(s) nesta pasta` : ""}\n`
  );
  return 0;
}

try {
  const gerar = arg("gerar-chave");
  if (gerar) process.exitCode = gerarChave(gerar);
  else if (process.argv.includes("--verificar")) process.exitCode = verificar();
  else process.exitCode = assinar();
} catch (falha) {
  process.stderr.write(`falha: ${falha.message}\n`);
  process.exitCode = 1;
}
