const fs = require("fs");
const path = require("path");

const API_URL = process.env.E2E_API_URL || "http://127.0.0.1:8791";
const WEB_URL = process.env.E2E_WEB_URL || "http://127.0.0.1:8790";
const ARQUIVO_TOKENS = path.join(__dirname, ".tokens.json");

async function encerrar(url) {
  try {
    await fetch(`${url}/__e2e/encerrar`, { method: "POST" });
  } catch {}
}

module.exports = async () => {
  await Promise.all([encerrar(API_URL), encerrar(WEB_URL)]);
  fs.rmSync(ARQUIVO_TOKENS, { force: true });
};
