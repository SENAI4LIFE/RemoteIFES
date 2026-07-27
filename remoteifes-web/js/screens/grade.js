const DIAS_ORDEM = [1, 2, 3, 4, 5, 6, 0];
const gradeSalaSelect = document.getElementById("gradeSala");

const GRADE_INICIO_MIN = 6 * 60 + 20;
const GRADE_FIM_MIN = 22 * 60 + 20;

function gerarFaixasHorario() {
  const faixas = [];
  for (let min = GRADE_INICIO_MIN; min < GRADE_FIM_MIN; min += 30) {
    const h = String(Math.floor(min / 60)).padStart(2, "0");
    const m = String(min % 60).padStart(2, "0");
    faixas.push(`${h}:${m}`);
  }
  return faixas;
}

function faixaCoberta(faixa, inicio, fim) {
  return faixa >= inicio && faixa < fim;
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
    const faixas = gerarFaixasHorario();
    const tabela = document.getElementById("gradeTabela");

    let html = "<thead><tr><th>Horário</th>";
    DIAS_ORDEM.forEach((d) => (html += `<th>${DIA_NOME[d]}</th>`));
    html += "</tr></thead><tbody>";

    faixas.forEach((faixa) => {
      html += `<tr><td class="grade-hora">${faixa}</td>`;
      DIAS_ORDEM.forEach((dia) => {
        const ag = agendamentos.find(
          (a) => a.diasSemana.includes(dia) && faixaCoberta(faixa, a.horaInicio, a.horaFim)
        );
        if (!ag) {
          html += `<td class="grade-cell grade-cell-desligado"></td>`;
          return;
        }
        const ligando = ag.modo === "ligar_completo"
          || (ag.modo === "ligar_intervalo" && faixaCoberta(faixa, ag.ligarInicio, ag.ligarFim));
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
