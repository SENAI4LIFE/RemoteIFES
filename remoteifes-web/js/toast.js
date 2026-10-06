const Toast = (() => {
  const PERMANENCIA_MS = {
    erro: { normal: 6000, minima: 4000 },
    aviso: { normal: 8000, minima: 3000 },
  };
  const LEITURA_MS_POR_CARACTERE = 50;
  const ESPERA_POR_VAGA = 3;

  let pilha = null;
  const visiveis = [];
  const fila = [];
  const estadosAtivos = new Map();

  function obterPilha() {
    if (!pilha) {
      pilha = document.createElement("div");
      pilha.className = "toast-stack";
      pilha.setAttribute("aria-live", "polite");
      document.body.appendChild(pilha);
      window.addEventListener("resize", acomodar);
    }
    return pilha;
  }

  function limiteVisivel() {
    if (window.innerHeight <= 600) return 1;
    if (window.innerWidth <= 520 || window.innerHeight <= 800) return 2;
    return 3;
  }

  function excedeAltura() {
    return visiveis.length > 1 && pilha.scrollHeight > pilha.clientHeight;
  }

  function permanenciaMinima(entrada) {
    const { normal, minima } = PERMANENCIA_MS[entrada.tipo];
    return Math.min(normal, Math.max(minima, entrada.texto.length * LEITURA_MS_POR_CARACTERE));
  }

  function agendar(entrada) {
    clearTimeout(entrada.timer);
    const { normal } = PERMANENCIA_MS[entrada.tipo];
    const prazo = fila.length
      ? Math.min(entrada.renovadoEm + permanenciaMinima(entrada), entrada.exibidoEm + normal)
      : entrada.renovadoEm + normal;
    entrada.timer = setTimeout(() => dispensar(entrada), Math.max(0, prazo - performance.now()));
  }

  function exibir(entrada) {
    entrada.exibidoEm = entrada.renovadoEm = performance.now();
    visiveis.push(entrada);
    pilha.appendChild(entrada.el);
  }

  function devolverUltimaAFila() {
    const entrada = visiveis.pop();
    clearTimeout(entrada.timer);
    entrada.el.remove();
    fila.unshift(entrada);
  }

  function acomodar() {
    const limite = limiteVisivel();
    while (visiveis.length > limite || excedeAltura()) devolverUltimaAFila();
    while (fila.length && visiveis.length < limite) {
      exibir(fila.shift());
      if (excedeAltura()) {
        devolverUltimaAFila();
        break;
      }
    }
    visiveis.forEach(agendar);
  }

  function enfileirar(entrada) {
    fila.push(entrada);
    if (fila.length <= limiteVisivel() * ESPERA_POR_VAGA) return;
    const maisAntigaDescartavel = fila.findIndex((e) => e.descartavel);
    if (maisAntigaDescartavel >= 0) fila.splice(maisAntigaDescartavel, 1);
  }

  function dispensar(entrada) {
    const indice = visiveis.indexOf(entrada);
    if (indice < 0) return;
    visiveis.splice(indice, 1);
    clearTimeout(entrada.timer);
    entrada.el.remove();
    acomodar();
  }

  function criarEntrada(texto, tipo, descartavel) {
    const el = document.createElement("p");
    el.className = `toast toast-${tipo}`;
    el.setAttribute("aria-atomic", "true");
    el.textContent = texto;
    const entrada = { tipo, texto, el, descartavel, contador: 1, elContador: null, exibidoEm: 0, renovadoEm: 0, timer: null };
    el.addEventListener("click", () => dispensar(entrada));
    return entrada;
  }

  function registrarRepeticao(entrada) {
    entrada.contador += 1;
    entrada.renovadoEm = performance.now();
    if (!entrada.elContador) {
      entrada.elContador = document.createElement("span");
      entrada.elContador.className = "toast-contador";
      entrada.el.append(" ", entrada.elContador);
    }
    entrada.elContador.textContent = `${entrada.contador}×`;
  }

  function mostrar(texto, tipo, descartavel = true) {
    if (!texto) return null;
    const mensagem = String(texto);
    obterPilha();
    let entrada = visiveis.concat(fila).find((e) => e.tipo === tipo && e.texto === mensagem);
    if (entrada) {
      registrarRepeticao(entrada);
    } else {
      entrada = criarEntrada(mensagem, tipo, descartavel);
      enfileirar(entrada);
    }
    acomodar();
    return entrada.el;
  }

  function erro(texto) {
    return mostrar(texto, "erro");
  }

  function aviso(texto) {
    return mostrar(texto, "aviso");
  }

  function criarAvisoDeEstado(chave, texto) {
    return function aplicar(ativo) {
      const jaAtivo = estadosAtivos.get(chave) || false;
      if (ativo && !jaAtivo) {
        mostrar(texto, "aviso", false);
      }
      estadosAtivos.set(chave, !!ativo);
    };
  }

  return { erro, aviso, criarAvisoDeEstado };
})();
