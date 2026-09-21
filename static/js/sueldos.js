/* Sueldos, la pantalla de la empleada.

   Entra, elige su nombre y ve lo que se le debe hoy. Lo único que carga a mano
   son dos cosas: cuántas horas hizo cada día y cuánto duró cada trabajo a
   comisión. Todo lo demás —qué trabajos hizo, cuánto valen, la cuenta— sale de
   los comprobantes.

   El ciclo no es la semana: es "lo que todavía no se pagó". Por eso acá no hay
   fechas de corte ni navegación entre semanas. Lo que aparece es lo pendiente, y
   desaparece cuando la dueña cierra y paga. */
requireLogin(); pintarNav(); ajustarPorRol();

const $=s=>document.querySelector(s);
const fmt=n=>"$"+(n||0).toLocaleString("es-AR");
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function toast(m){const t=$("#toast");t.textContent=m;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2200);}

/* Con el usuario empleado, la pantalla se abre con un código por persona.

   El permiso vive acá, en memoria, y no en localStorage: se pide cada vez que se
   entra a la pantalla, que es lo que se pidió, y así el que agarra la tablet
   después no encuentra la sesión de la otra abierta. Esto es comodidad y orden;
   el candado de verdad lo pone el servidor, que sin este permiso no contesta el
   sueldo de nadie.

   La dueña no pasa por acá: es la que paga y ve a todas. */
let PERMISO = null, YO = null;

async function pedir(url, opts){
  opts = opts || {};
  if(PERMISO) opts.headers = Object.assign({}, opts.headers || {}, {"X-Sueldo": PERMISO});
  const r = await authFetch(url, opts);
  // 403 en esta pantalla es siempre lo mismo: el permiso no vale más (se venció
  // el rato o se cerró de otro lado). En vez de dejar la pantalla mostrando
  // números que ya no se pueden guardar, se vuelve a pedir el código.
  if(r.status === 403 && PERMISO) cerrarPuerta("Se venció el rato. Poné tu código de nuevo.");
  return r;
}

/* Para la dueña, cuál de las empleadas está mirando queda guardado en el aparato:
   entra muchas veces seguidas a la misma. */
const RECUERDO = "sueldos_empleado";

let EMPLEADOS = [], ITEMS = [], EMP = null, D = null, FORMAS = [];
// Todas las activas, aparte de EMPLEADOS: a la empleada esa lista se le
// recorta a ella sola, y para elegir a la ayudante del lunes necesita ver a
// las demás. Son los mismos nombres que ya ve en el desplegable de facturar.
let TODAS = [];
// Lo pendiente de cada una, que arma el panel de la dueña. Lo usa el desplegable
// para decidir a quién sigue mostrando.
let PENDIENTE = {};

/* A quién se le paga sueldo.

   La dueña está en la lista de empleadas —atiende— pero no se paga sueldo a sí
   misma, y sin código de sueldo es un nombre de más en todos los desplegables de
   esta pantalla. El código es la señal: el que cobra acá tiene uno para entrar a
   ver lo suyo.

   Si igual le quedó algo pendiente, aparece. Esconder plata que se debe es peor
   que mostrar un nombre de más. */
const seLePaga = e => e.tiene_pin !== false || (PENDIENTE[e.id] || 0) > 0;
const DUENO = esDueno();
/* La misma tarjeta la miran dos personas distintas: la empleada mira lo suyo y
   la dueña mira lo de otra. Los rótulos cambian con eso, porque "se te debe" en
   la pantalla de la dueña es directamente falso. */
const VOS = {
  debe:   DUENO ? "Se le debe" : "Se te debe",
  quien:  DUENO ? "Empleada" : "Quién sos",
  sinNada: DUENO ? "No tiene nada pendiente" : "No tenés nada pendiente",
  comoAparece: DUENO ? "Los días aparecen solos cuando se cobra un ticket a su nombre con un ítem a comisión."
                     : "Los días aparecen solos cuando se cobra un ticket a tu nombre con un ítem a comisión.",
};

/* Las horas se muestran como las dice la gente ("8 h 30"), nunca en decimales:
   "8,5 h" se lee mal y se tipea peor. Adentro siempre son minutos enteros, que
   es lo que se guarda: con decimales, media hora a $4.000 termina en centavos
   que no existen. */
function hhmm(min){
  min = Math.max(0, min|0);
  const h = Math.floor(min/60), m = min%60;
  if(!h) return m + " min";
  return h + " h" + (m ? " " + String(m).padStart(2,"0") : "");
}

/* La fecha de hoy en argentino, sin pasar por toISOString(): eso pasa a UTC y
   después de las 21 devuelve el día siguiente, que es justo cuando el local
   sigue trabajando. */
function hoyArg(){
  const d = new Date(Date.now() - 3*3600*1000);
  return d.toISOString().slice(0,10);
}
function fechaCorta(iso){
  if(!iso) return "";
  const [a,m,d] = iso.split("-");
  return `${d}/${m}`;
}
const MESES = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];
/* "Mar 2 a sáb 6 de septiembre". El ciclo se nombra por sus días, no por un
   número de semana: nadie sabe en qué semana del año está, pero todos saben qué
   martes fue. */
function rangoLargo(desde, hasta){
  if(!desde) return "";
  if(desde === hasta) return `${diaDe(desde)} ${fechaCorta(desde)}`;
  const [, mA] = desde.split("-"), [, mB] = hasta.split("-");
  const d1 = desde.split("-")[2], d2 = hasta.split("-")[2];
  return mA === mB
    ? `${Number(d1)} al ${Number(d2)} de ${MESES[Number(mA)-1]}`
    : `${Number(d1)} de ${MESES[Number(mA)-1]} al ${Number(d2)} de ${MESES[Number(mB)-1]}`;
}
const DIAS = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
function diaDe(iso){
  if(!iso) return "";
  const [a,m,d] = iso.split("-").map(Number);
  return DIAS[new Date(a, m-1, d).getDay()];
}

async function arranque(){
  // La dueña ve también a las dadas de baja: mientras tengan algo pendiente hay
  // que pagárselo, y esconderlas sería perderles el sueldo de la última semana.
  // La empleada se ve solo a ella: entró con su código y el resto no es asunto
  // suyo (el servidor tampoco se lo contestaría).
  EMPLEADOS = await listaEmpleados();
  TODAS = await (await pedir("/api/empleados")).json();
  const sel = $("#quien");
  sel.onchange = () => { localStorage.setItem(RECUERDO, sel.value); cargar(); };
  if(DUENO){
    // Para la dueña la tarjeta de abajo no es "tus horas": es el detalle de la
    // que está mirando. El selector de arriba sigue existiendo porque es lo que
    // dice de quién es lo que se ve.
    $("#tituloDetalle").textContent = "Detalle";
    $("#bajadaDetalle").textContent = "Lo que se le debe, ciclo por ciclo. Cada semana se cierra por separado.";
    $("#rotuloQuien").textContent = VOS.quien;
  } else {
    $("#tituloDetalle").textContent = "👛 Tu sueldo";
    $("#bajadaDetalle").textContent = "Poné cuánto duró cada trabajo y las horas de cada día. El total se actualiza solo.";
  }
  // Ordenados por nombre: el desplegable se usa buscando uno puntual, y el orden
  // en que los devuelve la base no le dice nada al que busca.
  ITEMS = (await (await pedir("/api/sueldos/items-comision")).json())
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  if(DUENO){
    // Las mismas formas de pago con las que se cobra: el egreso del sueldo entra
    // a la caja como cualquier otro, y el arqueo lo suma si dice "Efectivo".
    const cfg = await (await pedir("/api/config")).json();
    FORMAS = cfg.formas_pago || [];
  }
  if(!EMPLEADOS.length){ llenarSelector(); return; }
  // El panel de la dueña va primero porque es el que sabe cuánto se le debe a
  // cada una, y de eso depende quién aparece en el desplegable.
  if(DUENO) await cargarPanelDueno(); else await pintarLiquidaciones();
  llenarSelector();
  await cargar();
}

