requireLogin(); pintarNav();
const $=s=>document.querySelector(s);
const fmt=n=>"$"+(n||0).toLocaleString("es-AR");
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let CATALOGO=[], DESCUENTOS=[], CLIENTES=[], ticket=[], NEGOCIO={};
let tipo="ticket", descPct=0, descNombre=null, formaPago="efectivo";
let totalActual=0;
let mxDeudaActual=0;
let vista="cats", catActual=null, grupoActual=null;
const ORDEN_VAR=["S","M","L","XL","Mayor XL"];
const ordenVar=v=>{const i=ORDEN_VAR.indexOf(v);return i<0?99:i;};
function parseNombre(nombre){
  const m=nombre.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  return m?{base:m[1].trim(),variante:m[2].trim()}:{base:nombre.trim(),variante:null};
}

function toast(m){const t=$("#toast");t.textContent=m;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2200);}

$("#btnGuardarEgreso").onclick=async()=>{
  const tipo=$("#egTipo").value.trim();
  const monto=parseInt($("#egMonto").value);
  if(!tipo || !monto){ toast("Completá tipo y monto"); return; }
  await authFetch("/api/tipos-egreso",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({nombre:tipo})});
  await authFetch("/api/egresos",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({tipo, concepto:$("#egConcepto").value, monto, forma_pago:$("#egPago").value})});
  $("#egTipo").value=""; $("#egConcepto").value=""; $("#egMonto").value="";
  toast("Egreso registrado"); cargarEgresosHoy();
};

async function cargarEgresosHoy(){
  const es=await (await authFetch("/api/egresos/dia")).json();
  const cont=$("#egresosHoy");

  /* El total del día va en el encabezado: si el bloque está cerrado, igual
     sabés cuánto salió sin abrirlo. */
  const total = es.reduce((a,e)=>a+e.monto, 0);
  $("#egresoResumen").textContent = es.length
    ? `${es.length} hoy · ${fmt(total)}`
    : "";

  if(es.length===0){ cont.innerHTML='<div class="muted">Todavía no salió plata hoy.</div>'; return; }
  cont.innerHTML='<div class="eg-tit">Egresos de hoy</div>';
  es.forEach(e=>{
    const row=document.createElement("div"); row.className="eg-row";
    const detalle=[e.concepto, e.forma_pago].filter(Boolean).join(" · ");
    row.innerHTML=`
      <span class="hora">${e.hora}</span>
      <span class="que"><b>${e.tipo}</b>${detalle?' <span class="det">'+detalle+'</span>':''}</span>
      <span class="monto">−${fmt(e.monto)}</span>
      <button class="quitar" title="Anular este egreso">×</button>`;
    row.querySelector(".quitar").onclick=async()=>{
      if(!confirm("¿Anular este egreso?"))return;
      const r=await authFetch("/api/egresos/"+e.id,{method:"DELETE"});
      if(!r.ok){ toast("No se pudo"); return; }
      toast("Egreso anulado"); cargarEgresosHoy();
    };
    cont.appendChild(row);
  });
}

async function init(){
  const cfg=await (await authFetch("/api/config")).json();
  NEGOCIO=cfg.negocio||{};              // encabezado del papel impreso
  CATALOGO=await (await authFetch("/api/catalogo")).json();
  CLIENTES=await (await authFetch("/api/clientes")).json();
  $("#cobroForma").innerHTML=(cfg.formas_pago||[]).map(f=>`<option>${f}</option>`).join("");
  $("#egPago").innerHTML=(cfg.formas_pago||[]).map(f=>`<option>${f}</option>`).join("");
  $("#egTipos").innerHTML=(cfg.tipos_egreso||[]).map(t=>`<option value="${t}">`).join("");
  $("#aliasList").innerHTML=(cfg.alias||[]).map(a=>`<option value="${a}">`).join("");
  DESCUENTOS=await (await authFetch("/api/descuentos")).json();
  $("#descuento").innerHTML='<option value="">Sin descuento</option>'+
    DESCUENTOS.map((d,i)=>`<option value="${i}">${d.nombre} ${d.porcentaje}%</option>`).join("");
  AJUSTES=await (await authFetch("/api/ajustes-item")).json();   // descuentos/recargos por línea
  pintarRail();
  renderCategorias(); restaurarBorrador(); pintarOtroDia(); renderTicket(); mostrarBotones(); cargarEgresosHoy();
  const cliParam=new URLSearchParams(location.search).get("cliente");
  if(cliParam){ $("#cliente").value=cliParam; }
}

// El precio de lista lleva el peso; el de descuento va de apoyo, chiquito al lado.
function precioBtn(it){
  return `<span class="precios"><span class="p-tr">${fmt(it.precio_transfer)}</span>`+
         `<span class="p-ef">c/desc ${fmt(it.precio)}</span></span>`;
}
function categorias(){
  const set=[], vistos=new Set();
  CATALOGO.forEach(it=>{ if(!vistos.has(it.categoria)){vistos.add(it.categoria);set.push(it.categoria);} });
  return set.sort((a,b)=>a.localeCompare(b,'es'));
}

/* El rail se dibuja UNA vez y queda siempre a la vista: desde cualquier lugar
   (dentro de un grupo, o buscando) se puede saltar a otra categoría sin volver. */
function pintarRail(){
  const rail=$("#catPills"); rail.innerHTML="";
  const cuentas=new Map();
  CATALOGO.forEach(it=>cuentas.set(it.categoria,(cuentas.get(it.categoria)||0)+1));
  categorias().forEach(c=>{
    const b=document.createElement("button");
    b.className="cat-pill"; b.dataset.cat=c;
    b.innerHTML=`<span class="nom">${esc(c)}</span><span class="cuenta">${cuentas.get(c)||0}</span>`;
    b.onclick=()=>{ $("#buscar").value=""; abrirCategoria(c); };
    rail.appendChild(b);
  });
}
function marcarRail(cat){
  $("#catPills").querySelectorAll(".cat-pill").forEach(p=>p.classList.toggle("on", p.dataset.cat===cat));
}

