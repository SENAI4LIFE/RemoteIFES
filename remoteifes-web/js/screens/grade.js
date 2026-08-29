const gradeSalaSelect = document.getElementById("gradeSala");
const gradeDataInput = document.getElementById("gradeData");

const PERIODOS = [
  { inicio: "07:00", fim: "07:50" },
  { inicio: "08:10", fim: "09:00" },
  { inicio: "09:20", fim: "10:10" },
  { inicio: "10:30", fim: "11:20" },
  { inicio: "11:40", fim: "12:30" },
  { inicio: "13:00", fim: "13:50" },
  { inicio: "14:00", fim: "14:50" },
  { inicio: "15:00", fim: "15:50" },
  { inicio: "16:00", fim: "16:50" },
  { inicio: "17:00", fim: "17:50" },
  { inicio: "18:10", fim: "19:00" },
  { inicio: "19:10", fim: "20:00" },
  { inicio: "20:10", fim: "21:00" },
  { inicio: "21:20", fim: "22:10" },
];

function periodoCoberto(periodo, inicio, fim) {
  return periodo.inicio >= inicio && periodo.inicio < fim;
}

function hojeISO() {
  const agora = new Date();
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, "0")}-${String(agora.getDate()).padStart(2, "0")}`;
}

const Grade = {
  async aoAbrir() {
    if (gradeSalaSelect.dataset.carregado !== "1") {
      const salas = await Api.listarSalas();
      gradeSalaSelect.innerHTML = salas
        .map((s) => `<option value="${escapeHtml(s.sala)}">${escapeHtml(RoomsData.rotulo(s.sala))} — ${escapeHtml(s.nome)}</option>`)
        .join("");
      gradeSalaSelect.dataset.carregado = "1";
    }
    if (!gradeDataInput.value) gradeDataInput.value = hojeISO();
    await this.renderizar();
  },

  async renderizar() {
    const sala = gradeSalaSelect.value;
    const data = gradeDataInput.value;
    if (!sala || !data) return;

    const agendamentos = (await Api.listarAgendamentos(sala)).filter((a) => a.ativo && a.data === data);
    const tabela = document.getElementById("gradeTabela");

    let html = `<thead><tr><th>Horário</th><th>${data.split("-").reverse().join("/")}</th></tr></thead><tbody>`;

    PERIODOS.forEach((periodo) => {
      const ag = agendamentos.find((a) => periodoCoberto(periodo, a.horaInicio, a.horaFim));
      if (!ag) {
        html += `<tr><td class="grade-hora">${periodo.inicio}–${periodo.fim}</td><td class="grade-cell grade-cell-desligado"></td></tr>`;
        return;
      }
      const ligando = ag.modo === "ligar_completo"
        || (ag.modo === "ligar_intervalo" && periodoCoberto(periodo, ag.ligarInicio, ag.ligarFim));
      const classe = ligando ? "grade-cell grade-cell-ligado" : "grade-cell grade-cell-agendado";
      const nomeEscapado = escapeHtml(ag.usuarioNome);
      const janelaEscapada = `${escapeHtml(ag.horaInicio)}–${escapeHtml(ag.horaFim)}`;
      html += `<tr><td class="grade-hora">${periodo.inicio}–${periodo.fim}</td><td class="${classe}" title="${nomeEscapado} · ${janelaEscapada}">${nomeEscapado}</td></tr>`;
    });

    html += "</tbody>";
    tabela.innerHTML = html;
  },
};

function _gradeSync() {
  if (typeof Router !== "undefined") Router.sync();
}
gradeSalaSelect.addEventListener("change", () => {
  Grade.renderizar();
  _gradeSync();
});
gradeDataInput.addEventListener("change", () => {
  Grade.renderizar();
  _gradeSync();
});
