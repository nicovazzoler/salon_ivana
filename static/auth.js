const TKEY="pelu_token", RKEY="pelu_rol", UKEY="pelu_user";
function getToken(){return localStorage.getItem(TKEY);}
function getRol(){return localStorage.getItem(RKEY);}
function getUser(){return localStorage.getItem(UKEY);}
function logout(){localStorage.removeItem(TKEY);localStorage.removeItem(RKEY);localStorage.removeItem(UKEY);location.href="/login";}
async function authFetch(url,opts){
  opts=opts||{};
  opts.headers=Object.assign({},opts.headers||{},{"Authorization":"Bearer "+getToken()});
  const r=await fetch(url,opts);
  if(r.status===401){logout();throw new Error("sesion vencida");}
  return r;
}
function requireLogin(){ if(!getToken()){location.href="/login";} }
function requireDueno(){ requireLogin(); if(getRol()!=="dueno"){location.href="/";} }
function pintarNav(){
  const nav=document.querySelector("nav.menu");
  if(!nav) return;
  const rol=getRol();
  const aqui=location.pathname;
  // Un solo lugar donde se definen los links del menú. Cambiás acá y se actualiza en todas las páginas.
  const links=[
    {href:"/",           txt:"Facturar"},
    {href:"/clientes",   txt:"Clientes"},
    {href:"/historial",  txt:"Historial"},
    {href:"/agenda",     txt:"Agenda"},
    {href:"/caja",       txt:"Caja"},
    {href:"/inventario", txt:"Inventario", dueno:true},
    {href:"/reportes",   txt:"Reportes",   dueno:true},
    {href:"/admin",      txt:"Admin",      dueno:true},
  ];
  let html="";
  for(const l of links){
    if(l.dueno && rol!=="dueno") continue;   // los empleados no ven los links de dueño
    const esActual = (l.href===aqui) || (l.href==="/" && aqui==="/facturar");
    html+=`<a href="${l.href}"${esActual?' class="actual"':''}>${l.txt}</a>`;
  }
  html+=`<a href="#" onclick="logout();return false;">Salir</a>`;
  // la marca se agrega después, cuando el nav ya está en el DOM
  /* Interruptor, no botón: se ven los dos destinos a la vez y la perilla marca
     en cuál estás. role="switch" para que un lector de pantalla lo anuncie como
     lo que es. */
  html+=`<button type="button" class="sw-tema" id="btnTema" role="switch" aria-label="Modo oscuro">`
      + `<span class="pista">${ICONO_SOL}${ICONO_LUNA}<span class="perilla"></span></span></button>`;
  nav.innerHTML=html;
  pintarBotonTema();
  marcarBorradorEnMenu();
  avisarPasswordDeFabrica();
}

/* Aviso de contraseña sin cambiar.

   Las contraseñas con las que se crean los usuarios están escritas en
   seed_datos.py, y el repositorio es público: mientras alguien siga usando una,
   entrar a la app es cuestión de saber la dirección. El backend lo detecta y lo
   dice en /api/yo.

   El cartel va arriba de todo, en todas las pantallas, y no se puede cerrar:
   un aviso que se puede tapar se tapa el primer día y no se lo ve nunca más.
   Desaparece solo cuando la contraseña se cambia de verdad. */
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
  barra.innerHTML = `<span>🔓 ${partes.join(" ")} Cualquiera que sepa la dirección de la app puede entrar.</span>`
    + (getRol()==="dueno" ? ` <a href="/admin#usuarios">Cambiarla ahora</a>` : "");
  document.body.insertBefore(barra, document.body.firstChild);
}

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
    // el borrador se descarta solo a las 12 horas; acá se respeta lo mismo
    if(d && Date.now() - (d.guardado||0) < 12*3600*1000){
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
const PARTICULAS = new Set(["de","del","la","las","los","y","e","da","das","do",
                            "dos","van","von","di","der","el"]);

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