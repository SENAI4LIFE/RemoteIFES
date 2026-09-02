/*
 * Registro público do manual. Os módulos em js/manual/ acrescentam seções por
 * domínio; conteúdo administrativo continua sendo entregue apenas pela API.
 */
const ManualContent = (() => {
  const secoes = [];
  const categorias = {
    comecar: { titulo: "Começar", ordem: 10 },
    salas: { titulo: "Salas e controle", ordem: 20 },
    conta: { titulo: "Conta, plataformas e suporte", ordem: 30 },
    admin_operacao: { titulo: "Administração · operação", ordem: 40 },
    admin_historicos: { titulo: "Administração · acompanhamento", ordem: 50 },
    super_dispositivos: { titulo: "Superadmin · ESP32", ordem: 60 },
    super_seguranca: { titulo: "Superadmin · segurança e configuração", ordem: 70 },
    super_infra: { titulo: "Superadmin · infraestrutura e releases", ordem: 80 },
  };

  function registrar(novas) {
    for (const secao of novas || []) {
      if (!secao || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(secao.id || "")) {
        throw new Error("seção do manual sem ID estável");
      }
      if (secoes.some((existente) => existente.id === secao.id)) {
        throw new Error(`ID duplicado no manual: ${secao.id}`);
      }
      secoes.push({ categoria: "comecar", papel: "todos", ...secao });
    }
  }

  return { secoes, categorias, registrar };
})();
