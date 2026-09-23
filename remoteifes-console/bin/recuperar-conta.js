#!/usr/bin/env node
// Recuperação da conta de superadministrador da aplicação.
//
// Diferenças deliberadas em relação a `reset-admin-senha.js`:
//   - a senha chega por **stdin**, nunca por argv. Argumento de processo aparece em `ps`,
//     em `/proc/<pid>/cmdline` e em qualquer captura de linha de comando;
//   - não existe fallback para "admin": uma recuperação que instala uma senha padrão
//     conhecida troca um problema de acesso por um problema de segurança;
//   - diz com precisão o que foi invalidado: apenas as sessões **daquela conta**.
//
// O caminho de emergência continua sendo `npm run reset-admin` no servidor, que funciona sem
// console, sem autenticação e com a aplicação parada. Este runner é a versão gerenciada.

const fs = require("fs");
const path = require("path");

const raizConsole = path.join(__dirname, "..");
const config = require(path.join(raizConsole, "src", "config"));

function lerStdin() {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    let total = 0;
    process.stdin.on("data", (d) => {
      total += d.length;
      if (total > 4096) {
        reject(new Error("entrada grande demais"));
        process.stdin.destroy();
        return;
      }
      pedacos.push(d);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(pedacos).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const app = config.caminhosDaAplicacao();

  if (!fs.existsSync(app.banco)) {
    console.error(`Banco não encontrado em ${app.banco}.`);
    console.error("Sem banco não há conta a recuperar: inicie o RemoteIFES uma vez para criá-lo.");
    return 1;
  }

  const bruto = await lerStdin();
  const senha = bruto.replace(/\r?\n$/, "");
  if (senha.length < 8 || senha.length > 128) {
    console.error("A senha precisa ter entre 8 e 128 caracteres.");
    return 2;
  }
  if (["admin", "superadmin", "senha", "password"].includes(senha.toLowerCase())) {
    console.error("Essa senha é um valor padrão conhecido; escolha outra.");
    return 2;
  }

  let bcrypt;
  try {
    bcrypt = require(path.join(config.DIR_SERVIDOR, "node_modules", "bcryptjs"));
  } catch (erro) {
    console.error("bcryptjs não está instalado no servidor; rode 'npm ci --omit=dev' em remoteifes-server.");
    return 1;
  }

  const { DatabaseSync } = require("node:sqlite");
  let db;
  try {
    db = new DatabaseSync(app.banco);
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (erro) {
    console.error(`Não foi possível abrir o banco: ${erro.message}`);
    return 1;
  }

  try {
    // A conta é escolhida pelo nível, não pelo nome de login: o login padrão mudou de "admin"
    // para "superadmin" e pode ter sido renomeado pelo operador.
    const conta =
      db.prepare("SELECT id, usuario FROM usuarios WHERE nivel = 3 ORDER BY id LIMIT 1").get() ||
      db.prepare("SELECT id, usuario FROM usuarios WHERE usuario = 'superadmin'").get() ||
      db.prepare("SELECT id, usuario FROM usuarios WHERE usuario = 'admin'").get();

    if (!conta) {
      console.error("Nenhuma conta de superadministrador encontrada neste banco.");
      console.error("Inicie o RemoteIFES uma vez (npm start) para que ela seja criada.");
      return 1;
    }

    const hash = bcrypt.hashSync(senha, 10);
    db.prepare("UPDATE usuarios SET senhaHash = ? WHERE id = ?").run(hash, conta.id);
    const sessoes = db.prepare("UPDATE sessoes SET logout = datetime('now') WHERE usuarioId = ? AND logout IS NULL").run(conta.id);

    console.log(`Senha redefinida para a conta "${conta.usuario}" (nível 3).`);
    console.log(`Sessões encerradas desta conta: ${sessoes.changes}.`);
    console.log("As sessões das demais contas continuam válidas; um reinício do serviço encerraria todas.");
    console.log(`CONSOLE_RESULTADO ${JSON.stringify({ usuario: conta.usuario, sessoesEncerradas: sessoes.changes })}`);
    return 0;
  } catch (erro) {
    console.error(`Falha ao redefinir a senha: ${erro.message}`);
    return 1;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

main()
  .then((codigo) => {
    process.exitCode = codigo;
  })
  .catch((erro) => {
    console.error(`Erro inesperado: ${erro && erro.message ? erro.message : erro}`);
    process.exitCode = 1;
  });
