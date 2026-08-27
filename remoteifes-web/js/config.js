const hostAtual = window.location.hostname;
const servidorPadrao = ["localhost", "127.0.0.1", "::1"].includes(hostAtual)
  ? `${window.location.protocol}//${hostAtual}:8080`
  : window.location.origin;

window.RemoteIFESConfig = {
  serverUrl: servidorPadrao,
};
