const ManualContent = (() => {
  const box = (x, y, w, t) => `<g class="md-node"><rect x="${x}" y="${y}" width="${w}" height="34" rx="6"/><text x="${x + w / 2}" y="${y + 21}" text-anchor="middle">${t}</text></g>`;
  const arrow = (x1, y1, x2, y2) => `<line class="md-arrow" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#md-a)"/>`;
  const arrowBi = (x1, y1, x2, y2) => `<line class="md-arrow" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-start="url(#md-a)" marker-end="url(#md-a)"/>`;
  const svg = (vb, inner) => `<svg class="manual-diagram" viewBox="0 0 ${vb}" role="img" xmlns="http://www.w3.org/2000/svg"><defs><marker id="md-a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto-start-reverse"><path d="M0,0 L7,3 L0,6 z"/></marker></defs>${inner}</svg>`;

  const rotulos = {
    navegacao: "Fluxo de navegação do portal ao aplicativo.",
    papeis: "Papéis e permissões do RemoteIFES.",
    selecaoSala: "Formas de selecionar uma sala.",
    controlador: "Estados do controlador de ar-condicionado.",
  };

  const diagramas = {
    navegacao: svg("520 218", box(10, 12, 130, "Portal de acesso") + box(200, 12, 140, "Login") + box(390, 12, 120, "Aplicação") + arrow(140, 29, 200, 29) + arrow(340, 29, 390, 29) + box(200, 92, 140, "Salas e recursos") + arrow(450, 46, 300, 92) + `<text class="md-cap" x="10" y="198">O endereço guarda a tela atual sem guardar credenciais.</text>`),
    papeis: svg("520 250", box(10, 10, 200, "Usuário") + box(310, 10, 200, "Usuário com controle") + box(10, 90, 200, "Proprietário de sala") + box(310, 90, 200, "Administrador") + box(160, 170, 200, "Superadministrador") + arrow(210, 27, 310, 27) + arrow(110, 44, 110, 90) + arrow(410, 124, 300, 170)),
    selecaoSala: svg("520 145", box(10, 20, 130, "Cards") + box(195, 20, 130, "Lista") + box(380, 20, 130, "Planta baixa") + `<text class="md-cap" x="20" y="100">As três opções levam ao mesmo painel da sala.</text>`),
    controlador: svg("520 172", box(20, 20, 120, "Desligado") + box(210, 20, 120, "Ligado") + box(400, 20, 100, "Turbo") + arrowBi(140, 37, 210, 37) + arrowBi(330, 37, 400, 37) + `<text class="md-cap" x="20" y="98">Conexão, reserva e permissão determinam quais comandos estão disponíveis.</text>`),
  };

  const secoes = [
    { id: "inicio", titulo: "Primeiros passos", papel: "todos", corpo: [
      { t: "p", texto: "O RemoteIFES controla o ar-condicionado das salas do campus com uma conta individual criada pela equipe responsável." },
      { t: "passos", itens: ["Escolha o tipo de acesso.", "Informe seu usuário e senha.", "Use somente as seções apresentadas para o seu perfil."] },
      { t: "diagrama", chave: "navegacao" },
      { t: "nota", texto: "Não compartilhe credenciais. Para problemas de acesso, procure a equipe RemoteIFES do campus." },
    ] },
    { id: "navegacao", titulo: "Navegação e persistência", papel: "todos", verNoApp: "/salas", corpo: [
      { t: "lista", itens: ["A barra inferior mostra apenas as seções permitidas.", "Os ícones de ajuda abrem a orientação da página e a seção correspondente do manual.", "Atualizar ou usar voltar/avançar preserva a rota permitida; uma URL nunca concede nova permissão."] },
    ] },
    { id: "inicio-acoes", titulo: "Tela Início e seus atalhos", papel: "todos", verNoApp: "/inicio", corpo: [
      { t: "p", texto: "<strong>Início</strong> é a primeira tela depois de entrar. Cada cartão é um botão inteiro: clique, toque ou navegue com Tab e confirme com Enter. Só aparecem os cartões permitidos para o seu perfil." },
      { t: "tabela", cabecalho: ["Cartão", "O que abre"], linhas: [["Salas", "lista de salas para ligar, desligar e ajustar o ar-condicionado"], ["Planta baixa", "mapa dos blocos e andares do campus"], ["Agenda e Grade", "agendamentos e painel do dia (administradores)"], ["Config. de sala", "acesso das salas sob sua responsabilidade (proprietários)"], ["Notificações", "abre o sino com os avisos dos dispositivos (administradores)"], ["Relatar problema", "o mesmo formulário do botão de inseto"], ["Ajuda e manual", "este manual"], ["Aplicativo móvel", "instalação do app Android e da PWA"]] },
      { t: "p", texto: "O administrador vê também um bloco de atalhos para as abas de Administração. O superadministrador tem, acima dos cartões, uma faixa com a saúde do serviço e um atalho para o monitoramento." },
      { t: "nota", texto: "O selo colorido em um cartão indica pendências: salas on-line, notificações não lidas ou relatos novos." },
    ] },
    { id: "conta-sessao", titulo: "Conta, sessão e inatividade", papel: "todos", corpo: [
      { t: "lista", itens: ["As iniciais no canto superior direito abrem o menu da conta, com nome, login, papel, <strong>Aplicativo móvel</strong> e <strong>Sair</strong>.", "A sessão expira por inatividade. Cerca de um minuto antes, a janela <strong>Sessão prestes a expirar</strong> oferece <strong>Continuar conectado</strong> ou <strong>Sair agora</strong>.", "Abas do mesmo navegador compartilham a sessão: sair em uma encerra as demais.", "Sair limpa o endereço e o estado local; nenhuma senha ou token fica guardado na URL."] },
      { t: "nota", texto: "Contas são criadas, reativadas e desbloqueadas pela equipe responsável. Nunca compartilhe sua senha." },
    ] },
    { id: "conexao", titulo: "Conexão, reconexão e estados do servidor", papel: "todos", corpo: [
      { t: "p", texto: "O status das salas chega em tempo real. Se a conexão cair, a interface se recupera sozinha quando a rede volta — não é preciso recarregar nem sair." },
      { t: "tabela", cabecalho: ["Tela", "Significado"], linhas: [["Sem conexão com o servidor", "queda momentânea; reconexão automática em andamento"], ["Sistema em manutenção", "manutenção programada; apenas o acesso administrativo é liberado"], ["Conectar este aplicativo", "app móvel ainda sem o endereço do servidor configurado"]] },
      { t: "nota", texto: "Um comando aceito enquanto o dispositivo está offline pode ficar pendente até o ESP32 reconectar." },
    ] },
    { id: "papeis", titulo: "Papéis e permissões", papel: "todos", corpo: [
      { t: "tabela", cabecalho: ["Papel", "Acesso"], linhas: [["Usuário", "salas, controle autorizado, relatos e uso móvel"], ["Proprietário de sala", "gestão de acesso somente das salas atribuídas"], ["Administrador", "operação administrativa permitida pelo servidor"], ["Superadministrador", "administração avançada e infraestrutura"]] },
      { t: "diagrama", chave: "papeis" },
      { t: "nota", texto: "O servidor verifica a autorização em cada operação; ocultar controles é apenas uma proteção adicional da interface." },
    ] },
    { id: "selecao-sala", titulo: "Selecionar bloco, andar e sala", papel: "todos", verNoApp: "/salas", corpo: [
      { t: "p", texto: "Use Cards, Lista ou Planta baixa. Todas as opções levam ao mesmo painel e mostram conexão, energia, reserva e acesso." },
      { t: "diagrama", chave: "selecaoSala" },
    ] },
    { id: "controlador", titulo: "Operar o ar-condicionado", papel: "todos", verNoApp: "/salas", corpo: [
      { t: "p", texto: "Power, temperatura e Turbo respeitam os limites da sala, a conexão do dispositivo, agendamentos ativos e a permissão da conta." },
      { t: "diagrama", chave: "controlador" },
      { t: "nota", texto: "Quando o dispositivo está offline, um comando aceito pode permanecer pendente até a reconexão." },
    ] },
    { id: "relatos", titulo: "Relatar problema", papel: "todos", corpo: [
      { t: "p", texto: "Use o cartão <strong>Relatar problema</strong> em Início ou o botão de inseto, presente em qualquer tela. Informe categoria, título, descrição e a sala relacionada, quando houver." },
      { t: "lista", itens: ["O mesmo painel lista os seus relatos com a situação atual: novo, aberto, em análise ou resolvido.", "A resposta da equipe aparece dentro do relato correspondente.", "Você acompanha somente os próprios relatos."] },
      { t: "nota", texto: "Nunca inclua senhas, tokens, segredos ou credenciais de dispositivo na descrição." },
    ] },
    { id: "pwa-mobile", titulo: "PWA, celular e aplicativo", papel: "todos", verNoApp: "/aplicativo", corpo: [
      { t: "lista", itens: ["Abra Aplicativo móvel no menu da conta ou na ajuda para ver a versão, o tamanho e o SHA-256 do APK.", "A PWA instalada se atualiza sozinha: ao abrir com rede, a versão nova é baixada, substitui a anterior e a tela recarrega já atualizada — sem desinstalar, limpar dados, usar janela anônima ou recarregar várias vezes.", "Sem rede, a PWA continua abrindo a última versão instalada; entrar, comandar salas e consultar agendamentos exigem o servidor.", "Quando há um APK publicado, use Baixar APK: o navegador confere o SHA-256 do arquivo antes de salvar e cancela o download se não bater.", "Em navegadores compatíveis, instale a PWA ou adicione-a à tela inicial — é a opção indicada quando não há APK publicado.", "Na primeira execução do aplicativo, informe o endereço do servidor da sua instalação quando ele for solicitado.", "O aplicativo Cordova usa o mesmo frontend e exige acesso ao servidor para autenticação, estado e comandos."] },
    ] },
    { id: "acessibilidade", titulo: "Acessibilidade", papel: "todos", corpo: [
      { t: "p", texto: "O botão de acessibilidade fica fixo na lateral direita, na altura central da tela, e abre um painel com ajustes válidos para toda a interface." },
      { t: "lista", itens: ["Cor, tipo e tamanho da fonte, incluindo uma opção voltada à dislexia.", "Espaçamento entre letras, altura da linha, largura do parágrafo e alinhamento do texto.", "Destaque de links, contraste, cor do texto e opção de ocultar imagens.", "<strong>Redefinir tudo</strong> volta ao padrão; cada ajuste também tem o próprio <strong>Redefinir</strong>."] },
      { t: "nota", texto: "As preferências ficam salvas neste aparelho e valem nas próximas aberturas. Toda a interface é navegável por teclado, com Tab, Enter e Esc." },
    ] },
    { id: "solucao-problemas", titulo: "Solução de problemas", papel: "todos", corpo: [
      { t: "tabela", cabecalho: ["Sintoma", "Verificação"], linhas: [["Sem conexão", "rede do aparelho e endereço do servidor"], ["Sessão encerrada", "entre novamente; a sessão pode ter expirado"], ["Controle bloqueado", "permissão, reserva ativa e conexão"], ["Aplicativo não conecta", "origem do servidor e disponibilidade na rede local"], ["Tela parece antiga depois de uma atualização", "abra uma vez com rede e aguarde; a versão nova assume sozinha"], ["Texto pequeno ou pouco legível", "ajuste fonte, espaçamento e contraste no painel de acessibilidade"]] },
    ] },
  ];

  return { secoes, diagramas, rotulos };
})();
