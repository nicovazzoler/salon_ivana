/* Sueldos, la pantalla de la empleada: entra, elige su nombre y ve lo que se le
   debe. A mano carga su horario de cada día; cuánto duró cada trabajo sale del
   catálogo y se corrige si no fue así. El resto sale de los comprobantes. */
requireLogin(); pintarNav(); ajustarPorRol();

const $=s=>document.querySelector(s);
const fmt=n=>"$"+(n||0).toLocaleString("es-AR");
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function toast(m){const t=$("#toast");t.textContent=m;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2200);}

/* Con el usuario empleado, la pantalla se abre con un código por persona. El
   permiso vive en memoria y no en localStorage: se pide en cada entrada, así el
   que agarra la tablet después no encuentra la sesión de la otra. El candado de
   verdad lo pone el servidor. La dueña no pasa por acá. */
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
// recorta a ella sola, y para elegir a la ayudante del día necesita ver a
// las demás. Son los mismos nombres que ya ve en el desplegable de facturar.
let TODAS = [];
// Lo pendiente de cada una, que arma el panel de la dueña. Lo usa el desplegable
// para decidir a quién sigue mostrando.
let PENDIENTE = {};

/* A quién se le paga sueldo: la casilla de Valores y comisiones. Si a una que no
   cobra le quedó algo pendiente aparece igual: esconder plata que se debe es
   peor que un nombre de más. */
const seLePaga = e => e.cobra_sueldo || (PENDIENTE[e.id] || 0) > 0;
const DUENO = esDueno();
/* La misma tarjeta la miran dos personas distintas: la empleada mira lo suyo y
   la dueña mira lo de otra. Los rótulos cambian con eso, porque "se te debe" en
   la pantalla de la dueña es directamente falso. */
const VOS = {
  debe:   DUENO ? "Se le debe" : "Se te debe",
  quien:  DUENO ? "Empleada" : "Quién sos",
  sinNada: DUENO ? "No tiene nada pendiente" : "No tenés nada pendiente",
  comoAparece: DUENO ? "Aparecen solos al cobrar un ticket a su nombre."
                     : "Aparecen solos al cobrar un ticket a tu nombre.",
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
    $("#rotuloQuien").textContent = VOS.quien;
  } else {
    $("#tituloDetalle").textContent = "Tu semana";
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
  if(DUENO) await cargarPanelDueno();
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
  // Puede no quedar ninguna para mostrar: nadie tiene código todavía y nadie
  // tiene nada pendiente. Sin esto el desplegable quedaba vacío, se pedía el
  // sueldo del empleado 0 y la pantalla se rompía entera con un 404.
  if(!visibles.length){
    sel.closest(".quien").style.display = "none";
    $("#totales").innerHTML = "";
    $("#cuerpo").innerHTML = `<div class="vacio"><b>No hay nada pendiente</b>
      Las empleadas con código aparecen siempre; las demás, cuando se les deba algo.</div>`;
    EMP = null;
    return;
  }
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
  if(DUENO) await cargarPanelDueno();
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
  const cobra = Object.fromEntries(EMPLEADOS.map(e => [e.id, !!e.cobra_sueldo]));
  // "Tiene algo" no es "tiene ciclos": el ciclo en curso existe siempre, aunque
  // esté en blanco, porque es donde la empleada carga sus horas.
  const conAlgo = r => r.ciclos.filter(c => !c.vacio).length;
  const resumenes = todos.filter(r => (r.activo || r.total > 0 || conAlgo(r))
                                   && (cobra[r.empleado.id] || r.total > 0 || conAlgo(r)));
  const total = resumenes.reduce((a,r)=>a+r.total, 0);
  const ciclosViejos = resumenes.reduce((a,r)=>a + Math.max(conAlgo(r) - 1, 0), 0);
  $("#kpisDueno").innerHTML = `
    <div class="kpi"><span class="lbl">Total a pagar</span><span class="val">${fmt(total)}</span></div>
    ${ciclosViejos ? `<div class="kpi"><span class="lbl">Semanas atrasadas</span><span class="val">${ciclosViejos}</span></div>` : ""}`;
  $("#listaEmpleadas").innerHTML = resumenes.map(r=>`
    <div class="fila-emp${r.empleado.id===EMP?" abierta":""}">
      <div>
        <b>${esc(r.empleado.nombre)}${r.activo ? "" : " · de baja"}</b>
        <span class="det">${r.valor_hora ? `${fmt(r.valor_hora)} la hora · `
          : `<span style="color:var(--danger);">sin valor hora</span> · `}${
          conAlgo(r) ? `${conAlgo(r)} ${conAlgo(r)===1?"ciclo":"ciclos"} · ${hhmm(r.minutos_total)}` : "sin nada pendiente"}${
          r.sin_tiempo ? ` · <span style="color:var(--danger);">${r.sin_tiempo===1 ? "falta 1 duración" : `faltan ${r.sin_tiempo} duraciones`}</span>` : ""}${
          r.sin_horas ? ` · <span style="color:var(--danger);">${r.sin_horas===1 ? "falta 1 día sin horas" : `faltan ${r.sin_horas} días sin horas`}</span>` : ""}</span>
      </div>
      <div class="plata">${fmt(r.total)}</div>
      <button class="b-out ver" data-emp="${r.empleado.id}">Ver</button>
    </div>`).join("") || `<div class="vacio"><b>No hay empleados cargados</b>
      Se agregan en Admin y se les pone el valor hora en Valores y comisiones.</div>`;
  // "Ver" cambia la empleada del detalle, que está más abajo en la página: sin
  // el scroll, tocarlo parecía no hacer nada.
  $("#listaEmpleadas").querySelectorAll(".ver").forEach(b=>{
    b.onclick = async () => {
      // La lista de arriba muestra a quien tenga ALGO para mirar; el desplegable,
      // solo a quien cobre. Sin la opción el .value no agarra y el detalle abría
      // el de otra persona, diciendo "no hay nada pendiente".
      const sel = $("#quien");
      if(!sel.querySelector(`option[value="${b.dataset.emp}"]`)){
        const emp = EMPLEADOS.find(e => String(e.id) === String(b.dataset.emp));
        sel.insertAdjacentHTML("beforeend",
          `<option value="${b.dataset.emp}">${esc(emp ? emp.nombre : "—")}</option>`);
      }
      sel.value = b.dataset.emp;
      localStorage.setItem(RECUERDO, b.dataset.emp);
      await cargar();
      $("#tituloDetalle").closest(".card").scrollIntoView({behavior:"smooth", block:"start"});
    };
  });

  pintarLiquidaciones();
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
  EMP = Number($("#quien").value) || null;
  if(!EMP) return;                       // no hay a quién mirar: lo dice llenarSelector
  D = await (await pedir("/api/sueldos/pendiente?empleado_id="+EMP)).json();
  pintar();
}

function pintar(){
  if(DUENO) pintarDuena(); else pintarEmpleada();
  enganchar();
}

