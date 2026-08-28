// Resolução do endereço do servidor RemoteIFES.
//
// - No navegador (PWA hospedada junto do servidor): usa a própria origem.
//   Em localhost de desenvolvimento, assume a porta 8080.
// - No app empacotado (Cordova/APK): a página é carregada de file:// ou de
//   https://localhost, então NÃO existe uma origem útil. Nesse caso o endereço
//   precisa ser informado uma vez e fica salvo em localStorage.
// - Em qualquer contexto, um endereço salvo em localStorage tem prioridade
//   (permite apontar a PWA para outro servidor sem rebuild).

const CHAVE_SERVIDOR = "remoteifes_server_url";

function ehContextoEmpacotado() {
  const protocolo = window.location.protocol;
  if (protocolo === "file:" || protocolo === "content:") return true;
  // cordova-android 13+ serve o app de https://localhost/ com o objeto cordova presente
  if (window.cordova && ["localhost", "127.0.0.1"].includes(window.location.hostname)) return true;
  return false;
}

function normalizarUrlServidor(valor) {
  if (typeof valor !== "string") return null;
  const limpo = valor.trim().replace(/\/+$/, "");
  if (!limpo) return null;
  let url;
  try {
    url = new URL(limpo);
  } catch (erro) {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.protocol}//${url.host}`;
}

function lerServidorSalvo() {
  try {
    return normalizarUrlServidor(localStorage.getItem(CHAVE_SERVIDOR));
  } catch (erro) {
    return null;
  }
}

function servidorPadraoDoNavegador() {
  const host = window.location.hostname;
  if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    return `${window.location.protocol}//${host}:8080`;
  }
  return window.location.origin;
}

const empacotado = ehContextoEmpacotado();
const salvo = lerServidorSalvo();
const serverUrl = salvo || (empacotado ? "" : servidorPadraoDoNavegador());

window.RemoteIFESConfig = {
  serverUrl,
  empacotado,
  precisaConfigurar: empacotado && !salvo,

  definirServidor(valor) {
    const normalizado = normalizarUrlServidor(valor);
    if (!normalizado) return false;
    try {
      localStorage.setItem(CHAVE_SERVIDOR, normalizado);
    } catch (erro) {
      return false;
    }
    return true;
  },

  limparServidor() {
    try {
      localStorage.removeItem(CHAVE_SERVIDOR);
    } catch (erro) {
      /* ignora */
    }
  },
};
