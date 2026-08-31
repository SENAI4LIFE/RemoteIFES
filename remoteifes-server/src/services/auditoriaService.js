const db = require("../config/database");

const LIMITE_PADRAO = 25;
const LIMITE_MAXIMO = 100;

function texto(valor, max = 300) {
  if (valor === undefined || valor === null) return null;
  return String(valor).replace(/[\x00-\x1F\x7F]/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, max) || null;
}

function dataSql(valor) {
  if (!valor) return null;
  const data = new Date(valor);
  return Number.isFinite(data.getTime()) ? data.toISOString().slice(0, 19).replace("T", " ") : null;
}

function registrar({ tipo, ator, alvoTipo, alvoId, alvoRotulo, descricao, camposAlterados = [] }) {
  const evento = texto(tipo, 80);
  const resumo = texto(descricao);
  if (!evento || !resumo) throw new Error("evento de auditoria invalido");
  const campos = Array.isArray(camposAlterados)
    ? camposAlterados.map((campo) => texto(campo, 60)).filter(Boolean).slice(0, 20).join(",")
    : "";
  return Number(db.prepare(`
    INSERT INTO auditoria_eventos
      (tipo, atorId, atorLogin, alvoTipo, alvoId, alvoRotulo, descricao, camposAlterados)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    evento,
    ator && Number.isInteger(ator.id) ? ator.id : null,
    ator ? texto(ator.usuario, 60) : null,
    texto(alvoTipo, 40),
    texto(alvoId, 120),
    texto(alvoRotulo, 120),
    resumo,
    campos || null
  ).lastInsertRowid);
}

function paginacao(valorPagina, valorLimite) {
  const pagina = Number(valorPagina || 1);
  const limite = Number(valorLimite || LIMITE_PADRAO);
  if (!Number.isInteger(pagina) || pagina < 1) throw new Error("pagina invalida");
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new Error("limite invalido");
  return { pagina, limite, offset: (pagina - 1) * limite };
}

function validarData(data) {
  if (data === undefined || data === "") return null;
  if (typeof data !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error("data invalida");
  return data;
}

function listar(filtros = {}) {
  const { pagina, limite, offset } = paginacao(filtros.pagina, filtros.limite);
  const onde = [];
  const params = [];
  const data = validarData(filtros.data);
  if (data) { onde.push("date(criadoEm) = ?"); params.push(data); }
  for (const [campo, valor, max] of [["tipo", filtros.tipo, 80], ["atorLogin", filtros.ator, 60]]) {
    if (valor !== undefined && valor !== "") {
      const normalizado = texto(valor, max);
      if (!normalizado) throw new Error("filtro invalido");
      onde.push(`${campo} = ?`);
      params.push(normalizado);
    }
  }
  if (filtros.alvo !== undefined && filtros.alvo !== "") {
    const alvo = texto(filtros.alvo, 120);
    if (!alvo) throw new Error("filtro invalido");
    onde.push("(alvoRotulo LIKE ? ESCAPE '\\' OR alvoId = ?)");
    params.push(`%${alvo.replace(/[\\%_]/g, "\\$&")}%`, alvo);
  }
  const clausula = onde.length ? `WHERE ${onde.join(" AND ")}` : "";
  const total = Number(db.prepare(`SELECT COUNT(*) n FROM auditoria_eventos ${clausula}`).get(...params).n);
  const itens = db.prepare(`
    SELECT id, tipo, atorLogin, alvoTipo, alvoId, alvoRotulo, descricao, camposAlterados, criadoEm
    FROM auditoria_eventos ${clausula}
    ORDER BY criadoEm DESC, id DESC LIMIT ? OFFSET ?
  `).all(...params, limite, offset);
  return { itens, pagina, limite, total, paginas: Math.max(1, Math.ceil(total / limite)) };
}

function registrarOffline(sala, quando) {
  const salaLimpa = texto(sala, 100);
  if (!salaLimpa) return false;
  return db.prepare(`
    INSERT OR IGNORE INTO esp_indisponibilidades (sala, offlineEm)
    VALUES (?, COALESCE(?, datetime('now')))
  `).run(salaLimpa, dataSql(quando)).changes > 0;
}

function registrarOnline(sala, quando) {
  const salaLimpa = texto(sala, 100);
  if (!salaLimpa) return null;
  const aberta = db.prepare(`SELECT id FROM esp_indisponibilidades WHERE sala = ? AND onlineEm IS NULL LIMIT 1`).get(salaLimpa);
  if (!aberta) return null;
  const onlineEm = dataSql(quando) || new Date().toISOString().slice(0, 19).replace("T", " ");
  db.prepare(`
    UPDATE esp_indisponibilidades
    SET onlineEm = ?, duracaoSegundos = MAX(0, CAST(strftime('%s', ?) - strftime('%s', offlineEm) AS INTEGER))
    WHERE id = ? AND onlineEm IS NULL
  `).run(onlineEm, onlineEm, aberta.id);
  return db.prepare("SELECT * FROM esp_indisponibilidades WHERE id = ?").get(aberta.id);
}

function listarConectividade(filtros = {}) {
  const { pagina, limite, offset } = paginacao(filtros.pagina, filtros.limite);
  const onde = [];
  const params = [];
  const data = validarData(filtros.data);
  if (data) { onde.push("date(offlineEm) = ?"); params.push(data); }
  if (filtros.sala !== undefined && filtros.sala !== "") {
    const sala = texto(filtros.sala, 100);
    if (!sala) throw new Error("sala invalida");
    onde.push("sala = ?"); params.push(sala);
  }
  const clausula = onde.length ? `WHERE ${onde.join(" AND ")}` : "";
  const total = Number(db.prepare(`SELECT COUNT(*) n FROM esp_indisponibilidades ${clausula}`).get(...params).n);
  const itens = db.prepare(`SELECT id, sala, offlineEm, onlineEm, duracaoSegundos FROM esp_indisponibilidades ${clausula}
    ORDER BY offlineEm DESC, id DESC LIMIT ? OFFSET ?`).all(...params, limite, offset);
  return { itens, pagina, limite, total, paginas: Math.max(1, Math.ceil(total / limite)) };
}

function tipos() {
  return db.prepare("SELECT tipo, COUNT(*) total FROM auditoria_eventos GROUP BY tipo ORDER BY tipo").all();
}

module.exports = { registrar, listar, tipos, registrarOffline, registrarOnline, listarConectividade, LIMITE_MAXIMO };
