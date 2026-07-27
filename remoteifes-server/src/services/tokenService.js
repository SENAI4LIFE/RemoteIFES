const crypto = require("crypto");
const db = require("../config/database");

const LIMIAR_ONLINE_MIN = 5;

function gerarToken(usuarioId) {
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare(`INSERT INTO sessoes (token, usuarioId) VALUES (?, ?)`).run(token, usuarioId);
  return token;
}

function validarToken(token) {
  const sessao = db.prepare(`
    SELECT s.token, u.*
    FROM sessoes s
    JOIN usuarios u ON u.id = s.usuarioId
    WHERE s.token = ? AND s.logout IS NULL AND u.ativo = 1
  `).get(token);

  if (!sessao) return null;

  db.prepare(`UPDATE sessoes SET ultimoUso = datetime('now') WHERE token = ?`).run(token);
  return sessao;
}

function removerToken(token) {
  db.prepare(`UPDATE sessoes SET logout = datetime('now') WHERE token = ? AND logout IS NULL`).run(token);
}

function removerSessoesDoUsuario(usuarioId) {
  db.prepare(`UPDATE sessoes SET logout = datetime('now') WHERE usuarioId = ? AND logout IS NULL`).run(usuarioId);
}

function listarUsuariosAtivos() {
  const linhas = db.prepare(`
    SELECT u.id, u.usuario, u.nome, u.isAdmin, MAX(s.ultimoUso) AS ultimoAcesso,
      (SELECT s2.logout FROM sessoes s2 WHERE s2.usuarioId = u.id ORDER BY s2.ultimoUso DESC LIMIT 1) AS logoutMaisRecente
    FROM usuarios u
    JOIN sessoes s ON s.usuarioId = u.id
    GROUP BY u.id
    ORDER BY ultimoAcesso DESC
  `).all();

  return linhas.map((l) => {
    const minutosAtras = (Date.now() - new Date(l.ultimoAcesso.replace(" ", "T") + "Z").getTime()) / 60000;
    const online = !l.logoutMaisRecente && minutosAtras <= LIMIAR_ONLINE_MIN;
    return {
      usuario: l.usuario,
      nome: l.nome,
      isAdmin: !!l.isAdmin,
      ultimoAcesso: l.ultimoAcesso,
      online,
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
  return db.prepare(query).all(...params);
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
  listarUsuariosAtivos,
  listarHistoricoSessoes,
  apagarHistoricoSessoes,
};