function renderCategorias(){
  // Sin categoría elegida abrimos la primera: en tablet es un toque menos y la
  // grilla nunca arranca vacía.
  const cats=categorias();
  if(cats.length){ abrirCategoria(cats[0]); return; }
  vista="cats"; catActual=null; grupoActual=null;
  $("#barraNav").style.display="none";
  $("#items").innerHTML='<p class="muted" style="grid-column:1/-1;">No hay ítems cargados.</p>';
}
function abrirCategoria(cat){
  vista="items"; catActual=cat; grupoActual=null;
  marcarRail(cat);
  $("#barraNav").style.display="none";
  const items=CATALOGO.filter(i=>i.categoria===cat);
  const grupos=new Map();
  items.forEach(it=>{ const{base,variante}=parseNombre(it.nombre);
    if(!grupos.has(base))grupos.set(base,[]); grupos.get(base).push({variante,it}); });
  const g=$("#items"); g.innerHTML="";
  [...grupos.entries()].forEach(([base,arr])=>{
    if(arr.length===1){
      const it=arr[0].it; const b=document.createElement("button"); b.className="btn-item";
      b.innerHTML=`<span class="n">${it.nombre}</span>${precioBtn(it)}`;
      b.onclick=()=>agregar(it); g.appendChild(b);
    } else {
      const labels=arr.map(a=>a.variante).filter(Boolean).sort((a,b)=>ordenVar(a)-ordenVar(b));
      const b=document.createElement("button"); b.className="btn-item grupo";
      b.innerHTML=`<span class="n">${base}&nbsp;›<span class="hint">${labels.join(" · ")||"opciones"}</span></span>${precioBtn(arr[0].it)}`;
      b.onclick=()=>abrirGrupo(base,arr); g.appendChild(b);
    }
  });
}
function abrirGrupo(base,arr){
  vista="grupo"; grupoActual=base;
  $("#barraNav").style.display="flex";
  $("#volver").textContent="← "+catActual; $("#tituloCat").textContent=base;
  const ordenado=[...arr].sort((a,b)=>ordenVar(a.variante)-ordenVar(b.variante));
  const g=$("#items"); g.innerHTML="";
  ordenado.forEach(({variante,it})=>{
    const b=document.createElement("button"); b.className="btn-item";
    b.innerHTML=`<span class="n">${variante||it.nombre}</span>${precioBtn(it)}`;
    b.onclick=()=>agregar(it); g.appendChild(b);
  });
}
function buscar(q){
  vista="buscar";
  marcarRail(null);                        // buscando no hay categoría activa
  $("#barraNav").style.display="flex";
  $("#volver").textContent="← Volver"; $("#tituloCat").textContent=`"${q}"`;
  const res=CATALOGO.filter(i=>i.nombre.toLowerCase().includes(q.toLowerCase()));
  const g=$("#items"); g.innerHTML="";
  if(res.length===0){ g.innerHTML='<p class="muted">Nada coincide.</p>'; return; }
  res.forEach(it=>{
    const b=document.createElement("button"); b.className="btn-item";
    // al buscar sí conviene ver de qué categoría es cada resultado
    b.innerHTML=`<span class="n">${esc(it.nombre)}</span>`+
                `<span class="cat-mini">${esc(it.categoria)}</span>${precioBtn(it)}`;
    b.onclick=()=>agregar(it); g.appendChild(b);
  });
}

$("#buscar").oninput=e=>{ const q=e.target.value.trim(); if(q.length===0){renderCategorias();return;} buscar(q); };
$("#volver").onclick=()=>{
  $("#buscar").value="";
  // desde un grupo se vuelve a su categoría; desde la búsqueda, a la última abierta
  abrirCategoria(catActual || categorias()[0]);
};

function agregar(it){
  // Solo se acumula con una línea SIN ajuste: si la de arriba tiene un descuento
  // propio, sumarle una unidad se lo aplicaría también, que no es lo que se quiere.
  const ex=ticket.find(l=>l.item_id===it.id && !l.precioEditado && !l.ajustePct);
  if(ex){ ex.cantidad++; } else {
    ticket.push({item_id:it.id, nombre:it.nombre, precio:it.precio, precioTransfer:it.precio_transfer,
                 precioCatalogo:it.precio, cantidad:1, precioEditado:false,
                 ajustePct:0, ajusteMonto:0, ajusteNombre:null});
  }
  renderTicket();
}

// --- Ajuste por línea ---------------------------------------------------
// Va POR UNIDAD y con signo, de dos formas excluyentes:
//   porcentaje: -10 descuenta un 10%, +15 recarga un 15%
//   monto fijo: -2000 descuenta $2000, +1500 recarga $1500
// Mismo criterio que precio_con_ajuste() en el backend: si hay monto, manda el
// monto; el mismo importe se resta de las dos listas y nunca baja de 0.
const conAjuste = (base, pct, monto) => {
  base = base || 0;
  if(monto) return Math.max(base + monto, 0);
  return pct ? Math.round(base * (100 + pct) / 100) : base;
};
const precioAjEf = l => conAjuste(l.precio,         l.ajustePct, l.ajusteMonto);
const precioAjTr = l => conAjuste(l.precioTransfer, l.ajustePct, l.ajusteMonto);
// Un ajuste "existe" si tiene porcentaje o monto. Se pregunta en varios lados,
// así que va una sola vez acá.
const hayAj = l => !!(l.ajustePct || l.ajusteMonto);
let AJUSTES = [];                 // lista configurada en admin

/* --- Extras del comprobante ---
   Cargos sueltos que se suman al final, después de todos los descuentos, y que
   siempre salen impresos. No son ítems del catálogo ni llevan cantidad. */
let EXTRAS = [];                  // [{concepto, monto}]

function renderExtras(){
  const cont=$("#listaExtras"); cont.innerHTML="";
  EXTRAS.forEach((e,i)=>{
    const row=document.createElement("div"); row.className="extra-linea";
    row.innerHTML=`<span class="cn">${esc(e.concepto)}</span>
                   <span class="mt">${fmt(e.monto)}</span>
                   <button class="quitar" title="Quitar">×</button>`;
    row.querySelector(".quitar").onclick=()=>{ EXTRAS.splice(i,1); renderExtras(); actualizarTotales(); };
    cont.appendChild(row);
  });
}

function agregarExtra(){
  const concepto=$("#exConcepto").value.trim();
  const monto=parseInt($("#exMonto").value)||0;
  if(!concepto){ toast("Poné un concepto"); return; }
  if(monto<=0){ toast("El monto tiene que ser mayor a 0"); return; }
  EXTRAS.push({concepto, monto});
  $("#exConcepto").value=""; $("#exMonto").value="";
  renderExtras(); actualizarTotales(); guardarBorrador();
  $("#exConcepto").focus();
}

/* Cómo se lee un ajuste de la lista de admin en el desplegable. */
const etiquetaAj = a => a.monto
  ? `${a.monto<0?"−":"+"}${fmt(Math.abs(a.monto))} c/u`
  : `${a.porcentaje<0?"−":"+"}${Math.abs(a.porcentaje)}%`;

/* Si la línea tiene puesto exactamente este ajuste de la lista. */
const coincideAj = (l, a) => l.ajusteNombre === a.nombre
  && (l.ajusteMonto||0) === (a.monto||0)
  && (l.ajustePct||0)   === (a.monto ? 0 : a.porcentaje);

/* El botón del ajuste muestra lo que está aplicado: "−10%", "−$2.000" o, si no
   hay nada, el símbolo del tipo que se usó la última vez. */
function claseAj(l){
  const v = l.ajusteMonto || l.ajustePct || 0;
  return v < 0 ? "aj desc" : v > 0 ? "aj rec" : "aj";
}
function textoAj(l){
  if(l.ajusteMonto) return `${l.ajusteMonto<0?"−":"+"}${fmt(Math.abs(l.ajusteMonto))}`;
  if(l.ajustePct)   return `${l.ajustePct<0?"−":"+"}${Math.abs(l.ajustePct)}%`;
  return "%";
}

