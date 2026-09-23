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

function resolver() {
  const info = lerEstado();

  const ativa = versaoUtilizavel(info.versaoAtiva);
  if (ativa) return { dir: ativa, versao: info.versaoAtiva, origem: "ponteiro" };

  if (info.versaoAtiva) {
    console.error(`[bootstrap] a versão ativa (${info.versaoAtiva}) não está utilizável; procurando alternativa.`);
  }

  const anterior = versaoUtilizavel(info.versaoAnterior);
  if (anterior) {
    console.error(`[bootstrap] usando a versão anterior (${info.versaoAnterior}).`);
    return { dir: anterior, versao: info.versaoAnterior, origem: "anterior" };
  }

  for (const versao of versoesPresentes()) {
    const dir = versaoUtilizavel(versao);
    if (dir) {
      console.error(`[bootstrap] ponteiro inválido; usando a versão mais recente presente (${versao}).`);
      return { dir, versao, origem: "mais-recente" };
    }
  }

  // Instalação de desenvolvimento: o payload pode estar ao lado do bootstrap.
  if (fs.existsSync(path.join(RAIZ, ALVO))) return { dir: RAIZ, versao: null, origem: "no-lugar" };

  return null;
}

const escolhida = resolver();
if (!escolhida) {
  console.error(
    `[bootstrap] nenhuma versão utilizável do console foi encontrada em ${DIR_VERSOES}.\n` +
      "Reinstale o pacote do Console de Operações para restaurar a instalação."
  );
  process.exit(1);
}

// CONSOLE_RAIZ_INSTALACAO fixa a camada estável para o payload, que precisa dela para
// administrar versoes/ e o ponteiro mesmo quando roda de dentro de versoes/<v>/.
process.env.CONSOLE_RAIZ_INSTALACAO = RAIZ;

// Chama a entrada exportada em vez de contar com efeito de carregamento: aqui o módulo
// principal é este bootstrap, então `require.main === module` seria falso no payload e nada
// aconteceria.
const modulo = require(path.join(escolhida.dir, ALVO));
if (typeof modulo.executar === "function") {
  modulo.executar();
} else {
  console.error(`[bootstrap] ${ALVO} da versão ${escolhida.versao || "local"} não expõe uma entrada "executar".`);
  process.exit(1);
}
