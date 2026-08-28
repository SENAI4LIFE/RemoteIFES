const CACHE_VERSION = "v8";
const CACHE_NAME = `remoteifes-shell-${CACHE_VERSION}`;

const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/style.css",
  "./js/app.js",
  "./js/api.js",
  "./js/config.js",
  "./js/floorplan.js",
  "./js/help.js",
  "./js/idle-timer.js",
  "./js/nav.js",
  "./js/rooms-data.js",
  "./js/rtstatus.js",
  "./js/server-status.js",
  "./js/state.js",
  "./js/tempo.js",
  "./js/toast.js",
  "./js/a11y.js",
  "./js/ui-dialog.js",
  "./js/screens/admin.js",
  "./js/screens/relatos.js",
  "./js/screens/floorplan.js",
  "./js/screens/grade.js",
  "./js/screens/location.js",
  "./js/screens/login.js",
  "./js/screens/notifications.js",
  "./js/screens/panel.js",
  "./js/screens/portal-funcoes.js",
  "./js/screens/propriedade.js",
  "./js/screens/rooms.js",
  "./js/screens/schedule.js",
  "./js/screens/simple.js",
  "./js/screens/esp32-admin.js",
  "./js/screens/monitoramento.js",
  "./assets/ifes-logo.png",
  "./assets/remoteifes-logo.png",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/icon-192-maskable.png",
  "./assets/icons/icon-512-maskable.png",
  "./assets/icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.destination === "") return;

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached);

      return cached || network;
    })
  );
});