async function listaEmpleados(){
  const todos = await (await pedir("/api/empleados" + (DUENO ? "?todos=true" : ""))).json();
  return DUENO ? todos : todos.filter(e => e.id === YO);
}

/* El selector es de dónde sale TODO lo demás: si queda apuntando a alguien que
   ya no está, la pantalla muestra el sueldo de otra. Por eso se redibuja entero
   cada vez que cambia la lista, respetando lo que estaba elegido. */
function llenarSelector(){
  const sel = $("#quien");
  const antes = sel.value || localStorage.getItem(RECUERDO);
  if(!EMPLEADOS.length){
    sel.closest(".quien").style.display = "none";
    $("#totales").innerHTML = "";
    $("#cuerpo").innerHTML = `<div class="vacio"><b>Todavía no hay nadie en la lista</b>
      ${DUENO ? "Agregalos más abajo, en “Cómo se calcula”." : "La dueña los carga desde esta misma pantalla."}</div>`;
    return;
  }
  // Para la empleada el bloque ya se escondió al entrar con el código: su nombre
  // está arriba y no hay nada que elegir.
  if(DUENO) sel.closest(".quien").style.display = "";
  const visibles = DUENO ? EMPLEADOS.filter(seLePaga) : EMPLEADOS;
  sel.innerHTML = visibles.map(e=>`<option value="${e.id}">${esc(e.nombre)}${e.activo===false?" (de baja)":""}</option>`).join("");
  if(antes && visibles.some(e=>String(e.id)===String(antes))) sel.value = antes;
  if(DUENO) localStorage.setItem(RECUERDO, sel.value);
}

/* Después de cualquier cambio se vuelve a leer todo del servidor: la cuenta la
   hace él, y repetirla acá sería tener dos versiones del sueldo. Es barato
   —son dos empleadas y una lista corta— y evita que la pantalla muestre un
   total viejo al lado de un detalle nuevo. */
async function refrescar(){
  EMPLEADOS = await listaEmpleados();
  if(!EMPLEADOS.length){ llenarSelector(); return; }
  if(DUENO) await cargarPanelDueno(); else await pintarLiquidaciones();
  llenarSelector();
  await cargar();
}

/* ---------- lo que ve solo la dueña ---------- */

async function cargarPanelDueno(){
  const card = $("#cardDueno");
  if(!card) return;
  card.style.display = "";
  // Un pedido por empleada: son dos o tres. Hacer un endpoint que devuelva todo
  // junto sería otra versión de la misma cuenta para mantener al lado de esta.
  const todos = await Promise.all(EMPLEADOS.map(async e =>
    ({...await (await pedir("/api/sueldos/pendiente?empleado_id="+e.id)).json(),
      activo: e.activo !== false})));
  // A las dadas de baja se las sigue viendo SOLO si les quedó algo sin pagar:
  // mientras haya algo pendiente hay que pagárselo, pero una que se fue hace
  // meses y ya cobró todo no tiene por qué seguir en la lista de todos los días.
  PENDIENTE = Object.fromEntries(todos.map(r => [r.empleado.id, r.total]));
  const conCodigo = Object.fromEntries(EMPLEADOS.map(e => [e.id, e.tiene_pin !== false]));
  const resumenes = todos.filter(r => (r.activo || r.total > 0 || r.ciclos.length)
                                   && (conCodigo[r.empleado.id] || r.total > 0 || r.ciclos.length));
  /* El general sale de config y NO del resumen de la primera de la lista.
     Cuando cada una podía tener el suyo, `resumenes[0].valor_hora` pasó a ser el
     de esa persona: el casillero de abajo edita el general, y con eso adentro,
     guardarlo le ponía a todas el sueldo de la primera del abecedario. */
  const gral = await pedir("/api/config").then(r=>r.json()).catch(()=>({}));
  const distintas = resumenes.filter(r => r.valor_hora !== (gral.valor_hora ?? 0)).length;
  const total = resumenes.reduce((a,r)=>a+r.total, 0);
  const ciclosViejos = resumenes.reduce((a,r)=>a + Math.max(r.ciclos.length - 1, 0), 0);
  $("#kpisDueno").innerHTML = `
    <div class="kpi"><span class="lbl">Total a pagar</span><span class="val">${fmt(total)}</span></div>
    <div class="kpi"><span class="lbl">Valor hora</span><span class="val">${fmt(gral.valor_hora ?? 0)}</span>${
      distintas ? `<span class="nota">${distintas} ${distintas===1?"cobra":"cobran"} distinto</span>` : ""}</div>
    ${ciclosViejos ? `<div class="kpi"><span class="lbl">Semanas atrasadas</span><span class="val">${ciclosViejos}</span></div>` : ""}`;
  $("#listaEmpleadas").innerHTML = resumenes.map(r=>`
    <div class="fila-emp${r.empleado.id===EMP?" abierta":""}">
      <div>
        <b>${esc(r.empleado.nombre)}${r.activo ? "" : " · de baja"}</b>
        <span class="det">${r.valor_hora !== (gral.valor_hora ?? 0) ? `${fmt(r.valor_hora)} la hora · ` : ""}${
          r.ciclos.length ? `${r.ciclos.length} ${r.ciclos.length===1?"ciclo":"ciclos"} · ${hhmm(r.minutos_total)}` : "sin nada pendiente"}${
          r.sin_tiempo ? ` · <span style="color:var(--danger);">${r.sin_tiempo===1 ? "falta 1 duración" : `faltan ${r.sin_tiempo} duraciones`}</span>` : ""}${
          r.sin_horas ? ` · <span style="color:var(--danger);">${r.sin_horas===1 ? "falta 1 día sin horas" : `faltan ${r.sin_horas} días sin horas`}</span>` : ""}</span>
      </div>
      <div class="plata">${fmt(r.total)}</div>
      <button class="b-out ver" data-emp="${r.empleado.id}">Ver</button>
    </div>`).join("") || `<div class="vacio"><b>No hay empleados cargados</b>
      Agregalos más abajo y ahí empiezan a aparecer acá.</div>`;
  // "Ver" cambia la empleada del detalle, que está más abajo en la página: sin
  // el scroll, tocarlo parecía no hacer nada.
  $("#listaEmpleadas").querySelectorAll(".ver").forEach(b=>{
    b.onclick = async () => {
      $("#quien").value = b.dataset.emp;
      localStorage.setItem(RECUERDO, b.dataset.emp);
      await cargar();
      $("#tituloDetalle").closest(".card").scrollIntoView({behavior:"smooth", block:"start"});
    };
  });

  // El mismo editor que usa Admin arriba de la lista de empleados: los dos
  // números son uno solo y no pueden dibujarse en dos lados distintos.
  panelGenerales($("#cfgGenerales"), () => cargarPanelDueno());
  pintarArranque(resumenes[0] ? resumenes[0].arranque : null);

  pintarLiquidaciones();
}

/* El borrón y cuenta nueva.

   Lo de antes del corte se pagó a mano, por fuera de la app, y no tiene que
   volver a aparecer como pendiente. NO borra nada: los trabajos y las horas
   siguen guardados, así que correr el corte para atrás los devuelve enteros.
   Por eso es esto y no un botón de borrar ciclos viejos, que sí sería para
   siempre y con la plata de otro. */
