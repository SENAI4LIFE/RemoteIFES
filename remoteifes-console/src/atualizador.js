const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");
const zlib = require("zlib");
const config = require("./config");
const estado = require("./estado");
const release = require("./release");
const plataforma = require("./plataforma");

// Atualizador do console instalado.
//
// Modelo: **payload versionado lado a lado com camada estável de bootstrap**.
//
//   <raiz>/console-bootstrap.js      camada estável — instalada pelo pacote, nunca reescrita
//   <raiz>/estado-instalacao.json    ponteiro da versão ativa + transação em andamento
//   <raiz>/versoes/2.0.0/            payload imutável
//   <raiz>/versoes/2.1.0/
//   <raiz>/descargas/                área de estágio
//
// Consequências que valem a complexidade:
//   - o `.deb` (ou o instalador) é dono só da camada estável; as atualizações seguintes não
//     sobrescrevem arquivo registrado pelo gerenciador de pacotes, então ele nunca fica
//     inconsistente;
//   - reverter é trocar um ponteiro, não reinstalar;
//   - no Windows não é preciso substituir um executável em uso.
//
// A troca do ponteiro é a única etapa irreversível, e é um `rename` — atômico o bastante para
// que uma queda de energia deixe a versão antiga ou a nova, nunca um meio-termo.

const RE_VERSAO = /^\d+\.\d+\.\d+$/;
const LIMITE_ARTEFATO = 120 * 1024 * 1024;

function raizInstalacao() {
  return config.RAIZ_INSTALACAO;
}

function arquivoEstado() {
  return path.join(raizInstalacao(), "estado-instalacao.json");
}

function dirVersoes() {
  return path.join(raizInstalacao(), "versoes");
}

function dirDescargas() {
  return path.join(raizInstalacao(), "descargas");
}

function lerEstadoInstalacao() {
  return estado.lerJson(arquivoEstado(), { versaoAtiva: null, versaoAnterior: null, transacao: null, atualizadoEm: null });
}

function gravarEstadoInstalacao(valor) {
  estado.gravarJson(arquivoEstado(), valor, 0o644);
}

/** Versões presentes no disco, mais o ponteiro ativo. */
function versoesInstaladas() {
  const info = lerEstadoInstalacao();
  let presentes = [];
  try {
    presentes = fs
      .readdirSync(dirVersoes(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && RE_VERSAO.test(e.name))
      .map((e) => e.name)
      .sort(release.compararVersoes);
  } catch {}
  return {
    ativa: info.versaoAtiva,
    anterior: info.versaoAnterior && presentes.includes(info.versaoAnterior) ? info.versaoAnterior : null,
    presentes,
    transacaoPendente: info.transacao || null,
    gerenciadoLadoALado: presentes.length > 0,
  };
}

/** Versão em execução neste processo (o payload de onde o console foi carregado). */
function versaoEmExecucao() {
  try {
    return require(path.join(config.RAIZ_CONSOLE, "package.json")).version;
  } catch {
    return null;
  }
}

// --- Descoberta ------------------------------------------------------------------------------

function baixar(url, { destino = null, limiteBytes = LIMITE_ARTEFATO, saltos = 0, timeoutMs = 120_000 } = {}) {
  let alvo;
  try {
    alvo = new URL(url);
  } catch {
    return Promise.resolve({ ok: false, erro: "endereço inválido" });
  }
  // Releases públicos: nenhuma credencial é enviada, em nenhum salto. Um redirecionamento para
  // armazenamento nunca deve carregar cabeçalho de autorização junto.
  const transporte = alvo.protocol === "http:" ? http : https;
  if (alvo.protocol !== "https:" && !process.env.CONSOLE_RELEASE_BASE) {
    return Promise.resolve({ ok: false, erro: "download só é aceito por HTTPS" });
  }
  if (saltos > 3) return Promise.resolve({ ok: false, erro: "mais de 3 redirecionamentos" });

  return new Promise((resolve) => {
    const req = transporte.request(
      {
        protocol: alvo.protocol,
        host: alvo.hostname,
        port: alvo.port || undefined,
        path: `${alvo.pathname}${alvo.search}`,
        method: "GET",
        headers: { "User-Agent": "remoteifes-console", Accept: "*/*" },
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const proximo = new URL(res.headers.location, alvo).toString();
          return resolve(baixar(proximo, { destino, limiteBytes, saltos: saltos + 1, timeoutMs }));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return resolve({ ok: false, erro: `HTTP ${res.statusCode}`, status: res.statusCode });
        }
        let bytes = 0;
        if (destino) {
          fs.mkdirSync(path.dirname(destino), { recursive: true });
          const fluxo = fs.createWriteStream(destino, { mode: 0o600 });
          let abortado = false;
          res.on("data", (d) => {
            bytes += d.length;
            if (bytes > limiteBytes) {
              abortado = true;
              req.destroy();
              fluxo.destroy();
              fs.rmSync(destino, { force: true });
              resolve({ ok: false, erro: "download passou do limite de tamanho" });
            }
          });
          res.pipe(fluxo);
          fluxo.on("finish", () => {
            if (!abortado) resolve({ ok: true, arquivo: destino, bytes });
          });
          fluxo.on("error", (erro) => resolve({ ok: false, erro: erro.message }));
          return;
        }
        let texto = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          bytes += Buffer.byteLength(d);
          if (bytes > 2 * 1024 * 1024) {
            req.destroy();
            return resolve({ ok: false, erro: "resposta grande demais" });
          }
          texto += d;
        });
        res.on("end", () => resolve({ ok: true, texto, bytes }));
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, erro: "tempo esgotado" });
    });
    req.on("error", (erro) => resolve({ ok: false, erro: erro.code || erro.message }));
    req.end();
  });
}

