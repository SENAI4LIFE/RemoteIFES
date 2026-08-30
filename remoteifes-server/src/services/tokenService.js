const crypto = require("crypto");
const db = require("../config/database");
const configuracoesService = require("./configuracoesService");
const { paraEpochMs } = require("../utils/tempo");

const NIVEL_ADMIN = 2;
const SESSAO_MAX_HORAS_PADRAO = 12;

function sessaoMaxHoras() {
  const valor = Number(process.env.SESSAO_MAX_HORAS || SESSAO_MAX_HORAS_PADRAO);
  return Number.isFinite(valor) && valor > 0 && valor <= 168 ? valor : SESSAO_MAX_HORAS_PADRAO;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function gerarToken(usuarioId) {
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare(`INSERT INTO sessoes (token, usuarioId) VALUES (?, ?)`).run(hashToken(token), usuarioId);
  return token;
}

function detalhesSessao(sessao, baseInatividadeMs = Date.now()) {
  const timeoutInatividadeMinutos = configuracoesService.timeoutEfetivoParaUsuario(sessao.nivel >= NIVEL_ADMIN);
  const expiraAbsoluta = paraEpochMs(sessao.login) + sessaoMaxHoras() * 3600000;
  const expiraInatividade = baseInatividadeMs + timeoutInatividadeMinutos * 60000;
  return {
    timeoutInatividadeMinutos,
    sessaoExpiraEm: new Date(Math.min(expiraAbsoluta, expiraInatividade)).toISOString(),
    servidorAgora: new Date().toISOString(),
  };
}

function validarToken(token, { atualizarUso = true } = {}) {
  const tokenHash = hashToken(token);
  const sessao = db.prepare(`
    SELECT s.token, s.login, s.ultimoUso, u.*
    FROM sessoes s
    JOIN usuarios u ON u.id = s.usuarioId
    WHERE s.token = ? AND s.logout IS NULL AND u.ativo = 1
  `).get(tokenHash);

  if (!sessao) return null;

  const idadeHoras = (Date.now() - paraEpochMs(sessao.login)) / 3600000;
  if (idadeHoras > sessaoMaxHoras()) {
    removerToken(token);
    return null;
  }

  const timeoutMinutos = configuracoesService.timeoutEfetivoParaUsuario(sessao.nivel >= NIVEL_ADMIN);
  if (timeoutMinutos) {
    const minutosInativo = (Date.now() - paraEpochMs(sessao.ultimoUso)) / 60000;
    if (minutosInativo > timeoutMinutos) {
      removerToken(token);
      return null;
    }
  }

  const agora = Date.now();
  if (atualizarUso) {
    db.prepare(`UPDATE sessoes SET ultimoUso = datetime('now') WHERE token = ?`).run(tokenHash);
  }
  Object.assign(sessao, detalhesSessao(sessao, atualizarUso ? agora : paraEpochMs(sessao.ultimoUso)));
  return sessao;
}

function removerToken(token) {
  db.prepare(`UPDATE sessoes SET logout = datetime('now') WHERE token = ? AND logout IS NULL`).run(hashToken(token));
}

function removerSessoesDoUsuario(usuarioId) {
  db.prepare(`UPDATE sessoes SET logout = datetime('now') WHERE usuarioId = ? AND logout IS NULL`).run(usuarioId);
}

function encerrarSessoesAtivasNoInicio() {
  db.prepare(`UPDATE sessoes SET logout = datetime('now') WHERE logout IS NULL`).run();
}

const HORAS_SESSAO_ABANDONADA = 24;

function encerrarSessoesAbandonadas() {
  db.prepare(`
    UPDATE sessoes SET logout = datetime('now')
    WHERE logout IS NULL AND ultimoUso < datetime('now', '-${HORAS_SESSAO_ABANDONADA} hours')
  `).run();
}

function listarUsuariosAtivos() {
  const { limiarOnlineMinutos } = configuracoesService.obter();

  const linhas = db.prepare(`
    SELECT u.id, u.usuario, u.nome, u.isAdmin,
      (SELECT s2.login FROM sessoes s2 WHERE s2.usuarioId = u.id AND s2.logout IS NULL ORDER BY s2.login DESC LIMIT 1) AS loginAtivo,
      (SELECT s2.ultimoUso FROM sessoes s2 WHERE s2.usuarioId = u.id AND s2.logout IS NULL ORDER BY s2.login DESC LIMIT 1) AS ultimoUsoAtivo,
      (SELECT MAX(s3.ultimoUso) FROM sessoes s3 WHERE s3.usuarioId = u.id) AS ultimoAcesso
    FROM usuarios u
    WHERE EXISTS (SELECT 1 FROM sessoes s4 WHERE s4.usuarioId = u.id)
    ORDER BY COALESCE(ultimoUsoAtivo, ultimoAcesso) DESC
  `).all();

  return linhas.map((l) => {
    let status = "offline";
    if (l.loginAtivo) {
      const minutosInativo = l.ultimoUsoAtivo
        ? (Date.now() - paraEpochMs(l.ultimoUsoAtivo)) / 60000
        : Infinity;
      status = minutosInativo <= limiarOnlineMinutos ? "online" : "inativo";
    }
    return {
      usuario: l.usuario,
      nome: l.nome,
      isAdmin: !!l.isAdmin,
      ultimoAcesso: l.ultimoAcesso,
      status,
      sessaoLoginEm: l.loginAtivo || null,
    };
  });
}

function listarHistoricoSessoes({ data, limite = 500 } = {}) {
  const max = Number.isInteger(limite) && limite > 0 && limite <= 2000 ? limite : 500;
  let query = `
    SELECT u.usuario, u.nome, s.login, s.logout
    FROM sessoes s
    JOIN usuarios u ON u.id = s.usuarioId
    WHERE 1=1
  `;
  const params = [];
  if (data) {
    query += " AND date(s.login) = ?";
    params.push(data);
  }
  query += " ORDER BY s.login DESC LIMIT ?";
  params.push(max);
  const linhas = db.prepare(query).all(...params);

  return linhas.map((l) => {
    const inicioMs = paraEpochMs(l.login);
    const fimMs = l.logout ? paraEpochMs(l.logout) : Date.now();
    return {
      ...l,
      duracaoSegundos: Math.max(0, Math.round((fimMs - inicioMs) / 1000)),
      emAndamento: !l.logout,
    };
  });
}

function apagarHistoricoSessoes({ data } = {}) {
  if (data) {
    db.prepare(`DELETE FROM sessoes WHERE logout IS NOT NULL AND date(login) = ?`).run(data);
  } else {
    db.prepare(`DELETE FROM sessoes WHERE logout IS NOT NULL`).run();
  }
}

module.exports = {
  gerarToken,
  validarToken,
  removerToken,
  removerSessoesDoUsuario,
  encerrarSessoesAtivasNoInicio,
  encerrarSessoesAbandonadas,
  listarUsuariosAtivos,
  listarHistoricoSessoes,
  apagarHistoricoSessoes,
  detalhesSessao,
};
