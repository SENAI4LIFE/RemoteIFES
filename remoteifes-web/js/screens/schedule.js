const MODO_NOME = {
  reserva: "apenas reserva",
  ligar_completo: "liga no período todo",
  ligar_intervalo: "liga em intervalo",
};

const agendaSalaSelect = document.getElementById("agendaSala");
const agendaIntervaloRow = document.getElementById("agendaIntervaloRow");

const agendaDataInput = document.getElementById("agendaData");

const Schedule = {
  async aoAbrir() {
    agendaDataInput.value = Tempo.dataAtualBrasiliaISO().split("-").reverse().join("/");
    await this.carregarSalas();
    await this.carregarAgendamentos();
  },

  async carregarSalas() {
    if (agendaSalaSelect.dataset.carregado === "1") return;

    const salas = await Api.listarSalas();
    agendaSalaSelect.innerHTML = salas
      .map((s) => `<option value="${s.sala}">${RoomsData.rotulo(s.sala)} — ${s.nome}</option>`)
      .join("");
    agendaSalaSelect.dataset.carregado = "1";
  },

  async carregarAgendamentos() {
    const sala = agendaSalaSelect.value;
    if (!sala) return;

    const list = document.getElementById("agendaList");
    const empty = document.getElementById("agendaEmpty");
    list.innerHTML = "";

    const agendamentos = await Api.listarAgendamentos(sala);
    if (agendamentos.length === 0) {
      empty.classList.remove("hidden");
      return;
    }
    empty.classList.add("hidden");

    agendamentos.forEach((a) => {
      const souDono = a.usuarioLogin === state.usuario;
      const podeGerenciar = souDono || state.isAdmin;
      const detalheModo = a.modo === "ligar_intervalo"
        ? `${MODO_NOME[a.modo]} (${a.ligarInicio}–${a.ligarFim})`
        : MODO_NOME[a.modo] || MODO_NOME.ligar_completo;
      const dataFormatada = a.data.split("-").reverse().join("/");

      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <div class="room-name">${RoomsData.rotulo(a.sala)} · ${dataFormatada} · ${a.horaInicio}–${a.horaFim}</div>
          <div class="room-sub">${a.temperatura}°C · ${detalheModo} · por ${a.usuarioNome}${souDono ? " (você)" : ""}</div>
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
          await Api.removerAgendamento(a.id);
          await this.carregarAgendamentos();
        });
      }
      list.appendChild(li);
    });
  },
};

agendaSalaSelect.addEventListener("change", () => Schedule.carregarAgendamentos());

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
