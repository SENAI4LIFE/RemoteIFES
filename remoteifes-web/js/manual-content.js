const ManualContent = (() => {
  const box = (x, y, w, t) => `<g class="md-node"><rect x="${x}" y="${y}" width="${w}" height="34" rx="6"/><text x="${x + w / 2}" y="${y + 21}" text-anchor="middle">${t}</text></g>`;
  const arrow = (x1, y1, x2, y2) => `<line class="md-arrow" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#md-a)"/>`;
  const svg = (vb, inner) =>
    `<svg class="manual-diagram" viewBox="0 0 ${vb}" role="img" xmlns="http://www.w3.org/2000/svg">` +
    `<defs><marker id="md-a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 z"/></marker></defs>${inner}</svg>`;

  const rotulos = {
    navegacao: "Fluxo de navegação: do portal de acesso ao login e à aplicação; o endereço guarda a tela atual.",
    papeis: "Papéis do sistema, do menos ao mais privilegiado, e o que cada um pode fazer.",
    selecaoSala: "Seleção de sala em três passos: bloco, andar e sala.",
    controlador: "Estados do ar-condicionado: desligado, ligado (Cool) e turbo, com as ressalvas de offline e reserva.",
    ota: "Máquina de estados da atualização OTA: de ocioso a concluído, ou falhou com reversão automática.",
    backup: "Fluxo de backup: do banco ao backup automático e à restauração pelo script no servidor.",
    credencial: "Ciclo da credencial por dispositivo: de só MAC a credencial ativa, com rotacionar, substituir e revogar.",
  };

  const diagramas = {
    navegacao: svg("520 210",
      box(10, 12, 130, "Portal de acesso") +
      box(200, 12, 140, "Login (Usuário / Admin)") +
      box(390, 12, 120, "Aplicação") +
      arrow(140, 29, 200, 29) + arrow(340, 29, 390, 29) +
      box(200, 92, 140, "Salas · Agenda · Grade") +
      box(200, 140, 140, "Config. · Admin") +
      arrow(450, 46, 300, 92) + arrow(300, 126, 300, 140) +
      `<text class="md-cap" x="10" y="190">O endereço (#/...) guarda a tela atual: atualizar a página mantém o lugar.</text>`),

    papeis: svg("520 250",
      box(10, 10, 200, "Usuário (visualiza)") +
      box(10, 54, 200, "Usuário com controle") +
      box(10, 98, 200, "Proprietário de sala") +
      box(10, 142, 200, "Administrador") +
      box(10, 186, 200, "Administrador principal") +
      `<text class="md-cap" x="240" y="32">vê salas e status</text>` +
      `<text class="md-cap" x="240" y="76">liga/desliga, ajusta temperatura</text>` +
      `<text class="md-cap" x="240" y="120">concede controle de salas suas</text>` +
      `<text class="md-cap" x="240" y="164">usuários, agenda, auditoria, mapa</text>` +
      `<text class="md-cap" x="240" y="208">config., ESP32/MAC, monitoramento</text>`),

    selecaoSala: svg("520 150",
      box(20, 20, 110, "Bloco") + box(200, 20, 110, "Andar") + box(380, 20, 120, "Sala") +
      arrow(130, 37, 200, 37) + arrow(310, 37, 380, 37) +
      `<text class="md-cap" x="20" y="100">Três formas: Cards (passo a passo) · Lista · Planta baixa (mapa com zoom).</text>` +
      `<text class="md-cap" x="20" y="122">Cores: cinza=offline · azul=ligado desligado · verde=ligado · contorno=reservada.</text>`),

    controlador: svg("520 170",
      box(20, 20, 120, "Desligado") + box(210, 20, 120, "Ligado (Cool)") + box(400, 20, 100, "Turbo") +
      arrow(140, 37, 210, 37) + arrow(330, 37, 400, 37) +
      arrow(400, 30, 330, 30) + arrow(210, 44, 140, 44) +
      `<text class="md-cap" x="20" y="96">Dispositivo offline: o comando fica salvo e é aplicado ao reconectar.</text>` +
      `<text class="md-cap" x="20" y="118">Sala reservada por agendamento: controles bloqueados até o fim do horário.</text>` +
      `<text class="md-cap" x="20" y="140">Apenas visualização: você vê o status, mas não controla.</text>`),

    ota: svg("560 130",
      box(10, 20, 80, "ocioso") + box(110, 20, 90, "ofertado") + box(220, 20, 90, "baixando") +
      box(330, 20, 90, "gravado") + box(440, 20, 100, "reiniciando") +
      arrow(90, 37, 110, 37) + arrow(200, 37, 220, 37) + arrow(310, 37, 330, 37) + arrow(420, 37, 440, 37) +
      box(220, 80, 110, "concluído") + box(360, 80, 90, "falhou") +
      arrow(490, 54, 300, 80) + arrow(470, 54, 410, 80) +
      `<text class="md-cap" x="10" y="120">Se a nova versão não validar, o ESP32 reverte sozinho para a atual.</text>`),

    backup: svg("520 130",
      box(10, 20, 110, "Banco de dados") + box(170, 20, 150, "Backup automático (N/N h)") + box(380, 20, 130, "Restauração (script)") +
      arrow(120, 37, 170, 37) + arrow(320, 37, 380, 37) +
      `<text class="md-cap" x="10" y="96">Quantidade e idade do último backup aparecem em Monitoramento.</text>` +
      `<text class="md-cap" x="10" y="118">Restaurar e verificar saúde são operações na máquina do servidor.</text>`),

    credencial: svg("540 130",
      box(10, 20, 110, "Só MAC") + box(170, 20, 110, "Provisionar") + box(330, 20, 120, "Credencial ativa") +
      arrow(120, 37, 170, 37) + arrow(280, 37, 330, 37) +
      `<text class="md-cap" x="10" y="96">Depois: rotacionar (segredo antigo vale 24 h) · substituir (troca de placa) · revogar.</text>` +
      `<text class="md-cap" x="10" y="118">O segredo é exibido uma única vez.</text>`),
  };

  const secoes = [
    {
      id: "inicio", titulo: "Primeiros passos", papel: "todos",
      corpo: [
        { t: "p", texto: "O RemoteIFES controla remotamente o ar-condicionado das salas do campus. O login é próprio do sistema, independente de outras plataformas do Ifes: usuário e senha são criados por um administrador." },
        { t: "passos", itens: [
          "Na tela inicial, escolha <strong>Usuário</strong> ou <strong>Administrador</strong>.",
          "Informe usuário e senha. O acesso é individual; não compartilhe credenciais.",
          "Após entrar, a barra inferior mostra as seções disponíveis para o seu perfil.",
        ] },
        { t: "diagrama", chave: "navegacao" },
        { t: "nota", texto: "Problemas para entrar? Procure o administrador do RemoteIFES no seu campus." },
      ],
    },
    {
      id: "navegacao", titulo: "Navegação e persistência", papel: "todos", verNoApp: "/salas",
      corpo: [
        { t: "p", texto: "A barra inferior sempre traz <strong>Salas</strong>. <strong>Agenda</strong>, <strong>Grade</strong> e <strong>Admin</strong> aparecem para administradores; <strong>Config.</strong> aparece para quem é proprietário de alguma sala. O logotipo no topo volta ao início da seção Salas." },
        { t: "lista", itens: [
          "O ícone <strong>?</strong> ao lado de cada título abre a ajuda daquela tela, com um atalho para a seção correspondente deste manual.",
          "O botão de acessibilidade (canto inferior) ajusta fonte, contraste, espaçamento, cores e alinhamento; as preferências ficam no aparelho.",
          "O endereço da página guarda onde você está (<code>#/salas/planta/a-terreo</code>, <code>#/sala/A-108</code>, <code>#/admin/usuarios</code>, <code>#/ajuda/ota</code>…). Atualizar a página mantém a tela, a subtela, a aba, a sala e a seção do mapa.",
          "Os botões <strong>voltar</strong> e <strong>avançar</strong> do navegador percorrem as seções por onde você passou.",
          "Você pode salvar ou compartilhar um endereço para abrir direto numa tela — o sistema só o leva até onde a sua permissão alcança.",
        ] },
        { t: "nota", texto: "Nenhuma senha, dado de formulário sensível ou permissão é guardado no endereço ou no aparelho." },
      ],
    },
    {
      id: "papeis", titulo: "Papéis e permissões", papel: "todos",
      corpo: [
        { t: "p", texto: "Cada conta tem um papel que define o que ela pode fazer:" },
        { t: "tabela", cabecalho: ["Papel", "Pode"], linhas: [
          ["Usuário", "ver salas, status e planta baixa"],
          ["Usuário com controle", "ligar/desligar e ajustar temperatura das salas permitidas"],
          ["Proprietário de sala", "conceder ou revogar o controle das salas das quais é proprietário"],
          ["Administrador", "usuários, agendamentos, auditoria, mapa, proprietários de sala"],
          ["Administrador principal", "tudo acima + ESP32/MAC, configurações do sistema, funções avançadas de ESP32 e monitoramento"],
        ] },
        { t: "diagrama", chave: "papeis" },
        { t: "nota", texto: "A autorização é sempre verificada no servidor. A interface apenas oculta o que você não pode usar — ela não substitui a checagem de permissão." },
      ],
    },
    {
      id: "selecao-sala", titulo: "Selecionar bloco, andar e sala", papel: "todos", verNoApp: "/salas",
      corpo: [
        { t: "p", texto: "Há três formas de chegar a uma sala, todas na seção Salas:" },
        { t: "lista", itens: [
          "<strong>Cards</strong>: toque em bloco, andar e sala, um passo de cada vez.",
          "<strong>Lista</strong>: escolha bloco e andar e veja a lista de salas com status de conexão e de ligado/desligado.",
          "<strong>Planta baixa</strong>: mapa do andar; toque numa sala colorida para abrir o controle. Use os botões de <strong>zoom</strong>, <strong>aproximar num ponto</strong> e <strong>restaurar</strong>; no celular, o mapa rola quando não cabe inteiro.",
        ] },
        { t: "diagrama", chave: "selecaoSala" },
        { t: "lista", itens: [
          "Salas sem cor no mapa ainda não têm ar-condicionado controlado pelo sistema.",
          "Códigos unidos por traço (ex.: <code>B-105-B-106</code>) são duas salas atendidas pelo mesmo ESP32.",
        ] },
      ],
    },
    {
      id: "controlador", titulo: "Operar o ar-condicionado", papel: "todos", verNoApp: "/salas",
      corpo: [
        { t: "p", texto: "O painel de controle imita um controle remoto: <strong>Power</strong> liga/desliga, <strong>+</strong>/<strong>−</strong> ajustam a temperatura alvo (dentro dos limites da sala) e <strong>Turbo</strong> ativa o modo turbo (e, se configurada, uma função extra como oscilação)." },
        { t: "diagrama", chave: "controlador" },
        { t: "lista", itens: [
          "<strong>Conexão do dispositivo</strong>: se o ESP32 estiver offline, o comando é salvo e aplicado assim que ele reconectar.",
          "<strong>Sala reservada</strong>: se há um agendamento ativo de outra pessoa, os controles ficam bloqueados até o fim do horário.",
          "<strong>Apenas visualização</strong>: alguns usuários veem o status sem poder controlar.",
          "No celular, o controlador ocupa a tela inteira para facilitar o toque; retrato e paisagem funcionam sem recarregar.",
        ] },
      ],
    },
    {
      id: "agenda-grade", titulo: "Agendamentos e Grade", papel: "admin", verNoApp: "/agenda",
      corpo: [
        { t: "p", texto: "Em <strong>Agenda</strong>, escolha a sala e o horário e defina o comportamento:" },
        { t: "lista", itens: [
          "<strong>Apenas reservar</strong>: bloqueia a sala para outros no período, sem ligar o ar-condicionado.",
          "<strong>Reservar e ligar no período todo</strong>: liga durante todo o horário.",
          "<strong>Reservar e ligar em intervalo</strong>: reserva o período, mas liga só na janela escolhida.",
        ] },
        { t: "p", texto: "A <strong>temperatura</strong> alvo é aplicada quando o agendamento ligar o aparelho. Um agendamento pode ser desativado sem ser apagado." },
        { t: "p", texto: "Em <strong>Grade</strong>, veja hora a hora quando a sala fica desligada, apenas agendada ou ligada — útil para achar conflitos e janelas livres." },
      ],
    },
    {
      id: "notificacoes", titulo: "Notificações de dispositivos", papel: "admin",
      corpo: [
        { t: "p", texto: "O sino no topo (administradores) reúne eventos de ESP32 — quando um dispositivo fica online ou offline — e alertas de monitoramento. Toque numa notificação para marcá-la como lida, ou use <em>marcar todas como lidas</em>." },
      ],
    },
    {
      id: "relatos", titulo: "Relatar um problema", papel: "todos",
      corpo: [
        { t: "p", texto: "O botão de inseto abre o formulário de relato: escolha a categoria, escreva um título curto e a descrição, e opcionalmente a sala relacionada. A página atual e o tamanho da tela são registrados automaticamente." },
        { t: "nota", texto: "Nunca inclua senhas ou códigos de acesso no relato." },
        { t: "p", texto: "O administrador principal vê todos os relatos, filtra por status (novo, aberto, em análise, resolvido) e pode responder — a resposta fica visível para quem enviou." },
      ],
    },
    {
      id: "administracao", titulo: "Administração", papel: "admin", verNoApp: "/admin/usuarios",
      corpo: [
        { t: "p", texto: "A seção <strong>Admin</strong> tem abas para cada área. Para todos os administradores:" },
        { t: "lista", itens: [
          "<strong>Usuários</strong>: criar contas; trocar nome, login e senha; conceder/revogar o controle de salas; ativar/desativar. Só o administrador principal concede ou revoga o papel de administrador.",
          "<strong>Ativos</strong> e <strong>Sessões</strong>: quem está online agora e o histórico de login/logout.",
          "<strong>Logs</strong>, <strong>Dispositivos</strong> e <strong>Acessos ESP32</strong>: auditoria de comandos, de conexões dos ESP32 e das requisições que eles fazem ao servidor.",
          "<strong>Proprietários de sala</strong>: delegar a um usuário comum a concessão de acesso de uma sala específica. É preciso ativar o <em>acesso restrito</em> da sala para que a concessão tenha efeito.",
          "<strong>Mapa</strong>: visão geral do status de todas as salas ao mesmo tempo.",
        ] },
        { t: "p", texto: "Somente para o administrador principal: <strong>ESP32 / MACs</strong>, <strong>Configurações</strong>, <strong>ESP32</strong> (funções avançadas) e <strong>Monitoramento</strong>." },
      ],
    },
    {
      id: "esp32-cadastro", titulo: "Cadastro de ESP32 por sala", papel: "superadmin", verNoApp: "/admin/macs",
      corpo: [
        { t: "p", texto: "Em <strong>Admin &gt; ESP32 / MACs</strong> cada sala é associada ao endereço MAC do seu ESP32." },
        { t: "lista", itens: [
          "Use a <strong>planta baixa</strong> no topo para localizar a sala: toque nela no mapa e a lista rola até o cartão correspondente. O mapa tem zoom, aproximar num ponto e restaurar; no celular ele rola quando não cabe.",
          "<strong>ESP32 detectados na rede</strong>: dispositivos que já falaram com o servidor mas ainda não estão vinculados a uma sala — escolha a sala e toque em <em>vincular</em>.",
          "<strong>Limites de temperatura</strong> por sala: deixe em branco para herdar o limite global; informe mínima, máxima ou ambas para a sala.",
          "<strong>Acesso restrito</strong> por sala: quando ativo, só usuários explicitamente autorizados (ou concedidos por um proprietário) controlam a sala.",
        ] },
      ],
    },
    {
      id: "esp32-avancado", titulo: "ESP32 — funções avançadas", papel: "superadmin", verNoApp: "/admin/esp32",
      corpo: [
        { t: "p", texto: "Em <strong>Admin &gt; ESP32</strong>, cada dispositivo mostra separadamente se está conectado ao <strong>Wi-Fi</strong> e ao <strong>servidor</strong>." },
        { t: "lista", itens: [
          "<strong>Entrar em modo de configuração</strong>: disponível quando o dispositivo está conectado ao servidor.",
          "<strong>Modo clonagem</strong> + <strong>captura IR</strong>: capture os sinais do controle remoto original; use <em>testar</em> para reenviar um sinal e confirmar; <em>usar protocolo</em> salva um protocolo conhecido para o painel comandar o aparelho.",
          "<strong>Sair do modo de configuração</strong>: devolve o dispositivo à operação normal.",
          "<strong>Resetar Wi-Fi</strong>: apaga a rede e o endereço do servidor e reinicia em ponto de acesso para reconfiguração — a credencial exclusiva do dispositivo é preservada.",
        ] },
        { t: "nota", texto: "Botões indisponíveis (ex.: dispositivo desconectado) aparecem desabilitados com o motivo — nenhuma ação some sem explicação." },
      ],
    },
    {
      id: "monitoramento", titulo: "Monitoramento e saúde do sistema", papel: "superadmin", verNoApp: "/admin/monitoramento",
      corpo: [
        { t: "p", texto: "Visível apenas ao administrador principal. Reúne, de fontes locais e baratas (sem serviços externos), um retrato da instalação, atualizado a cada 20 s enquanto a aba está aberta." },
        { t: "lista", itens: [
          "<strong>Serviço</strong>: ambiente, tempo no ar, memória, carga, versão do Node.",
          "<strong>Banco de dados</strong>: se responde e em quanto tempo, tamanho do arquivo e do WAL.",
          "<strong>Armazenamento</strong>: espaço livre no diretório de dados, com alerta abaixo de 10%.",
          "<strong>Backups</strong>: se o automático está ligado, quantos existem e a idade do último.",
          "<strong>ESP32</strong>: com MAC, online, offline inesperado, reconexões na última hora, OTA em andamento e com falha.",
          "<strong>Credenciais</strong>: provisionadas, só por MAC, revogadas, e se a exigência global está ligada.",
          "<strong>Contadores de falha</strong> desde a inicialização (telemetria, agendador, OTA, credenciais, reconexões).",
        ] },
        { t: "p", texto: "Cada bloco mostra um selo de estado: <em>disponível</em>, <em>temporariamente indisponível</em>, <em>desativado por configuração</em> ou <em>falha</em>. A cada 5 minutos o servidor reavalia e gera uma notificação para cada alerta ativo, sem repetir o mesmo em 6 horas." },
      ],
    },
    {
      id: "backup", titulo: "Backup e recuperação", papel: "superadmin",
      corpo: [
        { t: "p", texto: "O backup automático do banco é ligado/desligado por configuração do servidor, com intervalo em horas. A quantidade e a idade do último backup aparecem em <strong>Monitoramento</strong>." },
        { t: "diagrama", chave: "backup" },
        { t: "p", texto: "Restaurar um backup e verificar a saúde do serviço são operações feitas na máquina do servidor (scripts <code>restore-backup.js</code> e <code>healthcheck.sh</code>). O README traz o passo a passo." },
      ],
    },
    {
      id: "ota-credenciais", titulo: "OTA e credenciais por dispositivo", papel: "superadmin", verNoApp: "/admin/esp32",
      corpo: [
        { t: "sub", titulo: "Atualização de firmware (OTA)" },
        { t: "p", texto: "Publicado um firmware, cada sala conectada e desatualizada ganha o botão <strong>Atualizar firmware (OTA)</strong>. O dispositivo baixa a imagem, confere o hash, grava e reinicia. Se a nova versão não validar, ele reverte sozinho para a atual." },
        { t: "diagrama", chave: "ota" },
        { t: "sub", titulo: "Credenciais por dispositivo" },
        { t: "p", texto: "Cada sala pode ter uma credencial exclusiva (deviceId + segredo). As ações são <strong>provisionar</strong>, <strong>rotacionar</strong> (o segredo anterior vale por 24 h), <strong>substituir</strong> (troca de placa) e <strong>revogar</strong>. O segredo é mostrado uma única vez." },
        { t: "diagrama", chave: "credencial" },
        { t: "p", texto: "A opção global <em>Exigir credencial por dispositivo</em> (em Configurações) faz o servidor recusar conexões só por MAC. Ative-a só depois de provisionar todos os controladores; a mudança é reversível." },
      ],
    },
    {
      id: "pwa-mobile", titulo: "PWA, celular e app Cordova", papel: "todos",
      corpo: [
        { t: "lista", itens: [
          "<strong>PWA</strong>: com o frontend em HTTPS, o navegador oferece instalar o app (ícone na barra de endereço no Chrome/Edge; <em>Compartilhar &gt; Adicionar à Tela de Início</em> no iOS).",
          "<strong>App nativo (Cordova)</strong>: carrega de <code>file://</code> e, na primeira abertura sem endereço configurado, mostra <strong>Configurar endereço do servidor</strong>. O mesmo botão reaparece quando o app está offline, permitindo trocar de servidor sem reinstalar.",
          "Retrato e paisagem funcionam sem recarregar nem perder o estado atual.",
          "A casca do app e este manual ficam em cache: abrem mesmo sem Internet. As chamadas ao servidor e o tempo real continuam exigindo rede.",
        ] },
        { t: "nota", texto: "Para um app instalado a partir de uma página HTTPS, o servidor também precisa de HTTPS, senão o navegador bloqueia as chamadas." },
      ],
    },
    {
      id: "solucao-problemas", titulo: "Solução de problemas", papel: "todos",
      corpo: [
        { t: "tabela", cabecalho: ["Sintoma", "O que verificar"], linhas: [
          ["\"Sem conexão com o servidor\"", "rede do aparelho; no app nativo, o endereço do servidor em Configurar endereço do servidor"],
          ["Sessão encerrada sozinha", "expiração por inatividade — basta entrar de novo"],
          ["Liguei/desliguei e nada mudou", "veja \"Conexão do dispositivo\" no painel: se offline, o comando fica pendente"],
          ["Controles bloqueados numa sala", "há um agendamento ativo; aguarde o fim do horário"],
          ["Não vejo a aba Admin", "sua conta não é administrador"],
          ["Planta baixa muito pequena no celular", "use os botões de zoom e role o mapa"],
          ["App instalado não conecta", "página HTTPS exige servidor HTTPS"],
        ] },
      ],
    },
    {
      id: "operacao-admin", titulo: "Operação e implantação (administradores)", papel: "superadmin",
      corpo: [
        { t: "p", texto: "Resumo operacional; o passo a passo completo está no README do projeto." },
        { t: "lista", itens: [
          "<strong>Scripts do servidor</strong>: preparo (<code>setup.sh</code>), serviço do sistema (<code>install-service.sh</code>), publicação e reversão (<code>deploy.sh</code>, <code>rollback.sh</code>), verificação (<code>healthcheck.sh</code>).",
          "<strong>Restrição de rede</strong>: em produção o acesso é limitado às redes autorizadas (formato CIDR). O <em>modo de teste</em> desliga essa restrição temporariamente — desligue ao terminar.",
          "<strong>Modo de manutenção</strong>: bloqueia usuários comuns e exibe aviso; administradores continuam entrando.",
          "<strong>Cache do frontend</strong>: ao alterar arquivos estáticos, incremente <code>CACHE_VERSION</code> no <code>sw.js</code> para os apps já instalados buscarem a versão nova.",
        ] },
      ],
    },
  ];

  return { secoes, diagramas, rotulos };
})();
