const HelpContent = {
  cards: { titulo: "Como usar: Modo cards", itens: [{ titulo: "Bloco, andar e sala", texto: "Toque nos ícones grandes, em três passos, até chegar à sala desejada." }, { titulo: "Cores", texto: "Cinza indica offline, azul indica desligado, verde indica ligado e o contorno destaca reserva." }] },
  localizacao: { titulo: "Como usar: Selecionar ambiente", itens: [{ titulo: "Seleção", texto: "Escolha bloco e andar e abra a lista ou a planta baixa." }] },
  planta: { titulo: "Como usar: Planta baixa", itens: [{ titulo: "Salas", texto: "Toque em uma sala colorida para abrir o painel; use zoom e rolagem quando necessário." }] },
  salas: { titulo: "Como usar: Lista de salas", itens: [{ titulo: "Status", texto: "Cada item informa conexão, energia, reserva e se o acesso é apenas para visualização." }] },
  painel: { titulo: "Como usar: Painel de controle", itens: [{ titulo: "Comandos", texto: "Power, temperatura e Turbo respeitam conexão, reservas, limites e permissões do servidor." }] },
  propriedade: { titulo: "Como usar: Configurações de sala", itens: [{ titulo: "Proprietário", texto: "Conceda ou revogue o controle apenas das salas que um administrador atribuiu a você." }] },
};

const MANUAL_SECAO_POR_AJUDA = {
  cards: "selecao-sala", localizacao: "selecao-sala", planta: "selecao-sala", salas: "selecao-sala", painel: "controlador",
  agenda: "agenda-grade", grade: "agenda-grade", usuarios: "administracao", ativos: "administracao", sessoes: "administracao",
  logs: "administracao", dispositivos: "administracao", acessos: "administracao", proprietarios: "administracao", propriedade: "papeis",
  mapa: "administracao", macs: "esp32-cadastro", config: "operacao-admin", esp32: "esp32-avancado", monitoramento: "monitoramento",
};

const RoleDocumentation = (() => {
  let assinatura = null;
  let secoesPrivadas = [];
  let ajudaPrivada = {};
  let carregando = null;
  function assinaturaAtual() { return `${state.usuario || ""}|${state.nivel || 1}`; }
  async function carregar() {
    if (!state.usuario || !state.isAdmin) return;
    const atual = assinaturaAtual();
    if (assinatura === atual) return;
    if (!carregando) {
      carregando = Api.documentacao().then((resp) => {
        if (resp && resp.ok) {
          secoesPrivadas = Array.isArray(resp.secoes) ? resp.secoes : [];
          ajudaPrivada = resp.ajuda && typeof resp.ajuda === "object" ? resp.ajuda : {};
          assinatura = atual;
        }
      }).finally(() => { carregando = null; });
    }
    await carregando;
  }
  function limpar() { assinatura = null; secoesPrivadas = []; ajudaPrivada = {}; carregando = null; }
  return { carregar, limpar, secoes: () => secoesPrivadas, ajuda: (chave) => ajudaPrivada[chave] || null };
})();

const Help = {
  _elementoAnterior: null,
  async abrir(chave) {
    await RoleDocumentation.carregar();
    const dados = HelpContent[chave] || RoleDocumentation.ajuda(chave);
    if (!dados) return;
    document.getElementById("helpModalTitle").textContent = dados.titulo;
    document.getElementById("helpModalList").innerHTML = dados.itens.map((item) => `<li><strong>${escapeHtml(item.titulo)}:</strong> ${escapeHtml(item.texto)}</li>`).join("");
    const manualBtn = document.getElementById("helpModalManualBtn");
    if (manualBtn) {
      const secao = MANUAL_SECAO_POR_AJUDA[chave] || null;
      manualBtn.classList.toggle("hidden", !secao || typeof Manual === "undefined");
      manualBtn.dataset.secao = secao || "";
    }
    this._elementoAnterior = document.activeElement;
    document.getElementById("helpModal").classList.remove("hidden");
    document.getElementById("helpModalCloseBtn").focus();
  },
  fechar() {
    document.getElementById("helpModal").classList.add("hidden");
    const anterior = this._elementoAnterior;
    this._elementoAnterior = null;
    if (anterior && typeof anterior.focus === "function") anterior.focus();
  },
};

document.querySelectorAll(".help-icon-btn[data-help]").forEach((btn) => btn.addEventListener("click", () => Help.abrir(btn.dataset.help)));
const helpModalManualBtn = document.getElementById("helpModalManualBtn");
if (helpModalManualBtn) helpModalManualBtn.addEventListener("click", () => {
  const secao = helpModalManualBtn.dataset.secao;
  Help.fechar();
  if (secao && typeof Manual !== "undefined") Manual.abrir(secao);
});
document.addEventListener("click", (event) => {
  const alvo = event.target.closest("[data-manual]");
  if (!alvo) return;
  event.preventDefault();
  if (typeof Manual !== "undefined") Manual.abrir(alvo.dataset.manual || null);
});
document.getElementById("helpModalCloseBtn").addEventListener("click", () => Help.fechar());
document.getElementById("helpModal").addEventListener("click", (event) => { if (event.target.id === "helpModal") Help.fechar(); });
document.getElementById("helpModal").addEventListener("keydown", (event) => {
  const modal = document.getElementById("helpModal");
  if (modal.classList.contains("hidden")) return;
  if (event.key === "Escape") return Help.fechar();
  if (event.key !== "Tab") return;
  const focaveis = Array.from(modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null);
  if (!focaveis.length) return;
  if (event.shiftKey && document.activeElement === focaveis[0]) { event.preventDefault(); focaveis[focaveis.length - 1].focus(); }
  else if (!event.shiftKey && document.activeElement === focaveis[focaveis.length - 1]) { event.preventDefault(); focaveis[0].focus(); }
});
