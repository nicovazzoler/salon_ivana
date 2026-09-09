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
  return authFetch(url, opts);
}

/* Para la dueña, cuál de las empleadas está mirando queda guardado en el aparato:
   entra muchas veces seguidas a la misma. */
const RECUERDO = "sueldos_empleado";

let EMPLEADOS = [], ITEMS = [], EMP = null, D = null, FORMAS = [];
const DUENO = esDueno();
/* La misma tarjeta la miran dos personas distintas: la empleada mira lo suyo y
   la dueña mira lo de otra. Los rótulos cambian con eso, porque "se te debe" en
   la pantalla de la dueña es directamente falso. */
const VOS = {
  debe:   DUENO ? "Se le debe" : "Se te debe",
  dias:   DUENO ? "Días trabajados" : "Días que trabajaste",
  quien:  DUENO ? "Empleada" : "Quién sos",
  sinDias: DUENO ? "Todavía no tiene días cargados" : "Todavía no cargaste ningún día",
  comoCargar: DUENO ? "Se agregan abajo, con el día y las horas." : "Agregá abajo el día y cuántas horas hiciste.",
  sinTrabajos: DUENO ? "Aparecen solos cuando se cobra un ticket a su nombre con un ítem marcado a comisión."
                     : "Aparecen solos cuando se cobra un ticket a tu nombre con un ítem marcado a comisión.",
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
  const sel = $("#quien");
  sel.onchange = () => { localStorage.setItem(RECUERDO, sel.value); cargar(); };
  if(DUENO){
    // Para la dueña la tarjeta de abajo no es "tus horas": es el detalle de la
    // que está mirando. El selector de arriba sigue existiendo porque es lo que
    // dice de quién es lo que se ve.
    $("#tituloDetalle").textContent = "Detalle";
    $("#bajadaDetalle").textContent = "Lo que se le debe hoy. Se puede corregir acá mismo antes de cerrar.";
    $("#rotuloQuien").textContent = VOS.quien;
  }
  ITEMS = await (await pedir("/api/sueldos/items-comision")).json();
  if(DUENO){
    // Las mismas formas de pago con las que se cobra: el egreso del sueldo entra
    // a la caja como cualquier otro, y el arqueo lo suma si dice "Efectivo".
    const cfg = await (await pedir("/api/config")).json();
    FORMAS = cfg.formas_pago || [];
  }
  llenarSelector();
  if(!EMPLEADOS.length) return;
  if(DUENO) await cargarPanelDueno();
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
  sel.closest(".quien").style.display = "";
  sel.innerHTML = EMPLEADOS.map(e=>`<option value="${e.id}">${esc(e.nombre)}${e.activo===false?" (de baja)":""}</option>`).join("");
  if(antes && EMPLEADOS.some(e=>String(e.id)===String(antes))) sel.value = antes;
  if(DUENO) localStorage.setItem(RECUERDO, sel.value);
}

/* Después de cualquier cambio se vuelve a leer todo del servidor: la cuenta la
   hace él, y repetirla acá sería tener dos versiones del sueldo. Es barato
   —son dos empleadas y una lista corta— y evita que la pantalla muestre un
   total viejo al lado de un detalle nuevo. */
async function refrescar(){
  EMPLEADOS = await listaEmpleados();
  llenarSelector();
  if(!EMPLEADOS.length) return;
  if(DUENO) await cargarPanelDueno();
  await cargar();
}

/* ---------- lo que ve solo la dueña ---------- */