/* Cómo se describe el ajuste en palabras, para el renglón de abajo de la línea. */
function detalleAj(l){
  const neg = (l.ajusteMonto || l.ajustePct) < 0;
  const cuanto = l.ajusteMonto
    ? `${neg?"−":"+"}${fmt(Math.abs(l.ajusteMonto))} c/u`
    : `${neg?"−":"+"}${Math.abs(l.ajustePct)}%`;
  return `${l.ajusteNombre || (neg ? "Descuento" : "Recargo")} ${cuanto}`;
}

/* Precios de una línea listos para pintar. Está aparte del render completo porque
   mientras se tipea un porcentaje hay que refrescarlos sin volver a dibujar la
   línea entera (si no, el input pierde el foco a mitad de lo que estás cargando). */
function htmlPrecios(l, dosColumnas){
  const aj = hayAj(l);
  const tachado = base => aj ? `<span class="precio-viejo">${fmt(base)}</span> ` : "";
  return dosColumnas
    ? `<span style="display:flex;gap:12px;font-size:13px;min-width:130px;text-align:right;">
         <span><span style="font-size:11px;color:var(--text-tenue);">Lista</span><br>${tachado(l.precioTransfer)}${fmt(precioAjTr(l))}</span>
         <span><span style="font-size:11px;color:var(--text-tenue);">Con desc.</span><br>${tachado(l.precio)}${fmt(precioAjEf(l))}</span>
       </span>`
    : `<span style="min-width:110px;text-align:right;">${tachado(l.precioTransfer)}${fmt(precioAjTr(l))} <span style="color:var(--text-tenue);font-size:11px;">(c/desc ${fmt(precioAjEf(l))} )</span></span>`;
}

$("#item-extra").onclick=()=>agregarItem();

$("#btnAddExtra").onclick=()=>agregarExtra();
// Enter en cualquiera de los dos campos también lo suma
["#exConcepto","#exMonto"].forEach(sel=>{
  $(sel).onkeydown = e => { if(e.key==="Enter"){ e.preventDefault(); agregarExtra(); } };
});

function agregarItem(){
  // 'editando:true' marca la línea como "en edición": mientras esté así se muestran
  // los inputs y no se puede cobrar. Recién al tocar 💾 pasa a false y queda fija.
  ticket.push({item_id: null, nombre: "", precio: 0, precioTransfer: 0,
              precioCatalogo: 0, cantidad: 1, precioEditado:false, editando:true,
              ajustePct:0, ajusteMonto:0, ajusteNombre:null});
  renderTicket();
}

// Precio transferencia = efectivo x 1,1111 redondeado hacia arriba a múltiplo de 100.
// (Mismo criterio que el backend en config_extra.calcular_transfer.)
const calcularTransfer = precioEfvo => Math.ceil((precioEfvo||0) * 1.1111 / 100) * 100;

// Confirma un ítem extra: valida, lo deja fijo y sale del modo edición.
function guardarItemExtra(l){
  l.nombre = (l.nombre || "").trim();
  if(l.nombre === "" || !(l.precio > 0)){ toast("Completá nombre y precio del ítem"); return; }
  l.precioEditado = true;
  l.editando = false;
  renderTicket();
}

