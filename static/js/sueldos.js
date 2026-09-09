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

/* Quién está cargando queda guardado en el aparato: hay un solo login compartido
   y la tablet es siempre la misma, así que preguntárselo cada vez es una molestia
   diaria. El día que haya un PIN por persona, esto se reemplaza por el login. */
const RECUERDO = "sueldos_empleado";

let EMPLEADOS = [], ITEMS = [], EMP = null, D = null;

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
  EMPLEADOS = await (await authFetch("/api/empleados")).json();
  const sel = $("#quien");
  if(!EMPLEADOS.length){
    sel.closest(".quien").style.display = "none";
    $("#cuerpo").innerHTML = `<div class="vacio"><b>Todavía no hay nadie en la lista</b>
      La dueña carga los nombres en Admin, y desde ahí aparecen acá.</div>`;
    return;
  }
  sel.innerHTML = EMPLEADOS.map(e=>`<option value="${e.id}">${esc(e.nombre)}</option>`).join("");
  const guardado = localStorage.getItem(RECUERDO);
  if(guardado && EMPLEADOS.some(e=>String(e.id)===guardado)) sel.value = guardado;
  sel.onchange = () => { localStorage.setItem(RECUERDO, sel.value); cargar(); };
  localStorage.setItem(RECUERDO, sel.value);

  ITEMS = await (await authFetch("/api/sueldos/items-comision")).json();
  cargar();
}

async function cargar(){
  EMP = Number($("#quien").value);
  D = await (await authFetch("/api/sueldos/pendiente?empleado_id="+EMP)).json();
  pintar();
}

function pintar(){
  const conComp = D.trabajos.filter(t=>!t.suelto).length;
  $("#totales").innerHTML = `
    <div class="kpi destacado">
      <span class="lbl">Se te debe</span>
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
        <span class="det">${d.sugerido ? "hiciste trabajos ese día — poné las horas" : ""}</span>
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

  return `<div class="sub-h">Días que trabajaste — ${hhmm(D.minutos_total)} en total</div>
    ${filas || `<div class="vacio"><b>Todavía no cargaste ningún día</b>
       Agregá abajo el día y cuántas horas hiciste.</div>`}
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
    </div>` : "";

  return `<div class="sub-h">Trabajos a comisión — ${hhmm(D.minutos_comision)} que ya se pagan con la comisión</div>
    ${filas || `<div class="vacio"><b>Ningún trabajo a comisión pendiente</b>
       Aparecen solos cuando se cobra un ticket a tu nombre con un ítem marcado a comisión.</div>`}
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
    const r = await authFetch(url, {
      method: metodo,
      headers: cuerpo ? {"Content-Type":"application/json"} : {},
      body: cuerpo ? JSON.stringify(cuerpo) : undefined});
    if(!r.ok){
      const e = await r.json().catch(()=>({}));
      toast(e.detail || "No se pudo guardar");
      return false;
    }
    await cargar();
    return true;
  }catch(e){
    toast("No se pudo guardar: " + e.message);
    return false;
  }
}

arranque();
