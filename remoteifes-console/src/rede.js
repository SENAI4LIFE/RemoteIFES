const os = require("os");
const fs = require("fs");
const path = require("path");
const dns = require("dns").promises;
const tls = require("tls");
const http = require("http");
const config = require("./config");
const processos = require("./processos");
const coleta = require("./coleta");

// Diagnóstico de rede, domínio e TLS.
//
// Dois cuidados que mudam o valor do que é mostrado:
//  1. **Ponto de vista.** Uma requisição do Pi para o próprio domínio público pode passar por
//     /etc/hosts, DNS interno ou loopback e não prova nada sobre alcance externo. Toda sonda
//     declara de onde foi feita.
//  2. **Destino limitado.** Uma sonda com destino livre transforma o console em encaminhador
//     de requisições (SSRF). Só o domínio configurado da aplicação e o loopback são sondáveis,
//     sem seguir redirecionamento.

const PORTAS_INTERESSE = [80, 443];

function interfaces() {
  const saida = [];
  for (const [nome, enderecos] of Object.entries(os.networkInterfaces())) {
    for (const endereco of enderecos || []) {
      if (endereco.internal && nome !== "lo") continue;
      saida.push({
        interface: nome,
        familia: endereco.family,
        endereco: endereco.address,
        mascara: endereco.netmask,
        interna: endereco.internal,
      });
    }
  }
  return saida;
}

async function rotas() {
  const r = await processos.executar("ip", ["route", "show"], { timeoutMs: 5000 });
  if (!r.ok) return { suportado: false };
  const linhas = r.saida.split("\n").filter(Boolean).slice(0, 25);
  const padrao = linhas.find((l) => l.startsWith("default"));
  return { suportado: true, linhas, gatewayPadrao: padrao || null };
}

function resolvedor() {
  const texto = coleta.lerTexto("/etc/resolv.conf");
  if (!texto) return { suportado: false };
  const servidores = texto
    .split("\n")
    .filter((l) => l.trim().startsWith("nameserver"))
    .map((l) => l.trim().split(/\s+/)[1])
    .filter(Boolean);
  return { suportado: true, servidores };
}

async function escutas() {
  const r = await processos.chamarAuxiliar("portas", [], { timeoutMs: 10_000 });
  if (!r.ok) {
    // Sem privilégio ainda dá para ver as portas, só não o processo dono.
    const semPrivilegio = await processos.executar("ss", ["-ltn"], { timeoutMs: 8000 });
    if (!semPrivilegio.ok) return { suportado: false, motivo: r.erro };
    return { suportado: true, comProcesso: false, linhas: semPrivilegio.saida.split("\n").filter(Boolean).slice(0, 40) };
  }
  return { suportado: true, comProcesso: true, linhas: r.saida.split("\n").filter(Boolean).slice(0, 40) };
}

/**
 * Configuração de exposição da aplicação, lida do .env e do banco (somente leitura).
 * Separada de propósito da exposição do console: são políticas diferentes com donos diferentes.
 */
function exposicaoDaAplicacao() {
  const env = config.lerEnvServidor();
  const app = config.caminhosDaAplicacao();
  const resultado = {
    porta: app.porta,
    bind: env.BIND_ADDR || "0.0.0.0 (padrão)",
    ambiente: env.NODE_ENV || "development",
    corsOrigin: env.CORS_ORIGIN ? env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean) : [],
    trustProxy: env.TRUST_PROXY === undefined ? "0 (padrão)" : env.TRUST_PROXY,
    servirFrontend: env.SERVIR_FRONTEND === undefined ? "true (padrão)" : env.SERVIR_FRONTEND,
    observacao:
      "TRUST_PROXY é fronteira de segurança: com valor maior que 0 o servidor passa a confiar em " +
      "X-Forwarded-For para identificar o cliente, e isso decide a restrição por faixa de rede e o limite de tentativas. " +
      "Use exatamente o número de proxies confiáveis à frente.",
  };

  // Faixas autorizadas: quem edita é a aplicação (Configurações). O console só mostra e explica.
  const banco = coleta.espiarBanco();
  resultado.redesAutorizadas = { dono: "aplicação (Administração > Sistema > Configurações)", valores: null, lido: false };
  if (banco.existe && banco.lido) {
    try {
      const { DatabaseSync } = require("node:sqlite");
      const conexao = new DatabaseSync(app.banco, { readOnly: true });
      try {
        const linha = conexao.prepare("SELECT valor FROM configuracoes WHERE chave = 'redesAutorizadas'").get();
        if (linha && typeof linha.valor === "string") {
          let valores;
          try {
            valores = JSON.parse(linha.valor);
          } catch {
            valores = linha.valor.split(",").map((s) => s.trim()).filter(Boolean);
          }
          resultado.redesAutorizadas.valores = Array.isArray(valores) ? valores : [];
          resultado.redesAutorizadas.lido = true;
        } else {
          resultado.redesAutorizadas.valores = [];
          resultado.redesAutorizadas.lido = true;
        }
        const teste = conexao.prepare("SELECT valor FROM configuracoes WHERE chave = 'modoTeste'").get();
        resultado.modoTeste = teste ? teste.valor : null;
        const manutencao = conexao.prepare("SELECT valor FROM configuracoes WHERE chave = 'modoManutencao'").get();
        resultado.modoManutencao = manutencao ? manutencao.valor : null;
      } finally {
        conexao.close();
      }
    } catch (erro) {
      resultado.redesAutorizadas.erro = erro.message;
    }
  }
  resultado.redesAutorizadas.observacao =
    "O verificador de faixas do RemoteIFES trabalha com IPv4 em notação CIDR; endereços IPv6 mapeados (::ffff:) são " +
    "normalizados e ::1 vira 127.0.0.1. Faixas IPv6 próprias não são suportadas pelo analisador atual.";
  return resultado;
}

