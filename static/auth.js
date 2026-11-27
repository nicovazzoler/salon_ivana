const TKEY="pelu_token", RKEY="pelu_rol", UKEY="pelu_user";
function getToken(){return localStorage.getItem(TKEY);}
function getRol(){return localStorage.getItem(RKEY);}
function getUser(){return localStorage.getItem(UKEY);}
function logout(){localStorage.removeItem(TKEY);localStorage.removeItem(RKEY);localStorage.removeItem(UKEY);location.href="/login";}
async function authFetch(url,opts){
  opts=opts||{};
  opts.headers=Object.assign({},opts.headers||{},{"Authorization":"Bearer "+getToken()});
  let r;
  try{ r=await fetch(url,opts); }
  catch(e){
    // Un pedido que se cortó a propósito (cambiar de pantalla) no es la red
    if(e.name !== "AbortError" && window.avisarConexion) avisarConexion(false);
    throw e;
  }
  if(window.avisarConexion) avisarConexion(true);
  if(r.status===401){logout();throw new Error("sesion vencida");}
  return r;
}
/* Pasa un presupuesto a ticket, que nace a cuenta. Lo usan Historial y la ficha
   de la clienta. Devuelve el mensaje para mostrar, o null si se canceló. */
async function convertirPresupuesto(id, boton){
  if(!await confirmar("¿Convertir este presupuesto en ticket?\n\nSe crea un ticket con los mismos ítems y queda a cuenta: el cobro se registra después.", { si: "Convertir" })) return null;
  if(boton) boton.disabled = true;
  try{
    const r = await authFetch("/api/comprobantes/"+id+"/convertir", {method:"POST"});
    const d = await r.json().catch(()=>({}));
    return r.ok ? "Convertido a N-"+String(d.numero).padStart(5,"0") : (d.detail || "No se pudo convertir");
  }catch(e){ return "Sin conexión: fijate en la lista si se convirtió antes de volver a tocar"; }
}
/* La clave de un cobro: se arma una vez y viaja en cada reintento, así el
   backend reconoce el pedido que ya hizo y no cobra dos veces. randomUUID solo
   existe en https y en localhost. */