function pintarArranque(actual){
  const cont = $("#cfgArranque");
  if(!cont) return;
  cont.innerHTML = `
    <div class="arranque">
      <span>${actual
        ? `Los sueldos cuentan desde el <b>${fechaCorta(actual)}</b>. Lo anterior no aparece.`
        : "Los sueldos cuentan desde siempre."}</span>
      <input type="date" class="arrFecha" value="${actual || hoyArg()}" max="${hoyArg()}">
      <button class="b-out btn-mini arrOk">Mover el corte</button>
      ${actual ? `<button class="b-out btn-mini arrNo">Quitarlo</button>` : ""}
    </div>`;
  cont.querySelector(".arrOk").onclick = async () => {
    const f = cont.querySelector(".arrFecha").value;
    if(!f){ toast("Elegí desde qué día"); return; }
    if(!confirm(`Los sueldos van a contar desde el ${fechaCorta(f)}.\n\n`
      + "Lo de antes deja de aparecer como pendiente. No se borra nada: si te "
      + "equivocás, corrés el corte para atrás y vuelve todo.")) return;
    if(await mandar("/api/sueldos/arranque", "PUT", {fecha: f})) toast("Corte movido ✓");
  };
  const quitar = cont.querySelector(".arrNo");
  if(quitar) quitar.onclick = async () => {
    if(!confirm("Van a volver a aparecer todos los ciclos anteriores al corte. ¿Seguimos?")) return;
    if(await mandar("/api/sueldos/arranque", "PUT", {fecha: null})) toast("Corte quitado ✓");
  };
}

/* Lo ya pagado, agrupado por ciclo. Un ciclo cerrado es una semana del local:
   adentro van las empleadas que cobraron esa semana, y adentro de cada una sus
   trabajos. Ordenado así se lee "qué pagué la semana del 2", que es la pregunta
   que uno se hace; una lista plana de liquidaciones mezcla semanas y personas. */
async function pintarLiquidaciones(){
  const liqs = await (await pedir("/api/sueldos/liquidaciones?limite=60")).json();
  const card = $("#cardLiquidaciones");
  if(!card) return;
  if(!liqs.length){ card.style.display = "none"; return; }
  card.style.display = "";
  // Plegado por defecto: son todos los cierres de la historia y empujan para
  // abajo lo que sí se mira todos los días, que es lo que falta pagar.
  const boton = $("#verPagado"), lista = $("#listaLiq");
  if(boton){
    const abierto = lista.style.display === "block";
    boton.textContent = abierto ? "Ocultar" : `Ver los ${liqs.length}`;
    boton.onclick = () => {
      const ahora = lista.style.display !== "block";
      lista.style.display = ahora ? "block" : "none";
      boton.textContent = ahora ? "Ocultar" : `Ver los ${liqs.length}`;
    };
  }
  if(!DUENO){
    $("#tituloPagado").textContent = "🧾 Lo que ya cobraste";
    $("#bajadaPagado").textContent = "Tus ciclos cerrados, con los números tal como estaban ese día.";
  }

  // Se agrupa por el rango del ciclo. La clave es desde+hasta: dos empleadas de
  // la misma semana caen en el mismo bloque aunque se hayan pagado en días
  // distintos.
  const ciclos = {};
  liqs.forEach(l => {
    const clave = `${l.desde}|${l.hasta}`;
    (ciclos[clave] = ciclos[clave] || {desde:l.desde, hasta:l.hasta, liqs:[]}).liqs.push(l);
  });
  const orden = Object.values(ciclos).sort((a,b) => (b.desde||"").localeCompare(a.desde||""));

  $("#listaLiq").innerHTML = orden.map(c => {
    const total = c.liqs.reduce((a,l)=>a+l.total, 0);
    const min = c.liqs.reduce((a,l)=>a+(l.minutos_total||0), 0);
    return `<div class="ciclo">
      <div class="ciclo-cab">
        <div>
          <h3>${c.liqs.every(l=>l.depilacion) ? "Depilación " : ""}${rangoLargo(c.desde, c.hasta)}</h3>
          <div class="det">${c.liqs.length} ${c.liqs.length===1?"empleada":"empleadas"}${
            c.liqs.every(l=>l.depilacion) ? " · se repartió el día" : ` · ${hhmm(min)} trabajadas`}</div>
        </div>
        <div class="plata">${fmt(total)}</div>
      </div>
      <div class="ciclo-cuerpo">
        ${c.liqs.map(l => `
          <div class="fila-emp">
            <div><b>${esc(l.empleado||"—")}${l.parcial ? ` <span class="saldo-de">pago parcial</span>` : ""}</b>
              <span class="det">${l.depilacion
                ? `depilación · entró ${fmt(l.recaudado)} − gastos ${fmt(l.gastos)}, la mitad`
                : `${hhmm(l.minutos_total)} trabajadas · ${hhmm(l.minutos_pagados)} a ${fmt(l.valor_hora)} = ${fmt(l.total_horas)} · comisiones ${fmt(l.total_comisiones)}`}${
                l.egreso_numero ? ` · egreso #${l.egreso_numero}${l.forma_pago?" en "+esc(l.forma_pago):""}` : ""}${l.notas?" · "+esc(l.notas):""}</span></div>
            <div class="plata">${fmt(l.total)}</div>
            <button class="b-out verLiq" data-id="${l.id}">Ver</button>
          </div>
          <div class="detalle-liq" id="liq${l.id}" style="display:none;"></div>`).join("")}
      </div>
    </div>`;
  }).join("");

  $("#listaLiq").querySelectorAll(".verLiq").forEach(b=>{
    b.onclick = async () => {
      const caja = $("#liq"+b.dataset.id);
      if(caja.style.display === "block"){ caja.style.display = "none"; return; }
      const d = await (await pedir("/api/sueldos/liquidaciones/"+b.dataset.id)).json();
      caja.innerHTML = `
        <div class="sub-h">Días</div>
        ${d.dias.map(x=>`<div class="fila-dato"><div class="que"><b>${diaDe(x.fecha)} ${fechaCorta(x.fecha)}</b></div>
           <div class="mins">${hhmm(x.minutos)}</div>
           <div class="plata">${fmt(Math.round(x.minutos * d.valor_hora / 60))}</div></div>`).join("") || `<div class="vacio">Sin días.</div>`}
        <div class="sub-h">Trabajos</div>
        ${d.trabajos.map(x=>`<div class="fila-dato"><div class="que"><b>${esc(x.nombre||"—")}${x.cantidad>1?` ×${x.cantidad}`:""}${x.suelto?` <span class="sin-comp">sin comprobante</span>`:""}</b>
           <span class="det">${fechaCorta(x.fecha)} · ${fmt(x.base)}</span></div>
           <div class="mins">${hhmm(x.minutos)}</div>
           <div class="plata">${fmt(x.comision)}</div></div>`).join("") || `<div class="vacio">Sin trabajos.</div>`}`;
      caja.style.display = "block";
    };
  });
}

async function cargar(){
  EMP = Number($("#quien").value);
  D = await (await pedir("/api/sueldos/pendiente?empleado_id="+EMP)).json();
  pintar();
}

