/* Operations Console manual. Static content rendered by app.js with text nodes; **text** marks bold. */
var MANUAL_CONSOLE = [
  {
    id: "o-que-e",
    grupo: "Começar",
    titulo: "O que é o Console de Operações",
    blocos: [
      { t: "p", texto: "O Console de Operações administra o **servidor do RemoteIFES**: o serviço da aplicação, as atualizações, os backups, o acesso de rede, os aplicativos e a CI, e o próprio console. A **operação do prédio** (salas, agendamentos, usuários, ESP32) continua no RemoteIFES." },
      { t: "p", texto: "Ele é um programa separado de propósito: se a aplicação cair ou o banco quebrar, o console continua disponível para diagnosticar e recuperar. Ele tem operadores próprios, que não são contas do RemoteIFES." },
      { t: "h", texto: "Áreas" },
      { t: "lista", itens: [
        "**Início**: o que precisa de atenção agora e as tarefas mais frequentes.",
        "**Serviço e registros**: iniciar, parar e reiniciar o RemoteIFES, watchdog e journal.",
        "**Backups e recuperação**: criar e restaurar backups e recuperar a conta de superadministrador.",
        "**Rede e acesso**: quem pode abrir a aplicação e o diagnóstico de domínio, certificado e proxy.",
        "**Atualizações**: atualizar e reverter o RemoteIFES e, separadamente, o próprio console.",
        "**Aplicativos e CI**: site e PWA, Android, iOS, builds no GitHub Actions e a credencial que eles exigem.",
        "**Console instalado**: versão, plataforma, instalação e desinstalação do console.",
        "**Segurança e auditoria**: sessão, elevação, histórico de operações, auditoria e Terminal Expert."
      ] }
    ]
  },
  {
    id: "acesso",
    grupo: "Começar",
    titulo: "Acesso, túnel SSH e primeiro operador",
    blocos: [
      { t: "p", texto: "O console escuta só no próprio host, em **127.0.0.1:8099**. Ele nunca fica exposto na rede. De outro computador, abra um túnel SSH e use o endereço local:" },
      { t: "comando", texto: "ssh -L 8099:127.0.0.1:8099 <usuário>@<host-do-servidor>" },
      { t: "p", texto: "Com o túnel aberto, acesse http://127.0.0.1:8099 no navegador do seu computador. O localhost do seu computador não é o do servidor: sem o túnel, a página não abre." },
      { t: "h", texto: "Primeiro operador" },
      { t: "passos", itens: [
        "Com interface gráfica no host, abra o console pelo atalho ou com ./console.sh, numa conta de administrador. O lançador autoriza o primeiro acesso sem digitar segredo.",
        "Sem interface gráfica (um Raspberry Pi por SSH), crie o operador no terminal: sudo ./console.sh --criar-operador.",
        "Também é possível digitar o segredo de instalação, guardado em bootstrap-token no diretório de estado e legível só pelo administrador."
      ] },
      { t: "aviso", nivel: "info", texto: "Criado o primeiro operador, o segredo e os convites deixam de valer. Reinstalar ou reparar o console preserva os operadores." }
    ]
  },
  {
    id: "sessao",
    grupo: "Começar",
    titulo: "Sessão, elevação e confirmações",
    blocos: [
      { t: "p", texto: "A sessão dura até 8 horas e termina após 30 minutos sem uso. Operações que mudam o host, como reiniciar, atualizar, restaurar ou desinstalar, pedem a **senha de novo** (elevação). A elevação vale por poucos minutos e aparece como um cadeado amarelo no topo; tocar nele a encerra." },
      { t: "p", texto: "Antes de cada operação o console mostra o propósito, o **impacto** e o que foi avaliado no instante, como OTA de ESP32 em andamento, outra manutenção ou disco cheio. Operações destrutivas exigem digitar uma palavra de confirmação." },
      { t: "aviso", nivel: "alerta", texto: "Bloqueios aparecem em vermelho e impedem a operação. Avisos aparecem em amarelo: confirmar a operação significa aceitá-los." }
    ]
  },
  {
    id: "navegacao",
    grupo: "Começar",
    titulo: "Navegação, ajuda e atalhos",
    blocos: [
      { t: "p", texto: "No computador, as áreas ficam na barra lateral; no celular, na barra inferior, com **Mais** para as demais. O endereço da página muda com a área, então voltar do navegador funciona e um endereço pode ser compartilhado com outro operador." },
      { t: "lista", itens: [
        "O botão **?** abre a ajuda da área atual e o manual completo.",
        "O botão de acessibilidade ajusta fonte, espaçamento, contraste e animações.",
        "**Tab** percorre os controles; **Esc** fecha painéis e diálogos; nas abas internas, as **setas** trocam de aba.",
        "O primeiro Tab da página oferece **Pular para o conteúdo**."
      ] }
    ]
  },
  {
    id: "servico",
    grupo: "Operar",
    titulo: "Serviço e registros",
    blocos: [
      { t: "p", texto: "Mostra o estado do serviço remoteifes.service, há quanto tempo está ativo, reinícios e memória, e o **watchdog de saúde**, que reinicia a aplicação depois de 3 falhas seguidas do /health." },
      { t: "lista", itens: [
        "**Verificar saúde**: consulta o /health agora, sem efeito colateral.",
        "**Reiniciar**: interrupção curta; as sessões dos usuários são encerradas e os ESP32 reconectam.",
        "**Parar**: desliga também o watchdog, senão ele religaria a aplicação. Use para manutenção prolongada.",
        "**Iniciar**: sobe a aplicação e religa o watchdog."
      ] },
      { t: "p", texto: "Os **registros** mostram as últimas linhas do journal da aplicação, do watchdog, do console ou do reinício de recuperação. Marque Só avisos e erros para filtrar." }
    ]
  },
  {
    id: "atualizacoes-remoteifes",
    grupo: "Operar",
    titulo: "Atualizar e reverter o RemoteIFES",
    blocos: [
      { t: "p", texto: "Em **Atualizações > RemoteIFES**, o console compara o commit que o processo realmente executa (lido do /health) com o último origin/main." },
      { t: "passos", itens: [
        "Use **Procurar atualizações**: o console busca os commits do GitHub sem tocar no código em execução.",
        "Revise **O que muda**: commits e partes afetadas (servidor, site, firmware…).",
        "Use **Atualizar o RemoteIFES**: backup verificado, troca do código, dependências quando mudaram, reinício e confirmação de que o processo informa o commit novo.",
        "Se a versão nova não confirmar, o console volta sozinho à anterior."
      ] },
      { t: "p", texto: "**Reverter** volta o código para a versão anterior registrada. Reverter código não desfaz mudanças de dados: restaurar um backup é uma decisão separada, em Backups e recuperação." },
      { t: "aviso", nivel: "alerta", texto: "Alterações locais no checkout impedem a atualização. O console nunca usa --force." }
    ]
  },
  {
    id: "atualizacoes-console",
    grupo: "Operar",
    titulo: "Atualizar e reverter o Console",
    blocos: [
      { t: "p", texto: "O Console de Operações tem versão própria, independente do commit do RemoteIFES. Atualizar o console **não** atualiza a aplicação, e vice-versa." },
      { t: "lista", itens: [
        "O console procura versões novas sozinho duas vezes por dia e instala a verificada lado a lado; ela vale no próximo início.",
        "**Verificar publicação** consulta o GitHub agora.",
        "**Atualizar o Console** baixa o release, confere a atestação de proveniência e o SHA-256, instala e reinicia o console. A página reconecta sozinha; o RemoteIFES não é afetado.",
        "**Reverter o Console** volta para a versão anterior já verificada, sem rede."
      ] },
      { t: "aviso", nivel: "info", texto: "Sem Internet, a versão instalada continua funcionando normalmente. Uma versão nova que não se mantém no ar é revertida automaticamente." }
    ]
  },
  {
    id: "dados",
    grupo: "Operar",
    titulo: "Backups, restauração e recuperação de conta",
    blocos: [
      { t: "p", texto: "Um backup é um snapshot consistente e verificado do banco SQLite, feito com a aplicação no ar. Ele não inclui .env, firmware, APKs, certificados nem o estado do console." },
      { t: "p", texto: "**Restaurar** troca o banco atual pelo backup escolhido, com a aplicação parada. Tudo o que aconteceu depois do backup é perdido; o banco atual é guardado como cópia pré-restauração antes da troca." },
      { t: "p", texto: "**Redefinir a senha do superadministrador** recupera o acesso ao RemoteIFES quando ninguém consegue entrar. A senha vai ao processo por stdin e não aparece em linha de comando, log ou auditoria." },
      { t: "aviso", nivel: "alerta", texto: "Uma trava de manutenção residual só pode ser removida quando o processo dono não existe mais. Idade não é prova de abandono." }
    ]
  },
  {
    id: "rede",
    grupo: "Operar",
    titulo: "Rede e acesso à aplicação",
    blocos: [
      { t: "p", texto: "O **modo de teste** libera o acesso de qualquer rede. Desligado, só as **faixas autorizadas** (CIDR IPv4, como 10.10.0.0/16) abrem a aplicação. O site só exibe estes valores; eles são alterados aqui ou pelo terminal com npm run redes." },
      { t: "p", texto: "O **diagnóstico** confere domínio, DNS, certificado, proxy Nginx e sondas locais, do ponto de vista do próprio host. lan-setup.sh e https-setup.sh continuam como procedimento de terminal, porque instalam pacotes e reescrevem o Nginx e o .env." }
    ]
  },
  {
    id: "web",
    grupo: "Aplicativos e CI",
    titulo: "Site e PWA",
    blocos: [
      { t: "p", texto: "Em produção, o próprio servidor entrega o site na mesma origem da API. A aba **Web e PWA** mostra a versão do frontend, o endereço da aplicação e se ela pode ser instalada como aplicativo." },
      { t: "lista", itens: [
        "A PWA só é instalável em **HTTPS**. Sem domínio com certificado, o site funciona no navegador, mas não como aplicativo instalado.",
        "Para instalar: abra o endereço no navegador do aparelho e use Instalar aplicativo ou Adicionar à tela inicial.",
        "A **demonstração no GitHub Pages** é opcional; Publicar demonstração dispara o workflow Pages e o console acompanha a execução."
      ] }
    ]
  },
  {
    id: "android",
    grupo: "Aplicativos e CI",
    titulo: "Android: APK publicado, builds e publicação",
    blocos: [
      { t: "p", texto: "O **APK publicado** é o que o RemoteIFES oferece na página Aplicativo. O console mostra versão, build, tamanho e SHA-256, baixa o arquivo e **confere a integridade** recalculando o SHA-256. Ele só oferece o APK que a própria aplicação ofereceria: release.json válido, origem embutida igual a uma origem desta instalação e bytes conferidos; caso contrário, mostra o motivo." },
      { t: "p", texto: "Os **builds de validação** rodam no GitHub Actions: **Gerar build de validação** inicia o workflow Android, o console acompanha os jobs e oferece os artefatos para baixar. Esses APKs servem para teste; nenhum é de produção." },
      { t: "h", texto: "Publicar uma versão de produção" },
      { t: "p", texto: "A publicação exige a chave de produção e o Android SDK (apksigner e apkanalyzer), que **não** ficam neste host. O console mostra os comandos já preenchidos com o endereço desta instalação e a pasta que o servidor entrega. Depois de copiar os arquivos, use **Conferir integridade**." },
      { t: "aviso", nivel: "alerta", texto: "O Android só atualiza um aplicativo instalado quando o versionCode cresce e a assinatura é a mesma. Perder a chave de produção impede atualizar as instalações existentes." }
    ]
  },
  {
    id: "ios",
    grupo: "Aplicativos e CI",
    titulo: "iOS",
    blocos: [
      { t: "p", texto: "O workflow iOS compila e testa o aplicativo num simulador macOS do GitHub Actions. Ele não produz IPA distribuível nem envio à App Store. O console inicia o build, acompanha os jobs e baixa os registros do simulador." }
    ]
  },
  {
    id: "ci",
    grupo: "Aplicativos e CI",
    titulo: "Builds e CI no GitHub Actions",
    blocos: [
      { t: "p", texto: "A aba **Builds e CI** lista as últimas execuções de cada workflow no ramo main. Tocar numa execução abre o acompanhamento: jobs, etapas, artefatos e ações." },
      { t: "lista", itens: [
        "**Validar o commit em execução** dispara a validação completa exigindo exatamente o commit que o servidor executa.",
        "**Repetir falhas** repete só os jobs que falharam; **Repetir tudo** repete a execução inteira.",
        "**Cancelar** interrompe uma execução em andamento.",
        "Execuções em andamento são atualizadas sozinhas enquanto o acompanhamento estiver aberto."
      ] },
      { t: "aviso", nivel: "info", texto: "Workflow verde, artefato disponível, APK publicado e aplicativo instalado são estados diferentes: um não implica o outro." }
    ]
  },
  {
    id: "credencial",
    grupo: "Aplicativos e CI",
    titulo: "Credencial do GitHub",
    blocos: [
      { t: "p", texto: "Acompanhar e acionar a CI exige um token do GitHub guardado no estado do console. O valor nunca volta por API, log ou auditoria; o console mostra só se ele existe, o formato e quando foi gravado." },
      { t: "passos", itens: [
        "No GitHub, crie um token fine-grained limitado ao repositório SENAI4LIFE/RemoteIFES.",
        "Conceda **Actions: leitura e escrita** e **Metadata: leitura**. Nada além disso é necessário.",
        "Em Aplicativos e CI > Configuração, cole o token e use **Gravar credencial**. A senha do operador é pedida.",
        "Use **Conferir acesso** para confirmar que o token alcança o repositório."
      ] },
      { t: "aviso", nivel: "info", texto: "Sem credencial, o console e o RemoteIFES funcionam normalmente; só o acompanhamento da CI fica indisponível." }
    ]
  },
  {
    id: "console",
    grupo: "Console",
    titulo: "Console instalado e plataforma",
    blocos: [
      { t: "p", texto: "Mostra a versão do programa, o sistema, a arquitetura e as **capacidades** disponíveis. Um recurso indisponível diz por quê (não instalado, sem permissão, não se aplica), e o servidor do console recusa a operação de verdade, não só apaga o botão." },
      { t: "p", texto: "O console roda de uma pasta própria, fora do checkout, com versões lado a lado. O estado (operadores, auditoria, histórico) fica em outro diretório." }
    ]
  },
  {
    id: "desinstalar",
    grupo: "Console",
    titulo: "Desinstalar o Console",
    blocos: [
      { t: "p", texto: "Desinstalar remove **apenas o Console de Operações**. O RemoteIFES, seu serviço, o banco e os backups continuam funcionando, e **operadores, auditoria e histórico ficam preservados** para uma reinstalação." },
      { t: "passos", itens: [
        "Use **Simular desinstalação** para ver exatamente o que seria removido, sem mudar nada.",
        "Use **Desinstalar o Console**, confirme a senha e digite desinstalar.",
        "A página perde a conexão quando o console é encerrado; isso é esperado."
      ] },
      { t: "p", texto: "Quando a instalação pertence ao root (Linux com systemd), ao pacote .deb ou ao Windows, o console mostra o motivo e o comando exato para o terminal ou para o sistema, porque ele próprio roda sem esse privilégio." },
      { t: "aviso", nivel: "info", texto: "Para apagar também operadores e auditoria, use o desinstalador no terminal com --apagar-estado." }
    ]
  },
  {
    id: "seguranca",
    grupo: "Console",
    titulo: "Segurança, auditoria e Terminal Expert",
    blocos: [
      { t: "p", texto: "A **auditoria** registra metadados de cada operação (quem, o quê, quando, resultado), nunca senhas, tokens ou conteúdo de terminal. O **histórico de operações** guarda a saída das operações longas." },
      { t: "p", texto: "O **Terminal Expert** abre um shell no host. Ele exige o módulo node-pty, destravamento e senha, encerra-se por ociosidade e não filtra a saída: um arquivo com credenciais aberto nele aparece na tela." },
      { t: "p", texto: "**Trocar minha senha** encerra a sessão; entre de novo com a senha nova." }
    ]
  },
  {
    id: "problemas",
    grupo: "Problemas",
    titulo: "Quando algo dá errado",
    blocos: [
      { t: "lista", itens: [
        "**RemoteIFES não responde**: veja os registros da aplicação em Serviço e registros e reinicie. Se o banco estiver corrompido, restaure um backup.",
        "**Operação com desfecho desconhecido**: o console não conseguiu comprovar o resultado. Confira o estado no Início antes de repetir.",
        "**Trava de manutenção residual**: remova-a em Backups e recuperação quando o processo dono não existir mais.",
        "**Atualização recusada por alterações locais**: salve ou reverta as alterações no checkout pelo terminal.",
        "**CI indisponível**: grave ou confira a credencial do GitHub. Sem Internet, nada da operação do prédio é afetado.",
        "**A página do console não abre**: confira o túnel SSH e use ./console.sh --status no host."
      ] }
    ]
  },
  {
    id: "terminal",
    grupo: "Problemas",
    titulo: "Recuperação pelo terminal",
    blocos: [
      { t: "p", texto: "Se o console não estiver disponível, os mesmos procedimentos existem no terminal do host:" },
      { t: "comando", texto: "sudo systemctl status remoteifes.service\nsudo journalctl -u remoteifes.service -f" },
      { t: "comando", texto: "cd remoteifes-server\nnpm run backup\nnpm run restore -- <arquivo>" },
      { t: "comando", texto: "cd remoteifes-server\nbash deploy.sh\nbash rollback.sh" },
      { t: "p", texto: "Ao parar o serviço por mais de alguns minutos, pare também o watchdog (sudo systemctl stop remoteifes-health.timer) e religue-o ao terminar." }
    ]
  },
  {
    id: "acessibilidade",
    grupo: "Problemas",
    titulo: "Acessibilidade e uso por teclado",
    blocos: [
      { t: "p", texto: "O painel de acessibilidade ajusta tamanho da fonte, espaçamento entre letras, altura da linha, tipo de fonte (inclusive uma opção para dislexia), alto contraste, destaque de links e redução de animações. As escolhas ficam guardadas neste navegador e voltam a valer depois de sair e entrar de novo." },
      { t: "p", texto: "Todos os controles funcionam por teclado, com foco visível. Estados nunca dependem só de cor: cada um tem texto e ícone." }
    ]
  }
];
