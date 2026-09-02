const adminSections = require("./documentation/adminSections");
const superSections = [
  ...require("./documentation/superDevices"),
  ...require("./documentation/superOperations"),
  ...require("./documentation/superInfrastructure"),
  ...require("./documentation/superRelease"),
];

const PUBLIC_SECTION_IDS = new Set([
  "inicio", "navegacao", "inicio-acoes", "papeis", "selecao-sala", "estados-sala",
  "controlador", "controle-acesso-sala", "conta-sessao", "conexao", "relatos",
  "pwa-mobile", "acessibilidade", "solucao-problemas",
]);

const adminHelp = {
  agenda: { titulo: "Como usar: Agendamentos", itens: [
    { titulo: "Criar", texto: "Escolha sala, horário, temperatura e comportamento; o servidor recusa conflito e dados fora dos limites." },
    { titulo: "Corrigir", texto: "Não há edição: desative ou exclua o item e recrie com os dados corretos." },
  ] },
  grade: { titulo: "Como usar: Grade do dia", itens: [{ titulo: "Consulta", texto: "Selecione sala e data para comparar períodos livres, reservados e ligados antes de agendar." }] },
  usuarios: { titulo: "Como usar: Usuários", itens: [{ titulo: "Limite do papel", texto: "Admin mantém contas comuns; somente Superadministrador promove ou altera administradores." }] },
  ativos: { titulo: "Como usar: Ativos", itens: [{ titulo: "Presença", texto: "A lista diferencia online, inativo e offline pelo uso da sessão e limiar configurado." }] },
  sessoes: { titulo: "Como usar: Sessões", itens: [{ titulo: "Histórico", texto: "Filtre por data; preserve registros exigidos antes de usar exclusão irreversível." }] },
  logs: { titulo: "Como usar: Logs", itens: [{ titulo: "Comandos", texto: "Filtre sala/data e compare comando, usuário ou sistema, origem e horário." }] },
  dispositivos: { titulo: "Como usar: Dispositivos", itens: [{ titulo: "Eventos", texto: "Correlacione quedas e retornos do controlador com comandos e relatos." }] },
  notificacoes: { titulo: "Como usar: Notificações de dispositivos", itens: [{ titulo: "Fila compartilhada", texto: "A aba e o sino mostram a mesma lista; marcar como lida vale para todos os administradores." }] },
  acessos: { titulo: "Como usar: Acessos ESP32", itens: [{ titulo: "Evidência", texto: "Filtre os acessos registrados pelos controladores; eles não confirmam resposta física do ar-condicionado." }] },
  proprietarios: { titulo: "Como usar: Proprietários de sala", itens: [{ titulo: "Delegação", texto: "Associe usuário comum à sala; ele passará a manter a lista de acesso em Config." }] },
  mapa: { titulo: "Como usar: Mapa", itens: [{ titulo: "Triagem", texto: "Use conexão, energia e reserva como visão geral e abra a sala ou histórico para investigar." }] },
};

const superHelp = {
  energia: { titulo: "Como usar: Energia", itens: [{ titulo: "Estimativa", texto: "Informe watts elétricos e tipo; confira cobertura/parcial antes de comparar. Não é medição para faturamento." }] },
  macs: { titulo: "Como usar: ESP32 / MACs", itens: [{ titulo: "Vínculo", texto: "Confirme fisicamente a placa, vincule o MAC à sala e valide limites, restrição e status." }] },
  config: { titulo: "Como usar: Configurações", itens: [{ titulo: "Impacto global", texto: "Registre valores anteriores; salve só a mudança planejada e valide sessões, rede e dispositivos." }] },
  esp32: { titulo: "Como usar: ESP32", itens: [
    { titulo: "Manutenção", texto: "Use configuração/IR em uma sala por vez e retorne a placa ao modo de operação." },
    { titulo: "Segurança", texto: "OTA, credenciais e Resetar Wi-Fi exigem plano de validação ou acesso físico." },
  ] },
  monitoramento: { titulo: "Como usar: Monitoramento", itens: [{ titulo: "Triagem", texto: "Identifique o cartão em alerta, correlacione o horário e valide a normalização após corrigir uma causa." }] },
  heatmap: { titulo: "Como usar: Mapa de calor operacional", itens: [
    { titulo: "Sob demanda", texto: "Expanda, escolha métrica/período e atualize; a consulta agrega históricos existentes." },
    { titulo: "Leitura", texto: "Frio é melhor e quente é pior; números, legenda e tabela sempre acompanham a cor." },
  ] },
  auditoria: { titulo: "Como usar: Auditoria", itens: [{ titulo: "Consulta", texto: "Filtre evento/ator/alvo e indisponibilidades; preserve externamente o que precisar superar a retenção." }] },
  relatos: { titulo: "Como usar: Relatos de problemas", itens: [
    { titulo: "Fluxo", texto: "Revise contexto, mova para análise, responda, resolva ou reabra." },
    { titulo: "Exclusão", texto: "Duas confirmações removem conteúdo e histórico permanentemente; auditoria guarda só metadados." },
  ] },
};

function validar() {
  const todas = [...adminSections, ...superSections];
  const ids = new Set(PUBLIC_SECTION_IDS);
  for (const secao of todas) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(secao.id || "")) throw new Error(`ID inválido na documentação: ${secao.id}`);
    if (ids.has(secao.id)) throw new Error(`ID duplicado na documentação: ${secao.id}`);
    ids.add(secao.id);
    if (!['admin', 'superadmin'].includes(secao.papel)) throw new Error(`papel inválido em ${secao.id}`);
    if (!secao.categoria || !Array.isArray(secao.corpo)) throw new Error(`seção incompleta: ${secao.id}`);
  }
  for (const secao of todas) {
    for (const bloco of secao.corpo) {
      if (bloco.t !== "links") continue;
      for (const link of bloco.itens || []) {
        if (!ids.has(link.id)) throw new Error(`link quebrado em ${secao.id}: ${link.id}`);
      }
    }
  }
  return true;
}

validar();

function para(usuario) {
  if (!usuario || !usuario.isAdmin) return { secoes: [], ajuda: {} };
  if (usuario.nivel === 3) {
    return { secoes: [...adminSections, ...superSections], ajuda: { ...adminHelp, ...superHelp } };
  }
  return { secoes: [...adminSections], ajuda: { ...adminHelp } };
}

module.exports = { para, validar, _adminSections: adminSections, _superSections: superSections };
