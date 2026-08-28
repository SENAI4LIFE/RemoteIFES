const db = require("./src/config/database");
const { criarSchema } = require("./src/db/schema");
const configuracoesService = require("./src/services/configuracoesService");

criarSchema();

const REQUISITANTE = { id: "cli:redes-autorizadas", nivel: 3 };

function fecharBanco() {
  try {
    db.close();
  } catch {}
}

function faixaValida(faixa) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(faixa);
  if (!m) return false;
  const octetos = m.slice(1, 5).map(Number);
  const prefixo = Number(m[5]);
  return octetos.every((o) => o >= 0 && o <= 255) && prefixo >= 0 && prefixo <= 32;
}

function estadoAtual() {
  const { modoTeste, redesAutorizadas } = configuracoesService.acessoRestritoAtivo();
  return { modoTeste, redesAutorizadas: redesAutorizadas || [] };
}

function aplicar(lista) {
  const invalidas = lista.filter((f) => !faixaValida(f));
  if (invalidas.length) {
    console.error(`Faixa(s) de IP inválida(s): ${invalidas.join(", ")}`);
    console.error("Use a notação CIDR, ex.: 10.10.0.0/16 ou 192.168.1.0/24");
    fecharBanco();
    process.exit(1);
  }
  const unicas = [...new Set(lista.map((f) => f.trim()))];
  configuracoesService.validarEAtualizar({ redesAutorizadas: unicas }, REQUISITANTE);
  console.log(`Redes autorizadas: ${unicas.length ? unicas.join(", ") : "(nenhuma)"}`);
  if (!unicas.length) {
    console.log("Com a lista vazia e modo de teste desligado, o acesso em produção fica bloqueado (exceto /dispositivo e localhost via túnel).");
  }
}

const args = process.argv.slice(2);
const atual = estadoAtual();

if (args.length === 0) {
  console.log(`Modo de teste: ${atual.modoTeste ? "ligado (restrição desativada)" : "desligado"}`);
  console.log(`Redes autorizadas: ${atual.redesAutorizadas.length ? atual.redesAutorizadas.join(", ") : "(nenhuma)"}`);
  console.log("");
  console.log("Uso:");
  console.log("  node redes-autorizadas.js <cidr> [<cidr> ...]   define a lista (substitui)");
  console.log("  node redes-autorizadas.js --add <cidr>          adiciona uma faixa");
  console.log("  node redes-autorizadas.js --clear               esvazia a lista");
  fecharBanco();
  process.exit(0);
}

try {
  if (args[0] === "--clear") {
    aplicar([]);
  } else if (args[0] === "--add") {
    const novas = args.slice(1);
    if (!novas.length) throw new Error("informe ao menos uma faixa CIDR após --add");
    aplicar([...atual.redesAutorizadas, ...novas]);
  } else {
    aplicar(args);
  }
  fecharBanco();
  process.exit(0);
} catch (erro) {
  console.error(`Falha ao atualizar as redes autorizadas: ${erro.message}`);
  fecharBanco();
  process.exit(1);
}
