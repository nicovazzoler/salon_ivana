/* Sueldos. La empleada entra con su código y ve lo que le toca: carga su horario
   de cada día, corrige la duración de un trabajo que no fue la del catálogo y
   pide un adelanto o se lleva un producto. La dueña paga lo trabajado hasta un
   día, a varias juntas. La cuenta la hace siempre el servidor. */
requireLogin(); pintarNav(); ajustarPorRol();

const $=s=>document.querySelector(s);
const fmt=n=>(n < 0 ? "−$" : "$")+Math.abs(n||0).toLocaleString("es-AR");
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function toast(m){const t=$("#toast");t.textContent=m;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2600);}

/* Con el usuario empleado, la pantalla se abre con un código por persona. El
   permiso vive en memoria y no en localStorage: se pide en cada entrada, así el
   que agarra la tablet después no encuentra la sesión de la otra. El candado de
   verdad lo pone el servidor. La dueña no pasa por acá. */
let PERMISO = null, YO = null;

async function pedir(url, opts){
  opts = opts || {};
  if(PERMISO) opts.headers = Object.assign({}, opts.headers || {}, {"X-Sueldo": PERMISO});
  const r = await authFetch(url, opts);
  // 403 en esta pantalla es siempre lo mismo: el permiso no vale más. En vez de
  // dejar a la vista números que ya no se pueden guardar, se pide el código.
  if(r.status === 403 && PERMISO) cerrarPuerta("Se venció el rato. Poné tu código de nuevo.");
  return r;
}

const DUENO = esDueno();
let EMPLEADOS = [], ITEMS = [];
// El resumen de cada empleada que está en pantalla, por id: la dueña ve varias.
let RES = {};

/* Las horas se muestran como las dice la gente ("8 h 30"), nunca en decimales.
   Adentro siempre son minutos enteros, que es lo que se guarda. */
function hhmm(min){
  min = Math.max(0, min|0);
  const h = Math.floor(min/60), m = min%60;
  if(!h) return m + " min";
  return h + " h" + (m ? " " + String(m).padStart(2,"0") : "");
}

/* La fecha de hoy en argentino, sin pasar por toISOString(): eso pasa a UTC y
   después de las 21 devuelve el día siguiente. */
function hoyArg(){
  const d = new Date(Date.now() - 3*3600*1000);
  return d.toISOString().slice(0,10);
}
function sumarDias(iso, n){
  const [a, m, d] = iso.split("-").map(Number);
  const f = new Date(Date.UTC(a, m - 1, d + n));
  return f.toISOString().slice(0, 10);
}
const DIAS = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
function diaDe(iso){
  if(!iso) return "";
  const [a,m,d] = iso.split("-").map(Number);
  return DIAS[new Date(a, m-1, d).getDay()];
}
const dm = iso => { const [, m, d] = iso.split("-").map(Number); return `${d}/${m}`; };
const diaCorto = iso => `${diaDe(iso).slice(0, 3)} ${dm(iso)}`;
const diaLargo = iso => `${diaDe(iso).toLowerCase()} ${dm(iso)}`;
const pesos = v => parseInt(String(v).replace(/\D/g, ""), 10) || 0;
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

async function arranque(){
  EMPLEADOS = await (await pedir("/api/empleados" + (DUENO ? "?todos=true" : ""))).json();
  // Ordenados por nombre: el desplegable se usa buscando uno puntual.
  ITEMS = (await (await pedir("/api/sueldos/items-comision")).json())
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  await refrescar();
}

/* Después de cualquier cambio se vuelve a leer todo del servidor: la cuenta la
   hace él, y repetirla acá sería tener dos versiones del sueldo. */
async function refrescar(){
  if(DUENO) await cargarDuena(); else await cargarEmpleada();
}

/* ======================= la dueña: pagar ======================= */

let HASTA = hoyArg();
// Quién está tildado para pagar. Sin marca, la que se puede pagar va tildada.
let MARCAS = {};
// Lo que se acaba de pagar, para decirlo en la fila hasta que se cambie de día.
let RECIEN = {};
let LIQS = null, VER_TODO_PAGADO = false, VER_TODO_COBRADO = false;
const DETALLES = new Map();
const ABIERTOS = new Set();

async function cargarDuena(){
  const ids = EMPLEADOS.map(e => e.id);
  const res = await Promise.all(ids.map(async id =>
    (await pedir(`/api/sueldos/pendiente?empleado_id=${id}&hasta=${HASTA}`)).json()));
  RES = Object.fromEntries(res.map(r => [r.empleado.id, r]));
  LIQS = porPago(await (await pedir("/api/sueldos/liquidaciones?limite=300")).json());
  pintarDuena();
}

// Lo que no deja pagarle, y lo que se avisa pero no frena.
function estadoDe(e, r){
  const frena = [], avisa = [];
  r.dias_sin_horas.forEach(f => frena.push(f === hoyArg() ? "Le falta el horario de hoy" : `Le falta el horario del ${diaCorto(f).toLowerCase()}`));
  if(r.sin_tiempo) frena.push(r.sin_tiempo === 1 ? "Un trabajo sin duración" : `${r.sin_tiempo} trabajos sin duración`);
  if(r.minutos_pagados && !r.valor_hora) frena.push("Sin valor hora");
  if(!r.ganado) frena.push("Nada para pagar");
  else if(r.total <= 0) frena.push(`Los adelantos cubren todo: quedan ${fmt(-r.total)} para el próximo pago`);
  if(r.sin_respaldo) avisa.push(r.sin_respaldo === 1 ? "Un día con horario y sin ningún trabajo" : `${r.sin_respaldo} días con horario y sin trabajos`);
  return { frena, avisa, marcada: !frena.length && MARCAS[e.id] !== false };
}

function filasDuena(){
  // A las dadas de baja y a las que no cobran se las ve SOLO si les quedó algo:
  // mientras haya plata pendiente hay que pagársela.
  return EMPLEADOS
    .filter(e => RES[e.id] && ((e.activo !== false && e.cobra_sueldo) || !RES[e.id].vacio || RECIEN[e.id]))
    .map(e => ({ e, r: RES[e.id], ...estadoDe(e, RES[e.id]) }));
}

