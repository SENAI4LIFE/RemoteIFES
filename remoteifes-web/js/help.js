const HelpContent = {
  cards: {
    titulo: "Como usar: Modo cards",
    itens: [
      { titulo: "Bloco, andar e sala", texto: "Toque nos ícones grandes, em três passos, até chegar à sala desejada." },
      { titulo: "Cores da sala", texto: "Cinza: offline. Azul: online, desligado. Verde: online, ligado. Contorno amarelo: reservada agora." },
      { titulo: "Trocar bloco/andar", texto: "Use o link no topo de cada passo para voltar e escolher outra opção." },
    ],
  },
  localizacao: {
    titulo: "Como usar: Selecionar ambiente",
    itens: [
      { titulo: "Bloco e andar", texto: "Escolha o bloco (A ou B) e o andar para carregar as salas correspondentes." },
      { titulo: "Ver salas", texto: "Abre a lista de salas do bloco/andar escolhido, com status de conexão e ligado/desligado." },
      { titulo: "Ver planta baixa", texto: "Abre o mapa visual do andar; salas coloridas podem ser controladas diretamente pelo mapa." },
    ],
  },
  planta: {
    titulo: "Como usar: Planta baixa",
    itens: [
      { titulo: "Salas coloridas", texto: "Possuem ar-condicionado controlado pelo sistema: toque para abrir o painel de controle." },
      { titulo: "Salas sem cor", texto: "Não possuem dispositivo cadastrado ainda." },
      { titulo: "Legenda", texto: "Offline (sem contato recente), online desligado, online ligado, e reservada agora (agendamento ativo)." },
      { titulo: "Abas", texto: "Alternam entre os blocos e andares disponíveis." },
      { titulo: "Ver como lista", texto: "Troca a visualização de mapa para uma lista simples de salas." },
    ],
  },
  salas: {
    titulo: "Como usar: Lista de salas",
    itens: [
      { titulo: "Status", texto: "O selo à direita indica se o dispositivo da sala está online ou offline." },
      { titulo: "agendada", texto: "A sala tem um agendamento ativo neste momento." },
      { titulo: "visualização", texto: "Você pode ver a sala, mas não tem permissão para controlá-la." },
      { titulo: "Abrir sala", texto: "Toque em qualquer item da lista para abrir o painel de controle." },
    ],
  },
  painel: {
    titulo: "Como usar: Painel de controle",
    itens: [
      { titulo: "Conexão do dispositivo", texto: "Mostra se o ESP32 da sala está online. Se estiver offline, comandos ficam salvos até ele reconectar." },
      { titulo: "Ar-condicionado", texto: "Estado atual (ligado/desligado) reportado pelo dispositivo." },
      { titulo: "Ligar/Desligar e temperatura", texto: "Enviam comandos imediatos para o ESP32 da sala; a temperatura respeita os limites mínimo e máximo da sala." },
      { titulo: "Turbo", texto: "Ativa o modo turbo do aparelho e, se configurada, uma função extra (ex.: oscilação). Disponível apenas com o ar-condicionado ligado." },
      { titulo: "Aviso de reserva", texto: "Se a sala estiver reservada por outro usuário, os controles ficam bloqueados até o fim do agendamento." },
      { titulo: "Apenas visualização", texto: "Alguns usuários podem ver o status da sala sem poder controlá-la." },
    ],
  },
  agenda: {
    titulo: "Como usar: Agendamentos",
    itens: [
      { titulo: "Apenas reservar", texto: "Bloqueia a sala para outros usuários no período, sem ligar o ar-condicionado automaticamente." },
      { titulo: "Reservar e ligar no período todo", texto: "A sala é reservada e o ar-condicionado liga durante todo o horário definido." },
      { titulo: "Reservar e ligar em intervalo", texto: "A sala fica reservada no período, mas o ar-condicionado só liga dentro do intervalo escolhido." },
      { titulo: "Temperatura", texto: "Temperatura alvo aplicada quando o ar-condicionado for ligado pelo agendamento." },
      { titulo: "Ativar/desativar", texto: "Um agendamento desativado não é executado, mas continua salvo para reativação futura." },
    ],
  },
  grade: {
    titulo: "Como usar: Grade do dia",
    itens: [
      { titulo: "Sala e data", texto: "Selecione a sala e o dia para ver a grade de horários." },
      { titulo: "Cores", texto: "Desligado, agendado (reservado mas ainda não ligado) e ligado, hora a hora." },
      { titulo: "Uso", texto: "Ajuda a identificar rapidamente conflitos de horário ou janelas livres para novos agendamentos." },
    ],
  },
  usuarios: {
    titulo: "Como usar: Usuários",
    itens: [
      { titulo: "Novo usuário", texto: "Cria um login com senha inicial; a permissão de controlar salas pode ser marcada na criação. O administrador principal também pode criar outro administrador." },
      { titulo: "Trocar nome / login / senha", texto: "Qualquer administrador altera o nome de exibição e o login; ao trocar a senha, as sessões abertas daquele usuário são encerradas." },
      { titulo: "Conceder/revogar admin", texto: "Somente o administrador principal pode promover ou rebaixar outros administradores." },
      { titulo: "Controlar salas", texto: "Define se o usuário pode ligar/desligar e ajustar temperatura, além de apenas visualizar." },
      { titulo: "Desativar", texto: "Impede o login do usuário sem apagar seu histórico." },
    ],
  },
  ativos: {
    titulo: "Como usar: Ativos",
    itens: [
      { titulo: "Status em tempo real", texto: "Online (em uso agora), inativo (sem interação recente) ou offline." },
      { titulo: "Tempo de sessão", texto: "Cronômetro desde o login, atualizado a cada segundo." },
    ],
  },
  sessoes: {
    titulo: "Como usar: Sessões",
    itens: [
      { titulo: "Filtrar por data", texto: "Mostra apenas as sessões iniciadas no dia escolhido." },
      { titulo: "Apagar histórico", texto: "Remove os registros de sessão da data selecionada ou de todo o sistema: ação irreversível." },
    ],
  },
  logs: {
    titulo: "Como usar: Logs",
    itens: [
      { titulo: "O que é registrado", texto: "Cada comando de ligar, desligar ou ajuste de temperatura enviado a uma sala." },
      { titulo: "Origem", texto: "Indica se o comando veio de um usuário, de um agendamento ou do próprio sistema." },
      { titulo: "Apagar logs", texto: "Remove os registros da data selecionada ou de todo o histórico: ação irreversível." },
    ],
  },
  dispositivos: {
    titulo: "Como usar: Dispositivos",
    itens: [
      { titulo: "Eventos de conexão", texto: "Registra sempre que um ESP32 fica online ou offline." },
      { titulo: "Filtrar por data", texto: "Mostra apenas os eventos ocorridos no dia escolhido." },
    ],
  },
  acessos: {
    titulo: "Como usar: Acessos ESP32",
    itens: [
      { titulo: "O que é registrado", texto: "Cada requisição feita por um ESP32 ao servidor, com o IP de origem." },
      { titulo: "Uso", texto: "Útil para diagnosticar problemas de rede ou identificar dispositivos com comportamento incomum." },
      { titulo: "Apagar acessos", texto: "Remove os registros da data selecionada ou de todo o histórico: ação irreversível." },
    ],
  },
  proprietarios: {
    titulo: "Como usar: Proprietários de sala",
    itens: [
      { titulo: "O que é", texto: "Um usuário comum que pode conceder ou revogar o controle de uma sala específica, sem virar administrador." },
      { titulo: "Pré-requisito", texto: "A sala precisa estar com o controle restrito a usuários específicos para que o acesso concedido tenha efeito." },
      { titulo: "Tornar proprietário", texto: "Escolha um usuário não administrador e defina-o como proprietário da sala selecionada." },
      { titulo: "Controle do administrador", texto: "Você pode remover um proprietário a qualquer momento; ele perde o acesso imediatamente. Você também pode revogar diretamente qualquer acesso concedido por ele." },
    ],
  },
  mapa: {
    titulo: "Como usar: Mapa",
    itens: [
      { titulo: "Cores", texto: "Offline, online desligado, online ligado e reservada agora, iguais à legenda da planta baixa." },
      { titulo: "Salas combinadas", texto: "Códigos unidos por traço (ex.: B-105-B-106) indicam duas salas controladas pelo mesmo ESP32." },
    ],
  },
  macs: {
    titulo: "Como usar: ESP32 / Salas",
    itens: [
      { titulo: "Planta baixa", texto: "Toque em uma sala no mapa para rolar até o cartão dela na lista. O mapa tem zoom, aproximar num ponto e restaurar; no celular ele rola quando não cabe inteiro." },
      { titulo: "Buscar sala", texto: "Digite o número ou o nome da sala para filtrar a lista rapidamente." },
      { titulo: "Detectados na rede", texto: "ESP32 que já entraram em contato com o servidor mas ainda não estão vinculados a nenhuma sala; escolha a sala e toque em vincular." },
      { titulo: "Vincular à sala", texto: "Associe um ESP32 (pelo endereço MAC) à sala onde ele está instalado." },
      { titulo: "Limites por sala", texto: "Deixe em branco para herdar cada limite global ou informe uma mínima, uma máxima, ou ambas para esta sala." },
      { titulo: "Acesso por sala", texto: "Ative o acesso restrito e defina quais usuários podem controlar cada sala." },
      { titulo: "Permissão", texto: "Esta aba é visível apenas ao administrador principal, que também é quem altera o MAC e os limites de uma sala." },
    ],
  },
  propriedade: {
    titulo: "Como usar: Configurações de sala",
    itens: [
      { titulo: "O que é", texto: "Um administrador concedeu a você a função de proprietário de uma ou mais salas." },
      { titulo: "Conceder acesso", texto: "Escolha um usuário e conceda a ele o controle desta sala (ligar, desligar e ajustar temperatura)." },
      { titulo: "Revogar acesso", texto: "Remove o controle concedido anteriormente a um usuário." },
      { titulo: "Sem restrição ativa", texto: "Se a sala não estiver com o controle restrito, todos que já podem controlar salas conseguem operá-la; peça a um administrador para restringir." },
      { titulo: "Sua permissão", texto: "É uma função de baixo nível: você não tem acesso às demais funções administrativas, e um administrador pode remover sua permissão a qualquer momento." },
    ],
  },
  config: {
    titulo: "Como usar: Configurações",
    itens: [
      { titulo: "Sessão por inatividade", texto: "Tempo sem uso até deslogar automaticamente; deixe em branco para nunca deslogar por tempo. Há a opção de aplicar o timer também a administradores." },
      { titulo: "Presença online", texto: "Por quantos minutos sem uso um usuário ainda aparece como online no painel de Ativos." },
      { titulo: "Limites de temperatura e Turbo", texto: "Limite global de temperatura e a função extra opcional acionada junto com o Turbo (ex.: oscilação vertical)." },
      { titulo: "Modo de teste e redes autorizadas", texto: "Em produção o acesso é restrito às redes autorizadas (CIDR). O modo de teste desativa essa restrição temporariamente — desligue ao terminar." },
      { titulo: "Modo de manutenção", texto: "Bloqueia o acesso de usuários comuns e exibe um aviso; administradores continuam entrando." },
      { titulo: "Credencial por dispositivo", texto: "Quando exigida globalmente, nenhum ESP32 conecta só pelo MAC — cada sala precisa de uma credencial provisionada em Admin > ESP32." },
      { titulo: "Acesso restrito", texto: "Esta aba inteira é visível apenas ao administrador principal." },
    ],
  },
  esp32: {
    titulo: "Como usar: ESP32",
    itens: [
      { titulo: "O que é", texto: "Acesso direto às funções avançadas de cada ESP32, antes disponíveis apenas na página local do dispositivo. Visível apenas ao administrador principal." },
      { titulo: "Conexão", texto: "Mostra separadamente se o dispositivo está online na rede Wi-Fi e se está conectado ao servidor." },
      { titulo: "Entrar em modo de configuração", texto: "Disponível quando o ESP32 está conectado ao servidor. Botões indisponíveis aparecem desabilitados com o motivo." },
      { titulo: "Modo clonagem e capturas", texto: "Só em modo de configuração; captura sinais infravermelhos do controle original. Use \"testar\" para reenviar e \"usar protocolo\" para salvar um protocolo conhecido." },
      { titulo: "Atualizar firmware (OTA)", texto: "Para uma sala conectada e desatualizada, envia o firmware publicado. O dispositivo baixa, confere o hash, grava e reinicia; se não validar, reverte sozinho." },
      { titulo: "Credencial do dispositivo", texto: "Provisionar cria uma credencial exclusiva para a sala; rotacionar gera novo segredo (o anterior vale 24 h); substituir é para troca de placa; revogar derruba a conexão. O segredo é exibido uma única vez." },
      { titulo: "Sair do modo de configuração", texto: "Devolve o dispositivo ao funcionamento normal (modo operação)." },
      { titulo: "Resetar Wi-Fi", texto: "Apaga a rede e o endereço do servidor e reinicia em ponto de acesso, para reconfiguração. A credencial exclusiva do dispositivo é preservada." },
    ],
  },
  monitoramento: {
    titulo: "Como usar: Monitoramento",
    itens: [
      { titulo: "O que é", texto: "Retrato da saúde da instalação a partir de fontes locais e baratas, sem serviços externos. Visível apenas ao administrador principal." },
      { titulo: "Selo de estado", texto: "Cada bloco mostra disponível, temporariamente indisponível, desativado por configuração ou falha." },
      { titulo: "O que acompanha", texto: "Serviço, banco de dados, armazenamento, backups, ESP32 (online, offline inesperado, reconexões, OTA), credenciais e contadores de falha desde a inicialização." },
      { titulo: "Atualização", texto: "A tela recarrega a cada 20 s enquanto aberta. A cada 5 min o servidor reavalia e gera uma notificação por alerta ativo, sem repetir o mesmo em 6 h." },
      { titulo: "Atenção", texto: "A caixa \"Atenção\" no topo lista as condições de alerta ativas no momento." },
    ],
  },
};

