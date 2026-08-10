const DIA_NOME = {
  0: "Dom",
  1: "Seg",
  2: "Ter",
  3: "Qua",
  4: "Qui",
  5: "Sex",
  6: "Sáb",
};

const MODO_NOME = {
  reserva: "apenas reserva",
  ligar_completo: "liga no período todo",
  ligar_intervalo: "liga em intervalo",
};

const agendaSalaSelect = document.getElementById("agendaSala");
const agendaIntervaloRow = document.getElementById("agendaIntervaloRow");
const agendaDataUnicaRow = document.getElementById("agendaDataUnicaRow");
const agendaDiasWrapper = document.getElementById("agendaDias");

let agendaRepeticaoSelecionada = "semanal";

const Schedule = {
  async aoAbrir() {
    await this.carregarSalas();
    await this.carregarAgendamentos();
  },

  async carregarSalas() {
    if (agendaSalaSelect.dataset.carregado === "1") return;

    const salas = await Api.listarSalas();
    agendaSalaSelect.innerHTML = salas
      .map((s) => `<option value="${s.sala}">${s.sala} — ${s.nome}</option>`)
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
      const dias = a.diasSemana.map((d) => DIA_NOME[d]).join(", ");
      const souDono = a.usuarioLogin === state.usuario;
      const podeGerenciar = souDono || state.isAdmin;
      const detalheModo = a.modo === "ligar_intervalo"
        ? `${MODO_NOME[a.modo]} (${a.ligarInicio}–${a.ligarFim})`
        : MODO_NOME[a.modo] || MODO_NOME.ligar_completo;
      const detalheRepeticao = a.repeticao === "unica"
        ? `somente em ${a.dataUnica ? a.dataUnica.split("-").reverse().join("/") : "?"}`
        : "toda semana";

      const li = document.createElement("li");
      li.innerHTML = `
        <div>
          <div class="room-name">${a.sala} · ${a.horaInicio}–${a.horaFim}</div>
          <div class="room-sub">${dias} · ${detalheRepeticao} · ${a.temperatura}°C · ${detalheModo} · por ${a.usuarioNome}${souDono ? " (você)" : ""}</div>
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

document.querySelectorAll("#agendaDias .choice-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const dia = Number(btn.dataset.dia);
    const indice = state.agendaDiasSelecionados.indexOf(dia);
    if (indice === -1) {
      state.agendaDiasSelecionados.push(dia);
      btn.classList.add("active");
    } else {
      state.agendaDiasSelecionados.splice(indice, 1);
      btn.classList.remove("active");
    }
  });
});

document.querySelectorAll('input[name="agendaModo"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    agendaIntervaloRow.classList.toggle("hidden", radio.value !== "ligar_intervalo" || !radio.checked);
  });
});

document.querySelectorAll('[data-repeticao]').forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll('[data-repeticao]').forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    agendaRepeticaoSelecionada = btn.dataset.repeticao;

    const ehUnica = agendaRepeticaoSelecionada === "unica";
    agendaDataUnicaRow.classList.toggle("hidden", !ehUnica);
    agendaDiasWrapper.classList.toggle("hidden", ehUnica);
  });
});

document.getElementById("criarAgendaBtn").addEventListener("click", async () => {
  const errorEl = document.getElementById("agendaError");
  errorEl.classList.add("hidden");

  const modo = document.querySelector('input[name="agendaModo"]:checked').value;

  const dados = {
    sala: agendaSalaSelect.value,
    horaInicio: document.getElementById("agendaHoraInicio").value,
    horaFim: document.getElementById("agendaHoraFim").value,
    temperatura: Number(document.getElementById("agendaTemperatura").value),
    modo,
    ligarInicio: modo === "ligar_intervalo" ? document.getElementById("agendaLigarInicio").value : undefined,
    ligarFim: modo === "ligar_intervalo" ? document.getElementById("agendaLigarFim").value : undefined,
    repeticao: agendaRepeticaoSelecionada,
  };

  if (agendaRepeticaoSelecionada === "unica") {
    dados.dataUnica = document.getElementById("agendaDataUnica").value;
    if (!dados.dataUnica) {
      errorEl.textContent = "selecione a data do agendamento";
      errorEl.classList.remove("hidden");
      return;
    }
  } else {
    dados.diasSemana = state.agendaDiasSelecionados;
    if (dados.diasSemana.length === 0) {
      errorEl.textContent = "selecione ao menos um dia da semana";
      errorEl.classList.remove("hidden");
      return;
    }
  }

  const resp = await Api.criarAgendamento(dados);
  if (!resp.ok) {
    errorEl.textContent = resp.erro || "não foi possível criar o agendamento";
    errorEl.classList.remove("hidden");
    return;
  }

  document.querySelectorAll("#agendaDias .choice-btn").forEach((btn) => btn.classList.remove("active"));
  state.agendaDiasSelecionados = [];
  document.getElementById("agendaDataUnica").value = "";
  await Schedule.carregarAgendamentos();
});