function renderTicket(){
  const esEf = formaPago==="efectivo";
  const esPresu = document.getElementById("btnPresu").classList.contains("on");
  const cont=$("#lineas"); cont.innerHTML="";

  if(ticket.length===0){ cont.innerHTML='<p class="muted">Tocá un servicio para empezar.</p>'; }
  ticket.forEach((l,i)=>{

    const editando = !!l.editando;          // línea de ítem extra abierta para editar
    const esExtra  = l.item_id === null;     // ítem cargado a mano (ya guardado o en edición)
    const row=document.createElement("div"); row.className = "linea" + (editando ? " editando" : "");

    const aj = hayAj(l);
    const preciosHTML = `<span class="precios-linea">${htmlPrecios(l, esPresu && !editando)}</span>`;
    const ajClase = claseAj(l), ajTexto = textoAj(l);
    const ajTitulo = aj ? esc(l.ajusteNombre || "Ajuste manual") : "Descuento o recargo de este ítem";
    const enPesos = !!l.ajusteMonto || l.ajusteUnidad === "$";

    row.innerHTML=`
      ${editando
        ?`<input class="nombre-item-extra" placeholder="Nombre del ítem" value="${esc(l.nombre)}">
          <div class="precio-extra-box"><span class="pfx">$</span><input class="precio-item-extra" inputmode="numeric" placeholder="Precio efvo." value="${l.precio>0?l.precio:''}"></div>
          <span class="transfer-vivo">transf ${fmt(l.precioTransfer)}</span>
          <button class="check-item-extra" title="Guardar ítem">💾</button>`
        : esExtra
        ?`<span class="n">${esc(l.nombre)}<button class="edit-item-extra" title="Editar ítem">✏️</button></span>
          ${preciosHTML}`
        :`<span class="n">${l.nombre}</span>
          ${preciosHTML}`
      }
      ${editando ? "" : `<span class="aj-nota">${aj ? "↳ "+esc(detalleAj(l)) : ""}</span>`}
      <div class="controles">
        ${editando ? "" : `<button class="${ajClase}" title="${ajTitulo}">${ajTexto}</button>`}
        <div class="qty separa"><button class="menos">−</button><span>${l.cantidad}</span><button class="mas">+</button></div>
        <button class="quitar">×</button>
      </div>
      ${l.ajusteAbierto && !editando ? `
      <div class="aj-panel">
        <span class="lbl">Ajuste:</span>
        <select class="aj-sel">
          <option value="">Sin ajuste</option>
          ${AJUSTES.map(a=>`<option value="${a.id}"${coincideAj(l,a)?" selected":""}>${esc(a.nombre)} (${etiquetaAj(a)})</option>`).join("")}
          <option value="libre"${aj && !l.ajusteNombre?" selected":""}>Otro…</option>
        </select>
        <div class="aj-unidad">
          <button class="u-pct${enPesos?"":" on"}" type="button" title="Ajuste en porcentaje">Porc. %</button>
          <button class="u-mon${enPesos?" on":""}" type="button" title="Ajuste en pesos">Pesos</button>
        </div>
        <div class="pct-box">
          ${enPesos ? '<span class="pfx">$</span>' : ""}
          <input class="aj-valor" type="number" inputmode="numeric"
                 ${enPesos?"":'min="-100" max="100"'} placeholder="0"
                 value="${(enPesos ? l.ajusteMonto : l.ajustePct) || ''}">
          ${enPesos ? "" : '<span class="sfx">%</span>'}
        </div>
        <span class="lbl">(negativo descuenta)</span>
        <button class="quitar-aj">Listo</button>
      </div>` : ""}
    `;

    // Ítem extra en edición: inputs de nombre/precio + guardar
    if(editando){
      const inputnombre = row.querySelector(".nombre-item-extra");
      inputnombre.oninput = e => { l.nombre = e.target.value; };

      const inputprecio = row.querySelector(".precio-item-extra");
      inputprecio.oninput = e => {
        l.precio = Number(e.target.value) || 0;
        l.precioTransfer = calcularTransfer(l.precio);
        row.querySelector(".transfer-vivo").textContent = "transf " + fmt(l.precioTransfer);
      };
      // Enter en cualquiera de los campos también guarda
      [inputnombre, inputprecio].forEach(inp => inp.onkeydown = e => { if(e.key === "Enter"){ e.preventDefault(); guardarItemExtra(l); } });
      row.querySelector(".check-item-extra").onclick = () => guardarItemExtra(l);
    } else if(esExtra){
      row.querySelector(".edit-item-extra").onclick = () => { l.editando = true; renderTicket(); };
    }

    // Ajuste de la línea: abrir/cerrar el panel, elegir de la lista o tipear a mano
    if(!editando){
      row.querySelector(".aj").onclick = () => { l.ajusteAbierto = !l.ajusteAbierto; renderTicket(); };
    }
    if(l.ajusteAbierto && !editando){
      const sel = row.querySelector(".aj-sel");
      const inp = row.querySelector(".aj-valor");
      sel.onchange = () => {
        if(sel.value === ""){ l.ajustePct = 0; l.ajusteMonto = 0; l.ajusteNombre = null; }
        else if(sel.value === "libre"){ l.ajusteNombre = null; }   // deja lo tipeado
        else {
          const a = AJUSTES.find(x => String(x.id) === sel.value);
          if(a){
            // El ajuste guardado trae su propia unidad: si es en pesos, el panel
            // se pasa a pesos solo.
            l.ajusteMonto = a.monto || 0;
            l.ajustePct   = a.monto ? 0 : a.porcentaje;
            l.ajusteUnidad = a.monto ? "$" : "%";
            l.ajusteNombre = a.nombre;
          }
        }
        renderTicket();
      };
      // Cambiar de % a $ (o al revés) arranca de cero: convertir "−10%" a un
      // monto daría un número distinto por cada línea y sería peor que empezar
      // de nuevo. Se recuerda la unidad elegida para la próxima vez.
      const cambiarUnidad = u => {
        l.ajusteUnidad = u; l.ajustePct = 0; l.ajusteMonto = 0; l.ajusteNombre = null;
        renderTicket();
        // el input del panel recién dibujado queda listo para tipear
        const nuevo = document.querySelectorAll(".linea")[i]?.querySelector(".aj-valor");
        if(nuevo) nuevo.focus();
      };
      row.querySelector(".u-pct").onclick = () => cambiarUnidad("%");
      row.querySelector(".u-mon").onclick = () => cambiarUnidad("$");

      inp.oninput = () => {
        let v = parseInt(inp.value);
        if(isNaN(v)) v = 0;
        if(enPesos){
          l.ajusteMonto = v; l.ajustePct = 0;
        } else {
          l.ajustePct = Math.max(-100, Math.min(100, v)); l.ajusteMonto = 0;
        }
        l.ajusteNombre = null;          // si lo tipea a mano, ya no es uno de la lista
        // Refrescamos a mano lo que cambia, en vez de redibujar: así el input
        // conserva el foco y el cursor mientras se sigue escribiendo.
        sel.value = v ? "libre" : "";
        const btn = row.querySelector(".aj");
        btn.className = claseAj(l); btn.textContent = textoAj(l);
        const nota = row.querySelector(".aj-nota");
        if(nota) nota.textContent = hayAj(l) ? "↳ " + detalleAj(l) : "";
        row.querySelector(".precios-linea").innerHTML = htmlPrecios(l, esPresu && !editando);
        actualizarTotales();
      };
      row.querySelector(".quitar-aj").onclick = () => { l.ajusteAbierto = false; renderTicket(); };
    }

    // onclicks
    row.querySelector(".mas").onclick=()=>{ l.cantidad++; renderTicket(); };
    row.querySelector(".menos").onclick=()=>{ l.cantidad--; if(l.cantidad<=0) ticket.splice(i,1); renderTicket(); };
    row.querySelector(".quitar").onclick=()=>{ ticket.splice(i,1); renderTicket(); };

    cont.appendChild(row);
  });

  actualizarTotales();
}

/* Los totales van aparte del render de las líneas: así, mientras se tipea un
   porcentaje a mano, se pueden recalcular sin volver a dibujar el input
   (redibujarlo le sacaría el foco en la mitad de lo que estás escribiendo). */
function actualizarTotales(){
  const esEf = formaPago==="efectivo";
  const esPresu = document.getElementById("btnPresu").classList.contains("on");

  // --- subtotales base (ya con el ajuste de cada línea aplicado) ---
  const totalEf = ticket.reduce((a,l)=>a+precioAjEf(l)*l.cantidad,0);     // a precio efectivo
  const totalTr = ticket.reduce((a,l)=>a+precioAjTr(l)*l.cantidad,0);     // a precio transfer
  const subTr = totalTr;           // subtotal transfer (el que se ve siempre)
  const subEf = totalEf;           // subtotal efectivo

  // descuento de catálogo (jubilado, promo, etc.)
  const hayDescCat = descPct > 0;
  const descCatTr = hayDescCat ? Math.round(subTr * descPct / 100) : 0;
  const descCatEf = hayDescCat ? Math.round(subEf * descPct / 100) : 0;
  const baseCat = esEf ? subEf : subTr;
  const descCat = hayDescCat ? (esEf ? descCatEf : descCatTr) : 0;

  // En presupuesto, mostrar AMBOS subtotales (Lista/Descuento); en ticket, solo el de la forma seleccionada
  // Presupuesto: dos columnas de importes. El encabezado dice cuál es cuál, así
  // que cada renglón solo pone los números.
  $("#totales").classList.toggle("presu", esPresu);
  pintarAvisoBorrador();
  $("#subtotal").textContent  = fmt(subTr);
  $("#subtotal2").textContent = esPresu ? fmt(subEf) : "";

  // descuento efectivo = diferencia de las 2 listas
  const descEfvo = subTr - subEf;
  const pctEfvo = subTr>0 ? (descEfvo/subTr*100) : 0;
  // En presupuesto, mostrar siempre; en ticket, solo si es efectivo
  $("#rowDescEfvo").style.display = ((esPresu || esEf) && ticket.length>0) ? "" : "none";
  $("#descEfvoLabel").textContent = esPresu ? `Diferencia` : `Descuento (${pctEfvo.toFixed(2)}%)`;
  $("#descEfvoMonto").textContent = "−"+fmt(descEfvo);

  // subtotal con descuento de catálogo
  const hayDescCatYPresu = hayDescCat && esPresu;
  const hayDescCatYEf = hayDescCat && esEf;
  $("#rowSubEfvo").style.display = (hayDescCatYPresu || hayDescCatYEf) ? "" : "none";
  if(hayDescCatYPresu){
    document.querySelector("#rowSubEfvo .lbl").textContent = "Subtotal c/desc";
    $("#subEfvoMonto").textContent  = fmt(subTr - descCatTr);
    $("#subEfvoMonto2").textContent = fmt(subEf - descCatEf);
  } else {
    $("#subEfvoMonto").textContent = fmt(subEf);
    $("#subEfvoMonto2").textContent = "";
  }

  $("#rowDescCat").style.display = (hayDescCat && ticket.length>0) ? "" : "none";
  $("#descCatLabel").textContent = descNombre || "Descuento";
  if(esPresu && hayDescCat){
    $("#descCatMonto").textContent  = "−"+fmt(descCatTr);
    $("#descCatMonto2").textContent = "−"+fmt(descCatEf);
  } else {
    $("#descCatMonto").textContent  = "−"+fmt(descCat);
    $("#descCatMonto2").textContent = "";
  }

  // Extras: entran al final, sin que ningún descuento los toque
  const extrasTotal = EXTRAS.reduce((a,e)=>a+(e.monto||0),0);
  $("#rowExtras").style.display = extrasTotal>0 ? "" : "none";
  $("#extrasMonto").textContent  = "+"+fmt(extrasTotal);
  $("#extrasMonto2").textContent = "+"+fmt(extrasTotal);

  // total
  const total = baseCat - descCat + extrasTotal;
  if(esPresu){
    $("#total").textContent  = fmt(subTr - descCatTr + extrasTotal);
    $("#total2").textContent = fmt(subEf - descCatEf + extrasTotal);
    totalActual = subEf - descCatEf + extrasTotal;  // usar total efectivo para operaciones
  } else {
    $("#total").textContent = fmt(total);
    $("#total2").textContent = "";
    totalActual = total;
  }

  const vacio = ticket.length===0;
  actualizarAcciones();
  $("#cobrarTodo").textContent = vacio ? "Cobrar todo" : "Cobrar todo "+fmt(total);
  guardarBorrador();
  
}

