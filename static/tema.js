/* Tema claro / oscuro.

   Este archivo se carga en el <head> y SIN defer a propósito: tiene que estampar
   el tema antes de que el navegador pinte, o al abrir cada pantalla se ve un
   fogonazo blanco antes de que aparezca el oscuro.

   La elección se guarda por dispositivo: la tablet del mostrador puede quedar en
   claro y el celular en oscuro, sin pisarse. */
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

  function aplicar(tema){
    document.documentElement.setAttribute("data-tema", tema);
    // Que la barra del navegador en el celular acompañe al fondo de la app
    var meta = document.querySelector('meta[name="theme-color"]');
    if(meta) meta.setAttribute("content", tema === "oscuro" ? "#17130e" : "#f2ece0");
  }

  window.temaActual = preferido;

  window.alternarTema = function(){
    var nuevo = (document.documentElement.getAttribute("data-tema") === "oscuro") ? "claro" : "oscuro";
    try { localStorage.setItem(CLAVE, nuevo); } catch(e){ /* modo privado: al menos vale por esta sesión */ }
    aplicar(nuevo);
    if(window.pintarBotonTema) window.pintarBotonTema();
    return nuevo;
  };

  aplicar(preferido());

  /* Si nunca eligió a mano, que acompañe al sistema cuando este cambie */
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function(e){
      if(guardado()) return;
      aplicar(e.matches ? "oscuro" : "claro");
      if(window.pintarBotonTema) window.pintarBotonTema();
    });
  } catch(e){}
})();