function pintar(){
  const espera = D.en_espera
    ? `<span class="nota">faltan ${D.sin_tiempo} sin duración: ${fmt(D.en_espera)} sin contar</span>` : "";
  // El reparto del lunes no es comisión ni horas: sin su propio casillero, el
  // total de arriba tiene plata que ninguno de los otros dos explica.
  const depis = D.ciclos.filter(c => c.depilacion);
  $("#totales").innerHTML = `
    <div class="kpi destacado">
      <span class="lbl">${VOS.debe}</span>
      <span class="val">${fmt(D.total)}</span>
      <span class="nota">${D.ciclos.length} ${D.ciclos.length===1?"ciclo":"ciclos"} sin pagar</span>
    </div>
    <div class="kpi">
      <span class="lbl">Comisiones</span>
      <span class="val">${fmt(D.total_comisiones)}</span>
      <span class="nota">al ${D.comision_pct}% salvo los que tienen el suyo</span>
    </div>
    <div class="kpi">
      <span class="lbl">Horas</span>
      <span class="val">${fmt(D.total_horas)}</span>
      <span class="nota">${hhmm(D.minutos_total)} declaradas · ${fmt(D.valor_hora)} la hora</span>
    </div>` + (depis.length ? `
    <div class="kpi">
      <span class="lbl">Depilación</span>
      <span class="val">${fmt(depis.reduce((a, c) => a + c.total, 0))}</span>
      <span class="nota">${depis.length === 1 ? "el reparto del lunes" : depis.length + " lunes repartidos"}</span>
    </div>` : "");
  if(espera) $("#totales").insertAdjacentHTML("beforeend",
    `<div class="kpi" style="flex:1 1 100%;"><span class="lbl">Sin contar todavía</span>
     <span class="val">${fmt(D.en_espera)}</span>
     <span class="nota">${D.sin_tiempo} ${D.sin_tiempo===1?"trabajo":"trabajos"} esperando que se cargue cuánto duró</span></div>`);

  const avisos = bloqueAvisos();
  $("#cuerpo").innerHTML = avisos + (D.ciclos.length
    ? D.ciclos.map(dibujarCiclo).join("")
    : (avisos ? "" : `<div class="vacio"><b>${VOS.sinNada}</b>${VOS.comoAparece}</div>`)) + bloqueHoy();
  enganchar();
}

/* Siempre hay una puerta para cargar un trabajo de HOY.

   Los días aparecen solos cuando hay un ticket, pero un trabajo que no quedó en
   ningún comprobante no crea nada: sin esto, el día que no hubo ni un ticket
   —o el día que todavía no se facturó nada— la pantalla no ofrecía ningún lugar
   donde anotarlo. Y es justo el caso en el que hace falta: si hubiera
   comprobante, no habría que cargarlo a mano.

   Va al final y para las dos, la empleada y la dueña: la que lo hizo es la que
   sabe que lo hizo. */
function bloqueHoy(){
  const hoy = hoyArg();
  const yaEsta = D.ciclos.some(c => c.dias.some(d => d.fecha === hoy));
  return `<div class="hoy-suelto">
    <div>
      <b>¿Hiciste un trabajo hoy que no quedó en ningún ticket?</b>
      <span class="det">${yaEsta
        ? "Se agrega al día de hoy, que ya está más arriba."
        : "Se agrega solo, con el día de hoy, y arranca el ciclo si hace falta."}</span>
    </div>
    <button class="b-out agregar-trabajo" data-fecha="${hoy}">+ Trabajo sin comprobante</button>
  </div>`;
}

const trabajosDelDia = c => c.dias.flatMap(d => d.trabajos);

/* El lunes de depilación no se paga por comisión: se reparte el día.

   Se ve la cuenta entera —lo que entró, lo que salió y las dos mitades— porque
   es un negocio a medias: la mitad que le toca no se entiende sin los dos
   números de arriba. Los gastos se cargan desde acá y no desde Caja, que es de
   la dueña: son los costos de SU día y son los únicos que le bajan la parte.
   Cerrar sigue siendo de la dueña. */
function dibujarDepilacion(c){
  const q = c.cuenta;
  const ayudantes = q.egresos_detalle.filter(e => e.ayudante);
  const otros = q.egresos_detalle.filter(e => !e.ayudante);
  const borrar = e => `<button class="b-out btn-mini borrar-gasto" data-id="${e.id}"
      title="Sacar este gasto del día">✕</button>`;
  return `<div class="ciclo depi" data-desde="${c.desde}">
    <div class="ciclo-cab">
      <div>
        <h3>Depilación ${rangoLargo(c.desde, c.hasta)}</h3>
        <div class="det">${q.comprobantes} ${q.comprobantes===1?"servicio":"servicios"} · se reparte el día, no se paga por comisión</div>
      </div>
      <div class="plata">${fmt(c.total)}</div>
    </div>
    <div class="ciclo-cuerpo">
      <div class="cuenta-depi">
        <div class="ren"><span>Lo que entró</span><b>${fmt(q.recaudado)}</b></div>
        ${otros.map(e => `<div class="ren chico">
            <span>${e.numero ? "#" + e.numero + " " : ""}${esc(e.concepto || e.tipo || "Gasto")}</span>
            <span>−${fmt(e.monto)} ${borrar(e)}</span></div>`).join("")}
        ${ayudantes.map(e => `<div class="ren chico ayudante">
            <span>Ayudante · ${esc(e.concepto || "sin nombre")}${
              e.notas ? ` <em class="det">(${esc(e.notas)})</em>` : ""}</span>
            <span>−${fmt(e.monto)} ${borrar(e)}</span></div>`).join("")}
        ${ayudantes.length ? "" : `<div class="ren chico falta-ayudante">
            <span>Pago a la ayudante</span>
            <span><button class="b-out btn-mini btn-ayudante" data-fecha="${c.desde}">Cargar</button></span>
          </div>`}
        <div class="ren"><span>Gastos del día</span><b class="${q.gastos ? "resta" : ""}">${q.gastos ? "−" : ""}${fmt(q.gastos)}</b></div>
        <div class="ren total"><span>Queda</span><b>${fmt(q.resto)}</b></div>
        <div class="ren mitad"><span>${DUENO ? "Para " + esc(D.empleado.nombre) : "Te toca"}</span><b>${fmt(q.parte_empleada)}</b></div>
        <div class="ren mitad"><span>Para el salón</span><b>${fmt(q.parte_salon)}</b></div>
      </div>
      <div class="dia-acciones">
        <button class="b-out btn-mini btn-gasto" data-fecha="${c.desde}">+ Gasto del día</button>
        ${ayudantes.length ? `<button class="b-out btn-mini btn-ayudante" data-fecha="${c.desde}">+ Otra ayudante</button>` : ""}
      </div>
      ${q.deuda > 0 ? `<div class="aviso">⚠️ Falta cobrar ${fmt(q.deuda)} de este día${
          q.parte_empleada <= 0 ? ", que es por lo que no hay nada para repartir todavía" : ""}. Cuando se cobre, el reparto sube solo.</div>` : ""}
      ${q.resto < 0 ? `<div class="aviso">⚠️ Los gastos del día superan lo que entró. No hay nada para repartir.</div>` : ""}
      ${!q.deuda && q.resto >= 0 && q.parte_empleada <= 0 && q.comprobantes === 0
        ? `<div class="aviso">Todavía no se facturó nada de este día.</div>` : ""}
      ${trabajosDelDia(c).length ? `
        <div class="nota-depi">Lo que se anotó este día no va por comisión para nadie —ya está adentro del reparto—, pero se ve igual: escondido parecería que se perdió.</div>
        <div class="lista-depi">${trabajosDelDia(c).map(t => `<div>
          <span>${esc(t.nombre)}${t.cantidad > 1 ? ` ×${t.cantidad}` : ""}</span>
          <span class="det">${t.numero ? "#" + t.numero : "sin comprobante"}${t.cliente ? " · " + esc(t.cliente) : ""}</span>
        </div>`).join("")}</div>` : ""}
      ${DUENO ? filaCerrar(c, q.parte_empleada > 0) : ""}
    </div>
  </div>`;
}

