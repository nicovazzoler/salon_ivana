/* Tema claro / oscuro. Va en el <head> y SIN defer: tiene que estampar el tema
   antes de que el navegador pinte, o se ve un fogonazo blanco.

   Se guarda por dispositivo y cada pestaña lo estampa una sola vez al abrirse:
   de ahí los tres eventos de abajo, que avisan a las que ya estaban. */
(function(){
  var CLAVE = "pelu_tema";

  function guardado(){
    try { return localStorage.getItem(CLAVE); } catch(e){ return null; }
  }

  /* Sin elección propia seguimos lo que pida el sistema operativo. */
  function preferido(){
    var g = guardado();
    if(g === "claro" || g === "oscuro") return g;
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "oscuro" : "claro";
    } catch(e){ return "claro"; }
  }

  function actual(){
    return document.documentElement.getAttribute("data-tema");
  }

  /* La transición de 150ms es para el mouse encima de UN botón, no para
     repintar la pantalla entera: al cambiar de tema se animan todos juntos y en
     una lista larga eso es medio segundo de tirones. */
  function sinTransiciones(){
    var d = document.documentElement;
    d.setAttribute("data-cambiando-tema", "");
    // Leer una medida obliga al navegador a aplicar el corte ya, antes de pintar
    void d.offsetHeight;
    var listo = function(){ d.removeAttribute("data-cambiando-tema"); };
    if(window.requestAnimationFrame){
      requestAnimationFrame(function(){ requestAnimationFrame(listo); });
    } else {
      setTimeout(listo, 50);
    }
  }

  function aplicar(tema, animar){
    if(actual() === tema) return;          // ya está: no repintamos al pedo
    if(animar !== false) sinTransiciones();
    document.documentElement.setAttribute("data-tema", tema);
    // Que la barra del navegador en el celular acompañe al fondo de la app
    var meta = document.querySelector('meta[name="theme-color"]');
    if(meta) meta.setAttribute("content", tema === "oscuro" ? "#17130e" : "#f2ece0");
    if(window.pintarBotonTema) window.pintarBotonTema();
  }

  /* Volver a poner la pantalla de acuerdo con lo que está guardado. Es lo que se
     llama cuando el cambio lo hizo OTRA pestaña, o cuando el navegador nos
     devuelve una página que tenía congelada. */
  function resincronizar(){
    aplicar(preferido());
  }

  window.temaActual = preferido;

  window.alternarTema = function(){
    var nuevo = (actual() === "oscuro") ? "claro" : "oscuro";
    try { localStorage.setItem(CLAVE, nuevo); } catch(e){ /* modo privado: al menos vale por esta sesión */ }
    aplicar(nuevo);
    return nuevo;
  };

  // Primer estampado: sin animación, que todavía no hay nada pintado que animar
  aplicar(preferido(), false);

  /* Otra pestaña del mismo navegador tocó el botón. El evento "storage" salta en
     todas las pestañas MENOS en la que hizo el cambio, que es justo lo que
     queremos: esa ya se actualizó sola. */
  window.addEventListener("storage", function(e){
    if(e.key === CLAVE) resincronizar();
  });

  /* El navegador puede guardar la página entera al navegar y devolverla tal cual
     al volver atrás, sin correr los scripts de nuevo (bfcache). En ese caso el
     tema que se ve es el que había al salir, que puede no ser el elegido. */
  window.addEventListener("pageshow", function(e){
    if(e.persisted) resincronizar();
  });

  // Red de seguridad: al volver a esta pestaña, comprobar que sigue al día
  document.addEventListener("visibilitychange", function(){
    if(!document.hidden) resincronizar();
  });

  /* Si nunca eligió a mano, que acompañe al sistema cuando este cambie */
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function(e){
      if(guardado()) return;
      aplicar(e.matches ? "oscuro" : "claro");
    });
  } catch(e){}
})();
