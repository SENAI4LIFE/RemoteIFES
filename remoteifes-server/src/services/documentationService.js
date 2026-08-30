const adminSections = [
  { id: "agenda-grade", titulo: "Agendamentos e Grade", papel: "admin", verNoApp: "/agenda", corpo: [
    { t: "p", texto: "Em <strong>Agenda</strong>, escolha sala, horário, temperatura e se a reserva apenas bloqueia o período ou também liga o aparelho." },
    { t: "p", texto: "Em <strong>Grade</strong>, consulte os períodos livres, reservados ou ligados antes de criar um agendamento." },
  ] },
  { id: "notificacoes", titulo: "Notificações de dispositivos", papel: "admin", corpo: [
    { t: "p", texto: "O sino reúne eventos de conexão dos ESP32 e alertas operacionais. Uma notificação pode ser marcada individualmente ou todas de uma vez." },
  ] },
  { id: "administracao", titulo: "Administração", papel: "admin", verNoApp: "/admin/usuarios", corpo: [
    { t: "p", texto: "Administradores gerenciam usuários comuns, sessões, logs, eventos de dispositivos, acessos, proprietários de sala e o mapa geral." },
    { t: "lista", itens: [
      "<strong>Usuários</strong>: criar contas, atualizar identificação e senha, controlar ativação e permissões operacionais.",
      "<strong>Ativos e Sessões</strong>: acompanhar presença e histórico de acesso.",
      "<strong>Logs, Dispositivos e Acessos ESP32</strong>: consultar a auditoria disponível ao administrador.",
      "<strong>Proprietários de sala</strong>: delegar a gestão de acesso de salas específicas.",
    ] },
    { t: "nota", texto: "Configuração global, credenciais, OTA, monitoramento, relatos de problemas e infraestrutura não fazem parte do acesso de administrador comum." },
  ] },
];

const superSections = [
  { id: "esp32-cadastro", titulo: "Cadastro de ESP32 por sala", papel: "superadmin", verNoApp: "/admin/macs", corpo: [
    { t: "p", texto: "Associe cada sala ao MAC do controlador detectado, configure limites específicos e, quando necessário, restrinja o controle a usuários autorizados." },
  ] },
  { id: "esp32-avancado", titulo: "ESP32 — funções avançadas", papel: "superadmin", verNoApp: "/admin/esp32", corpo: [
    { t: "lista", itens: ["Entrar e sair do modo de configuração.", "Capturar e testar sinais infravermelhos.", "Selecionar protocolo, atualizar firmware por OTA e resetar a configuração Wi-Fi."] },
  ] },
  { id: "monitoramento", titulo: "Monitoramento e saúde do sistema", papel: "superadmin", verNoApp: "/admin/monitoramento", corpo: [
    { t: "p", texto: "Acompanhe serviço, banco, armazenamento, backups, controladores, credenciais e contadores de falha. A tela atualiza enquanto permanece aberta." },
  ] },
  { id: "relatos-gestao", titulo: "Relatos de problemas (gestão)", papel: "superadmin", verNoApp: "/admin/relatos", corpo: [
    { t: "p", texto: "Em <strong>Administração &rsaquo; Relatos de problemas</strong>, o superadministrador filtra os relatos por situação (novo, aberto, em análise, resolvido), abre cada um para revisar o contexto, escreve uma resposta visível ao autor e move a situação: marcar em análise, resolver ou reabrir. Abrir um relato novo já o marca como aberto." },
    { t: "p", texto: "A janela de detalhe também permite <strong>excluir permanentemente</strong> um relato já enviado, após uma confirmação em duas etapas dentro da própria janela. A exclusão remove a descrição, a resposta e o histórico de revisão, não pode ser desfeita e não depende da situação do relato." },
    { t: "nota", texto: "Os usuários enviam relatos pelo botão de inseto presente em qualquer tela; o formulário de envio não faz parte desta seção de gestão. Nenhum relato é removido automaticamente — a exclusão é sempre manual e deliberada." },
  ] },
  { id: "backup", titulo: "Backup e recuperação", papel: "superadmin", corpo: [
    { t: "p", texto: "Confira a execução e a idade dos backups no monitoramento. No host, use <code>cd remoteifes-server && npm run backup</code> para uma cópia manual verificada." },
    { t: "passos", itens: ["Pare o serviço antes da restauração.", "Execute <code>npm run restore</code> para listar as cópias ou <code>npm run restore -- &lt;arquivo&gt;</code> para escolher uma.", "Reinicie o serviço, execute a verificação de saúde e confirme autenticação, banco e controladores."] },
    { t: "nota", texto: "Guarde cópias fora do host e teste a restauração periodicamente. Nunca copie apenas o arquivo SQLite ativo ignorando o WAL." },
  ] },
  { id: "ota-credenciais", titulo: "OTA e credenciais por dispositivo", papel: "superadmin", verNoApp: "/admin/esp32", corpo: [
    { t: "p", texto: "A publicação OTA usa imagem versionada e SHA-256; o dispositivo valida antes de gravar e pode reverter após falha de inicialização." },
    { t: "p", texto: "Credenciais exclusivas podem ser provisionadas, rotacionadas, substituídas ou revogadas. O segredo é mostrado uma única vez e nunca integra esta documentação." },
  ] },
  { id: "operacao-admin", titulo: "Operação, implantação e manutenção", papel: "superadmin", corpo: [
    { t: "p", texto: "Procedimentos de terminal, configuração do servidor, implantação, reversão, serviços, diagnóstico e manutenção são exclusivos do superadministrador." },
    { t: "lista", itens: [
      "<strong>Preparação</strong>: <code>cd remoteifes-server &amp;&amp; npm ci &amp;&amp; npm run setup</code>.",
      "<strong>Serviço</strong>: use <code>npm run install-service</code> na instalação e o gerenciador de serviços do host para iniciar, parar, reiniciar e consultar o estado.",
      "<strong>Implantação</strong>: execute <code>npm run deploy</code>; confirme o backup prévio, a versão alvo e o retorno saudável.",
      "<strong>Reversão</strong>: execute <code>npm run rollback</code> quando a verificação pós-implantação falhar.",
      "<strong>Diagnóstico</strong>: execute <code>npm run health</code> e revise os logs do serviço sem copiar tokens ou segredos.",
      "Mantenha restrição de rede, HTTPS, variáveis de produção, backups e cache da aplicação alinhados à instalação.",
      "Nunca registre senhas, tokens, credenciais de dispositivo ou conteúdo de arquivos de ambiente no manual ou em relatos.",
    ] },
  ] },
  { id: "configuracao-servidor", titulo: "Configuração do servidor e do website", papel: "superadmin", corpo: [
    { t: "lista", itens: [
      "Defina o ambiente de produção, a origem CORS exata, a política de proxy confiável, o diretório persistente de dados e as redes autorizadas no arquivo de ambiente protegido do host.",
      "Use HTTPS sempre que o tráfego sair de uma rede local controlada. Não publique arquivos de ambiente, bancos, backups, keystores ou diretórios de release em hospedagem estática.",
      "Após alterar assets web, incremente a versão do cache do service worker, valide instalação/atualização da PWA e sincronize novamente o projeto Cordova.",
      "Para Android, gere com origem fixa e keystore de produção; publique somente após apksigner, verificação de debuggable, versão/build, SHA-256 e certificado. O APK servido fica preso à origem do build — outra implantação exige um APK novo.",
      "Mantenha o keystore e as senhas de assinatura fora do controle de versão e com backup próprio em cofre ou mídia offline: perder a chave impede atualizações em aparelhos já instalados.",
    ] },
  ] },
];

