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

  const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function sha256HexPuro(buffer) {
    const bytes = new Uint8Array(buffer);
    const tamanho = ((bytes.length + 9 + 63) >> 6) << 6;
    const bloco = new Uint8Array(tamanho);
    bloco.set(bytes);
    bloco[bytes.length] = 0x80;
    const visao = new DataView(bloco.buffer);
    visao.setUint32(tamanho - 8, Math.floor((bytes.length * 8) / 0x100000000));
    visao.setUint32(tamanho - 4, (bytes.length * 8) >>> 0);
    const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let inicio = 0; inicio < tamanho; inicio += 64) {
      for (let t = 0; t < 16; t += 1) w[t] = visao.getUint32(inicio + t * 4);
      for (let t = 16; t < 64; t += 1) {
        const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let t = 0; t < 64; t += 1) {
        const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[t] + w[t]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    return h.map((x) => x.toString(16).padStart(8, "0")).join("");
  }

  async function sha256Hex(buffer) {
    if (!(window.crypto && crypto.subtle)) return sha256HexPuro(buffer);
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Only the packaged app knows which version is installed: it is written into the bundle by the
  // same build that produces the APK. On the website and PWA that data does not exist, and the page
  // says so instead of guessing what is installed on the reader's device.
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

  // No periodic polling: the published version is re-read only when the page opens and when the
  // device returns to the foreground with it open, which is when the data may have changed.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (overlay.classList.contains("hidden")) return;
    carregar();
  });

  return { abrir, fechar, estaAberto: () => !overlay.classList.contains("hidden") };
})();
