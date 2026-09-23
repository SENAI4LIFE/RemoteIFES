const fs = require("fs");
const path = require("path");
const config = require("./config");
const estado = require("./estado");
const processos = require("./processos");
const execucao = require("./execucao");
const coleta = require("./coleta");
const prontidaoMod = require("./prontidao");
const repositorio = require("./repositorio");
const trava = require("./trava");

// Registro de ações gerenciadas.
//
// Toda operação do console passa por aqui, identificada por um id fixo e com argumentos
// estruturados e validados. Não existe endpoint que receba uma linha de comando.
//
// Observação importante: `src/services/documentation/commands.js`, do servidor, é um catálogo
// de **texto de documentação** — tem espaços reservados (`<dominio>`, `<arquivo>`),
// alternativas, pipelines e exemplos de várias linhas. Ele nunca é avaliado como ação; as duas
// listas são independentes de propósito.

const RE_COMMIT = /^[0-9a-f]{7,40}$/;
const RE_REF = /^[A-Za-z0-9._\/-]{1,120}$/;
const RE_BACKUP = /^(?:remoteifes|pre-restauracao)-\d{8}-\d{6}-[0-9a-f]{6}(?:-[a-z0-9-]+)?\.db$/;

function erroDeValidacao(mensagem) {
  const erro = new Error(mensagem);
  erro.codigo = "argumento-invalido";
  return erro;
}

function nodeExecutavel() {
  return process.execPath;
}

function caminhoBin(nome) {
  return path.join(config.RAIZ_CONSOLE, "bin", nome);
}

// --- Definição das ações -------------------------------------------------------------------

