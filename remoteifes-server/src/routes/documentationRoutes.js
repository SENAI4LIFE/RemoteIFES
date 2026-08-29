const express = require("express");
const { exigirLogin } = require("../middlewares/auth");
const documentationService = require("../services/documentationService");

const router = express.Router();

router.get("/documentation", exigirLogin, (req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.json({ ok: true, ...documentationService.para(req.usuario) });
});

module.exports = router;
