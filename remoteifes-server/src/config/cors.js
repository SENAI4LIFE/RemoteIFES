const logger = require("../utils/logger");

// CORS_ORIGIN, parsed in one place for the HTTP API (app.js) and the browser WebSocket
// (statusHub.js).
//
// Until 2026-10 .env.example carried these two origins as an active line, and setup.sh copies that
// template to .env. Installations created from it therefore trusted two domains this project does
// not control (one did not even resolve when checked, so anyone might register it): a page there
// could read API responses from browsers inside the authorized networks. They are dropped wherever CORS_ORIGIN is read, with a
// warning, so updating the code is enough to close it.
const ORIGENS_DO_MODELO_ANTIGO = new Set(["https://exemplo.com", "https://outro-exemplo.com"]);

let avisado = false;

function origensPermitidas(valor = process.env.CORS_ORIGIN) {
  const lista = String(valor || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ignoradas = lista.filter((origem) => ORIGENS_DO_MODELO_ANTIGO.has(origem));
  if (ignoradas.length && !avisado) {
    avisado = true;
    logger.warn("cors-origem-de-exemplo-ignorada", {
      origens: ignoradas,
      acao: "remova essas origens de CORS_ORIGIN no .env; deixe vazio na operação same-origin",
    });
  }
  return lista.filter((origem) => !ORIGENS_DO_MODELO_ANTIGO.has(origem));
}

module.exports = { origensPermitidas, ORIGENS_DO_MODELO_ANTIGO };