/* El aviso de la ayudante: NO es un ciclo.

   Para ella el lunes de depilación no se cierra ni se liquida —la plata salió de
   la caja el día que se le pagó, como cualquier gasto—, así que lo único que
   tiene que ver es cuánto cobró. Es también el lugar donde dice por qué ese
   lunes no le aparece ninguna comisión: sin eso, el día se le borra de la
   pantalla y parece que se perdió. */
function bloqueAvisos(){
  const av = D.avisos_depilacion || [];
  if(!av.length) return "";
  return `<div class="avisos-depi">
    ${av.map(a => `<div class="aviso-depi">
      <div>
        <b>Depilación · ${diaDe(a.fecha)} ${fechaCorta(a.fecha)}</b>
        <span class="det">${a.monto
          ? "Cobro por el día. No hay ciclo que cerrar: ya te lo pagaron."
          : "Ese día se reparte entero entre la que lo llevó y el salón, así que no va por comisión."}</span>
      </div>
      <span class="plata">${a.monto ? fmt(a.monto) : "—"}</span>
    </div>`).join("")}
  </div>`;
}

/* Un ciclo es la semana del local: de sábado a viernes, que es cuando se paga.
   No es una ventana para filtrar, es la unidad con la que se paga: una semana
   sin cerrar sigue apareciendo entera al lado de la nueva. */
function dibujarCiclo(c){
  if(c.depilacion) return dibujarDepilacion(c);
  const hoy = hoyArg();
  const enCurso = hoy >= c.desde && hoy <= c.hasta;
  const listo = !c.sin_tiempo && !c.sin_horas && c.total > 0;
  return `<div class="ciclo${enCurso ? " en-curso" : ""}" data-desde="${c.desde}">
    <div class="ciclo-cab">
      <div>
        <h3>${rangoLargo(c.desde, c.hasta)}${c.pagado_antes ? ` <span class="saldo-de">saldo</span>` : ""}</h3>
        <div class="det">${c.pagado_antes ? `ya se pagaron ${fmt(c.pagado_antes)} de esta semana · ` : ""}${hhmm(c.minutos_total)} declaradas · ${hhmm(c.minutos_comision)} de trabajos · comisiones ${fmt(c.total_comisiones)} + horas ${fmt(c.total_horas)}</div>
      </div>
      <div class="plata">${fmt(c.total)}</div>
    </div>
    <div class="ciclo-cuerpo">
      ${c.dias.map(d => dibujarDia(d, c)).join("")}
      ${DUENO ? filaAgregarDia(c) : ""}
      ${DUENO ? filaCerrar(c, listo) : ""}
    </div>
  </div>`;
}

/* El día es el renglón que la empleada mira: cuántas horas hizo y qué trabajos
   entraron. Las horas se muestran escritas y se editan con el lapicito: con el
   casillero siempre abierto, un número tipeado sin querer es plata. */
function dibujarDia(d, c){
  // Un día cuyas horas ya se pagaron en un cierre anterior vuelve a aparecer si
  // se le agrega una comisión con esa fecha. No le falta nada, así que no se
  // pide ni se ofrece el casillero: cargarlas sería pagarlas dos veces, y el
  // servidor las rebota igual.
  const falta = !d.minutos && !d.horas_pagadas;
  return `<div class="dia" data-fecha="${d.fecha}">
    <div class="dia-cab">
      <b>${diaDe(d.fecha)} ${fechaCorta(d.fecha)}</b>
      <span class="dia-horas${falta ? " falta" : ""}">
        <span class="rot-horas">Horas trabajadas:</span>
        <span class="valor">${d.horas_pagadas ? "ya cobradas" : (falta ? "sin horas" : hhmm(d.minutos))}</span>
        ${d.horas_pagadas ? "" : `<button class="b-out btn-mini editar-horas" data-fecha="${d.fecha}" data-min="${d.minutos}">${falta ? "Poner horas" : "✎"}</button>`}
      </span>
      <span class="plata">${fmt(Math.round(Math.max(d.minutos - d.trabajos.reduce((a,t)=>a+(t.minutos||0),0), 0) * D.valor_hora / 60))}</span>
    </div>
    ${d.trabajos.length ? `<div class="trabajos">${d.trabajos.map(dibujarTrabajo).join("")}</div>` : ""}
    <div class="dia-acciones">
      <button class="b-out btn-mini agregar-trabajo" data-fecha="${d.fecha}">+ Trabajo sin comprobante</button>
    </div>
  </div>`;
}

function dibujarTrabajo(t){
  const marca = t.suelto
    ? `<span class="sin-comp">sin comprobante</span>`
    : (t.cliente_id
        ? `<a class="ver-comp" href="/cuenta?id=${t.cliente_id}&comp=${t.comprobante_id}">#${t.numero} ↗</a>`
        : `<span class="det">#${t.numero}</span>`);
  const quien = t.suelto ? "" : (t.cliente ? titulo(t.cliente) + " · " : "mostrador · ");
  const clave = t.suelto ? `data-trabajo="${t.id}"` : `data-linea="${t.linea_id}"`;
  const falta = !t.minutos;
  return `<div class="trabajo${falta ? " sin-tiempo" : ""}">
    <div class="que">
      <b>${esc(t.nombre)}${t.cantidad>1?` ×${t.cantidad}`:""} ${marca}</b>
      <span class="det">${esc(quien)}${fmt(t.base)}${
        // El porcentaje solo cuando NO es el general: si estuviera en todos los
        // renglones, el que es distinto dejaría de saltar a la vista.
        t.pct != null && t.pct !== D.comision_pct ? ` · al ${t.pct}%` : ""}${
        t.suelto ? ` · <a href="#" class="borrar-suelto" data-trabajo="${t.id}">borrar</a>` : ""}</span>
    </div>
    <span class="dia-horas">
      ${falta ? `<span class="falta-tiempo">falta el tiempo</span>` : `<span class="valor">${hhmm(t.minutos)}</span>`}
      <button class="b-out btn-mini editar-min" ${clave} data-min="${t.minutos}">${falta ? "Poner" : "✎"}</button>
    </span>
    <span class="plata${falta ? " no-cuenta" : ""}"${
      falta ? ` title="Todavía no se cuenta: falta cargarle la duración"` : ""}>${fmt(t.comision)}</span>
  </div>`;
}

/* Agregar un día a mano es de la dueña: un día sin ningún trabajo detrás no se
   puede verificar contra nada, y son horas que se pagan. Los días con trabajo
   aparecen solos. */
function filaAgregarDia(c){
  // Detrás de un botón: es la excepción —los días con trabajo aparecen solos— y
  // abierto son tres casilleros vacíos abajo de cada ciclo, en la pantalla que se
  // mira todos los días para ver un total.
  return `<div class="dia-acciones">
    <button class="b-out btn-mini abrir-dia" data-desde="${c.desde}" data-hasta="${c.hasta}">+ Agregar un día</button>
  </div>`;
}

