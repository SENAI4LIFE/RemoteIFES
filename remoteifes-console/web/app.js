/* Console de Operações RemoteIFES — interface.
 *
 * Regra de renderização: nada vindo do servidor, do Git, do journal ou do sistema de arquivos
 * entra por innerHTML. Tudo é inserido com textContent ou por nós criados aqui. Mensagem de
 * commit, nome de arquivo e linha de log são conteúdo hostil por definição.
 */
(function () {
  "use strict";

  var estadoApp = { csrf: null, operador: null, elevada: false, area: "visao", painel: null, atualizacao: null, fluxo: null };

  // --- utilidades -------------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }

  function limpar(no) { while (no.firstChild) no.removeChild(no.firstChild); }

  function el(tag, texto, classe) {
    var n = document.createElement(tag);
    if (texto !== undefined && texto !== null) n.textContent = String(texto);
    if (classe) n.className = classe;
    return n;
  }

  function dado(dl, rotulo, valor, classe) {
    var div = el("div", null, "dado");
    div.appendChild(el("dt", rotulo));
    var dd = el("dd", valor === null || valor === undefined || valor === "" ? "desconhecido" : valor, classe);
    if (valor === null || valor === undefined || valor === "") dd.classList.add("fraco");
    div.appendChild(dd);
    dl.appendChild(div);
    return dd;
  }

  function aviso(container, nivel, titulo, texto) {
    var div = el("div", null, "aviso " + nivel);
    div.appendChild(el("strong", titulo));
    div.appendChild(document.createTextNode(texto || ""));
    container.appendChild(div);
    return div;
  }

  function selo(no, classe, texto) {
    no.className = "estado " + classe;
    no.textContent = texto;
  }

  function bytes(n) {
    if (n === null || n === undefined || !isFinite(n)) return null;
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KiB";
    if (n < 1073741824) return (n / 1048576).toFixed(1) + " MiB";
    return (n / 1073741824).toFixed(2) + " GiB";
  }

  function duracao(s) {
    if (s === null || s === undefined || !isFinite(s)) return null;
    if (s < 60) return Math.round(s) + " s";
    if (s < 3600) return Math.round(s / 60) + " min";
    if (s < 86400) return (s / 3600).toFixed(1) + " h";
    return (s / 86400).toFixed(1) + " dias";
  }

  function quando(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString("pt-BR");
  }

  function curto(commit) { return commit ? String(commit).slice(0, 8) : null; }

  // --- rede ---------------------------------------------------------------------------------

  function api(caminho, opcoes) {
    opcoes = opcoes || {};
    var cfg = { method: opcoes.method || "GET", headers: {}, credentials: "same-origin" };
    if (opcoes.corpo !== undefined) {
      cfg.headers["Content-Type"] = "application/json";
      cfg.body = JSON.stringify(opcoes.corpo);
    }
    if (cfg.method !== "GET" && cfg.method !== "HEAD" && estadoApp.csrf) {
      cfg.headers["X-Console-CSRF"] = estadoApp.csrf;
    }
    return fetch(caminho, cfg).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (corpo) {
        if (r.status === 401 && estadoApp.operador) { mostrarLogin("Sua sessão expirou. Entre novamente."); }
        return { status: r.status, ok: r.ok, corpo: corpo };
      });
    });
  }

  // --- entrada ------------------------------------------------------------------------------

  function mostrarLogin(mensagem) {
    estadoApp.operador = null;
    estadoApp.csrf = null;
    $("telaConsole").classList.add("oculto");
    $("telaLogin").classList.remove("oculto");
    var caixa = $("loginAviso");
    limpar(caixa);
    caixa.classList.add("oculto");
    if (mensagem) { caixa.classList.remove("oculto"); aviso(caixa, "alerta", "Atenção", mensagem); }
    api("/api/sessao").then(function (r) {
      if (r.corpo && r.corpo.precisaBootstrap) {
        $("formLogin").classList.add("oculto");
        $("formBootstrap").classList.remove("oculto");
        $("loginTitulo").textContent = "Primeiro acesso ao console";
      } else {
        $("formLogin").classList.remove("oculto");
        $("formBootstrap").classList.add("oculto");
        $("loginNome").focus();
      }
    });
  }

  function entrarNoConsole(sessao) {
    estadoApp.operador = sessao.operador;
    estadoApp.csrf = sessao.csrf;
    estadoApp.elevada = !!sessao.elevada;
    $("telaLogin").classList.add("oculto");
    $("telaConsole").classList.remove("oculto");
    $("seloOperador").textContent = sessao.operador;
    atualizarSeloElevacao(sessao.restanteElevacaoS || 0);
    trocarArea(estadoApp.area);
    carregarPainel();
    carregarTrabalhos();
    mostrarLinkDaAplicacao();
  }

  /**
   * O atalho para o RemoteIFES sai do endereço que a aplicação realmente publica, não de uma
   * porta presumida. Abre em outra aba: o console não enquadra a aplicação nem é enquadrado.
   */
  function mostrarLinkDaAplicacao() {
    api("/api/programa").then(function (r) {
      if (!r.ok || !r.corpo.aplicacao || !r.corpo.aplicacao.url) return;
      var a = $("linkAplicacao");
      a.href = r.corpo.aplicacao.url;
      a.hidden = false;
    });
  }

  function atualizarSeloElevacao(restante) {
    var s = $("seloElevacao");
    if (estadoApp.elevada && restante > 0) {
      s.classList.remove("oculto");
      s.textContent = "elevado · " + Math.ceil(restante / 60) + " min";
    } else {
      s.classList.add("oculto");
    }
  }

  // --- abas ----------------------------------------------------------------------------------

  var AREAS = ["visao", "servico", "atualizacao", "programa", "dados", "mobile", "rede", "avancado"];

  function trocarArea(area) {
    estadoApp.area = area;
    AREAS.forEach(function (a) {
      var aba = $("aba-" + a);
      var painel = $("painel-" + a);
      var ativo = a === area;
      aba.setAttribute("aria-selected", ativo ? "true" : "false");
      aba.tabIndex = ativo ? 0 : -1;
      painel.classList.toggle("oculto", !ativo);
    });
    if (area === "atualizacao") carregarAtualizacao();
    if (area === "programa") carregarPrograma();
    if (area === "dados") carregarDados();
    if (area === "mobile") carregarMobile();
    if (area === "avancado") carregarAvancado();
    if (area === "servico") carregarServico();
  }

  // --- painel --------------------------------------------------------------------------------

  function classeDoEstadoApp(p) {
    if (!p.aplicacao.respondeu) {
      if (p.servico && p.servico.suportado && !p.servico.ativo) return ["alerta", "parado"];
      return ["erro", "sem resposta"];
    }
    return p.aplicacao.ok ? ["ok", "saudável"] : ["erro", "degradado"];
  }

  function carregarPainel(completo) {
    return api("/api/painel" + (completo ? "?completo=1" : "")).then(function (r) {
      if (!r.ok) return;
      var p = r.corpo;
      estadoApp.painel = p;
      renderVisao(p);
      renderFaixaTrabalho(p.trabalhoAtivo);
      if (estadoApp.area === "servico") renderServico(p);
    });
  }

  function renderVisao(p) {
    var atencao = $("visaoAtencao");
    limpar(atencao);

    // Problemas primeiro: o operador abre o console porque algo pode estar errado.
    if (p.manutencao && p.manutencao.ocupada) {
      aviso(atencao, "info", "Manutenção em andamento", p.manutencao.descricao);
    } else if (p.manutencao && p.manutencao.residuo) {
      aviso(atencao, "alerta", "Trava de manutenção residual", p.manutencao.descricao + " Remova-a em Avançado antes de iniciar outra operação.");
    }
    if (!p.aplicacao.respondeu) {
      if (p.servico && p.servico.suportado && !p.servico.ativo) {
        aviso(atencao, "alerta", "RemoteIFES parado", "O serviço não está ativo. Se a parada foi intencional, o watchdog está desligado. Use Serviço > Iniciar para voltar à operação.");
      } else {
        aviso(atencao, "erro", "RemoteIFES não responde", "O /health não respondeu (" + (p.aplicacao.erro || "sem resposta") + "). Veja os registros em Serviço e considere reiniciar.");
      }
    } else if (!p.aplicacao.ok) {
      aviso(atencao, "erro", "RemoteIFES degradado", "O processo respondeu, mas relatou banco em estado \"" + (p.aplicacao.banco || "desconhecido") + "\".");
    }
    if (p.bancoQuarentenado > 0) {
      aviso(atencao, "alerta", "Banco em quarentena", p.bancoQuarentenado + " arquivo(s) preservados de uma recuperação anterior. Eles nunca são apagados automaticamente.");
    }
    if (p.watchdog && p.watchdog.suportado && !p.watchdog.ativo) {
      aviso(atencao, "alerta", "Watchdog desligado", "A recuperação automática está suspensa: uma falha do /health não vai reiniciar a aplicação sozinha.");
    }
    if (p.watchdog && p.watchdog.falhasConsecutivas > 0) {
      aviso(atencao, "alerta", "Falhas de saúde registradas", p.watchdog.falhasConsecutivas + " de " + p.watchdog.limite + " falhas consecutivas. Na " + p.watchdog.limite + "ª, o watchdog reinicia o serviço.");
    }
    if (p.host && p.host.throttle && p.host.throttle.suportado && (p.host.throttle.subtensaoDesdeOBoot || p.host.throttle.throttlingDesdeOBoot)) {
      aviso(atencao, "alerta", "Alimentação ou temperatura", "O host registrou subtensão ou limitação de frequência desde o boot. Verifique a fonte e a ventilação.");
    }

    var e = classeDoEstadoApp(p);
    selo($("visaoEstadoApp"), e[0], e[1]);

    var dl = $("visaoApp");
    limpar(dl);
    dado(dl, "Estado do serviço", p.servico && p.servico.suportado ? p.servico.estadoAtivo + " / " + p.servico.subEstado : (p.servico && p.servico.motivo) || "não consultável");
    dado(dl, "Commit em execução", p.aplicacao.respondeu ? (curto(p.aplicacao.commit) || "não informado por esta versão") : null, "mono");
    dado(dl, "Tempo no ar", p.aplicacao.respondeu ? duracao(p.aplicacao.uptimeSegundos) : null);
    dado(dl, "Banco", p.aplicacao.respondeu ? p.aplicacao.banco : null);
    dado(dl, "Ambiente", p.aplicacao.respondeu ? p.aplicacao.ambiente : null);
    dado(dl, "Watchdog", p.watchdog && p.watchdog.suportado ? (p.watchdog.ativo ? "ativo (a cada " + p.watchdog.intervaloMinutos + " min)" : "desligado") : "não consultável");
    dado(dl, "Sessões do console", p.sessoesConsole);

    var hostOk = p.host && p.host.memoria && p.host.memoria.disponivelBytes > 80 * 1048576;
    selo($("visaoEstadoHost"), hostOk ? "ok" : "alerta", hostOk ? "normal" : "atenção");
    var dh = $("visaoHost");
    limpar(dh);
    dado(dh, "Modelo", p.host.modelo);
    dado(dh, "Memória disponível", p.host.memoria ? bytes(p.host.memoria.disponivelBytes) + " de " + bytes(p.host.memoria.totalBytes) : null);
    dado(dh, "Carga (1/5/15 min)", p.host.cargaMedia ? p.host.cargaMedia.um.toFixed(2) + " / " + p.host.cargaMedia.cinco.toFixed(2) + " / " + p.host.cargaMedia.quinze.toFixed(2) : null);
    dado(dh, "Temperatura", p.host.temperaturaC !== null ? p.host.temperaturaC + " °C" : null);
    dado(dh, "Host no ar há", duracao(p.host.uptimeSegundos));
    dado(dh, "Node", p.host.node);
    dado(dh, "Console (RSS)", bytes(p.host.consoleRss));

    var dv = $("visaoVersoes");
    limpar(dv);
    dado(dv, "Servidor (package.json)", p.versoes.servidor);
    dado(dv, "Frontend / PWA", p.versoes.frontend);
    dado(dv, "Firmware ESP32", p.versoes.firmware);
    dado(dv, "Android", p.versoes.android && p.versoes.android.versionName ? p.versoes.android.versionName + " (build " + p.versoes.android.versionCode + ")" : null);
    dado(dv, "Última implantação registrada", curto(p.versoesRegistradas.atual), "mono");
    dado(dv, "Backups", p.backups.disponivel ? p.backups.total + (p.backups.ultimo ? " · último " + quando(p.backups.ultimo.modificadoEm) : "") : p.backups.motivo);

    $("visaoColeta").textContent = "Coletado em " + quando(p.coletadoEm) + ". As leituras de host vêm de /proc e do systemd; a versão em execução vem do /health do próprio processo, não do código em disco.";
  }

  function renderFaixaTrabalho(trabalho) {
    var faixa = $("faixaTrabalho");
    limpar(faixa);
    if (!trabalho) { faixa.classList.add("oculto"); return; }
    faixa.classList.remove("oculto");
    var caixa = el("div", null, "aviso info");
    caixa.appendChild(el("strong", "Operação em andamento"));
    caixa.appendChild(document.createTextNode(trabalho.rotulo + " — fase: " + (trabalho.fase || "em curso") + ". "));
    var b = el("button", "Acompanhar", "btn pequeno");
    b.type = "button";
    b.addEventListener("click", function () { abrirTrabalho(trabalho.id); });
    caixa.appendChild(b);
    faixa.appendChild(caixa);
  }

  // --- ações ----------------------------------------------------------------------------------

  var ACOES = [];

  function carregarAcoes() {
    return api("/api/acoes").then(function (r) { if (r.ok) ACOES = r.corpo.acoes; });
  }

  function acaoPorId(id) {
    for (var i = 0; i < ACOES.length; i++) if (ACOES[i].id === id) return ACOES[i];
    return null;
  }

  function botaoDeAcao(container, id, obterArgumentos, classe) {
    var acao = acaoPorId(id);
    if (!acao) return;
    var bloco = el("div", null, "acao");
    bloco.appendChild(el("h4", acao.rotulo));
    bloco.appendChild(el("p", acao.proposito));
    var impacto = el("p", null, "impacto fraco");
    impacto.appendChild(el("strong", "Impacto: "));
    impacto.appendChild(document.createTextNode(acao.impacto));
    bloco.appendChild(impacto);
    var botao = el("button", acao.rotulo, "btn " + (classe || ""));
    botao.type = "button";
    botao.addEventListener("click", function () {
      var args = obterArgumentos ? obterArgumentos() : {};
      if (args === null) return;
      prepararAcao(acao, args);
    });
    bloco.appendChild(botao);
    if (acao.exigeElevacao) {
      bloco.appendChild(el("p", "Exige reautenticação.", "motivo-desabilitado"));
    }
    container.appendChild(bloco);
  }

  function prepararAcao(acao, argumentos) {
    api("/api/acoes/" + encodeURIComponent(acao.id) + "/preparar", { method: "POST", corpo: { argumentos: argumentos } }).then(function (r) {
      if (!r.ok) { alertar(r.corpo.erro || "não foi possível preparar a operação"); return; }
      mostrarConfirmacao(acao, argumentos, r.corpo);
    });
  }

  function mostrarConfirmacao(acao, argumentos, preparo) {
    var dlg = $("dlgAcao");
    $("dlgAcaoTitulo").textContent = acao.rotulo;
    var corpo = $("dlgAcaoCorpo");
    limpar(corpo);

    corpo.appendChild(el("p", preparo.acao.proposito));
    var pImp = el("p", null, "aviso alerta");
    pImp.appendChild(el("strong", "Impacto"));
    pImp.appendChild(document.createTextNode(preparo.acao.impacto));
    corpo.appendChild(pImp);

    var impedido = false;

    if (preparo.impedimento) {
      impedido = true;
      aviso(corpo, "erro", "Não é possível agora", preparo.impedimento);
    }

    var p = preparo.prontidao;
    if (p) {
      if (p.bloqueios.length) {
        impedido = true;
        p.bloqueios.forEach(function (b) { aviso(corpo, "erro", b.titulo, b.detalhe); });
      }
      p.avisos.forEach(function (a) { aviso(corpo, "alerta", a.titulo, a.detalhe); });
      if (p.informacoes.length) {
        var det = el("details");
        det.appendChild(el("summary", "Situação avaliada (" + p.informacoes.length + ")"));
        var d = el("div", null, "corpo");
        p.informacoes.forEach(function (i) {
          var linha = el("p");
          linha.appendChild(el("strong", i.titulo + ": "));
          linha.appendChild(document.createTextNode(i.detalhe));
          d.appendChild(linha);
        });
        det.appendChild(d);
        corpo.appendChild(det);
      }
      corpo.appendChild(el("p", "Avaliado em " + quando(p.avaliadoEm) + ". A situação é reavaliada no instante da execução.", "fraco"));
    }

    var campoConfirma = null;
    if (!impedido && preparo.acao.confirmacao) {
      var div = el("div", null, "campo");
      var lbl = el("label", 'Para confirmar, digite "' + preparo.acao.confirmacao + '"');
      lbl.setAttribute("for", "campoConfirmacao");
      div.appendChild(lbl);
      campoConfirma = document.createElement("input");
      campoConfirma.type = "text";
      campoConfirma.id = "campoConfirmacao";
      campoConfirma.autocapitalize = "none";
      campoConfirma.spellcheck = false;
      div.appendChild(campoConfirma);
      corpo.appendChild(div);
    }

    var confirmar = $("dlgAcaoConfirmar");
    confirmar.disabled = impedido;
    confirmar.textContent = impedido ? "Indisponível" : "Confirmar";
    confirmar.className = "btn " + (preparo.acao.confirmacao ? "perigo" : "primario");

    confirmar.onclick = function () {
      var carga = { argumentos: argumentos, aceitarAvisos: true };
      if (preparo.acao.confirmacao) {
        carga.confirmacao = campoConfirma ? campoConfirma.value.trim() : "";
        if (carga.confirmacao.toLowerCase() !== preparo.acao.confirmacao) {
          alertar('Digite exatamente "' + preparo.acao.confirmacao + '" para confirmar.');
          return;
        }
      }
      dlg.close();
      executarAcao(acao, carga);
    };
    $("dlgAcaoCancelar").onclick = function () { dlg.close(); };
    dlg.showModal();
  }

  function executarAcao(acao, carga) {
    api("/api/acoes/" + encodeURIComponent(acao.id) + "/executar", { method: "POST", corpo: carga }).then(function (r) {
      if (r.status === 403 && r.corpo.precisaElevacao) {
        pedirElevacao(function () { executarAcao(acao, carga); });
        return;
      }
      if (!r.ok) {
        alertar(r.corpo.erro || "a operação não pôde ser iniciada");
        return;
      }
      if (r.corpo.imediata) {
        carregarPainel();
        var res = r.corpo.resultado;
        alertar(res && res.erro ? res.erro : "Operação concluída.", res && res.erro ? "erro" : "ok");
        return;
      }
      abrirTrabalho(r.corpo.trabalho.id);
      carregarPainel();
    });
  }

  // --- elevação ---------------------------------------------------------------------------------

  function pedirElevacao(aoConseguir) {
    var dlg = $("dlgElevacao");
    limpar($("elevErro"));
    $("elevSenha").value = "";
    $("dlgElevConfirmar").onclick = function () {
      var senha = $("elevSenha").value;
      api("/api/sessao/elevar", { method: "POST", corpo: { senha: senha } }).then(function (r) {
        $("elevSenha").value = "";
        if (!r.ok) {
          limpar($("elevErro"));
          aviso($("elevErro"), "erro", "Não liberado", r.corpo.erro || "senha incorreta");
          return;
        }
        estadoApp.elevada = true;
        atualizarSeloElevacao(r.corpo.expiraEmS);
        setTimeout(function () { estadoApp.elevada = false; atualizarSeloElevacao(0); }, r.corpo.expiraEmS * 1000);
        dlg.close();
        if (aoConseguir) aoConseguir();
      });
    };
    $("dlgElevCancelar").onclick = function () { dlg.close(); };
    dlg.showModal();
    $("elevSenha").focus();
  }

  // --- trabalhos ---------------------------------------------------------------------------------

  function abrirTrabalho(id) {
    var dlg = $("dlgTrabalho");
    var saida = $("dlgTrabalhoSaida");
    var estadoCaixa = $("dlgTrabalhoEstado");
    saida.textContent = "";
    limpar(estadoCaixa);
    $("dlgTrabalhoTitulo").textContent = "Operação";
    dlg.showModal();

    if (estadoApp.fluxo) { estadoApp.fluxo.close(); estadoApp.fluxo = null; }

    function pintarEstado(t) {
      limpar(estadoCaixa);
      $("dlgTrabalhoTitulo").textContent = t.rotulo || t.acao;
      var mapa = { executando: ["info", "em andamento"], concluido: ["ok", "concluída"], falhou: ["erro", "falhou"], cancelado: ["alerta", "cancelada"], desconhecido: ["alerta", "desfecho desconhecido"] };
      var m = mapa[t.estado] || ["desconhecido", t.estado];
      var linha = el("div", null, "linha entre");
      var s = el("span");
      selo(s, m[0], m[1]);
      linha.appendChild(s);
      if (t.fase) linha.appendChild(el("span", "Fase: " + t.fase, "fraco"));
      estadoCaixa.appendChild(linha);
      if (t.estado === "executando") {
        var barra = el("div", null, "barra");
        barra.appendChild(document.createElement("i"));
        estadoCaixa.appendChild(barra);
      }
      if (t.irreversivel && t.estado === "executando") {
        aviso(estadoCaixa, "alerta", "Ponto sem retorno", "A operação passou da fase em que podia ser interrompida com segurança.");
      }
      if (t.erro) aviso(estadoCaixa, t.estado === "desconhecido" ? "alerta" : "erro", "Resultado", t.erro);
      if (t.verificacao && t.verificacao.resumo) {
        aviso(estadoCaixa, t.verificacao.ok === false ? "alerta" : "ok", "Verificação", t.verificacao.resumo);
      }
      if (t.estado === "desconhecido") {
        aviso(estadoCaixa, "alerta", "Próximo passo", "Confira o estado atual na Visão geral antes de repetir a operação: o efeito não pôde ser comprovado.");
      }
      $("dlgTrabalhoCancelar").disabled = t.estado !== "executando" || t.irreversivel;
    }

    api("/api/trabalhos/" + encodeURIComponent(id)).then(function (r) {
      if (!r.ok) return;
      pintarEstado(r.corpo);
      $("dlgTrabalhoCancelar").onclick = function () {
        api("/api/trabalhos/" + encodeURIComponent(id) + "/cancelar", { method: "POST" }).then(function (rc) {
          if (!rc.ok) alertar(rc.corpo.erro || "não foi possível cancelar");
        });
      };
      var fonte = new EventSource("/api/trabalhos/" + encodeURIComponent(id) + "/eventos");
      estadoApp.fluxo = fonte;
      fonte.addEventListener("saida", function (ev) {
        try {
          var d = JSON.parse(ev.data);
          saida.textContent += d.texto;
          saida.scrollTop = saida.scrollHeight;
        } catch (e) {}
      });
      fonte.addEventListener("fim", function (ev) {
        try { pintarEstado(JSON.parse(ev.data)); } catch (e) {}
        fonte.close();
        estadoApp.fluxo = null;
        carregarPainel();
        carregarTrabalhos();
      });
      fonte.onerror = function () { /* reconecta sozinho; o estado final também é lido no fechamento */ };
    });

    $("dlgTrabalhoFechar").onclick = function () {
      if (estadoApp.fluxo) { estadoApp.fluxo.close(); estadoApp.fluxo = null; }
      dlg.close();
      carregarPainel();
    };
  }

  function carregarTrabalhos() {
    return api("/api/trabalhos").then(function (r) {
      if (!r.ok) return;
      var tbody = document.querySelector("#tabelaTrabalhos tbody");
      limpar(tbody);
      r.corpo.trabalhos.forEach(function (t) {
        var tr = document.createElement("tr");
        tr.appendChild(el("td", quando(t.iniciadoEm)));
        tr.appendChild(el("td", t.rotulo || t.acao));
        var td = el("td");
        var s = el("span");
        var mapa = { executando: ["info", "em andamento"], concluido: ["ok", "concluída"], falhou: ["erro", "falhou"], cancelado: ["alerta", "cancelada"], desconhecido: ["alerta", "desconhecido"] };
        var m = mapa[t.estado] || ["desconhecido", t.estado];
        selo(s, m[0], m[1]);
        td.appendChild(s);
        tr.appendChild(td);
        var tdb = el("td");
        var b = el("button", "Ver", "btn pequeno");
        b.type = "button";
        b.addEventListener("click", function () { abrirTrabalho(t.id); });
        tdb.appendChild(b);
        tr.appendChild(tdb);
        tbody.appendChild(tr);
      });
    });
  }

  // --- serviço -------------------------------------------------------------------------------------

  function carregarServico() {
    if (estadoApp.painel) renderServico(estadoApp.painel);
    else carregarPainel();
  }

  function renderServico(p) {
    var dl = $("servicoDetalhe");
    limpar(dl);
    if (p.servico.suportado) {
      dado(dl, "Estado", p.servico.estadoAtivo + " / " + p.servico.subEstado);
      dado(dl, "Habilitado no boot", p.servico.arquivoUnidade);
      dado(dl, "Ativo desde", p.servico.desde);
      dado(dl, "Reinícios", p.servico.reinicios);
      dado(dl, "PID principal", p.servico.pid);
      dado(dl, "Memória do serviço", bytes(p.servico.memoriaBytes));
      dado(dl, "Último resultado", p.servico.resultadoUltimaExecucao);
    } else {
      dado(dl, "systemd", p.servico.motivo || "não consultável");
    }
    if (p.watchdog) {
      dado(dl, "Watchdog", p.watchdog.suportado ? (p.watchdog.ativo ? "ativo" : "desligado") : p.watchdog.motivo);
      dado(dl, "Falhas consecutivas de saúde", p.watchdog.falhasConsecutivas + " de " + p.watchdog.limite);
    }

    var acoes = $("servicoAcoes");
    limpar(acoes);
    botaoDeAcao(acoes, "saude.verificar");
    botaoDeAcao(acoes, "servico.reiniciar", null, "primario");
    if (p.servico.suportado && p.servico.ativo) botaoDeAcao(acoes, "servico.parar", null, "perigo");
    else botaoDeAcao(acoes, "servico.iniciar", null, "primario");
  }

  function carregarLog() {
    var saida = $("logSaida");
    saida.textContent = "carregando…";
    api("/api/logs?unidade=" + encodeURIComponent($("logUnidade").value) + "&linhas=" + encodeURIComponent($("logLinhas").value)).then(function (r) {
      // textContent: uma linha de journal é conteúdo não confiável e pode conter qualquer coisa.
      saida.textContent = r.ok && r.corpo.ok ? (r.corpo.texto || "(sem linhas)") : (r.corpo.erro || "não foi possível ler o registro");
    });
  }

  // --- atualizações -----------------------------------------------------------------------------------

  function carregarAtualizacao(consultando) {
    return api("/api/atualizacao").then(function (r) {
      if (!r.ok) return;
      estadoApp.atualizacao = r.corpo;
      renderAtualizacao(r.corpo);
    });
  }

  function renderAtualizacao(a) {
    var avisos = $("atualizacaoAvisos");
    limpar(avisos);

    if (!a.checkout.repositorio) {
      aviso(avisos, "erro", "Sem repositório", a.checkout.motivo);
      return;
    }
    if (a.divergenciaProcessoCheckout.ha) {
      aviso(avisos, "alerta", "Código em disco diferente do processo em execução", a.divergenciaProcessoCheckout.explicacao);
    }
    if (!a.checkout.limpo) {
      aviso(avisos, "alerta", "Alterações locais no checkout",
        a.checkout.totalModificados + " arquivo(s) modificados e " + a.checkout.totalNaoRastreados +
        " não rastreados. Uma atualização normal recusa prosseguir; o console nunca usa --force.");
    }
    if (a.checkout.destacado) {
      aviso(avisos, "alerta", "HEAD destacado", "O checkout não está num ramo. Isso acontece após implantar uma tag ou commit específico.");
    }
    if (a.checkout.raso) {
      aviso(avisos, "info", "Histórico raso", "O clone é shallow: comparações de commits podem não refletir todo o histórico.");
    }
    if (a.consultaAgora) {
      aviso(avisos, "erro", "Não foi possível consultar origin", a.consultaAgora.mensagem || a.consultaAgora.erro || "falha desconhecida");
    }
    if (a.remoto && a.remoto.ressalva) {
      aviso(avisos, "alerta", "Observação desatualizada", a.remoto.ressalva);
    }
    if (a.remoto && a.remoto.urlAnterior) {
      aviso(avisos, "alerta", "Remoto alterado", "O endereço de origin mudou de " + a.remoto.urlAnterior + " para " + a.remoto.url + ".");
    }

    var dl = $("atualizacaoDetalhe");
    limpar(dl);
    dado(dl, "Commit do processo em execução", a.emExecucao.commit ? curto(a.emExecucao.commit) : a.emExecucao.motivoDesconhecido, a.emExecucao.commit ? "mono" : null);
    dado(dl, "HEAD do checkout", curto(a.checkout.head), "mono");
    dado(dl, "Descrição do HEAD", a.checkout.descricaoHead, "mono");
    dado(dl, "Ramo local", a.checkout.destacado ? "(destacado)" : a.checkout.ramo);
    dado(dl, "Upstream", a.checkout.upstream);
    dado(dl, "Estado do checkout", a.checkout.limpo ? "limpo" : a.checkout.totalModificados + " modificados, " + a.checkout.totalNaoRastreados + " não rastreados");
    dado(dl, "Remoto origin", a.checkout.remotoOrigin, "mono");

    if (a.remoto) {
      dado(dl, "Último origin/main observado", curto(a.remoto.commit), "mono");
      dado(dl, "Observado em", quando(a.remoto.observadoEm) + " (há " + duracao(a.remoto.idadeSegundos) + ")");
    } else {
      dado(dl, "Último origin/main observado", null);
    }

    if (a.comparacao) {
      if (!a.comparacao.conhecido) {
        dado(dl, "Comparação", a.comparacao.motivo);
      } else {
        var texto = a.comparacao.igual ? "o checkout está no commit observado"
          : a.comparacao.atrasado ? a.comparacao.commitsSoRemotos + " commit(s) à frente em origin"
          : a.comparacao.adiantado ? a.comparacao.commitsSoLocais + " commit(s) locais não enviados"
          : a.comparacao.commitsSoLocais + " local(is) e " + a.comparacao.commitsSoRemotos + " remoto(s): divergiram";
        dado(dl, "Comparação", texto + (a.comparacao.ressalvaRaso ? " · " + a.comparacao.ressalvaRaso : ""));
      }
    }

    dado(dl, "Última implantação verificada", a.ultimaImplantacaoVerificada ? quando(a.ultimaImplantacaoVerificada.em) + " → " + curto(a.ultimaImplantacaoVerificada.para) : "nenhuma registrada");
    dado(dl, "Versão anterior registrada", curto(a.versoesRegistradas.anterior), "mono");

    var acoes = $("atualizacaoAcoes");
    limpar(acoes);
    var alvo = a.remoto ? a.remoto.commit : null;
    if (alvo && a.comparacao && a.comparacao.conhecido && a.comparacao.atrasado) {
      botaoDeAcao(acoes, "atualizacao.aplicar", function () { return { commit: alvo }; }, "primario");
    } else if (alvo) {
      var nota = el("div", null, "acao");
      nota.appendChild(el("h4", "Atualizar o RemoteIFES"));
      nota.appendChild(el("p", a.comparacao && a.comparacao.igual
        ? "O checkout já está no commit observado em origin. Se o processo em execução não o confirma, reinicie o serviço para aplicá-lo."
        : "Verifique origin e busque os objetos para comparar antes de atualizar."));
      acoes.appendChild(nota);
    } else {
      var nota2 = el("div", null, "acao");
      nota2.appendChild(el("h4", "Atualizar o RemoteIFES"));
      nota2.appendChild(el("p", "Nenhuma observação de origin ainda. Use \"Verificar origin\"."));
      acoes.appendChild(nota2);
    }
    botaoDeAcao(acoes, "atualizacao.reverter", function () { return {}; }, "perigo");
    botaoDeAcao(acoes, "console.atualizar", function () { return {}; });

    var tbody = document.querySelector("#tabelaHistorico tbody");
    limpar(tbody);
    (a.historico || []).forEach(function (h) {
      var tr = document.createElement("tr");
      tr.appendChild(el("td", quando(h.em) || h.bruto || ""));
      tr.appendChild(el("td", h.tipo || ""));
      tr.appendChild(el("td", curto(h.de) || "", "mono"));
      tr.appendChild(el("td", curto(h.para) || "", "mono"));
      var td = el("td");
      var s = el("span");
      selo(s, h.sucesso ? "ok" : "erro", h.sucesso ? "ok" : "falhou");
      td.appendChild(s);
      tr.appendChild(td);
      tbody.appendChild(tr);
    });

    carregarMudancas(a);
  }

  function carregarMudancas(a) {
    var caixa = $("atualizacaoMudancas");
    limpar(caixa);
    var de = a.emExecucao.commit || a.checkout.head;
    var para = a.remoto ? a.remoto.commit : null;
    if (!de || !para || de === para) {
      caixa.appendChild(el("p", "Nada a comparar: o console compara a versão em execução com o último origin/main observado.", "fraco"));
      return;
    }
    api("/api/atualizacao/mudancas?de=" + encodeURIComponent(de) + "&para=" + encodeURIComponent(para)).then(function (r) {
      limpar(caixa);
      if (!r.ok || !r.corpo.disponivel) {
        caixa.appendChild(el("p", (r.corpo && r.corpo.motivo) || "não foi possível comparar", "fraco"));
        return;
      }
      var m = r.corpo;
      caixa.appendChild(el("p", m.total + " commit(s) e " + m.arquivosAlterados + " arquivo(s) entre " + curto(de) + " e " + curto(para) + (m.truncado ? " (lista limitada)" : "")));
      if (m.componentes.length) {
        var ul = el("ul");
        m.componentes.forEach(function (c) {
          var li = el("li");
          li.appendChild(el("strong", c.rotulo + ": "));
          li.appendChild(document.createTextNode(c.arquivos + " arquivo(s)"));
          ul.appendChild(li);
        });
        caixa.appendChild(ul);
      }
      var det = el("details");
      det.appendChild(el("summary", "Commits"));
      var d = el("div", null, "corpo");
      var tabela = el("table");
      var tb = document.createElement("tbody");
      m.commits.forEach(function (c) {
        var tr = document.createElement("tr");
        tr.appendChild(el("td", c.curto, "mono"));
        // Assunto de commit é texto de terceiros: textContent, nunca innerHTML.
        tr.appendChild(el("td", c.assunto));
        tr.appendChild(el("td", c.autor, "fraco"));
        tb.appendChild(tr);
      });
      tabela.appendChild(tb);
      d.appendChild(tabela);
      det.appendChild(d);
      caixa.appendChild(det);
    });
  }

  // --- dados ---------------------------------------------------------------------------------------

  function carregarDados() {
    api("/api/backups").then(function (r) {
      if (!r.ok) return;
      var b = r.corpo;
      $("backupEscopo").textContent = b.escopo;

      var avisos = $("dadosAvisos");
      limpar(avisos);
      if (!b.disponivel) aviso(avisos, "alerta", "Backups indisponíveis", b.motivo || "pasta não encontrada");
      if (b.bancoQuarentenado && b.bancoQuarentenado.length) {
        aviso(avisos, "alerta", "Banco em quarentena", b.bancoQuarentenado.join(", ") + " — preservados para análise; nada é apagado automaticamente.");
      }

      var acoes = $("backupAcoes");
      limpar(acoes);
      botaoDeAcao(acoes, "backup.criar", function () { return { rotulo: "console" }; }, "primario");

      var tbody = document.querySelector("#tabelaBackups tbody");
      limpar(tbody);
      (b.itens || []).forEach(function (item) {
        var tr = document.createElement("tr");
        tr.appendChild(el("td", item.nome, "mono"));
        tr.appendChild(el("td", bytes(item.bytes)));
        tr.appendChild(el("td", quando(item.modificadoEm)));
        var td = el("td");
        var bt = el("button", "Restaurar", "btn pequeno perigo");
        bt.type = "button";
        bt.addEventListener("click", function () {
          var acao = acaoPorId("backup.restaurar");
          if (acao) prepararAcao(acao, { backup: item.nome });
        });
        td.appendChild(bt);
        tr.appendChild(td);
        tbody.appendChild(tr);
      });
      if (!(b.itens || []).length) {
        var tr2 = document.createElement("tr");
        var td2 = el("td", "Nenhum backup encontrado.");
        td2.colSpan = 4;
        td2.className = "fraco";
        tr2.appendChild(td2);
        tbody.appendChild(tr2);
      }
    });

    var rec = $("recuperacaoAcoes");
    limpar(rec);
    botaoDeAcao(rec, "conta.recuperar-superadmin", function () {
      var senha = window.prompt("Nova senha do superadministrador (8 a 128 caracteres).\nEla é enviada pelo corpo da requisição e entregue ao processo por stdin: não aparece em linha de comando nem em log.");
      if (senha === null) return null;
      return { senha: senha };
    }, "perigo");
    botaoDeAcao(rec, "manutencao.remover-trava", function () { return {}; });

    api("/api/host").then(function (r) {
      if (!r.ok) return;
      var dl = $("bancoDetalhe");
      limpar(dl);
      var b = r.corpo.banco;
      dado(dl, "Arquivo presente", b.existe ? "sim" : "não");
      dado(dl, "Tamanho", bytes(b.bytes));
      dado(dl, "Modificado em", quando(b.modificadoEm));
      dado(dl, "WAL presente", b.wal ? "sim" : "não");
      if (b.lido) {
        dado(dl, "Usuários", b.usuarios);
        dado(dl, "Salas (com MAC)", b.salas + " (" + b.salasComMac + ")");
        dado(dl, "Agendamentos ativos", b.agendamentosAtivos);
        dado(dl, "Sessões sem logout", b.sessoesAbertas);
      } else {
        dado(dl, "Leitura", b.erro || "não lido");
      }
      var pa = r.corpo.prontidaoAplicacao;
      if (pa && pa.disponivel) {
        dado(dl, "Canais de comando ESP32", pa.dispositivos.canaisDeComando + " de " + pa.dispositivos.conectados + " presentes");
        dado(dl, "OTA em andamento", pa.ota.ativos);
      } else {
        dado(dl, "Atividade de dispositivos", (pa && pa.motivo) || "desconhecida");
      }
      var pacotes = r.corpo.host.pacotes;
      dado(dl, "Atualizações de pacote do sistema", pacotes && pacotes.suportado ? pacotes.pendentes + " pendente(s) no cache local" : (pacotes && pacotes.motivo) || "não consultável");
      var disco = (r.corpo.host.disco || []).filter(function (d) { return d.suportado; });
      disco.forEach(function (d) {
        dado(dl, "Disco " + d.caminho, bytes(d.livreBytes) + " livres de " + bytes(d.totalBytes) + " (" + d.usoPercentual + "% usado)");
      });
    });
  }

  // --- mobile ---------------------------------------------------------------------------------------

  function carregarMobile() {
    api("/api/mobile").then(function (r) {
      if (!r.ok) return;
      var m = r.corpo;
      var dl = $("mobileIdentidades");
      limpar(dl);
      dado(dl, "Servidor", m.identidades.servidor);
      dado(dl, "Frontend / PWA", m.identidades.frontendPwa);
      dado(dl, "Pacote Cordova", m.identidades.pacoteCordova);
      dado(dl, "Android versionName", m.identidades.android && m.identidades.android.versionName);
      dado(dl, "Android versionCode", m.identidades.android && m.identidades.android.versionCode);
      dado(dl, "Firmware ESP32", m.identidades.firmware);

      var dr = $("mobileRelease");
      limpar(dr);
      if (!m.release.publicado) {
        dado(dr, "APK publicado", "nenhum — " + m.release.motivo);
      } else {
        dado(dr, "Versão", m.release.versao + " (build " + m.release.build + ")");
        dado(dr, "Arquivo", m.release.arquivo, "mono");
        dado(dr, "Presente no disco", m.release.apkPresente ? bytes(m.release.bytes) : "não");
        dado(dr, "SHA-256", m.release.sha256, "mono");
        dado(dr, "Origem do servidor", m.release.serverOrigin);
        dado(dr, "Campo signed", m.release.assinadoDeclarado ? "declarado true" : "ausente");
      }
      dado(dr, "Pasta servida", m.release.destino.servidoPor + " (" + m.release.destino.variavelDoServidor + ")", "mono");
      dado(dr, "Pasta de publicação", (m.release.destino.publicadoPara || "não definida") + " (" + m.release.destino.variavelDaPublicacao + ")", "mono");

      var build = $("mobileBuild");
      limpar(build);
      if (m.release.destino.divergem) {
        aviso(build, "alerta", "Destinos divergentes", m.release.destino.observacao);
      }
      aviso(build, "info", "Onde o build acontece", m.build.politica);
      aviso(build, "info", "iOS", m.build.ios);
      aviso(build, "alerta", "Publicação de produção", m.publicacao.motivo);
      aviso(build, "info", "Artefatos da CI", m.publicacao.artefatosDaCi);
      if (m.release.publicado) {
        aviso(build, "info", "Sobre o campo signed", m.release.ressalvaAssinatura);
      }
      var det = el("details");
      det.appendChild(el("summary", "Este host tem ferramenta de build?"));
      var d = el("div", null, "corpo");
      var dl2 = el("dl");
      dado(dl2, "Android SDK", m.build.esteHost.sdkAndroid ? "presente" : "ausente (esperado)");
      dado(dl2, "JDK", m.build.esteHost.jdk ? "presente" : "ausente (esperado)");
      dado(dl2, "Dependências Cordova", m.build.esteHost.dependenciasCordova ? "instaladas" : "ausentes");
      dado(dl2, "Arquitetura", m.build.esteHost.arquitetura);
      d.appendChild(dl2);
      det.appendChild(d);
      build.appendChild(det);
    });
  }

  function carregarCI() {
    var caixa = $("mobileCI");
    limpar(caixa);
    caixa.appendChild(el("p", "consultando…", "fraco"));
    api("/api/mobile/ci").then(function (r) {
      limpar(caixa);
      if (!r.ok) { aviso(caixa, "erro", "Falha", (r.corpo && r.corpo.erro) || "não foi possível consultar"); return; }
      var c = r.corpo;
      if (!c.disponivel) {
        aviso(caixa, "info", "Indisponível", c.motivo + (c.orientacao ? " " + c.orientacao : ""));
        return;
      }
      aviso(caixa, "info", "Estados distintos", c.estadosDistintos);
      if (c.origemMobile) aviso(caixa, "info", "Builds móveis", c.origemMobile);
      [["CI", c.ci], ["Android", c.android], ["iOS", c.ios]].forEach(function (par) {
        var det = el("details");
        det.appendChild(el("summary", par[0] + " — " + par[1].length + " execução(ões)"));
        var d = el("div", null, "corpo");
        var tabela = el("table");
        var tb = document.createElement("tbody");
        par[1].forEach(function (run) {
          var tr = document.createElement("tr");
          tr.appendChild(el("td", curto(run.commit), "mono"));
          tr.appendChild(el("td", run.status + (run.conclusao ? " · " + run.conclusao : "")));
          tr.appendChild(el("td", quando(run.criadoEm), "fraco"));
          tb.appendChild(tr);
        });
        tabela.appendChild(tb);
        d.appendChild(tabela);
        det.appendChild(d);
        caixa.appendChild(det);
      });
      if (c.limite && c.limite.restante !== null) {
        caixa.appendChild(el("p", "Limite do GitHub: " + c.limite.restante + " requisições restantes.", "fraco"));
      }
    });
  }

  // --- rede -------------------------------------------------------------------------------------------

  function carregarRede() {
    var caixa = $("redeConteudo");
    limpar(caixa);
    caixa.appendChild(el("p", "coletando…", "fraco"));
    api("/api/rede").then(function (r) {
      limpar(caixa);
      if (!r.ok) { aviso(caixa, "erro", "Falha", (r.corpo && r.corpo.erro) || "não foi possível coletar"); return; }
      var n = r.corpo;
      aviso(caixa, "info", "Ponto de vista das sondas", n.pontoDeVista);

      var dl = el("dl");
      dado(dl, "Domínio configurado", n.dominio.configurado || "nenhum detectado");
      if (n.dominio.dns) {
        dado(dl, "DNS (A)", (n.dominio.dns.a || []).join(", ") || n.dominio.dns.erro);
        dado(dl, "Aponta para este host", n.dominio.dns.apontaParaEsteHost === null ? "desconhecido" : n.dominio.dns.apontaParaEsteHost ? "sim" : "não");
      }
      if (n.dominio.certificado) {
        var cert = n.dominio.certificado;
        dado(dl, "TLS", cert.alcancou ? (cert.autorizado ? "cadeia válida" : "cadeia não validada: " + cert.erroAutorizacao) : "não alcançou: " + cert.erro);
        if (cert.alcancou) {
          dado(dl, "Certificado expira em", cert.diasParaExpirar + " dia(s) — " + quando(cert.validoAte));
          dado(dl, "Emissor", cert.emissor);
        }
      }
      dado(dl, "Certbot", n.dominio.renovacao.certbot ? (n.dominio.renovacao.dominios || []).join(", ") + (n.dominio.renovacao.timerInstalado ? " · timer instalado" : " · sem timer") : "não instalado");
      dado(dl, "Proxy Nginx", n.proxy.instalado ? (n.proxy.siteRemoteifes ? "site RemoteIFES ativo" : "instalado, sem site RemoteIFES") : "não instalado");
      dado(dl, "Sonda /health local", n.sondas.aplicacaoLocal.alcancou ? "HTTP " + n.sondas.aplicacaoLocal.status : n.sondas.aplicacaoLocal.erro);
      dado(dl, "Sonda porta 80 local", n.sondas.proxyLocal.alcancou ? "HTTP " + n.sondas.proxyLocal.status : n.sondas.proxyLocal.erro);
      caixa.appendChild(dl);

      if (n.proxy.observacao) aviso(caixa, "alerta", "Nginx", n.proxy.observacao);

      var exp = el("details");
      exp.appendChild(el("summary", "Exposição da aplicação e do console"));
      var expd = el("div", null, "corpo");
      var dle = el("dl");
      dado(dle, "Porta da aplicação", n.exposicaoAplicacao.porta);
      dado(dle, "Bind", n.exposicaoAplicacao.bind);
      dado(dle, "Ambiente", n.exposicaoAplicacao.ambiente);
      dado(dle, "CORS_ORIGIN", n.exposicaoAplicacao.corsOrigin.join(", ") || "(vazio)");
      dado(dle, "TRUST_PROXY", n.exposicaoAplicacao.trustProxy);
      dado(dle, "Faixas autorizadas (dono: aplicação)", n.exposicaoAplicacao.redesAutorizadas.lido ? (n.exposicaoAplicacao.redesAutorizadas.valores.join(", ") || "(nenhuma)") : "não lidas");
      dado(dle, "Console escuta em", n.exposicaoConsole.endereco + ":" + n.exposicaoConsole.porta);
      dado(dle, "Hosts aceitos pelo console", n.exposicaoConsole.hostsAceitos.join(", "));
      expd.appendChild(dle);
      aviso(expd, "info", "Acesso remoto", n.exposicaoConsole.orientacao);
      aviso(expd, "info", "TRUST_PROXY", n.exposicaoAplicacao.observacao);
      aviso(expd, "info", "Faixas de rede", n.exposicaoAplicacao.redesAutorizadas.observacao + " Quem edita as faixas é a aplicação, em Administração > Sistema > Configurações.");
      exp.appendChild(expd);
      caixa.appendChild(exp);

      var esc = el("details");
      esc.appendChild(el("summary", "Interfaces, rotas e portas em escuta"));
      var escd = el("div", null, "corpo");
      var pre = el("pre", null, "saida");
      var linhas = [];
      n.interfaces.forEach(function (i) { linhas.push(i.interface + "  " + i.familia + "  " + i.endereco + "/" + i.mascara); });
      linhas.push("");
      if (n.rotas.suportado) linhas = linhas.concat(n.rotas.linhas);
      linhas.push("");
      if (n.escutas.suportado) linhas = linhas.concat(n.escutas.linhas);
      pre.textContent = linhas.join("\n");
      escd.appendChild(pre);
      esc.appendChild(escd);
      caixa.appendChild(esc);

      aviso(caixa, "alerta", "Operações consequentes", n.operacoesConsequentes.observacao);
    });
  }

  // --- avançado ---------------------------------------------------------------------------------------

  function carregarAvancado() {
    var s = $("avancadoSessao");
    limpar(s);
    var p = el("p");
    p.textContent = "Operador: " + estadoApp.operador + ". A elevação vale por poucos minutos e é revogada no logout, na troca de senha e ao encerrá-la.";
    s.appendChild(p);
    var linha = el("div", null, "linha");
    var bElev = el("button", "Liberar operações sensíveis", "btn pequeno");
    bElev.type = "button";
    bElev.addEventListener("click", function () { pedirElevacao(function () { carregarAvancado(); }); });
    linha.appendChild(bElev);
    var bRel = el("button", "Encerrar elevação", "btn pequeno");
    bRel.type = "button";
    bRel.addEventListener("click", function () {
      api("/api/sessao/elevar", { method: "DELETE" }).then(function () {
        estadoApp.elevada = false;
        atualizarSeloElevacao(0);
        carregarAvancado();
        carregarTerminal();
      });
    });
    linha.appendChild(bRel);
    s.appendChild(linha);

    var acoes = $("avancadoAcoes");
    limpar(acoes);
    // A atualização e a reversão do próprio console vivem na aba Programa, onde a versão alvo
    // está à vista: a ação exige a versão publicada, e um botão sem ela só produziria recusa.
    botaoDeAcao(acoes, "manutencao.remover-trava", function () { return {}; });
    botaoDeAcao(acoes, "host.reiniciar", function () { return {}; }, "perigo");

    carregarTerminal();
    carregarSegredos();

    api("/api/auditoria?limite=80").then(function (r) {
      if (!r.ok) return;
      var tbody = document.querySelector("#tabelaAuditoria tbody");
      limpar(tbody);
      r.corpo.itens.forEach(function (item) {
        var tr = document.createElement("tr");
        tr.appendChild(el("td", quando(item.em)));
        tr.appendChild(el("td", item.evento));
        var copia = {};
        Object.keys(item).forEach(function (k) { if (k !== "em" && k !== "evento") copia[k] = item[k]; });
        tr.appendChild(el("td", JSON.stringify(copia), "mono"));
        tbody.appendChild(tr);
      });
    });

    carregarTrabalhos();
  }

  // --- programa instalado e plataforma -------------------------------------------------------

  var ROTULO_CAPACIDADE = {
    controleDeServico: "Controle do serviço do RemoteIFES",
    watchdog: "Watchdog de saúde",
    registrosDoSistema: "Registros do sistema",
    inicializacaoAutomatica: "Partida com o sistema",
    reinicioDoHost: "Reinício do host",
    terminal: "Terminal Expert",
  };

  var ROTULO_ESTADO = {
    suportado: ["ok", "disponível"],
    "nao-instalado": ["alerta", "não instalado"],
    "sem-permissao": ["alerta", "sem permissão"],
    indisponivel: ["erro", "indisponível"],
    "nao-aplicavel": ["desconhecido", "não se aplica"],
    "nao-suportado": ["desconhecido", "não suportado aqui"],
  };

  function carregarPrograma(comRede) {
    return api("/api/programa" + (comRede ? "?rede=1" : "")).then(function (r) {
      if (!r.ok) return;
      renderPrograma(r.corpo);
    });
  }

  function renderPrograma(p) {
    var avisos = $("programaAvisos");
    limpar(avisos);

    if (p.console.transacaoPendente && p.console.transacaoPendente.etapa !== "concluida") {
      aviso(avisos, "alerta", "Atualização interrompida",
        "Uma atualização do console parou em \"" + p.console.transacaoPendente.etapa + "\". A versão ativa continua a que funcionava; " +
        "a reconciliação limpa o resto na próxima partida.");
    }
    if (p.console.divergenciaDeVersao) {
      // Reinício pendente é o caminho normal entre ativar e reabrir; só o descompasso persistente
      // é erro. Gritar nos dois casos ensina o operador a ignorar o aviso.
      var d = p.console.divergenciaDeVersao;
      if (d.reinicioPendente) {
        aviso(avisos, "info", "Reinício pendente", d.motivo);
      } else {
        aviso(avisos, "erro", "A versão em execução não é a versão ativa", d.motivo);
      }
    }
    if (!p.console.confiancaConfigurada) {
      aviso(avisos, "info", "Atualização por release não configurada",
        "Nenhuma chave pública de publicação foi provisionada neste console, então nenhum release é aceito. " +
        "Atualizar aqui significa reinstalar o pacote da plataforma.");
    }
    if (!p.plataforma.runtime.atende) {
      aviso(avisos, "erro", "Node abaixo do exigido", p.plataforma.runtime.motivo || "");
    }

    // --- versão do console ---------------------------------------------------------------
    var dl = $("programaConsole");
    limpar(dl);
    dado(dl, "Versão em execução", p.console.versaoEmExecucao, "mono");
    if (p.console.gerenciadoLadoALado) {
      dado(dl, "Versão ativa registrada", p.console.versaoAtivaRegistrada, "mono");
      dado(dl, "Versão anterior (reversível)", p.console.versaoAnterior, "mono");
      dado(dl, "Versões no disco", p.console.versoesPresentes.join(", "), "mono");
    } else {
      dado(dl, "Layout", "execução a partir do código-fonte; sem versões lado a lado");
    }
    dado(dl, "Alvo de artefato", p.console.alvo, "mono");
    if (p.console.ultimaObservacao) {
      var obs = p.console.ultimaObservacao;
      dado(dl, "Publicação observada", obs.versao + " (" + (obs.canal || "estável") + ")", "mono");
      dado(dl, "Observada em", quando(obs.observadoEm) + (obs.recente ? "" : " — dado antigo"));
      if (obs.ressalva) dado(dl, "Ressalva", obs.ressalva);
    } else {
      dado(dl, "Publicação observada", null);
    }
    if (p.console.consultaAgora && p.console.consultaAgora.motivo) {
      dado(dl, "Última consulta", p.console.consultaAgora.motivo);
    }
    if (p.console.motivoNaoAtualizar) dado(dl, "Por que não atualizar agora", p.console.motivoNaoAtualizar);
    dado(dl, "Escopo da distribuição", p.console.observacaoDeDistribuicao.replace(/\*\*/g, ""));

    var acoes = $("programaAcoes");
    limpar(acoes);
    if (p.console.podeAtualizar && p.console.disponivel) {
      botaoDeAcao(acoes, "console.atualizar", function () { return { versao: p.console.disponivel }; });
    }
    if (p.console.versaoAnterior) {
      botaoDeAcao(acoes, "console.reverter", function () { return {}; });
    }
    if (!acoes.firstChild) {
      acoes.appendChild(el("p", "Nenhuma operação de versão disponível agora.", "fraco"));
    }

    // --- plataforma -----------------------------------------------------------------------
    var dp = $("programaPlataforma");
    limpar(dp);
    dado(dp, "Sistema", p.plataforma.rotulo);
    dado(dp, "Node", p.plataforma.runtime.versao + " (mínimo " + p.plataforma.runtime.minimoExigido + ")", "mono");
    var a = p.plataforma.arquitetura;
    if (a) {
      dado(dp, "Runtime", a.runtime, "mono");
      dado(dp, "Kernel", a.kernel, "mono");
      dado(dp, "Userland", a.userland ? a.userland + (a.fonteUserland ? " (" + a.fonteUserland + ")" : "") : null, "mono");
      dado(dp, "Hardware", a.hardware, "mono");
      if (a.ressalva) dado(dp, "Ressalva de arquitetura", a.ressalva);
    }
    Object.keys(p.plataforma.ferramentas || {}).forEach(function (nome) {
      var f = p.plataforma.ferramentas[nome];
      dado(dp, nome, f.disponivel ? (f.versao || "presente") : (f.motivo || "ausente"), f.disponivel ? "mono" : null);
    });

    var tbody = document.querySelector("#tabelaCapacidades tbody");
    limpar(tbody);
    Object.keys(p.plataforma.recursos).forEach(function (chave) {
      var r = p.plataforma.recursos[chave];
      var par = ROTULO_ESTADO[r.estado] || ["desconhecido", r.estado];
      var tr = document.createElement("tr");
      tr.appendChild(el("td", ROTULO_CAPACIDADE[chave] || chave));
      var td = el("td");
      var marca = el("span", par[1], "estado " + par[0]);
      td.appendChild(marca);
      tr.appendChild(td);
      tr.appendChild(el("td", r.motivo || "—"));
      tbody.appendChild(tr);
    });

    // --- instalação -------------------------------------------------------------------------
    var di = $("programaInstalacao");
    limpar(di);
    dado(di, "Programa", p.instalacao.raiz, "mono");
    if (p.instalacao.payloadEmExecucao !== p.instalacao.raiz) {
      dado(di, "Payload em execução", p.instalacao.payloadEmExecucao, "mono");
    }
    dado(di, "Estado", p.instalacao.estado, "mono");
    dado(di, "Checkout administrado", p.instalacao.checkout, "mono");
    dado(di, "Escopo", p.instalacao.escopo);
    dado(di, "Modo de execução", p.instalacao.modoDeExecucao);
    if (p.instalacao.protecaoDoContrato && p.instalacao.protecaoDoContrato.presente) {
      var pc = p.instalacao.protecaoDoContrato;
      dado(di, "Contrato de identidade", (pc.restrito ? "restrito" : pc.verificavel ? "LEGÍVEL POR OUTROS" : "não verificável") + " · " + pc.mecanismo);
    }
    dado(di, "Aplicação", p.aplicacao.url, "mono");

    var caixa = $("programaDesinstalar");
    limpar(caixa);
    var pd = el("p", null, "fraco");
    pd.appendChild(document.createTextNode("Para remover o programa sem perder operadores nem auditoria: "));
    pd.appendChild(el("code", "node " + p.instalacao.raiz + "/versoes/<versão>/instalacao/desinstalar.js --simular", "mono"));
    pd.appendChild(document.createTextNode(". A simulação mostra exatamente o que sairia; o estado só é apagado com --apagar-estado."));
    caixa.appendChild(pd);
  }

  function carregarSegredos() {
    var caixa = $("segredoGitHub");
    limpar(caixa);
    api("/api/mobile").then(function (r) {
      if (!r.ok) return;
      var t = r.corpo.credencialGitHub;
      var dl = el("dl");
      dado(dl, "Credencial", t.presente ? "gravada" : "não configurada");
      if (t.presente) {
        dado(dl, "Formato", t.formato);
        dado(dl, "Gravada em", quando(t.gravadoEm));
      }
      caixa.appendChild(dl);
      caixa.appendChild(el("p", t.presente ? t.observacao : "Um token só é necessário para acompanhar e disparar a CI. Sem ele o console funciona normalmente.", "fraco"));
    });
  }

  // --- terminal -----------------------------------------------------------------------------------------

  var terminalAtual = null;
  var terminalPos = 0;
  var terminalRelogio = null;

  function carregarTerminal() {
    var caixa = $("terminalEstado");
    limpar(caixa);
    api("/api/terminal").then(function (r) {
      if (!r.ok) return;
      var t = r.corpo;
      if (!t.disponivel) {
        aviso(caixa, "alerta", "Terminal indisponível", t.motivo);
        caixa.appendChild(el("p", t.explicacao, "fraco"));
        var det = el("details");
        det.appendChild(el("summary", "Como habilitar"));
        var d = el("div", null, "corpo");
        var pre = el("pre", null, "saida");
        pre.textContent = t.instalacao.join("\n");
        d.appendChild(pre);
        d.appendChild(el("p", t.alternativa, "fraco"));
        det.appendChild(d);
        caixa.appendChild(det);
        $("terminalArea").classList.add("oculto");
        return;
      }
      aviso(caixa, "info", "Alto risco", t.politica);
      aviso(caixa, "alerta", "Sem redação de saída", t.redacao);
      var dl = el("dl");
      dado(dl, "Implementação", t.implementacao);
      dado(dl, "Shell", t.shell);
      dado(dl, "Sessões simultâneas", t.limites.maxSessoes);
      dado(dl, "Relock por ociosidade", duracao(t.limites.ociosoSegundos));
      dado(dl, "Duração máxima", duracao(t.limites.maximoSegundos));
      caixa.appendChild(dl);

      if (!terminalAtual) {
        var b = el("button", "Destravar e abrir terminal", "btn perigo");
        b.type = "button";
        b.addEventListener("click", function () { abrirTerminal(); });
        caixa.appendChild(b);
      }
    });
  }

  function abrirTerminal() {
    api("/api/terminal/sessoes", { method: "POST", corpo: { colunas: 100, linhas: 30 } }).then(function (r) {
      if (r.status === 403 && r.corpo.precisaElevacao) { pedirElevacao(function () { abrirTerminal(); }); return; }
      if (!r.ok) { alertar(r.corpo.erro || "não foi possível abrir o terminal"); return; }
      terminalAtual = r.corpo.id;
      terminalPos = 0;
      $("terminalTela").textContent = "";
      $("terminalArea").classList.remove("oculto");
      $("terminalEntrada").focus();
      terminalRelogio = setInterval(lerTerminal, 700);
      carregarTerminal();
    });
  }

  function lerTerminal() {
    if (!terminalAtual) return;
    api("/api/terminal/sessoes/" + encodeURIComponent(terminalAtual) + "/saida?desde=" + terminalPos).then(function (r) {
      if (r.status === 404) { fecharTerminal(true); return; }
      if (!r.ok) return;
      if (r.corpo.texto) {
        var tela = $("terminalTela");
        // A saída do terminal é texto não confiável: entra por textContent e nunca é interpretada.
        tela.textContent += r.corpo.texto;
        tela.scrollTop = tela.scrollHeight;
      }
      terminalPos = r.corpo.posicao;
    });
  }

  function fecharTerminal(jaMorreu) {
    if (terminalRelogio) { clearInterval(terminalRelogio); terminalRelogio = null; }
    var id = terminalAtual;
    terminalAtual = null;
    $("terminalArea").classList.add("oculto");
    if (id && !jaMorreu) api("/api/terminal/sessoes/" + encodeURIComponent(id), { method: "DELETE" });
    carregarTerminal();
  }

  // --- auxiliares de UI -----------------------------------------------------------------------------------

  function alertar(mensagem, nivel) {
    var faixa = $("faixaTrabalho");
    limpar(faixa);
    faixa.classList.remove("oculto");
    aviso(faixa, nivel === "ok" ? "ok" : "erro", nivel === "ok" ? "Pronto" : "Não foi possível", mensagem);
    setTimeout(function () { if (estadoApp.painel) renderFaixaTrabalho(estadoApp.painel.trabalhoAtivo); }, 8000);
  }

  // --- inicialização ---------------------------------------------------------------------------------------

  function ligarEventos() {
    AREAS.forEach(function (a) {
      $("aba-" + a).addEventListener("click", function () { trocarArea(a); });
    });
    document.querySelector(".abas").addEventListener("keydown", function (ev) {
      var i = AREAS.indexOf(estadoApp.area);
      if (ev.key === "ArrowRight") { trocarArea(AREAS[(i + 1) % AREAS.length]); $("aba-" + estadoApp.area).focus(); }
      if (ev.key === "ArrowLeft") { trocarArea(AREAS[(i - 1 + AREAS.length) % AREAS.length]); $("aba-" + estadoApp.area).focus(); }
    });

    $("formLogin").addEventListener("submit", function (ev) {
      ev.preventDefault();
      api("/api/sessao", { method: "POST", corpo: { nome: $("loginNome").value.trim(), senha: $("loginSenha").value } }).then(function (r) {
        $("loginSenha").value = "";
        if (!r.ok) {
          var caixa = $("loginAviso");
          limpar(caixa);
          caixa.classList.remove("oculto");
          aviso(caixa, "erro", "Não foi possível entrar", r.corpo.erro || "credenciais inválidas");
          return;
        }
        carregarAcoes().then(function () { entrarNoConsole(r.corpo); });
      });
    });

    $("formBootstrap").addEventListener("submit", function (ev) {
      ev.preventDefault();
      api("/api/bootstrap", { method: "POST", corpo: { segredo: $("bsSegredo").value, nome: $("bsNome").value.trim(), senha: $("bsSenha").value } }).then(function (r) {
        if (!r.ok) {
          var caixa = $("loginAviso");
          limpar(caixa);
          caixa.classList.remove("oculto");
          aviso(caixa, "erro", "Não foi possível criar o operador", r.corpo.erro || "falha");
          return;
        }
        $("bsSegredo").value = "";
        $("bsSenha").value = "";
        mostrarLogin("Operador criado. Entre com as credenciais que acabou de definir.");
      });
    });

    $("btnSair").addEventListener("click", function () {
      api("/api/sessao", { method: "DELETE" }).then(function () { mostrarLogin(); });
    });

    $("btnAtualizarPainel").addEventListener("click", function () { carregarPainel(true); });
    $("btnCarregarLog").addEventListener("click", carregarLog);
    $("btnVerificarRemoto").addEventListener("click", function () {
      api("/api/atualizacao/verificar", { method: "POST" }).then(function (r) {
        if (r.ok) { estadoApp.atualizacao = r.corpo; renderAtualizacao(r.corpo); }
        else alertar((r.corpo && r.corpo.erro) || "falha ao consultar origin");
      });
    });
    $("btnBuscarObjetos").addEventListener("click", function () {
      api("/api/atualizacao/buscar", { method: "POST" }).then(function (r) {
        if (r.ok) { estadoApp.atualizacao = r.corpo.situacao; renderAtualizacao(r.corpo.situacao); }
        else alertar((r.corpo && r.corpo.erro) || "falha ao buscar objetos");
      });
    });
    $("btnVerificarConsole").addEventListener("click", function () {
      carregarPrograma(true);
    });
    $("btnCarregarCI").addEventListener("click", carregarCI);
    $("btnCarregarRede").addEventListener("click", carregarRede);
    $("btnTerminalFechar").addEventListener("click", function () { fecharTerminal(false); });
    $("terminalEntrada").addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" || !terminalAtual) return;
      ev.preventDefault();
      var texto = ev.target.value + "\n";
      ev.target.value = "";
      api("/api/terminal/sessoes/" + encodeURIComponent(terminalAtual) + "/entrada", { method: "POST", corpo: { dados: texto } }).then(function (r) {
        if (r.status === 403) { fecharTerminal(true); alertar("A elevação expirou e o terminal foi encerrado."); }
      });
    });
  }

  function iniciar() {
    ligarEventos();
    api("/api/sessao").then(function (r) {
      if (r.ok && r.corpo.autenticado) {
        carregarAcoes().then(function () { entrarNoConsole(r.corpo); });
      } else {
        mostrarLogin();
      }
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar);
  else iniciar();
})();
