const PORTAL_FUNCOES = {
  salas: {
    icon: "termostato",
    tom: "tom-operacao",
    titulo: "Salas",
    texto: "Veja as salas do campus, o status do ar-condicionado de cada uma e ligue ou desligue remotamente.",
  },
  planta: {
    icon: "predio",
    tom: "tom-operacao",
    titulo: "Planta Baixa",
    texto: "Visualize o mapa dos blocos e andares para localizar rapidamente cada sala e seu equipamento.",
  },
  agenda: {
    icon: "agenda",
    tom: "tom-atencao",
    titulo: "Agenda",
    texto: "Programe horários de ligar e desligar o ar-condicionado das salas de acordo com o uso do campus.",
  },
  grade: {
    icon: "grade",
    tom: "tom-operacao",
    titulo: "Grade",
    texto: "Consulte, por sala e data, os períodos de aula livres, reservados e com o ar-condicionado ligado antes de agendar.",
  },
  admin: {
    icon: "ferramenta",
    tom: "tom-admin",
    titulo: "Admin",
    texto: "Gerencie usuários, permissões e configurações gerais do sistema RemoteIFES.",
  },
};

const PORTAL_FUNCAO_PLACEHOLDER = {
  icon: "info",
  tom: "tom-info",
  titulo: "Selecione uma função",
  texto: "Toque em um dos ícones acima para ver do que se trata.",
};

const portalFuncaoBotoes = document.querySelectorAll(".portal-funcao");
const portalFuncaoDetalhe = document.getElementById("portalFuncaoDetalhe");
const portalFuncaoDetalheIcon = document.getElementById("portalFuncaoDetalheIcon");
const portalFuncaoDetalheTitulo = document.getElementById("portalFuncaoDetalheTitulo");
const portalFuncaoDetalheTexto = document.getElementById("portalFuncaoDetalheTexto");

function exibirPortalFuncaoDetalhe(info) {
  Icones.aplicar(portalFuncaoDetalheIcon, info.icon, info.tom);
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
