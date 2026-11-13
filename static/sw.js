/* Service worker. Es un MOLDE: lo sirve /sw.js con la versión y la lista de
   archivos ya escritas (pwa.py). Guarda las pantallas, el CSS, el JS y los
   íconos para que la app abra rápido con el internet del local. La API no pasa
   nunca por acá: turnos, caja y pagos van siempre al servidor. */
const CACHE = "salon-__VERSION__";
const ARCHIVOS = __ARCHIVOS__;

self.addEventListener("install", e => {
  // "reload": bajarlos del servidor, no de la caché HTTP del navegador, que
  // puede tener el archivo de antes del deploy
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(ARCHIVOS.map(u => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(nombres => Promise.all(nombres
      .filter(n => n.startsWith("salon-") && n !== CACHE)
      .map(n => caches.delete(n))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const pedido = e.request;
  const url = new URL(pedido.url);
  if (pedido.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // /cuenta?id=3 y /cuenta?id=8 son la misma pantalla
  const opciones = { ignoreSearch: pedido.mode === "navigate" };
  e.respondWith(caches.open(CACHE)
    .then(c => c.match(pedido, opciones))
    .then(guardado => guardado || fetch(pedido)));
});
