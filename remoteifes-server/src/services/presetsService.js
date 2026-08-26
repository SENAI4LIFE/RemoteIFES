const db = require("../config/database");

const TIPOS_VALIDOS = ["numero", "booleano", "selecao"];
const PRESET_PADRAO_NOME = "Padrão";

const POSICOES_VALIDAS = [
  "flank_esq",
  "flank_dir",
  "fan",
  "grid_topo_1",
  "grid_topo_2",
  "grid_topo_3",
  "grid_base_1",
  "grid_base_2",
  "grid_base_3",
  "grid_base_4",
  "grid_base_5",
  "grid_base_6",
];

function paraSaidaFuncao(f) {
  return {
    id: f.id,
    chave: f.chave,
    rotulo: f.rotulo,
    tipo: f.tipo,
    opcoes: f.opcoes ? JSON.parse(f.opcoes) : null,
    ordem: f.ordem,
    posicao: f.posicao || null,
  };
}

function funcoesDoPreset(presetId) {
  return db
    .prepare(`SELECT * FROM preset_funcoes WHERE presetId = ? ORDER BY ordem, id`)
    .all(presetId)
    .map(paraSaidaFuncao);
}

function paraSaidaPreset(p) {
  return {
    id: p.id,
    nome: p.nome,
    padrao: !!p.padrao,
    criadoEm: p.criadoEm,
    funcoes: funcoesDoPreset(p.id),
  };
}

function listar() {
  return db.prepare(`SELECT * FROM presets ORDER BY padrao DESC, nome`).all().map(paraSaidaPreset);
}

function buscarPorId(id) {
  const p = db.prepare(`SELECT * FROM presets WHERE id = ?`).get(id);
  return p ? paraSaidaPreset(p) : null;
}

function buscarPorNome(nome) {
  return db.prepare(`SELECT * FROM presets WHERE nome = ?`).get(nome);
}

function criar({ nome }) {
  if (!nome || !nome.trim()) throw new Error("informe o nome do preset");
  const existente = buscarPorNome(nome.trim());
  if (existente) throw new Error("já existe um preset com esse nome");

  const info = db.prepare(`INSERT INTO presets (nome, padrao) VALUES (?, 0)`).run(nome.trim());
  return buscarPorId(info.lastInsertRowid);
}

function remover(id) {
  const preset = db.prepare(`SELECT * FROM presets WHERE id = ?`).get(id);
  if (!preset) throw new Error("preset não encontrado");
  if (preset.padrao) throw new Error("não é possível remover o preset padrão");

  db.exec("BEGIN");
  try {
    db.prepare(`UPDATE salas SET presetId = NULL WHERE presetId = ?`).run(id);
    db.prepare(`DELETE FROM preset_funcoes WHERE presetId = ?`).run(id);
    db.prepare(`DELETE FROM presets WHERE id = ?`).run(id);
    db.exec("COMMIT");
  } catch (erro) {
    db.exec("ROLLBACK");
    throw erro;
  }
}

function validarPosicao(posicao) {
  if (posicao === undefined) return undefined;
  if (posicao === null || posicao === "") return null;
  if (!POSICOES_VALIDAS.includes(posicao)) throw new Error("posição inválida no controle");
  return posicao;
}

function validarFuncao({ chave, rotulo, tipo, opcoes }) {
  if (!chave || !/^[a-z0-9_]+$/.test(chave)) {
    throw new Error("chave da função deve conter apenas letras minúsculas, números e underscore");
  }
  if (!rotulo || !rotulo.trim()) throw new Error("informe o rótulo da função");
  const tipoFinal = tipo && TIPOS_VALIDOS.includes(tipo) ? tipo : "numero";
  return { chave, rotulo: rotulo.trim(), tipo: tipoFinal, opcoes: opcoes ?? null };
}

function garantirPosicaoLivre(presetId, posicao, ignorarFuncaoId) {
  if (!posicao) return;
  const ocupante = db.prepare(`SELECT id FROM preset_funcoes WHERE presetId = ? AND posicao = ?`).get(presetId, posicao);
  if (ocupante && ocupante.id !== ignorarFuncaoId) {
    throw new Error("já existe uma função nessa posição do controle");
  }
}

