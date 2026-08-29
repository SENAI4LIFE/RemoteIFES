const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const { exigirLogin } = require("../middlewares/auth");

const router = express.Router();
const RELEASE_DIR = path.resolve(process.env.MOBILE_APP_RELEASE_DIR || path.join(__dirname, "..", "..", "data", "releases", "mobile"));
const METADATA = path.join(RELEASE_DIR, "release.json");
let releaseCache = null;

function dadosPublicados(req) {
  try {
    const metaStat = fs.statSync(METADATA);
    const meta = JSON.parse(fs.readFileSync(METADATA, "utf8"));
    if (!/^\d+\.\d+\.\d+$/.test(String(meta.version || ""))) return null;
    if (!/^\d+$/.test(String(meta.build || ""))) return null;
    if (!/^[a-f0-9]{64}$/.test(String(meta.sha256 || ""))) return null;
    if (!/^[a-f0-9]{64}$/.test(String(meta.certificateSha256 || ""))) return null;
    if (meta.artifactType !== "release" || meta.signed !== true || meta.debuggable !== false) return null;
    if (typeof meta.serverOrigin !== "string" || !/^https?:\/\/[^/]+$/.test(meta.serverOrigin)) return null;
    if (meta.serverOrigin !== `${req.protocol}://${req.get("host")}`) return null;
    const nome = path.basename(String(meta.file || ""));
    if (!nome.toLowerCase().endsWith(".apk")) return null;
    if (/debug|unsigned/i.test(nome)) return null;
    const arquivo = path.join(RELEASE_DIR, nome);
    const arquivoStat = fs.statSync(arquivo);
    if (!arquivoStat.isFile()) return null;
    const cacheKey = `${metaStat.mtimeMs}|${metaStat.size}|${arquivoStat.mtimeMs}|${arquivoStat.size}`;
    if (releaseCache && releaseCache.key === cacheKey) return releaseCache.release;
    const hash = crypto.createHash("sha256").update(fs.readFileSync(arquivo)).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(meta.sha256))) return null;
    const release = { ...meta, arquivo, nome, tamanhoBytes: arquivoStat.size };
    releaseCache = { key: cacheKey, release };
    return release;
  } catch (erro) {
    return null;
  }
}

function tamanho(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

router.get("/mobile-app/info", exigirLogin, (req, res) => {
  const release = dadosPublicados(req);
  res.set("Cache-Control", "no-store");
  res.json({
    ok: true,
    versao: release ? release.version : "1.0.0",
    android: release ? {
      disponivel: true,
      build: String(release.build),
      sha256: release.sha256,
      certificateSha256: release.certificateSha256,
      tamanho: tamanho(release.tamanhoBytes),
      url: "/mobile-app/android",
    } : { disponivel: false },
  });
});

router.get("/mobile-app/android", exigirLogin, (req, res) => {
  const release = dadosPublicados(req);
  if (!release) return res.status(404).json({ ok: false, erro: "APK de produção não publicado" });
  res.set("Cache-Control", "private, no-store");
  res.set("Content-Type", "application/vnd.android.package-archive");
  res.set("X-APK-SHA256", release.sha256);
  return res.download(release.arquivo, `RemoteIFES-${release.version}-${release.build}.apk`);
});

module.exports = router;
