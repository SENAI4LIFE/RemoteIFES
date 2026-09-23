const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

// Apoio aos testes: estado isolado por teste, módulos recarregados e um cliente HTTP pequeno.
// Nada aqui toca no estado real do console nem no banco da aplicação.

const RAIZ = path.join(__dirname, "..");
const MODULOS = ["config", "estado", "auth", "processos", "execucao", "trava", "coleta", "acoes", "prontidao", "repositorio", "servidor", "rede", "mobile", "github", "terminal"];

function dirTemporario(prefixo = "console-teste-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefixo));
}

/**
 * Prepara um ambiente isolado e devolve os módulos recém-carregados. `config.js` lê o ambiente
 * no require, então as variáveis precisam estar postas antes de recarregar.
 */
function ambiente(opcoes = {}) {
  const estadoDir = opcoes.estadoDir || dirTemporario();
  const checkout = opcoes.checkout || path.join(RAIZ, "..");

  const anterior = {};
  const definir = (chave, valor) => {
    anterior[chave] = process.env[chave];
    if (valor === undefined) delete process.env[chave];
    else process.env[chave] = String(valor);
  };

  definir("CONSOLE_ESTADO_DIR", estadoDir);
  definir("CONSOLE_CHECKOUT_DIR", checkout);
  definir("CONSOLE_SEM_PRIVILEGIO", "1");
  definir("CONSOLE_PORTA", opcoes.porta || 8399);
  definir("CONSOLE_OCIOSIDADE_S", opcoes.ociosidadeS === undefined ? 0 : opcoes.ociosidadeS);
  if (opcoes.sessaoOciosaS) definir("CONSOLE_SESSAO_OCIOSA_S", opcoes.sessaoOciosaS);
  if (opcoes.sessaoMaxS) definir("CONSOLE_SESSAO_MAX_S", opcoes.sessaoMaxS);
  if (opcoes.elevacaoS) definir("CONSOLE_ELEVACAO_S", opcoes.elevacaoS);
  if (opcoes.terminalOciosoS) definir("CONSOLE_TERMINAL_OCIOSO_S", opcoes.terminalOciosoS);
  if (opcoes.terminalMaxS) definir("CONSOLE_TERMINAL_MAX_S", opcoes.terminalMaxS);
  if (opcoes.githubApi) definir("CONSOLE_GITHUB_API", opcoes.githubApi);
  if (opcoes.env) for (const [k, v] of Object.entries(opcoes.env)) definir(k, v);

  for (const nome of MODULOS) delete require.cache[require.resolve(path.join(RAIZ, "src", `${nome}.js`))];

  const mods = {};
  for (const nome of MODULOS) mods[nome] = require(path.join(RAIZ, "src", `${nome}.js`));

  fs.mkdirSync(estadoDir, { recursive: true });

  return {
    ...mods,
    estadoDir,
    checkout,
    restaurar() {
      for (const [chave, valor] of Object.entries(anterior)) {
        if (valor === undefined) delete process.env[chave];
        else process.env[chave] = valor;
      }
      for (const nome of MODULOS) delete require.cache[require.resolve(path.join(RAIZ, "src", `${nome}.js`))];
      try {
        fs.rmSync(estadoDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

/** Sobe o servidor do console numa porta efêmera. */
function subir(mods) {
  return new Promise((resolve) => {
    const servidor = mods.servidor.criarServidor();
    servidor.listen(0, "127.0.0.1", () => {
      const porta = servidor.address().port;
      resolve({
        servidor,
        porta,
        host: `127.0.0.1:${porta}`,
        base: `http://127.0.0.1:${porta}`,
        fechar: () =>
          new Promise((r) => {
            servidor.closeAllConnections && servidor.closeAllConnections();
            servidor.close(() => r());
          }),
      });
    });
  });
}

/** Cliente HTTP cru: permite forjar Host, Origin, Content-Type e cabeçalho CSRF. */
function pedir(porta, caminho, opcoes = {}) {
  const corpo = opcoes.corpo === undefined ? null : JSON.stringify(opcoes.corpo);
  const cabecalhos = Object.assign(
    {
      Host: opcoes.host === undefined ? `127.0.0.1:${porta}` : opcoes.host,
    },
    opcoes.cabecalhos || {}
  );
  if (corpo !== null && cabecalhos["Content-Type"] === undefined) cabecalhos["Content-Type"] = "application/json";
  if (opcoes.cookie) cabecalhos.Cookie = opcoes.cookie;
  if (opcoes.csrf) cabecalhos["X-Console-CSRF"] = opcoes.csrf;
  if (opcoes.origem) cabecalhos.Origin = opcoes.origem;

  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: porta, path: caminho, method: opcoes.metodo || "GET", headers: cabecalhos, timeout: 15_000 },
      (res) => {
        let texto = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          texto += d;
        });
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(texto);
          } catch {}
          resolve({ status: res.statusCode, texto, json, cabecalhos: res.headers });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("tempo esgotado"));
    });
    req.on("error", reject);
    if (corpo !== null) req.end(corpo);
    else req.end();
  });
}

function cookieDe(resposta) {
  const bruto = resposta.cabecalhos["set-cookie"];
  if (!bruto || !bruto.length) return null;
  return bruto[0].split(";")[0];
}

/** Cria operador e devolve sessão pronta para uso. */
async function autenticar(mods, porta, { nome = "operador", senha = "senha-de-teste-12345" } = {}) {
  mods.auth.criarOperador(nome, senha);
  const r = await pedir(porta, "/api/sessao", { metodo: "POST", corpo: { nome, senha }, origem: `http://127.0.0.1:${porta}` });
  return { cookie: cookieDe(r), csrf: r.json.csrf, nome, senha, resposta: r };
}

async function elevar(mods, porta, sessao) {
  return pedir(porta, "/api/sessao/elevar", {
    metodo: "POST",
    corpo: { senha: sessao.senha },
    cookie: sessao.cookie,
    csrf: sessao.csrf,
    origem: `http://127.0.0.1:${porta}`,
  });
}

module.exports = { RAIZ, ambiente, subir, pedir, cookieDe, autenticar, elevar, dirTemporario };
