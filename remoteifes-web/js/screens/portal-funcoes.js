const PORTAL_FUNCOES = {
  salas: {
    icon: "🌡️",
    titulo: "Salas",
    texto: "Veja as salas do campus, o status do ar-condicionado de cada uma e ligue ou desligue remotamente.",
  },
  planta: {
    icon: "🏢",
    titulo: "Planta Baixa",
    texto: "Visualize o mapa dos blocos e andares para localizar rapidamente cada sala e seu equipamento.",
  },
  agenda: {
    icon: "🗓️",
    titulo: "Agenda",
    texto: "Programe horários de ligar e desligar o ar-condicionado das salas de acordo com o uso do campus.",
  },
  grade: {
    icon: "📈",
    titulo: "Grade",
    texto: "Acompanhe em um painel único o status de todas as salas monitoradas ao mesmo tempo.",
  },
  admin: {
    icon: "🔧",
    titulo: "Admin",
    texto: "Gerencie usuários, permissões e configurações gerais do sistema RemoteIFES.",
  },
};

const PORTAL_FUNCAO_PLACEHOLDER = {
  icon: "ℹ️",
  titulo: "Selecione uma função",
  texto: "Toque em um dos ícones acima para ver do que se trata.",
};

const portalFuncaoBotoes = document.querySelectorAll(".portal-funcao");
const portalFuncaoDetalhe = document.getElementById("portalFuncaoDetalhe");
const portalFuncaoDetalheIcon = document.getElementById("portalFuncaoDetalheIcon");
const portalFuncaoDetalheTitulo = document.getElementById("portalFuncaoDetalheTitulo");
const portalFuncaoDetalheTexto = document.getElementById("portalFuncaoDetalheTexto");

function exibirPortalFuncaoDetalhe(info) {
  portalFuncaoDetalheIcon.textContent = info.icon;
  portalFuncaoDetalheTitulo.textContent = info.titulo;
  portalFuncaoDetalheTexto.textContent = info.texto;
}

function limparPortalFuncaoAtiva() {
  portalFuncaoBotoes.forEach((btn) => btn.classList.remove("is-active"));
  exibirPortalFuncaoDetalhe(PORTAL_FUNCAO_PLACEHOLDER);
}

portalFuncaoBotoes.forEach((btn) => {
  btn.addEventListener("click", () => {
    const jaAtivo = btn.classList.contains("is-active");
    limparPortalFuncaoAtiva();
    if (jaAtivo) return;

    const info = PORTAL_FUNCOES[btn.dataset.funcao];
    if (!info) return;

    btn.classList.add("is-active");
    exibirPortalFuncaoDetalhe(info);
  });
});