function pintarDuena(){
  // El ciclo en curso está siempre, vacío o no: no cuenta como semana sin pagar.
  const pendientes = D.ciclos.filter(c => !c.vacio).length;
  $("#totales").innerHTML = `
    <div class="kpi destacado">
      <span class="lbl">${VOS.debe}</span>
      <span class="val">${fmt(D.total)}</span>
      <span class="nota">${pendientes} ${pendientes===1?"ciclo":"ciclos"} sin pagar</span>
    </div>
    <div class="kpi">
      <span class="lbl">Comisiones</span>
      <span class="val">${fmt(D.total_comisiones)}</span>
    </div>
    <div class="kpi">
      <span class="lbl">Horas</span>
      <span class="val">${fmt(D.total_horas)}</span>
      <span class="nota">${hhmm(D.minutos_total)} en el local · ${
        D.valor_hora ? `${fmt(D.valor_hora)} la hora` : "sin valor hora"}</span>
    </div>`;
  if(D.en_espera) $("#totales").insertAdjacentHTML("beforeend",
    `<div class="kpi" style="flex:1 1 100%;"><span class="lbl">Sin contar todavía</span>
     <span class="val">${fmt(D.en_espera)}</span>
     <span class="nota">${D.sin_tiempo} ${D.sin_tiempo===1?"trabajo":"trabajos"} sin duración, ni en el catálogo ni cargada</span></div>`);

  // El ciclo en curso primero: es el que se está llenando y a lo que se entra.
  // Las semanas viejas sin pagar van abajo, que son la excepción.
  const hoy = hoyArg();
  const orden = [...D.ciclos].sort((a, b) =>
    (hoy >= b.desde && hoy <= b.hasta) - (hoy >= a.desde && hoy <= a.hasta)
    || a.desde.localeCompare(b.desde));
  $("#cuerpo").innerHTML = orden.length
    ? orden.map(dibujarCiclo).join("")
    : `<div class="vacio"><b>${VOS.sinNada}</b>${VOS.comoAparece}</div>`;
}

/* La empleada no ve semanas: ve cuánto le toca, el día de hoy y la lista de los
   días que todavía no cobró. Las semanas son de la dueña, que es la que paga. */
function pintarEmpleada(){
  $("#tituloDetalle").hidden = true;
  const dias = D.ciclos.flatMap(c => c.dias).sort((a, b) => b.fecha.localeCompare(a.fecha));
  const conAlgo = dias.filter(d => d.minutos || d.trabajos.length);
  const desde = (conAlgo.length ? conAlgo[conAlgo.length - 1] : dias[dias.length - 1] || {}).fecha;
  const trabajos = dias.flatMap(d => d.trabajos.filter(t => t.minutos));
  const minPagados = D.ciclos.reduce((a, c) => a + c.minutos_pagados, 0);
  $("#totales").innerHTML = `<div class="cuenta">
    <div class="grande"><span class="lbl">Te toca cobrar</span><span class="val">${fmt(D.total)}</span>
      ${desde ? `<span class="desde">desde el ${diaDe(desde).toLowerCase()} ${dm(desde)}</span>` : ""}</div>
    <div class="renglones">
      <div class="r"><span>Comisiones <small>${trabajos.length} ${trabajos.length===1?"trabajo":"trabajos"} · ${hhmm(trabajos.reduce((a, t) => a + t.minutos, 0))}</small></span><span>${fmt(D.total_comisiones)}</span></div>
      <div class="r"><span>Horas <small>${hhmm(minPagados)}${D.valor_hora ? ` a ${fmt(D.valor_hora)}` : ""}</small></span><span>${fmt(D.total_horas)}</span></div>
      ${D.en_espera ? `<div class="r falta-r"><span>Sin contar <small>${D.sin_tiempo} sin duración</small></span><span>${fmt(D.en_espera)}</span></div>` : ""}
      <div class="r total"><span>Te toca</span><span>${fmt(D.total)}</span></div>
    </div></div>`;
  const hoy = dias.find(d => d.fecha === hoyArg());
  $("#cuerpo").innerHTML = `
    ${hoy && !hoy.horas_pagadas ? tarjetaHoy(hoy) : ""}
    <div class="seccion-h"><h3>Días</h3>${conAlgo.length
      ? `<span>${hhmm(dias.reduce((a, d) => a + d.minutos, 0))} en el local</span>` : ""}</div>
    ${dias.map(dibujarDia).join("") || `<div class="vacio-chico">${VOS.sinNada}.</div>`}
    <div id="cobrado"></div>`;
  pintarCobrado();
}

/* ---------- el horario, en tandas ---------- */

const aMin = t => { const [h, m] = t.split(":").map(Number); return h*60 + m; };
const aHora = m => `${String(Math.floor(m/60)).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`;
const minTandas = t => t.reduce((a, [x, y]) => a + aMin(y) - aMin(x), 0);
const descanso = t => t.length > 1 ? aMin(t[1][0]) - aMin(t[0][1]) : 0;
const textoTandas = t => t.map(([x, y]) => `${x} a ${y}`).join(" y ");
const dm = iso => { const [, m, d] = iso.split("-").map(Number); return `${d}/${m}`; };
const diaCorto = iso => `${diaDe(iso).slice(0, 3)} ${dm(iso)}`;
// El horario de un día dicho en una línea; las filas de antes de las tandas solo tienen minutos.
const horarioDe = d => d.tandas.length
  ? `${textoTandas(d.tandas)}${d.tandas[1] ? ` · ${hhmm(descanso(d.tandas))} de descanso` : ""}`
  : hhmm(d.minutos);
// Como el round() del backend: el medio va al par.
const redondear = x => { const f = Math.floor(x), r = x - f; return r > .5 || (r === .5 && f % 2) ? f + 1 : f; };
const ROT = DUENO ? ["Entró", "Salió", "Volvió", "Se fue"] : ["Entré", "Salí", "Volví", "Me fui"];

function tandasHTML(t){
  t = t && t.length ? t : [["", ""]];
  return `
    <div class="tanda"><div><label>${ROT[0]}</label><input type="time" class="t0a" value="${t[0][0]}"></div>
      <div><label>${ROT[1]}</label><input type="time" class="t0b" value="${t[0][1]}"></div></div>
    ${t[1] ? `<div class="tanda"><div><label>${ROT[2]}</label><input type="time" class="t1a" value="${t[1][0]}"></div>
      <div><label>${ROT[3]}</label><input type="time" class="t1b" value="${t[1][1]}"></div>
      <button type="button" class="quitar" aria-label="Sacar la segunda tanda">${icono("cruz")}</button></div>`
      : `<button type="button" class="mas-tanda">+ ${DUENO ? "Volvió" : "Volví"} después de un descanso</button>`}
    <div class="tandas-pie"><span class="suma"></span><span class="desc"></span></div>`;
}
function leerTandas(caja){
  const v = c => (caja.querySelector(c) || {}).value || "";
  const t = [[v(".t0a"), v(".t0b")]];
  if(caja.querySelector(".t1a")) t.push([v(".t1a"), v(".t1b")]);
  return t;
}
function tandasValidas(t){
  if(t.some(([a, b]) => !a || !b || aMin(b) <= aMin(a))) return false;
  return !(t[1] && aMin(t[1][0]) < aMin(t[0][1]));
}
/* Engancha un editor ya dibujado. `boton` es el que guarda: dice cuántas horas
   va a guardar, y no se puede tocar mientras el horario no cierra. */
