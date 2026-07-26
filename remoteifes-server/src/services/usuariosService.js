const bcrypt = require("bcryptjs");
const db = require("../config/database");
const { removerSessoesDoUsuario } = require("./tokenService");

function paraSaida(u) {
  return {
    id: u.id,
    usuario: u.usuario,
    nome: u.nome,
    isAdmin: !!u.isAdmin,
    podeControlar: !!u.podeControlar,
    podeAgendar: !!u.podeAgendar,
    ativo: !!u.ativo,
    criadoEm: u.criadoEm,
  };
}

function listar() {
  return db.prepare(`SELECT * FROM usuarios ORDER BY criadoEm DESC`).all().map(paraSaida);
}

function buscarPorUsuario(usuario) {
  return db.prepare(`SELECT * FROM usuarios WHERE usuario = ?`).get(usuario);
}

function criar({ usuario, senha, nome, podeControlar, podeAgendar }) {
  const existente = buscarPorUsuario(usuario);
  if (existente) throw new Error("já existe um usuário com esse login");

  const senhaHash = bcrypt.hashSync(senha, 10);
  const info = db.prepare(`
    INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, podeControlar, podeAgendar, ativo)
    VALUES (?, ?, ?, 0, ?, ?, 1)
  `).run(usuario, senhaHash, nome, podeControlar ? 1 : 0, podeAgendar ? 1 : 0);

  return paraSaida(db.prepare(`SELECT * FROM usuarios WHERE id = ?`).get(info.lastInsertRowid));
}

function atualizarPermissoes(id, { podeControlar, podeAgendar, ativo }) {
  const usuario = db.prepare(`SELECT * FROM usuarios WHERE id = ?`).get(id);
  if (!usuario) throw new Error("usuário não encontrado");
  if (usuario.isAdmin) throw new Error("não é possível alterar permissões do administrador");

  db.prepare(`
    UPDATE usuarios
    SET podeControlar = COALESCE(?, podeControlar),
        podeAgendar = COALESCE(?, podeAgendar),
        ativo = COALESCE(?, ativo)
    WHERE id = ?
  `).run(
    podeControlar === undefined ? null : (podeControlar ? 1 : 0),
    podeAgendar === undefined ? null : (podeAgendar ? 1 : 0),
    ativo === undefined ? null : (ativo ? 1 : 0),
    id
  );

  if (ativo === false) removerSessoesDoUsuario(id);

  return paraSaida(db.prepare(`SELECT * FROM usuarios WHERE id = ?`).get(id));
}

function trocarSenha(id, novaSenha) {
  const senhaHash = bcrypt.hashSync(novaSenha, 10);
  db.prepare(`UPDATE usuarios SET senhaHash = ? WHERE id = ?`).run(senhaHash, id);
}

function remover(id) {
  const usuario = db.prepare(`SELECT * FROM usuarios WHERE id = ?`).get(id);
  if (!usuario) throw new Error("usuário não encontrado");
  if (usuario.isAdmin) throw new Error("não é possível remover o administrador");

  removerSessoesDoUsuario(id);
  db.prepare(`DELETE FROM agendamentos WHERE usuarioId = ?`).run(id);
  db.prepare(`DELETE FROM usuarios WHERE id = ?`).run(id);
}

module.exports = {
  listar,
  buscarPorUsuario,
  criar,
  atualizarPermissoes,
  trocarSenha,
  remover,
  paraSaida,
};
