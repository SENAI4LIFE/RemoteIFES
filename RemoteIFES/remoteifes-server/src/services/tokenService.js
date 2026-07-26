const crypto = require("crypto");
const db = require("../config/database");

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
    WHERE s.token = ? AND u.ativo = 1
  `).get(token);

  if (!sessao) return null;

  db.prepare(`UPDATE sessoes SET ultimoUso = datetime('now') WHERE token = ?`).run(token);
  return sessao;
}

function removerToken(token) {
  db.prepare(`DELETE FROM sessoes WHERE token = ?`).run(token);
}

function removerSessoesDoUsuario(usuarioId) {
  db.prepare(`DELETE FROM sessoes WHERE usuarioId = ?`).run(usuarioId);
}

function listarSessoesAtivas() {
  return db.prepare(`
    SELECT u.usuario, u.nome, u.isAdmin, s.criadoEm, s.ultimoUso
    FROM sessoes s
    JOIN usuarios u ON u.id = s.usuarioId
    ORDER BY s.ultimoUso DESC
  `).all();
}

module.exports = {
  gerarToken,
  validarToken,
  removerToken,
  removerSessoesDoUsuario,
  listarSessoesAtivas,
};
