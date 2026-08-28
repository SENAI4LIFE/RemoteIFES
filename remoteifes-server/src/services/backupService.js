const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { CAMINHO_DB, DIR_BACKUPS } = require("../config/paths");
const logger = require("../utils/logger");

const PREFIXO = "remoteifes-";
const SUFIXO = ".db";
const RE_BACKUP = /^remoteifes-\d{8}-\d{6}-[0-9a-f]{6}(?:-[a-z0-9-]+)?\.db$/;
const RE_PRE_RESTAURACAO = /^pre-restauracao-\d{8}-\d{6}-[0-9a-f]{6}\.db$/;
const TABELAS_ESSENCIAIS = ["usuarios", "salas", "configuracoes", "agendamentos", "relatos"];
const TMP_STALE_MS = 10 * 60 * 1000;
const PRE_RESTAURACAO_MANTER = 5;

function normalizarInteiro(valor, padrao, min, max) {
  if (valor === undefined || valor === null || valor === "") return padrao;
  if (!/^\d+$/.test(String(valor).trim())) return padrao;
  const n = Number(valor);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : padrao;
}

const RETENCAO_PADRAO = normalizarInteiro(process.env.BACKUP_RETENCAO, 14, 1, 3650);

function conexaoAtiva() {
  return require("../config/database");
}

