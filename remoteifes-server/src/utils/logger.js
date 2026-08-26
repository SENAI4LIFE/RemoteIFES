function formatarLinha(nivel, categoria, detalhes) {
  const timestamp = new Date().toISOString();
  const sufixo = detalhes === undefined ? "" : ` ${JSON.stringify(detalhes)}`;
  return `[${timestamp}] [${nivel}] [${categoria}]${sufixo}`;
}

function info(categoria, detalhes) {
  console.log(formatarLinha("INFO", categoria, detalhes));
}

function warn(categoria, detalhes) {
  console.warn(formatarLinha("WARN", categoria, detalhes));
}

function error(categoria, detalhes) {
  console.error(formatarLinha("ERROR", categoria, detalhes));
}

module.exports = { info, warn, error };
