const CHAVE_SERVIDOR = "remoteifes_server_url";

function ehContextoEmpacotado() {
  const protocolo = window.location.protocol;
  if (protocolo === "file:" || protocolo === "content:") return true;
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

  definirServidor(valor) {
    if (!empacotado) return false;
    const normalizado = normalizarUrlServidor(valor);
    if (!normalizado) return false;
    try {
      localStorage.setItem(CHAVE_SERVIDOR, normalizado);
    } catch (erro) {
      return false;
    }
    return true;
  },
};