function abrirFormDia(boton){
  document.querySelectorAll(".form-dia").forEach(x => x.remove());
  const caja = document.createElement("div");
  caja.className = "agregar form-dia";
  caja.innerHTML = `
    <div><label>Día del ciclo</label>
      <input type="date" class="nvFecha" min="${boton.dataset.desde}" max="${boton.dataset.hasta}" value="${boton.dataset.desde}"></div>
    <div style="flex:0 0 90px;"><label>Horas</label>
      <input type="number" class="nvHoras" min="0" max="24" inputmode="numeric" placeholder="8"></div>
    <div style="flex:0 0 90px;"><label>Min</label>
      <input type="number" class="nvMin" min="0" max="59" step="5" inputmode="numeric" placeholder="0"></div>
    <button class="b-ok btn-dia">Agregar día</button>
    <button class="b-out dNo">Cancelar</button>`;
  boton.after(caja);
  caja.querySelector(".dNo").onclick = () => caja.remove();
  caja.querySelector(".btn-dia").onclick = async () => {
    const fecha = caja.querySelector(".nvFecha").value;
    const minutos = (parseInt(caja.querySelector(".nvHoras").value,10)||0)*60
                  + (parseInt(caja.querySelector(".nvMin").value,10)||0);
    if(!fecha){ toast("Elegí el día"); return; }
    if(minutos <= 0){ toast("Poné cuántas horas"); return; }
    await mandar("/api/sueldos/horas", "PUT", {empleado_id: EMP, fecha, minutos});
  };
  caja.querySelector(".nvHoras").focus();
}

/* Cerrar antes de que termine la semana NO es cerrar la semana.

   El viernes es el final del ciclo y el día de pago. Si se paga un miércoles, lo
   que se paga es lo que va hasta ahí: el ciclo sigue abierto y lo que se trabaje
   el jueves y el viernes cae en el mismo. Por eso el botón dice "pago parcial" y
   no "cerrar".

   Al lado queda el cierre anticipado, para el caso en el que la semana sí se
   terminó antes —el viernes cae feriado, se paga el jueves—: ahí la da por
   cerrada igual. Son dos cosas distintas y por eso son dos botones. */
function filaCerrar(c, listo){
  // El viernes mismo YA es cerrar la semana: es el último día y el de pago. Con
  // ">" el cierre normal de todas las semanas salía como "pago parcial".
  const termino = hoyArg() >= c.hasta;
  const aviso = c.sin_tiempo
    ? `<div class="aviso">⚠️ ${c.sin_tiempo} ${c.sin_tiempo===1?"trabajo":"trabajos"} sin duración. Hasta que la tengan no se sabe cuántas horas hay que pagar aparte, así que este ciclo no se puede cerrar.</div>`
    : c.sin_horas
    ? `<div class="aviso">⚠️ ${c.sin_horas} ${c.sin_horas===1?"día":"días"} sin horas declaradas. Un día en cero se paga solo por comisión y las horas de ese día se pierden, así que este ciclo no se puede cerrar.</div>`
    : (termino ? "" : `<div class="aviso">Esta semana no terminó todavía. Lo que se pague ahora es lo que va hasta hoy: lo que trabaje después vuelve a aparecer en este mismo ciclo.</div>`);
  return `<div class="cierre">
    <div style="display:flex;align-items:center;gap:var(--sp-2);">
      <label style="margin:0;">Se paga con</label>
      <select class="formaCierre" style="width:auto;">${FORMAS.map(f=>`<option${f==="Efectivo"?" selected":""}>${esc(f)}</option>`).join("")}</select>
    </div>
    <div style="display:flex;align-items:center;gap:var(--sp-2);">
      <label style="margin:0;">el día</label>
      <input type="date" class="fechaCierre" value="${hoyArg()}" max="${hoyArg()}" style="width:auto;">
    </div>
    <input class="nota notaCierre" placeholder="Nota (opcional)">
    <button class="b-ok btn-cerrar" ${listo ? "" : "disabled"}>${
      termino ? `Cerrar y pagar ${fmt(c.total)}` : `Pago parcial de ${fmt(c.total)}`}</button>
    ${termino ? "" : `<button class="b-out btn-cerrar anticipado" ${listo ? "" : "disabled"}
        title="La semana terminó antes: viernes feriado, por ejemplo">Cerrar la semana igual</button>`}
    ${aviso}
  </div>`;
}

/* Todo lo que se toca abre un casillero chiquito en el lugar, guarda y vuelve a
   cerrarse. Un solo abierto por vez: con veinte casilleros abiertos, la pantalla
   deja de decir qué está guardado y qué está tipeado. */
function abrirEditor(ancla, minutos, alGuardar){
  document.querySelectorAll(".editor-min").forEach(x => x.remove());
  const h = Math.floor(minutos/60), m = minutos%60;
  const caja = document.createElement("span");
  caja.className = "mins editor-min";
  caja.innerHTML = `
    <input type="number" min="0" max="24" inputmode="numeric" value="${h||""}" class="eh" aria-label="Horas">
    <span class="u">h</span>
    <input type="number" min="0" max="59" step="5" inputmode="numeric" value="${m||""}" class="em" aria-label="Minutos">
    <span class="u">min</span>
    <button class="b-ok btn-mini ok">Guardar</button>
    <button class="b-out btn-mini no">✕</button>`;
  ancla.replaceWith(caja);
  const leer = () => Math.max(0, parseInt(caja.querySelector(".eh").value,10)||0) * 60
                   + Math.max(0, parseInt(caja.querySelector(".em").value,10)||0);
  caja.querySelector(".no").onclick = () => pintar();
  caja.querySelector(".ok").onclick = () => alGuardar(leer());
  caja.querySelectorAll("input").forEach(i => i.onkeydown = e => {
    if(e.key === "Enter") alGuardar(leer());
    if(e.key === "Escape") pintar();
  });
  caja.querySelector(".eh").focus();
}

function enganchar(){
  // horas de un día
  document.querySelectorAll(".editar-horas").forEach(b => {
    b.onclick = () => abrirEditor(b, Number(b.dataset.min)||0, async minutos => {
      if(!minutos){ toast("Poné cuántas horas hiciste"); return; }
      await mandar("/api/sueldos/horas", "PUT", {empleado_id: EMP, fecha: b.dataset.fecha, minutos});
    });
  });
  // duración de un trabajo
  document.querySelectorAll(".editar-min").forEach(b => {
    b.onclick = () => abrirEditor(b, Number(b.dataset.min)||0, async minutos => {
      if(!minutos){ toast("Poné cuánto duró"); return; }
      const d = b.dataset;
      await mandar("/api/sueldos/trabajo-minutos", "PUT", d.linea
        ? {empleado_id: EMP, linea_id: Number(d.linea), minutos}
        : {empleado_id: EMP, trabajo_id: Number(d.trabajo), minutos});
    });
  });
  // el trabajo sin comprobante, escondido hasta que se lo pide
  document.querySelectorAll(".agregar-trabajo").forEach(b => {
    b.onclick = () => abrirFormTrabajo(b);
  });
  document.querySelectorAll(".borrar-suelto").forEach(a => {
    a.onclick = async e => {
      e.preventDefault();
      if(!confirm("¿Borrar este trabajo cargado a mano?")) return;
      await mandar("/api/sueldos/trabajo-suelto/"+a.dataset.trabajo, "DELETE");
    };
  });
  // los gastos del lunes de depilación
  document.querySelectorAll(".btn-gasto").forEach(b => {
    b.onclick = () => abrirFormGasto(b, false);
  });
  document.querySelectorAll(".btn-ayudante").forEach(b => {
    b.onclick = () => abrirFormGasto(b, true);
  });
  document.querySelectorAll(".borrar-gasto").forEach(b => {
    b.onclick = async () => {
      if(!confirm("¿Sacar este gasto del día? El reparto se recalcula solo.")) return;
      await mandar(`/api/sueldos/depilacion/gasto/${b.dataset.id}?empleado_id=${EMP}`, "DELETE");
    };
  });
  // lo de la dueña
  document.querySelectorAll(".abrir-dia").forEach(b => {
    b.onclick = () => abrirFormDia(b);
  });
  document.querySelectorAll(".btn-cerrar").forEach(b => {
    b.onclick = async () => {
      const caja = b.closest(".cierre");
      const ciclo = b.closest(".ciclo").dataset.desde;
      const forma = caja.querySelector(".formaCierre").value || "Efectivo";
      const c = D.ciclos.find(x => x.desde === ciclo);
      const anticipado = b.classList.contains("anticipado");
      const termino = hoyArg() > c.hasta;
      const parcial = !termino && !anticipado;
      const que = parcial
        ? `Pago parcial de ${fmt(c.total)} a ${D.empleado.nombre} por lo que va de ${rangoLargo(c.desde, c.hasta)}.\n`
          + `La semana sigue abierta: lo que trabaje después vuelve a aparecer acá.`
        : `Se le pagan ${fmt(c.total)} a ${D.empleado.nombre} por ${rangoLargo(c.desde, c.hasta)}, y la semana queda cerrada.`;
      const fecha = caja.querySelector(".fechaCierre").value || hoyArg();
      const dia = fecha === hoyArg() ? "la caja de hoy" : "la caja del " + fechaCorta(fecha);
      if(!confirm(`${que}\n\nSe paga en ${forma} y el egreso queda anotado en ${dia}.\n\nEsto no se puede deshacer. ¿Seguimos?`)) return;
      if(await mandar("/api/sueldos/cerrar", "POST", {empleado_id: EMP, desde: ciclo, forma_pago: forma,
                                                      anticipado, fecha,
                                                      notas: caja.querySelector(".notaCierre").value.trim() || null}))
        toast(parcial ? "Pago parcial hecho ✓" : "Pagado ✓");
    };
  });
}

