const RoomsData = {
  montarCodigo(bloco, andar, numero) {
    return `${bloco}${andar}0${numero}`;
  },

  rotulo(sala) {
    const valor = String(sala ?? "");
    const internaBlocoB2 = valor.match(/^B20(\d{1,2})$/);
    if (internaBlocoB2) return `B${internaBlocoB2[1].padStart(2, "0")}`;
    return valor;
  },
};
