const fs = require("fs");
const path = require("path");

const API_URL = process.env.E2E_API_URL || "http://127.0.0.1:8791";
const ARQUIVO_TOKENS = path.join(__dirname, ".tokens.json");

const CREDENCIAIS = {
  superadmin: { usuario: "admin", senha: "admin" },
  admin: { usuario: "e2e_admin", senha: "e2e-admin-pass-123" },
  user: { usuario: "e2e_user", senha: "e2e-user-pass-123" },
  readonly: { usuario: "e2e_readonly", senha: "e2e-readonly-123" },
};

module.exports = async () => {
  let pronto = false;
  for (let i = 0; i < 120 && !pronto; i += 1) {
    try {
      const r = await fetch(`${API_URL}/health`);
      pronto = r.ok;
    } catch (e) {}
    if (!pronto) await new Promise((res) => setTimeout(res, 500));
  }
  if (!pronto) throw new Error(`servidor de teste não respondeu em ${API_URL}/health`);

  const tokens = {};
  for (const [papel, cred] of Object.entries(CREDENCIAIS)) {
    const resp = await fetch(`${API_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cred),
    });
    if (!resp.ok) throw new Error(`login de "${papel}" falhou no global-setup (HTTP ${resp.status})`);
    const corpo = await resp.json();
    if (!corpo.token) throw new Error(`login de "${papel}" não retornou token`);
    tokens[papel] = corpo.token;
  }

  fs.writeFileSync(ARQUIVO_TOKENS, JSON.stringify(tokens, null, 2));
};
