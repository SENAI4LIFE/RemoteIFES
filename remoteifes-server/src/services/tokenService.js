const crypto = require("crypto");
const db = require("../config/database");
const configuracoesService = require("./configuracoesService");
const { paraEpochMs } = require("../utils/tempo");

const NIVEL_ADMIN = 2;
const SESSAO_MAX_HORAS_PADRAO = 12;
const INTERVALO_MIN_GRAVACAO_USO_MS = 30 * 1000;

function sessaoMaxHoras() {
  const valor = Number(process.env.SESSAO_MAX_HORAS || SESSAO_MAX_HORAS_PADRAO);
  return Number.isFinite(valor) && valor > 0 && valor <= 168 ? valor : SESSAO_MAX_HORAS_PADRAO;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function gerarToken(usuarioId) {
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare(`INSERT INTO sessoes (token, usuarioId) VALUES (?, ?)`).run(hashToken(token), usuarioId);
  return token;
}

function detalhesSessao(sessao, baseInatividadeMs = Date.now(), cfg = null) {
  const timeoutInatividadeMinutos = configuracoesService.timeoutEfetivoParaUsuario(sessao.nivel >= NIVEL_ADMIN, cfg);
  const expiraAbsoluta = paraEpochMs(sessao.login) + sessaoMaxHoras() * 3600000;
  const expiraInatividade = baseInatividadeMs + timeoutInatividadeMinutos * 60000;
  return {
    timeoutInatividadeMinutos,
    sessaoExpiraEm: new Date(Math.min(expiraAbsoluta, expiraInatividade)).toISOString(),
    servidorAgora: new Date().toISOString(),
  };
}

const SELECT_SESSAO = `
  SELECT s.token AS tokenHash, s.login, s.ultimoUso, u.*
  FROM sessoes s
  JOIN usuarios u ON u.id = s.usuarioId
  WHERE s.logout IS NULL AND u.ativo = 1`;

function avaliarSessao(sessao, { atualizarUso, cfg }) {
  if (!sessao) return null;
  const tokenHash = sessao.tokenHash;
  delete sessao.tokenHash;
  sessao.token = tokenHash;

  const idadeHoras = (Date.now() - paraEpochMs(sessao.login)) / 3600000;
  if (idadeHoras > sessaoMaxHoras()) {
    removerTokenPorHash(tokenHash);
    return null;
  }

  const configuracoes = cfg || configuracoesService.obter();
  const timeoutMinutos = configuracoesService.timeoutEfetivoParaUsuario(sessao.nivel >= NIVEL_ADMIN, configuracoes);
  const ultimoUsoMs = paraEpochMs(sessao.ultimoUso);
  if (timeoutMinutos) {
    const minutosInativo = (Date.now() - ultimoUsoMs) / 60000;
    if (minutosInativo > timeoutMinutos) {
      removerTokenPorHash(tokenHash);
      return null;
    }
  }

  const agora = Date.now();
  const gravarUso = atualizarUso && !(Number.isFinite(ultimoUsoMs) && agora - ultimoUsoMs < INTERVALO_MIN_GRAVACAO_USO_MS);
  if (gravarUso) {
    db.prepare(`UPDATE sessoes SET ultimoUso = datetime('now') WHERE token = ?`).run(tokenHash);
  }
  Object.assign(sessao, detalhesSessao(sessao, gravarUso ? agora : ultimoUsoMs, configuracoes));
  return sessao;
}

function validarToken(token, { atualizarUso = true, cfg = null } = {}) {
  const sessao = db.prepare(`${SELECT_SESSAO} AND s.token = ?`).get(hashToken(token));
  return avaliarSessao(sessao, { atualizarUso, cfg });
}

function validarTokens(tokens, { atualizarUso = false, cfg = null } = {}) {
  const resultado = new Map();
  const unicos = [...new Set(tokens.filter((t) => typeof t === "string" && t))];
  if (!unicos.length) return resultado;
  const configuracoes = cfg || configuracoesService.obter();
  const porHash = new Map(unicos.map((t) => [hashToken(t), t]));
  const hashes = [...porHash.keys()];
  const linhas = db.prepare(`${SELECT_SESSAO} AND s.token IN (${hashes.map(() => "?").join(", ")})`).all(...hashes);
  const encontradas = new Map(linhas.map((l) => [l.tokenHash, l]));
  for (const [hash, token] of porHash) {
    resultado.set(token, avaliarSessao(encontradas.get(hash) || null, { atualizarUso, cfg: configuracoes }));
  }
  return resultado;
}

function removerTokenPorHash(tokenHash) {
  db.prepare(`UPDATE sessoes SET logout = datetime('now') WHERE token = ? AND logout IS NULL`).run(tokenHash);
}

function removerToken(token) {
  removerTokenPorHash(hashToken(token));
}

function removerSessoesDoUsuario(usuarioId) {
  db.prepare(`UPDATE sessoes SET logout = datetime('now') WHERE usuarioId = ? AND logout IS NULL`).run(usuarioId);
}

function encerrarSessoesAtivasNoInicio() {
  db.prepare(`UPDATE sessoes SET logout = datetime('now') WHERE logout IS NULL`).run();
}

const HORAS_SESSAO_ABANDONADA = 24;

function encerrarSessoesAbandonadas() {
  db.prepare(`
    UPDATE sessoes SET logout = datetime('now')
    WHERE logout IS NULL AND ultimoUso < datetime('now', '-${HORAS_SESSAO_ABANDONADA} hours')
  `).run();
}

function listarUsuariosAtivos() {
  const { limiarOnlineMinutos } = configuracoesService.obter();

  const linhas = db.prepare(`
    SELECT u.id, u.usuario, u.nome, u.isAdmin,
      (SELECT s2.login FROM sessoes s2 WHERE s2.usuarioId = u.id AND s2.logout IS NULL ORDER BY s2.login DESC LIMIT 1) AS loginAtivo,
      (SELECT s2.ultimoUso FROM sessoes s2 WHERE s2.usuarioId = u.id AND s2.logout IS NULL ORDER BY s2.login DESC LIMIT 1) AS ultimoUsoAtivo,
      (SELECT MAX(s3.ultimoUso) FROM sessoes s3 WHERE s3.usuarioId = u.id) AS ultimoAcesso
    FROM usuarios u
    WHERE EXISTS (SELECT 1 FROM sessoes s4 WHERE s4.usuarioId = u.id)
    ORDER BY COALESCE(ultimoUsoAtivo, ultimoAcesso) DESC
  `).all();

  return linhas.map((l) => {
    let status = "offline";
    if (l.loginAtivo) {
      const minutosInativo = l.ultimoUsoAtivo
        ? (Date.now() - paraEpochMs(l.ultimoUsoAtivo)) / 60000
        : Infinity;
      status = minutosInativo <= limiarOnlineMinutos ? "online" : "inativo";
    }
    return {
      usuario: l.usuario,
      nome: l.nome,
      isAdmin: !!l.isAdmin,
      ultimoAcesso: l.ultimoAcesso,
      status,
      sessaoLoginEm: l.loginAtivo || null,
    };
  });
}

function listarHistoricoSessoes({ data, limite = 500 } = {}) {
  const max = Number.isInteger(limite) && limite > 0 && limite <= 2000 ? limite : 500;
  let query = `
    SELECT u.usuario, u.nome, s.login, s.logout
    FROM sessoes s
    JOIN usuarios u ON u.id = s.usuarioId
    WHERE 1=1
  `;
  const params = [];
  if (data) {
    query += " AND date(s.login, '-3 hours') = ?";
    params.push(data);
  }
  query += " ORDER BY s.login DESC LIMIT ?";
  params.push(max);
  const linhas = db.prepare(query).all(...params);

  return linhas.map((l) => {
    const inicioMs = paraEpochMs(l.login);
    const fimMs = l.logout ? paraEpochMs(l.logout) : Date.now();
    return {
      ...l,
      duracaoSegundos: Math.max(0, Math.round((fimMs - inicioMs) / 1000)),
      emAndamento: !l.logout,
    };
  });
}

function apagarHistoricoSessoes({ data } = {}) {
  if (data) {
    db.prepare(`DELETE FROM sessoes WHERE logout IS NOT NULL AND date(login, '-3 hours') = ?`).run(data);
  } else {
    db.prepare(`DELETE FROM sessoes WHERE logout IS NOT NULL`).run();
  }
}

module.exports = {
  gerarToken,
  validarToken,
  validarTokens,
  removerToken,
  removerSessoesDoUsuario,
  encerrarSessoesAtivasNoInicio,
  encerrarSessoesAbandonadas,
  listarUsuariosAtivos,
  listarHistoricoSessoes,
  apagarHistoricoSessoes,
  detalhesSessao,
};