function engancharTandas(caja, boton){
  const act = () => {
    const t = leerTandas(caja), ok = tandasValidas(t);
    caja.querySelector(".suma").textContent = ok ? "= " + hhmm(minTandas(t)) : "";
    caja.querySelector(".desc").textContent = ok && t[1] ? `${hhmm(descanso(t))} de descanso` : "";
    boton.disabled = !ok;
    boton.textContent = ok ? `Guardar ${hhmm(minTandas(t))}` : "Guardar";
  };
  caja.querySelectorAll("input").forEach(i => i.oninput = act);
  const redibujar = t => { caja.innerHTML = tandasHTML(t); engancharTandas(caja, boton); };
  const mas = caja.querySelector(".mas-tanda"), quitar = caja.querySelector(".quitar");
  if(mas) mas.onclick = () => {
    const t = leerTandas(caja);
    t.push([t[0][1] ? aHora(Math.min(aMin(t[0][1]) + 60, 23*60)) : "", ""]);
    redibujar(t);
  };
  if(quitar) quitar.onclick = () => redibujar([leerTandas(caja)[0]]);
  act();
}

const guardarHorario = (fecha, tandas) => mandar("/api/sueldos/horas", "PUT",
  {empleado_id: EMP, fecha, tandas: tandas.map(([desde, hasta]) => ({desde, hasta}))});

let EDITANDO_HOY = false;
function tarjetaHoy(d){
  if(d.minutos && !EDITANDO_HOY) return `<div class="hoy"><div class="hoy-cab"><h3>Hoy, ${diaDe(d.fecha).toLowerCase()} ${dm(d.fecha)}</h3></div>
    <div class="cargado"><span>${d.tandas.length ? horarioDe(d) : "Horas cargadas"}</span><b>${hhmm(d.minutos)}</b>
      <button class="lapiz" id="editarHoy" aria-label="Corregir el horario de hoy">${icono("lapiz")}</button></div></div>`;
  const sugerido = !d.tandas.length && d.sugerido.length;
  return `<div class="hoy"><div class="hoy-cab"><h3>Hoy, ${diaDe(d.fecha).toLowerCase()} ${dm(d.fecha)}</h3>
      ${sugerido ? `<span class="nota-hoy">Es tu horario de la agenda: cambiá lo que no fue así</span>` : ""}</div>
    <div class="tandas" id="hoyTandas" data-fecha="${d.fecha}">${tandasHTML(d.tandas.length ? d.tandas : d.sugerido)}</div>
    <div class="hoy-acc">${EDITANDO_HOY ? `<button class="b-out" id="cancelarHoy">Cancelar</button>` : ""}
      <button class="b-ok" id="guardarHoy">Guardar</button></div></div>`;
}

/* Un cartel propio y no preguntar(): adentro va un formulario, no un texto. Usa
   las mismas piezas, así se ve igual que los demás carteles de la app. */
