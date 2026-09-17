const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const RAIZ_REPOSITORIO = path.join(__dirname, "..", "..", "..");
const RE_COMMIT = /^[0-9a-f]{40}$/;

function lerTexto(caminho) {
  try {
    return fs.readFileSync(caminho, "utf8").trim();
  } catch {
    return null;
  }
}

function diretorioGit(raiz) {
  const entrada = path.join(raiz, ".git");
  let stat;
  try {
    stat = fs.statSync(entrada);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return entrada;
  const conteudo = lerTexto(entrada);
  const alvo = conteudo && conteudo.match(/^gitdir:\s*(.+)$/m);
  return alvo ? path.resolve(raiz, alvo[1].trim()) : null;
}

function resolverRef(dirGit, ref) {
  const solto = lerTexto(path.join(dirGit, ref));
  if (solto && RE_COMMIT.test(solto)) return solto;
  const empacotadas = lerTexto(path.join(dirGit, "packed-refs"));
  if (!empacotadas) return null;
  for (const linha of empacotadas.split("\n")) {
    const partes = linha.trim().split(/\s+/);
    if (partes.length === 2 && partes[1] === ref && RE_COMMIT.test(partes[0])) return partes[0];
  }
  return null;
}

// Lê o commit direto do .git para não depender do binário git nem das suas checagens de
// propriedade do diretório; o git só é consultado se a leitura direta não resolver.
function commitPelosArquivos(raiz) {
  const dirGit = diretorioGit(raiz);
  if (!dirGit) return null;
  const head = lerTexto(path.join(dirGit, "HEAD"));
  if (!head) return null;
  if (RE_COMMIT.test(head)) return head;
  const ref = head.match(/^ref:\s*(.+)$/);
  return ref ? resolverRef(dirGit, ref[1].trim()) : null;
}

function commitPeloGit(raiz) {
  try {
    const saida = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: raiz,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    return RE_COMMIT.test(saida) ? saida : null;
  } catch {
    return null;
  }
}

function resolverCommitEmExecucao(raiz = RAIZ_REPOSITORIO) {
  return commitPelosArquivos(raiz) || commitPeloGit(raiz);
}

// Capturado uma única vez ao iniciar o processo: identifica o código que este processo carregou,
// mesmo que o checkout seja trocado depois por um deploy.
const COMMIT_EM_EXECUCAO = resolverCommitEmExecucao();

module.exports = { COMMIT_EM_EXECUCAO, resolverCommitEmExecucao };
