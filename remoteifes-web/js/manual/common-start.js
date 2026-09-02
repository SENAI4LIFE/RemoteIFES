ManualContent.registrar([
  {
    id: "inicio",
    titulo: "Primeiros passos e acesso",
    categoria: "comecar",
    tags: ["login", "entrar", "senha", "portal", "manutenção"],
    corpo: [
      { t: "p", texto: "O RemoteIFES permite consultar salas e, conforme a permissão da conta, comandar os aparelhos de ar-condicionado. Use sempre sua conta individual, criada pela equipe responsável." },
      { t: "sub", titulo: "Entrar" },
      { t: "passos", itens: [
        "No portal de acesso, escolha <strong>USUÁRIO</strong> para uma conta comum ou <strong>ADMINISTRADOR</strong> para uma conta administrativa.",
        "Informe o <strong>Usuário</strong> e a <strong>Senha</strong> e use <strong>Entrar</strong>.",
        "Confirme seu nome e papel no menu da conta. A tela <strong>Início</strong> mostrará somente as funções autorizadas.",
      ] },
      { t: "fluxo", titulo: "Do acesso à operação", itens: [
        { tipo: "screen", texto: "Portal de acesso" },
        { tipo: "action", texto: "Escolher o tipo de acesso" },
        { tipo: "action", texto: "Autenticar" },
        { tipo: "status", texto: "Início com recursos do papel" },
      ] },
      { t: "sub", titulo: "Se não entrar" },
      { t: "lista", itens: [
        "Revise usuário e senha, inclusive maiúsculas, teclado e preenchimento automático.",
        "Uma conta comum não entra pela opção <strong>ADMINISTRADOR</strong>; volte ao portal e escolha <strong>USUÁRIO</strong>.",
        "Conta desativada, senha esquecida ou acesso bloqueado exigem atendimento da equipe responsável.",
        "Em <strong>Sistema em manutenção</strong>, usuários comuns aguardam o término; administradores ainda podem entrar para diagnóstico.",
      ] },
      { t: "nota", nivel: "seguranca", texto: "Não compartilhe senha nem deixe uma sessão aberta em equipamento coletivo." },
    ],
  },
  {
    id: "navegacao",
    titulo: "Navegação no site",
    categoria: "comecar",
    tags: ["menu", "voltar", "link", "desktop", "celular"],
    verNoApp: "/inicio",
    corpo: [
      { t: "p", texto: "A barra de seções usa os nomes <strong>Início</strong>, <strong>Salas</strong> e, quando autorizados, <strong>Agenda</strong>, <strong>Grade</strong>, <strong>Config.</strong> e <strong>Admin</strong>. Em telas compactas a apresentação muda, mas os nomes e os procedimentos permanecem." },
      { t: "lista", itens: [
        "Use o nome da seção, e não sua posição, para reconhecer um destino.",
        "Voltar e avançar do navegador restauram rotas permitidas. O fragmento depois de <code>#</code> identifica a tela, mas nunca guarda senha ou token.",
        "Um link direto não concede permissão: o servidor e o roteador redirecionam quem não tiver o papel necessário.",
        "O botão <strong>Precisa de ajuda?</strong> abre atalhos, ajuda contextual, este manual, relatos e a página <strong>Aplicativo</strong>.",
      ] },
      { t: "sub", titulo: "Usar este manual" },
      { t: "lista", itens: [
        "Busque pelo nome visível do controle, erro ou tarefa; a busca inclui títulos, comandos e palavras-chave.",
        "O sumário é agrupado por assunto. <strong>Ver no app</strong> fecha o manual e abre a função documentada.",
        "Links como <code>#/ajuda/controlador</code> abrem diretamente um tópico permitido ao papel atual.",
      ] },
    ],
  },
  {
    id: "inicio-acoes",
    titulo: "Início e atalhos disponíveis",
    categoria: "comecar",
    tags: ["cartões", "atalhos", "indicadores"],
    verNoApp: "/inicio",
    corpo: [
      { t: "p", texto: "<strong>Início</strong> reúne atalhos inteiros acionáveis por clique, toque, Enter ou Espaço. A composição depende do papel e das responsabilidades da conta." },
      { t: "tabela", cabecalho: ["Atalho", "Resultado"], linhas: [
        ["Salas / Planta baixa", "abre a seleção e os estados dos ambientes"],
        ["Agenda / Grade", "cria agendamentos ou consulta a ocupação; somente admin"],
        ["Config. de sala", "gerencia usuários autorizados nas salas das quais a conta é proprietária"],
        ["Notificações", "abre os avisos compartilhados entre administradores"],
        ["Relatar problema", "abre o formulário e os próprios relatos"],
        ["Ajuda e manual", "abre esta referência"],
        ["Aplicativo móvel", "mostra PWA, APK e orientações de instalação"],
      ] },
      { t: "p", texto: "Selos mostram pendências ou totais, como salas online, notificações não lidas e relatos novos. O Superadministrador também vê um resumo da saúde do serviço; os detalhes ficam em <strong>Administração &gt; Monitoramento</strong>." },
    ],
  },
  {
    id: "papeis",
    titulo: "Papéis, controle e propriedade",
    categoria: "comecar",
    tags: ["usuário", "admin", "superadmin", "permissão", "proprietário"],
    corpo: [
      { t: "tabela", cabecalho: ["Papel ou condição", "O que acrescenta"], linhas: [
        ["Usuário", "consulta salas, usa suporte e controla somente quando autorizado"],
        ["Usuário com controle", "envia comandos nas salas sem restrição ou onde recebeu acesso"],
        ["Proprietário de sala", "concede e revoga acesso de usuários nas salas atribuídas"],
        ["admin", "herda o uso comum e administra operação, contas e históricos permitidos"],
        ["Superadministrador", "herda usuário + admin e acrescenta dispositivos, segurança e infraestrutura"],
      ] },
      { t: "fluxo", titulo: "Herança do manual e das capacidades", itens: [
        { tipo: "role", texto: "Usuário" },
        { tipo: "role", texto: "admin: usuário + administração" },
        { tipo: "role", texto: "Superadministrador: usuário + admin + manutenção" },
      ] },
      { t: "nota", texto: "A interface oculta recursos indevidos, e o servidor volta a verificar o papel, a propriedade, a reserva e o acesso em cada operação." },
      { t: "links", titulo: "Veja também", itens: [
        { id: "controle-acesso-sala", texto: "Acesso a salas restritas" },
        { id: "conta-sessao", texto: "Conta, sessão e saída" },
      ] },
    ],
  },
]);