function cartelForm({ titulo, texto = "", cuerpo, si = "Guardar", extra = null, alAbrir, alSi }){
  const fondo = document.createElement("div");
  fondo.className = "dlg-fondo";
  fondo.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlgTitulo">
    <h3 id="dlgTitulo">${esc(titulo)}</h3>${texto ? `<p class="dlg-p">${esc(texto)}</p>` : ""}
    <div class="dlg-cuerpo">${cuerpo}</div>
    <div class="dlg-acciones">${extra ? `<button type="button" class="b-out dlg-extra">${esc(extra.texto)}</button>` : ""}
      <button type="button" class="b-out dlg-no">Cancelar</button>
      <button type="button" class="dlg-si">${esc(si)}</button></div></div>`;
  document.body.appendChild(fondo);
  const cerrar = () => { fondo.remove(); removeEventListener("keydown", tecla, true); };
  const tecla = e => { if(e.key === "Escape"){ e.preventDefault(); cerrar(); } };
  addEventListener("keydown", tecla, true);
  fondo.onclick = e => { if(e.target === fondo) cerrar(); };
  fondo.querySelector(".dlg-no").onclick = cerrar;
  const bSi = fondo.querySelector(".dlg-si");
  bSi.onclick = async () => { bSi.disabled = true; if(await alSi(fondo) !== false) cerrar(); else bSi.disabled = false; };
  if(extra) fondo.querySelector(".dlg-extra").onclick = async () => { cerrar(); await extra.alClick(); };
  if(alAbrir) alAbrir(fondo, bSi);
  (fondo.querySelector("input") || bSi).focus();
}

function cartelHorario(fecha){
  const d = D.ciclos.flatMap(c => c.dias).find(x => x.fecha === fecha);
  if(!d) return;
  cartelForm({
    titulo: `Horario del ${diaDe(fecha).toLowerCase()} ${dm(fecha)}`, texto: DUENO ? D.empleado.nombre : "",
    cuerpo: `<div class="tandas caja-t">${tandasHTML(d.tandas.length ? d.tandas : d.sugerido)}</div>`,
    extra: d.minutos ? { texto: DUENO ? "No vino" : "No vine",
                         alClick: () => mandar("/api/sueldos/horas", "PUT", {empleado_id: EMP, fecha, tandas: []}) } : null,
    alAbrir: (fondo, bSi) => engancharTandas(fondo.querySelector(".caja-t"), bSi),
    alSi: async fondo => {
      const t = leerTandas(fondo.querySelector(".caja-t"));
      if(!tandasValidas(t)) return false;
      return await guardarHorario(fecha, t);
    }});
}

function cartelDuracion(t){
  const actual = t.minutos || 0;
  cartelForm({
    titulo: `¿Cuánto duró ${t.nombre}?`,
    texto: t.duracion_catalogo ? `En el catálogo dice ${hhmm(t.duracion_catalogo)}.` : "Este servicio no tiene duración en el catálogo.",
    cuerpo: `<div class="dos-campos">
      <div><label for="durH">Horas</label><input id="durH" type="number" inputmode="numeric" min="0" max="12" value="${Math.floor(actual/60) || ""}"></div>
      <div><label for="durM">Minutos</label><input id="durM" type="number" inputmode="numeric" min="0" max="59" step="5" value="${actual % 60 || ""}"></div></div>`,
    extra: t.minutos_propios && t.duracion_catalogo
      ? { texto: "La del catálogo", alClick: () => guardarDuracion(t, 0) } : null,
    alSi: async fondo => {
      const m = (parseInt(fondo.querySelector("#durH").value, 10) || 0) * 60
              + (parseInt(fondo.querySelector("#durM").value, 10) || 0);
      if(m <= 0){ toast("Poné cuánto duró"); return false; }
      return await guardarDuracion(t, m);
    }});
}
// Cero vuelve a la duración del catálogo.
const guardarDuracion = (t, minutos) => mandar("/api/sueldos/trabajo-minutos", "PUT", t.suelto
  ? {empleado_id: EMP, trabajo_id: t.id, minutos}
  : {empleado_id: EMP, linea_id: t.linea_id, minutos});

/* ---------- los días ---------- */

// Qué días y qué cobros están desplegados: sobrevive a cada redibujo.
const ABIERTOS = new Set();

/* Un ciclo es la semana del local: de sábado a viernes, que es cuando se paga.
   No es una ventana para filtrar, es la unidad con la que se paga: una semana
   sin cerrar sigue apareciendo entera al lado de la nueva. */
function dibujarCiclo(c){
  const hoy = hoyArg();
  const enCurso = hoy >= c.desde && hoy <= c.hasta;
  const listo = !c.sin_tiempo && !c.sin_horas && c.total > 0;
  return `<div class="ciclo${enCurso ? " en-curso" : ""}" data-desde="${c.desde}">
    <div class="ciclo-cab">
      <div>
        <h3>${rangoLargo(c.desde, c.hasta)}${c.pagado_antes ? ` <span class="saldo-de">saldo</span>` : ""}</h3>
        <div class="det">${c.pagado_antes ? `ya se pagaron ${fmt(c.pagado_antes)} de esta semana · ` : ""}${hhmm(c.minutos_total)} en el local · ${hhmm(c.minutos_comision)} de trabajos · comisiones ${fmt(c.total_comisiones)} + horas ${fmt(c.total_horas)}</div>
      </div>
      <div class="plata">${fmt(c.total)}</div>
    </div>
    <div class="ciclo-cuerpo">
      ${[...c.dias].sort((a, b) => b.fecha.localeCompare(a.fecha)).map(dibujarDia).join("")}
      ${DUENO && !c.vacio ? filaCerrar(c, listo) : ""}
    </div>
  </div>`;
}

/* Un renglón por día, que se abre para ver el horario y los trabajos. Están
   TODOS los del ciclo hasta hoy, así que uno en blanco es "no vino" y no "falta
   cargarlo". */
function dibujarDia(d){
  const esHoy = d.fecha === hoyArg();
  const rotulo = esHoy ? `Hoy ${dm(d.fecha)}` : diaCorto(d.fecha);
  const clase = `dia${esHoy ? " hoy-d" : ""}`;
  const botonHorario = txt => d.horas_pagadas ? ""
    : `<button class="b-out btn-chico cargar-h" data-fecha="${d.fecha}">${txt}</button>`;
  if(!d.minutos && !d.trabajos.length) return `<div class="${clase}"><div class="dia-fila quieta">
    <b>${rotulo}</b><span class="det"><span class="tenue">${d.horas_pagadas ? "horas ya cobradas"
      : esHoy ? "todavía sin cargar" : DUENO ? "no vino" : "no viniste"}</span></span>
    ${botonHorario("Cargar horario")}</div></div>`;

  const minTrab = d.trabajos.reduce((a, t) => a + (t.minutos || 0), 0);
  const com = d.trabajos.reduce((a, t) => a + (t.minutos ? t.comision : 0), 0);
  const porHora = Math.max(d.minutos - minTrab, 0);
  const plataHoras = redondear(porHora * D.valor_hora / 60);
  const faltaHoras = !d.minutos && !d.horas_pagadas;
  const faltaTiempo = d.trabajos.some(t => !t.minutos);
  const n = d.trabajos.length;
  const cantidad = n ? `${n} ${n === 1 ? "trabajo" : "trabajos"}` : "sin trabajos";
  const det = (d.horas_pagadas ? "horas ya cobradas" : faltaHoras ? `<span class="falta">Falta el horario</span>`
               : d.tandas.length ? textoTandas(d.tandas) : hhmm(d.minutos))
    + ` · ${cantidad}${faltaTiempo ? ` · <span class="falta">falta un tiempo</span>` : ""}`
    + (DUENO && d.sin_respaldo ? ` <span class="sin-comp">sin trabajos</span>` : "");
  const abierto = ABIERTOS.has(d.fecha);
  return `<div class="${clase}${abierto ? " abierto" : ""}">
    <button class="dia-fila" data-k="${d.fecha}" aria-expanded="${abierto}"><b>${rotulo}</b><span class="det">${det}</span>
      <span class="plata">${fmt(com + (d.horas_pagadas ? 0 : plataHoras))}</span><span class="flecha">${icono("flecha")}</span></button>
    ${abierto ? `<div class="dia-cuerpo">
      <div class="dia-horario">${d.horas_pagadas ? `<span>Las horas de este día ya se cobraron.</span>`
        : d.minutos ? `<span><b>${horarioDe(d)}</b></span>${botonHorario("Corregir horario")}`
        : `<span class="falta">Sin horario</span>${botonHorario("Cargar horario")}`}</div>
      ${d.minutos ? `<div class="cuentita">${hhmm(d.minutos)} en el local${minTrab ? ` − ${hhmm(minTrab)} en trabajos con comisión` : ""} = <b>${hhmm(porHora)} por hora</b>, ${fmt(plataHoras)}</div>` : ""}
      ${d.trabajos.map(dibujarTrabajo).join("")}
      <div class="dia-acciones"><button class="b-out btn-chico agregar-trabajo" data-fecha="${d.fecha}">+ Trabajo sin comprobante</button></div>
    </div>` : ""}
  </div>`;
}

function dibujarTrabajo(t){
  const marca = t.suelto
    ? `<span class="sin-comp">sin comprobante</span>`
    : (t.cliente_id
        ? `<a class="ver-comp" href="/cuenta?id=${t.cliente_id}&comp=${t.comprobante_id}">#${t.numero}</a>`
        : `<span class="tenue">#${t.numero}</span>`);
  const quien = t.suelto ? "" : (t.cliente ? titulo(t.cliente) : "mostrador") + " · ";
  const clave = t.suelto ? `data-trabajo="${t.id}"` : `data-linea="${t.linea_id}"`;
  return `<div class="trab${t.minutos ? "" : " sin-tiempo"}">
    <div><b>${esc(t.nombre)}${t.cantidad>1?` ×${t.cantidad}`:""} ${marca}</b>
      <span class="det">${esc(quien)}${fmt(t.base)} · ${t.pct ?? 0}%${
        t.suelto ? ` · <a href="#" class="borrar-suelto" data-trabajo="${t.id}">borrar</a>` : ""}</span></div>
    <span class="dur">${t.minutos ? hhmm(t.minutos) : `<span class="falta">falta el tiempo</span>`}
      <button class="editar-min" ${clave} aria-label="Cambiar cuánto duró">${icono("lapiz")}</button></span>
    <span class="plata${t.minutos ? "" : " no-cuenta"}">${fmt(t.comision)}</span>
  </div>`;
}

/* ---------- lo que ya cobró ---------- */

let LIQS = null, VER_TODO_COBRADO = false;
const DETALLES = new Map();
const MAS_COBRADO = 6;

/* Plegado: es la historia, y lo que se mira todos los días está arriba. Al
   abrir un cobro se ve día por día, que es lo que ella cruza con su cuaderno. */