// ---- Borrador del ticket: sobrevive al cambiar de pantalla ----
const BORRADOR_KEY = "ticketBorrador";

function guardarBorrador(){
  localStorage.setItem(BORRADOR_KEY, JSON.stringify({
    guardado: Date.now(),
    ticket,
    cliente: $("#cliente").value,
    clienteIdSel,
    notaCliente: $("#notaCliente").textContent,
    peluquero: $("#peluquero").value,
    descPct, descNombre,
    fechaServicio: $("#fechaServicio").value,
    descuentoSel: $("#descuento").value,   // el índice elegido en el select de descuento
    formaPago,
    extras: EXTRAS
  }));
}

function restaurarBorrador(){
  const raw = localStorage.getItem(BORRADOR_KEY);
  if(!raw) return;
  try{
    const d = JSON.parse(raw);
    if(Date.now() - (d.guardado||0) > 12*3600*1000){ localStorage.removeItem(BORRADOR_KEY); return; }  // más de 12hs: lo descartamos
    if(!d.ticket || d.ticket.length === 0) return;   // nada útil que restaurar
    // Un ítem extra sin precio confirmado se restaura en modo edición (no como línea fija en $0).
    ticket = d.ticket.map(l => {
      if(l.item_id === null && !(l.precioEditado && l.precio > 0)) l.editando = true;
      return l;
    });
    $("#cliente").value = d.cliente || "";
    clienteIdSel = d.clienteIdSel ?? null;
    mostrarNotaCliente(d.notaCliente || "");
    $("#peluquero").value = d.peluquero || "";
    descPct = d.descPct || 0;
    descNombre = d.descNombre || null;
    $("#fechaServicio").value = d.fechaServicio || "";
    $("#descuento").value = d.descuentoSel || "";
    EXTRAS = Array.isArray(d.extras) ? d.extras : [];
    renderExtras();
    if(EXTRAS.length) $("#extrasBox").open = true;   // si hay extras cargados, que se vean
    formaPago = d.formaPago || "efectivo";
    $("#formaPago").value = formaPago;
  }catch(e){ localStorage.removeItem(BORRADOR_KEY); }
}

function disableBotones(v){
  ["cobrarTodo","cobrarParte","dejarCuenta","cobrarMixto","crearPresu"].forEach(id=>{
    const b = $("#"+id); if(b) b.disabled = v;
  });
}

function bloquearControles(v){
  ["formaPago","btnTicket","btnPresu","cliente","peluquero","descuento"].forEach(id=>{
    const el = $("#"+id); if(el) el.disabled = v;
  });
}

function mostrarBotones(){
  const esT = tipo==="ticket";
  $("#botsTicket").style.display = esT ? "block" : "none";
  $("#crearPresu").style.display = esT ? "none" : "block";

  // En presupuesto, el selector de forma solo ofrece Efectivo / Transferencia
  $("#formaPago").querySelector('option[value="mixto"]').style.display  = esT ? "block" : "none";
  $("#formaPago").querySelector('option[value="cuenta"]').style.display = esT ? "block" : "none";

  // Si venías en mixto/cuenta y pasás a presupuesto, lo reseteamos a efectivo
  if(!esT && (formaPago==="mixto" || formaPago==="cuenta")){
    formaPago = "efectivo";
    $("#formaPago").value = "efectivo";
    $("#aliasBox").style.display = "none";
  }
  renderTicket();   // repinta con la forma correcta
}

function actualizarAcciones(){
  const listo    = ticketListo();
  if(tipo === "presupuesto"){
    $("#crearPresu").disabled = !listo;   // el presupuesto solo necesita ítems + cliente
    return;
  }
  const esMixto  = formaPago === "mixto";
  const esCuenta = formaPago === "cuenta";

  // Qué botones se ven según la forma de pago
  $("#cobrarTodo").style.display  = (esMixto || esCuenta) ? "none" : "block";
  $("#cobrarParte").style.display = (esMixto || esCuenta) ? "none" : "block";
  $("#dejarCuenta").style.display = esMixto ? "none" : "block";
  $("#cobrarMixto").style.display = esMixto ? "block" : "none";

  const enProgreso = !!compActual;
  ["cobrarTodo","cobrarParte","dejarCuenta","cobrarMixto"].forEach(id=>{
    const b = $("#"+id); if(b) b.disabled = !listo || enProgreso;
  });
  bloquearControles(enProgreso);
}

// El ticket está "listo" para cobrar si tiene al menos un ítem, un cliente cargado
// y ningún ítem extra a medio cargar (sin confirmar con 💾).
function ticketListo(){
  return ticket.length > 0 && $("#cliente").value.trim() !== "" && !ticket.some(l=>l.editando);
}

$("#cliente").oninput = actualizarAcciones;
$("#btnTicket").onclick=()=>{ tipo="ticket"; $("#btnTicket").classList.add("on"); $("#btnPresu").classList.remove("on"); mostrarBotones(); };
$("#btnPresu").onclick=()=>{ tipo="presupuesto"; $("#btnPresu").classList.add("on"); $("#btnTicket").classList.remove("on"); mostrarBotones(); };
$("#formaPago").onchange = e => {
  formaPago = e.target.value;
  $("#aliasBox").style.display = (formaPago === "transfer") ? "flex" : "none";
  renderTicket();
};
$("#cobrarMixto").onclick=()=>{
  disableBotones(true)
  if(!ticketListo()) return;
  abrirMixto();
};


