// Atualizações em tempo real (WebSocket, consultas periódicas) só devem mexer no que mudou: o
// elemento de cada item continua o mesmo nó do DOM, na mesma posição, com o foco, a rolagem e o
// estado de interação preservados. Só uma mudança estrutural de verdade (item novo ou removido)
// altera o layout.
const UISync = (() => {
  // Reconcilia os filhos de `container` (os que casam com `seletor`, identificados por
  // data-<atributo>) com `itens`. Elementos existentes são atualizados no lugar e nunca movidos,
  // mesmo que a lista chegue em outra ordem; elementos novos entram logo após o item anterior da
  // lista recebida; os ausentes saem. Devolve true quando a estrutura mudou.
  function sincronizarLista(container, itens, { seletor, chave, atributo = "sala", criar, atualizar }) {
    const existentes = new Map();
    container.querySelectorAll(seletor).forEach((el) => existentes.set(el.dataset[atributo], el));
    let anterior = null;
    let mudouEstrutura = false;
    (itens || []).forEach((item) => {
      const k = String(chave(item));
      let el = existentes.get(k);
      if (el) {
        existentes.delete(k);
      } else {
        el = criar(item);
        el.dataset[atributo] = k;
        if (anterior) anterior.after(el);
        else container.prepend(el);
        mudouEstrutura = true;
      }
      atualizar(el, item);
      anterior = el;
    });
    existentes.forEach((el) => {
      el.remove();
      mudouEstrutura = true;
    });
    return mudouEstrutura;
  }

  function reconciliarAtributos(atual, novo) {
    Array.from(novo.attributes).forEach(({ name, value }) => {
      if (atual.getAttribute(name) !== value) atual.setAttribute(name, value);
    });
    Array.from(atual.attributes).forEach(({ name }) => {
      if (!novo.hasAttribute(name)) atual.removeAttribute(name);
    });
  }

  function reconciliarFilhos(alvo, fonte) {
    const atuais = Array.from(alvo.childNodes);
    const novos = Array.from(fonte.childNodes);
    novos.forEach((novo, i) => {
      const atual = atuais[i];
      if (!atual) {
        alvo.appendChild(novo);
        return;
      }
      const mesmoTipo = atual.nodeType === novo.nodeType
        && (novo.nodeType !== Node.ELEMENT_NODE || atual.tagName === novo.tagName);
      if (!mesmoTipo) {
        alvo.replaceChild(novo, atual);
        return;
      }
      if (novo.nodeType === Node.ELEMENT_NODE) {
        reconciliarAtributos(atual, novo);
        reconciliarFilhos(atual, novo);
      } else if (atual.data !== novo.data) {
        atual.data = novo.data;
      }
    });
    for (let i = novos.length; i < atuais.length; i += 1) atuais[i].remove();
  }

  // Deixa o conteúdo de `el` igual ao HTML dado sem reconstruí-lo: nós de mesma posição e tipo são
  // mantidos e só textos e atributos diferentes são tocados. Substitui `el.innerHTML = html` nos
  // caminhos de atualização periódica.
  function aplicarHtml(el, html) {
    const modelo = document.createElement("template");
    modelo.innerHTML = html;
    reconciliarFilhos(el, modelo.content);
  }

  return { sincronizarLista, aplicarHtml };
})();
