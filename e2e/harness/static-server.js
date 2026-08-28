const http = require("http");
const fs = require("fs");
const path = require("path");

const RAIZ_WEB = path.join(__dirname, "..", "..", "remoteifes-web");
const PORT = Number(process.env.E2E_WEB_PORT || 8790);

const TIPOS = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  let rel = url === "/" ? "/index.html" : url;
  const alvo = path.normalize(path.join(RAIZ_WEB, rel));

  if (alvo !== RAIZ_WEB && !alvo.startsWith(RAIZ_WEB + path.sep)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  fs.readFile(alvo, (err, dados) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": TIPOS[path.extname(alvo)] || "application/octet-stream" });
    res.end(dados);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[e2e-web] servindo ${RAIZ_WEB} em http://127.0.0.1:${PORT}`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