$("#descuento").onchange=e=>{
  const v=e.target.value;
  if(v===""){ descPct=0; descNombre=null; }
  else { const d=DESCUENTOS[parseInt(v)]; descPct=d.porcentaje; descNombre=d.nombre; }
  renderTicket();
};

let compActual=null;
let compEsDeOtroDia=false;   // el servicio en curso es de un día anterior (no se imprime)

/* ---- Servicio de otro día ----

   Cuando se olvidan de cargar algo, se anota con la fecha en que se hizo: así
   la venta y la plata caen en la caja de ESE día, que es donde tienen que
   estar. El comprobante guarda además cuándo se lo cargó, y con eso el papel
   puede decir "anotado el 30/8" sin mentir sobre el día que se atendió.

   Un servicio de otro día NO se imprime: el cliente ya se fue. */
function fechaHoyLocal(){
  // el input date quiere AAAA-MM-DD en hora local, no el ISO en UTC
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

// La fecha elegida, o null si es hoy (que es lo mismo que no mandar nada).
function fechaElegida(){
  const v = $("#fechaServicio").value;
  return (v && v !== fechaHoyLocal()) ? v : null;
}
const esDeOtroDia = () => fechaElegida() !== null;

function pintarOtroDia(){
  const f = fechaElegida();
  $("#otroDiaBox").classList.toggle("activo", !!f);
  const nota = $("#notaOtroDia");
  nota.style.display = f ? "" : "none";
  if(f){
    const [a,m,d] = f.split("-");
    nota.textContent = `Se va a anotar como servicio del ${Number(d)}/${Number(m)}/${a}. `
                     + `Entra en la caja de ese día y no se imprime.`;
    $("#otroDiaBox").open = true;   // si quedó una fecha vieja, que se vea
  }
  actualizarAcciones();
}

$("#fechaServicio").onchange = () => { pintarOtroDia(); guardarBorrador(); };
$("#btnHoy").onclick = () => { $("#fechaServicio").value = fechaHoyLocal(); pintarOtroDia(); guardarBorrador(); };

/* ---- Impresión ----

   Antes había que crear el comprobante, encontrar el botón de imprimir y
   tocarlo. Ahora sale solo al terminar de cobrar: el papel se arma con el
   MISMO generador que usa la pantalla de impresión (/static/escpos.js), así
   que lo que sale al cobrar y lo que sale al reimprimir son idénticos.

   Se llama SIEMPRE después de limpiar la pantalla. El esquema rawbt: es una
   navegación: si el celular no tiene RawBT instalado, se va de la página. Con
   el ticket ya guardado y la pantalla limpia, eso no cuesta nada; al revés,
   costaría el borrador. */
async function imprimirComprobante(id){
  try{
    const r = await authFetch("/api/comprobantes/"+id);
    if(!r.ok) throw new Error("no se pudo leer el comprobante");
    const comp = await r.json();
    location.href = EscPos.urlRawbt(EscPos.deComprobante(comp, NEGOCIO));
  }catch(e){
    // Que falle la impresión no puede tapar que el cobro sí salió: se avisa y
    // queda el botón de arriba para mandarlo a mano.
    toast("Cobrado, pero no se pudo imprimir — usá el botón de imprimir");
  }
}

// Valida el cliente (obligatorio) y crea el comprobante. Devuelve el objeto creado o null.
async function crearComprobante(){
  const nom=$("#cliente").value.trim();
  if(!nom){ toast("Falta el nombre del cliente"); $("#cliente").focus(); return null; }
 let cliId = clienteIdSel;                     // lo que elegiste del dropdown (o null)

  // Si no elegiste del dropdown, resolvemos por nombre: match exacto, o crear con confirmación.
  if(!cliId){
    const match = CLIENTES.find(c=>c.nombre.toLowerCase()===nom.toLowerCase());
    if(match){
      cliId = match.id;
    } else {
      if(!confirm(`"${nom}" no está en tu lista de clientes. ¿Crearlo como cliente nuevo?`)){
        toast("Revisá el nombre del cliente");
        return null;
      }
      const rc=await authFetch("/api/clientes",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({nombre:nom})});
      if(!rc.ok){ toast("No se pudo crear el cliente"); return null; }
      const nuevo=await rc.json();
      cliId = nuevo.id;
      CLIENTES.push({id:nuevo.id, nombre:nom});
    }
  }
  const body={
    tipo,
    cliente_id: cliId,
    cliente_nombre: null,
    peluquero: $("#peluquero").value.trim() || null,
    forma_pago: formaPago,
    descuento_pct: descPct,
    descuento_nombre: descNombre,
    mostrar_motivo: true,
    fecha: fechaElegida(),
    lineas: ticket.map(l=>({item_id:l.item_id, nombre: l.nombre, cantidad:l.cantidad,
                            precio_custom: l.precioEditado ? l.precio : null,
                            ajuste_pct: l.ajustePct || 0, ajuste_monto: l.ajusteMonto || 0,
                            ajuste_nombre: l.ajusteNombre || null})),
    extras: EXTRAS
  };
  const r=await authFetch("/api/comprobantes",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(!r.ok){
    // El backend rechaza fechas futuras o demasiado viejas: conviene decir cuál
    // fue el motivo y no un "no se pudo" que no explica nada.
    let motivo = "No se pudo crear";
    try{ motivo = (await r.json()).detail || motivo; }catch(e){}
    toast(motivo);
    return null;
  }
  const d=await r.json();
  const pref = d.tipo==="ticket" ? "N-" : "P-";
  toast(`${d.tipo} ${pref}${String(d.numero).padStart(5,"0")} creado`);
  // dejar a mano el botón para imprimir el comprobante recién creado
  const pu=$("#printUltimo");
  pu.href="/ticket?id="+d.id;
  pu.textContent=`🖨️ Imprimir ${pref}${String(d.numero).padStart(5,"0")}`;
  pu.style.display="block";
  return d;
}


// ---- Buscador de clientes (dropdown propio; guarda el id elegido) ----
let clienteIdSel = null;                        // id del cliente elegido, o null si el nombre es nuevo
const cliInput = $("#cliente"), cliDrop = $("#cliDrop");
let cliTimer;

cliInput.addEventListener("input", ()=>{
  clienteIdSel = null;                          // al tipear se invalida cualquier selección previa
  mostrarNotaCliente("");                       // y la nota deja de corresponder
  const term = cliInput.value.trim();
  clearTimeout(cliTimer);
  if(!term){ cliDrop.style.display="none"; return; }
  cliTimer = setTimeout(async ()=>{             // debounce: espera 200ms a que dejes de tipear
    const res = await (await authFetch("/api/clientes?q="+encodeURIComponent(term))).json();
    if(!res.length){ cliDrop.style.display="none"; return; }
    cliDrop.innerHTML = res.slice(0,8).map(c=>{
      // La nota se muestra al elegir, en un renglón propio y apagado: sirve para
      // reconocer al cliente ("mamá de Sofía") sin taparle el nombre.
      const nota = (c.notas||"").trim();
      return `<div class="cli-opt" data-id="${c.id}" data-nom="${esc(c.nombre)}"${nota?` data-nota="${esc(nota)}"`:""}>
        <b>${esc(c.nombre)}</b> <span class="muted">#${c.id}${c.telefono? ' · '+esc(c.telefono) : ''}</span>
        ${nota ? `<span class="cli-nota">${esc(nota)}</span>` : ""}
      </div>`;
    }).join("");
    cliDrop.style.display="block";
  }, 200);
});

cliDrop.addEventListener("click", e=>{          // elegir una opción → guarda el id
  const opt = e.target.closest(".cli-opt"); if(!opt) return;
  clienteIdSel = parseInt(opt.dataset.id);
  cliInput.value = opt.dataset.nom;
  cliDrop.style.display = "none";
  mostrarNotaCliente(opt.dataset.nota || "");
});

/* La nota del cliente elegido queda a la vista mientras se arma el ticket, en
   un renglón chico debajo del campo. No es un cartel ni bloquea nada: si
   decía algo importante ("no le gusta el secado"), está ahí. */
function mostrarNotaCliente(nota){
  const caja = $("#notaCliente");
  if(!caja) return;
  caja.textContent = nota;
  caja.style.display = nota ? "" : "none";
}

document.addEventListener("click", e=>{         // cerrar si clickeás afuera
  if(!cliInput.contains(e.target) && !cliDrop.contains(e.target)) cliDrop.style.display="none";
});

$("#cobrarTodo").onclick=async()=>{
  disableBotones(true);
  const otroDia = esDeOtroDia();
  const d=await crearComprobante();
  if(!d){ renderTicket(); return; }
  const c=await (await authFetch("/api/comprobantes/"+d.id)).json();

  const forma = formaPago==="efectivo" ? "Efectivo" : "Transferencia";
  const monto = c.saldo;            // el total ya trae el descuento: se salda 1:1

  const r=await authFetch("/api/comprobantes/"+d.id+"/pagos",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({monto, saldado:monto, forma_pago:forma, alias:null, del_servicio:true})});
  if(r.ok){ toast("Cobrado ✓"); } else { toast("Se creó, pero el cobro falló — cobralo desde la cuenta"); }
  limpiar();
  if(r.ok && !otroDia) imprimirComprobante(d.id);
};