function claveDeCobro(){
  if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
function requireLogin(){ if(!getToken()){location.href="/login";} }
function requireDueno(){ requireLogin(); if(getRol()!=="dueno"){location.href="/";} }
function esDueno(){ return getRol()==="dueno"; }

/* Deja en la pantalla lo que le corresponde a quien entró: se marca el elemento
   con data-dueno o data-empleado y acá se BORRA, no se esconde.

   Es ADEMÁS del control del backend y nunca en lugar de él: lo que de verdad no
   se puede hacer lo frena el servidor. */
function ajustarPorRol(raiz){
  const doc = raiz || document;
  const sobra = esDueno() ? "[data-empleado]" : "[data-dueno]";
  doc.querySelectorAll(sobra).forEach(el => el.remove());
}
window.ajustarPorRol = ajustarPorRol;
function pintarNav(){
  const nav=document.querySelector("nav.menu");
  if(!nav) return;
  const rol=getRol();
  const aqui=location.pathname;
  // Un solo lugar donde se definen los links del menú. Cambiás acá y se actualiza en todas las páginas.
  const links=[
    {href:"/",           txt:"Facturar"},
    // Depilación es facturar con todo lo que no se usa sacado. Va al lado porque
    // es la misma cosa: un cobro, por el mismo camino y con el mismo comprobante.
    {href:"/depilacion", txt:"Depilación"},
    // Caja va pegada a Facturar porque es el otro lado del mismo movimiento: se
    // cobra y se mira cuánto entró, muchas veces seguidas en el mismo rato.
    {href:"/caja",       txt:"Caja"},
    {href:"/clientes",   txt:"Clientes"},
    {href:"/historial",  txt:"Historial"},
    {href:"/agenda",     txt:"Agenda"},
    // Inventario y Admin son también del empleado, recortados: lee las
    // cantidades sin tocarlas y maneja las listas con las que factura, no los
    // usuarios ni el backup. Reportes es solo de la dueña.
    {href:"/inventario", txt:"Inventario"},
    // Sueldos lo usan los dos, pero para cosas distintas: la empleada carga sus
    // horas y la dueña mira lo que debe y cierra el ciclo.
    {href:"/sueldos",    txt:"Sueldos"},
    {href:"/reportes",   txt:"Reportes",   dueno:true},
    {href:"/admin",      txt:"Admin"},
  ];
  let html="";
  for(const l of links){
    if(l.dueno && rol!=="dueno") continue;   // los empleados no ven los links de dueño
    const esActual = (l.href===aqui) || (l.href==="/" && aqui==="/facturar");
    html+=`<a href="${l.href}"${esActual?' class="actual"':''}>${l.txt}</a>`;
  }
  html+=`<a href="#" onclick="logout();return false;">Salir</a>`;
  /* En el celular los diez links se parten en tres filas y comen media
     pantalla, así que van adentro de un cajón que abre el botón de las tres
     rayas. De tablet para arriba el cajón es la fila de siempre. */
  html=`<div class="links">${html}</div>`;
  /* Interruptor, no botón: se ven los dos destinos a la vez y la perilla marca
     en cuál estás. role="switch" para que un lector de pantalla lo anuncie como
     lo que es. Queda afuera del cajón: se usa seguido y ocupa nada. */
  html+=`<button type="button" class="sw-tema" id="btnTema" role="switch" aria-label="Modo oscuro">`
      + `<span class="pista">${ICONO_SOL}${ICONO_LUNA}<span class="perilla"></span></span></button>`;
  html+=`<button type="button" class="hamb" id="btnMenu" aria-label="Menú"`
      + ` aria-expanded="false">${icono("menu")}</button>`;
  nav.innerHTML=html;
  engancharHamburguesa(nav);
  pintarBotonTema();
  marcarBorradorEnMenu();
  avisarPasswordDeFabrica();
}

/* El cajón del menú en pantallas chicas.

   Se cierra al tocar afuera y con Escape, y NO al tocar un link: el link navega
   y la página se vuelve a dibujar con el cajón cerrado de fábrica. Cerrarlo a
   mano antes de navegar solo hace que la pantalla parpadee. */
function engancharHamburguesa(nav){
  const boton = nav.querySelector(".hamb");
  if(!boton) return;
  const cerrar = () => {
    nav.classList.remove("abierto");
    boton.setAttribute("aria-expanded", "false");
  };
  boton.onclick = ev => {
    ev.stopPropagation();
    const abrir = !nav.classList.contains("abierto");
    nav.classList.toggle("abierto", abrir);
    boton.setAttribute("aria-expanded", String(abrir));
  };
  document.addEventListener("click", ev => {
    if(nav.classList.contains("abierto") && !nav.contains(ev.target)) cerrar();
  });
  document.addEventListener("keydown", ev => { if(ev.key === "Escape") cerrar(); });
}

/* Aviso de contraseña sin cambiar. Las de fábrica están en seed_datos.py y el
   repositorio es público: mientras alguien use una, entrar es cuestión de saber
   la dirección. El cartel va en todas las pantallas y NO se puede cerrar: uno
   que se tapa se tapa el primer día y no se ve nunca más. */
async function avisarPasswordDeFabrica(){
  if(!getToken() || document.getElementById("avisoSeguridad")) return;
  let yo;
  try{ yo = await (await authFetch("/api/yo")).json(); }catch(e){ return; }

  const mia = yo.password_de_fabrica;
  const otros = (yo.usuarios_sin_cambiar || []).filter(u => u !== yo.usuario);
  if(!mia && !otros.length) return;

  const partes = [];
  if(mia) partes.push("Tu contraseña sigue siendo la que vino de fábrica.");
  if(otros.length) partes.push(
    `${otros.length===1 ? "El usuario" : "Los usuarios"} ${otros.join(", ")} `
    + `${otros.length===1 ? "sigue" : "siguen"} con la contraseña de fábrica.`);

  const barra = document.createElement("div");
  barra.id = "avisoSeguridad";
  barra.className = "aviso-seguridad";
  barra.innerHTML = `<span>${partes.join(" ")} Cualquiera que sepa la dirección de la app puede entrar.</span>`
    + (getRol()==="dueno" ? ` <a href="/admin#usuarios">Cambiarla ahora</a>` : "");
  document.body.insertBefore(barra, document.body.firstChild);
}

/* Cuánto vive un ticket a medio cargar antes de descartarse solo. El borrador
   es para el ida y vuelta de un rato, no para retomar mañana: pasado eso,
   ofrecerlo como si fuera el ticket de la clienta que está adelante es peor que
   perderlo. Vive acá para que el menú y facturar no usen dos plazos. */
const BORRADOR_HORAS = 1;
window.BORRADOR_HORAS = BORRADOR_HORAS;

/* Si quedó un ticket a medio cargar, el link de Facturar lo muestra con un
   puntito. Se lee del borrador en localStorage, así que la marca aparece en
   TODAS las pantallas, no solo en facturar: la idea es enterarse mientras
   estás en otro lado, que es justo cuando uno se olvida. */
function marcarBorradorEnMenu(){
  const link = document.querySelector('nav.menu a[href="/"], nav.menu a[href="/facturar"]');
  if(!link) return;
  let hay = false, cuantos = 0;
  try{
    const d = JSON.parse(localStorage.getItem("ticketBorrador") || "null");
    // el mismo plazo con el que facturar lo descarta
    if(d && Date.now() - (d.guardado||0) < BORRADOR_HORAS*3600*1000){
      cuantos = (d.ticket||[]).length;
      hay = cuantos > 0 || (d.extras||[]).length > 0;
    }
  }catch(e){}
  link.classList.toggle("con-borrador", hay);
  link.title = hay ? `Ticket en borrador: ${cuantos} ${cuantos===1?"ítem":"ítems"} sin cobrar` : "";
}
window.marcarBorradorEnMenu = marcarBorradorEnMenu;

/* Sol y luna dibujados, no en emoji: los ☀/☾ del teclado dependen de la fuente
   que tenga el aparato y en la tablet del local pueden salir como un asterisco
   o de otro color. Así se ven iguales en todos lados y toman el color del botón
   (por eso el stroke es currentColor y no un dorado fijo). */
const ICONO_SOL = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none"
  stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
  <circle cx="12" cy="12" r="4.2"/>
  <path d="M12 2.4v2.4M12 19.2v2.4M2.4 12h2.4M19.2 12h2.4
           M5.2 5.2l1.7 1.7M17.1 17.1l1.7 1.7M18.8 5.2l-1.7 1.7M6.9 17.1l-1.7 1.7"/>
</svg>`;
const ICONO_LUNA = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none"
  stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">
  <path d="M20.5 14.6A8.6 8.6 0 0 1 9.4 3.5a8.6 8.6 0 1 0 11.1 11.1Z"/>
</svg>`;

/* Íconos de línea (Lucide, licencia ISC) en vez de emojis: cada aparato dibuja
   los emojis a su manera y con sus colores. Estos toman el color del texto. */
const ICONOS = {
  lapiz: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>',
  cruz: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  impresora: '<path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
  calendario: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  candado: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  guardar: '<path d="M20 6 9 17l-5-5"/>',
  nota: '<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5z"/><path d="M15 3v6h6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  flecha: '<path d="m9 18 6-6-6-6"/>',
  billete: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
  bolsa: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
};
function icono(nombre){
  return `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"`
       + ` stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONOS[nombre]}</svg>`;
}

/* En el interruptor los dos íconos están siempre a la vista y lo que se mueve es
   la perilla: se entiende de un vistazo en cuál de los dos modos estás, sin
   tener que deducirlo del ícono. Se dibuja acá para que aparezca en todas las
   pantallas sin tocar once archivos. */
function pintarBotonTema(){
  const b = document.getElementById("btnTema");
  if(!b) return;
  const oscuro = document.documentElement.getAttribute("data-tema") === "oscuro";
  b.setAttribute("aria-checked", oscuro ? "true" : "false");
  b.title = oscuro ? "Pasar a modo claro" : "Pasar a modo oscuro";
  b.onclick = () => { if(window.alternarTema) window.alternarTema(); };
}
window.pintarBotonTema = pintarBotonTema;

/* Partículas que van en minúscula dentro de un nombre ("María de los Ángeles").
   Tiene que coincidir con _PARTICULAS de main.py: el backend normaliza al
   guardar y esto muestra igual los nombres viejos, que quedaron sin normalizar. */
/* Para buscar: minúscula y sin acentos, así "nunez" encuentra a "Núñez". Es la
   misma cuenta que _plano() del backend, que es el que busca clientes y tickets. */
function sinAcentos(t){
  return String(t ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/* Sugerencias debajo de un campo, sin importar los acentos. Reemplaza al
   <datalist>, que el navegador filtra a su manera y "nunez" no le trae "Núñez".
   `opciones` es una función: la lista puede cargarse después de enganchar. */
function sugerirEn(input, opciones, max = 8){
  const caja = input.parentElement;
  if(getComputedStyle(caja).position === "static") caja.style.position = "relative";
  const lista = document.createElement("div");
  lista.className = "sugerencias"; lista.hidden = true;
  caja.appendChild(lista);
  let marcada = -1;
  const elegir = valor => {
    input.value = valor; lista.hidden = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const pintar = () => {
    const q = sinAcentos(input.value.trim());
    if(!q){ lista.hidden = true; return; }
    const todas = opciones().filter(o => sinAcentos(o).includes(q));
    // Primero las que empiezan con lo tipeado: es lo que se está buscando casi siempre.
    todas.sort((a, b) => sinAcentos(b).startsWith(q) - sinAcentos(a).startsWith(q));
    const vistas = todas.slice(0, max);
    if(!vistas.length || (vistas.length === 1 && vistas[0] === input.value.trim())){ lista.hidden = true; return; }
    marcada = -1;
    lista.innerHTML = vistas.map(o => `<button type="button" tabindex="-1">${String(o).replace(/[&<>"]/g,
      c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}</button>`).join("");
    lista.querySelectorAll("button").forEach((b, i) => {
      b.onmousedown = e => e.preventDefault();          // que el campo no pierda el foco antes del click
      b.onclick = () => elegir(vistas[i]);
    });
    lista.hidden = false;
  };
  input.setAttribute("autocomplete", "off");
  input.addEventListener("input", pintar);
  input.addEventListener("blur", () => { lista.hidden = true; });
  input.addEventListener("keydown", e => {
    const bs = [...lista.querySelectorAll("button")];
    if(lista.hidden || !bs.length) return;
    if(e.key === "ArrowDown" || e.key === "ArrowUp"){
      e.preventDefault();
      marcada = (marcada + (e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length;
      bs.forEach((b, i) => b.classList.toggle("on", i === marcada));
    } else if(e.key === "Enter" && marcada >= 0){
      e.preventDefault(); elegir(bs[marcada].textContent);
    } else if(e.key === "Escape"){
      lista.hidden = true;
    }
  });
}

const PARTICULAS = new Set(["de","del","la","las","los","y","e","da","das","do",
                            "dos","van","von","di","der","el"]);

/* Pregunta si se anula y por qué, en un solo cartel. Devuelve el motivo, o null
   si se canceló. El backend lo exige siempre; acá se valida el largo nada más,
   para no hacer un viaje al servidor por un campo vacío. */
const MOTIVOS_ANULAR = ["Cargado dos veces", "Se cargó mal", "No se hizo"];
const MOTIVOS_SENA = ["Se le devolvió la plata", "Cargada dos veces", "Se cargó mal"];
async function pedirMotivo(titulo, { texto = "", si = "Anular", opciones = MOTIVOS_ANULAR } = {}){
  const m = await preguntar({ titulo, texto, si, peligro: true, pideTexto: true, opciones });
  if(m === null) return null;            // canceló: no es un motivo vacío
  if(m.trim().length < 3){ toast("Hace falta decir por qué"); return null; }
  return m.trim();
}

/* Los carteles de la app, en lugar de confirm() y prompt() del navegador. Con
   pideTexto devuelve el texto o null; sin él, true o false. Las `opciones` se
   tocan para no tipear en la tablet; `linea` pide un texto corto con `valor` puesto. */
function preguntar({ titulo, texto = "", si = "Aceptar", no = "Volver", peligro = false,
                     pideTexto = false, opciones = [], linea = false, valor = "", minimo = 3 }){
  return new Promise(resolver => {
    const fondo = document.createElement("div");
    fondo.className = "dlg-fondo";
    const entrada = linea ? '<input type="text">' : '<textarea rows="2" placeholder="¿Por qué?"></textarea>';
    fondo.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlgTitulo">
      <h3 id="dlgTitulo"></h3><p class="dlg-p"></p>
      ${pideTexto ? `<div class="dlg-cuerpo"><div class="chips"></div>${entrada}</div>` : ""}
      <div class="dlg-acciones"><button type="button" class="b-out dlg-no"></button>
        <button type="button" class="dlg-si${peligro ? " peligro" : ""}"></button></div></div>`;
    // "N-00303" no se parte en el guion
    fondo.querySelector("h3").textContent = titulo.replace(/\b([NP])-(\d)/g, "$1\u2011$2");
    const p = fondo.querySelector(".dlg-p");
    if(texto) p.textContent = texto; else p.remove();
    const bSi = fondo.querySelector(".dlg-si"), bNo = fondo.querySelector(".dlg-no");
    bSi.textContent = si;
    if(no === null) bNo.remove(); else bNo.textContent = no;   // null: es un aviso, no una pregunta
    const campo = fondo.querySelector("textarea, input");
    const respuesta = () => campo ? campo.value.trim() : true;
    const nada = () => campo ? null : false;
    if(campo){
      campo.value = valor;
      const chips = fondo.querySelector(".chips");
      opciones.forEach(o => {
        const c = document.createElement("button");
        c.type = "button"; c.textContent = o;
        c.onclick = () => { campo.value = o; habilitar(); chips.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === c)); };
        chips.appendChild(c);
      });
      if(!opciones.length) chips.remove();
      campo.oninput = habilitar;
    }
    function habilitar(){ bSi.disabled = !!campo && campo.value.trim().length < minimo; }
    function cerrar(v){ fondo.remove(); removeEventListener("keydown", tecla, true); resolver(v); }
    function tecla(e){
      if(e.key === "Escape"){ e.preventDefault(); cerrar(nada()); }
      else if(e.key === "Enter" && linea && !bSi.disabled){ e.preventDefault(); cerrar(respuesta()); }
    }
    bSi.onclick = () => cerrar(respuesta());
    if(no !== null) bNo.onclick = () => cerrar(nada());
    fondo.onclick = e => { if(e.target === fondo) cerrar(nada()); };
    addEventListener("keydown", tecla, true);
    habilitar();
    document.body.appendChild(fondo);
    if(campo){ campo.focus(); if(linea) campo.select(); } else bSi.focus();
  });
}

/* La altura del encabezado, para lo que se pega justo debajo (las pestañas de Admin):
   con un número fijo, cuando el encabezado ocupaba dos renglones lo tapaban. */
(function(){
  const h = document.querySelector("header");
  if(h && window.ResizeObserver)
    new ResizeObserver(() => document.documentElement.style.setProperty("--alto-header", h.offsetHeight + "px")).observe(h);
})();

/* La barra de cobro de abajo (Facturar y Depilación): repite el total y el botón
   principal mientras ese botón está fuera de la vista. No cobra por su cuenta:
   toca ese mismo botón, o lleva hasta él si todavía no se puede. */
function engancharBarraCobro({ barra, botones, total, cantidad, observar }){
  if(!barra) return;
  const btn = barra.querySelector("button");
  const principal = () => botones.find(b => b && b.offsetParent !== null);
  const aLaVista = new Map();
  function pintar(){
    const n = cantidad(), b = principal();
    barra.hidden = n === 0 || !b || aLaVista.get(b);
    if(barra.hidden) return;
    barra.querySelector(".tot").textContent = total();
    barra.querySelector(".cant").textContent = `· ${n} ${n === 1 ? "ítem" : "ítems"}`;
    btn.textContent = b.disabled ? "Ir al ticket" : (b.dataset.corto || b.textContent);
    btn.className = b.disabled ? "b-out" : "b-ok";
  }
  btn.onclick = () => {
    const b = principal(); if(!b) return;
    b.scrollIntoView({ block:"center", behavior:"smooth" });
    if(!b.disabled) b.click();
  };
  new MutationObserver(pintar).observe(observar,
    { subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:["style", "disabled", "hidden"] });
  const io = new IntersectionObserver(es => { es.forEach(e => aLaVista.set(e.target, e.isIntersecting)); pintar(); },
                                      { threshold: 0.6 });
  botones.forEach(b => b && io.observe(b));
  pintar();
}

/* Para los mensajes que ya vienen escritos como un confirm(): el primer párrafo
   va de título y el resto de texto. `si` es el verbo del botón. */
function confirmar(mensaje, { si = "Seguir", no = "Volver", peligro = false } = {}){
  const [titulo, ...resto] = String(mensaje).split("\n\n");
  return preguntar({ titulo, texto: resto.join("\n\n"), si, no, peligro });
}

function titulo(str){
  // Ojo: \b de JS es ASCII, así que "maría" caía en "MarÍa" (la í cuenta como
  // borde de palabra). Por eso se parte por letras y no por bordes de palabra.
  let primera = true;
  return (str||"").toLowerCase().replace(/\p{L}[\p{L}\p{M}]*/gu, pal => {
    const arranque = primera; primera = false;
    // la primera palabra siempre va en mayúscula: "De Luca" como apellido cuenta
    if(!arranque && PARTICULAS.has(pal)) return pal;
    return pal.charAt(0).toUpperCase() + pal.slice(1);
  });
}
/* El estudio de uso: /clarity.js viene vacío mientras no esté prendido. Desde
   acá y no desde cada página para que el login no se grabe. */
(function(){
  const s=document.createElement("script");
  s.src="/clarity.js"; s.async=true;
  document.head.appendChild(s);
})();