function adicionarFuncao(presetId, dados) {
  const preset = db.prepare(`SELECT * FROM presets WHERE id = ?`).get(presetId);
  if (!preset) throw new Error("preset não encontrado");

  const { chave, rotulo, tipo, opcoes } = validarFuncao(dados);
  const jaExiste = db.prepare(`SELECT 1 FROM preset_funcoes WHERE presetId = ? AND chave = ?`).get(presetId, chave);
  if (jaExiste) throw new Error("este preset já possui uma função com essa chave");

  const posicao = validarPosicao(dados.posicao) || null;
  garantirPosicaoLivre(presetId, posicao, null);

  const ordem = Number.isFinite(Number(dados.ordem)) ? Number(dados.ordem) : 0;
  db.prepare(`
    INSERT INTO preset_funcoes (presetId, chave, rotulo, tipo, opcoes, ordem, posicao)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(presetId, chave, rotulo, tipo, opcoes ? JSON.stringify(opcoes) : null, ordem, posicao);

  return buscarPorId(presetId);
}

function atualizarFuncao(funcaoId, dados) {
  const funcao = db.prepare(`SELECT * FROM preset_funcoes WHERE id = ?`).get(funcaoId);
  if (!funcao) throw new Error("função não encontrada");

  const opcoesAtuais = funcao.opcoes ? JSON.parse(funcao.opcoes) : null;
  const { rotulo, tipo, opcoes } = validarFuncao({ ...funcao, opcoes: opcoesAtuais, ...dados, chave: funcao.chave });
  const ordem = dados.ordem !== undefined && Number.isFinite(Number(dados.ordem)) ? Number(dados.ordem) : funcao.ordem;

  const posicaoInformada = validarPosicao(dados.posicao);
  const posicao = posicaoInformada !== undefined ? posicaoInformada : funcao.posicao;
  garantirPosicaoLivre(funcao.presetId, posicao, funcao.id);

  db.prepare(`
    UPDATE preset_funcoes SET rotulo = ?, tipo = ?, opcoes = ?, ordem = ?, posicao = ? WHERE id = ?
  `).run(rotulo, tipo, opcoes ? JSON.stringify(opcoes) : null, ordem, posicao, funcaoId);

  return buscarPorId(funcao.presetId);
}

function removerFuncao(funcaoId) {
  const funcao = db.prepare(`SELECT * FROM preset_funcoes WHERE id = ?`).get(funcaoId);
  if (!funcao) throw new Error("função não encontrada");
  if (funcao.chave === "temperatura") throw new Error("a função de temperatura não pode ser removida do preset");

  db.prepare(`DELETE FROM preset_funcoes WHERE id = ?`).run(funcaoId);
  return buscarPorId(funcao.presetId);
}

function sincronizarPresetDaSala({ presetIdAtual, nome, funcoes }) {
  if (!nome || !nome.trim()) throw new Error("informe o nome do preset");
  if (!Array.isArray(funcoes) || funcoes.length === 0) throw new Error("informe ao menos uma função");

  const existente = presetIdAtual ? db.prepare(`SELECT * FROM presets WHERE id = ?`).get(presetIdAtual) : null;
  let presetId;
  if (existente && !existente.padrao) {
    presetId = existente.id;
    const colisao = buscarPorNome(nome.trim());
    if (!colisao || colisao.id === presetId) {
      db.prepare(`UPDATE presets SET nome = ? WHERE id = ?`).run(nome.trim(), presetId);
    }
  } else {
    let nomeFinal = nome.trim();
    let sufixo = 2;
    while (buscarPorNome(nomeFinal)) {
      nomeFinal = `${nome.trim()} (${sufixo})`;
      sufixo += 1;
    }
    const info = db.prepare(`INSERT INTO presets (nome, padrao) VALUES (?, 0)`).run(nomeFinal);
    presetId = info.lastInsertRowid;
  }

  for (const f of funcoes) {
    const { chave, rotulo, tipo, opcoes } = validarFuncao(f);
    const funcaoExistente = db.prepare(`SELECT id FROM preset_funcoes WHERE presetId = ? AND chave = ?`).get(presetId, chave);
    if (funcaoExistente) {
      db.prepare(`UPDATE preset_funcoes SET rotulo = ?, tipo = ?, opcoes = ? WHERE id = ?`)
        .run(rotulo, tipo, opcoes ? JSON.stringify(opcoes) : null, funcaoExistente.id);
    } else {
      db.prepare(`INSERT INTO preset_funcoes (presetId, chave, rotulo, tipo, opcoes, ordem) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(presetId, chave, rotulo, tipo, opcoes ? JSON.stringify(opcoes) : null, f.ordem || 0);
    }
  }

  return buscarPorId(presetId);
}

function seedPresetPadrao(limitesTemperatura) {
  let preset = buscarPorNome(PRESET_PADRAO_NOME);
  if (!preset) {
    const info = db.prepare(`INSERT INTO presets (nome, padrao) VALUES (?, 1)`).run(PRESET_PADRAO_NOME);
    preset = { id: info.lastInsertRowid };
  }

  const temFuncaoTemperatura = db
    .prepare(`SELECT 1 FROM preset_funcoes WHERE presetId = ? AND chave = 'temperatura'`)
    .get(preset.id);

  if (!temFuncaoTemperatura) {
    db.prepare(`
      INSERT INTO preset_funcoes (presetId, chave, rotulo, tipo, opcoes, ordem)
      VALUES (?, 'temperatura', 'Temperatura', 'numero', ?, 0)
    `).run(preset.id, JSON.stringify(limitesTemperatura));
  }

  return buscarPorId(preset.id);
}

function presetPadrao() {
  const p = db.prepare(`SELECT * FROM presets WHERE padrao = 1 LIMIT 1`).get();
  return p ? paraSaidaPreset(p) : null;
}

module.exports = {
  listar,
  buscarPorId,
  criar,
  remover,
  adicionarFuncao,
  atualizarFuncao,
  removerFuncao,
  sincronizarPresetDaSala,
  seedPresetPadrao,
  presetPadrao,
  POSICOES_VALIDAS,
};
