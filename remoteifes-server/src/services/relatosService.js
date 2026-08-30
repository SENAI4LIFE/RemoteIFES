const db = require("../config/database");
const logger = require("../utils/logger");

const CATEGORIAS = [
  "ar_condicionado",
  "agendamento",
  "interface",
  "acesso_login",
  "esp32_dispositivo",
  "outro",
];

const STATUS = ["novo", "aberto", "em_analise", "resolvido"];
const STATUS_PENDENTES = ["novo", "aberto", "em_analise"];

const LIMITES = {
  titulo: { min: 3, max: 140 },
  descricao: { min: 10, max: 4000 },
  resposta: { max: 2000 },
  pagina: { max: 80 },
  sala: { max: 40 },
  contextoPath: { max: 200 },
  contextoUserAgent: { max: 300 },
  contextoIdioma: { max: 20 },
  contextoViewport: { max: 15 },
};

const VIEWPORT_REGEX = /^\d{1,5}x\d{1,5}$/;
const CONTROLE_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

function limparControle(valor) {
  return String(valor == null ? "" : valor).replace(CONTROLE_REGEX, "");
}

function limparLinhaUnica(valor, max) {
  return limparControle(valor).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max);
}

function limparMultilinha(valor, max) {
  return limparControle(valor).replace(/\r\n?/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim().slice(0, max);
}

function salaExiste(sala) {
  return !!db.prepare(`SELECT sala FROM salas WHERE sala = ?`).get(sala);
}

function montarContexto(contextoCliente, req) {
  const contexto = {};
  const bruto = contextoCliente && typeof contextoCliente === "object" ? contextoCliente : {};

  const path = limparLinhaUnica(bruto.path, LIMITES.contextoPath.max);
  if (path) contexto.path = path;

  const viewport = limparLinhaUnica(bruto.viewport, LIMITES.contextoViewport.max);
  if (viewport && VIEWPORT_REGEX.test(viewport)) contexto.viewport = viewport;

  if (req && typeof req.get === "function") {
    const userAgent = limparLinhaUnica(req.get("user-agent"), LIMITES.contextoUserAgent.max);
    if (userAgent) contexto.userAgent = userAgent;
    const idioma = limparLinhaUnica(String(req.get("accept-language") || "").split(",")[0], LIMITES.contextoIdioma.max);
    if (idioma) contexto.idioma = idioma;
  }

  contexto.registradoEm = new Date().toISOString();
  return contexto;
}

function parseContexto(texto) {
  if (!texto) return null;
  try {
    const dados = JSON.parse(texto);
    return dados && typeof dados === "object" ? dados : null;
  } catch (erro) {
    return null;
  }
}

function autorDe(linha) {
  const nome = linha.liveNome || linha.usuarioNome || null;
  const login = linha.liveLogin || linha.usuarioLogin || null;
  return {
    id: linha.usuarioId || null,
    nome: nome || "(usuário removido)",
    login: login || null,
    removido: !linha.usuarioId,
  };
}

function paraSaida(linha) {
  return {
    id: linha.id,
    titulo: linha.titulo,
    descricao: linha.descricao,
    categoria: linha.categoria,
    sala: linha.sala || null,
    pagina: linha.pagina || null,
    contexto: parseContexto(linha.contexto),
    status: linha.status,
    resposta: linha.resposta || null,
    criadoEm: linha.criadoEm,
    atualizadoEm: linha.atualizadoEm,
    revisadoEm: linha.revisadoEm || null,
    autor: autorDe(linha),
  };
}

function paraSaidaDoUsuario(linha) {
  return {
    id: linha.id,
    titulo: linha.titulo,
    descricao: linha.descricao,
    categoria: linha.categoria,
    sala: linha.sala || null,
    pagina: linha.pagina || null,
    status: linha.status,
    resposta: linha.resposta || null,
    criadoEm: linha.criadoEm,
    atualizadoEm: linha.atualizadoEm,
  };
}

function criar(dadosBrutos, requisitante, req) {
  const dados = dadosBrutos && typeof dadosBrutos === "object" ? dadosBrutos : {};

  const titulo = limparLinhaUnica(dados.titulo, LIMITES.titulo.max);
  if (titulo.length < LIMITES.titulo.min) {
    throw new Error(`o título deve ter ao menos ${LIMITES.titulo.min} caracteres`);
  }

  const descricao = limparMultilinha(dados.descricao, LIMITES.descricao.max);
  if (descricao.length < LIMITES.descricao.min) {
    throw new Error(`a descrição deve ter ao menos ${LIMITES.descricao.min} caracteres`);
  }

  let categoria = limparLinhaUnica(dados.categoria, 40).toLowerCase();
  if (!CATEGORIAS.includes(categoria)) categoria = "outro";

  let sala = null;
  if (dados.sala !== undefined && dados.sala !== null && String(dados.sala).trim() !== "") {
    const salaLimpa = limparLinhaUnica(dados.sala, LIMITES.sala.max);
    if (!salaExiste(salaLimpa)) throw new Error("sala informada não existe");
    sala = salaLimpa;
  }

  const pagina = limparLinhaUnica(dados.pagina, LIMITES.pagina.max) || null;
  const contexto = JSON.stringify(montarContexto(dados.contexto, req));

  const usuarioId = requisitante ? requisitante.id : null;
  const usuarioNome = requisitante ? requisitante.nome : null;
  const usuarioLogin = requisitante ? requisitante.usuario : null;

  const recente = usuarioId
    ? db.prepare(`
        SELECT * FROM relatos
        WHERE usuarioId = ? AND titulo = ? AND descricao = ?
          AND criadoEm > datetime('now', '-90 seconds')
        ORDER BY id DESC LIMIT 1
      `).get(usuarioId, titulo, descricao)
    : null;

  if (recente) {
    return { relato: paraSaidaDoUsuario(recente), duplicado: true };
  }

  const info = db.prepare(`
    INSERT INTO relatos (usuarioId, usuarioNome, usuarioLogin, titulo, descricao, categoria, sala, pagina, contexto, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'novo')
  `).run(usuarioId, usuarioNome, usuarioLogin, titulo, descricao, categoria, sala, pagina, contexto);

  logger.info("relato-criado", { id: Number(info.lastInsertRowid), usuarioId, categoria, sala: sala || null });

  const linha = db.prepare(`SELECT * FROM relatos WHERE id = ?`).get(info.lastInsertRowid);
  return { relato: paraSaidaDoUsuario(linha), duplicado: false };
}

function listarDoUsuario(usuarioId, { limite = 50 } = {}) {
  const max = Number.isInteger(limite) && limite > 0 && limite <= 200 ? limite : 50;
  return db.prepare(`
    SELECT * FROM relatos WHERE usuarioId = ? ORDER BY id DESC LIMIT ?
  `).all(usuarioId, max).map(paraSaidaDoUsuario);
}

const SQL_LISTA = `
  SELECT r.*, u.nome AS liveNome, u.usuario AS liveLogin
  FROM relatos r
  LEFT JOIN usuarios u ON u.id = r.usuarioId
`;

function listar({ status, limite = 100 } = {}) {
  const max = Number.isInteger(limite) && limite > 0 && limite <= 500 ? limite : 100;
  if (status !== undefined && status !== null && !STATUS.includes(status)) {
    throw new Error("status inválido");
  }
  const filtrar = status !== undefined && status !== null;
  const where = filtrar ? `WHERE r.status = ?` : "";
  const ordem = `ORDER BY (r.status = 'resolvido') ASC, r.id DESC`;
  const stmt = db.prepare(`${SQL_LISTA} ${where} ${ordem} LIMIT ?`);
  const linhas = filtrar ? stmt.all(status, max) : stmt.all(max);
  return linhas.map(paraSaida);
}

function buscarPorId(id) {
  const linha = db.prepare(`${SQL_LISTA} WHERE r.id = ?`).get(id);
  return linha ? paraSaida(linha) : null;
}

function contarPorStatus() {
  const linhas = db.prepare(`SELECT status, COUNT(*) AS total FROM relatos GROUP BY status`).all();
  const contagem = { novo: 0, aberto: 0, em_analise: 0, resolvido: 0 };
  for (const { status, total } of linhas) {
    if (contagem[status] !== undefined) contagem[status] = total;
  }
  const pendentes = STATUS_PENDENTES.reduce((soma, s) => soma + (contagem[s] || 0), 0);
  return {
    novos: contagem.novo,
    abertos: contagem.aberto,
    emAnalise: contagem.em_analise,
    resolvidos: contagem.resolvido,
    pendentes,
    total: pendentes + contagem.resolvido,
  };
}

function marcarAbertoSeNovo(id, revisorId) {
  db.prepare(`
    UPDATE relatos
    SET status = 'aberto', revisadoPor = ?, revisadoEm = datetime('now'), atualizadoEm = datetime('now')
    WHERE id = ? AND status = 'novo'
  `).run(revisorId, id);
}

function atualizar(id, dadosBrutos, revisor) {
  const linha = db.prepare(`SELECT * FROM relatos WHERE id = ?`).get(id);
  if (!linha) throw new Error("relato não encontrado");

  const dados = dadosBrutos && typeof dadosBrutos === "object" ? dadosBrutos : {};

  let novoStatus = linha.status;
  if (dados.status !== undefined) {
    if (!STATUS.includes(dados.status)) throw new Error("status inválido");
    novoStatus = dados.status;
  }

  let novaResposta = linha.resposta;
  if (dados.resposta !== undefined) {
    const limpa = limparMultilinha(dados.resposta, LIMITES.resposta.max);
    novaResposta = limpa === "" ? null : limpa;
  }

  db.prepare(`
    UPDATE relatos
    SET status = ?, resposta = ?, revisadoPor = ?, revisadoEm = datetime('now'), atualizadoEm = datetime('now')
    WHERE id = ?
  `).run(novoStatus, novaResposta, revisor ? revisor.id : null, id);

  logger.info("relato-atualizado", { id, status: novoStatus, por: revisor ? revisor.id : null });
  return buscarPorId(id);
}

function remover(id, revisor) {
  const linha = db.prepare(`SELECT id, status FROM relatos WHERE id = ?`).get(id);
  if (!linha) throw new Error("relato não encontrado");
  db.prepare(`DELETE FROM relatos WHERE id = ?`).run(id);
  logger.info("relato-removido", { id, status: linha.status, por: revisor ? revisor.id : null });
}

module.exports = {
  CATEGORIAS,
  STATUS,
  LIMITES,
  criar,
  listarDoUsuario,
  listar,
  buscarPorId,
  contarPorStatus,
  marcarAbertoSeNovo,
  atualizar,
  remover,
};