const adminHelp = {
  agenda: { titulo: "Como usar: Agendamentos", itens: [{ titulo: "Reserva", texto: "Escolha sala, período e comportamento; conflitos são recusados pelo servidor." }] },
  grade: { titulo: "Como usar: Grade do dia", itens: [{ titulo: "Consulta", texto: "Selecione sala e data para conferir períodos livres, reservados e ligados." }] },
  usuarios: { titulo: "Como usar: Usuários", itens: [{ titulo: "Contas", texto: "Crie e atualize somente contas que seu nível pode administrar." }] },
  ativos: { titulo: "Como usar: Ativos", itens: [{ titulo: "Presença", texto: "A lista diferencia sessões online, inativas e encerradas." }] },
  sessoes: { titulo: "Como usar: Sessões", itens: [{ titulo: "Histórico", texto: "Filtre por data e preserve registros necessários para auditoria." }] },
  logs: { titulo: "Como usar: Logs", itens: [{ titulo: "Comandos", texto: "Consulte ação, sala, origem e horário dos comandos registrados." }] },
  dispositivos: { titulo: "Como usar: Dispositivos", itens: [{ titulo: "Eventos", texto: "Consulte mudanças de conexão dos controladores." }] },
  acessos: { titulo: "Como usar: Acessos ESP32", itens: [{ titulo: "Auditoria", texto: "Consulte requisições dos dispositivos dentro da permissão administrativa." }] },
  proprietarios: { titulo: "Como usar: Proprietários de sala", itens: [{ titulo: "Delegação", texto: "Associe um usuário comum somente às salas que ele deverá administrar." }] },
  mapa: { titulo: "Como usar: Mapa", itens: [{ titulo: "Visão geral", texto: "As cores refletem conexão, energia e reserva das salas." }] },
};

const superHelp = {
  macs: { titulo: "Como usar: ESP32 / Salas", itens: [{ titulo: "Vínculo", texto: "Associe dispositivos detectados, limites e acesso às salas corretas." }] },
  config: { titulo: "Como usar: Configurações", itens: [{ titulo: "Escopo", texto: "Mudanças globais afetam segurança, sessões, rede e todos os controladores." }] },
  esp32: { titulo: "Como usar: ESP32", itens: [{ titulo: "Operação avançada", texto: "Use configuração, IR, OTA, credenciais e reset somente no dispositivo selecionado." }] },
  monitoramento: { titulo: "Como usar: Monitoramento", itens: [{ titulo: "Saúde", texto: "Revise alertas de serviço, banco, disco, backup, controladores e credenciais." }] },
  relatos: { titulo: "Como usar: Relatos de problemas", itens: [
    { titulo: "Fluxo", texto: "Filtre por situação, abra um relato para revisar o contexto, responda ao autor e mova entre em análise, resolvido e reaberto." },
    { titulo: "Envio", texto: "Novos relatos chegam pelo botão de inseto usado pelos usuários; esta seção é só de gestão." },
    { titulo: "Exclusão", texto: "A janela de detalhe permite excluir um relato de forma permanente, após confirmação em duas etapas; a ação não pode ser desfeita." },
  ] },
};

function para(usuario) {
  if (!usuario || !usuario.isAdmin) return { secoes: [], ajuda: {} };
  if (usuario.nivel === 3) return { secoes: [...adminSections, ...superSections], ajuda: { ...adminHelp, ...superHelp } };
  return { secoes: adminSections, ajuda: adminHelp };
}

module.exports = { para };
