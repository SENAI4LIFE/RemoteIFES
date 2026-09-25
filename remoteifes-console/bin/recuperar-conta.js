#!/usr/bin/env node
// Recovery of the application's superadministrator account.
//
// Deliberate differences from `reset-admin-senha.js`:
//   - the password arrives on **stdin**, never in argv. Process arguments appear in `ps`, in
//     `/proc/<pid>/cmdline` and in any command-line capture;
//   - there is no fallback to "admin": a recovery that installs a known default password trades an
//     access problem for a security problem;
//   - it states exactly what was invalidated: only the sessions of **that account**.
//
// The emergency path remains `npm run reset-admin` on the server, which works without the Console,
// without authentication and with the application stopped. This runner is the managed version.

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
    // The account is chosen by level, not by login name: the default login may have been renamed by
    // the operator.
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
