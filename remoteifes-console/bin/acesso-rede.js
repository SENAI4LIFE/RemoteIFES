#!/usr/bin/env node
// Changes the application's network access policy: test mode and the authorized IPv4 ranges.
//
// These settings decide who reaches the website at all, so the website no longer edits them: a
// wrong range saved from a browser locks that browser out, and only the host could undo it. The
// Console runs as its own local service, outside the application's network restriction, which keeps
// the recovery path open.
//
// Input arrives on stdin as JSON ({ operador, modoTeste, redesAutorizadas }). Both keys and the audit
// event are written in one IMMEDIATE transaction, so a crash leaves either the old policy or the new
// one, never half of it. The application reads the policy on every request: no restart is needed.

const fs = require("fs");
const path = require("path");

const raizConsole = path.join(__dirname, "..");
const config = require(path.join(raizConsole, "src", "config"));

const LIMITE_ENTRADA = 16 * 1024;
const LIMITE_FAIXAS = 64;

function lerStdin() {
  return new Promise((resolve, reject) => {
    const pedacos = [];
    let total = 0;
    process.stdin.on("data", (d) => {
      total += d.length;
      if (total > LIMITE_ENTRADA) {
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

// Same grammar as the application's range checker (src/utils/rede.js) and its terminal CLI
// (redes-autorizadas.js): IPv4 in CIDR notation only.
function faixaValida(faixa) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(faixa);
  if (!m) return false;
  const octetos = m.slice(1, 5).map(Number);
  const prefixo = Number(m[5]);
  return octetos.every((o) => o >= 0 && o <= 255) && prefixo >= 0 && prefixo <= 32;
}

function validarPedido(bruto) {
  let pedido;
  try {
    pedido = JSON.parse(bruto);
  } catch {
    throw new Error("entrada inválida: JSON esperado");
  }
  if (!pedido || typeof pedido !== "object") throw new Error("entrada inválida");
  if (typeof pedido.modoTeste !== "boolean") throw new Error("modoTeste deve ser booleano");
  if (!Array.isArray(pedido.redesAutorizadas) || !pedido.redesAutorizadas.every((f) => typeof f === "string")) {
    throw new Error("redesAutorizadas deve ser uma lista de faixas");
  }
  const redes = [...new Set(pedido.redesAutorizadas.map((f) => f.trim()).filter(Boolean))];
  const invalidas = redes.filter((f) => !faixaValida(f));
  if (invalidas.length) {
    throw new Error(`faixa(s) de IP inválida(s): ${invalidas.join(", ")}. Use a notação CIDR IPv4, ex.: 10.10.0.0/16`);
  }
  if (redes.length > LIMITE_FAIXAS) throw new Error(`no máximo ${LIMITE_FAIXAS} faixas`);
  const operador = typeof pedido.operador === "string" ? pedido.operador.replace(/[^\w.@-]/g, "").slice(0, 48) : "";
  return { modoTeste: pedido.modoTeste, redesAutorizadas: redes, operador: operador || "operador" };
}

function lerValor(db, chave) {
  const linha = db.prepare("SELECT valor FROM configuracoes WHERE chave = ?").get(chave);
  if (!linha || typeof linha.valor !== "string") return undefined;
  try {
    return JSON.parse(linha.valor);
  } catch {
    return undefined;
  }
}

async function main() {
  const app = config.caminhosDaAplicacao();
  if (!fs.existsSync(app.banco)) {
    console.error(`Banco não encontrado em ${app.banco}.`);
    console.error("Inicie o RemoteIFES uma vez para criá-lo; a política de acesso fica guardada nele.");
    return 1;
  }

  let pedido;
  try {
    pedido = validarPedido(await lerStdin());
  } catch (erro) {
    console.error(`Pedido recusado: ${erro.message}`);
    return 2;
  }

  const { DatabaseSync } = require("node:sqlite");
  let db;
  try {
    db = new DatabaseSync(app.banco);
    db.exec("PRAGMA busy_timeout = 10000");
  } catch (erro) {
    console.error(`Não foi possível abrir o banco: ${erro.message}`);
    return 1;
  }

  try {
    const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('configuracoes', 'auditoria_eventos')").all();
    if (tabelas.length < 2) {
      console.error("O banco ainda não tem o esquema da aplicação: inicie o RemoteIFES uma vez antes de configurar o acesso.");
      return 1;
    }

    db.exec("BEGIN IMMEDIATE");
    let alterados;
    try {
      const antes = { modoTeste: lerValor(db, "modoTeste"), redesAutorizadas: lerValor(db, "redesAutorizadas") };
      alterados = ["modoTeste", "redesAutorizadas"].filter((chave) => JSON.stringify(antes[chave]) !== JSON.stringify(pedido[chave]));
      const gravar = db.prepare(
        "INSERT INTO configuracoes (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor"
      );
      gravar.run("modoTeste", JSON.stringify(pedido.modoTeste));
      gravar.run("redesAutorizadas", JSON.stringify(pedido.redesAutorizadas));
      if (alterados.length) {
        db.prepare(
          `INSERT INTO auditoria_eventos (tipo, atorId, atorLogin, alvoTipo, alvoId, alvoRotulo, descricao, camposAlterados)
           VALUES ('configuracao_alterada', NULL, ?, 'configuracao', 'global', 'Configuracoes globais', ?, ?)`
        ).run(
          `console:${pedido.operador}`,
          `Acesso de rede alterado pelo Console de Operações: ${alterados.join(", ")}`,
          alterados.join(",")
        );
      }
      db.exec("COMMIT");
    } catch (erro) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw erro;
    }

    console.log(`Modo de teste: ${pedido.modoTeste ? "ligado (restrição de rede desativada)" : "desligado"}`);
    console.log(`Redes autorizadas: ${pedido.redesAutorizadas.length ? pedido.redesAutorizadas.join(", ") : "(nenhuma)"}`);
    if (!pedido.modoTeste && !pedido.redesAutorizadas.length) {
      console.log(
        "Atenção: com o modo de teste desligado e nenhuma faixa, a aplicação em produção só atende localhost e /dispositivo. " +
          "Este console continua acessível para desfazer."
      );
    }
    console.log(alterados.length ? `Alterado: ${alterados.join(", ")}. Vale a partir da próxima requisição.` : "Nada mudou: os valores já eram esses.");
    console.log(`CONSOLE_RESULTADO ${JSON.stringify({ alterados, modoTeste: pedido.modoTeste, redesAutorizadas: pedido.redesAutorizadas })}`);
    return 0;
  } catch (erro) {
    console.error(`Falha ao gravar a política de acesso: ${erro.message}`);
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