function pintarDuena(){
  const filas = filasDuena(), elegidas = filas.filter(f => f.marcada && !RECIEN[f.e.id]);
  const total = elegidas.reduce((a, f) => a + f.r.total, 0);
  const debe = filas.reduce((a, f) => a + Math.max(f.r.total, 0), 0);
  const hoy = hoyArg(), ayer = sumarDias(hoy, -1), otro = HASTA !== hoy && HASTA !== ayer;
  $("#cardPagar").innerHTML = `
    <div class="card-head con-datos"><div class="titulo"><h2>Pagar sueldos</h2></div>
      <div class="kpis"><div class="kpi"><span class="lbl">Se debe hasta ${HASTA === hoy ? "hoy" : diaCorto(HASTA).toLowerCase()}</span>
        <span class="val">${fmt(debe)}</span></div></div></div>
    <div class="hasta"><span>Lo trabajado hasta</span>
      <div class="segmento">
        <button data-h="${hoy}" class="${HASTA === hoy ? "on" : ""}">Hoy<small>${diaCorto(hoy)}</small></button>
        <button data-h="${ayer}" class="${HASTA === ayer ? "on" : ""}">Ayer<small>${diaCorto(ayer)}</small></button>
        <label class="${otro ? "on" : ""}">Otro día <input type="date" id="hastaOtra" value="${otro ? HASTA : ""}" max="${hoy}"></label>
      </div></div>
    ${filas.length ? `<div class="pagos">
      <div class="pcab"><span><input type="checkbox" id="todas" aria-label="Marcar todas"></span><span>Empleada</span>
        <span>Comisiones</span><span>Horas</span><span>Descuentos</span><span>A pagar</span></div>
      ${filas.map(filaPago).join("")}
    </div>
    <div class="pie-pago">
      <button class="b-ok" id="pagar"${elegidas.length ? "" : " disabled"}>${elegidas.length
        ? `Pagar ${fmt(total)} a ${elegidas.length === 1 ? elegidas[0].e.nombre : elegidas.length + " empleadas"}`
        : "Elegí a quién pagarle"}</button>
    </div>` : `<div class="vacio"><b>No hay nadie que cobre sueldo</b>Se marca en Valores y comisiones.</div>`}`;

  const P = $("#cardPagar");
  P.querySelectorAll(".segmento button[data-h]").forEach(b => b.onclick = () => cambiarHasta(b.dataset.h));
  $("#hastaOtra").onchange = ev => { if(ev.target.value) cambiarHasta(ev.target.value > hoy ? hoy : ev.target.value); };
  P.querySelectorAll(".prow input[type=checkbox]").forEach(x => x.onchange = () => { MARCAS[x.dataset.id] = x.checked; pintarDuena(); });
  const pagables = filas.filter(f => !f.frena.length && !RECIEN[f.e.id]), todas = $("#todas");
  if(todas){
    todas.disabled = !pagables.length;
    todas.checked = pagables.length > 0 && pagables.every(f => f.marcada);
    todas.indeterminate = !todas.checked && pagables.some(f => f.marcada);
    todas.onchange = () => { pagables.forEach(f => MARCAS[f.e.id] = todas.checked); pintarDuena(); };
  }
  P.querySelectorAll(".prow .quien").forEach(b => b.onclick = () => {
    const k = "emp" + b.dataset.id; ABIERTOS.has(k) ? ABIERTOS.delete(k) : ABIERTOS.add(k); pintarDuena();
  });
  const pagar = $("#pagar");
  if(pagar) pagar.onclick = () => cartelPagar(elegidas);
  enganchar(P);
  pintarPagado();
}

function cambiarHasta(h){ HASTA = h; MARCAS = {}; RECIEN = {}; cargarDuena(); }

function filaPago(f){
  const { e, r } = f;
  if(RECIEN[e.id] !== undefined) return `<div class="pfila"><div class="prow apagada"><span></span>
      <span class="quien-fija">${esc(e.nombre)}</span>
      <span class="n recien"><span class="aviso ok">Pagado recién</span></span><span class="n total">${fmt(RECIEN[e.id])}</span></div></div>`;
  const ok = !f.frena.length, k = "emp" + e.id, abierto = ABIERTOS.has(k);
  return `<div class="pfila${abierto ? " abierta" : ""}"><div class="prow${ok ? "" : " apagada"}">
      <input type="checkbox" data-id="${e.id}" aria-label="Pagarle a ${esc(e.nombre)}"${f.marcada ? " checked" : ""}${ok ? "" : " disabled"}>
      <span><button class="quien" data-id="${e.id}" aria-expanded="${abierto}">${esc(e.nombre)}${icono("flecha")}</button>
        <span class="desde">${r.desde ? `${diaCorto(r.desde).toLowerCase()} a ${diaCorto(r.hasta).toLowerCase()} · ` : ""}${
          hhmm(r.minutos_total)} en el local</span></span>
      <span class="n"><span class="rot-movil">Comisiones <small>${plural(r.trabajos, "trabajo", "trabajos")}</small></span>${fmt(r.total_comisiones)}<small class="esc">${plural(r.trabajos, "trabajo", "trabajos")} · ${hhmm(r.minutos_comision)}</small></span>
      <span class="n"><span class="rot-movil">Horas <small>${hhmm(r.minutos_pagados)}</small></span>${fmt(r.total_horas)}<small class="esc">${hhmm(r.minutos_pagados)}</small></span>
      <span class="n${r.descuentos ? " resta" : ""}"><span class="rot-movil">Descuentos</span>${r.descuentos ? fmt(-r.descuentos) : "—"}</span>
      <span class="n total">${fmt(Math.max(r.total, 0))}</span></div>
    ${f.frena.length || f.avisa.length ? `<div class="avisos">${f.frena.map(t => `<span class="aviso frena">${esc(t)}</span>`).join("")}${
      f.avisa.map(t => `<span class="aviso">${esc(t)}</span>`).join("")}</div>` : ""}
    ${abierto ? `<div class="pdetalle">
      ${[...r.dias].reverse().map(d => dibujarDia(d, r)).join("") || `<div class="vacio-chico">No hay días sin cobrar.</div>`}
      ${r.movimientos.length ? `<div class="sub-movs">${movsHTML(r)}</div>` : ""}
      <div class="acc-emp">
        <button class="b-out btn-chico dar-adelanto" data-emp="${e.id}">+ Adelanto</button>
        <button class="b-out btn-chico dar-producto" data-emp="${e.id}">+ Producto</button>
      </div>
    </div>` : ""}
  </div>`;
}