async function pintarCobrado(){
  const caja = $("#cobrado");
  if(!caja) return;
  if(!LIQS) LIQS = await (await pedir("/api/sueldos/liquidaciones?limite=200")).json();
  if(!LIQS.length){ caja.innerHTML = ""; return; }
  const ult = LIQS[0];
  const lista = VER_TODO_COBRADO ? LIQS : LIQS.slice(0, MAS_COBRADO);
  caja.innerHTML = `<details class="cobrado"${ABIERTOS.has("cobrado") ? " open" : ""}>
    <summary><h3>Lo que ya cobraste</h3><span>último: ${diaDe(ult.cerrada.slice(0, 10)).toLowerCase()} ${dm(ult.cerrada.slice(0, 10))}, ${fmt(ult.total)}</span>${icono("flecha")}</summary>
    ${lista.map(cobroHTML).join("")}
    ${!VER_TODO_COBRADO && LIQS.length > MAS_COBRADO
      ? `<p class="ver-mas"><button class="b-out btn-chico" id="verMasCobrado">Ver ${LIQS.length - MAS_COBRADO} más</button></p>` : ""}
  </details>`;
  caja.querySelector("details").ontoggle = ev => ev.target.open ? ABIERTOS.add("cobrado") : ABIERTOS.delete("cobrado");
  const mas = $("#verMasCobrado");
  if(mas) mas.onclick = () => { VER_TODO_COBRADO = true; pintarCobrado(); };
  caja.querySelectorAll(".hist-fila").forEach(b => b.onclick = async () => {
    const k = b.dataset.k;
    if(ABIERTOS.has(k)) ABIERTOS.delete(k);
    else {
      ABIERTOS.add(k);
      if(!DETALLES.has(k)) DETALLES.set(k, await (await pedir("/api/sueldos/liquidaciones/" + k.slice(4))).json());
    }
    pintarCobrado();
  });
}

function cobroHTML(l){
  const k = "liq-" + l.id, ab = ABIERTOS.has(k) && DETALLES.has(k);
  const dia = l.cerrada.slice(0, 10);
  return `<div class="hist${ab ? " abierto" : ""}"><button class="hist-fila" data-k="${k}" aria-expanded="${ab}">
      <span><b>${diaDe(dia)} ${dm(dia)}</b>
        <span class="det">${l.desde ? `${diaCorto(l.desde).toLowerCase()} a ${diaCorto(l.hasta).toLowerCase()}` : ""}${
          l.forma_pago ? ` · en ${esc(l.forma_pago.toLowerCase())}` : ""}${l.parcial ? " · pago parcial" : ""}</span></span>
      <span class="plata">${fmt(l.total)}</span><span class="flecha">${icono("flecha")}</span></button>
    ${ab ? resumenCobro(DETALLES.get(k)) : ""}</div>`;
}

// Los números salen de la foto del cierre: lo que se pagó, no lo que daría hoy.
function resumenCobro(liq){
  const fechas = [...new Set([...liq.dias.map(d => d.fecha), ...liq.trabajos.map(t => t.fecha)])].sort();
  const filas = fechas.map(f => {
    const d = liq.dias.find(x => x.fecha === f) || {minutos: 0, tandas: []};
    const tr = liq.trabajos.filter(t => t.fecha === f);
    const com = tr.reduce((a, t) => a + t.comision, 0), mt = tr.reduce((a, t) => a + t.minutos, 0);
    const pagos = Math.max(d.minutos - mt, 0), horas = redondear(pagos * (liq.valor_hora || 0) / 60);
    return `<div class="rd"><b>${diaCorto(f)}</b>
      <span class="det">${d.minutos ? `${hhmm(d.minutos)} en el local` : "sin horas"}${tr.length
        ? ` <em>· ${tr.length} ${tr.length === 1 ? "trabajo" : "trabajos"}, ${fmt(com)}</em>` : ""}${
        d.minutos ? ` <em>· ${hhmm(pagos)} por hora, ${fmt(horas)}</em>` : ""}</span>
      <span class="plata">${fmt(com + horas)}</span></div>`;
  }).join("");
  return `<div class="resumen-dias">${filas || `<div class="rd"><span class="det">Sin detalle de días.</span></div>`}
    <div class="rd tot"><span>Cobrado</span><span></span><span class="plata">${fmt(liq.total)}</span></div></div>`;
}

/* Cerrar antes de que termine la semana NO es cerrar la semana: pagar un
   miércoles paga lo que va, y lo del jueves y el viernes cae en el mismo ciclo,
   de ahí que el botón diga "pago parcial". Al lado va el cierre anticipado, para
   la semana que sí terminó antes. Son dos cosas y por eso son dos botones. */
