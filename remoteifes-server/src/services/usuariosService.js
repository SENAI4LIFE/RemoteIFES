const bcrypt = require("bcryptjs");
const db = require("../config/database");
const { removerSessoesDoUsuario } = require("./tokenService");
const logger = require("../utils/logger");

const NIVEL_USUARIO = 1;
const NIVEL_ADMIN = 2;
const NIVEL_SUPERADMIN = 3;

const SENHA_MIN = 8;
const SENHA_MAX = 128;

const NOME_MAX = 120;
const LOGIN_MAX = 60;
const CONTROLE_REGEX = /[\x00-\x1F\x7F]/g;

function validarSenha(senha) {
  if (typeof senha !== "string" || senha.length < SENHA_MIN) {
    throw new Error(`senha deve ter ao menos ${SENHA_MIN} caracteres`);
  }
  if (senha.length > SENHA_MAX) {
    throw new Error(`senha deve ter no máximo ${SENHA_MAX} caracteres`);
  }
}

function limparNome(valor) {
  if (typeof valor !== "string") throw new Error("informe um nome válido");
  const limpo = valor
    .replace(CONTROLE_REGEX, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!limpo) throw new Error("informe um nome válido");
  if (limpo.length > NOME_MAX) throw new Error(`nome deve ter no máximo ${NOME_MAX} caracteres`);
  return limpo;
}

function limparLogin(valor) {
  if (typeof valor !== "string") throw new Error("informe um login válido");
  const limpo = valor
    .replace(CONTROLE_REGEX, "")
    .trim();
  if (!limpo) throw new Error("informe um login válido");
  if (limpo.length > LOGIN_MAX) throw new Error(`login deve ter no máximo ${LOGIN_MAX} caracteres`);
  if (!/^[A-Za-z0-9._@-]+$/.test(limpo)) {
    throw new Error("login pode conter apenas letras, números e os símbolos . _ - @ (sem espaços)");
  }
  return limpo;
}