/* El cartel de pagar: una forma por empleada, que la de una no es la de otra, y
   cuánto sale de la caja en cada forma, que es lo que hay que tener en la mano. */
function cartelPagar(elegidas){
  const estados = {};
  const total = elegidas.reduce((a, f) => a + f.r.total, 0);
  const desc = elegidas.reduce((a, f) => a + f.r.adelantos, 0);
  cartelForm({ titulo: `Pagar ${fmt(total)}`, si: `Pagar ${fmt(total)}`, clase: "pagar",
    texto: `Lo trabajado hasta ${HASTA === hoyArg() ? "hoy" : diaLargo(HASTA)}.${desc ? ` Los adelantos (${fmt(desc)}) ya salieron de la caja el día que se dieron.` : ""}`,
    cuerpo: elegidas.map(f => `<div class="pago-emp"><div class="cab"><b>${esc(f.e.nombre)}</b>
        <small>${f.r.desde ? `${diaCorto(f.r.desde).toLowerCase()} a ${diaCorto(f.r.hasta).toLowerCase()}` : ""}</small>
        <span class="plata">${fmt(f.r.total)}</span></div>
      ${formasHTML("p" + f.e.id, "Efectivo")}</div>`).join("")
      + `<div class="dia-caja"><label for="fechaPago">Día de la caja</label>
          <input type="date" id="fechaPago" value="${hoyArg()}" max="${hoyArg()}"></div><p class="sale" id="sale"></p>`,
    alAbrir: (fondo, si) => {
      const act = () => {
        let ef = 0, tr = 0, ok = true;
        elegidas.forEach(f => {
          const st = estados[f.e.id]; if(!st) return;
          const t = f.r.total;
          if(st.forma === "Efectivo") ef += t;
          else if(st.forma === "Transferencia") tr += t;
          else { ef += st.ef; tr += t - st.ef; ok = ok && formaLista(st, t); }
        });
        const f = fondo.querySelector("#fechaPago").value || hoyArg();
        fondo.querySelector("#sale").innerHTML = `Sale de la caja ${f === hoyArg() ? "de hoy" : "del " + dm(f)}: <b>${fmt(ef)}</b> en efectivo${tr ? ` y <b>${fmt(tr)}</b> por transferencia` : ""}.`;
        si.disabled = !ok;
      };
      elegidas.forEach(f => { estados[f.e.id] = engancharFormas(fondo, "p" + f.e.id, () => f.r.total, act); });
      fondo.querySelector("#fechaPago").onchange = act;
      act();
    },
    alSi: async fondo => {
      const cuerpo = { hasta: HASTA, fecha: fondo.querySelector("#fechaPago").value || hoyArg(),
        pagos: elegidas.map(f => ({ empleado_id: f.e.id, forma_pago: estados[f.e.id].forma,
                                    efectivo: estados[f.e.id].forma === "Mixto" ? estados[f.e.id].ef : null })) };
      const r = await pedir("/api/sueldos/pagar", { method: "POST",
        headers: {"Content-Type": "application/json"}, body: JSON.stringify(cuerpo) });
      if(!r.ok){ toast((await r.json().catch(() => ({}))).detail || "No se pudo pagar"); return false; }
      const d = await r.json();
      elegidas.forEach(f => RECIEN[f.e.id] = f.r.total);
      toast(`Pagado. ${d.pagos.length === 1 ? "Quedó el egreso" : "Quedaron los egresos"} en la caja`);
      await cargarDuena();
    }});
}

/* Lo ya pagado, por día de pago: "qué pagué el viernes", con cada una adentro y
   cada una abierta día por día. Una lista plana mezcla semanas y personas. */
function pintarPagado(){
  const caja = $("#cardPagado");
  if(!LIQS || !LIQS.length){ caja.innerHTML = ""; return; }
  const por = {};
  LIQS.forEach(l => { const f = l.pagado; (por[f] = por[f] || { fecha: f, liqs: [] }).liqs.push(l); });
  const grupos = Object.values(por).sort((a, b) => b.fecha.localeCompare(a.fecha));
  const lista = VER_TODO_PAGADO ? grupos : grupos.slice(0, 4);
  caja.innerHTML = `<div class="card-head"><h2>Ya pagado</h2></div>
    ${lista.map(g => {
      const k = "pago" + g.fecha, ab = ABIERTOS.has(k), t = g.liqs.reduce((a, l) => a + l.total, 0);
      const l0 = g.liqs[0];
      return `<div class="hist${ab ? " abierto" : ""}"><button class="hist-fila" data-k="${k}" aria-expanded="${ab}">
          <span><b>${diaDe(g.fecha)} ${dm(g.fecha)}</b><span class="det">${plural(g.liqs.length, "empleada", "empleadas")}${
            l0.desde ? ` · ${diaCorto(l0.desde).toLowerCase()} a ${diaCorto(l0.hasta).toLowerCase()}` : ""}</span></span>
          <span class="plata">${fmt(t)}</span><span class="flecha">${icono("flecha")}</span></button>
        ${ab ? `<div class="hist-cuerpo">${g.liqs.map(l => cobroHTML(l, l.empleado)).join("")}</div>` : ""}</div>`;
    }).join("")}
    ${!VER_TODO_PAGADO && grupos.length > 4 ? `<p class="ver-mas"><button class="b-out btn-chico" id="verMasPagado">Ver ${grupos.length - 4} más</button></p>` : ""}`;
  const mas = $("#verMasPagado");
  if(mas) mas.onclick = () => { VER_TODO_PAGADO = true; pintarPagado(); };
  engancharHistorial(caja, pintarPagado);
}

/* ======================= la empleada ======================= */

let D = null;
async function cargarEmpleada(){
  D = await (await pedir("/api/sueldos/pendiente?empleado_id=" + YO)).json();
  RES = { [YO]: D };
  if(!LIQS) LIQS = porPago(await (await pedir("/api/sueldos/liquidaciones?limite=200")).json());
  pintarEmpleada();
}

/* No ve semanas: ve cuánto le toca, el día de hoy y la lista de los días que
   todavía no cobró. */