/* El formulario de un trabajo sin comprobante aparece recién cuando se lo pide,
   pegado al día que lo va a recibir. Antes estaba siempre abierto abajo de todo:
   cinco casilleros vacíos que casi nunca se usan, en la pantalla que se mira
   todos los días para ver un total. */
function abrirFormTrabajo(boton){
  document.querySelectorAll(".form-trabajo").forEach(x => x.remove());
  if(!ITEMS.length){
    toast("Falta marcar en el catálogo cuáles van a comisión");
    return;
  }
  const fecha = boton.dataset.fecha;
  const caja = document.createElement("div");
  caja.className = "agregar form-trabajo";
  caja.innerHTML = `
    <div class="ancho"><label>Trabajo del ${fechaCorta(fecha)}</label>
      <select class="fItem">${ITEMS.map(i=>`<option value="${i.id}">${esc(i.nombre)} — ${fmt(i.precio)}</option>`).join("")}</select></div>
    <div style="flex:0 0 80px;"><label>Cant.</label>
      <input type="number" class="fCant" min="1" value="1" inputmode="numeric"></div>
    <div style="flex:0 0 90px;"><label>Horas</label>
      <input type="number" class="fHoras" min="0" max="24" inputmode="numeric" placeholder="1"></div>
    <div style="flex:0 0 90px;"><label>Min</label>
      <input type="number" class="fMin" min="0" max="59" step="5" inputmode="numeric" placeholder="30"></div>
    <button class="b-ok fOk">Agregar</button>
    <button class="b-out fNo">Cancelar</button>`;
  boton.after(caja);
  caja.querySelector(".fNo").onclick = () => caja.remove();
  caja.querySelector(".fOk").onclick = async () => {
    const minutos = (parseInt(caja.querySelector(".fHoras").value,10)||0)*60
                  + (parseInt(caja.querySelector(".fMin").value,10)||0);
    // Sin duración no se agrega: un trabajo sin tiempo no se puede pagar bien
    // —no se sabe cuánto descontarle a las horas del día— y el servidor lo
    // rebota igual.
    if(minutos <= 0){ toast("Poné cuánto duró el trabajo"); return; }
    await mandar("/api/sueldos/trabajo-suelto", "POST", {
      empleado_id: EMP, item_id: Number(caja.querySelector(".fItem").value),
      cantidad: Math.max(1, parseInt(caja.querySelector(".fCant").value,10)||1),
      fecha, minutos});
  };
  caja.querySelector(".fHoras").focus();
}

/* El gasto de un día de depilación se carga acá y no en Caja.

   Dos formas del mismo formulario: el gasto común pide tipo y concepto, y el de
   la ayudante pide QUIÉN, porque es un pago a una persona y eso es lo que
   después le aparece a ella en su pantalla. El monto viene puesto con el fijo y
   se puede pisar: si se pisa, el egreso se queda con el número viejo escrito. */
function abrirFormGasto(boton, esAyudante){
  document.querySelectorAll(".form-gasto").forEach(x => x.remove());
  const fecha = boton.dataset.fecha;
  const c = D.ciclos.find(x => x.desde === fecha);
  const fijo = (c && c.cuenta && c.cuenta.pago_ayudante) || 0;
  // La que lleva el día no puede ser su propia ayudante: cobraría dos veces el
  // mismo día y la mitad de la resta sería contra ella misma.
  const otras = TODAS.filter(e => e.nombre !== D.empleado.nombre);
  const caja = document.createElement("div");
  caja.className = "agregar form-gasto";
  caja.innerHTML = esAyudante
    ? `<div class="ancho"><label>¿Quién ayudó el ${fechaCorta(fecha)}?</label>
         <select class="gQuien">
           ${otras.map(e => `<option value="${esc(e.nombre)}">${esc(e.nombre)}</option>`).join("")}
           <option value="">Otra persona…</option>
         </select></div>
       <div class="ancho gOtra" style="display:none;"><label>Nombre</label>
         <input class="gNombre" maxlength="60" placeholder="No es del salón"></div>
       <div style="flex:0 0 130px;"><label>Se le paga</label>
         <input type="number" class="gMonto" min="1" inputmode="numeric" value="${fijo || ""}"></div>
       <button class="b-ok gOk">Anotar el pago</button>
       <button class="b-out gNo">Cancelar</button>
       ${fijo ? `<span class="nota">El fijo son ${fmt(fijo)}. Si ponés otro número queda escrito que se cambió.</span>` : ""}`
    : `<div class="ancho"><label>Gasto del ${fechaCorta(fecha)}</label>
         <input class="gConcepto" maxlength="80" placeholder="Cera, descartables…"></div>
       <div style="flex:0 0 130px;"><label>Monto</label>
         <input type="number" class="gMonto" min="1" inputmode="numeric"></div>
       <button class="b-ok gOk">Agregar</button>
       <button class="b-out gNo">Cancelar</button>
       <span class="nota">Entra en la resta del día, así que baja las dos mitades.</span>`;
  boton.after(caja);
  caja.querySelector(".gNo").onclick = () => caja.remove();
  const sel = caja.querySelector(".gQuien");
  if(sel) sel.onchange = () => {
    caja.querySelector(".gOtra").style.display = sel.value ? "none" : "";
    if(!sel.value) caja.querySelector(".gNombre").focus();
  };
  caja.querySelector(".gOk").onclick = async () => {
    const monto = parseInt(caja.querySelector(".gMonto").value, 10) || 0;
    if(monto <= 0){ toast("Poné cuánto fue"); return; }
    let cuerpo = {empleado_id: EMP, fecha, monto};
    if(esAyudante){
      const elegida = sel.value || caja.querySelector(".gNombre").value.trim();
      if(!elegida){ toast("Decí quién ayudó"); return; }
      const suya = otras.find(e => e.nombre === elegida);
      cuerpo = {...cuerpo, ayudante: true, concepto: elegida,
                ayudante_id: suya ? suya.id : null, tipo: "Ayudante depilación"};
    } else {
      const que = caja.querySelector(".gConcepto").value.trim();
      if(!que){ toast("Poné qué se gastó"); return; }
      cuerpo = {...cuerpo, concepto: que, tipo: "Insumos"};
    }
    await mandar("/api/sueldos/depilacion/gasto", "POST", cuerpo);
  };
  caja.querySelector(esAyudante ? ".gMonto" : ".gConcepto").focus();
}