async function cargarPanelDueno(){
  const card = $("#cardDueno");
  if(!card) return;
  card.style.display = "";
  // Un pedido por empleada: son dos o tres. Hacer un endpoint que devuelva todo
  // junto sería otra versión de la misma cuenta para mantener al lado de esta.
  const resumenes = await Promise.all(EMPLEADOS.map(async e =>
    (await pedir("/api/sueldos/pendiente?empleado_id="+e.id)).json()));
  const total = resumenes.reduce((a,r)=>a+r.total, 0);
  $("#kpisDueno").innerHTML = `
    <div class="kpi"><span class="lbl">Total a pagar</span><span class="val">${fmt(total)}</span></div>
    <div class="kpi"><span class="lbl">Valor hora</span><span class="val">${fmt(resumenes[0] ? resumenes[0].valor_hora : 0)}</span></div>`;
  $("#listaEmpleadas").innerHTML = resumenes.map(r=>`
    <div class="fila-emp${r.empleado.id===EMP?" abierta":""}">
      <div>
        <b>${esc(r.empleado.nombre)}</b>
        <span class="det">${r.trabajos.length} ${r.trabajos.length===1?"trabajo":"trabajos"} · ${hhmm(r.minutos_total)} · ${r.dias.length} ${r.dias.length===1?"día":"días"}</span>
      </div>
      <div class="plata">${fmt(r.total)}</div>
      <button class="b-out ver" data-emp="${r.empleado.id}">Ver</button>
    </div>`).join("") || `<div class="vacio"><b>No hay empleados cargados</b>
      Agregalos más abajo y ahí empiezan a aparecer acá.</div>`;
  $("#listaEmpleadas").querySelectorAll(".ver").forEach(b=>{
    b.onclick = () => { $("#quien").value = b.dataset.emp; localStorage.setItem(RECUERDO, b.dataset.emp); cargar(); };
  });

  $("#cfgHora").value = resumenes[0] ? resumenes[0].valor_hora : 0;
  $("#cfgPct").value  = resumenes[0] ? resumenes[0].comision_pct : 40;
  $("#btnCfg").onclick = async () => {
    await mandar("/api/config/sueldos", "PUT", {
      valor_hora: Math.max(0, parseInt($("#cfgHora").value,10)||0),
      comision_pct: Math.max(0, parseInt($("#cfgPct").value,10)||0)});
  };

  pintarLiquidaciones();
}