function pintarEmpleada(){
  const dias = [...D.dias].reverse();
  const conAlgo = dias.some(d => d.minutos || d.trabajos.length);
  $("#totales").innerHTML = `<div class="cuenta">
    <div class="grande"><span class="lbl">Te toca cobrar</span><span class="val">${fmt(Math.max(D.total, 0))}</span>
      ${D.desde ? `<span class="desde">desde el ${diaLargo(D.desde)}</span>` : ""}</div>
    <div class="renglones">
      <div class="r"><span>Comisiones <small>${plural(D.trabajos, "trabajo", "trabajos")} · ${hhmm(D.minutos_comision)}</small></span><span>${fmt(D.total_comisiones)}</span></div>
      <div class="r"><span>Horas <small>${hhmm(D.minutos_pagados)}${D.valor_hora ? ` a ${fmt(D.valor_hora)}` : ""}</small></span><span>${fmt(D.total_horas)}</span></div>
      ${D.adelantos ? `<div class="r resta"><span>Adelantos</span><span>${fmt(-D.adelantos)}</span></div>` : ""}
      ${D.productos ? `<div class="r resta"><span>Productos</span><span>${fmt(-D.productos)}</span></div>` : ""}
      ${D.en_espera ? `<div class="r falta-r"><span>Sin contar <small>${D.sin_tiempo} sin duración</small></span><span>${fmt(D.en_espera)}</span></div>` : ""}
      <div class="r total"><span>Te toca</span><span>${fmt(D.total)}</span></div>
    </div></div>`;
  const hoy = dias.find(d => d.fecha === hoyArg());
  $("#cuerpo").innerHTML = `
    ${hoy && !hoy.horas_pagadas ? tarjetaHoy(hoy) : ""}
    <div class="acciones">
      <button class="accion dar-adelanto" data-emp="${YO}">${icono("billete")}<span>Pedir un adelanto<small>Sale de la caja y se descuenta</small></span></button>
      <button class="accion dar-producto" data-emp="${YO}">${icono("bolsa")}<span>Me llevo un producto<small>Del inventario, al precio que pagás</small></span></button>
    </div>
    <div class="seccion-h"><h3>Días</h3>${conAlgo ? `<span>${hhmm(D.minutos_total)} en el local</span>` : ""}</div>
    ${dias.map(d => dibujarDia(d, D)).join("") || `<div class="vacio-chico">No tenés nada pendiente.</div>`}
    ${D.movimientos.length ? `<div class="seccion-h"><h3>Adelantos y productos</h3></div>${movsHTML(D)}` : ""}
    <div id="cobrado"></div>`;
  enganchar($("#cuerpo"));
  pintarCobrado();
}

/* Plegado: es la historia, y lo que se mira todos los días está arriba. Al
   abrir un cobro se ve día por día, que es lo que ella cruza con su cuaderno. */
function pintarCobrado(){
  const caja = $("#cobrado");
  if(!caja) return;
  if(!LIQS.length){ caja.innerHTML = ""; return; }
  const ult = LIQS[0], fu = ult.pagado;
  const lista = VER_TODO_COBRADO ? LIQS : LIQS.slice(0, 6);
  caja.innerHTML = `<details class="cobrado"${ABIERTOS.has("cobrado") ? " open" : ""}>
    <summary><h3>Lo que ya cobraste</h3><span>último: ${diaLargo(fu)}, ${fmt(ult.total)}</span>${icono("flecha")}</summary>
    ${lista.map(l => cobroHTML(l)).join("")}
    ${!VER_TODO_COBRADO && LIQS.length > 6
      ? `<p class="ver-mas"><button class="b-out btn-chico" id="verMasCobrado">Ver ${LIQS.length - 6} más</button></p>` : ""}
  </details>`;
  caja.querySelector("details").ontoggle = ev => ev.target.open ? ABIERTOS.add("cobrado") : ABIERTOS.delete("cobrado");
  const mas = $("#verMasCobrado");
  if(mas) mas.onclick = () => { VER_TODO_COBRADO = true; pintarCobrado(); };
  engancharHistorial(caja, pintarCobrado);
}

/* ======================= lo pagado, común a las dos ======================= */

const porPago = ls => ls.sort((a, b) => b.pagado.localeCompare(a.pagado) || b.id - a.id);
const formaTexto = f => !f ? "" : f === "Mixto" ? "mixto" : "en " + f.toLowerCase();

// Un cobro. Con `nombre`, la fila dice de quién es: es la lista de la dueña.
function cobroHTML(l, nombre){
  const k = "liq-" + l.id, ab = ABIERTOS.has(k) && DETALLES.has(k);
  const dia = l.pagado;
  const det = [nombre ? null : (l.desde ? `${diaCorto(l.desde).toLowerCase()} a ${diaCorto(l.hasta).toLowerCase()}` : null),
               formaTexto(l.forma_pago) || null,
               l.descuentos ? `menos ${fmt(l.descuentos)} de descuentos` : null,
               l.parcial ? "pago parcial" : null].filter(Boolean).join(" · ");
  return `<div class="hist${nombre ? " hist-emp" : ""}${ab ? " abierto" : ""}"><button class="hist-fila" data-k="${k}" aria-expanded="${ab}">
      <span><b>${nombre ? esc(nombre) : `${diaDe(dia)} ${dm(dia)}`}</b><span class="det">${det}</span></span>
      <span class="plata">${fmt(l.total)}</span><span class="flecha">${icono("flecha")}</span></button>
    ${ab ? resumenCobro(DETALLES.get(k)) : ""}</div>`;
}

