const SERVER_URL = "http://localhost:8080";
const CHAVE_TOKEN = "remoteifes_token";

let authToken = localStorage.getItem(CHAVE_TOKEN) || null;

function headersComToken(extra = {}) {
  return authToken ? { ...extra, Authorization: `Bearer ${authToken}` } : extra;
}

async function chamar(path, options = {}) {
  let res;
  try {
    res = await fetch(`${SERVER_URL}${path}`, options);
  } catch (err) {
    return { ok: false, erro: `não foi possível conectar ao servidor em ${SERVER_URL} (verifique se ele está rodando e acessível)` };
  }
  if (res.status === 401 && authToken) {
    authToken = null;
    localStorage.removeItem(CHAVE_TOKEN);
    window.dispatchEvent(new CustomEvent("app:sessao-expirada"));
  }
  try {
    return await res.json();
  } catch (err) {
    return { ok: false, erro: `resposta inválida do servidor (status ${res.status})` };
  }
}

const Api = {
  temTokenSalvo() {
    return !!authToken;
  },

  async me() {
    return chamar("/me", { headers: headersComToken() });
  },

  async login(usuario, senha) {
    const data = await chamar("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usuario, senha }),
    });
    if (data.ok) {
      authToken = data.token;
      localStorage.setItem(CHAVE_TOKEN, data.token);
    }
    return data;
  },

  async logout() {
    if (!authToken) return;
    try {
      await chamar("/logout", { method: "POST", headers: headersComToken() });
    } catch (err) {}
    authToken = null;
    localStorage.removeItem(CHAVE_TOKEN);
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
    const query = sala ? `?sala=${encodeURIComponent(sala)}` : "";
    return chamar(`/agendamentos${query}`, { headers: headersComToken() });
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

  async trocarLoginUsuario(id, novoLogin) {
    return chamar(`/admin/usuarios/${id}/login`, {
      method: "PATCH",
      headers: headersComToken({ "Content-Type": "application/json" }),
      body: JSON.stringify({ novoLogin }),
    });
  },

  async removerUsuario(id) {
    return chamar(`/admin/usuarios/${id}`, {
      method: "DELETE",
      headers: headersComToken(),
    });
  },

  async trocarSenhaUsuario(id, novaSenha) {
    return chamar(`/admin/usuarios/${id}/senha`, {
      method: "PATCH",
      headers: headersComToken({ "Content-Type": "application/json" }),
      body: JSON.stringify({ novaSenha }),
    });
  },

  async listarLogs(data) {
    const query = data ? `?data=${encodeURIComponent(data)}` : "";
    return chamar(`/admin/logs${query}`, { headers: headersComToken() });
  },

  async apagarLogs(data) {
    const query = data ? `?data=${encodeURIComponent(data)}` : "";
    return chamar(`/admin/logs${query}`, { method: "DELETE", headers: headersComToken() });
  },

  async listarUsuariosAtivos() {
    return chamar("/admin/sessoes", { headers: headersComToken() });
  },

  async listarHistoricoSessoes(data) {
    const query = data ? `?data=${encodeURIComponent(data)}` : "";
    return chamar(`/admin/sessoes/historico${query}`, { headers: headersComToken() });
  },

  async apagarHistoricoSessoes(data) {
    const query = data ? `?data=${encodeURIComponent(data)}` : "";
    return chamar(`/admin/sessoes/historico${query}`, { method: "DELETE", headers: headersComToken() });
  },

  async listarDispositivos({ sala, data } = {}) {
    const params = new URLSearchParams();
    if (sala) params.set("sala", sala);
    if (data) params.set("data", data);
    const query = params.toString();
    return chamar(`/admin/dispositivos${query ? `?${query}` : ""}`, { headers: headersComToken() });
  },

  async listarAcessosEsp({ sala, data } = {}) {
    const params = new URLSearchParams();
    if (sala) params.set("sala", sala);
    if (data) params.set("data", data);
    const query = params.toString();
    return chamar(`/admin/acessos${query ? `?${query}` : ""}`, { headers: headersComToken() });
  },

  async apagarAcessosEsp(data) {
    const query = data ? `?data=${encodeURIComponent(data)}` : "";
    return chamar(`/admin/acessos${query}`, { method: "DELETE", headers: headersComToken() });
  },

  async ping() {
    return chamar("/ping", { method: "POST", headers: headersComToken() });
  },

  async obterConfiguracoes() {
    return chamar("/admin/configuracoes", { headers: headersComToken() });
  },

  async atualizarConfiguracoes(dados) {
    return chamar("/admin/configuracoes", {
      method: "PATCH",
      headers: headersComToken({ "Content-Type": "application/json" }),
      body: JSON.stringify(dados),
    });
  },
};