async function pintarLiquidaciones(){
  const liqs = await (await pedir("/api/sueldos/liquidaciones")).json();
  const card = $("#cardLiquidaciones");
  if(!liqs.length){ card.style.display = "none"; return; }
  card.style.display = "";
  $("#listaLiq").innerHTML = liqs.map(l=>`
    <div class="fila-emp">
      <div><b>${esc(l.empleado||"—")} · ${fechaCorta(l.hasta)}</b>
        <span class="det">${fechaCorta(l.desde)} a ${fechaCorta(l.hasta)} · ${hhmm(l.minutos_pagados)} a ${fmt(l.valor_hora)} + comisiones al ${l.comision_pct}%${
          l.egreso_numero ? ` · egreso N-${String(l.egreso_numero).padStart(5,"0")}${l.forma_pago?" en "+esc(l.forma_pago):""}` : ""}${l.notas?" · "+esc(l.notas):""}</span></div>
      <div class="plata">${fmt(l.total)}</div>
      <button class="b-out verLiq" data-id="${l.id}">Ver</button>
    </div>
    <div class="detalle-liq" id="liq${l.id}" style="display:none;"></div>`).join("");
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

/* Cerrar es de la dueña, que es la que paga, y no se puede deshacer: a partir de
   ahí esos números no se mueven aunque después se corrija un comprobante. Por eso
   el botón dice cuánto se está pagando y a quién. */
function pintarCierre(){
  const caja = $("#cierre");
  if(!caja) return;
  const hay = D.trabajos.length || D.dias.length;
  if(!hay){ caja.innerHTML = ""; return; }
  const faltan = D.trabajos.filter(t=>!t.minutos).length;
  caja.className = "cierre";
  caja.innerHTML = `
    <div style="display:flex;align-items:center;gap:var(--sp-2);">
      <label for="formaCierre" style="margin:0;">Se paga con</label>
      <select id="formaCierre" style="width:auto;">${FORMAS.map(f=>`<option${f==="Efectivo"?" selected":""}>${esc(f)}</option>`).join("")}</select>
    </div>
    <input class="nota" id="notaCierre" placeholder="Nota (opcional): cómo se pagó, si quedó algo…">
    <button class="b-ok" id="btnCerrar">Cerrar y pagar ${fmt(D.total)} a ${esc(D.empleado.nombre)}</button>
    <div class="aviso">Al cerrar se anota solo el egreso en la caja de hoy, privado: la empleada no lo ve.</div>
    ${faltan ? `<div class="aviso">⚠️ ${faltan} ${faltan===1?"trabajo":"trabajos"} sin duración cargada. Ese tiempo no se descuenta de las horas del día, así que si el día tiene horas puestas se paga dos veces: por hora y por comisión.</div>` : ""}`;
  $("#btnCerrar").onclick = async () => {
    const forma = $("#formaCierre").value || "Efectivo";
    if(!confirm(`Se le pagan ${fmt(D.total)} a ${D.empleado.nombre} en ${forma} y arranca un ciclo nuevo.\n`
              + `El egreso queda anotado en la caja de hoy.\n\nEsto no se puede deshacer. ¿Cerramos?`)) return;
    if(await mandar("/api/sueldos/cerrar", "POST",
        {empleado_id: EMP, forma_pago: forma, notas: $("#notaCierre").value.trim() || null})) toast("Pagado ✓");
  };
}

async function cargar(){
  EMP = Number($("#quien").value);
  D = await (await pedir("/api/sueldos/pendiente?empleado_id="+EMP)).json();
  pintar();
}

function pintar(){
  const conComp = D.trabajos.filter(t=>!t.suelto).length;
  $("#totales").innerHTML = `
    <div class="kpi destacado">
      <span class="lbl">${VOS.debe}</span>
      <span class="val">${fmt(D.total)}</span>
      <span class="nota">sin cerrar todavía</span>
    </div>
    <div class="kpi">
      <span class="lbl">Comisiones</span>
      <span class="val">${fmt(D.total_comisiones)}</span>
      <span class="nota">${D.trabajos.length} ${D.trabajos.length===1?"trabajo":"trabajos"} al ${D.comision_pct}%</span>
    </div>
    <div class="kpi">
      <span class="lbl">Horas</span>
      <span class="val">${fmt(D.total_horas)}</span>
      <span class="nota">${hhmm(D.minutos_pagados)} a ${fmt(D.valor_hora)} la hora</span>
    </div>`;

  $("#cuerpo").innerHTML = seccionDias() + seccionTrabajos();
  enganchar();
  if(DUENO) pintarCierre();
}

/* Los días no se agregan de a uno: aparecen solos apenas hay un trabajo de esa
   fecha, con las horas en cero. Si hubiera que acordarse de agregarlos, el día
   que se olvide de uno se le paga de menos y nada avisa. El "+" de abajo es para
   el día que vino y no hizo ningún trabajo a comisión. */
function seccionDias(){
  const filas = D.dias.map(d=>{
    const h = Math.floor((d.minutos||0)/60), m = (d.minutos||0)%60;
    return `<div class="fila-dato${d.sugerido?" sugerido":""}">
      <div class="que">
        <b>${diaDe(d.fecha)} ${fechaCorta(d.fecha)}</b>
        <span class="det">${d.sugerido ? (DUENO ? "hizo trabajos ese día — faltan las horas" : "hiciste trabajos ese día — poné las horas") : ""}</span>
      </div>
      <div class="mins">
        <input type="number" min="0" max="24" inputmode="numeric" value="${h||""}"
               data-fecha="${d.fecha}" data-parte="h" aria-label="Horas del ${d.fecha}">
        <span class="u">h</span>
        <input type="number" min="0" max="59" step="5" inputmode="numeric" value="${m||""}"
               data-fecha="${d.fecha}" data-parte="m" aria-label="Minutos del ${d.fecha}">
        <span class="u">min</span>
      </div>
      <div class="plata">${fmt(Math.round(Math.max((d.minutos||0),0) * D.valor_hora / 60))}</div>
    </div>`;
  }).join("");

  return `<div class="sub-h">${VOS.dias} — ${hhmm(D.minutos_total)} en total</div>
    ${filas || `<div class="vacio"><b>${VOS.sinDias}</b>${VOS.comoCargar}</div>`}
    <div class="agregar">
      <div><label for="nvFecha">Día</label><input type="date" id="nvFecha" value="${hoyArg()}" max="${hoyArg()}"></div>
      <div><label for="nvHoras">Horas</label><input type="number" id="nvHoras" min="0" max="24" inputmode="numeric" placeholder="8"></div>
      <div><label for="nvMin">Min</label><input type="number" id="nvMin" min="0" max="59" step="5" inputmode="numeric" placeholder="0"></div>
      <button class="b-ok" id="btnDia">Agregar día</button>
    </div>`;
}

function seccionTrabajos(){
  const filas = D.trabajos.map(t=>{
    const h = Math.floor((t.minutos||0)/60), m = (t.minutos||0)%60;
    // El número de comprobante linkea a la cuenta del cliente y cae parado sobre
    // ese comprobante: si algo no cuadra, se ve el ticket entero sin buscarlo.
    const marca = t.suelto
      ? `<span class="sin-comp">sin comprobante</span>`
      : (t.cliente_id
          ? `<a class="ver-comp" href="/cuenta?id=${t.cliente_id}&comp=${t.comprobante_id}">#${t.numero} ↗</a>`
          : `<span class="det">#${t.numero}</span>`);
    const quien = t.suelto ? "cargado a mano" : (t.cliente ? titulo(t.cliente) : "mostrador");
    const clave = t.suelto ? `data-trabajo="${t.id}"` : `data-linea="${t.linea_id}"`;
    return `<div class="fila-dato">
      <div class="que">
        <b>${esc(t.nombre)}${t.cantidad>1?` ×${t.cantidad}`:""} ${marca}</b>
        <span class="det">${fechaCorta(t.fecha)} · ${esc(quien)} · ${fmt(t.base)}${
          t.suelto ? ` · <a href="#" class="borrar-suelto" data-trabajo="${t.id}">borrar</a>` : ""}</span>
      </div>
      <div class="mins">
        <input type="number" min="0" max="24" inputmode="numeric" value="${h||""}" ${clave} data-parte="h" aria-label="Horas del trabajo">
        <span class="u">h</span>
        <input type="number" min="0" max="59" step="5" inputmode="numeric" value="${m||""}" ${clave} data-parte="m" aria-label="Minutos del trabajo">
        <span class="u">min</span>
      </div>
      <div class="plata">${fmt(t.comision)}</div>
    </div>`;
  }).join("");

  const opciones = ITEMS.map(i=>`<option value="${i.id}">${esc(i.nombre)} — ${fmt(i.precio)}</option>`).join("");
  /* El bloque para cargar un trabajo sin comprobante se muestra SIEMPRE. Antes
     desaparecía si todavía no había ningún ítem marcado a comisión, que es
     justo el estado en el que está el local el primer día: la pantalla no
     ofrecía nada y parecía que cargar un trabajo a mano no se podía. Ahora, si
     falta esa marca, lo dice y explica dónde se pone. */
  const agregar = ITEMS.length ? `<div class="agregar">
      <div class="ancho"><label for="nvItem">Trabajo sin comprobante</label>
        <select id="nvItem">${opciones}</select></div>
      <div style="flex:0 0 80px;"><label for="nvCant">Cant.</label>
        <input type="number" id="nvCant" min="1" value="1" inputmode="numeric"></div>
      <div><label for="nvTFecha">Día</label>
        <input type="date" id="nvTFecha" value="${hoyArg()}" max="${hoyArg()}"></div>
      <div><label for="nvTHoras">Horas</label>
        <input type="number" id="nvTHoras" min="0" max="24" inputmode="numeric" placeholder="1"></div>
      <div><label for="nvTMin">Min</label>
        <input type="number" id="nvTMin" min="0" max="59" step="5" inputmode="numeric" placeholder="30"></div>
      <button class="b-ok" id="btnSuelto">Agregar trabajo</button>
    </div>` : `<div class="agregar" style="display:block;">
      <b>Trabajo sin comprobante</b>
      <p class="muted" style="margin:var(--sp-1) 0 0;">Para cargar uno a mano falta
        marcar cuáles son los trabajos que van a comisión: se hace en el catálogo
        de <a href="/admin#catalogo">Admin</a>, con la casilla “comisión” de cada
        ítem. El precio del trabajo sale de ahí, así que la comisión se calcula
        siempre sobre la misma base.</p>
    </div>`;

  return `<div class="sub-h">Trabajos a comisión — ${hhmm(D.minutos_comision)} que ya se pagan con la comisión</div>
    ${filas || `<div class="vacio"><b>Ningún trabajo a comisión pendiente</b>${VOS.sinTrabajos}
       ${ITEMS.length ? "Si hiciste uno que no quedó en ningún ticket, cargalo acá abajo." : ""}</div>`}
    ${agregar}`;
}

/* Todo se guarda al salir del casillero, sin botón de guardar: son dos números
   por fila y un botón por cada uno sería una pantalla llena de botones. Después
   de guardar se recarga entero, así el total de arriba nunca queda diciendo algo
   distinto de lo que muestra el detalle. */
function enganchar(){
  document.querySelectorAll(".mins input").forEach(inp => {
    inp.onchange = () => guardarMinutos(inp);
    // Enter en la tablet es "terminé con este": dispara el mismo guardado.
    inp.onkeydown = e => { if(e.key === "Enter") inp.blur(); };
  });
  document.querySelectorAll(".borrar-suelto").forEach(a => {
    a.onclick = async e => {
      e.preventDefault();
      if(!confirm("¿Borrar este trabajo cargado a mano?")) return;
      await mandar("/api/sueldos/trabajo-suelto/"+a.dataset.trabajo, "DELETE");
    };
  });
  const bd = $("#btnDia"); if(bd) bd.onclick = agregarDia;
  const bs = $("#btnSuelto"); if(bs) bs.onclick = agregarSuelto;
}

function minutosDe(inp){
  const fila = inp.closest(".mins");
  const val = p => {
    const e = fila.querySelector(`input[data-parte="${p}"]`);
    return Math.max(0, parseInt(e.value, 10) || 0);
  };
  return val("h")*60 + val("m");
}

async function guardarMinutos(inp){
  const minutos = minutosDe(inp);
  if(minutos > 24*60){ toast("No entran más de 24 horas en un día"); return; }
  const d = inp.dataset;
  if(d.fecha)        await mandar("/api/sueldos/horas", "PUT", {empleado_id: EMP, fecha: d.fecha, minutos});
  else if(d.linea)   await mandar("/api/sueldos/trabajo-minutos", "PUT", {empleado_id: EMP, linea_id: Number(d.linea), minutos});
  else if(d.trabajo) await mandar("/api/sueldos/trabajo-minutos", "PUT", {empleado_id: EMP, trabajo_id: Number(d.trabajo), minutos});
}

async function agregarDia(){
  const fecha = $("#nvFecha").value;
  if(!fecha){ toast("Elegí el día"); return; }
  const minutos = (parseInt($("#nvHoras").value,10)||0)*60 + (parseInt($("#nvMin").value,10)||0);
  if(minutos <= 0){ toast("Poné cuántas horas hiciste"); return; }
  await mandar("/api/sueldos/horas", "PUT", {empleado_id: EMP, fecha, minutos});
}

async function agregarSuelto(){
  const fecha = $("#nvTFecha").value;
  if(!fecha){ toast("Elegí el día"); return; }
  const minutos = (parseInt($("#nvTHoras").value,10)||0)*60 + (parseInt($("#nvTMin").value,10)||0);
  await mandar("/api/sueldos/trabajo-suelto", "POST", {
    empleado_id: EMP, item_id: Number($("#nvItem").value),
    cantidad: Math.max(1, parseInt($("#nvCant").value,10)||1), fecha, minutos});
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

/* ---------- la puerta ---------- */

/* Con el usuario empleado no se muestra nada hasta que alguien dice quién es y
   pone su código. Se pide en CADA entrada a la pantalla: en el local la tablet
   queda prendida y pasando de mano en mano, así que una sesión que quedara
   abierta es el sueldo de una a la vista de la siguiente.

   Sin ningún código cargado no se entra. Es a propósito: si se dejara pasar
   "mientras no haya códigos", el día que la dueña carga el primero recién ahí
   empieza a proteger, y hasta entonces la pantalla estuvo abierta sin que nadie
   se enterara. */
async function abrirPuerta(){
  const puerta = $("#puerta"), cuerpo = $("#puertaCuerpo");
  $("#todo").hidden = true;
  puerta.hidden = false;

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
    const caja = $("#quien").closest(".quien");
    caja.innerHTML = `<label>Sos</label>
      <span class="quien-nombre">${esc(d.empleado.nombre)}</span>
      <button class="b-out" id="salirSueldos" title="Cerrar y que entre otra">Salir</button>
      <select id="quien" hidden></select>`;
    $("#salirSueldos").onclick = () => location.reload();
    arranque();
  };
  $("#pEntrar").onclick = entrar;
  $("#pPin").addEventListener("keydown", ev => { if(ev.key === "Enter") entrar(); });
  setTimeout(()=>$("#pPin").focus(), 0);
}

if(DUENO) arranque(); else abrirPuerta();
