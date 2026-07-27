const crypto = require("crypto");
const db = require("../config/database");
const configuracoesService = require("./configuracoesService");
const { paraEpochMs } = require("../utils/tempo");

const NIVEL_ADMIN = 2;

function gerarToken(usuarioId) {
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare(`INSERT INTO sessoes (token, usuarioId) VALUES (?, ?)`).run(token, usuarioId);
  return token;
}

function validarToken(token) {
  const sessao = db.prepare(`
    SELECT s.token, s.ultimoUso, u.*
    FROM sessoes s
    JOIN usuarios u ON u.id = s.usuarioId
    WHERE s.token = ? AND s.logout IS NULL AND u.ativo = 1
  `).get(token);

  if (!sessao) return null;

  const timeoutMinutos = configuracoesService.timeoutEfetivoParaUsuario(sessao.nivel >= NIVEL_ADMIN);
  if (timeoutMinutos) {
    const minutosInativo = (Date.now() - paraEpochMs(sessao.ultimoUso)) / 60000;
    if (minutosInativo > timeoutMinutos) {
      removerToken(token);
      return null;
    }
  }

  db.prepare(`UPDATE sessoes SET ultimoUso = datetime('now') WHERE token = ?`).run(token);
  return sessao;
}

function removerToken(token) {
  db.prepare(`UPDATE sessoes SET logout = datetime('now') WHERE token = ? AND logout IS NULL`).run(token);
}

function removerSessoesDoUsuario(usuarioId) {
  db.prepare(`UPDATE sessoes SET logout = datetime('now') WHERE usuarioId = ? AND logout IS NULL`).run(usuarioId);
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

function listarHistoricoSessoes({ data } = {}) {
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
  query += " ORDER BY s.login DESC";
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
  encerrarSessoesAbandonadas,
  listarUsuariosAtivos,
  listarHistoricoSessoes,
  apagarHistoricoSessoes,
};
