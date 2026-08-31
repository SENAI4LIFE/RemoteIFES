const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "remoteifes-web");
const DEST = path.join(__dirname, "www");
const EXCLUDE = new Set(["manifest.webmanifest", "sw.js", ".nojekyll"]);

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

fs.rmSync(DEST, { recursive: true, force: true });
copyDir(SRC, DEST);
const indexPath = path.join(DEST, "index.html");
const index = fs.readFileSync(indexPath, "utf8");
// O primeiro script da aplicação declara a versão do frontend e traz o sufixo "?v=" dessa versão.
const marcador = /^([ \t]*)<script src="js\/version\.js(?:\?[^"]*)?"><\/script>$/m;
const encontrado = index.match(marcador);
if (!encontrado) throw new Error("marcador de scripts não encontrado no index.html");
fs.writeFileSync(indexPath, index.replace(marcador, `${encontrado[1]}<script src="cordova.js"></script>\n${encontrado[0]}`));
console.log(`remoteifes-web sincronizado em ${DEST}`);