/* Un solo lugar donde se habla con el servidor: si algo falla se muestra el
   motivo que mandó el backend en vez de dejar la pantalla como si hubiera
   guardado. Después de cualquier cambio se recarga: la cuenta la hace el
   servidor, y repetirla acá sería tener dos versiones del sueldo. */
async function mandar(url, metodo, cuerpo){
  try{
    const r = await pedir(url, {
      method: metodo,
      headers: cuerpo ? {"Content-Type":"application/json"} : {},
      body: cuerpo ? JSON.stringify(cuerpo) : undefined});
    if(!r.ok){
      const e = await r.json().catch(()=>({}));
      toast(e.detail || "No se pudo guardar");
      return false;
    }
    await refrescar();
    return true;
  }catch(e){
    toast("No se pudo guardar: " + e.message);
    return false;
  }
}

/* ---------- cerrar la puerta sola ---------- */

/* La tablet queda prendida arriba del mostrador y pasa de mano en mano. Que el
   permiso se pierda al navegar o recargar no alcanza: si la empleada deja la
   pantalla abierta y se va a atender, su sueldo queda ahí para el que la agarre.

   Así que se cierra sola en tres casos:
     - cuando la pantalla deja de estar a la vista (cambió de app, de pestaña,
       bloqueó la tablet),
     - cuando pasan unos minutos sin que nadie la toque,
     - y cuando el servidor contesta que el permiso ya no vale.

   Cerrar es tirar el permiso Y esconder lo que está dibujado: si solo se tirara
   el permiso, los números seguirían en pantalla hasta que alguien tocara algo. */
const MINUTOS_QUIETA = 3;
let relojQuieta = null;

function cerrarPuerta(motivo){
  if(DUENO || !PERMISO) return;
  PERMISO = null; YO = null;
  clearTimeout(relojQuieta);
  $("#todo").hidden = true;
  abrirPuerta(motivo);
}

function reiniciarRelojQuieta(){
  if(DUENO || !PERMISO) return;
  clearTimeout(relojQuieta);
  relojQuieta = setTimeout(() => cerrarPuerta("Se cerró sola por seguridad. Poné tu código de nuevo."),
                           MINUTOS_QUIETA * 60 * 1000);
}

function vigilarPantalla(){
  if(DUENO) return;
  // visibilitychange cubre cambiar de app, de pestaña y bloquear la tablet.
  document.addEventListener("visibilitychange", () => {
    if(document.hidden) cerrarPuerta("Saliste de la pantalla. Poné tu código de nuevo.");
  });
  // Y el reloj de inactividad, que se reinicia con cualquier cosa que se toque.
  ["pointerdown","keydown","input","touchstart"].forEach(ev =>
    document.addEventListener(ev, reiniciarRelojQuieta, {passive:true}));
}

/* ---------- la puerta ---------- */

/* Con el usuario empleado no se muestra nada hasta que alguien dice quién es y
   pone su código. Se pide en CADA entrada a la pantalla: en el local la tablet
   queda prendida y pasando de mano en mano, así que una sesión que quedara
   abierta es el sueldo de una a la vista de la siguiente.

   Sin ningún código cargado no se entra. Es a propósito: si se dejara pasar
   "mientras no haya códigos", el día que la dueña carga el primero recién ahí
   empieza a proteger, y hasta entonces la pantalla estuvo abierta sin que nadie
   se enterara. */
async function abrirPuerta(motivo){
  const puerta = $("#puerta"), cuerpo = $("#puertaCuerpo");
  $("#todo").hidden = true;
  puerta.hidden = false;
  $("#puertaAyuda").textContent = motivo || "Elegí quién sos y poné tu código.";

  let emps = [];
  try{ emps = (await (await authFetch("/api/empleados")).json()).filter(e => e.tiene_pin); }
  catch(e){ emps = []; }

  if(!emps.length){
    $("#puertaAyuda").textContent = "El ingreso está cerrado.";
    cuerpo.innerHTML = `<div class="vacio"><b>Todavía no hay códigos cargados</b>
      La dueña los pone en Admin, en la lista de empleados. Hasta entonces esta
      pantalla no se abre para nadie.</div>`;
    return;
  }

  const guardado = localStorage.getItem(RECUERDO);
  cuerpo.innerHTML = `
    <div class="puerta-form">
      <div>
        <label for="pQuien">Quién sos</label>
        <select id="pQuien">${emps.map(e=>`<option value="${e.id}"${String(e.id)===guardado?" selected":""}>${esc(e.nombre)}</option>`).join("")}</select>
      </div>
      <div style="flex:0 1 160px;">
        <label for="pPin">Tu código</label>
        <input id="pPin" class="pin" type="password" inputmode="numeric" autocomplete="off"
               maxlength="8" placeholder="••••">
      </div>
      <button class="b-ok" id="pEntrar">Entrar</button>
    </div>
    <p class="puerta-error" id="pError" hidden></p>`;

  const entrar = async () => {
    const error = $("#pError");
    error.hidden = true;
    const pin = $("#pPin").value.trim();
    if(!pin){ $("#pPin").focus(); return; }
    const r = await authFetch("/api/sueldos/entrar", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({empleado_id: Number($("#pQuien").value), pin})});
    if(!r.ok){
      error.textContent = (await r.json().catch(()=>({}))).detail || "No se pudo entrar";
      error.hidden = false;
      $("#pPin").value = ""; $("#pPin").focus();
      return;
    }
    const d = await r.json();
    PERMISO = d.token; YO = d.empleado.id;
    localStorage.setItem(RECUERDO, String(YO));   // solo para preseleccionar el nombre
    puerta.hidden = true; $("#todo").hidden = false;
    // El desplegable de "quién sos" no tiene sentido cuando ya se dijo con el
    // código: queda el nombre y un botón para que entre la otra. El select sigue
    // existiendo escondido porque es de donde el resto de la pantalla lee de
    // quién es lo que muestra.
    // display:none y no [hidden]: la clase .quien pone display:flex y le gana al
    // hidden del navegador, así que el bloque quedaría a la vista igual.
    const caja = $("#quien").closest(".quien");
    caja.style.display = "none";
    caja.innerHTML = `<select id="quien" hidden></select>`;
    const nom = $("#quienEmpleada");
    nom.hidden = false;
    nom.innerHTML = `${esc(d.empleado.nombre)}
      <button class="b-out" id="salirSueldos" title="Cerrar y que entre otra">Salir</button>`;
    $("#salirSueldos").onclick = () => cerrarPuerta("Listo. El código lo pide de nuevo para entrar.");
    reiniciarRelojQuieta();
    arranque();
  };
  $("#pEntrar").onclick = entrar;
  $("#pPin").addEventListener("keydown", ev => { if(ev.key === "Enter") entrar(); });
  setTimeout(()=>$("#pPin").focus(), 0);
}

if(DUENO){ arranque(); } else { vigilarPantalla(); abrirPuerta(); }