function carimboDeData(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function sanitizarRotulo(rotulo) {
  if (!rotulo) return "";
  const limpo = String(rotulo).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return limpo ? `-${limpo}` : "";
}

function aspasSqlite(caminho) {
  return `'${caminho.replace(/'/g, "''")}'`;
}

function fsyncCaminho(alvo) {
  let fd;
  try {
    fd = fs.openSync(alvo, "r");
    fs.fsyncSync(fd);
  } catch (erro) {
    if (erro.code !== "EISDIR" && erro.code !== "EPERM" && erro.code !== "EINVAL" && erro.code !== "EACCES") {
      logger.warn("backup-fsync-falhou", { alvo: path.basename(alvo), mensagem: erro.message });
    }
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function verificarArquivoBackup(arquivo) {
  if (!fs.existsSync(arquivo) || fs.statSync(arquivo).size === 0) {
    throw new Error(`arquivo de backup ausente ou vazio: ${arquivo}`);
  }
  const conexao = new DatabaseSync(arquivo, { readOnly: true });
  try {
    const integridade = conexao.prepare("PRAGMA integrity_check").all();
    const integro = integridade.length === 1 && integridade[0].integrity_check === "ok";
    if (!integro) {
      throw new Error(`integrity_check falhou: ${integridade.map((l) => l.integrity_check).join("; ")}`);
    }
    if (conexao.prepare("PRAGMA foreign_key_check").all().length > 0) {
      throw new Error("foreign_key_check encontrou referências inválidas no backup");
    }
    for (const tabela of TABELAS_ESSENCIAIS) {
      conexao.prepare(`SELECT 1 FROM ${tabela} LIMIT 1`).get();
    }
    const { total } = conexao.prepare("SELECT COUNT(*) total FROM usuarios").get();
    if (!Number.isInteger(total) || total < 1) {
      throw new Error("backup não contém nenhum usuário — provavelmente corrompido ou incompleto");
    }
  } finally {
    conexao.close();
  }
  return true;
}

function listarComPadrao(dir, regex) {
  let nomes;
  try {
    nomes = fs.readdirSync(dir);
  } catch (erro) {
    if (erro.code === "ENOENT") return [];
    throw erro;
  }
  return nomes
    .filter((nome) => regex.test(nome))
    .map((nome) => {
      const completo = path.join(dir, nome);
      const info = fs.statSync(completo);
      return { arquivo: completo, nome, bytes: info.size, modificadoEm: info.mtime.toISOString(), mtimeMs: info.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || (a.nome < b.nome ? 1 : a.nome > b.nome ? -1 : 0));
}

function listarBackups(dir = DIR_BACKUPS) {
  return listarComPadrao(dir, RE_BACKUP);
}

function rotacionar(dir = DIR_BACKUPS, reter = RETENCAO_PADRAO, protegidos = []) {
  const limite = Number.isSafeInteger(reter) && reter >= 1 ? reter : RETENCAO_PADRAO;
  const preservar = new Set(protegidos);
  const removidos = [];
  let mantidos = 0;
  for (const backup of listarBackups(dir)) {
    if (mantidos < limite || preservar.has(backup.nome)) {
      mantidos += 1;
      continue;
    }
    try {
      fs.rmSync(backup.arquivo, { force: true });
      removidos.push(backup.nome);
    } catch (erro) {
      logger.warn("backup-rotacao-falhou", { arquivo: backup.nome, mensagem: erro.message });
    }
  }
  return removidos;
}

function limparTemporariosOrfaos(dir) {
  let nomes;
  try {
    nomes = fs.readdirSync(dir);
  } catch {
    return;
  }
  const agora = Date.now();
  for (const nome of nomes) {
    if (!nome.startsWith(".tmp-") && !nome.includes(".incoming-")) continue;
    const completo = path.join(dir, nome);
    try {
      if (agora - fs.statSync(completo).mtimeMs > TMP_STALE_MS) {
        fs.rmSync(completo, { force: true });
      }
    } catch {}
  }
}

function snapshotConsistente(conexao, destino) {
  conexao.exec(`VACUUM INTO ${aspasSqlite(destino)}`);
}

function tokenUnico() {
  return crypto.randomBytes(3).toString("hex");
}

function criarBackup({ dir = DIR_BACKUPS, reter = RETENCAO_PADRAO, rotulo, conexao } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  limparTemporariosOrfaos(dir);

  const marca = carimboDeData();
  const nomeDestino = `${PREFIXO}${marca}-${tokenUnico()}${sanitizarRotulo(rotulo)}${SUFIXO}`;
  const destino = path.join(dir, nomeDestino);
  const temporario = path.join(dir, `.tmp-${marca}-${process.pid}-${tokenUnico()}${SUFIXO}`);
  fs.rmSync(temporario, { force: true });

  try {
    snapshotConsistente(conexao || conexaoAtiva(), temporario);
    verificarArquivoBackup(temporario);
    fs.chmodSync(temporario, 0o600);
    fsyncCaminho(temporario);
    fs.renameSync(temporario, destino);
    fsyncCaminho(dir);
  } catch (erro) {
    fs.rmSync(temporario, { force: true });
    throw erro;
  }

  const bytes = fs.statSync(destino).size;
  const removidos = rotacionar(dir, reter, [nomeDestino]);
  logger.info("backup-criado", { arquivo: nomeDestino, bytes, removidos: removidos.length });
  return { arquivo: destino, bytes, removidos };
}

function snapshotDoBancoAtual(destinoBanco, destinoSnapshot) {
  const atual = new DatabaseSync(destinoBanco);
  try {
    try {
      atual.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {}
    snapshotConsistente(atual, destinoSnapshot);
  } finally {
    atual.close();
  }
  verificarArquivoBackup(destinoSnapshot);
}

function removerLaterais(destinoBanco) {
  for (const lateral of [`${destinoBanco}-wal`, `${destinoBanco}-shm`]) {
    fs.rmSync(lateral, { force: true });
  }
}

function restaurarBackup(arquivo, { destino = CAMINHO_DB, dirSeguranca = DIR_BACKUPS } = {}) {
  if (destino === ":memory:") {
    throw new Error("não é possível restaurar sobre um banco em memória");
  }
  const origem = path.resolve(arquivo);
  verificarArquivoBackup(origem);

  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.mkdirSync(dirSeguranca, { recursive: true, mode: 0o700 });
  limparTemporariosOrfaos(dirSeguranca);

  let copiaSeguranca = null;
  if (fs.existsSync(destino) && fs.statSync(destino).size > 0) {
    copiaSeguranca = path.join(dirSeguranca, `pre-restauracao-${carimboDeData()}-${tokenUnico()}${SUFIXO}`);
    try {
      snapshotDoBancoAtual(destino, copiaSeguranca);
      fs.chmodSync(copiaSeguranca, 0o600);
    } catch (erro) {
      fs.rmSync(copiaSeguranca, { force: true });
      throw new Error(
        `não foi possível criar uma cópia de segurança verificada do banco atual (${erro.message}); ` +
          "restauração abortada. Confirme que o servidor está parado e tente novamente."
      );
    }
  }

  const entrando = `${destino}.incoming-${tokenUnico()}`;
  try {
    fs.copyFileSync(origem, entrando);
    fs.chmodSync(entrando, 0o600);
    fsyncCaminho(entrando);
    verificarArquivoBackup(entrando);
    removerLaterais(destino);
    fs.renameSync(entrando, destino);
    fsyncCaminho(path.dirname(destino));
  } catch (erro) {
    fs.rmSync(entrando, { force: true });
    throw new Error(`não foi possível instalar o backup: ${erro.message}`, { cause: erro });
  }

  try {
    verificarArquivoBackup(destino);
  } catch (erro) {
    if (copiaSeguranca) {
      const rollback = `${destino}.rollback-${tokenUnico()}`;
      try {
        fs.copyFileSync(copiaSeguranca, rollback);
        fsyncCaminho(rollback);
        verificarArquivoBackup(rollback);
        removerLaterais(destino);
        fs.renameSync(rollback, destino);
        fsyncCaminho(path.dirname(destino));
      } catch (rollbackErro) {
        fs.rmSync(rollback, { force: true });
        throw new Error(
          `o banco restaurado não passou na verificação (${erro.message}) e o rollback também falhou (${rollbackErro.message})`,
          { cause: erro }
        );
      }
      throw new Error(
        `o banco restaurado não passou na verificação (${erro.message}); ` +
          `o banco anterior foi recolocado a partir de ${path.basename(copiaSeguranca)}.`
      );
    }
    throw erro;
  }

  podarPreRestauracao(dirSeguranca);

  logger.info("backup-restaurado", {
    origem: path.basename(origem),
    copiaSeguranca: copiaSeguranca ? path.basename(copiaSeguranca) : null,
  });
  return { destino, copiaSeguranca };
}

function podarPreRestauracao(dir = DIR_BACKUPS) {
  for (const antigo of listarComPadrao(dir, RE_PRE_RESTAURACAO).slice(PRE_RESTAURACAO_MANTER)) {
    fs.rmSync(antigo.arquivo, { force: true });
  }
}

module.exports = {
  criarBackup,
  restaurarBackup,
  verificarArquivoBackup,
  listarBackups,
  rotacionar,
  normalizarInteiro,
  DIR_BACKUPS,
  RETENCAO_PADRAO,
};