function baseDeRelease() {
  return (
    process.env.CONSOLE_RELEASE_BASE ||
    "https://github.com/SENAI4LIFE/RemoteIFES/releases/latest/download"
  );
}

function arquivoObservacao() {
  return path.join(config.DIR_ESTADO, "observacao-release.json");
}

/**
 * Consulta a publicação atual. Guarda a última observação com a hora, para que a interface
 * mostre dado antigo como antigo em vez de como atual.
 */
async function verificarPublicacao({ forcar = false } = {}) {
  if (!release.confianciaConfigurada()) {
    return {
      ok: false,
      naoConfigurado: true,
      motivo:
        "a atualização por release não está configurada neste console: nenhuma chave pública de publicação foi " +
        "provisionada. O console continua funcionando; a atualização é feita reinstalando o pacote.",
    };
  }

  const anterior = estado.lerJson(arquivoObservacao(), null);
  if (!forcar && anterior && Date.now() - Date.parse(anterior.observadoEm) < 15 * 60 * 1000) {
    return { ok: true, ...anterior, doCache: true };
  }

  const base = baseDeRelease();
  const manifestoResp = await baixar(`${base}/manifesto.json`, { timeoutMs: 30_000 });
  if (!manifestoResp.ok) {
    return { ok: false, motivo: `não foi possível obter o manifesto (${manifestoResp.erro})`, offline: true, ultimaObservacao: anterior };
  }
  const assinaturaResp = await baixar(`${base}/manifesto.json.sig`, { timeoutMs: 30_000 });
  if (!assinaturaResp.ok) {
    return { ok: false, motivo: `não foi possível obter a assinatura (${assinaturaResp.erro})`, ultimaObservacao: anterior };
  }

  const verificacao = release.verificarManifesto(Buffer.from(manifestoResp.texto, "utf8"), assinaturaResp.texto);
  if (!verificacao.ok) {
    estado.auditar("release-manifesto-recusado", { motivo: verificacao.motivo });
    return { ok: false, motivo: verificacao.motivo, recusado: true };
  }
  release.registrarRotacao(verificacao.manifesto);

  const observacao = {
    observadoEm: new Date().toISOString(),
    versao: verificacao.manifesto.versao,
    canal: verificacao.manifesto.canal || "estavel",
    notas: verificacao.manifesto.notas || null,
    alvos: verificacao.manifesto.artefatos.map((a) => a.alvo),
    expiraEm: verificacao.manifesto.expiraEm,
    chaveUsada: verificacao.chaveUsada,
  };
  estado.gravarJson(arquivoObservacao(), observacao, 0o600);
  return { ok: true, ...observacao, manifesto: verificacao.manifesto };
}