function engancharHistorial(caja, repintar){
  caja.querySelectorAll(".hist-fila").forEach(b => b.onclick = async () => {
    const k = b.dataset.k;
    if(ABIERTOS.has(k)) ABIERTOS.delete(k);
    else {
      ABIERTOS.add(k);
      if(k.startsWith("liq-") && !DETALLES.has(k))
        DETALLES.set(k, await (await pedir("/api/sueldos/liquidaciones/" + k.slice(4))).json());
    }
    repintar();
  });
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
        ? ` <em>· ${plural(tr.length, "trabajo", "trabajos")}, ${fmt(com)}</em>` : ""}${
        d.minutos ? ` <em>· ${hhmm(pagos)} por hora, ${fmt(horas)}</em>` : ""}</span>
      <span class="plata">${fmt(com + horas)}</span></div>`;
  }).join("");
  const movs = (liq.movimientos || []).map(m => `<div class="rd"><b>${m.tipo === "adelanto" ? "Adelanto" : "Producto"}</b>
      <span class="det">${diaCorto(m.fecha)}${m.tipo === "producto" ? ` · ${esc(m.nombre)}${m.cantidad > 1 ? " ×" + m.cantidad : ""}` : ""}</span>
      <span class="plata resta">${fmt(-m.monto)}</span></div>`).join("");
  return `<div class="resumen-dias">${filas || `<div class="rd"><span class="det">Sin detalle de días.</span></div>`}${movs}
    <div class="rd tot"><span>Cobrado</span><span></span><span class="plata">${fmt(liq.total)}</span></div></div>`;
}

/* ======================= los días ======================= */

const aMin = t => { const [h, m] = t.split(":").map(Number); return h*60 + m; };
const aHora = m => `${String(Math.floor(m/60)).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`;
const minTandas = t => t.reduce((a, [x, y]) => a + aMin(y) - aMin(x), 0);
const descanso = t => t.length > 1 ? aMin(t[1][0]) - aMin(t[0][1]) : 0;
const textoTandas = t => t.map(([x, y]) => `${x} a ${y}`).join(" y ");
// El horario de un día dicho en una línea; las filas de antes de las tandas solo tienen minutos.
const horarioDe = d => d.tandas.length
  ? `${textoTandas(d.tandas)}${d.tandas[1] ? ` · ${hhmm(descanso(d.tandas))} de descanso` : ""}`
  : hhmm(d.minutos);
// Como el round() del backend: el medio va al par.
const redondear = x => { const f = Math.floor(x), r = x - f; return r > .5 || (r === .5 && f % 2) ? f + 1 : f; };
const ROT = DUENO ? ["Entró", "Salió", "Volvió", "Se fue"] : ["Entré", "Salí", "Volví", "Me fui"];

/* Un renglón por día, que se abre para ver el horario y los trabajos. Están
   todos los días desde el último pago, así que uno en blanco es "no vino" y no
   "falta cargarlo". */
function dibujarDia(d, r){
  const emp = r.empleado.id, esHoy = d.fecha === hoyArg();
  const rotulo = esHoy ? `Hoy ${dm(d.fecha)}` : diaCorto(d.fecha);
  const clase = `dia${esHoy ? " hoy-d" : ""}`;
  const botonHorario = txt => d.horas_pagadas ? ""
    : `<button class="b-out btn-chico cargar-h" data-emp="${emp}" data-fecha="${d.fecha}">${txt}</button>`;
  if(!d.minutos && !d.trabajos.length) return `<div class="${clase}"><div class="dia-fila quieta">
    <b>${rotulo}</b><span class="det"><span class="tenue">${d.horas_pagadas ? "horas ya cobradas"
      : esHoy ? "todavía sin cargar" : DUENO ? "no vino" : "no viniste"}</span></span>
    ${botonHorario("Cargar horario")}</div></div>`;

  const faltaHoras = !d.minutos && !d.horas_pagadas;
  const faltaTiempo = d.trabajos.some(t => !t.minutos);
  const det = (d.horas_pagadas ? "horas ya cobradas" : faltaHoras ? `<span class="falta">Falta el horario</span>`
               : d.tandas.length ? textoTandas(d.tandas) : hhmm(d.minutos))
    + ` · ${d.trabajos.length ? plural(d.trabajos.length, "trabajo", "trabajos") : "sin trabajos"}`
    + (faltaTiempo ? ` · <span class="falta">falta un tiempo</span>` : "")
    + (DUENO && d.sin_respaldo ? ` <span class="sin-comp">sin trabajos</span>` : "");
  const k = `dia${emp}-${d.fecha}`, abierto = ABIERTOS.has(k);
  return `<div class="${clase}${abierto ? " abierto" : ""}">
    <button class="dia-fila" data-k="${k}" aria-expanded="${abierto}"><b>${rotulo}</b><span class="det">${det}</span>
      <span class="plata">${fmt(d.total)}</span><span class="flecha">${icono("flecha")}</span></button>
    ${abierto ? `<div class="dia-cuerpo">
      <div class="dia-horario">${d.horas_pagadas ? `<span>Las horas de este día ya se cobraron.</span>`
        : d.minutos ? `<span><b>${horarioDe(d)}</b></span>${botonHorario("Corregir horario")}`
        : `<span class="falta">Sin horario</span>${botonHorario("Cargar horario")}`}</div>
      ${d.minutos ? `<div class="cuentita">${hhmm(d.minutos)} en el local${d.minutos_trabajos ? ` − ${hhmm(d.minutos_trabajos)} en trabajos con comisión` : ""} = <b>${hhmm(d.minutos_pagados)} por hora</b>, ${fmt(d.horas)}</div>` : ""}
      ${d.trabajos.map(t => dibujarTrabajo(t, emp)).join("")}
      <div class="dia-acciones"><button class="b-out btn-chico agregar-trabajo" data-emp="${emp}" data-fecha="${d.fecha}">+ Trabajo sin comprobante</button></div>
    </div>` : ""}
  </div>`;
}

function dibujarTrabajo(t, emp){
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
        t.suelto ? ` · <a href="#" class="borrar-suelto" data-emp="${emp}" data-trabajo="${t.id}">borrar</a>` : ""}</span></div>
    <span class="dur">${t.minutos ? hhmm(t.minutos) : `<span class="falta">falta el tiempo</span>`}
      <button class="editar-min" data-emp="${emp}" ${clave} aria-label="Cambiar cuánto duró">${icono("lapiz")}</button></span>
    <span class="plata${t.minutos ? "" : " no-cuenta"}">${fmt(t.comision)}</span>
  </div>`;
}

// Los adelantos y productos que se van a descontar. Anular es de hoy para ella y de cualquier día para la dueña.
function movsHTML(r){
  return r.movimientos.map(m => `<div class="mov"><div>
      <b>${m.tipo === "adelanto" ? "Adelanto" : `${esc(m.nombre)}${m.cantidad > 1 ? " ×" + m.cantidad : ""}`}</b>
      <span class="det">${diaCorto(m.fecha)} · ${m.tipo === "adelanto"
        ? (m.forma_pago === "Mixto" ? `${fmt(m.efectivo)} en efectivo y ${fmt(m.monto - m.efectivo)} por transferencia` : formaTexto(m.forma_pago))
        : `se descuenta · de lista ${fmt(m.precio_lista * m.cantidad)}`}</span></div>
      ${DUENO || m.fecha === hoyArg() ? `<button class="b-del anular-mov" data-emp="${r.empleado.id}" data-id="${m.id}">Anular</button>` : "<span></span>"}
      <span class="plata">${fmt(-m.monto)}</span></div>`).join("");
}

/* ---------- el horario, en tandas ---------- */

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

