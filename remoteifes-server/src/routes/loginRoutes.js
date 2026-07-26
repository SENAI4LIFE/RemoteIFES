const express = require("express");
const bcrypt = require("bcryptjs");
const usuariosService = require("../services/usuariosService");
const { gerarToken } = require("../services/tokenService");

const router = express.Router();

router.post("/login", (req, res) => {
  const { usuario, senha } = req.body;

  if (!usuario || !senha) {
    return res.status(400).json({ ok: false, erro: "usuário e senha são obrigatórios" });
  }

  const registro = usuariosService.buscarPorUsuario(usuario);
  if (!registro || !registro.ativo || !bcrypt.compareSync(senha, registro.senhaHash)) {
    return res.status(401).json({ ok: false, erro: "usuário ou senha inválidos" });
  }

  const token = gerarToken(registro.id);

  res.json({
    ok: true,
    token,
    nome: registro.nome,
    usuario: registro.usuario,
    isAdmin: !!registro.isAdmin,
    podeControlar: !!registro.podeControlar,
    podeAgendar: !!registro.podeAgendar,
  });
});

module.exports = router;