function paraSaida(u) {
  return {
    id: u.id,
    usuario: u.usuario,
    nome: u.nome,
    nivel: u.nivel,
    isAdmin: u.nivel >= NIVEL_ADMIN,
    isSuperAdmin: u.nivel === NIVEL_SUPERADMIN,
    podeControlar: !!u.podeControlar,
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

function criar({ usuario, senha, nome, podeControlar, isAdmin }, requisitante) {
  const loginLimpo = limparLogin(usuario);
  const nomeLimpo = limparNome(nome);

  const existente = buscarPorUsuario(loginLimpo);
  if (existente) throw new Error("já existe um usuário com esse login");

  if (isAdmin && (!requisitante || requisitante.nivel !== NIVEL_SUPERADMIN)) {
    throw new Error("apenas o superadministrador pode conceder privilégios de administrador");
  }

  validarSenha(senha);

  const nivel = isAdmin ? NIVEL_ADMIN : NIVEL_USUARIO;
  const senhaHash = bcrypt.hashSync(senha, 10);
  const info = db.prepare(`
    INSERT INTO usuarios (usuario, senhaHash, nome, isAdmin, nivel, podeControlar, ativo)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(loginLimpo, senhaHash, nomeLimpo, nivel >= NIVEL_ADMIN ? 1 : 0, nivel, podeControlar ? 1 : 0);

  logger.info("usuario-criado", { usuarioNovo: loginLimpo, nivel, por: requisitante ? requisitante.id : null });
  return paraSaida(buscarPorId(info.lastInsertRowid));
}

function atualizarPermissoes(id, { podeControlar, ativo, isAdmin }, requisitante) {
  const usuario = buscarPorId(id);
  if (!usuario) throw new Error("usuário não encontrado");
  if (usuario.nivel === NIVEL_SUPERADMIN) {
    throw new Error("não é possível alterar o nível do superadministrador");
  }

  if (usuario.nivel === NIVEL_ADMIN && (ativo !== undefined || podeControlar !== undefined)) {
    if (!requisitante || requisitante.nivel !== NIVEL_SUPERADMIN) {
      throw new Error("apenas o superadministrador pode alterar outro administrador");
    }
  }

  let novoNivel = usuario.nivel;
  if (isAdmin !== undefined) {
    const querAdmin = !!isAdmin;
    if (querAdmin && usuario.nivel === NIVEL_USUARIO) {
      if (!requisitante || requisitante.nivel !== NIVEL_SUPERADMIN) {
        throw new Error("apenas o superadministrador pode conceder privilégios de administrador");
      }
      novoNivel = NIVEL_ADMIN;
    } else if (!querAdmin && usuario.nivel === NIVEL_ADMIN) {
      if (!requisitante || requisitante.nivel !== NIVEL_SUPERADMIN) {
        throw new Error("apenas o superadministrador pode remover privilégios de administrador");
      }
      novoNivel = NIVEL_USUARIO;
    }
  }

  db.prepare(`
    UPDATE usuarios
    SET podeControlar = COALESCE(?, podeControlar),
        ativo = COALESCE(?, ativo),
        nivel = ?,
        isAdmin = ?
    WHERE id = ?
  `).run(
    podeControlar === undefined ? null : (podeControlar ? 1 : 0),
    ativo === undefined ? null : (ativo ? 1 : 0),
    novoNivel,
    novoNivel >= NIVEL_ADMIN ? 1 : 0,
    id
  );

  if (ativo === false) removerSessoesDoUsuario(id);

  logger.info("usuario-permissoes-alteradas", { alvo: id, podeControlar, ativo, isAdmin, por: requisitante ? requisitante.id : null });
  return paraSaida(buscarPorId(id));
}

function exigirPermissaoSobreAlvo(usuario, requisitante) {
  if (usuario.nivel === NIVEL_SUPERADMIN && (!requisitante || requisitante.nivel !== NIVEL_SUPERADMIN)) {
    throw new Error("apenas o superadministrador pode alterar este usuário");
  }
  if (
    usuario.nivel === NIVEL_ADMIN &&
    (!requisitante || (requisitante.id !== usuario.id && requisitante.nivel !== NIVEL_SUPERADMIN))
  ) {
    throw new Error("apenas o superadministrador pode alterar outro administrador");
  }
}

function trocarNome(id, novoNome, requisitante) {
  const usuario = buscarPorId(id);
  if (!usuario) throw new Error("usuário não encontrado");
  exigirPermissaoSobreAlvo(usuario, requisitante);

  const nomeLimpo = limparNome(novoNome);
  db.prepare(`UPDATE usuarios SET nome = ? WHERE id = ?`).run(nomeLimpo, id);
  return paraSaida(buscarPorId(id));
}

function trocarLogin(id, novoLogin, requisitante) {
  const usuario = buscarPorId(id);
  if (!usuario) throw new Error("usuário não encontrado");
  exigirPermissaoSobreAlvo(usuario, requisitante);

  const loginLimpo = limparLogin(novoLogin);
  const existente = buscarPorUsuario(loginLimpo);
  if (existente && existente.id !== id) throw new Error("já existe um usuário com esse login");

  db.prepare(`UPDATE usuarios SET usuario = ? WHERE id = ?`).run(loginLimpo, id);
  return paraSaida(buscarPorId(id));
}

function trocarSenha(id, novaSenha, requisitante) {
  const usuario = buscarPorId(id);
  if (!usuario) throw new Error("usuário não encontrado");
  exigirPermissaoSobreAlvo(usuario, requisitante);
  validarSenha(novaSenha);
  const senhaHash = bcrypt.hashSync(novaSenha, 10);
  db.prepare(`UPDATE usuarios SET senhaHash = ? WHERE id = ?`).run(senhaHash, id);
  removerSessoesDoUsuario(id);
  logger.info("usuario-senha-alterada", { alvo: id, por: requisitante ? requisitante.id : null });
}

function remover(id, requisitante) {
  const usuario = buscarPorId(id);
  if (!usuario) throw new Error("usuário não encontrado");
  if (usuario.nivel === NIVEL_SUPERADMIN) throw new Error("não é possível remover o superadministrador");
  exigirPermissaoSobreAlvo(usuario, requisitante);

  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM agendamentos_execucoes WHERE agendamentoId IN (SELECT id FROM agendamentos WHERE usuarioId = ?)`).run(id);
    db.prepare(`DELETE FROM agendamentos WHERE usuarioId = ?`).run(id);
    db.prepare(`DELETE FROM sala_donos WHERE usuarioId = ?`).run(id);
    db.prepare(`DELETE FROM sala_acessos WHERE usuarioId = ?`).run(id);
    db.prepare(`DELETE FROM sessoes WHERE usuarioId = ?`).run(id);
    db.prepare(`DELETE FROM usuarios WHERE id = ?`).run(id);
    db.exec("COMMIT");
  } catch (erro) {
    db.exec("ROLLBACK");
    throw erro;
  }
  logger.info("usuario-removido", { alvo: id, usuario: usuario.usuario, por: requisitante ? requisitante.id : null });
}

module.exports = {
  NIVEL_USUARIO,
  NIVEL_ADMIN,
  NIVEL_SUPERADMIN,
  SENHA_MIN,
  SENHA_MAX,
  listar,
  buscarPorUsuario,
  buscarPorId,
  criar,
  atualizarPermissoes,
  trocarNome,
  trocarLogin,
  trocarSenha,
  remover,
  paraSaida,
};
