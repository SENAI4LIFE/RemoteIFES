const DIAS_ORDEM = [1, 2, 3, 4, 5, 6, 0];
const gradeSalaSelect = document.getElementById("gradeSala");

// Períodos de aula: 50 minutos cada, de 07:00 até 22:10.
// Intervalos de 10, 20 ou 30 minutos entre as aulas (30 min às 12:30 - almoço).
const PERIODOS = [
  { inicio: "07:00", fim: "07:50" },
  { inicio: "08:10", fim: "09:00" },
  { inicio: "09:20", fim: "10:10" },
  { inicio: "10:30", fim: "11:20" },
  { inicio: "11:40", fim: "12:30" }, // intervalo de 30min (almoço) 12:30–13:00
  { inicio: "13:00", fim: "13:50" },
  { inicio: "14:00", fim: "14:50" },
  { inicio: "15:00", fim: "15:50" },
  { inicio: "16:00", fim: "16:50" },
  { inicio: "17:00", fim: "17:50" }, // intervalo de 20min 17:50–18:10
  { inicio: "18:10", fim: "19:00" },
  { inicio: "19:10", fim: "20:00" },
  { inicio: "20:10", fim: "21:00" }, // intervalo de 20min 21:00–21:20
  { inicio: "21:20", fim: "22:10" },
];

function periodoCoberto(periodo, inicio, fim) {
  return periodo.inicio >= inicio && periodo.inicio < fim;
}

const Grade = {
  async aoAbrir() {
    if (gradeSalaSelect.dataset.carregado !== "1") {
      const salas = await Api.listarSalas();
      gradeSalaSelect.innerHTML = salas
        .map((s) => `<option value="${s.sala}">${s.sala} — ${s.nome}</option>`)
        .join("");
      gradeSalaSelect.dataset.carregado = "1";
    }
    await this.renderizar();
  },

  async renderizar() {
    const sala = gradeSalaSelect.value;
    if (!sala) return;

    const agendamentos = (await Api.listarAgendamentos(sala)).filter((a) => a.ativo);
    const tabela = document.getElementById("gradeTabela");

    let html = "<thead><tr><th>Horário</th>";
    DIAS_ORDEM.forEach((d) => (html += `<th>${DIA_NOME[d]}</th>`));
    html += "</tr></thead><tbody>";

    PERIODOS.forEach((periodo) => {
      html += `<tr><td class="grade-hora">${periodo.inicio}–${periodo.fim}</td>`;
      DIAS_ORDEM.forEach((dia) => {
        const ag = agendamentos.find(
          (a) => a.diasSemana.includes(dia) && periodoCoberto(periodo, a.horaInicio, a.horaFim)
        );
        if (!ag) {
          html += `<td class="grade-cell grade-cell-desligado"></td>`;
          return;
        }
        const ligando = ag.modo === "ligar_completo"
          || (ag.modo === "ligar_intervalo" && periodoCoberto(periodo, ag.ligarInicio, ag.ligarFim));
        const classe = ligando ? "grade-cell grade-cell-ligado" : "grade-cell grade-cell-agendado";
        html += `<td class="${classe}" title="${ag.usuarioNome} · ${ag.horaInicio}–${ag.horaFim}">${ag.usuarioNome}</td>`;
      });
      html += "</tr>";
    });

    html += "</tbody>";
    tabela.innerHTML = html;
  },
};

gradeSalaSelect.addEventListener("change", () => Grade.renderizar());