/** Situação para a interface: instalado, disponível, alvo, prontidão e ressalvas. */
async function situacao({ consultarRede = false } = {}) {
  const instaladas = versoesInstaladas();
  const emExecucao = versaoEmExecucao();
  const observacao = estado.lerJson(arquivoObservacao(), null);
  const idadeS = observacao ? Math.round((Date.now() - Date.parse(observacao.observadoEm)) / 1000) : null;

  let consulta = null;
  if (consultarRede) consulta = await verificarPublicacao({ forcar: true });

  const alvo = release.alvoAtual();
  const disponivel = consulta && consulta.ok ? consulta.versao : observacao ? observacao.versao : null;
  const politica = disponivel && emExecucao ? release.politicaDeVersao({ versao: disponivel }, emExecucao) : null;

  return {
    versaoEmExecucao: emExecucao,
    versaoAtivaRegistrada: instaladas.ativa,
    versaoAnterior: instaladas.anterior,
    versoesPresentes: instaladas.presentes,
    gerenciadoLadoALado: instaladas.gerenciadoLadoALado,
    transacaoPendente: instaladas.transacaoPendente,
    alvo,
    confiancaConfigurada: release.confianciaConfigurada(),
    ultimaObservacao: observacao
      ? {
          ...observacao,
          idadeSegundos: idadeS,
          recente: idadeS !== null && idadeS < 3600,
          ressalva: idadeS !== null && idadeS >= 3600 ? "esta observação é antiga; a publicação pode ter mudado desde então" : null,
        }
      : null,
    consultaAgora: consulta && !consulta.ok ? consulta : null,
    disponivel,
    podeAtualizar: !!(politica && politica.ok),
    motivoNaoAtualizar: politica && !politica.ok ? politica.motivo : null,
    observacaoDeDistribuicao:
      "Esta é a versão do **programa console**, independente do commit do RemoteIFES implantado e das versões de " +
      "servidor, PWA e aplicativo.",
  };
}

/** Validação usada pela ação antes de confirmar. */
async function validarAlvo(versao) {
  if (!RE_VERSAO.test(String(versao || ""))) return "versão alvo inválida";
  if (!release.confianciaConfigurada()) {
    return (
      "a atualização por release não está configurada neste console (sem chave pública de publicação). " +
      "Atualize reinstalando o pacote da plataforma."
    );
  }
  const instaladas = versoesInstaladas();
  if (!instaladas.gerenciadoLadoALado) {
    return (
      "esta instalação não usa o layout de versões lado a lado, então a troca de ponteiro não se aplica. " +
      "Reinstale com o instalador desta versão para migrar o layout."
    );
  }
  return null;
}

// --- Extração segura ---------------------------------------------------------------------------

/**
 * Extrai um `.tar.gz` sem depender do `tar` do sistema (que não existe em todo Windows) e sem
 * aceitar caminho que escape do destino. Suporta apenas arquivo comum e diretório: link
 * simbólico, hardlink e dispositivo são **recusados**, porque um artefato é conteúdo remoto.
 */