// Cobrar una parte: NO crea nada todavía; el comprobante se crea en el primer pago.
$("#cobrarParte").onclick=async()=>{
  disableBotones(true);
  compEsDeOtroDia = esDeOtroDia();    // se recuerda: al finalizar decide si imprime
  const d=await crearComprobante();
  if(!d){ renderTicket(); return; }
  compActual=d.id; abrirCobro();     // ← esta línea es la que setea compActual
};

// Dejar a cuenta: crea el comprobante sin ningún pago. Queda pendiente en la cuenta.
$("#dejarCuenta").onclick=async()=>{
  if(!ticketListo()) return;
  disableBotones(true);
  const otroDia = esDeOtroDia();
  const nom=$("#cliente").value.trim();
  const d=await crearComprobante();
  if(!d){ renderTicket(); return; }
  toast("Queda a cuenta de "+nom);
  limpiar();
  // Se imprime igual: el papel dice PENDIENTE y es el respaldo de lo que debe.
  if(!otroDia) imprimirComprobante(d.id);
};

$("#crearPresu").onclick=async()=>{
  disableBotones(true);
  const otroDia = esDeOtroDia();
  const d=await crearComprobante();
  if(!d){ renderTicket(); return; }
  limpiar();
  // El presupuesto también sale solo: es justamente el papel que se lleva el
  // cliente para pensarlo.
  if(!otroDia) imprimirComprobante(d.id);
};

function limpiar(){
  // La fecha vuelve a hoy sí o sí. Si quedara pegada, el servicio siguiente se
  // cargaría sin querer en el día viejo y a nadie se le ocurriría mirar ahí.
  ticket=[]; $("#cliente").value=""; clienteIdSel=null; $("#peluquero").value="";
  $("#fechaServicio").value=""; compEsDeOtroDia=false; $("#otroDiaBox").open=false; pintarOtroDia();
  $("#descuento").value=""; descPct=0; descNombre=null;
  $("#aliasTransfer").value="";
  EXTRAS=[]; renderExtras(); $("#extrasBox").open=false;
  $("#panelCobro").style.display="none"; compActual=null;
  localStorage.removeItem(BORRADOR_KEY);
  renderTicket();
}

async function abrirCobro(){
  let saldo, total, pagos, titulo;
  const esEf = formaPago==="efectivo";
  if(compActual){
    const c=await (await authFetch("/api/comprobantes/"+compActual)).json();
    const totalEf = totalEfectivoComp(c);            // deuda total en efectivo, lista real
    // el saldo en efectivo = total efectivo menos lo ya saldado, proporcional
    total = esEf ? totalEf : c.total_final;
    saldo = esEf ? Math.max(totalEf - c.pagos.reduce((a,p)=>a+p.monto,0), 0) : c.saldo;
    pagos = c.pagos;
    titulo = c.cliente_nombre || $("#cliente").value.trim() || "Cliente";
  } else {
    saldo=totalActual; total=totalActual; pagos=[];  // totalActual ya está en efectivo
    titulo=$("#cliente").value.trim() || "Cliente";
  }
  $("#panelCobro").style.display="block";
  $("#cobroTitulo").textContent="Cobrar — "+titulo;
  $("#cobroTotal").textContent=fmt(total);
  $("#cobroSaldo").textContent=fmt(saldo);
  $("#cobroMonto").value=saldo>0 ? saldo : "";
  const ab=$("#cobroAbonos");
  ab.innerHTML = pagos.length ? pagos.map(p=>`<div class="muted">✓ ${p.forma_pago} ${fmt(p.monto)}</div>`).join("") : "";
  $("#cobroCerrar").textContent = saldo<=0 ? "Finalizar servicio" : "Finalizar (dejar saldo pendiente)";
  if(saldo<=0){  
    ab.innerHTML += '<div style="color:var(--acento);font-weight:700;margin-top:6px;">Saldado ✓</div>';
    $("#cobroRegistrar").style.display="none";
  } else { $("#cobroRegistrar").style.display="block"; }
  $("#cobroForma").value = formaPago==="efectivo" ? "Efectivo" : "Transferencia";
  $("#cobroForma").disabled = true;   // el panel no elige forma: la hereda del ticket
  $("#cobroAliasBox").style.display = (formaPago==="transfer") ? "flex" : "none";
  if(formaPago==="transfer") $("#cobroAlias").value = $("#aliasTransfer").value.trim();
  actualizarAcciones();   // bloquea los botones de arriba mientras hay cobro en curso
}

