const bcrypt = require("bcryptjs");
const db = require("../config/database");
const { removerSessoesDoUsuario } = require("./tokenService");

const NIVEL_USUARIO = 1;
const NIVEL_ADMIN = 2;
const NIVEL_SUPERADMIN = 3;

function paraSaida(u) {
  return {
    id: u.id,
    usuario: u.usuario,
    nome: u.nome,
    nivel: u.nivel,
    isAdmin: u.nivel >= NIVEL_ADMIN,
    isSuperAdmin: u.nivel === NIVEL_SUPERADMIN,
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

function buscarPorId(id) {
  return db.prepare(`SELECT * FROM usuarios WHERE id = ?`).get(id);
}

function criar({ usuario, senha, nome, podeControlar, podeAgendar, isAdmin }, requisitante) {
  const existente = buscarPorUsuario(usuario);
  if (existente) throw new Error("já existe um usuário com esse login");

  if (isAdmin && (!requisitante || requisitante.nivel !== NIVEL_SUPERADMIN)) {
    throw new Error("apenas o administrador principal pode conceder privilégios de administrador");
  }

  if (!senha || senha.length < 6) throw new Error("senha deve ter ao menos 6 caracteres");

  const nivel = isAdmin ? NIVEL_ADMIN : NIVEL_USUARIO;
  const senhaHash = bcrypt.hashSync(senha, 10);
  const info = db.prepare(`
    INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel, podeControlar, podeAgendar, ativo)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `).run(usuario, senhaHash, nome, nivel >= NIVEL_ADMIN ? 1 : 0, nivel, podeControlar ? 1 : 0, podeAgendar ? 1 : 0);

  return paraSaida(buscarPorId(info.lastInsertRowid));
}

function atualizarPermissoes(id, { podeControlar, podeAgendar, ativo, isAdmin }, requisitante) {
  const usuario = buscarPorId(id);
  if (!usuario) throw new Error("usuário não encontrado");
  if (usuario.nivel === NIVEL_SUPERADMIN) {
    throw new Error("não é possível alterar o nível do administrador principal");
  }

  if (usuario.nivel === NIVEL_ADMIN && (ativo !== undefined || podeControlar !== undefined || podeAgendar !== undefined)) {
    if (!requisitante || requisitante.nivel !== NIVEL_SUPERADMIN) {
      throw new Error("apenas o administrador principal pode alterar outro administrador");
    }
  }

  let novoNivel = usuario.nivel;
  if (isAdmin !== undefined) {
    const querAdmin = !!isAdmin;
    if (querAdmin && usuario.nivel === NIVEL_USUARIO) {
      if (!requisitante || requisitante.nivel !== NIVEL_SUPERADMIN) {
        throw new Error("apenas o administrador principal pode conceder privilégios de administrador");
      }
      novoNivel = NIVEL_ADMIN;
    } else if (!querAdmin && usuario.nivel === NIVEL_ADMIN) {
      if (!requisitante || requisitante.nivel !== NIVEL_SUPERADMIN) {
        throw new Error("apenas o administrador principal pode remover privilégios de administrador");
      }
      novoNivel = NIVEL_USUARIO;
    }
  }

  db.prepare(`
    UPDATE usuarios
    SET podeControlar = COALESCE(?, podeControlar),
        podeAgendar = COALESCE(?, podeAgendar),
        ativo = COALESCE(?, ativo),
        nivel = ?,
        isAdmin = ?
    WHERE id = ?
  `).run(
    podeControlar === undefined ? null : (podeControlar ? 1 : 0),
    podeAgendar === undefined ? null : (podeAgendar ? 1 : 0),
    ativo === undefined ? null : (ativo ? 1 : 0),
    novoNivel,
    novoNivel >= NIVEL_ADMIN ? 1 : 0,
    id
  );

  if (ativo === false) removerSessoesDoUsuario(id);

  return paraSaida(buscarPorId(id));
}

function trocarLogin(id, novoLogin, requisitante) {
  const usuario = buscarPorId(id);
  if (!usuario) throw new Error("usuário não encontrado");
  if (usuario.nivel === NIVEL_SUPERADMIN && (!requisitante || requisitante.nivel !== NIVEL_SUPERADMIN)) {
    throw new Error("apenas o administrador principal pode alterar o próprio login");
  }
  if (!novoLogin || !novoLogin.trim()) throw new Error("informe o novo login");

  const loginLimpo = novoLogin.trim();
  const existente = buscarPorUsuario(loginLimpo);
  if (existente && existente.id !== id) throw new Error("já existe um usuário com esse login");

  db.prepare(`UPDATE usuarios SET usuario = ? WHERE id = ?`).run(loginLimpo, id);
  return paraSaida(buscarPorId(id));
}

function trocarSenha(id, novaSenha, requisitante) {
  const usuario = buscarPorId(id);
  if (!usuario) throw new Error("usuário não encontrado");
  if (usuario.nivel === NIVEL_SUPERADMIN && (!requisitante || requisitante.nivel !== NIVEL_SUPERADMIN)) {
    throw new Error("apenas o administrador principal pode alterar a própria senha");
  }
  if (!novaSenha || novaSenha.length < 6) throw new Error("senha deve ter ao menos 6 caracteres");
  const senhaHash = bcrypt.hashSync(novaSenha, 10);
  db.prepare(`UPDATE usuarios SET senhaHash = ? WHERE id = ?`).run(senhaHash, id);
  removerSessoesDoUsuario(id);
}

function remover(id) {
  const usuario = buscarPorId(id);
  if (!usuario) throw new Error("usuário não encontrado");
  if (usuario.nivel === NIVEL_SUPERADMIN) throw new Error("não é possível remover o administrador principal");

  removerSessoesDoUsuario(id);
  db.prepare(`DELETE FROM agendamentos WHERE usuarioId = ?`).run(id);
  db.prepare(`DELETE FROM usuarios WHERE id = ?`).run(id);
}

module.exports = {
  NIVEL_USUARIO,
  NIVEL_ADMIN,
  NIVEL_SUPERADMIN,
  listar,
  buscarPorUsuario,
  buscarPorId,
  criar,
  atualizarPermissoes,
  trocarLogin,
  trocarSenha,
  remover,
  paraSaida,
};
