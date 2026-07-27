const db = require("../config/database");

const PADROES = {
  timeoutInatividadeMinutos: null,
  timeoutInatividadeMinutosSugestao: 15,
  adminSujeitoTimeout: false,
  popupAvisoSegundos: 60,
  limiarOnlineMinutos: 5,
};

const CHAVES_NUMERICAS_ANULAVEIS = ["timeoutInatividadeMinutos"];
const CHAVES_NUMERICAS = ["popupAvisoSegundos", "limiarOnlineMinutos"];
const CHAVES_BOOLEANAS = ["adminSujeitoTimeout"];

function obter() {
  const linhas = db.prepare(`SELECT chave, valor FROM configuracoes`).all();
  const armazenado = {};
  for (const { chave, valor } of linhas) {
    armazenado[chave] = valor === null ? null : JSON.parse(valor);
  }
  return { ...PADROES, ...armazenado };
}

function timeoutEfetivoParaUsuario(isAdmin) {
  const cfg = obter();
  if (!cfg.timeoutInatividadeMinutos) return null;
  if (isAdmin && !cfg.adminSujeitoTimeout) return null;
  return cfg.timeoutInatividadeMinutos;
}

function validarEAtualizar(patch) {
  const atual = obter();
  const proximo = { ...atual };

  if (Object.prototype.hasOwnProperty.call(patch, "timeoutInatividadeMinutos")) {
    const v = patch.timeoutInatividadeMinutos;
    if (v === null || v === "" || v === undefined) {
      proximo.timeoutInatividadeMinutos = null;
    } else {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error("tempo de inatividade deve ser um número de minutos maior que zero (ou vazio para indefinido)");
      }
      proximo.timeoutInatividadeMinutos = n;
    }
  }

  for (const chave of CHAVES_NUMERICAS) {
    if (Object.prototype.hasOwnProperty.call(patch, chave)) {
      const n = Number(patch[chave]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`${chave} deve ser um número maior que zero`);
      }
      proximo[chave] = n;
    }
  }

  for (const chave of CHAVES_BOOLEANAS) {
    if (Object.prototype.hasOwnProperty.call(patch, chave)) {
      proximo[chave] = !!patch[chave];
    }
  }

  const gravar = db.prepare(
    `INSERT INTO configuracoes (chave, valor) VALUES (?, ?)
     ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`
  );

  const chavesArmazenaveis = [...CHAVES_NUMERICAS_ANULAVEIS, ...CHAVES_NUMERICAS, ...CHAVES_BOOLEANAS];
  for (const chave of chavesArmazenaveis) {
    gravar.run(chave, JSON.stringify(proximo[chave]));
  }

  return obter();
}

module.exports = { obter, validarEAtualizar, timeoutEfetivoParaUsuario, PADROES };