const guardarHorario = (emp, fecha, tandas) => mandar("/api/sueldos/horas", "PUT",
  {empleado_id: emp, fecha, tandas: tandas.map(([desde, hasta]) => ({desde, hasta}))});

let EDITANDO_HOY = false;
function tarjetaHoy(d){
  if(d.minutos && !EDITANDO_HOY) return `<div class="hoy"><div class="hoy-cab"><h3>Hoy, ${diaLargo(d.fecha)}</h3></div>
    <div class="cargado"><span>${d.tandas.length ? horarioDe(d) : "Horas cargadas"}</span><b>${hhmm(d.minutos)}</b>
      <button class="lapiz" id="editarHoy" aria-label="Corregir el horario de hoy">${icono("lapiz")}</button></div></div>`;
  const sugerido = !d.tandas.length && d.sugerido.length;
  return `<div class="hoy"><div class="hoy-cab"><h3>Hoy, ${diaLargo(d.fecha)}</h3>
      ${sugerido ? `<span class="nota-hoy">Es tu horario de la agenda: cambiá lo que no fue así</span>` : ""}</div>
    <div class="tandas" id="hoyTandas" data-fecha="${d.fecha}">${tandasHTML(d.tandas.length ? d.tandas : d.sugerido)}</div>
    <div class="hoy-acc">${EDITANDO_HOY ? `<button class="b-out" id="cancelarHoy">Cancelar</button>` : ""}
      <button class="b-ok" id="guardarHoy">Guardar</button></div></div>`;
}

/* Un cartel propio y no preguntar(): adentro va un formulario, no un texto. Usa
   las mismas piezas, así se ve igual que los demás carteles de la app. */
