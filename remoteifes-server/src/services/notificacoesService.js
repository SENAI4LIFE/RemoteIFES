const db = require("../config/database");

function criar({ tipo, sala = null, mensagem }) {
  db.prepare(`
    INSERT INTO notificacoes (tipo, sala, mensagem)
    VALUES (?, ?, ?)
  `).run(tipo, sala, mensagem);
}

function criarEspOffline(sala, nomeSala) {
  criar({
    tipo: "esp32_offline",
    sala,
    mensagem: `O ESP32 da sala ${sala} (${nomeSala}) ficou offline.`,
  });
}

function listar({ limite = 50 } = {}) {
  return db.prepare(`
    SELECT * FROM notificacoes ORDER BY criadoEm DESC LIMIT ?
  `).all(limite);
}

function contarNaoLidas() {
  const linha = db.prepare(`SELECT COUNT(*) AS total FROM notificacoes WHERE lida = 0`).get();
  return linha ? linha.total : 0;
}

function marcarLida(id) {
  db.prepare(`UPDATE notificacoes SET lida = 1 WHERE id = ?`).run(id);
}

function marcarTodasLidas() {
  db.prepare(`UPDATE notificacoes SET lida = 1 WHERE lida = 0`).run();
}

module.exports = {
  criar,
  criarEspOffline,
  listar,
  contarNaoLidas,
  marcarLida,
  marcarTodasLidas,
};
