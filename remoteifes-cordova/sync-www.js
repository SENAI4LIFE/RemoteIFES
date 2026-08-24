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
console.log(`remoteifes-web sincronizado em ${DEST}`);