function filaCerrar(c, listo){
  // El viernes mismo YA es cerrar la semana: es el último día y el de pago. Con
  // ">" el cierre normal de todas las semanas salía como "pago parcial".
  const termino = hoyArg() >= c.hasta;
  const aviso = c.sin_tiempo
    ? `<div class="aviso">${c.sin_tiempo} ${c.sin_tiempo===1?"trabajo":"trabajos"} sin duración. Hasta que la tengan no se sabe cuántas horas hay que pagar aparte, así que este ciclo no se puede cerrar.</div>`
    : c.sin_horas
    ? `<div class="aviso">${c.sin_horas} ${c.sin_horas===1?"día":"días"} sin horario. Un día sin horas se paga solo por comisión y las horas de ese día se pierden, así que este ciclo no se puede cerrar.</div>`
    : (termino ? "" : `<div class="aviso">Esta semana no terminó todavía. Lo que se pague ahora es lo que va hasta hoy: lo que trabaje después vuelve a aparecer en este mismo ciclo.</div>`);
  // Horas declaradas en un día sin ningún trabajo detrás. Avisa, no frena: se
  // puede venir a ordenar el local y no facturar nada.
  const respaldo = c.sin_respaldo
    ? `<div class="aviso">${c.sin_respaldo} ${c.sin_respaldo===1?"día tiene horas":"días tienen horas"} y ningún trabajo detrás. Se pagan igual; están marcados más arriba.</div>`
    : "";
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
    ${respaldo}
  </div>`;
}

function enganchar(){
  document.querySelectorAll(".dia-fila[data-k]").forEach(b => b.onclick = () => {
    const k = b.dataset.k; ABIERTOS.has(k) ? ABIERTOS.delete(k) : ABIERTOS.add(k); pintar();
  });
  document.querySelectorAll(".cargar-h").forEach(b => b.onclick = ev => {
    ev.stopPropagation(); cartelHorario(b.dataset.fecha);
  });
  // la tarjeta de hoy
  const caja = $("#hoyTandas");
  if(caja){
    const boton = $("#guardarHoy");
    engancharTandas(caja, boton);
    boton.onclick = async () => {
      const t = leerTandas(caja);
      if(!tandasValidas(t)) return;
      boton.disabled = true;
      if(await guardarHorario(caja.dataset.fecha, t)){ EDITANDO_HOY = false; toast("Horario de hoy guardado"); pintar(); }
      else boton.disabled = false;
    };
  }
  const editarHoy = $("#editarHoy"), cancelarHoy = $("#cancelarHoy");
  if(editarHoy) editarHoy.onclick = () => { EDITANDO_HOY = true; pintar(); };
  if(cancelarHoy) cancelarHoy.onclick = () => { EDITANDO_HOY = false; pintar(); };
  // duración de un trabajo
  const trabajos = D.ciclos.flatMap(c => c.dias.flatMap(d => d.trabajos));
  document.querySelectorAll(".editar-min").forEach(b => b.onclick = () => {
    const t = trabajos.find(x => b.dataset.linea ? String(x.linea_id) === b.dataset.linea
                                                 : String(x.id) === b.dataset.trabajo && x.suelto);
    if(t) cartelDuracion(t);
  });
  // el trabajo sin comprobante, escondido hasta que se lo pide
  document.querySelectorAll(".agregar-trabajo").forEach(b => {
    b.onclick = () => abrirFormTrabajo(b);
  });
  document.querySelectorAll(".borrar-suelto").forEach(a => {
    a.onclick = async e => {
      e.preventDefault();
      if(!await confirmar("¿Borrar este trabajo cargado a mano?", { si: "Borrar", peligro: true })) return;
      await mandar("/api/sueldos/trabajo-suelto/"+a.dataset.trabajo, "DELETE");
    };
  });
  // lo de la dueña
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
      if(!await confirmar(`${que}\n\nSe paga en ${forma} y el egreso queda anotado en ${dia}.\n\nEsto no se puede deshacer. ¿Seguimos?`, { si: "Pagar" })) return;
      if(await mandar("/api/sueldos/cerrar", "POST", {empleado_id: EMP, desde: ciclo, forma_pago: forma,
                                                      anticipado, fecha,
                                                      notas: caja.querySelector(".notaCierre").value.trim() || null}))
        toast(parcial ? "Pago parcial hecho" : "Pagado");
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
  // La duración viene del catálogo: se toca solo si no fue la de siempre.
  const sel = caja.querySelector(".fItem");
  const ponerDuracion = () => {
    const it = ITEMS.find(i => String(i.id) === sel.value), m = (it && it.duracion_min) || 0;
    caja.querySelector(".fHoras").value = m >= 60 ? Math.floor(m/60) : "";
    caja.querySelector(".fMin").value = m % 60 || "";
  };
  sel.onchange = ponerDuracion; ponerDuracion();
  caja.querySelector(".fNo").onclick = () => caja.remove();
  caja.querySelector(".fOk").onclick = async () => {
    const minutos = (parseInt(caja.querySelector(".fHoras").value,10)||0)*60
                  + (parseInt(caja.querySelector(".fMin").value,10)||0);
    if(minutos <= 0){ toast("Poné cuánto duró el trabajo"); return; }
    // La del catálogo va en cero: así el servidor la multiplica por la cantidad
    // y la sigue si después se corrige el catálogo.
    const it = ITEMS.find(i => String(i.id) === sel.value);
    await mandar("/api/sueldos/trabajo-suelto", "POST", {
      empleado_id: EMP, item_id: Number(sel.value),
      cantidad: Math.max(1, parseInt(caja.querySelector(".fCant").value,10)||1),
      fecha, minutos: it && it.duracion_min === minutos ? 0 : minutos});
  };
  sel.focus();
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

/* La tablet pasa de mano en mano, así que la pantalla se cierra sola: cuando
   deja de estar a la vista, cuando pasan unos minutos sin que nadie la toque y
   cuando el servidor dice que el permiso ya no vale. Cerrar es tirar el permiso
   Y esconder lo dibujado, o los números siguen en pantalla. */
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

/* Con el usuario empleado no se muestra nada hasta que alguien toca su nombre y
   pone su código, y se pide en CADA entrada. La que todavía no tiene código lo
   elige ahí, dos veces: la dueña no maneja códigos, solo los ve. */
let PUERTA = { paso: "nombres" };

async function abrirPuerta(motivo){
  $("#todo").hidden = true;
  $("#puerta").hidden = false;
  PUERTA = { paso: "nombres", motivo };
  let emps = [];
  try{ emps = (await (await authFetch("/api/empleados")).json()).filter(e => e.cobra_sueldo); }
  catch(e){ emps = []; }
  PUERTA.emps = emps;
  pintarPuerta();
}

function pintarPuerta(){
  const cuerpo = $("#puertaCuerpo"), ayuda = $("#puertaAyuda");
  if(PUERTA.paso === "nombres"){
    $("#puerta h2").hidden = false;
    ayuda.textContent = PUERTA.motivo || "";
    ayuda.hidden = !PUERTA.motivo;
    cuerpo.innerHTML = PUERTA.emps.length
      ? `<div class="puerta-caja"><div class="nombres">${PUERTA.emps.map(e => `
          <button class="nombre-tile" data-id="${e.id}"><span class="inicial">${esc(e.nombre[0] || "?")}</span>
            ${esc(e.nombre)}${e.tiene_pin ? "" : "<small>elegí tu código</small>"}</button>`).join("")}</div></div>`
      : `<div class="vacio"><b>No hay nadie que cobre sueldo</b>
          La dueña lo marca en Sueldos, en Valores y comisiones.</div>`;
    cuerpo.querySelectorAll(".nombre-tile").forEach(b => b.onclick = () => {
      const e = PUERTA.emps.find(x => String(x.id) === b.dataset.id);
      PUERTA = { ...PUERTA, paso: e.tiene_pin ? "pin" : "nuevo", emp: e, val: "", primero: null, error: "" };
      pintarPuerta();
    });
    return;
  }
  ayuda.hidden = true;
  $("#puerta h2").hidden = true;
  const e = PUERTA.emp, nuevo = PUERTA.paso === "nuevo";
  const titulo = !nuevo ? `Hola, ${esc(e.nombre)}` : PUERTA.primero == null ? `${esc(e.nombre)}, elegí tu código` : "Repetilo";
  const texto = !nuevo ? "Poné tu código" : PUERTA.primero == null ? "De 4 a 8 números" : "Para estar seguras de que quedó bien";
  const largo = Math.max(4, PUERTA.val.length);
  cuerpo.innerHTML = `<div class="puerta-caja"><div class="pin-caja">
    <button class="volver">‹ No soy ${esc(e.nombre)}</button>
    <h3>${titulo}</h3><p>${texto}</p>
    <div class="puntos${PUERTA.error ? " mal" : ""}">${Array.from({length: largo}, (_, i) =>
      `<i class="${i < PUERTA.val.length ? "lleno" : ""}"></i>`).join("")}</div>
    <p class="pin-error">${esc(PUERTA.error || "")}</p>
    <div class="teclado">${[1,2,3,4,5,6,7,8,9].map(n => `<button data-k="${n}">${n}</button>`).join("")}
      <button class="chico" data-k="b" aria-label="Borrar">${icono("cruz")}</button><button data-k="0">0</button>
      <button class="ok" data-k="ok">Entrar</button></div></div></div>`;
  cuerpo.querySelector(".volver").onclick = () => { PUERTA = { ...PUERTA, paso: "nombres", motivo: "" }; pintarPuerta(); };
  cuerpo.querySelectorAll(".teclado button").forEach(b => b.onclick = () => tecla(b.dataset.k));
}

// El teclado físico también sirve: en la tablet con teclado se tipea.
document.addEventListener("keydown", ev => {
  if($("#puerta").hidden || PUERTA.paso === "nombres") return;
  if(/^[0-9]$/.test(ev.key)) tecla(ev.key);
  else if(ev.key === "Backspace") tecla("b");
  else if(ev.key === "Enter") tecla("ok");
});

async function tecla(k){
  PUERTA.error = "";
  if(k === "b"){ PUERTA.val = PUERTA.val.slice(0, -1); return pintarPuerta(); }
  if(k !== "ok"){ if(PUERTA.val.length < 8) PUERTA.val += k; return pintarPuerta(); }
  if(PUERTA.val.length < 4){ PUERTA.error = "Son al menos 4 números"; return pintarPuerta(); }
  if(PUERTA.paso === "nuevo" && PUERTA.primero == null){
    PUERTA.primero = PUERTA.val; PUERTA.val = ""; return pintarPuerta();
  }
  if(PUERTA.paso === "nuevo" && PUERTA.primero !== PUERTA.val){
    PUERTA.error = "No coinciden. Empezá de nuevo"; PUERTA.primero = null; PUERTA.val = ""; return pintarPuerta();
  }
  const url = PUERTA.paso === "nuevo" ? "/api/sueldos/elegir-codigo" : "/api/sueldos/entrar";
  const r = await authFetch(url, {method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({empleado_id: PUERTA.emp.id, pin: PUERTA.val})});
  if(!r.ok){
    PUERTA.error = (await r.json().catch(()=>({}))).detail || "No se pudo entrar";
    PUERTA.val = ""; PUERTA.primero = null;
    return pintarPuerta();
  }
  entrarCon(await r.json());
}

function entrarCon(d){
  PERMISO = d.token; YO = d.empleado.id;
  $("#puerta").hidden = true; $("#todo").hidden = false;
  // El select sigue existiendo escondido porque es de donde el resto de la
  // pantalla lee de quién es lo que muestra. Va con display:none y no con
  // [hidden]: la clase .quien pone display:flex y le gana.
  const caja = $("#quien").closest(".quien");
  caja.style.display = "none";
  caja.innerHTML = `<select id="quien" hidden></select>`;
  const nom = $("#quienEmpleada");
  nom.hidden = false;
  nom.innerHTML = `<span class="inicial">${esc(d.empleado.nombre[0] || "?")}</span>${esc(d.empleado.nombre)}
    <button class="b-out" id="salirSueldos" title="Cerrar y que entre otra">Salir</button>`;
  LIQS = null; DETALLES.clear(); ABIERTOS.clear(); EDITANDO_HOY = false; VER_TODO_COBRADO = false;
  $("#salirSueldos").onclick = () => cerrarPuerta("Listo. El código lo pide de nuevo para entrar.");
  reiniciarRelojQuieta();
  arranque();
}

/* ---------- Valores y comisiones (solo la dueña) ---------- */

/* Cada empleada con su valor hora y cada servicio con su comisión: no hay
   generales. Los valores se ven escritos y se cambian con el lápiz, con Guardar:
   un casillero siempre abierto es un número tipeado sin querer. */
let FILTRO_C = { q: "", cat: "", pct: "" }, ELEGIDOS = new Set(), V_EMPS = [], V_ITEMS = [];

async function pintarValores(){
  try{
    [V_EMPS, V_ITEMS] = await Promise.all([
      authFetch("/api/empleados").then(r => r.json()),
      authFetch("/api/items/all").then(r => r.json()),
    ]);
  }catch(e){ toast("No se pudo cargar"); return; }
  V_ITEMS = V_ITEMS.filter(i => !i.es_depilacion);
  pintarTablaEmpleadas();
  pintarTablaComisiones();
}

function pintarTablaEmpleadas(){
  const cont = $("#tablaEmpleadas");
  cont.innerHTML = V_EMPS.length ? `<div class="tabla-scroll"><table class="tabla-v">
    <thead><tr><th>Empleada</th><th>Código</th><th class="n">Valor hora</th><th class="c">Cobra sueldo</th></tr></thead>
    <tbody>${V_EMPS.map(e => `<tr>
      <td><b>${esc(e.nombre)}</b></td>
      <td>${e.codigo ? `<span class="codigo">${esc(e.codigo)}</span>`
          : `<span class="det">${!e.cobra_sueldo ? "—" : e.tiene_pin ? "lo ves cuando vuelva a entrar" : "lo elige al entrar"}</span>`}</td>
      <td class="n">${e.cobra_sueldo ? `<span class="valor-ed">${e.valor_hora != null ? `<b class="v">${fmt(e.valor_hora)}</b>`
          : `<span class="falta">Falta</span>`}<button class="lapiz" data-vh="${e.id}" aria-label="Cambiar el valor hora de ${esc(e.nombre)}">${icono("lapiz")}</button></span>`
          : `<span class="det">—</span>`}</td>
      <td class="c"><input type="checkbox" class="cobra" data-id="${e.id}"${e.cobra_sueldo ? " checked" : ""}
          aria-label="${esc(e.nombre)} cobra sueldo"></td></tr>`).join("")}</tbody></table></div>`
    : `<div class="vacio"><b>No hay empleadas</b>Se agregan en Admin.</div>`;
  cont.querySelectorAll(".cobra").forEach(c => c.onchange = async () => {
    const e = V_EMPS.find(x => String(x.id) === c.dataset.id);
    if(!c.checked && !await confirmar(`${e.nombre} deja de cobrar sueldo.\n\nNo aparece para pagar ni puede entrar a Sueldos, y se le borra el valor hora. Lo ya pagado no cambia.`,
        { si: "Sacarle el sueldo", peligro: true })){ c.checked = true; return; }
    if(await guardarValor(`/api/empleados/${e.id}`, {cobra_sueldo: c.checked}))
      toast(c.checked ? `${e.nombre} cobra sueldo: falta su valor hora` : `${e.nombre} ya no cobra sueldo`);
  });
  cont.querySelectorAll("[data-vh]").forEach(b => b.onclick = () => {
    const e = V_EMPS.find(x => String(x.id) === b.dataset.vh);
    editarEnLugar(b, e.valor_hora, "$", async v => {
      if(!v) return "Poné cuánto cobra la hora";
      if(await guardarValor(`/api/empleados/${e.id}`, {valor_hora: v})) toast(`${e.nombre}: ${fmt(v)} la hora`);
    });
  });
}

const enPct = i => i.es_comision && i.comision_pct ? String(i.comision_pct) : "sin";

function pintarTablaComisiones(){
  const cont = $("#tablaComisiones");
  const q = sinAcentos(FILTRO_C.q);
  const cats = [...new Set(V_ITEMS.map(i => i.categoria))].sort((a, b) => a.localeCompare(b, "es"));
  const pcts = [...new Set(V_ITEMS.map(enPct))].sort((a, b) => a === "sin" ? 1 : b === "sin" ? -1 : b - a);
  const vistos = V_ITEMS.filter(i => (!q || sinAcentos(i.nombre).includes(q))
      && (!FILTRO_C.cat || i.categoria === FILTRO_C.cat) && (!FILTRO_C.pct || enPct(i) === FILTRO_C.pct))
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  const elegidos = vistos.filter(i => ELEGIDOS.has(i.id));
  const chip = (g, v, t) => `<button class="chip${FILTRO_C[g] === v ? " on" : ""}" data-g="${g}" data-v="${esc(v)}">${esc(t)}</button>`;
  cont.innerHTML = `
    <input id="buscaServ" class="buscador" placeholder="Buscar servicio…" value="${esc(FILTRO_C.q)}">
    <div class="filtros-c">
      ${chip("cat", "", "Todas")}${cats.map(c => chip("cat", c, c)).join("")}
      <span class="sep"></span>
      ${chip("pct", "", "Cualquier %")}${pcts.map(v => chip("pct", v, v === "sin" ? "Sin comisión" : v + "%")).join("")}
    </div>
    ${elegidos.length ? `<div class="barra-c"><b>${elegidos.length} ${elegidos.length === 1 ? "elegido" : "elegidos"}</b>
      <span>Poner</span><input id="pctVarios" inputmode="numeric" placeholder="%" aria-label="Comisión para los elegidos">
      <button class="b-out" id="aplicarVarios">Aplicar</button>
      <button class="b-out" id="sacarVarios">Sin comisión</button>
      <button class="lapiz" id="soltarVarios" aria-label="Soltar los elegidos">${icono("cruz")}</button></div>` : ""}
    <div class="tabla-scroll"><table class="tabla-v">
      <thead><tr><th class="c"><input type="checkbox" id="todosServ" aria-label="Elegir los que se ven"${
        vistos.length && elegidos.length === vistos.length ? " checked" : ""}></th>
        <th>Servicio</th><th class="n">Precio</th><th class="n">Comisión</th></tr></thead>
      <tbody>${vistos.map(i => `<tr${ELEGIDOS.has(i.id) ? ' class="elegido"' : ""}>
        <td class="c"><input type="checkbox" class="elige" data-id="${i.id}"${ELEGIDOS.has(i.id) ? " checked" : ""} aria-label="Elegir ${esc(i.nombre)}"></td>
        <td><b>${esc(i.nombre)}</b><span class="det">${esc(i.categoria)}</span></td>
        <td class="n">${fmt(i.precio)}</td>
        <td class="n"><span class="valor-ed">${enPct(i) === "sin" ? `<span class="det">Sin comisión</span>` : `<b class="v">${i.comision_pct}%</b>`}<button
          class="lapiz" data-pct="${i.id}" aria-label="Cambiar la comisión de ${esc(i.nombre)}">${icono("lapiz")}</button></span></td></tr>`).join("")
        || `<tr><td colspan="4" class="det">Ningún servicio con ese filtro.</td></tr>`}</tbody></table></div>`;

  const busca = $("#buscaServ");
  busca.oninput = () => { FILTRO_C.q = busca.value; pintarTablaComisiones();
    const b = $("#buscaServ"); b.focus(); b.setSelectionRange(b.value.length, b.value.length); };
  cont.querySelectorAll(".filtros-c .chip").forEach(c => c.onclick = () => { FILTRO_C[c.dataset.g] = c.dataset.v; pintarTablaComisiones(); });
  cont.querySelectorAll(".elige").forEach(c => c.onchange = () => {
    c.checked ? ELEGIDOS.add(Number(c.dataset.id)) : ELEGIDOS.delete(Number(c.dataset.id)); pintarTablaComisiones(); });
  $("#todosServ").onchange = ev => { vistos.forEach(i => ev.target.checked ? ELEGIDOS.add(i.id) : ELEGIDOS.delete(i.id)); pintarTablaComisiones(); };
  cont.querySelectorAll("[data-pct]").forEach(b => b.onclick = () => {
    const it = V_ITEMS.find(x => String(x.id) === b.dataset.pct);
    editarEnLugar(b, it.es_comision ? it.comision_pct : null, "%", async v => {
      if(v > 100) return "La comisión es de 1 a 100%";
      if(await cambiarComision([it.id], v || null)) toast(`${it.nombre}: ${v ? v + "%" : "sin comisión"}`);
    });
  });
  const aplicar = $("#aplicarVarios");
  if(aplicar){
    aplicar.onclick = async () => {
      const v = parseInt($("#pctVarios").value, 10);
      if(!(v > 0 && v <= 100)){ toast("Poné un porcentaje de 1 a 100"); $("#pctVarios").focus(); return; }
      const ids = elegidos.map(i => i.id);
      if(await cambiarComision(ids, v)){ ELEGIDOS = new Set(); toast(`${ids.length} servicios al ${v}%`); pintarValores(); }
    };
    $("#pctVarios").onkeydown = ev => { if(ev.key === "Enter") aplicar.click(); };
    $("#sacarVarios").onclick = async () => {
      const ids = elegidos.map(i => i.id);
      if(!await confirmar(`${ids.length} servicios dejan de pagar comisión.\n\nLo que falta pagar se recalcula; lo ya pagado no cambia.`,
          { si: "Sacarles la comisión", peligro: true })) return;
      if(await cambiarComision(ids, null)){ ELEGIDOS = new Set(); toast(`${ids.length} servicios sin comisión`); pintarValores(); }
    };
    $("#soltarVarios").onclick = () => { ELEGIDOS = new Set(); pintarTablaComisiones(); };
  }
}

/* El casillero se abre en el lugar del valor, con Guardar y la cruz. `guardar`
   devuelve un texto si el valor no sirve, y el casillero queda abierto. */
function editarEnLugar(boton, actual, unidad, guardar){
  const caja = boton.closest(".valor-ed");
  caja.innerHTML = `<input inputmode="numeric" value="${actual ?? ""}" placeholder="${unidad}">
    <button class="b-ok btn-mini ok">Guardar</button>
    <button class="lapiz no" aria-label="Cancelar">${icono("cruz")}</button>`;
  const inp = caja.querySelector("input");
  const ok = async () => {
    const t = inp.value.replace(/\D/g, "");
    const error = await guardar(t ? parseInt(t, 10) : 0);
    if(error){ toast(error); inp.focus(); return; }
    pintarValores();
  };
  caja.querySelector(".ok").onclick = ok;
  caja.querySelector(".no").onclick = () => pintarValores();
  inp.onkeydown = ev => { if(ev.key === "Enter") ok(); if(ev.key === "Escape") pintarValores(); };
  inp.focus(); inp.select();
}

async function guardarValor(url, cuerpo){
  const r = await authFetch(url, {method:"PUT", headers:{"Content-Type":"application/json"}, body: JSON.stringify(cuerpo)});
  if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo guardar"); await pintarValores(); return false; }
  await pintarValores();
  return true;
}

async function cambiarComision(ids, pct){
  const r = await authFetch("/api/comisiones", {method:"PUT", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ids, pct})});
  if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo guardar"); return false; }
  return true;
}

document.querySelectorAll(".solapas button").forEach(b => b.onclick = () => {
  document.querySelectorAll(".solapas button").forEach(x => x.classList.toggle("on", x === b));
  document.querySelectorAll(".hoja").forEach(h => h.hidden = h.id !== b.dataset.hoja);
  if(b.dataset.hoja === "hojaValores") pintarValores();
  else refrescar();
});

if(DUENO){ arranque(); } else { vigilarPantalla(); abrirPuerta(); }