function exposicaoDoConsole() {
  const servidor = require("./servidor");
  return {
    endereco: config.ENDERECO,
    porta: config.PORTA,
    hostsAceitos: servidor.hostsAceitos(),
    atrasDeTls: config.ATRAS_DE_TLS,
    orientacao:
      config.ENDERECO === "127.0.0.1"
        ? "O console escuta apenas no loopback do Pi. De outra máquina, use um túnel SSH: " +
          `ssh -L ${config.PORTA}:127.0.0.1:${config.PORTA} <usuario>@<host-do-pi> e então abra http://127.0.0.1:${config.PORTA}. ` +
          "O localhost do seu computador não é o do Pi."
        : "O console está escutando fora do loopback. Nesse modo, TLS e restrição de origem por rede são obrigatórios.",
  };
}

function nginx() {
  const candidatos = ["/etc/nginx/sites-enabled/remoteifes", "/etc/nginx/conf.d/remoteifes.conf"];
  const encontrado = candidatos.find((c) => fs.existsSync(c));
  const habilitados = (() => {
    try {
      return fs.readdirSync("/etc/nginx/sites-enabled");
    } catch {
      return null;
    }
  })();
  if (!encontrado) {
    return { instalado: fs.existsSync("/etc/nginx"), siteRemoteifes: false, sitesHabilitados: habilitados };
  }
  const texto = coleta.lerTexto(encontrado) || "";
  const nomes = [...texto.matchAll(/server_name\s+([^;]+);/g)].map((m) => m[1].trim());
  const certificado = /ssl_certificate\s+([^;]+);/.exec(texto);
  return {
    instalado: true,
    siteRemoteifes: true,
    arquivo: encontrado,
    serverNames: nomes,
    tls: !!certificado,
    caminhoCertificado: certificado ? certificado[1].trim() : null,
    sitesHabilitados: habilitados,
    observacao:
      habilitados && habilitados.length > 1
        ? "Há mais de um site habilitado no Nginx: lan-setup.sh e https-setup.sh sobrescrevem o site do RemoteIFES e mexem no site default. Em instalação com vários sites, revise antes de rodá-los."
        : null,
  };
}

function dominioConfigurado() {
  const conf = nginx();
  if (conf.serverNames && conf.serverNames.length) {
    const nome = conf.serverNames.flatMap((n) => n.split(/\s+/)).find((n) => n && n !== "_" && !/^\d+\.\d+\.\d+\.\d+$/.test(n));
    if (nome) return nome;
  }
  const env = config.lerEnvServidor();
  for (const origem of (env.CORS_ORIGIN || "").split(",")) {
    try {
      const url = new URL(origem.trim());
      if (url.hostname && url.hostname !== "localhost") return url.hostname;
    } catch {}
  }
  return null;
}

async function resolverDominio(nome) {
  if (!nome) return null;
  const saida = { nome, a: null, aaaa: null, erro: null };
  try {
    saida.a = await dns.resolve4(nome);
  } catch (erro) {
    saida.erro = erro.code || erro.message;
  }
  try {
    saida.aaaa = await dns.resolve6(nome);
  } catch {}
  saida.enderecosLocais = interfaces()
    .filter((i) => !i.interna)
    .map((i) => i.endereco);
  saida.apontaParaEsteHost =
    saida.a && saida.a.some((ip) => saida.enderecosLocais.includes(ip))
      ? true
      : saida.a
        ? false
        : null;
  saida.observacao =
    saida.apontaParaEsteHost === false
      ? "O domínio resolve para um endereço que não é deste host. Isso é esperado atrás de NAT ou CDN; não é, por si, um erro."
      : null;
  return saida;
}

