const FRONTEND_VERSION = "2026.09.01.5";
const CACHE_PREFIX = "remoteifes-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${FRONTEND_VERSION}`;
const VERSION_QUERY = `v=${encodeURIComponent(FRONTEND_VERSION)}`;
const UPGRADE_MARKER = "./__remoteifes_upgrade__";

const VERSIONED_SHELL = [
  "css/style.css",
  "js/version.js", "js/state.js", "js/config.js", "js/toast.js", "js/server-status.js",
  "js/tempo.js", "js/rooms-data.js", "js/api.js", "js/rtstatus.js", "js/nav.js",
  "js/idle-timer.js", "js/a11y.js", "js/ui-dialog.js", "js/ui-status.js", "js/help.js",
  "js/manual-content.js",
  "js/screens/notifications.js", "js/screens/relatos.js", "js/screens/login.js",
  "js/screens/portal-funcoes.js", "js/screens/location.js", "js/screens/simple.js",
  "js/floorplan.js", "js/screens/floorplan.js", "js/screens/rooms.js", "js/screens/panel.js",
  "js/screens/schedule.js", "js/screens/grade.js", "js/screens/propriedade.js",
  "js/screens/monitoramento.js", "js/screens/heatmap.js", "js/screens/energia.js", "js/screens/inicio.js",
  "js/screens/admin.js", "js/screens/esp32-admin.js", "js/screens/manual.js",
  "js/screens/mobile-app.js", "js/account-menu.js", "js/router.js", "js/app.js",
  "assets/ifes-logo.png", "assets/remoteifes-logo.png",
  "assets/icons/icon-192.png", "assets/icons/icon-512.png",
  "assets/icons/icon-192-maskable.png", "assets/icons/icon-512-maskable.png",
  "assets/icons/apple-touch-icon.png", "assets/icons/favicon-16.png", "assets/icons/favicon-32.png",
];

const APP_SHELL = [
  "./index.html",
  `./manifest.webmanifest?${VERSION_QUERY}`,
  "./version.json",
  ...VERSIONED_SHELL.map((asset) => `./${asset}?${VERSION_QUERY}`),
];

async function instalarShell() {
  const keys = await caches.keys();
  const atualizando = keys.some((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: "reload" })));
  if (atualizando) await cache.put(UPGRADE_MARKER, new Response("1"));
}

self.addEventListener("install", (event) => {
  event.waitUntil(instalarShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const cacheAtual = await caches.open(CACHE_NAME);
    const atualizando = !!(await cacheAtual.match(UPGRADE_MARKER));
    if (atualizando) await cacheAtual.delete(UPGRADE_MARKER);
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)));
    await self.clients.claim();

    if (atualizando) {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      clients.forEach((client) => {
        const url = new URL(client.url);
        if (url.origin === self.location.origin) client.navigate(client.url).catch(() => null);
      });
    }
  })());
});

async function responderNavegacao(request) {
  try {
    const response = await fetch(request, { cache: "no-store" });
    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put("./index.html", response.clone());
    }
    return response;
  } catch (erro) {
    return (await caches.match("./index.html", { cacheName: CACHE_NAME })) || Response.error();
  }
}

async function responderAtivo(request, url) {
  const versaoPedida = url.searchParams.get("v");
  if (versaoPedida && versaoPedida !== FRONTEND_VERSION) {
    return fetch(request, { cache: "reload" });
  }

  const cached = await caches.match(request, { cacheName: CACHE_NAME });
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, response.clone());
    }
    return response;
  } catch (erro) {
    return Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(responderNavegacao(request));
    return;
  }
  if (!request.destination) return;
  event.respondWith(responderAtivo(request, url));
});
