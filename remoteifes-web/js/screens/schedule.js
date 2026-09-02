const MODO_NOME = {
  reserva: "apenas reserva",
  ligar_completo: "liga no período todo",
  ligar_intervalo: "liga em intervalo",
};

const agendaSalaSelect = document.getElementById("agendaSala");
const agendaIntervaloRow = document.getElementById("agendaIntervaloRow");

const agendaDataInput = document.getElementById("agendaData");

// Cada leitura da lista recebe um número de ordem e uma remoção confirmada fica anotada
// com o número da leitura vigente: uma resposta emitida antes da remoção ainda traz o
// agendamento apagado e não pode repintá-lo na tela como se ele continuasse existindo.
let agendaLeituraAtual = 0;
let agendaLeiturasPendentes = 0;
const agendaRemovidos = new Map();

const Schedule = {
  async aoAbrir() {
    agendaDataInput.value = Tempo.dataAtualBrasiliaISO().split("-").reverse().join("/");
    await this.carregarSalas();
    await this.atualizarLimitesTemperatura();
    await this.carregarAgendamentos();
  },

  async carregarSalas() {
    if (agendaSalaSelect.dataset.carregado === "1") return;

    const salas = await Api.listarSalas();
    agendaSalaSelect.innerHTML = salas
      .map((s) => `<option value="${escapeHtml(s.sala)}">${escapeHtml(RoomsData.rotulo(s.sala))}: ${escapeHtml(s.nome)}</option>`)
      .join("");
    agendaSalaSelect.dataset.carregado = "1";
  },

  async atualizarLimitesTemperatura() {
    if (!agendaSalaSelect.value) return;
    const status = await Api.statusSala(agendaSalaSelect.value);
    const minima = Number(status.temperaturaMinima);
    const maxima = Number(status.temperaturaMaxima);
    if (!Number.isFinite(minima) || !Number.isFinite(maxima)) return;
    const input = document.getElementById("agendaTemperatura");
    input.min = String(minima);
    input.max = String(maxima);
    const atual = Number(input.value);
    if (!Number.isFinite(atual) || atual < minima || atual > maxima) input.value = String(minima);
    document.getElementById("agendaTemperaturaLimites").textContent = `Limite efetivo desta sala: ${minima} °C a ${maxima} °C.`;
  },

  async carregarAgendamentos() {
    const sala = agendaSalaSelect.value;
    if (!sala) return;

    const list = document.getElementById("agendaList");
    const empty = document.getElementById("agendaEmpty");
    list.innerHTML = "";

    const leitura = (agendaLeituraAtual += 1);
    agendaLeiturasPendentes += 1;
    let agendamentos;
    try {
      agendamentos = await Api.listarAgendamentos(sala);
    } finally {
      agendaLeiturasPendentes -= 1;
    }
    if (leitura !== agendaLeituraAtual) return;
    for (const [id, marca] of agendaRemovidos) if (leitura > marca) agendaRemovidos.delete(id);
    const visiveis = agendamentos.filter((a) => !agendaRemovidos.has(a.id));

    if (visiveis.length === 0) {
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    visiveis.forEach((a) => {
      const souDono = a.usuarioLogin === state.usuario;
      const podeGerenciar = souDono || state.isAdmin;
      const detalheModo = a.modo === "ligar_intervalo"
        ? `${MODO_NOME[a.modo]} (${escapeHtml(a.ligarInicio)}–${escapeHtml(a.ligarFim)})`
        : MODO_NOME[a.modo] || MODO_NOME.ligar_completo;
      const dataFormatada = escapeHtml(String(a.data).split("-").reverse().join("/"));

      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <div class="room-name">${escapeHtml(RoomsData.rotulo(a.sala))} · ${dataFormatada} · ${escapeHtml(a.horaInicio)}–${escapeHtml(a.horaFim)}</div>
          <div class="room-sub">${escapeHtml(String(a.temperatura))}°C · ${detalheModo} · por ${escapeHtml(a.usuarioNome)}${souDono ? " (você)" : ""}</div>
        </div>
        <div class="agenda-actions">
          ${podeGerenciar ? `<button type="button" class="link-btn agenda-toggle">${a.ativo ? "desativar" : "ativar"}</button>` : ""}
          ${podeGerenciar ? `<button type="button" class="link-btn agenda-remover">remover</button>` : `<span class="hint">somente leitura</span>`}
        </div>
      `;
      if (podeGerenciar) {
        li.querySelector(".agenda-toggle").addEventListener("click", async () => {
          await Api.alternarAgendamento(a.id, !a.ativo);
          await this.carregarAgendamentos();
        });
        li.querySelector(".agenda-remover").addEventListener("click", async () => {
          const resp = await Api.removerAgendamento(a.id);
          if (!resp || resp.ok !== true) {
            Toast.erro((resp && resp.erro) || "não foi possível remover o agendamento");
            return;
          }
          // A linha sai na hora: aguardar uma releitura completa deixava na tela um
          // agendamento que o servidor já apagou, e ainda podia trazê-lo de volta.
          agendaRemovidos.set(a.id, agendaLeituraAtual);
          li.remove();
          if (!list.children.length && !agendaLeiturasPendentes) empty.classList.remove("hidden");
        });
      }
      list.appendChild(li);
    });
  },
};

agendaSalaSelect.addEventListener("change", async () => {
  if (typeof Router !== "undefined") Router.sync();
  await Schedule.atualizarLimitesTemperatura();
  await Schedule.carregarAgendamentos();
});

document.querySelectorAll('input[name="agendaModo"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    agendaIntervaloRow.classList.toggle("hidden", radio.value !== "ligar_intervalo" || !radio.checked);
  });
});

document.getElementById("criarAgendaBtn").addEventListener("click", async () => {
  const modo = document.querySelector('input[name="agendaModo"]:checked').value;
  const data = Tempo.dataAtualBrasiliaISO();

  const dados = {
    sala: agendaSalaSelect.value,
    data,
    horaInicio: document.getElementById("agendaHoraInicio").value,
    horaFim: document.getElementById("agendaHoraFim").value,
    temperatura: Number(document.getElementById("agendaTemperatura").value),
    modo,
    ligarInicio: modo === "ligar_intervalo" ? document.getElementById("agendaLigarInicio").value : undefined,
    ligarFim: modo === "ligar_intervalo" ? document.getElementById("agendaLigarFim").value : undefined,
  };

  const resp = await Api.criarAgendamento(dados);
  if (!resp.ok) {
    Toast.erro(resp.erro || "não foi possível criar o agendamento");
    return;
  }

  await Schedule.carregarAgendamentos();
});