const MANUAL_SECAO_POR_AJUDA = {
  cards: "selecao-sala",
  localizacao: "selecao-sala",
  planta: "selecao-sala",
  salas: "selecao-sala",
  painel: "controlador",
  agenda: "agenda-grade",
  grade: "agenda-grade",
  usuarios: "administracao",
  ativos: "administracao",
  sessoes: "administracao",
  logs: "administracao",
  dispositivos: "administracao",
  acessos: "administracao",
  proprietarios: "administracao",
  propriedade: "administracao",
  mapa: "administracao",
  macs: "esp32-cadastro",
  config: "operacao-admin",
  esp32: "esp32-avancado",
  monitoramento: "monitoramento",
};

const Help = {
  _elementoAnterior: null,
  abrir(chave) {
    const dados = HelpContent[chave];
    if (!dados) return;
    document.getElementById("helpModalTitle").textContent = dados.titulo;
    document.getElementById("helpModalList").innerHTML = dados.itens
      .map((item) => `<li><strong>${item.titulo}:</strong> ${item.texto}</li>`)
      .join("");
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

document.querySelectorAll(".help-icon-btn[data-help]").forEach((btn) => {
  btn.addEventListener("click", () => Help.abrir(btn.dataset.help));
});

const _helpModalManualBtn = document.getElementById("helpModalManualBtn");
if (_helpModalManualBtn) {
  _helpModalManualBtn.addEventListener("click", () => {
    const secao = _helpModalManualBtn.dataset.secao;
    Help.fechar();
    if (secao && typeof Manual !== "undefined") Manual.abrir(secao);
  });
}

document.addEventListener("click", (e) => {
  const alvo = e.target.closest("[data-manual]");
  if (!alvo) return;
  e.preventDefault();
  if (typeof Manual !== "undefined") Manual.abrir(alvo.dataset.manual || null);
});

document.getElementById("helpModalCloseBtn").addEventListener("click", () => Help.fechar());
document.getElementById("helpModal").addEventListener("click", (e) => {
  if (e.target.id === "helpModal") Help.fechar();
});
document.getElementById("helpModal").addEventListener("keydown", (e) => {
  const modal = document.getElementById("helpModal");
  if (modal.classList.contains("hidden")) return;
  if (e.key === "Escape") {
    Help.fechar();
    return;
  }
  if (e.key !== "Tab") return;
  const focaveis = Array.from(
    modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
  ).filter((el) => el.offsetParent !== null);
  if (focaveis.length === 0) return;
  const primeiro = focaveis[0];
  const ultimo = focaveis[focaveis.length - 1];
  if (e.shiftKey && document.activeElement === primeiro) {
    e.preventDefault();
    ultimo.focus();
  } else if (!e.shiftKey && document.activeElement === ultimo) {
    e.preventDefault();
    primeiro.focus();
  }
});