function cartelForm({ titulo, texto = "", cuerpo, si = "Guardar", extra = null, clase = "", alAbrir, alSi }){
  const fondo = document.createElement("div");
  fondo.className = "dlg-fondo";
  fondo.innerHTML = `<div class="dlg ${clase}" role="dialog" aria-modal="true" aria-labelledby="dlgTitulo">
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
  bSi.onclick = async () => {
    bSi.disabled = true;
    if(await alSi(fondo) !== false) cerrar(); else bSi.disabled = false;
  };
  if(extra) fondo.querySelector(".dlg-extra").onclick = async () => { cerrar(); await extra.alClick(); };
  if(alAbrir) alAbrir(fondo, bSi);
  (fondo.querySelector("input:not([type=date])") || bSi).focus();
}

const diaDeResumen = (emp, fecha) => (RES[emp]?.dias || []).find(x => x.fecha === fecha);

function cartelHorario(emp, fecha){
  const d = diaDeResumen(emp, fecha);
  if(!d) return;
  cartelForm({
    titulo: `Horario del ${diaLargo(fecha)}`, texto: DUENO ? RES[emp].empleado.nombre : "",
    cuerpo: `<div class="tandas caja-t">${tandasHTML(d.tandas.length ? d.tandas : d.sugerido)}</div>`,
    extra: d.minutos ? { texto: DUENO ? "No vino" : "No vine",
                         alClick: () => mandar("/api/sueldos/horas", "PUT", {empleado_id: emp, fecha, tandas: []}) } : null,
    alAbrir: (fondo, bSi) => engancharTandas(fondo.querySelector(".caja-t"), bSi),
    alSi: async fondo => {
      const t = leerTandas(fondo.querySelector(".caja-t"));
      if(!tandasValidas(t)) return false;
      return await guardarHorario(emp, fecha, t);
    }});
}

function cartelDuracion(emp, t){
  const actual = t.minutos || 0;
  cartelForm({
    titulo: `¿Cuánto duró ${t.nombre}?`,
    texto: t.duracion_catalogo ? `En el catálogo dice ${hhmm(t.duracion_catalogo)}.` : "Este servicio no tiene duración en el catálogo.",
    cuerpo: `<div class="dos-campos">
      <div><label for="durH">Horas</label><input id="durH" type="number" inputmode="numeric" min="0" max="12" value="${Math.floor(actual/60) || ""}"></div>
      <div><label for="durM">Minutos</label><input id="durM" type="number" inputmode="numeric" min="0" max="59" step="5" value="${actual % 60 || ""}"></div></div>`,
    extra: t.minutos_propios && t.duracion_catalogo
      ? { texto: "La del catálogo", alClick: () => guardarDuracion(emp, t, 0) } : null,
    alSi: async fondo => {
      const m = (parseInt(fondo.querySelector("#durH").value, 10) || 0) * 60
              + (parseInt(fondo.querySelector("#durM").value, 10) || 0);
      if(m <= 0){ toast("Poné cuánto duró"); return false; }
      return await guardarDuracion(emp, t, m);
    }});
}
// Cero vuelve a la duración del catálogo.
const guardarDuracion = (emp, t, minutos) => mandar("/api/sueldos/trabajo-minutos", "PUT", t.suelto
  ? {empleado_id: emp, trabajo_id: t.id, minutos}
  : {empleado_id: emp, linea_id: t.linea_id, minutos});

/* ---------- las formas de pago: efectivo, transferencia o mixto ---------- */

function formasHTML(id, forma){
  return `<div class="fichas" data-formas="${id}">${["Efectivo","Transferencia","Mixto"].map(x =>
      `<button type="button" class="ficha${x === forma ? " on" : ""}" data-f="${x}">${x}</button>`).join("")}</div>
    <div class="mixto" data-mixto="${id}" ${forma === "Mixto" ? "" : "hidden"}>
      <label for="ef${id}">En efectivo</label><input id="ef${id}" inputmode="numeric" placeholder="$0"><span class="resto"></span></div>`;
}
// Engancha las fichas y devuelve el estado vivo: {forma, ef}.
function engancharFormas(raiz, id, total, alCambiar){
  const st = { forma: raiz.querySelector(`[data-formas="${id}"] .ficha.on`).dataset.f, ef: 0 };
  const mix = raiz.querySelector(`[data-mixto="${id}"]`), inp = mix.querySelector("input");
  const act = () => {
    const t = total();
    st.ef = Math.min(pesos(inp.value), t);
    inp.value = st.ef ? fmt(st.ef) : "";
    mix.querySelector(".resto").textContent = st.ef ? `y ${fmt(t - st.ef)} por transferencia` : "";
    alCambiar(st);
  };
  raiz.querySelectorAll(`[data-formas="${id}"] .ficha`).forEach(b => b.onclick = () => {
    st.forma = b.dataset.f;
    raiz.querySelectorAll(`[data-formas="${id}"] .ficha`).forEach(x => x.classList.toggle("on", x === b));
    mix.hidden = st.forma !== "Mixto";
    if(!mix.hidden) setTimeout(() => inp.focus(), 20);
    act();
  });
  inp.oninput = act;
  act();
  return st;
}
const formaLista = (st, t) => st.forma !== "Mixto" || (st.ef > 0 && st.ef < t);

/* ---------- adelanto y producto ---------- */

function cartelAdelanto(emp){
  let st, clave = claveDeCobro();
  const nombre = RES[emp].empleado.nombre;
  cartelForm({ titulo: DUENO ? `Adelanto a ${nombre}` : "Adelanto", si: "Dar el adelanto",
    texto: `Sale de la caja de hoy y se descuenta del próximo pago.`,
    cuerpo: `<div class="campo"><label for="adMonto">Cuánto</label><input id="adMonto" class="monto-grande" inputmode="numeric" placeholder="$0"></div>
      <div class="campo"><label>${DUENO ? "Cómo se lo lleva" : "Cómo te lo llevás"}</label>${formasHTML("ad", "Efectivo")}</div>`,
    alAbrir: (f, si) => {
      const inp = f.querySelector("#adMonto");
      const leyenda = () => {
        const n = pesos(inp.value);
        si.disabled = !n || !formaLista(st, n);
        si.textContent = !n ? "Dar el adelanto" : st.forma === "Mixto" ? `Adelanto de ${fmt(n)}` : `Adelanto de ${fmt(n)} en ${st.forma.toLowerCase()}`;
      };
      st = engancharFormas(f, "ad", () => pesos(inp.value), () => st && leyenda());
      inp.oninput = () => { const n = pesos(inp.value); inp.value = n ? fmt(n) : ""; f.querySelector("#efad").dispatchEvent(new Event("input")); leyenda(); };
      leyenda();
    },
    alSi: async f => {
      const n = pesos(f.querySelector("#adMonto").value);
      if(!n || !formaLista(st, n)) return false;
      const ok = await mandar("/api/sueldos/adelanto", "POST", {empleado_id: emp, monto: n, forma_pago: st.forma,
        efectivo: st.forma === "Mixto" ? st.ef : null, clave});
      if(ok) toast(`Adelanto de ${fmt(n)} anotado en la caja de hoy`);
      return ok;
    }});
}

/* Un producto que se lleva: se descuenta del próximo pago o se paga ahora, y
   ahí es un ticket a su nombre como cualquier otro. El precio lo pone ella; al
   lado queda el de la lista, que es lo que mira la dueña antes de pagar. */
async function cartelProducto(emp){
  const productos = await (await pedir("/api/sueldos/productos")).json();
  let prod = null, cant = 1, como = "descuento";
  const clave = claveDeCobro(), nombre = RES[emp].empleado.nombre;
  cartelForm({ titulo: DUENO ? `${nombre} se lleva un producto` : "Me llevo un producto", clase: "ancho",
    si: "Elegí un producto", cuerpo: `<div id="prodZona"></div>`,
    alAbrir: (f, si) => {
      const zona = f.querySelector("#prodZona");
      const dibujar = () => {
        if(!prod){
          zona.innerHTML = `<input id="pBusca" placeholder="Buscar en el inventario">
            <div class="prod-lista">${productos.map(p => `<button type="button" class="prod" data-id="${p.id}"${p.stock != null && p.stock <= 0 ? " disabled" : ""}>
              <span><b>${esc(p.nombre)}</b><span class="det">${p.stock != null ? ` · quedan ${p.stock}` : ""}</span></span>
              <span class="plata">${fmt(p.precio)}</span></button>`).join("") || `<div class="vacio-chico">No hay productos en el inventario.</div>`}</div>`;
          const b = zona.querySelector("#pBusca");
          b.oninput = () => zona.querySelectorAll(".prod").forEach(x =>
            x.hidden = !sinAcentos(x.querySelector("b").textContent).includes(sinAcentos(b.value)));
          zona.querySelectorAll(".prod").forEach(x => x.onclick = () => {
            prod = productos.find(p => String(p.id) === x.dataset.id); cant = 1; dibujar();
          });
          si.disabled = true; si.textContent = "Elegí un producto";
          setTimeout(() => b.focus(), 30);
          return;
        }
        zona.innerHTML = `<div class="prod-elegido"><span><b>${esc(prod.nombre)}</b>${prod.stock != null ? `<span class="tenue"> · quedan ${prod.stock}</span>` : ""}</span>
            <button type="button" id="pOtro">Cambiar</button></div>
          <div class="dos">
            <div class="campo"><label>Cantidad</label><div class="paso"><button type="button" id="pMenos" aria-label="Uno menos">−</button>
              <span id="pCant">${cant}</span><button type="button" id="pMas" aria-label="Uno más">+</button></div></div>
            <div class="campo"><label for="pPrecio">${DUENO ? "Lo que paga" : "Lo que pagás"} por cada uno</label>
              <input id="pPrecio" inputmode="numeric" value="${fmt(prod.precio)}">
              <span class="lista-precio">En la lista sale ${fmt(prod.precio)}</span></div>
          </div>
          <div class="campo"><label>${DUENO ? "Cómo lo paga" : "Cómo lo pagás"}</label><div class="fichas">
            <button type="button" class="ficha${como === "descuento" ? " on" : ""}" data-c="descuento">Que se descuente</button>
            <button type="button" class="ficha${como === "efectivo" ? " on" : ""}" data-c="efectivo">Ahora, en efectivo</button>
            <button type="button" class="ficha${como === "transfer" ? " on" : ""}" data-c="transfer">Ahora, transferencia</button></div></div>`;
        const precio = zona.querySelector("#pPrecio");
        const act = () => {
          const t = pesos(precio.value) * cant;
          si.disabled = false;
          si.textContent = como === "descuento" ? (t ? `Descontar ${fmt(t)}` : "Llevarlo sin cargo")
                                                : `Cobrar ${fmt(t)} en ${como === "efectivo" ? "efectivo" : "transferencia"}`;
        };
        precio.oninput = () => { precio.value = fmt(pesos(precio.value)); act(); };
        zona.querySelector("#pOtro").onclick = () => { prod = null; dibujar(); };
        const tope = prod.stock != null ? Math.max(prod.stock, 1) : 99;
        zona.querySelector("#pMenos").onclick = () => { cant = Math.max(1, cant - 1); zona.querySelector("#pCant").textContent = cant; act(); };
        zona.querySelector("#pMas").onclick = () => { cant = Math.min(tope, cant + 1); zona.querySelector("#pCant").textContent = cant; act(); };
        zona.querySelectorAll(".fichas .ficha").forEach(b => b.onclick = () => {
          como = b.dataset.c; zona.querySelectorAll(".fichas .ficha").forEach(x => x.classList.toggle("on", x === b)); act();
        });
        act();
      };
      dibujar();
    },
    alSi: async f => {
      if(!prod) return false;
      const precio = pesos(f.querySelector("#pPrecio").value);
      if(como === "descuento"){
        const ok = await mandar("/api/sueldos/producto", "POST",
          {empleado_id: emp, item_id: prod.id, cantidad: cant, precio, clave});
        if(ok) toast("Anotado: se descuenta del próximo pago");
        return ok;
      }
      // Pagado ahora es una venta: el ajuste por unidad lleva la lista de esa
      // forma de pago al precio que se dijo, igual en las dos listas.
      const lista = como === "efectivo" ? prod.precio : prod.precio_transfer;
      const ajuste = precio - lista;
      const r = await pedir("/api/comprobantes", {method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ tipo: "ticket", cliente_nombre: nombre, forma_pago: como, cobrar: true, clave,
          lineas: [{ item_id: prod.id, cantidad: cant, ajuste_monto: ajuste,
                     ajuste_nombre: ajuste ? "Precio empleada" : null }] })});
      if(!r.ok){ toast((await r.json().catch(() => ({}))).detail || "No se pudo cobrar"); return false; }
      const c = await r.json();
      toast(`Ticket N-${String(c.numero).padStart(5, "0")} a nombre de ${nombre}`);
      await refrescar();
    }});
}

/* ---------- enganchar ---------- */

function enganchar(raiz){
  raiz.querySelectorAll(".dia-fila[data-k]").forEach(b => b.onclick = () => {
    const k = b.dataset.k; ABIERTOS.has(k) ? ABIERTOS.delete(k) : ABIERTOS.add(k); repintar();
  });
  raiz.querySelectorAll(".cargar-h").forEach(b => b.onclick = ev => {
    ev.stopPropagation(); cartelHorario(Number(b.dataset.emp), b.dataset.fecha);
  });
  const caja = raiz.querySelector("#hoyTandas");
  if(caja){
    const boton = $("#guardarHoy");
    engancharTandas(caja, boton);
    boton.onclick = async () => {
      const t = leerTandas(caja);
      if(!tandasValidas(t)) return;
      boton.disabled = true;
      EDITANDO_HOY = false;
      if(await guardarHorario(YO, caja.dataset.fecha, t)) toast("Horario de hoy guardado");
      else { EDITANDO_HOY = true; boton.disabled = false; }
    };
  }
  const editarHoy = raiz.querySelector("#editarHoy"), cancelarHoy = raiz.querySelector("#cancelarHoy");
  if(editarHoy) editarHoy.onclick = () => { EDITANDO_HOY = true; repintar(); };
  if(cancelarHoy) cancelarHoy.onclick = () => { EDITANDO_HOY = false; repintar(); };
  raiz.querySelectorAll(".editar-min").forEach(b => b.onclick = () => {
    const emp = Number(b.dataset.emp);
    const t = RES[emp].dias.flatMap(d => d.trabajos).find(x => b.dataset.linea
      ? String(x.linea_id) === b.dataset.linea : x.suelto && String(x.id) === b.dataset.trabajo);
    if(t) cartelDuracion(emp, t);
  });
  raiz.querySelectorAll(".agregar-trabajo").forEach(b => b.onclick = () => abrirFormTrabajo(b));
  raiz.querySelectorAll(".borrar-suelto").forEach(a => a.onclick = async e => {
    e.preventDefault();
    if(!await confirmar("¿Borrar este trabajo cargado a mano?", { si: "Borrar", peligro: true })) return;
    await mandar("/api/sueldos/trabajo-suelto/" + a.dataset.trabajo, "DELETE");
  });
  raiz.querySelectorAll(".dar-adelanto").forEach(b => b.onclick = () => cartelAdelanto(Number(b.dataset.emp)));
  raiz.querySelectorAll(".dar-producto").forEach(b => b.onclick = () => cartelProducto(Number(b.dataset.emp)));
  raiz.querySelectorAll(".anular-mov").forEach(b => b.onclick = async () => {
    const m = RES[b.dataset.emp].movimientos.find(x => String(x.id) === b.dataset.id);
    const motivo = await pedirMotivo(`¿Anular ${m.tipo === "adelanto" ? `el adelanto de ${fmt(m.monto)}` : m.nombre}?\n\n${
      m.tipo === "adelanto" ? "La plata vuelve a la caja" : "Vuelve al stock"} y deja de descontarse.`);
    if(!motivo) return;
    if(await mandar(`/api/sueldos/movimientos/${m.id}?motivo=${encodeURIComponent(motivo)}`, "DELETE"))
      toast("Anulado");
  });
}

const repintar = () => DUENO ? pintarDuena() : pintarEmpleada();

/* El formulario de un trabajo sin comprobante aparece recién cuando se lo pide,
   pegado al día que lo va a recibir. */
function abrirFormTrabajo(boton){
  document.querySelectorAll(".form-trabajo").forEach(x => x.remove());
  if(!ITEMS.length){ toast("Falta poner en el catálogo cuáles van a comisión"); return; }
  const fecha = boton.dataset.fecha, emp = Number(boton.dataset.emp);
  const caja = document.createElement("div");
  caja.className = "agregar form-trabajo";
  caja.innerHTML = `
    <div class="ancho"><label>Trabajo del ${dm(fecha)}</label>
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
      empleado_id: emp, item_id: Number(sel.value),
      cantidad: Math.max(1, parseInt(caja.querySelector(".fCant").value,10)||1),
      fecha, minutos: it && it.duracion_min === minutos ? 0 : minutos});
  };
  sel.focus();
}

/* Un solo lugar donde se habla con el servidor: si algo falla se muestra el
   motivo que mandó el backend en vez de dejar la pantalla como si hubiera
   guardado. Después de cualquier cambio se recarga todo. */
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
