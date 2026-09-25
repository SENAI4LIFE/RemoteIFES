const crypto = require("crypto");
const config = require("./config");
const estado = require("./estado");

// The Console's own identity. It does not reuse the application's superadministrator: that
// authentication lives in SQLite, is invalidated on every managed restart
// (encerrarSessoesAtivasNoInicio) and disappears when the database breaks, exactly when the Console
// must work. Administering the application must also not grant root on the host.

const SCRYPT = { N: 16384, r: 8, p: 1, chaveBytes: 32, saltBytes: 16 };
const MIN_SENHA = 12;
const MAX_SENHA = 256;

function derivar(senha, salt) {
  return crypto.scryptSync(Buffer.from(String(senha), "utf8"), salt, SCRYPT.chaveBytes, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
}

function hashDeSenha(senha) {
  const salt = crypto.randomBytes(SCRYPT.saltBytes);
  const chave = derivar(senha, salt);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${chave.toString("base64")}`;
}

function conferirSenha(senha, guardado) {
  if (typeof guardado !== "string") return false;
  const partes = guardado.split("$");
  if (partes.length !== 6 || partes[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, chaveB64] = partes;
  let esperado;
  let calculado;
  try {
    esperado = Buffer.from(chaveB64, "base64");
    calculado = crypto.scryptSync(Buffer.from(String(senha), "utf8"), Buffer.from(saltB64, "base64"), esperado.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return esperado.length === calculado.length && crypto.timingSafeEqual(esperado, calculado);
}

function validarForcaDaSenha(senha) {
  if (typeof senha !== "string") return "senha ausente";
  if (senha.length < MIN_SENHA) return `a senha precisa de ao menos ${MIN_SENHA} caracteres`;
  if (senha.length > MAX_SENHA) return `a senha passa de ${MAX_SENHA} caracteres`;
  // The application's known bootstrap passwords are never valid Console credentials.
  if (["admin", "superadmin", "remoteifes", "senha", "password"].includes(senha.trim().toLowerCase())) {
    return "essa senha é um valor padrão conhecido; escolha outra";
  }
  return null;
}

// --- Operadores -------------------------------------------------------------------------

function lerOperadores() {
  const dados = estado.lerJson(config.ARQUIVO_OPERADORES, { operadores: [] });
  return Array.isArray(dados.operadores) ? dados : { operadores: [] };
}

function gravarOperadores(dados) {
  estado.gravarJson(config.ARQUIVO_OPERADORES, dados, 0o600);
}

function listarOperadores() {
  return lerOperadores().operadores.map((o) => ({
    nome: o.nome,
    criadoEm: o.criadoEm,
    trocaObrigatoria: !!o.trocaObrigatoria,
    ultimoAcesso: o.ultimoAcesso || null,
  }));
}

function existeOperador() {
  return lerOperadores().operadores.length > 0;
}

function criarOperador(nome, senha, { trocaObrigatoria = false } = {}) {
  if (!/^[a-z][a-z0-9._-]{2,31}$/.test(String(nome || ""))) {
    throw new Error("nome de operador inválido (3 a 32 caracteres: letras minúsculas, dígitos, ponto, hífen ou sublinhado)");
  }
  const problema = validarForcaDaSenha(senha);
  if (problema) throw new Error(problema);
  const dados = lerOperadores();
  if (dados.operadores.some((o) => o.nome === nome)) throw new Error("já existe um operador com esse nome");
  dados.operadores.push({
    nome,
    senhaHash: hashDeSenha(senha),
    criadoEm: new Date().toISOString(),
    trocaObrigatoria,
    ultimoAcesso: null,
  });
  gravarOperadores(dados);
  estado.auditar("operador-criado", { nome });
  return { nome };
}

function trocarSenha(nome, senhaAtual, novaSenha) {
  const dados = lerOperadores();
  const operador = dados.operadores.find((o) => o.nome === nome);
  if (!operador) throw new Error("operador não encontrado");
  if (!conferirSenha(senhaAtual, operador.senhaHash)) throw new Error("senha atual incorreta");
  const problema = validarForcaDaSenha(novaSenha);
  if (problema) throw new Error(problema);
  if (conferirSenha(novaSenha, operador.senhaHash)) throw new Error("a nova senha é igual à atual");
  operador.senhaHash = hashDeSenha(novaSenha);
  operador.trocaObrigatoria = false;
  gravarOperadores(dados);
  estado.auditar("operador-senha-trocada", { nome });
  // Changing the password ends the operator's other sessions, elevation and terminal included.
  revogarSessoesDoOperador(nome);
}

function autenticar(nome, senha) {
  const dados = lerOperadores();
  const operador = dados.operadores.find((o) => o.nome === nome);
  // Derives even without an operator so response time does not reveal whether an account exists.
  const referencia = operador ? operador.senhaHash : hashDeSenha(crypto.randomBytes(16).toString("hex"));
  const ok = conferirSenha(senha, referencia);
  if (!operador || !ok) return null;
  operador.ultimoAcesso = new Date().toISOString();
  gravarOperadores(dados);
  return { nome: operador.nome, trocaObrigatoria: !!operador.trocaObrigatoria };
}

// --- Sessions ----------------------------------------------------------------------------
// Persisted because the service exits on idle and returns through socket activation: an operator
// must not lose the session because the process hibernated. Writes happen on login, logout,
// elevation and purge, never on every request.

const COOKIE = "remoteifes_console";

function agora() {
  return Date.now();
}

function lerSessoes() {
  const dados = estado.lerJson(config.ARQUIVO_SESSOES, { sessoes: {} });
  return dados && typeof dados.sessoes === "object" && dados.sessoes !== null ? dados : { sessoes: {} };
}

function gravarSessoes(dados) {
  estado.gravarJson(config.ARQUIVO_SESSOES, dados, 0o600);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function expirada(sessao, instante = agora()) {
  if (!sessao) return true;
  if (instante >= sessao.expiraEm) return true;
  if (instante - sessao.vistaEm > config.SESSAO_OCIOSA_S * 1000) return true;
  return false;
}

function expurgar(dados, instante = agora()) {
  let mudou = false;
  for (const [id, sessao] of Object.entries(dados.sessoes)) {
    if (expirada(sessao, instante)) {
      delete dados.sessoes[id];
      mudou = true;
    }
  }
  return mudou;
}

function criarSessao(nome, { origem = null } = {}) {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(32).toString("base64url");
  const instante = agora();
  const dados = lerSessoes();
  expurgar(dados, instante);
  dados.sessoes[hashToken(token)] = {
    operador: nome,
    criadaEm: instante,
    vistaEm: instante,
    expiraEm: instante + config.SESSAO_MAX_S * 1000,
    csrf,
    elevadaAte: 0,
    origem,
  };
  gravarSessoes(dados);
  estado.auditar("sessao-iniciada", { operador: nome, origem });
  return { token, csrf };
}

// Activity tracking kept in memory only: writing "vistaEm" on every request would wear the SD card
// for no gain. The disk keeps the value of the last relevant event.
const vistaEmMemoria = new Map();

function validarSessao(token) {
  if (!token || typeof token !== "string") return null;
  const id = hashToken(token);
  const dados = lerSessoes();
  const sessao = dados.sessoes[id];
  if (!sessao) return null;
  const instante = agora();
  const visto = Math.max(sessao.vistaEm, vistaEmMemoria.get(id) || 0);
  if (expirada({ ...sessao, vistaEm: visto }, instante)) {
    delete dados.sessoes[id];
    vistaEmMemoria.delete(id);
    gravarSessoes(dados);
    return null;
  }
  vistaEmMemoria.set(id, instante);
  const elevadaAte = sessao.elevadaAte || 0;
  return {
    id,
    operador: sessao.operador,
    csrf: sessao.csrf,
    criadaEm: sessao.criadaEm,
    expiraEm: sessao.expiraEm,
    elevada: elevadaAte > instante,
    elevadaAte,
    restanteElevacaoS: elevadaAte > instante ? Math.round((elevadaAte - instante) / 1000) : 0,
  };
}

function elevar(token, senha) {
  const sessao = validarSessao(token);
  if (!sessao) return { ok: false, erro: "sessão inválida" };
  const operador = autenticar(sessao.operador, senha);
  if (!operador) return { ok: false, erro: "senha incorreta" };
  const dados = lerSessoes();
  const registro = dados.sessoes[sessao.id];
  if (!registro) return { ok: false, erro: "sessão inválida" };
  registro.elevadaAte = agora() + config.ELEVACAO_S * 1000;
  registro.vistaEm = agora();
  gravarSessoes(dados);
  estado.auditar("elevacao-concedida", { operador: sessao.operador, segundos: config.ELEVACAO_S });
  return { ok: true, expiraEmS: config.ELEVACAO_S };
}

function encerrarElevacao(token) {
  const sessao = validarSessao(token);
  if (!sessao) return;
  const dados = lerSessoes();
  if (dados.sessoes[sessao.id]) {
    dados.sessoes[sessao.id].elevadaAte = 0;
    gravarSessoes(dados);
    estado.auditar("elevacao-encerrada", { operador: sessao.operador });
  }
}

function revogarSessao(token) {
  if (!token) return;
  const id = hashToken(token);
  const dados = lerSessoes();
  const sessao = dados.sessoes[id];
  if (sessao) {
    delete dados.sessoes[id];
    vistaEmMemoria.delete(id);
    gravarSessoes(dados);
    estado.auditar("sessao-encerrada", { operador: sessao.operador });
  }
}

function revogarSessoesDoOperador(nome) {
  const dados = lerSessoes();
  let mudou = false;
  for (const [id, sessao] of Object.entries(dados.sessoes)) {
    if (sessao.operador === nome) {
      delete dados.sessoes[id];
      vistaEmMemoria.delete(id);
      mudou = true;
    }
  }
  if (mudou) {
    gravarSessoes(dados);
    estado.auditar("sessoes-revogadas", { operador: nome });
  }
  return mudou;
}

function sessoesAtivas() {
  const dados = lerSessoes();
  const instante = agora();
  return Object.entries(dados.sessoes)
    .filter(([id, s]) => !expirada({ ...s, vistaEm: Math.max(s.vistaEm, vistaEmMemoria.get(id) || 0) }, instante))
    .map(([id, s]) => ({
      id: id.slice(0, 12),
      operador: s.operador,
      criadaEm: new Date(s.criadaEm).toISOString(),
      elevada: (s.elevadaAte || 0) > instante,
    }));
}

// --- Attempt limiting ----------------------------------------------------------------
// In memory on purpose: the process is ephemeral, and an attacker who restarts the service to reset
// the counter would already need host access. Counts per operator and per origin.

const tentativas = new Map();
const JANELA_MS = 15 * 60 * 1000;
const MAX_POR_CHAVE = 8;

function chaveDeTentativa(chave) {
  const registro = tentativas.get(chave);
  const instante = agora();
  if (!registro || instante - registro.inicio > JANELA_MS) {
    const novo = { inicio: instante, contagem: 0 };
    tentativas.set(chave, novo);
    return novo;
  }
  return registro;
}

function bloqueado(chave) {
  const registro = chaveDeTentativa(chave);
  if (registro.contagem < MAX_POR_CHAVE) return 0;
  return Math.ceil((JANELA_MS - (agora() - registro.inicio)) / 1000);
}

function registrarFalha(chave) {
  chaveDeTentativa(chave).contagem += 1;
}

function limparTentativas(chave) {
  tentativas.delete(chave);
}

function limparTudoParaTeste() {
  tentativas.clear();
  vistaEmMemoria.clear();
}

module.exports = {
  COOKIE,
  MIN_SENHA,
  hashDeSenha,
  conferirSenha,
  validarForcaDaSenha,
  listarOperadores,
  existeOperador,
  criarOperador,
  trocarSenha,
  autenticar,
  criarSessao,
  validarSessao,
  elevar,
  encerrarElevacao,
  revogarSessao,
  revogarSessoesDoOperador,
  sessoesAtivas,
  bloqueado,
  registrarFalha,
  limparTentativas,
  limparTudoParaTeste,
};