function extrairTarGz(arquivo, destino) {
  const bruto = zlib.gunzipSync(fs.readFileSync(arquivo));
  const raizReal = path.resolve(destino);
  fs.mkdirSync(raizReal, { recursive: true });

  let posicao = 0;
  let arquivos = 0;
  let prefixoLongo = null;

  while (posicao + 512 <= bruto.length) {
    const cabecalho = bruto.subarray(posicao, posicao + 512);
    if (cabecalho.every((b) => b === 0)) break;

    const lerTexto = (inicio, tamanho) => cabecalho.subarray(inicio, inicio + tamanho).toString("utf8").replace(/\0.*$/, "").trim();
    let nome = prefixoLongo || lerTexto(0, 100);
    prefixoLongo = null;
    const modo = parseInt(lerTexto(100, 8) || "0", 8) || 0o644;
    const tamanho = parseInt(lerTexto(124, 12) || "0", 8) || 0;
    const tipo = String.fromCharCode(cabecalho[156]) || "0";
    const prefixo = lerTexto(345, 155);
    if (prefixo) nome = `${prefixo}/${nome}`;

    const blocos = Math.ceil(tamanho / 512);
    const conteudo = bruto.subarray(posicao + 512, posicao + 512 + tamanho);
    posicao += 512 + blocos * 512;

    if (tipo === "L") {
      // GNU long name: o nome do próximo item vem no corpo deste registro.
      prefixoLongo = conteudo.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    if (tipo === "x" || tipo === "g") continue; // metadados pax
    if (tipo === "1" || tipo === "2") {
      throw new Error(`artefato contém link (${nome}); extração recusada`);
    }
    if (tipo === "3" || tipo === "4" || tipo === "6") {
      throw new Error(`artefato contém arquivo especial (${nome}); extração recusada`);
    }
    if (!nome || nome === "./") continue;

    const limpo = nome.replace(/^\.\//, "");
    if (path.isAbsolute(limpo) || limpo.split(/[\\/]/).some((p) => p === "..")) {
      throw new Error(`artefato contém caminho que escapa do destino: ${nome}`);
    }
    const alvo = path.resolve(raizReal, limpo);
    if (alvo !== raizReal && !alvo.startsWith(raizReal + path.sep)) {
      throw new Error(`artefato contém caminho fora do destino: ${nome}`);
    }

    if (tipo === "5") {
      fs.mkdirSync(alvo, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(alvo), { recursive: true });
    fs.writeFileSync(alvo, conteudo);
    // Preserva apenas o bit de execução; nada de setuid/setgid vindo de um artefato.
    if (process.platform !== "win32") fs.chmodSync(alvo, modo & 0o755);
    arquivos += 1;
  }
  if (!arquivos) throw new Error("o artefato não continha arquivos");
  return { arquivos };
}

// --- Transação de atualização --------------------------------------------------------------------

function limparDescargas() {
  try {
    fs.rmSync(dirDescargas(), { recursive: true, force: true });
  } catch {}
}

/**
 * Reconciliação de transação interrompida. Chamada na partida do console: se a energia caiu
 * entre o estágio e a troca do ponteiro, o que ficou é lixo em `descargas/` ou um diretório de
 * versão incompleto — nunca uma instalação pela metade, porque a troca é um rename.
 */
function reconciliar() {
  const info = lerEstadoInstalacao();
  if (!info.transacao) return { reconciliado: false };

  const t = info.transacao;
  const destino = path.join(dirVersoes(), String(t.versao || ""));
  const completa = t.etapa === "concluida";
  if (!completa) {
    try {
      fs.rmSync(destino, { recursive: true, force: true });
    } catch {}
    limparDescargas();
    estado.auditar("atualizacao-console-reconciliada", { versao: t.versao, etapa: t.etapa });
  }
  info.transacao = null;
  gravarEstadoInstalacao(info);
  return { reconciliado: true, etapaInterrompida: completa ? null : t.etapa, versao: t.versao };
}

function registrarTransacao(versao, etapa) {
  const info = lerEstadoInstalacao();
  info.transacao = { versao, etapa, em: new Date().toISOString() };
  gravarEstadoInstalacao(info);
}

/**
 * Instala uma versão publicada e troca o ponteiro. Só escreve no diretório ativo depois de
 * assinatura, política de versão e digest conferirem.
 */
async function atualizar(versaoAlvo, { log = () => {} } = {}) {
  const raiz = raizInstalacao();
  const instaladas = versoesInstaladas();
  const emExecucao = versaoEmExecucao();

  const impedimento = await validarAlvo(versaoAlvo);
  if (impedimento) return { ok: false, erro: impedimento };

  log("Verificando a publicação...");
  const publicacao = await verificarPublicacao({ forcar: true });
  if (!publicacao.ok) return { ok: false, erro: publicacao.motivo };
  if (publicacao.versao !== versaoAlvo) {
    // O alvo foi fixado na confirmação: uma publicação que apareça depois não entra sozinha.
    return {
      ok: false,
      erro: `a publicação atual é ${publicacao.versao}, e a operação foi confirmada para ${versaoAlvo}. Reveja e confirme de novo.`,
    };
  }

  const politica = release.politicaDeVersao(publicacao.manifesto, emExecucao);
  if (!politica.ok) return { ok: false, erro: politica.motivo };

  const escolha = release.escolherArtefato(publicacao.manifesto);
  if (!escolha.ok) return { ok: false, erro: escolha.motivo };
  const artefato = escolha.artefato;
  log(`Alvo ${artefato.alvo}, artefato ${artefato.arquivo} (${(artefato.bytes / 1048576).toFixed(1)} MiB).`);

  const destino = path.join(dirVersoes(), versaoAlvo);
  if (fs.existsSync(destino)) {
    return { ok: false, erro: `a versão ${versaoAlvo} já está presente em ${destino}; remova-a antes de reinstalar.` };
  }

  registrarTransacao(versaoAlvo, "baixando");
  const staging = path.join(dirDescargas(), `${versaoAlvo}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(staging, { recursive: true });
  const arquivoLocal = path.join(staging, artefato.arquivo);

  log("Baixando o artefato...");
  const download = await baixar(`${baseDeRelease()}/${artefato.arquivo}`, { destino: arquivoLocal, limiteBytes: Math.max(artefato.bytes + 4096, 1024) });
  if (!download.ok) {
    limparDescargas();
    registrarTransacao(versaoAlvo, "falhou-download");
    reconciliar();
    return { ok: false, erro: `download falhou: ${download.erro}` };
  }

  log("Verificando integridade contra o manifesto assinado...");
  const conferencia = release.conferirArtefato(arquivoLocal, artefato);
  if (!conferencia.ok) {
    limparDescargas();
    registrarTransacao(versaoAlvo, "falhou-verificacao");
    reconciliar();
    estado.auditar("atualizacao-console-digest-divergente", { versao: versaoAlvo, motivo: conferencia.motivo });
    return { ok: false, erro: conferencia.motivo };
  }
  log(`SHA-256 confere (${conferencia.sha256.slice(0, 16)}…).`);

  log("Instalando lado a lado...");
  registrarTransacao(versaoAlvo, "instalando");
  const parcial = `${destino}.parcial-${crypto.randomBytes(3).toString("hex")}`;
  try {
    extrairTarGz(arquivoLocal, parcial);
  } catch (erro) {
    fs.rmSync(parcial, { recursive: true, force: true });
    limparDescargas();
    registrarTransacao(versaoAlvo, "falhou-extracao");
    reconciliar();
    return { ok: false, erro: `extração recusada: ${erro.message}` };
  }

  // O payload precisa ter o que o bootstrap vai carregar, senão a troca deixaria o console sem subir.
  for (const exigido of ["console.js", "package.json", path.join("src", "servidor.js")]) {
    if (!fs.existsSync(path.join(parcial, exigido))) {
      fs.rmSync(parcial, { recursive: true, force: true });
      limparDescargas();
      registrarTransacao(versaoAlvo, "falhou-conteudo");
      reconciliar();
      return { ok: false, erro: `o artefato não contém ${exigido}; instalação abortada antes de trocar a versão ativa.` };
    }
  }
  const pacoteNovo = JSON.parse(fs.readFileSync(path.join(parcial, "package.json"), "utf8"));
  if (pacoteNovo.version !== versaoAlvo) {
    fs.rmSync(parcial, { recursive: true, force: true });
    limparDescargas();
    registrarTransacao(versaoAlvo, "falhou-identidade");
    reconciliar();
    return { ok: false, erro: `o artefato declara versão ${pacoteNovo.version}, não ${versaoAlvo}.` };
  }

  fs.mkdirSync(dirVersoes(), { recursive: true });
  fs.renameSync(parcial, destino);
  limparDescargas();

  log("Trocando a versão ativa...");
  registrarTransacao(versaoAlvo, "trocando");
  const info = lerEstadoInstalacao();
  const anterior = info.versaoAtiva || emExecucao;
  gravarEstadoInstalacao({
    versaoAtiva: versaoAlvo,
    versaoAnterior: anterior && anterior !== versaoAlvo ? anterior : info.versaoAnterior,
    transacao: { versao: versaoAlvo, etapa: "concluida", em: new Date().toISOString() },
    atualizadoEm: new Date().toISOString(),
  });

  podarVersoes({ manter: [versaoAlvo, anterior].filter(Boolean) });
  estado.auditar("atualizacao-console-aplicada", { de: anterior, para: versaoAlvo, alvo: artefato.alvo });

  log(`Versão ativa agora é ${versaoAlvo} (anterior: ${anterior || "nenhuma"}).`);
  log("Reiniciando o console para carregar a nova versão...");
  const reinicio = await plataforma.reiniciarConsole();
  return {
    ok: true,
    versao: versaoAlvo,
    anterior,
    reinicio: reinicio.disponivel ? "solicitado" : reinicio.motivo,
    resumo: `console ${versaoAlvo} ativo; a versão ${anterior || "anterior"} fica guardada para reversão`,
  };
}

/** Reversão: troca o ponteiro para a versão anterior já instalada e verificada. Sem rede. */
async function reverter({ log = () => {} } = {}) {
  const instaladas = versoesInstaladas();
  if (!instaladas.anterior) return { ok: false, erro: "não há versão anterior instalada para a qual voltar." };
  const destino = path.join(dirVersoes(), instaladas.anterior);
  if (!fs.existsSync(path.join(destino, "console.js"))) {
    return { ok: false, erro: `a versão anterior (${instaladas.anterior}) não está íntegra em ${destino}.` };
  }
  log(`Voltando para ${instaladas.anterior}...`);
  gravarEstadoInstalacao({
    versaoAtiva: instaladas.anterior,
    versaoAnterior: instaladas.ativa,
    transacao: { versao: instaladas.anterior, etapa: "concluida", em: new Date().toISOString() },
    atualizadoEm: new Date().toISOString(),
  });
  estado.auditar("atualizacao-console-revertida", { de: instaladas.ativa, para: instaladas.anterior });
  const reinicio = await plataforma.reiniciarConsole();
  return { ok: true, versao: instaladas.anterior, reinicio: reinicio.disponivel ? "solicitado" : reinicio.motivo };
}

/** Mantém no disco só a versão ativa e a anterior. */
function podarVersoes({ manter = [] } = {}) {
  const preservar = new Set(manter);
  let presentes = [];
  try {
    presentes = fs.readdirSync(dirVersoes(), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  const removidas = [];
  for (const nome of presentes) {
    if (preservar.has(nome)) continue;
    try {
      fs.rmSync(path.join(dirVersoes(), nome), { recursive: true, force: true });
      removidas.push(nome);
    } catch {}
  }
  return removidas;
}

/** Importação offline: mesmo caminho de verificação, a partir de arquivos locais. */
async function importarOffline({ manifesto, assinatura, artefato, log = () => {} }) {
  if (!fs.existsSync(manifesto) || !fs.existsSync(assinatura) || !fs.existsSync(artefato)) {
    return { ok: false, erro: "informe manifesto, assinatura e artefato existentes" };
  }
  const verificacao = release.verificarManifesto(fs.readFileSync(manifesto), fs.readFileSync(assinatura, "utf8"));
  if (!verificacao.ok) return { ok: false, erro: verificacao.motivo };
  release.registrarRotacao(verificacao.manifesto);

  const escolha = release.escolherArtefato(verificacao.manifesto);
  if (!escolha.ok) return { ok: false, erro: escolha.motivo };
  if (path.basename(artefato) !== escolha.artefato.arquivo) {
    return { ok: false, erro: `o arquivo informado não é o artefato deste alvo (esperado ${escolha.artefato.arquivo}).` };
  }
  const conferencia = release.conferirArtefato(artefato, escolha.artefato);
  if (!conferencia.ok) return { ok: false, erro: conferencia.motivo };
  log("Manifesto e artefato verificados; instalando a partir do arquivo local.");
  return { ok: true, versao: verificacao.manifesto.versao, observacao: "use a ação de atualização para aplicar esta versão" };
}

module.exports = {
  raizInstalacao,
  versoesInstaladas,
  versaoEmExecucao,
  lerEstadoInstalacao,
  gravarEstadoInstalacao,
  verificarPublicacao,
  situacao,
  validarAlvo,
  atualizar,
  reverter,
  reconciliar,
  podarVersoes,
  extrairTarGz,
  importarOffline,
  baixar,
};
