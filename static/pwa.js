/* La app instalable: registra el service worker y pone los dos carteles de
   arriba, el de "sin conexión" y, en las pantallas que quedan abiertas todo el
   día, el de la versión nueva. */
(function(){
  "use strict";

  function cartel(id, clase){
    let c = document.getElementById(id);
    if(!c){
      c = document.createElement("div");
      c.id = id;
      c.className = "cartel-app " + clase;
      c.setAttribute("role", "status");
      c.hidden = true;
      document.body.insertBefore(c, document.body.firstChild);
    }
    return c;
  }

  /* La pantalla abre igual, de lo guardado, pero sin datos. Avisan el
     navegador cuando se corta la red y authFetch cuando un pedido no llega:
     el wifi puede estar prendido y sin internet. */
  window.avisarConexion = function(hay){
    const c = cartel("cartelSinConexion", "peligro");
    c.textContent = "Sin conexión: no se guarda nada hasta que vuelva";
    c.hidden = hay;
  };
  window.addEventListener("offline", () => window.avisarConexion(false));
  window.addEventListener("online",  () => window.avisarConexion(true));
  if(!navigator.onLine) window.avisarConexion(false);

  if(!("serviceWorker" in navigator)) return;

  // Sin uno de antes, el que toma el control es el primero, no una versión nueva
  const habiaUno = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if(!habiaUno || !document.body.hasAttribute("data-avisar-version")) return;
    const c = cartel("cartelVersion", "info");
    c.innerHTML = '<span>Hay una versión nueva de la app</span> <button type="button">Actualizar</button>';
    c.querySelector("button").onclick = () => location.reload();
    c.hidden = false;
  });

  navigator.serviceWorker.register("/sw.js").then(reg => {
    // El navegador pregunta por una versión nueva al cambiar de pantalla; una
    // que queda abierta todo el día no cambia nunca, así que pregunta sola.
    const revisar = () => reg.update().catch(() => {});
    setInterval(revisar, 30 * 60 * 1000);
    document.addEventListener("visibilitychange", () => { if(!document.hidden) revisar(); });
  }).catch(() => {});
})();