function certificadoTls(nome, porta = 443, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let concluido = false;
    const terminar = (valor) => {
      if (concluido) return;
      concluido = true;
      resolve(valor);
    };
    let socket;
    try {
      socket = tls.connect(
        { host: nome, port: porta, servername: nome, timeout: timeoutMs, rejectUnauthorized: false },
        () => {
          const cert = socket.getPeerCertificate(true);
          const autorizado = socket.authorized;
          const erroAutorizacao = socket.authorizationError ? String(socket.authorizationError) : null;
          const validoAte = cert && cert.valid_to ? new Date(cert.valid_to) : null;
          terminar({
            alcancou: true,
            autorizado,
            erroAutorizacao,
            emissor: cert && cert.issuer ? cert.issuer.O || cert.issuer.CN || null : null,
            assunto: cert && cert.subject ? cert.subject.CN || null : null,
            nomesAlternativos: cert && cert.subjectaltname ? cert.subjectaltname : null,
            validoDe: cert && cert.valid_from ? new Date(cert.valid_from).toISOString() : null,
            validoAte: validoAte ? validoAte.toISOString() : null,
            diasParaExpirar: validoAte ? Math.round((validoAte.getTime() - Date.now()) / 86400000) : null,
          });
          socket.end();
        }
      );
    } catch (erro) {
      return terminar({ alcancou: false, erro: erro.message });
    }
    socket.on("timeout", () => {
      socket.destroy();
      terminar({ alcancou: false, erro: `tempo esgotado em ${timeoutMs} ms` });
    });
    socket.on("error", (erro) => terminar({ alcancou: false, erro: erro.code || erro.message }));
  });
}

function renovacaoCertbot() {
  const dir = "/etc/letsencrypt/renewal";
  if (!fs.existsSync(dir)) return { certbot: false };
  let arquivos = [];
  try {
    arquivos = fs.readdirSync(dir).filter((n) => n.endsWith(".conf"));
  } catch {}
  const timer = fs.existsSync("/lib/systemd/system/certbot.timer") || fs.existsSync("/etc/systemd/system/certbot.timer");
  return { certbot: true, dominios: arquivos.map((a) => a.replace(/\.conf$/, "")), timerInstalado: timer };
}

function sondarLocal(porta, caminho = "/") {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: porta, path: caminho, method: "HEAD", timeout: 3000 }, (res) => {
      resolve({ alcancou: true, status: res.statusCode });
      res.resume();
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ alcancou: false, erro: "tempo esgotado" });
    });
    req.on("error", (erro) => resolve({ alcancou: false, erro: erro.code || erro.message }));
    req.end();
  });
}

async function diagnostico({ alvo = null } = {}) {
  const dominio = dominioConfigurado();
  // Destino limitado: só o domínio detectado na configuração. Um alvo livre vindo do navegador
  // transformaria este diagnóstico em encaminhador de requisições.
  const dominioSondado = alvo && alvo === dominio ? alvo : dominio;

  const app = config.caminhosDaAplicacao();
  const [rotasInfo, escutasInfo, dns, certificado, aplicacaoLocal, proxyLocal] = await Promise.all([
    rotas(),
    escutas(),
    resolverDominio(dominioSondado),
    dominioSondado ? certificadoTls(dominioSondado) : Promise.resolve(null),
    sondarLocal(app.porta, "/health"),
    sondarLocal(80, "/"),
  ]);

  return {
    coletadoEm: new Date().toISOString(),
    pontoDeVista:
      "Todas as sondas partem do próprio Raspberry Pi. Uma resposta positiva aqui não prova alcance a partir da internet " +
      "nem da rede do IFES: pode estar passando por /etc/hosts, DNS interno ou loopback. Para confirmar acesso externo, " +
      "teste de um dispositivo fora da rede.",
    interfaces: interfaces(),
    rotas: rotasInfo,
    resolvedor: resolvedor(),
    escutas: escutasInfo,
    exposicaoAplicacao: exposicaoDaAplicacao(),
    exposicaoConsole: exposicaoDoConsole(),
    proxy: nginx(),
    dominio: { configurado: dominio, dns, certificado, renovacao: renovacaoCertbot() },
    sondas: {
      aplicacaoLocal: { ...aplicacaoLocal, descricao: `HEAD http://127.0.0.1:${app.porta}/health a partir do host` },
      proxyLocal: { ...proxyLocal, descricao: "HEAD http://127.0.0.1:80/ a partir do host" },
    },
    operacoesConsequentes: {
      observacao:
        "lan-setup.sh e https-setup.sh não são diagnósticos: instalam pacotes, sobrescrevem o site Nginx do RemoteIFES, " +
        "mexem nos sites habilitados, alteram o .env e recarregam serviços; o HTTPS ainda aciona o Certbot. " +
        "Por isso continuam como procedimento de terminal com decisão humana, documentado no README.",
    },
  };
}

module.exports = { diagnostico, interfaces, exposicaoDaAplicacao, exposicaoDoConsole, dominioConfigurado, certificadoTls, nginx };
