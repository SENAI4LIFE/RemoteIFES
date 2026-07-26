const SERVER_URL = "http://localhost:8080";

let authToken = null;

function headersComToken(extra = {}) {
  return authToken ? { ...extra, Authorization: `Bearer ${authToken}` } : extra;
}

async function chamar(path, options = {}) {
  const res = await fetch(`${SERVER_URL}${path}`, options);
  return res.json();
}

const Api = {
  async login(usuario, senha) {
    const data = await chamar("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario, senha }),
    });
    if (data.ok) authToken = data.token;
    return data;
  },

  logout() {
    authToken = null;
  },

  async listarSalas({ bloco, andar } = {}) {
    const params = new URLSearchParams();
    if (bloco) params.set("bloco", bloco);
    if (andar) params.set("andar", andar);
    const query = params.toString();
    return chamar(`/salas${query ? `?${query}` : ""}`, { headers: headersComToken() });
  },

  async statusSala(sala) {
    return chamar(`/status?sala=${encodeURIComponent(sala)}`, { headers: headersComToken() });
  },

  async enviarComando(sala, cmd, valor) {
    return chamar("/comando", {
      method: "POST",
      headers: headersComToken({ "Content-Type": "application/json" }),
      body: JSON.stringify({ sala, cmd, ...(valor !== undefined ? { valor } : {}) }),
    });
  },

  async listarAgendamentos(sala) {
    return chamar(`/agendamentos?sala=${encodeURIComponent(sala)}`, { headers: headersComToken() });
  },

  async criarAgendamento(dados) {
    return chamar("/agendamentos", {
      method: "POST",
      headers: headersComToken({ "Content-Type": "application/json" }),
      body: JSON.stringify(dados),
    });
  },

  async alternarAgendamento(id, ativo) {
    return chamar(`/agendamentos/${id}`, {
      method: "PATCH",
      headers: headersComToken({ "Content-Type": "application/json" }),
      body: JSON.stringify({ ativo }),
    });
  },

  async removerAgendamento(id) {
    return chamar(`/agendamentos/${id}`, {
      method: "DELETE",
      headers: headersComToken(),
    });
  },

  // --- Administração ---

  async listarUsuarios() {
    return chamar("/admin/usuarios", { headers: headersComToken() });
  },

  async criarUsuario(dados) {
    return chamar("/admin/usuarios", {
      method: "POST",
      headers: headersComToken({ "Content-Type": "application/json" }),
      body: JSON.stringify(dados),
    });
  },

  async atualizarUsuario(id, dados) {
    return chamar(`/admin/usuarios/${id}`, {
      method: "PATCH",
      headers: headersComToken({ "Content-Type": "application/json" }),
      body: JSON.stringify(dados),
    });
  },

  async removerUsuario(id) {
    return chamar(`/admin/usuarios/${id}`, {
      method: "DELETE",
      headers: headersComToken(),
    });
  },

  async listarLogs() {
    return chamar("/admin/logs", { headers: headersComToken() });
  },

  async listarSessoesAtivas() {
    return chamar("/admin/sessoes", { headers: headersComToken() });
  },
};
