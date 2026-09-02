const MobileApp = (() => {
  const overlay = document.getElementById("screen-mobile-app");
  const conteudo = document.getElementById("mobileAppContent");
  let anterior = null;

  function plataforma() {
    const ua = navigator.userAgent || "";
    if (/Android/i.test(ua)) return "android";
    if (/iPad|iPhone|iPod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "ios";
    return "desktop";
  }

  const ICONE_BAIXAR =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 3a1 1 0 0 1 1 1v8.59l2.3-2.3a1 1 0 1 1 1.4 1.42l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.42l2.3 2.3V4a1 1 0 0 1 1-1Zm-7 13a1 1 0 0 1 1 1v2h12v-2a1 1 0 1 1 2 0v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z"/></svg>';

  async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Só o aplicativo empacotado sabe qual versão está instalada: ela é gravada no bundle no
  // mesmo build que gera o APK. No site e na PWA esse dado não existe, e a página diz isso
  // em vez de adivinhar o que está instalado no aparelho de quem está lendo.
  function versaoInstalada() {
    const cfg = window.RemoteIFESConfig || {};
    if (!cfg.empacotado) return null;
    if (!cfg.appAndroidBuild) return { conhecida: false };
    return { conhecida: true, versao: cfg.appAndroidVersao || "—", build: String(cfg.appAndroidBuild) };
  }

  function estadoDaVersao(apk) {
    const instalada = versaoInstalada();
    if (!instalada) return { chave: "navegador" };
    if (!instalada.conhecida) return { chave: "desconhecida" };
    const atual = Number(instalada.build);
    const publicado = Number(apk.build);
    if (!Number.isFinite(atual) || !Number.isFinite(publicado)) return { chave: "desconhecida" };
    return { chave: publicado > atual ? "desatualizada" : "atualizada", instalada };
  }

  function dataPorExtenso(iso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ""))) return null;
    return String(iso).split("-").reverse().join("/");
  }

  function cartaoStatus(estado, versao, apk) {
    const instalada = estado.instalada;
    if (estado.chave === "atualizada") {
      return { classe: "is-atualizada", selo: "Atualizado", titulo: "Você já está na versão mais recente",
        texto: `Versão instalada ${escapeHtml(instalada.versao)} (build ${escapeHtml(instalada.build)}). Não é preciso fazer nada.` };
    }
    if (estado.chave === "desatualizada") {
      return { classe: "is-desatualizada", selo: "Atualização disponível", titulo: "Há uma versão mais nova do aplicativo",
        texto: `Instalada: ${escapeHtml(instalada.versao)} (build ${escapeHtml(instalada.build)}). Publicada: ${escapeHtml(versao)} (build ${escapeHtml(apk.build)}). Baixe abaixo e instale por cima.` };
    }
    if (estado.chave === "desconhecida") {
      return { classe: "is-desconhecida", selo: "Versão instalada indisponível", titulo: "Não foi possível identificar a versão instalada",
        texto: `Este servidor publica a versão ${escapeHtml(versao)}. Instalar por cima é seguro: se a instalada já for essa, o Android avisa e nada muda.` };
    }
    return { classe: "is-navegador", selo: "Versão disponível", titulo: `Aplicativo Android ${escapeHtml(versao)}`,
      texto: "Você está no navegador, então não dá para saber qual versão está instalada no celular. Abra esta página no aparelho Android para instalar ou atualizar." };
  }

  function passosDeInstalacao(atualizando) {
    if (atualizando) {
      return [
        "Toque em <strong>Baixar atualização</strong> e aguarde a conferência do arquivo.",
        "Abra o arquivo baixado (pelo aviso de download ou pela pasta <strong>Downloads</strong>).",
        "Toque em <strong>Atualizar</strong>: a nova versão é instalada por cima da atual e sua conta e o endereço do servidor continuam salvos.",
        "A atualização só está concluída quando o Android confirma a instalação e o aplicativo abre na versão nova.",
      ];
    }
    return [
      "Toque em <strong>Baixar aplicativo</strong>. O arquivo é conferido automaticamente antes de ser salvo.",
      "Abra o arquivo baixado (pelo aviso de download ou pela pasta <strong>Downloads</strong>).",
      "Se o Android disser que não pode instalar desta fonte, toque em <strong>Configurações</strong> e ative <strong>Permitir desta fonte</strong> apenas para o aplicativo que abriu o arquivo. Depois de instalar você pode desativar de novo; não desligue outras proteções do aparelho.",
      "Toque em <strong>Instalar</strong> e depois em <strong>Abrir</strong>. Entre com a mesma conta que você usa no RemoteIFES.",
    ];
  }

  function render(info) {
    const android = plataforma() === "android";
    const disponivel = !!(info && info.android && info.android.disponivel);
    const versao = info && info.versao ? info.versao : "1.0.0";
    const apk = info && info.android ? info.android : {};
    const estado = disponivel ? estadoDaVersao(apk) : { chave: "navegador" };
    const atualizando = estado.chave === "desatualizada";
    const status = disponivel ? cartaoStatus(estado, versao, apk) : null;
    const publicacao = dataPorExtenso(apk.dataPublicacao);
    const notas = Array.isArray(apk.notas) ? apk.notas : [];
    const servidor = (window.RemoteIFESConfig && window.RemoteIFESConfig.serverUrl) || window.location.origin;

    conteudo.innerHTML = `
      <section class="mobile-app-hero">
        <div><span class="mobile-app-kicker">REMOTEIFES NO CELULAR</span><h2>Controle as salas com a mesma segurança do site</h2><p>O aplicativo empacota a interface mantida do RemoteIFES e conecta somente ao servidor configurado para a sua instalação.</p></div>
        <img src="assets/icons/icon-192.png?v=${encodeURIComponent(window.REMOTEIFES_FRONTEND_VERSION || "unknown")}" alt="" width="128" height="128" />
      </section>

      ${status
        ? `<section class="mobile-app-status ${status.classe}" role="status"><span class="mobile-app-selo">${escapeHtml(status.selo)}</span><h2>${status.titulo}</h2><p>${status.texto}</p></section>`
        : `<section class="mobile-app-status is-indisponivel" role="status"><span class="mobile-app-selo">Sem aplicativo publicado</span><h2>Este servidor ainda não publicou o aplicativo Android</h2><p class="mobile-app-unavailable">Nenhum APK de produção assinado está disponível aqui. Nenhuma versão de teste ou sem assinatura é oferecida: use a instalação como PWA, ao lado.</p></section>`}

      <div class="mobile-app-grid">
        <section class="mobile-app-card mobile-app-download ${android && disponivel ? "is-recommended" : ""}"><h3>Aplicativo Android</h3>
          ${disponivel
            ? `<p class="mobile-app-versao">Versão <strong>${escapeHtml(versao)}</strong>${publicacao ? ` · publicada em ${escapeHtml(publicacao)}` : ""} · ${escapeHtml(apk.tamanho || "—")}</p>
               <button type="button" class="btn btn-on btn-block mobile-app-download-btn">${ICONE_BAIXAR}<span>${atualizando ? "Baixar atualização" : "Baixar aplicativo"}</span></button>
               <p class="mobile-app-verify hint" role="status" aria-live="polite">O arquivo é conferido pelo servidor antes de ser salvo no aparelho.</p>
               ${notas.length ? `<div class="mobile-app-notas"><h4>Novidades desta versão</h4><ul>${notas.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul></div>` : ""}
               ${!android ? `<p class="hint">O arquivo serve para aparelhos Android; em outros sistemas ele só é transferido.</p>` : ""}`
            : `<p class="hint">Assim que a equipe publicar uma versão, ela aparece aqui com o botão de instalação.</p>`}
        </section>
        <section class="mobile-app-card ${!android || !disponivel ? "is-recommended" : ""}"><h3>Instalar como PWA</h3><p>No navegador compatível, use <strong>Instalar aplicativo</strong> ou <strong>Adicionar à tela inicial</strong>. É a opção indicada para iPhone, iPad e computadores, e a alternativa quando não há aplicativo Android publicado.</p></section>
      </div>

      ${disponivel ? `<section class="mobile-app-instructions"><h2>${atualizando ? "Como atualizar" : "Como instalar"}</h2><ol>${passosDeInstalacao(atualizando).map((p) => `<li>${p}</li>`).join("")}</ol></section>` : ""}

      <section class="mobile-app-instructions"><h2>Atualizações</h2>
        <p>Novas versões são publicadas por esta mesma página, pelo servidor da sua instalação — não pela Play Store. Abra esta página de vez em quando${versaoInstalada() ? " ou reabra o aplicativo" : ""}: quando houver uma versão mais nova, o aviso aparece aqui em cima. Nada é instalado sozinho; a instalação sempre passa pela sua confirmação no Android.</p>
      </section>

      <section class="mobile-app-security"><h2>Para funcionar</h2>
        <p>O aparelho precisa alcançar o servidor <code>${escapeHtml(servidor)}</code> — em geral pela rede Wi-Fi da instituição, não pelos dados móveis. A interface e o manual comum abrem sem Internet; comandos, estado em tempo real e login exigem o servidor. O aplicativo não instala nada silenciosamente, não inclui credenciais de desenvolvimento e não substitui as permissões da sua conta.</p>
      </section>

      <details class="mobile-app-detalhes"><summary>Problemas comuns</summary>
        <dl>
          <dt>“Aplicativo não instalado”</dt><dd>Normalmente o arquivo é igual ou mais antigo que o já instalado, ou veio de outra origem. Baixe de novo por esta página. Se continuar, desinstale o aplicativo e instale outra vez — você precisará informar o endereço do servidor e entrar de novo.</dd>
          <dt>O download não abre ou é recusado</dt><dd>Confira o espaço livre e baixe de novo. Um arquivo que chega corrompido é descartado automaticamente e não chega a ser salvo.</dd>
          <dt>O Android não deixa instalar desta fonte</dt><dd>Ative <strong>Permitir desta fonte</strong> apenas para o aplicativo que abriu o arquivo, instale e desative em seguida. Não é preciso desligar nenhuma outra proteção.</dd>
          <dt>O aplicativo abre mas não conecta</dt><dd>Confirme que o aparelho está na mesma rede do servidor <code>${escapeHtml(servidor)}</code> e que o Wi-Fi está ativo.</dd>
        </dl>
      </details>

      ${disponivel
        ? `<details class="mobile-app-detalhes mobile-app-tecnico"><summary>Detalhes técnicos</summary>
             <dl class="mobile-app-integrity">
               <dt>Versão</dt><dd>${escapeHtml(versao)} (build ${escapeHtml(apk.build)})</dd>
               <dt>Compatibilidade</dt><dd>Android 7.0 (API 24) ou posterior</dd>
               <dt>Tamanho</dt><dd>${escapeHtml(apk.tamanho || "—")}</dd>
               <dt>SHA-256 do arquivo</dt><dd><code class="mobile-app-hash">${escapeHtml(apk.sha256)}</code></dd>
               <dt>SHA-256 do certificado</dt><dd><code class="mobile-app-hash">${escapeHtml(apk.certificateSha256)}</code></dd>
               <dt>Servidor de origem</dt><dd><code>${escapeHtml(servidor)}</code></dd>
             </dl>
             <p class="hint">O navegador recalcula o SHA-256 dos bytes recebidos e cancela o salvamento se ele não bater com o publicado.</p>
           </details>`
        : ""}`;

    const baixar = conteudo.querySelector(".mobile-app-download-btn");
    const verificacao = conteudo.querySelector(".mobile-app-verify");
    const textoPadrao = "O arquivo é conferido pelo servidor antes de ser salvo no aparelho.";
    if (baixar) baixar.addEventListener("click", async () => {
      baixar.disabled = true;
      if (verificacao) { verificacao.classList.remove("mobile-app-verify-erro"); verificacao.textContent = "Baixando e conferindo o arquivo…"; }
      const resultado = await Api.baixarMobileApk();
      if (!resultado.ok) {
        baixar.disabled = false;
        if (verificacao) verificacao.textContent = textoPadrao;
        return Toast.erro(resultado.erro);
      }
      try {
        const bytes = await resultado.blob.arrayBuffer();
        const hash = await sha256Hex(bytes);
        if (apk.sha256 && hash !== String(apk.sha256).toLowerCase()) {
          baixar.disabled = false;
          if (verificacao) { verificacao.classList.add("mobile-app-verify-erro"); verificacao.textContent = "Falha na verificação de integridade: o arquivo baixado não corresponde ao publicado. O download foi cancelado."; }
          return Toast.erro("APK descartado: SHA-256 diferente do publicado.");
        }
        const url = URL.createObjectURL(resultado.blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = apk.build ? `RemoteIFES-${versao}-${apk.build}.apk` : resultado.nome;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        if (verificacao) verificacao.textContent = "Integridade confirmada. Abra o arquivo baixado e confirme a instalação no Android.";
      } catch (err) {
        if (verificacao) { verificacao.classList.add("mobile-app-verify-erro"); verificacao.textContent = "Não foi possível verificar a integridade do arquivo; o download foi cancelado."; }
        Toast.erro("não foi possível verificar o APK");
      } finally {
        baixar.disabled = false;
      }
    });
  }

  async function carregar() {
    const info = await Api.mobileAppInfo();
    render(info && info.ok ? info : null);
  }

  function abrir() {
    if (!state.usuario) return;
    anterior = document.activeElement;
    overlay.classList.remove("hidden");
    document.body.classList.add("mobile-app-open");
    conteudo.innerHTML = '<p class="hint">Carregando informações da versão…</p>';
    carregar().finally(() => conteudo.focus());
    if (typeof Router !== "undefined") Router.sync({ push: true });
  }

  function fechar({ semRestaurar = false } = {}) {
    overlay.classList.add("hidden");
    document.body.classList.remove("mobile-app-open");
    if (anterior && typeof anterior.focus === "function") anterior.focus();
    anterior = null;
    if (!semRestaurar && typeof Router !== "undefined") Router.ir("/inicio");
  }

  document.getElementById("mobileAppBackBtn").addEventListener("click", () => fechar());
  document.getElementById("mobileAppCloseBtn").addEventListener("click", () => fechar());
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") return fechar();
    if (event.key !== "Tab") return;
    const itens = Array.from(overlay.querySelectorAll('button, summary, [href], [tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null);
    if (!itens.length) return;
    const primeiro = itens[0];
    const ultimo = itens[itens.length - 1];
    if (event.shiftKey && document.activeElement === primeiro) {
      event.preventDefault();
      ultimo.focus();
    } else if (!event.shiftKey && document.activeElement === ultimo) {
      event.preventDefault();
      primeiro.focus();
    }
  });

  // Sem sondagem periódica: a versão publicada é relida só ao abrir a página e quando o
  // aparelho volta ao primeiro plano com ela aberta, que é quando o dado pode ter mudado.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (overlay.classList.contains("hidden")) return;
    carregar();
  });

  return { abrir, fechar, estaAberto: () => !overlay.classList.contains("hidden") };
})();
