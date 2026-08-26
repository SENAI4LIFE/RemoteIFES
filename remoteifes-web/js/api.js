const SERVER_URL = (window.RemoteIFESConfig && window.RemoteIFESConfig.serverUrl) || "http://localhost:8080";
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
  let data;
  try {
    data = await res.json();
  } catch (err) {
    return { ok: false, erro: `resposta inválida do servidor (status ${res.status})` };
  }
  if (res.status === 503 && data && data.manutencao) {
    window.dispatchEvent(new CustomEvent("app:manutencao-ativa"));
  }
  return data;
}

const Api = {
  temTokenSalvo() {
    return !!authToken;
  },

  obterToken() {
    return authToken;
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

  async trocarNomeUsuario(id, novoNome) {
    return chamar(`/admin/usuarios/${id}/nome`, {
      method: "PATCH",
      headers: headersComToken({ "Content-Type": "application/json" }),
      body: JSON.stringify({ novoNome }),
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

  async listarLogs({ data, sala, andar } = {}) {
    const params = new URLSearchParams();
    if (data) params.set("data", data);
    if (sala) params.set("sala", sala);
    if (andar) params.set("andar", andar);
    const query = params.toString();
    return chamar(`/admin/logs${query ? `?${query}` : ""}`, { headers: headersComToken() });
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

  async listarSalasAdmin() {
    return chamar("/admin/salas", { headers: headersComToken() });
  },

  async cadastrarMac(sala, mac) {
    return chamar(`/admin/salas/${encodeURIComponent(sala)}/mac`, {
      method: "PATCH",
      headers: headersComToken({ "Content-Type": "application/json" }),
      body: JSON.stringify({ mac }),
    });
  },

  async definirPresetDaSala(sala, presetId) {
    return chamar(`/admin/salas/${encodeURIComponent(sala)}/preset`, {
      method: "PATCH",
      headers: headersComToken({ "Content-Type": "application/json" }),
      body: JSON.stringify({ presetId }),
    });
  },

  async acessarEsp32(sala) {
    return chamar(`/admin/salas/${encodeURIComponent(sala)}/acessar-esp32`, { headers: headersComToken() });
  },

  async infoTokenDispositivo(sala) {
    return chamar(`/admin/salas/${encodeURIComponent(sala)}/token`, { headers: headersComToken() });
  },

  async gerarTokenDispositivo(sala) {
    return chamar(`/admin/salas/${encodeURIComponent(sala)}/token`, { method: "POST", headers: headersComToken() });
  },

  async revogarTokenDispositivo(sala) {
    return chamar(`/admin/salas/${encodeURIComponent(sala)}/token`, { method: "DELETE", headers: headersComToken() });
  },

  async listarPresets() {
    return chamar("/admin/presets", { headers: headersComToken() });
  },

  async criarPreset(nome) {
    return chamar("/admin/presets", {
      method: "POST",
      headers: headersComToken({ "Content-Type": "application/json" }),
      body: JSON.stringify({ nome }),
    });
  },

  async removerPreset(id) {
    return chamar(`/admin/presets/${id}`, { method: "DELETE", headers: headersComToken() });
  },

  async adicionarFuncaoPreset(presetId, dados) {
    return chamar(`/admin/presets/${presetId}/funcoes`, {
      method: "POST",
      headers: headersComToken({ "Content-Type": "application/json" }),
      body: JSON.stringify(dados),
    });
  },

  async atualizarFuncaoPreset(funcaoId, dados) {
    return chamar(`/admin/presets/funcoes/${funcaoId}`, {
      method: "PATCH",
      headers: headersComToken({ "Content-Type": "application/json" }),
      body: JSON.stringify(dados),
    });
  },

  async removerFuncaoPreset(funcaoId) {
    return chamar(`/admin/presets/funcoes/${funcaoId}`, { method: "DELETE", headers: headersComToken() });
  },

  async listarPosicoesPreset() {
    return chamar("/admin/presets/posicoes", { headers: headersComToken() });
  },

  async listarDetectados() {
    return chamar("/admin/esp32/detectados", { headers: headersComToken() });
  },

  async removerDetectado(mac) {
    return chamar(`/admin/esp32/detectados/${encodeURIComponent(mac)}`, { method: "DELETE", headers: headersComToken() });
  },

  async definirAcessoRestrito(sala, restrito) {
    return chamar(`/admin/salas/${encodeURIComponent(sala)}/acesso-restrito`, {
      method: "PATCH",
      headers: headersComToken({ "Content-Type": "application/json" }),
      body: JSON.stringify({ restrito }),
    });
  },

  async listarAcessoSala(sala) {
    return chamar(`/admin/salas/${encodeURIComponent(sala)}/acesso`, { headers: headersComToken() });
  },

  async concederAcessoSala(sala, usuarioId) {
    return chamar(`/admin/salas/${encodeURIComponent(sala)}/acesso/${usuarioId}`, {
      method: "POST",
      headers: headersComToken(),
    });
  },

  async revogarAcessoSala(sala, usuarioId) {
    return chamar(`/admin/salas/${encodeURIComponent(sala)}/acesso/${usuarioId}`, {
      method: "DELETE",
      headers: headersComToken(),
    });
  },

  async listarDonosSala(sala) {
    return chamar(`/admin/salas/${encodeURIComponent(sala)}/donos`, { headers: headersComToken() });
  },

  async concederDonoSala(sala, usuarioId) {
    return chamar(`/admin/salas/${encodeURIComponent(sala)}/donos/${usuarioId}`, {
      method: "POST",
      headers: headersComToken(),
    });
  },

  async revogarDonoSala(sala, usuarioId) {
    return chamar(`/admin/salas/${encodeURIComponent(sala)}/donos/${usuarioId}`, {
      method: "DELETE",
      headers: headersComToken(),
    });
  },

  async minhasSalasPropriedade() {
    return chamar("/minhas-salas-propriedade", { headers: headersComToken() });
  },

  async listarCandidatosPropriedade(sala) {
    return chamar(`/salas/${encodeURIComponent(sala)}/proprietario/candidatos`, { headers: headersComToken() });
  },

  async listarAcessoPropriedade(sala) {
    return chamar(`/salas/${encodeURIComponent(sala)}/proprietario/acesso`, { headers: headersComToken() });
  },

  async concederAcessoPropriedade(sala, usuarioId) {
    return chamar(`/salas/${encodeURIComponent(sala)}/proprietario/acesso/${usuarioId}`, {
      method: "POST",
      headers: headersComToken(),
    });
  },

  async revogarAcessoPropriedade(sala, usuarioId) {
    return chamar(`/salas/${encodeURIComponent(sala)}/proprietario/acesso/${usuarioId}`, {
      method: "DELETE",
      headers: headersComToken(),
    });
  },

  async listarNotificacoes() {
    return chamar("/admin/notificacoes", { headers: headersComToken() });
  },

  async contarNotificacoesNaoLidas() {
    return chamar("/admin/notificacoes/contagem", { headers: headersComToken() });
  },

  async marcarNotificacaoLida(id) {
    return chamar(`/admin/notificacoes/${id}/lida`, { method: "POST", headers: headersComToken() });
  },

  async marcarTodasNotificacoesLidas() {
    return chamar("/admin/notificacoes/marcar-todas-lidas", { method: "POST", headers: headersComToken() });
  },

  async listarDispositivosEsp32() {
    return chamar("/admin/esp32/dispositivos", { headers: headersComToken() });
  },

  async estadoDispositivoEsp32(sala) {
    return chamar(`/admin/esp32/${encodeURIComponent(sala)}/estado`, { headers: headersComToken() });
  },

  async entrarConfigEsp32(sala, senha) {
    return chamar(`/admin/esp32/${encodeURIComponent(sala)}/entrar-config`, {
      method: "POST",
      headers: headersComToken({ "Content-Type": "application/json" }),
      body: JSON.stringify({ senha }),
    });
  },

  async sairOperacaoEsp32(sala) {
    return chamar(`/admin/esp32/${encodeURIComponent(sala)}/sair-operacao`, { method: "POST", headers: headersComToken() });
  },

  async definirModoEsp32(sala, modo) {
    return chamar(`/admin/esp32/${encodeURIComponent(sala)}/modo`, {
      method: "POST",
      headers: headersComToken({ "Content-Type": "application/json" }),
      body: JSON.stringify({ modo }),
    });
  },

  async iniciarCapturaEsp32(sala) {
    return chamar(`/admin/esp32/${encodeURIComponent(sala)}/captura/iniciar`, { method: "POST", headers: headersComToken() });
  },

  async pararCapturaEsp32(sala) {
    return chamar(`/admin/esp32/${encodeURIComponent(sala)}/captura/parar`, { method: "POST", headers: headersComToken() });
  },

  async testarRawEsp32(sala, raw, carrierHz) {
    return chamar(`/admin/esp32/${encodeURIComponent(sala)}/teste/raw`, {
      method: "POST",
      headers: headersComToken({ "Content-Type": "application/json" }),
      body: JSON.stringify({ raw, carrierHz }),
    });
  },

  async testarEstadoEsp32(sala, dados) {
    return chamar(`/admin/esp32/${encodeURIComponent(sala)}/teste/estado`, {
      method: "POST",
      headers: headersComToken({ "Content-Type": "application/json" }),
      body: JSON.stringify(dados),
    });
  },

  async resetarWifiEsp32(sala) {
    return chamar(`/admin/esp32/${encodeURIComponent(sala)}/reset-wifi`, { method: "POST", headers: headersComToken() });
  },
};
