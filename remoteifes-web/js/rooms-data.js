function escapeHtml(texto) {
  return String(texto == null ? "" : texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const RoomsData = {
  rotulo(sala) {
    const valor = String(sala ?? "");
    const internaBlocoB2 = valor.match(/^B20(\d{1,2})$/);
    if (internaBlocoB2) return `B${internaBlocoB2[1].padStart(2, "0")}`;
    return valor;
  },
};