/* Total efectivo REAL de un comprobante.

   Tiene que dar exactamente lo mismo que estado_comprobante() en el backend, o
   el panel de cobro pide una plata distinta de la que el servidor va a aceptar.
   Dos cosas que hay que respetar y antes no se respetaban:
     - se usa precio_efectivo_final, que ya trae el ajuste de la línea; con
       precio_efectivo pelado, un ítem con "−10%" se cobraba sin el descuento;
     - los extras se suman al final, DESPUÉS del descuento, igual que allá; sin
       eso, un ticket con un extra cargado mostraba de menos. */
function totalEfectivoComp(c){
  const base = c.lineas.reduce((a,l)=>a + (l.precio_efectivo_final ?? l.precio_efectivo)*l.cantidad, 0)
             + (c.extra_dificultad||0);          // el extra solo existe en comprobantes viejos
  const desc = Math.round(base * (c.descuento_pct||0) / 100);
  const extras = (c.extras||[]).reduce((a,e)=>a+(e.monto||0), 0);
  return base - desc + extras;
}

async function abrirMixto(){
  mxDeudaActual = totalActual;                 // deuda a precio transfer, tomada de la pantalla
  $("#mxDeuda").textContent = fmt(totalActual);
  $("#mxEfectivo").value = "";
  $("#mxAlias").value = "";
  $("#mxResumen").style.display = "none";
  $("#mxAviso").style.display = "none";
  $("#mxRegistrar").disabled = true;
  $("#panelMixto").style.display = "block";
}

$("#cobroForma").onchange=()=>{
  $("#cobroAliasBox").style.display = ($("#cobroForma").value==="Transferencia") ? "flex" : "none";
};

function calcularMixto(){
  const D = mxDeudaActual;                          
  const E = parseInt($("#mxEfectivo").value)||0;    
  const aviso = $("#mxAviso");
  const efvoBruto =  Math.ceil((E / 0.9) / 100) * 100;  // Deuda cubierta

  let error = "";
  if(E <= 0)              error = "Poné cuánto paga en efectivo.";
  else if(efvoBruto >= D) error = `El efectivo cubre toda la deuda — usá cobro en efectivo, no mixto.`;

  if(error){
    aviso.textContent = error;
    aviso.style.display = "block";
    $("#mxResumen").style.display = "none";
    $("#mxRegistrar").disabled = true;
    return null;
  }

  aviso.style.display = "none";
  $("#mxResumen").style.display = "block";

  const T    = D - efvoBruto;                        // lo que queda va por transferencia
  const desc = efvoBruto - E;                        // descuento = deuda cubierta − plata real
  const totalCobrar = T + E;
  const pct  = Math.round(desc / efvoBruto * 100); 

  $("#mxMonEfvoReal").textContent  = fmt(E);
  $("#mxSubEfvo").textContent     = `equivale a ${fmt(efvoBruto)} de deuda (−${pct}%)`;
  $("#mxMonTransfer").textContent  = fmt(T);
  $("#mxTotal").textContent        = fmt(totalCobrar);

  $("#mxRegistrar").disabled = false;
  return { D, T, efvoBruto, E, desc };               
}


$("#mxEfectivo").oninput = calcularMixto;

$("#mxRegistrar").onclick=async()=>{
  $("#mxRegistrar").disabled = true;                 // evitar doble click y duplicados
  const E = parseInt($("#mxEfectivo").value)||0;     
  const alias = $("#mxAlias").value.trim() || null;

  const otroDia = esDeOtroDia();
  const d = await crearComprobante();
  if(!d){ $("#mxRegistrar").disabled=false; return; }


  const c = await (await authFetch("/api/comprobantes/"+d.id)).json();
  const D = c.saldo;
  let efvoBruto = Math.ceil((E / 0.9) / 100) * 100;  
  efvoBruto = Math.min(efvoBruto, D);                // nunca más que la deuda real
  const T = D - efvoBruto;                            

  // Pago 1: transferencia 
  if(T > 0){
    const r1 = await authFetch("/api/comprobantes/"+d.id+"/pagos",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ monto:T, saldado:T, forma_pago:"Transferencia", alias, del_servicio:true })});
    if(!r1.ok){ toast("Falló la parte transferencia — quedó a cuenta"); $("#panelMixto").style.display="none"; limpiar(); return; }
  }

  // Pago 2: efectivo (monto = plata real; saldado = deuda que cubre)
  const r2 = await authFetch("/api/comprobantes/"+d.id+"/pagos",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({ monto:E, saldado:efvoBruto, forma_pago:"Efectivo", alias:null, del_servicio:true })});
  toast(r2.ok ? "Pago mixto registrado ✓" : "Falló la parte efectivo — quedó saldo a cuenta");

  $("#panelMixto").style.display="none";
  limpiar();
  if(!otroDia) imprimirComprobante(d.id);
};



$("#cobroRegistrar").onclick=async()=>{
  const saldado=parseInt($("#cobroMonto").value)||0;
  if(saldado<=0){ toast("Poné un monto válido"); return; }
  const forma=$("#cobroForma").value;
  const body={ monto:saldado, saldado, forma_pago:forma,      // 1:1
               alias: (forma==="Transferencia") ? ($("#cobroAlias").value.trim()||null) : null,
               del_servicio: true };
  const r=await authFetch("/api/comprobantes/"+compActual+"/pagos",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  if(!r.ok){ const e=await r.json(); toast(e.detail||"No se pudo"); return; }
  const est=await r.json();
  toast(est.saldo<=0 ? "Ticket saldado ✓" : "Pago registrado");
  abrirCobro();
};

/* "Finalizar" cierra el cobro parcial. Se imprime acá y no en cada abono:
   el papel tiene que salir una sola vez y con todos los pagos ya anotados. */
$("#cobroCerrar").onclick=()=>{
  const id = compActual, otroDia = compEsDeOtroDia;
  limpiar();
  if(id && !otroDia) imprimirComprobante(id);
};

/* ---- Ticket a medio cargar ----

   Antes acá había dos carteles: el de beforeunload (el del navegador, que no se
   puede redactar ni sacar con el check de "evitar cuadros de diálogo") y un
   confirm propio al tocar un link. Los dos preguntaban por una pérdida que no
   pasa: el borrador se guarda solo en cada cambio y se restaura al volver.

   Un cartel que interrumpe para avisar algo que ya está resuelto es puro
   ruido, y encima había que contestarlo dos veces. Se reemplaza por un aviso
   que no pide nada: una marca en la pantalla y otra en el menú, que se ven
   desde cualquier lado y desaparecen solas al cobrar. */
function hayTicketSinCobrar(){
  return ticket.length > 0 || EXTRAS.length > 0;
}

/* La marca de borrador, arriba del ticket. Se actualiza sola porque
   actualizarTotales() corre en cada cambio. */
function pintarAvisoBorrador(){
  const caja = $("#avisoBorrador");
  if(!caja) return;
  const n = ticket.length;
  caja.style.display = hayTicketSinCobrar() ? "" : "none";
  caja.textContent = n
    ? `Borrador guardado · ${n} ${n===1?"ítem":"ítems"} sin cobrar`
    : "Borrador guardado";
  // y que el menú lo muestre en todas las pantallas
  if(window.marcarBorradorEnMenu) window.marcarBorradorEnMenu();
}

init();
