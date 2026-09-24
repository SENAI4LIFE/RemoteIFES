#!/usr/bin/env node
// Camada estável do Console de Operações.
//
// Este arquivo é instalado pelo pacote (deb, zip, bundle) e **nunca é reescrito por uma
// atualização**. Ele só resolve qual versão está ativa e a carrega. É o que permite que o
// gerenciador de pacotes continue dono de um conjunto fixo de arquivos enquanto o atualizador
// troca o payload lado a lado — os dois modelos não se atropelam.
//
// É também a rede de segurança: se a versão ativa estiver quebrada ou ausente, ele cai para a
// anterior e diz por quê, em vez de deixar o serviço sem subir.

const fs = require("fs");
const path = require("path");

const RAIZ = __dirname;
const ARQUIVO_ESTADO = path.join(RAIZ, "estado-instalacao.json");
const DIR_VERSOES = path.join(RAIZ, "versoes");
// Qual entrada carregar. `launcher-bootstrap.js` marca "launcher"; qualquer outro valor (ou a
// ausência dele) significa o console. Quem inicia o backend precisa mandar o valor
// explicitamente, porque herdar "launcher" de um lançador faria este bootstrap carregar outro
// lançador — e não o console que o lançador estava tentando subir.
const ALVO = process.env.CONSOLE_BOOTSTRAP_ALVO === "launcher" ? "launcher.js" : "console.js";

function lerEstado() {
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, "utf8"));
  } catch {
    return {};
  }
}

function versaoUtilizavel(versao) {
  if (!versao) return null;
  const dir = path.join(DIR_VERSOES, versao);
  return fs.existsSync(path.join(dir, ALVO)) ? dir : null;
}

function versoesPresentes() {
  try {
    return fs
      .readdirSync(DIR_VERSOES, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 3; i += 1) {
          if (pa[i] !== pb[i]) return pb[i] - pa[i];
        }
        return 0;
      });
  } catch {
    return [];
  }
}

/**
 * Candidatas em ordem de preferência: o ponteiro, a anterior, a mais recente presente, e o
 * payload ao lado (instalação de desenvolvimento).
 *
 * São várias porque *existir o arquivo* não é o mesmo que *conseguir carregá-lo*. Um payload
 * assinado pode trazer todos os arquivos exigidos e ainda assim ter um erro de sintaxe ou um
 * require que falha; nesse caso o `require()` lança e, antes, a exceção subia sem que a versão
 * anterior fosse sequer tentada — uma atualização ruim deixava o console sem subir de jeito
 * nenhum, justamente quando ele é a ferramenta usada para consertar as coisas.
 */
function candidatas() {
  const info = lerEstado();
  const lista = [];
  const juntar = (versao, origem) => {
    const dir = versaoUtilizavel(versao);
    if (dir && !lista.some((c) => c.dir === dir)) lista.push({ dir, versao, origem });
  };

  juntar(info.versaoAtiva, "ponteiro");
  juntar(info.versaoAnterior, "anterior");
  for (const versao of versoesPresentes()) juntar(versao, "mais-recente");
  if (fs.existsSync(path.join(RAIZ, ALVO))) lista.push({ dir: RAIZ, versao: null, origem: "no-lugar" });
  return lista;
}

const disponiveis = candidatas();
if (!disponiveis.length) {
  console.error(
    `[bootstrap] nenhuma versão utilizável do console foi encontrada em ${DIR_VERSOES}.\n` +
      "Reinstale o pacote do Console de Operações para restaurar a instalação."
  );
  process.exit(1);
}

// CONSOLE_RAIZ_INSTALACAO fixa a camada estável para o payload, que precisa dela para
// administrar versoes/ e o ponteiro mesmo quando roda de dentro de versoes/<v>/.
process.env.CONSOLE_RAIZ_INSTALACAO = RAIZ;

let iniciou = false;
for (const [indice, candidata] of disponiveis.entries()) {
  if (indice > 0) {
    console.error(`[bootstrap] tentando a versão ${candidata.versao || "local"} (${candidata.origem}).`);
  }
  try {
    // Chama a entrada exportada em vez de contar com efeito de carregamento: aqui o módulo
    // principal é este bootstrap, então `require.main === module` seria falso no payload.
    const modulo = require(path.join(candidata.dir, ALVO));
    if (typeof modulo.executar !== "function") {
      throw new Error(`${ALVO} não expõe uma entrada "executar"`);
    }
    modulo.executar();
    iniciou = true;
    break;
  } catch (erro) {
    console.error(
      `[bootstrap] a versão ${candidata.versao || "local"} não carregou: ${erro && erro.message ? erro.message : erro}`
    );
  }
}

if (!iniciou) {
  console.error(
    "[bootstrap] nenhuma versão instalada do console conseguiu iniciar.\n" +
      "Reinstale o pacote do Console de Operações para restaurar a instalação."
  );
  process.exit(1);
}