const ACOES = [
  {
    id: "saude.verificar",
    rotulo: "Verificar saúde agora",
    grupo: "servico",
    proposito: "Consulta o /health do processo em execução e mostra banco, ambiente, commit e tempo no ar.",
    impacto: "Nenhum: é só leitura.",
    exigeElevacao: false,
    confirmacao: null,
    imediata: true,
    async executarImediata() {
      const saude = await coleta.consultarSaude();
      return { ok: saude.respondeu && saude.ok, saude };
    },
  },

  {
    id: "servico.reiniciar",
    rotulo: "Reiniciar o RemoteIFES",
    grupo: "servico",
    proposito: "Reinicia remoteifes.service para aplicar configuração ou código já presentes no disco.",
    impacto:
      "Interrupção curta. Todas as sessões de usuário são invalidadas (a aplicação encerra as sessões ativas na partida) " +
      "e os ESP32 precisam reconectar. Agendamentos em curso são reavaliados na volta.",
    exigeElevacao: true,
    confirmacao: null,
    prontidao: { interrompeServico: true },
    montar({ operador }) {
      return {
        acao: "servico.reiniciar",
        rotulo: "Reiniciar o RemoteIFES",
        operador,
        executavel: nodeExecutavel(),
        argumentos: [caminhoBin("servico.js"), "reiniciar"],
        cwd: config.RAIZ_CONSOLE,
        exigeTrava: false,
        timeoutMs: 120_000,
        cancelavel: false,
        verificar: () => verificarAplicacaoSaudavel(),
      };
    },
  },

  {
    id: "servico.parar",
    rotulo: "Parar o RemoteIFES",
    grupo: "servico",
    proposito: "Para a aplicação para manutenção prolongada e desliga o watchdog para que ele não a reinicie.",
    impacto:
      "O RemoteIFES fica fora do ar: sem controle de salas, sem agendamento e sem comando para os ESP32. " +
      "O watchdog é desligado junto — do contrário ele reiniciaria a aplicação em até ~6 minutos, " +
      "porque parar o serviço, por si só, não é uma parada intencional durável.",
    exigeElevacao: true,
    confirmacao: "parar",
    prontidao: { interrompeServico: true },
    montar({ operador }) {
      return {
        acao: "servico.parar",
        rotulo: "Parar o RemoteIFES",
        operador,
        executavel: nodeExecutavel(),
        argumentos: [caminhoBin("servico.js"), "parar"],
        cwd: config.RAIZ_CONSOLE,
        exigeTrava: false,
        timeoutMs: 90_000,
        cancelavel: false,
        verificar: async () => {
          const saude = await coleta.consultarSaude({ timeoutMs: 2000 });
          return saude.respondeu
            ? { ok: false, resumo: "o serviço foi parado, mas algo continua respondendo na porta da aplicação" }
            : { ok: true, resumo: "aplicação parada e watchdog desligado" };
        },
      };
    },
  },

  {
    id: "servico.iniciar",
    rotulo: "Iniciar o RemoteIFES",
    grupo: "servico",
    proposito: "Sobe a aplicação e religa o watchdog de saúde.",
    impacto: "Restabelece a operação normal do prédio.",
    exigeElevacao: true,
    confirmacao: null,
    prontidao: {},
    montar({ operador }) {
      return {
        acao: "servico.iniciar",
        rotulo: "Iniciar o RemoteIFES",
        operador,
        executavel: nodeExecutavel(),
        argumentos: [caminhoBin("servico.js"), "iniciar"],
        cwd: config.RAIZ_CONSOLE,
        exigeTrava: false,
        timeoutMs: 120_000,
        cancelavel: false,
        verificar: () => verificarAplicacaoSaudavel(),
      };
    },
  },

  {
    id: "backup.criar",
    rotulo: "Criar backup do banco",
    grupo: "dados",
    proposito: "Gera um snapshot consistente e verificado do banco SQLite, com a aplicação no ar.",
    impacto:
      "Sem interrupção. Usa VACUUM INTO, que lê uma imagem consistente sem copiar o arquivo ativo. " +
      "Consome CPU e disco por alguns segundos e aplica a rotação configurada.",
    exigeElevacao: false,
    confirmacao: null,
    esquema: {
      rotulo: { tipo: "texto", padrao: "console", regex: /^[a-z0-9][a-z0-9-]{0,30}$/, obrigatorio: false },
    },
    prontidao: {},
    montar({ operador, argumentos }) {
      const rotulo = argumentos.rotulo || "console";
      return {
        acao: "backup.criar",
        rotulo: "Criar backup do banco",
        operador,
        argumentosVisiveis: { rotulo },
        executavel: nodeExecutavel(),
        argumentos: [caminhoBin("backup.js"), rotulo],
        cwd: config.RAIZ_CONSOLE,
        exigeTrava: false,
        timeoutMs: 15 * 60 * 1000,
        verificar: async ({ estadoFinal }) => {
          if (estadoFinal !== execucao.ESTADOS.CONCLUIDO) return null;
          const backups = coleta.listarBackups();
          if (!backups.ultimo) return { ok: false, resumo: "o script terminou sem erro, mas nenhum backup apareceu na pasta" };
          const idadeS = (Date.now() - Date.parse(backups.ultimo.modificadoEm)) / 1000;
          return idadeS < 300
            ? { ok: true, resumo: `${backups.ultimo.nome} (${(backups.ultimo.bytes / 1024).toFixed(0)} KiB)` }
            : { ok: false, resumo: "o backup mais recente não é desta execução" };
        },
      };
    },
  },

  {
    id: "backup.restaurar",
    rotulo: "Restaurar banco a partir de um backup",
    grupo: "dados",
    proposito: "Substitui o banco atual por um backup verificado, com a aplicação parada e o watchdog desligado.",
    impacto:
      "DESTRUTIVO. Toda a atividade do prédio registrada depois do backup escolhido é perdida: comandos, " +
      "agendamentos, relatos, auditoria e contas criadas nesse intervalo. A aplicação fica fora do ar durante a troca. " +
      "O banco atual é preservado como cópia pré-restauração antes da substituição.",
    exigeElevacao: true,
    confirmacao: "restaurar",
    esquema: {
      backup: { tipo: "texto", regex: RE_BACKUP, obrigatorio: true },
      recuperarCorrompido: { tipo: "booleano", padrao: false, obrigatorio: false },
    },
    prontidao: { exigeAplicacaoParada: false, interrompeServico: true },
    montar({ operador, argumentos }) {
      const args = [caminhoBin("restaurar.js"), argumentos.backup];
      if (argumentos.recuperarCorrompido) args.push("--recuperar-corrompido");
      return {
        acao: "backup.restaurar",
        rotulo: `Restaurar ${argumentos.backup}`,
        operador,
        argumentosVisiveis: { backup: argumentos.backup, recuperarCorrompido: !!argumentos.recuperarCorrompido },
        executavel: nodeExecutavel(),
        argumentos: args,
        cwd: config.RAIZ_CONSOLE,
        exigeTrava: true,
        timeoutMs: 20 * 60 * 1000,
        faseInicial: "validando o backup",
        detectarFase: (texto) => {
          if (texto.includes("Instalando o backup")) return "instalando";
          if (texto.includes("Parando a aplicação")) return "parando a aplicação";
          if (texto.includes("Restabelecendo o ciclo")) return "restabelecendo o serviço";
          return null;
        },
        // A partir da instalação do arquivo não há como voltar atrás por cancelamento: o
        // rollback interno do backupService é a rede de proteção, não um SIGTERM nosso.
        faseIrreversivel: (texto) => texto.includes("Instalando o backup"),
        verificar: () => verificarAplicacaoSaudavel(),
      };
    },
  },

  {
    id: "atualizacao.aplicar",
    rotulo: "Atualizar o RemoteIFES",
    grupo: "atualizacao",
    proposito:
      "Aplica um commit já revisado: backup pré-atualização, troca do checkout, dependências quando mudaram, " +
      "reinício e confirmação de que o processo em execução passou a informar exatamente esse commit.",
    impacto:
      "Interrupção curta e sessões de usuário invalidadas. Se a nova versão não confirmar o commit, " +
      "o deploy reverte sozinho para a anterior. Não é uma operação sem downtime.",
    exigeElevacao: true,
    confirmacao: "atualizar",
    esquema: {
      commit: { tipo: "texto", regex: RE_COMMIT, obrigatorio: true },
      offline: { tipo: "booleano", padrao: false, obrigatorio: false },
    },
    prontidao: { interrompeServico: true, exigeBackup: true, exigeRepositorioLimpo: true },
    async validacaoExtra({ argumentos }) {
      const local = await repositorio.estadoLocal();
      if (!local.repositorio) return local.motivo;
      if (!local.limpo) {
        return (
          "o checkout tem alterações locais não commitadas. Uma atualização normal não as descarta: " +
          "reverta ou salve essas alterações antes. O console nunca usa --force."
        );
      }
      // O alvo tem de existir localmente: só se implanta o que foi revisado e buscado.
      const existe = await repositorio.git(["cat-file", "-e", `${argumentos.commit}^{commit}`]);
      if (!existe.ok) {
        return "este commit não está no checkout. Use 'Verificar atualizações' para buscar os objetos de origin antes de aplicar.";
      }
      return null;
    },
    montar({ operador, argumentos }) {
      const args = [caminhoBin("implantar.js"), "aplicar", argumentos.commit];
      if (argumentos.offline) args.push("--offline");
      return {
        acao: "atualizacao.aplicar",
        rotulo: `Atualizar para ${argumentos.commit.slice(0, 8)}`,
        operador,
        argumentosVisiveis: { commit: argumentos.commit, offline: !!argumentos.offline },
        executavel: nodeExecutavel(),
        argumentos: args,
        cwd: config.RAIZ_CONSOLE,
        // A trava de manutenção é adquirida pelo **runner**, não aqui. Quando o console a
        // adquiria e em seguida chamava deploy.sh, o script tentava adquirir a mesma trava com
        // noclobber e abortava sempre. A prontidão já detecta conflito antes de confirmar.
        exigeTrava: false,
        env: { CONSOLE_OPERADOR: operador },
        timeoutMs: 45 * 60 * 1000,
        faseInicial: "preparando",
        detectarFase: (texto) => {
          if (texto.includes("Backup do banco")) return "backup pré-atualização";
          if (texto.includes("npm ci")) return "instalando dependências";
          if (texto.includes("Reiniciando o serviço")) return "reiniciando";
          if (texto.includes("confirmado pelo processo")) return "confirmado";
          if (texto.includes("Revertendo para")) return "revertendo";
          return null;
        },
        faseIrreversivel: (texto) => texto.includes("Reiniciando o serviço"),
        verificar: async ({ estadoFinal }) => {
          if (estadoFinal !== execucao.ESTADOS.CONCLUIDO) return null;
          return verificarCommitEmExecucao(argumentos.commit);
        },
      };
    },
  },

  {
    id: "atualizacao.reverter",
    rotulo: "Reverter para a versão anterior",
    grupo: "atualizacao",
    proposito: "Volta o código para a versão anterior registrada (ou uma escolhida) e confirma o processo em execução.",
    impacto:
      "Interrupção curta e sessões invalidadas. Reverter código NÃO desfaz mudanças de dados: " +
      "se a versão revertida usa um esquema mais antigo e incompatível, a restauração do banco é uma decisão separada e explícita.",
    exigeElevacao: true,
    confirmacao: "reverter",
    esquema: {
      ref: { tipo: "texto", regex: RE_REF, obrigatorio: false },
      offline: { tipo: "booleano", padrao: false, obrigatorio: false },
    },
    prontidao: { interrompeServico: true, exigeBackup: true },
    async validacaoExtra({ argumentos }) {
      if (!argumentos.ref) {
        const versoes = coleta.versoesRegistradas();
        if (!versoes.anterior) {
          return "não há versão anterior registrada em data/previous-version; informe explicitamente para onde voltar.";
        }
      }
      return null;
    },
    montar({ operador, argumentos }) {
      const args = [caminhoBin("implantar.js"), "reverter"];
      if (argumentos.ref) args.push(argumentos.ref);
      if (argumentos.offline) args.push("--offline");
      return {
        acao: "atualizacao.reverter",
        rotulo: argumentos.ref ? `Reverter para ${argumentos.ref}` : "Reverter para a versão anterior",
        operador,
        argumentosVisiveis: { ref: argumentos.ref || "(versão anterior registrada)", offline: !!argumentos.offline },
        executavel: nodeExecutavel(),
        argumentos: args,
        cwd: config.RAIZ_CONSOLE,
        // Mesma razão da atualização: quem segura a trava é o runner.
        exigeTrava: false,
        env: { CONSOLE_OPERADOR: operador },
        timeoutMs: 45 * 60 * 1000,
        detectarFase: (texto) => {
          if (texto.includes("Backup do banco")) return "backup pré-rollback";
          if (texto.includes("npm ci")) return "instalando dependências";
          if (texto.includes("Reiniciando o serviço")) return "reiniciando";
          if (texto.includes("confirmado pelo processo")) return "confirmado";
          return null;
        },
        faseIrreversivel: (texto) => texto.includes("Reiniciando o serviço"),
        verificar: () => verificarAplicacaoSaudavel(),
      };
    },
  },

  {
    id: "console.atualizar",
    rotulo: "Atualizar o Console de Operações",
    grupo: "atualizacao",
    proposito:
      "Instala uma versão publicada do console: baixa o artefato do release, confere a assinatura do manifesto e o " +
      "digest, instala lado a lado e troca a versão ativa. Não usa git nem o checkout do RemoteIFES.",
    impacto:
      "Esta sessão do console cai por alguns segundos e a página reconecta sozinha. O RemoteIFES não é afetado. " +
      "A versão anterior fica guardada e a reversão é uma troca de ponteiro.",
    exigeElevacao: true,
    confirmacao: null,
    esquema: {
      versao: { tipo: "texto", regex: /^\d+\.\d+\.\d+$/, obrigatorio: true },
    },
    prontidao: {},
    async validacaoExtra({ argumentos }) {
      const atualizador = require("./atualizador");
      return atualizador.validarAlvo(argumentos.versao);
    },
    montar({ operador, argumentos }) {
      return {
        acao: "console.atualizar",
        rotulo: `Atualizar o console para ${argumentos.versao}`,
        operador,
        argumentosVisiveis: { versao: argumentos.versao },
        executavel: nodeExecutavel(),
        argumentos: [caminhoBin("atualizar-console.js"), argumentos.versao],
        cwd: config.RAIZ_CONSOLE,
        exigeTrava: false,
        timeoutMs: 20 * 60 * 1000,
        cancelavel: false,
        faseIrreversivel: (texto) => texto.includes("Trocando a versão ativa"),
        detectarFase: (texto) => {
          if (texto.includes("Baixando")) return "baixando";
          if (texto.includes("Verificando")) return "verificando";
          if (texto.includes("Instalando")) return "instalando";
          if (texto.includes("Trocando a versão ativa")) return "trocando";
          return null;
        },
      };
    },
  },

  {
    id: "conta.recuperar-superadmin",
    rotulo: "Redefinir a senha do superadministrador",
    grupo: "recuperacao",
    proposito: "Instala uma nova senha na conta de nível 3 da aplicação quando ninguém consegue mais entrar.",
    impacto:
      "Altera a credencial da aplicação e encerra as sessões abertas dessa conta. " +
      "As sessões das outras contas continuam válidas. A senha é enviada pelo corpo da requisição e " +
      "entregue ao processo por stdin: nunca aparece em linha de comando, log ou auditoria.",
    exigeElevacao: true,
    confirmacao: null,
    esquema: {
      senha: { tipo: "segredo", obrigatorio: true, minimo: 8, maximo: 128 },
    },
    prontidao: {},
    montar({ operador, argumentos }) {
      return {
        acao: "conta.recuperar-superadmin",
        rotulo: "Redefinir a senha do superadministrador",
        operador,
        argumentosVisiveis: {},
        executavel: nodeExecutavel(),
        argumentos: [caminhoBin("recuperar-conta.js")],
        cwd: config.RAIZ_CONSOLE,
        entrada: argumentos.senha,
        exigeTrava: false,
        timeoutMs: 60_000,
        cancelavel: false,
      };
    },
  },

  {
    id: "host.reiniciar",
    rotulo: "Reiniciar o host",
    grupo: "host",
    proposito: "Reinicia o Raspberry Pi inteiro.",
    impacto:
      "Tudo para: RemoteIFES, console, rede e este navegador perdem a conexão. " +
      "A volta depende do boot do host; se algo impedir a subida, só acesso físico ou SSH resolve.",
    exigeElevacao: true,
    confirmacao: "reiniciar host",
    prontidao: { interrompeServico: true },
    montar({ operador }) {
      return {
        acao: "host.reiniciar",
        rotulo: "Reiniciar o host",
        operador,
        executavel: nodeExecutavel(),
        argumentos: [caminhoBin("servico.js"), "reiniciar-host"],
        cwd: config.RAIZ_CONSOLE,
        exigeTrava: false,
        timeoutMs: 60_000,
        cancelavel: false,
      };
    },
  },

  {
    id: "console.reverter",
    rotulo: "Reverter o console para a versão anterior",
    grupo: "atualizacao",
    proposito: "Aponta a instalação de volta para a versão anterior já verificada, sem rede.",
    impacto:
      "Esta sessão cai por alguns segundos. Usa a cópia local que já passou pela verificação de assinatura; " +
      "não baixa nada e não consulta o GitHub.",
    exigeElevacao: true,
    confirmacao: null,
    prontidao: {},
    async validacaoExtra() {
      const atualizador = require("./atualizador");
      const versoes = atualizador.versoesInstaladas();
      if (versoes.anterior) return null;
      return "não há versão anterior instalada para a qual voltar.";
    },
    montar({ operador }) {
      return {
        acao: "console.reverter",
        rotulo: "Reverter o console",
        operador,
        executavel: nodeExecutavel(),
        argumentos: [caminhoBin("atualizar-console.js"), "--reverter"],
        cwd: config.RAIZ_CONSOLE,
        exigeTrava: false,
        timeoutMs: 5 * 60 * 1000,
        cancelavel: false,
      };
    },
  },

  {
    id: "manutencao.remover-trava",
    rotulo: "Remover trava de manutenção residual",
    grupo: "recuperacao",
    proposito: "Apaga uma trava .deploy-lock deixada por um processo que não existe mais.",
    impacto:
      "Nenhum, quando a trava é mesmo resíduo. O console recusa remover a trava de um processo vivo, " +
      "por mais antiga que ela seja — idade não é prova de abandono.",
    exigeElevacao: true,
    confirmacao: null,
    imediata: true,
    async executarImediata({ operador }) {
      return trava.removerResiduo(operador);
    },
  },
];

