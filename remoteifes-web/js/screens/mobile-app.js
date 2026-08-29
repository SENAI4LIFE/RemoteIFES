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
        <section class="mobile-app-card mobile-app-download ${android ? "is-recommended" : ""}"><h3>Android</h3><p>Android 7.0 ou posterior · versão ${escapeHtml(versao)}${apk.build ? ` · build ${escapeHtml(apk.build)}` : ""}</p>
          ${disponivel ? `<button type="button" class="btn btn-on mobile-app-download-btn">Baixar APK de produção para Android</button><dl class="mobile-app-integrity"><dt>SHA-256</dt><dd><code>${escapeHtml(apk.sha256)}</code></dd><dt>Certificado</dt><dd><code>${escapeHtml(apk.certificateSha256)}</code></dd><dt>Tamanho</dt><dd>${escapeHtml(apk.tamanho)}</dd></dl>` : `<p class="mobile-app-unavailable" role="status">O APK de produção ainda não foi publicado. Nenhum APK de teste ou sem assinatura será oferecido.</p>`}
          ${!android ? `<p class="hint">Este download é destinado a dispositivos Android. Você ainda pode consultar os dados manualmente.</p>` : ""}
        </section>
        <section class="mobile-app-card ${!android ? "is-recommended" : ""}"><h3>Instalar como PWA</h3><p>No navegador compatível, use <strong>Instalar aplicativo</strong> ou <strong>Adicionar à tela inicial</strong>. É a opção indicada para iPhone, iPad e computadores.</p></section>
      </div>
      <section class="mobile-app-instructions"><h2>Instalação e configuração</h2><ol><li>Baixe somente desta página controlada pelo servidor RemoteIFES e confira o SHA-256.</li><li>No Android, confirme a instalação do arquivo. Autorize apenas esta instalação quando o sistema solicitar; não desative a proteção do aparelho globalmente.</li><li>Abra o aplicativo e informe o endereço HTTPS fornecido pela equipe local, se a versão não vier pré-configurada.</li><li>Entre com sua conta RemoteIFES. Atualizações usam o mesmo fluxo: baixe a versão publicada e valide a integridade antes de instalar.</li></ol></section>
      <section class="mobile-app-security"><h2>Segurança e funcionamento</h2><p>O aplicativo não instala nada silenciosamente, não inclui credenciais de desenvolvimento e não substitui as permissões do servidor. A interface e o manual comum podem abrir sem Internet; comandos, estado em tempo real e autenticação exigem acesso ao servidor local.</p></section>`;
    const baixar = conteudo.querySelector(".mobile-app-download-btn");
    if (baixar) baixar.addEventListener("click", async () => {
      baixar.disabled = true;
      const resultado = await Api.baixarMobileApk();
      baixar.disabled = false;
      if (!resultado.ok) return Toast.erro(resultado.erro);
      const url = URL.createObjectURL(resultado.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = resultado.nome;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    if (!semRestaurar && typeof Router !== "undefined") Router.ir("/salas");
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
