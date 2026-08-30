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

  function render(info) {
    const android = plataforma() === "android";
    const disponivel = !!(info && info.android && info.android.disponivel);
    const versao = info && info.versao ? info.versao : "1.0.0";
    const apk = info && info.android ? info.android : {};
    conteudo.innerHTML = `
      <section class="mobile-app-hero">
        <div><span class="mobile-app-kicker">REMOTEIFES NO CELULAR</span><h2>Controle as salas com a mesma segurança do site</h2><p>O aplicativo empacota a interface mantida do RemoteIFES e conecta somente ao servidor configurado para a sua instalação.</p></div>
        <img src="assets/icons/icon-192.png" alt="" width="128" height="128" />
      </section>
      <div class="mobile-app-grid">
        <section class="mobile-app-card mobile-app-download ${android ? "is-recommended" : ""}"><h3>Android</h3>
          <dl class="mobile-app-integrity">
            <dt>Versão</dt><dd>${escapeHtml(versao)}${apk.build ? ` (build ${escapeHtml(apk.build)})` : ""}</dd>
            <dt>Compatibilidade</dt><dd>Android 7.0 (API 24) ou posterior</dd>
            ${disponivel ? `<dt>Tamanho</dt><dd>${escapeHtml(apk.tamanho || "—")}</dd><dt>SHA-256</dt><dd><code class="mobile-app-hash">${escapeHtml(apk.sha256)}</code></dd><dt>Certificado</dt><dd><code class="mobile-app-hash">${escapeHtml(apk.certificateSha256)}</code></dd>` : ""}
          </dl>
          ${disponivel
            ? `<button type="button" class="btn btn-on btn-block mobile-app-download-btn">${ICONE_BAIXAR}<span>Baixar APK</span></button><p class="mobile-app-verify hint" role="status" aria-live="polite">O arquivo é verificado pelo SHA-256 acima antes de ser salvo.</p>`
            : `<p class="mobile-app-unavailable" role="status">Nenhum APK de produção assinado está publicado neste servidor no momento. Nenhum APK de teste ou sem assinatura é oferecido — use a instalação como PWA abaixo.</p>`}
          ${!android && disponivel ? `<p class="hint">O download é destinado a aparelhos Android; em outros sistemas ele serve apenas para transferir o arquivo verificado.</p>` : ""}
        </section>
        <section class="mobile-app-card ${!android || !disponivel ? "is-recommended" : ""}"><h3>Instalar como PWA</h3><p>No navegador compatível, use <strong>Instalar aplicativo</strong> ou <strong>Adicionar à tela inicial</strong>. É a opção indicada para iPhone, iPad e computadores, e a alternativa quando não há APK publicado.</p></section>
      </div>
      <section class="mobile-app-instructions"><h2>Instalação</h2><ol>
        <li>Baixe apenas por esta página, servida pelo servidor RemoteIFES da sua instalação.</li>
        <li>Confira que o SHA-256 mostrado aqui é igual ao do arquivo baixado (a página valida isso automaticamente antes de salvar).</li>
        <li>No Android, abra o arquivo e confirme a instalação. Autorize somente esta instalação quando o sistema pedir; não desligue a proteção do aparelho de forma permanente.</li>
        <li>Abra o aplicativo. Se ele não vier pré-configurado, informe o endereço do servidor fornecido pela equipe local e entre com sua conta RemoteIFES.</li>
      </ol></section>
      <section class="mobile-app-instructions"><h2>Atualizações</h2><ol>
        <li>Volte a esta página quando uma nova versão for publicada — a versão e o SHA-256 acima mudam.</li>
        <li>Baixe o novo APK e instale por cima do anterior; os dados de sessão e o endereço do servidor são preservados.</li>
        <li>A PWA se atualiza sozinha ao reabrir com conexão ao servidor.</li>
      </ol></section>
      <section class="mobile-app-security"><h2>Segurança e funcionamento</h2><p>O aplicativo não instala nada silenciosamente, não inclui credenciais de desenvolvimento e não substitui as permissões do servidor. A interface e o manual comum podem abrir sem Internet; comandos, estado em tempo real e autenticação exigem acesso ao servidor local.</p></section>`;

    const baixar = conteudo.querySelector(".mobile-app-download-btn");
    const verificacao = conteudo.querySelector(".mobile-app-verify");
    if (baixar) baixar.addEventListener("click", async () => {
      baixar.disabled = true;
      if (verificacao) { verificacao.classList.remove("mobile-app-verify-erro"); verificacao.textContent = "Baixando e verificando o arquivo…"; }
      const resultado = await Api.baixarMobileApk();
      if (!resultado.ok) {
        baixar.disabled = false;
        if (verificacao) verificacao.textContent = "O arquivo é verificado pelo SHA-256 acima antes de ser salvo.";
        return Toast.erro(resultado.erro);
      }
      try {
        const bytes = await resultado.blob.arrayBuffer();
        const hash = await sha256Hex(bytes);
        if (apk.sha256 && hash !== String(apk.sha256).toLowerCase()) {
          baixar.disabled = false;
          if (verificacao) { verificacao.classList.add("mobile-app-verify-erro"); verificacao.textContent = "Falha na verificação de integridade: o arquivo baixado não corresponde ao SHA-256 publicado. O download foi cancelado."; }
          return Toast.erro("APK descartado: SHA-256 diferente do publicado.");
        }
        const url = URL.createObjectURL(resultado.blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = resultado.nome;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        if (verificacao) verificacao.textContent = `Integridade confirmada (SHA-256 ${hash.slice(0, 12)}…). Instale o arquivo baixado.`;
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
    const itens = Array.from(overlay.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null);
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

  return { abrir, fechar, estaAberto: () => !overlay.classList.contains("hidden") };
})();