const PORID = new Map(ACOES.map((a) => [a.id, a]));

// --- Verificações de efeito -------------------------------------------------------------------

async function verificarAplicacaoSaudavel() {
  for (let i = 0; i < 15; i += 1) {
    const saude = await coleta.consultarSaude({ timeoutMs: 2000 });
    if (saude.respondeu && saude.ok) {
      return { ok: true, resumo: `aplicação saudável (commit ${saude.commit ? saude.commit.slice(0, 8) : "não informado"})` };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: false, resumo: "a aplicação não voltou a responder saudável dentro do prazo" };
}

async function verificarCommitEmExecucao(esperado) {
  for (let i = 0; i < 20; i += 1) {
    const saude = await coleta.consultarSaude({ timeoutMs: 2000 });
    if (saude.respondeu && saude.ok) {
      if (saude.commit && saude.commit.startsWith(esperado)) {
        return { ok: true, resumo: `processo em execução confirmou ${saude.commit.slice(0, 8)}` };
      }
      if (saude.commit) {
        return {
          ok: false,
          resumo: `o processo em execução informa ${saude.commit.slice(0, 8)}, não ${esperado.slice(0, 8)}: o reinício não aplicou a nova versão`,
        };
      }
      // Versões anteriores ao campo de commit não conseguem confirmar a própria identidade;
      // deploy.sh já trata esse caso e a distinção é preservada aqui.
      return {
        ok: true,
        resumo: "identidade não confirmada: a versão alvo não informa commit no /health; aceito um processo saudável reiniciado",
        identidadeConfirmada: false,
      };
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: false, resumo: "o /health não respondeu saudável depois da atualização" };
}

// --- Validação de argumentos ---------------------------------------------------------------

function validarArgumentos(acao, brutos) {
  const esquema = acao.esquema || {};
  const saida = {};
  const entrada = brutos && typeof brutos === "object" ? brutos : {};
  for (const chave of Object.keys(entrada)) {
    if (!esquema[chave]) throw erroDeValidacao(`argumento não reconhecido: ${chave}`);
  }
  for (const [chave, regra] of Object.entries(esquema)) {
    let valor = entrada[chave];
    if (valor === undefined || valor === null || valor === "") {
      if (regra.obrigatorio) throw erroDeValidacao(`argumento obrigatório ausente: ${chave}`);
      if (regra.padrao !== undefined) saida[chave] = regra.padrao;
      continue;
    }
    if (regra.tipo === "booleano") {
      if (typeof valor !== "boolean") throw erroDeValidacao(`${chave} deve ser booleano`);
      saida[chave] = valor;
      continue;
    }
    if (typeof valor !== "string") throw erroDeValidacao(`${chave} deve ser texto`);
    if (regra.tipo === "segredo") {
      if (valor.length < (regra.minimo || 1) || valor.length > (regra.maximo || 256)) {
        throw erroDeValidacao(`${chave} tem tamanho fora do permitido`);
      }
      saida[chave] = valor;
      continue;
    }
    if (regra.regex && !regra.regex.test(valor)) throw erroDeValidacao(`valor inválido para ${chave}`);
    saida[chave] = valor;
  }
  return saida;
}

// --- API do registro --------------------------------------------------------------------------

function listar() {
  return ACOES.map((a) => ({
    id: a.id,
    rotulo: a.rotulo,
    grupo: a.grupo,
    proposito: a.proposito,
    impacto: a.impacto,
    exigeElevacao: !!a.exigeElevacao,
    confirmacao: a.confirmacao || null,
    imediata: !!a.imediata,
    esquema: Object.fromEntries(
      Object.entries(a.esquema || {}).map(([k, v]) => [k, { tipo: v.tipo, obrigatorio: !!v.obrigatorio, padrao: v.padrao }])
    ),
  }));
}

function obter(id) {
  return PORID.get(id) || null;
}

/**
 * Prepara uma ação: valida argumentos e reavalia a prontidão. Chamado tanto pela tela de
 * confirmação quanto de novo no momento da execução — o estado pode ter mudado no intervalo.
 */
async function preparar(id, brutos) {
  const acao = obter(id);
  if (!acao) throw erroDeValidacao(`ação desconhecida: ${id}`);
  const argumentos = validarArgumentos(acao, brutos);
  let impedimento = null;
  if (typeof acao.validacaoExtra === "function") {
    impedimento = await acao.validacaoExtra({ argumentos });
  }
  const prontidao = acao.prontidao ? await prontidaoMod.avaliar(acao.prontidao) : null;
  return { acao, argumentos, impedimento, prontidao };
}

/**
 * Executa uma ação. Revalida prontidão imediatamente antes de começar: entre a confirmação do
 * operador e este instante pode ter começado um OTA, uma atualização pelo terminal ou o disco
 * pode ter enchido.
 */
async function executar(id, brutos, { operador, forcarAvisos = false } = {}) {
  const { acao, argumentos, impedimento, prontidao } = await preparar(id, brutos);

  if (impedimento) {
    const erro = new Error(impedimento);
    erro.codigo = "impedido";
    throw erro;
  }
  if (prontidao && !prontidao.pronto) {
    const erro = new Error(prontidao.bloqueios.map((b) => `${b.titulo}: ${b.detalhe}`).join(" | "));
    erro.codigo = "bloqueado";
    erro.prontidao = prontidao;
    throw erro;
  }
  if (prontidao && prontidao.avisos.length && !forcarAvisos) {
    const erro = new Error("há avisos que precisam de confirmação explícita");
    erro.codigo = "avisos";
    erro.prontidao = prontidao;
    throw erro;
  }

  if (acao.imediata) {
    const resultado = await acao.executarImediata({ operador, argumentos });
    estado.auditar("acao-imediata", { id, operador, ok: resultado && resultado.ok !== false });
    return { imediata: true, resultado };
  }

  const spec = acao.montar({ operador, argumentos });
  const trabalho = execucao.iniciar(spec);
  return { imediata: false, trabalho };
}

module.exports = { listar, obter, preparar, executar, validarArgumentos, ACOES };
