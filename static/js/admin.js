/* Admin ya no es una pantalla de dueña.

   El empleado entra y maneja las listas con las que factura todos los días
   —catálogo, formas de pago, tipos de egreso, descuentos, ajustes por ítem y
   alias—, que es la parte que se desactualiza sola y por la que había que
   esperar a que la dueña se sentara. Lo que no ve ni de casualidad son los
   usuarios y el backup: eso se saca del documento con ajustarPorRol(), y el
   backend lo rebota igual si alguien prueba el endpoint a mano. */
requireLogin(); pintarNav(); ajustarPorRol();
const DUENO = esDueno();
const $=s=>document.querySelector(s);
const fmt=n=>"$"+(n||0).toLocaleString("es-AR");
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let catActual=null;
let ITEMS_ALL=[];
/* El porcentaje general de comisión, el que rige cuando el ítem no tiene el
   suyo. Se muestra como sugerencia en la ficha para que se vea contra qué se
   está eligiendo; el que manda es el del servidor. */
let COMISION_GENERAL = 40;
/* El mismo mínimo que pide el servidor. Se chequea acá para avisar antes de
   mandar, no en lugar de allá: el que frena de verdad es el backend. */
const LARGO_MINIMO_PASS = 8;
/* Dos modos para la misma lista.

   Leyendo, que es como se entra casi siempre —a mirar un precio—, la fila no
   tiene ni un casillero abierto: un campo abierto invita a escribir, y un precio
   cambiado sin querer se cobra.

   Editando, que es cuando hay que actualizar precios y son veinte de una
   sentada, se abren todos juntos como estaban antes. Ir de a uno ahí es abrir y
   cerrar veinte paneles. */
let modoEdicion=false;

function toast(m){const t=$("#toast");t.textContent=m;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2200);}

// El general vive en config y lo edita la dueña desde Sueldos; acá se lee para
// mostrarlo como referencia en la ficha del ítem.
authFetch("/api/config").then(r=>r.json()).then(c=>{
  if(c && c.comision_pct != null) COMISION_GENERAL = c.comision_pct;
}).catch(()=>{});

async function cargarCats(){
  const cats=await (await authFetch("/api/categorias")).json();
  $("#selCat").innerHTML=cats.map(c=>`<option>${c}</option>`).join("");
  $("#cats").innerHTML=cats.map(c=>`<option value="${c}">`).join("");
  // Se respeta la categoría que se estaba mirando. Sin esto, guardar un precio
  // devolvía la lista a la primera categoría del abecedario y había que volver a
  // buscar dónde estabas para tocar el ítem de al lado.
  if(catActual && cats.includes(catActual)) $("#selCat").value=catActual;
  catActual=$("#selCat").value;
  ITEMS_ALL=await (await authFetch("/api/items/all")).json();
  filtrarItems();
}

$("#selCat").onchange=()=>{catActual=$("#selCat").value;$("#buscarItem").value="";filtrarItems();};
$("#buscarItem").oninput=filtrarItems;

/* El filtro de comisión y el buscador son lo mismo: los dos dejan de mirar una
   categoría y pasan a mirar el catálogo entero. Por eso están en la misma
   función y se pueden usar juntos ("de los que van a comisión, los que dicen
   color"). */
$("#soloComision").onclick=()=>{
  $("#soloComision").classList.toggle("on");
  filtrarItems();
};

function filtrarItems(){
  const q=$("#buscarItem").value.trim().toLowerCase();
  const soloCom=$("#soloComision").classList.contains("on");
  const cuenta=$("#cuentaComision");
  if(!q && !soloCom){ cuenta.textContent=""; cargarItems(); return; }
  // Con el buscador o el filtro prendidos se sale de la categoría y se mira el
  // catálogo entero: buscar dentro de una sola es justo lo que no sirve cuando
  // no te acordás en cuál lo pusiste.
  let f=ITEMS_ALL;
  if(soloCom) f=f.filter(i=>i.es_comision);
  if(q) f=f.filter(i=>i.nombre.toLowerCase().includes(q));
  cuenta.textContent = soloCom
    ? `${f.length} ${f.length===1?"ítem":"ítems"} en ${new Set(f.map(i=>i.categoria)).size} ${new Set(f.map(i=>i.categoria)).size===1?"categoría":"categorías"}`
    : "";
  renderItems(f, true);
}

async function cargarItems(){
  const items=await (await authFetch("/api/items?categoria="+encodeURIComponent(catActual))).json();
  renderItems(items, false);
}

/* El catálogo se dibuja igual que en facturar: el rail de categorías al costado
   y los ítems en tarjetas. Es la misma lista y se busca de la misma manera, así
   que se ve igual; lo único que cambia es qué pasa al tocar uno —allá se agrega
   al ticket, acá se abre para editar—.

   Para LEER y no para editar: la tarjeta no tiene ni un casillero abierto. Antes
   cada renglón tenía el nombre y el precio habilitados, con Guardar y Eliminar
   al lado: cuarenta campos abiertos en una pantalla a la que casi siempre se
   entra a mirar un precio. Y un campo abierto invita a escribir, que en un
   precio se cobra. */
function renderItems(items, mostrarCat){
  const cont=$("#listaItems");
  cerrarPaneles();
  pintarRail();
  if(modoEdicion){ cont.className=""; cont.innerHTML=""; renderItemsEditables(items, mostrarCat); return; }
  cont.className="grid-items";
  if(items.length===0){ cont.className=""; cont.innerHTML='<p class="muted">Sin ítems para mostrar.</p>'; return; }
  cont.innerHTML="";
  items.forEach(it=>{
    const b=document.createElement("button");
    b.type="button"; b.className="btn-item";
    const marcas=[];
    if(mostrarCat) marcas.push(`<span class="cat-mini">${esc(it.categoria)}</span>`);
    if(it.es_producto) marcas.push(`<span class="tag">prod</span>`);
    if(it.es_comision) marcas.push(`<span class="tag">comisión</span>`);
    b.innerHTML = `<span class="n">${esc(it.nombre)}</span>
      <span class="precios">
        <span class="p-tr">${fmt(it.precio)}</span>
        <span class="p-ef">transf ${fmt(it.precio_transfer||0)}</span>
      </span>
      ${marcas.length ? `<span class="marcas-item">${marcas.join("")}</span>` : ""}`;
    cont.appendChild(b);

    // Un solo panel abierto por vez, y debajo de la grilla entera: metido
    // adentro de una tarjeta rompería la grilla, y al lado dejaría la mitad de
    // los campos fuera de la pantalla en la tablet.
    b.onclick=()=>{
      const abierto = $("#catalogo .panel-edicion");
      const mismo = abierto && abierto.dataset.item === String(it.id);
      cerrarPaneles();
      if(mismo) return;                        // el mismo ítem cierra lo que abrió
      const pan = fichaItem(it);
      pan.dataset.item = it.id;
      cont.after(pan);
      b.classList.add("abierto");
    };
  });
}

/* El rail de categorías. "Todas" primero, y cada una con cuántos ítems tiene:
   sirve para encontrar la que quedó con dos y darse cuenta de que sobra. */
function pintarRail(){
  const rail=$("#catRail");
  if(!rail) return;
  const cuentas=new Map();
  ITEMS_ALL.forEach(i=>cuentas.set(i.categoria,(cuentas.get(i.categoria)||0)+1));
  const buscando = $("#buscarItem").value.trim() || $("#soloComision").classList.contains("on");
  rail.innerHTML="";
  const agregar=(nombre, etiqueta, cuenta, activa)=>{
    const b=document.createElement("button");
    b.type="button"; b.className="cat-pill" + (activa ? " on" : "");
    b.innerHTML=`<span class="nom">${esc(etiqueta)}</span><span class="cuenta">${cuenta}</span>`;
    b.onclick=()=>{
      $("#buscarItem").value="";
      $("#soloComision").classList.remove("on");
      if(nombre) { catActual = nombre; $("#selCat").value = nombre; }
      filtrarItems();
    };
    rail.appendChild(b);
  };
  agregar(null, "Todas", ITEMS_ALL.length, buscando);
  [...cuentas.keys()].sort().forEach(c =>
    agregar(c, c, cuentas.get(c), !buscando && c === catActual));
}

/* La lista entera abierta: nombre, precio y comisión de cada ítem.

   Se guarda con un solo botón al final, no con uno por renglón: la razón de
   estar acá es cambiar varios, y veinte Guardar es veinte viajes al servidor y
   veinte chances de dejar uno sin apretar. Lo que se tocó queda marcado hasta
   que se guarda, porque mirando la lista ya no se puede saber qué está en la
   base y qué está solo tipeado.

   Eliminar y la categoría no están acá: van en el panel de Editar, de a uno.
   Borrar un ítem entre veinte casilleros abiertos se aprieta sin mirar. */
function renderItemsEditables(items, mostrarCat){
  const cont=$("#listaItems");
  items.forEach(it=>{
    const row=document.createElement("div"); row.className="item-row";
    const cat = mostrarCat ? `<span class="tag neutro">${esc(it.categoria)}</span>` : "";
    // Si este ítem ya venía tocado desde otra categoría, se muestra como quedó y
    // no como está en la base: el cambio sigue pendiente hasta que se guarde.
    const pend = CAMBIOS.get(it.id);
    const v = pend || {nombre:it.nombre, precio:it.precio, es_comision:!!it.es_comision,
                       comision_pct:it.comision_pct};
    /* El porcentaje se edita acá adentro, al lado de la marca de comisión. Es la
       razón principal para entrar a este modo: prendés el filtro de comisión,
       entrás a editar y quedan todos los porcentajes del catálogo uno abajo del
       otro. De a un ítem por vez, cambiar diez es abrir y cerrar diez fichas. */
    row.innerHTML=`
      <input class="n" value="${esc(v.nombre)}" aria-label="Nombre">
      <input class="p" type="number" min="0" value="${v.precio}" aria-label="Precio efectivo">
      <span class="meta">
        <span class="transf" style="white-space:nowrap;">→ transf ${fmt(it.precio_transfer||0)}</span>
        ${cat}${it.es_producto?'<span class="tag">prod</span>':''}
        <label class="chk-com" title="La empleada que lo haga cobra comisión por este trabajo">
          <input type="checkbox" class="com" ${v.es_comision?"checked":""}> comisión
        </label>
        <span class="pct-fila"${v.es_comision?"":" hidden"}>
          <input type="number" class="pct" min="0" max="100" inputmode="numeric"
                 value="${v.comision_pct ?? ""}" placeholder="${COMISION_GENERAL}"
                 aria-label="Porcentaje de comisión"><span class="u">%</span>
        </span>
      </span>
      <span class="acc"></span>`;
    const leerPct=()=>{
      const t=row.querySelector(".pct").value.trim();
      // "" = sin porcentaje propio. Se guarda como null y el ítem usa el general.
      return t === "" ? null : Math.max(0, Math.min(100, parseInt(t,10) || 0));
    };
    const leer=()=>({nombre:row.querySelector(".n").value.trim(),
                     precio:parseInt(row.querySelector(".p").value,10),
                     es_comision:row.querySelector(".com").checked,
                     comision_pct:leerPct()});
    const original=JSON.stringify({nombre:it.nombre, precio:it.precio,
                                   es_comision:!!it.es_comision,
                                   comision_pct:it.comision_pct ?? null});
    const marcar=()=>{
      const ahora=leer();
      const sucia = JSON.stringify(ahora)!==original;
      /* Lo tocado vive en CAMBIOS y no en la fila. La fila se destruye al
         cambiar de categoría —se redibuja la lista entera— y con ella se perdía
         lo tipeado: había que acordarse de guardar antes de moverse, o se perdía
         sin aviso. Así se pueden recorrer todas las categorías y guardar una vez
         al final. */
      if(sucia) CAMBIOS.set(it.id, {...ahora, categoria:it.categoria, nombreViejo:it.nombre});
      else CAMBIOS.delete(it.id);
      row.classList.toggle("sucia", sucia);
      // El de transferencia lo calcula el servidor al guardar. Mientras el
      // precio está tocado, el que se ve al lado es el viejo: mostrarlo pegado a
      // un efectivo nuevo se lee como si fueran los dos de ahora. Y calcularlo
      // acá sería tener la cuenta de la plata escrita en dos lugares.
      row.querySelector(".transf").textContent = sucia
        ? "→ transf: se calcula al guardar"
        : `→ transf ${fmt(it.precio_transfer||0)}`;
      // El casillero del porcentaje sigue a la marca: sin comisión no significa
      // nada, y vacío quiere decir "usa el general".
      row.querySelector(".pct-fila").hidden = !row.querySelector(".com").checked;
      pintarBarra();
    };
    row.querySelectorAll("input").forEach(el=>{
      el.addEventListener("input", marcar); el.addEventListener("change", marcar);
    });
    if(pend) row.classList.add("sucia");
    cont.appendChild(row);
  });

  /* El botón se crea UNA vez y después solo se le cambia el texto.

     Redibujando la barra entera en cada tecla, el click se perdía: al apretar
     Guardar, el casillero pierde el foco y dispara su `change`, eso rehacía la
     barra, y el botón desaparecía entre el mousedown y el mouseup. El navegador
     entonces no manda ningún click y no pasa nada — había que apretar dos veces
     para que guardara. */
  const barra=document.createElement("div");
  barra.className="barra-guardar";
  const btn=Object.assign(document.createElement("button"),
                          {className:"b-ok", type:"button", id:"btnGuardarTodos"});
  const nota=Object.assign(document.createElement("span"), {className:"muted"});
  btn.onclick=guardarTodos;
  barra.append(btn, nota);
  cont.appendChild(barra);
  pintarBarra();
}

/* Lo tocado en el modo edición, de TODAS las categorías, hasta que se guarda.
   Clave: el id del ítem. */
const CAMBIOS = new Map();

function pintarBarra(){
  const btn=$("#btnGuardarTodos"), nota=btn && btn.nextElementSibling;
  if(!btn) return;
  const n = CAMBIOS.size;
  const cats = new Set([...CAMBIOS.values()].map(c=>c.categoria)).size;
  btn.style.display = n ? "" : "none";
  btn.textContent = `Guardar ${n} ${n===1?"cambio":"cambios"}`;
  nota.textContent = n
    ? (cats > 1 ? `Sin guardar todavía · ${cats} categorías tocadas` : "Sin guardar todavía.")
    : "Tocá los precios o los nombres que haya que cambiar y guardalos todos juntos. Podés moverte entre categorías: los cambios se acumulan.";
}

/* Se guarda TODO lo tocado, esté o no en la categoría que se está viendo. La
   razón de estar en este modo es cambiar varios, y ahí "varios" cruza
   categorías: los precios suben para todo el catálogo, no para una sola. */
async function guardarTodos(){
  const pendientes = [...CAMBIOS.entries()];
  const malos = [];
  for(const [id, v] of pendientes){
    if(!v.nombre || !(v.precio > 0)){ malos.push(`${v.nombreViejo} (nombre o precio vacío)`); continue; }
    const r = await authFetch(`/api/items/${id}`, {method:"PUT",
      headers:{"Content-Type":"application/json"},
      // -1 es "sacale el propio y que use el general"; null sería "no lo toques".
      body: JSON.stringify({nombre:v.nombre, precio:v.precio, es_comision:v.es_comision,
                            comision_pct: v.comision_pct == null ? -1 : v.comision_pct})});
    if(r.ok) CAMBIOS.delete(id); else malos.push(v.nombreViejo);
  }
  if(malos.length) toast("No se pudieron guardar: " + malos.join(", "));
  else toast(`${pendientes.length} ${pendientes.length===1?"ítem guardado":"ítems guardados"}`);
  ITEMS_ALL = await (await authFetch("/api/items/all")).json();
  await cargarCats();          // redibuja con los precios de transferencia nuevos
}

/* El atajo a los porcentajes: prende el filtro de comisión y el modo edición
   juntos, que es lo que hay que combinar para ver todos los porcentajes del
   catálogo uno abajo del otro. Separados, había que saber que se usaban así. */
$("#btnComisiones").onclick = () => {
  $("#buscarItem").value = "";
  $("#soloComision").classList.add("on");
  if(!modoEdicion) $("#btnEditarTodos").click();
  else filtrarItems();
};

/* El botón que cambia de modo. Al apagarlo se redibuja de cero: si quedó algo
   tipeado sin guardar, la lista vuelve a mostrar lo que está en la base y no lo
   que se había escrito, que es lo que corresponde ver cuando se está leyendo. */
$("#btnEditarTodos").onclick=async()=>{
  const pendientes=CAMBIOS.size;
  if(modoEdicion && pendientes &&
     !confirm(`Hay ${pendientes} ${pendientes===1?"cambio":"cambios"} sin guardar.\n\n¿Salir igual y perderlos?`)) return;
  CAMBIOS.clear();
  modoEdicion=!modoEdicion;
  const b=$("#btnEditarTodos");
  b.textContent = modoEdicion ? "✓ Listo" : "✏️ Editar todos";
  b.className = modoEdicion ? "b-tinta" : "b-out";
  $("#panelNuevoItem").innerHTML="";
  cerrarPaneles();
  filtrarItems();
};

// Uno solo abierto en toda la tarjeta, el de crear incluido.
function cerrarPaneles(){
  document.querySelectorAll("#catalogo .panel-edicion, #listaItems ~ .ficha-item").forEach(p=>p.remove());
  document.querySelectorAll(".btn-item.abierto").forEach(b=>b.classList.remove("abierto"));
}

/* La ficha de un ítem: la misma para editar y para cargar uno nuevo.

   Todo junto y un solo Guardar. El precio y la marca de comisión son del mismo
   ítem, y con un botón por campo se guarda uno y se pierde el otro sin que nada
   avise.

   Las dos marcas son interruptores y no casillas sueltas: son dos preguntas de
   sí o no que cambian cómo se comporta el ítem al vender, no dos ajustes de un
   formulario. Y el porcentaje aparece recién cuando la comisión está prendida,
   porque hasta entonces no significa nada. */
function fichaItem(it){
  const nuevo = !it;
  const pan = document.createElement("div");
  pan.className = "ficha-item";
  pan.innerHTML = `
    <div class="ficha-cab">
      <h3>${nuevo ? "Ítem nuevo" : "Editar ítem"}</h3>
      <button type="button" class="cerrar" aria-label="Cerrar">✕</button>
    </div>
    <div class="ficha-campos">
      <div class="campo ancho"><label>Nombre</label>
        <input class="f-nombre" type="text" placeholder="Ej: Corte de puntas"></div>
      <div class="campo"><label>Precio en efectivo</label>
        <input class="f-precio" type="number" min="0" inputmode="numeric" placeholder="0"></div>
      <div class="campo"><label>Categoría</label>
        <input class="f-cat" list="cats" placeholder="existente o nueva"></div>
    </div>
    <div class="ficha-marcas">
      <button type="button" class="marca f-prod">
        <span class="tilde">✓</span> Es producto
        <span class="sub">descuenta stock al venderlo</span>
      </button>
      <button type="button" class="marca f-com">
        <span class="tilde">✓</span> Va a comisión
        <span class="sub">se le paga a quien lo haga</span>
      </button>
      <div class="campo pct" hidden><label>Su porcentaje</label>
        <div class="con-signo"><input class="f-pct" type="number" min="0" max="100" inputmode="numeric"
             placeholder="${COMISION_GENERAL}"><span>%</span></div></div>
    </div>
    <p class="ficha-pie">La categoría se escribe: nace con el primer ítem que la use y
      desaparece sola cuando se queda sin ninguno. El precio de transferencia se
      calcula al guardar.</p>
    <div class="ficha-acc">
      ${nuevo ? "" : `<button class="b-del borrar">Eliminar</button>`}
      <span class="separa"></span>
      <button class="b-out cancelar">Cancelar</button>
      <button class="b-ok guardar">${nuevo ? "Agregar" : "Guardar"}</button>
    </div>`;
  const $$ = s => pan.querySelector(s);

  $$(".f-nombre").value = it ? it.nombre : "";
  $$(".f-precio").value = it ? it.precio : "";
  $$(".f-cat").value    = it ? (it.categoria || catActual) : (catActual || "");
  const marcar = (b, on) => b.classList.toggle("on", !!on);
  marcar($$(".f-prod"), it && it.es_producto);
  marcar($$(".f-com"),  it && it.es_comision);
  if(it && it.comision_pct != null) $$(".f-pct").value = it.comision_pct;

  const verPct = () => { $$(".pct").hidden = !$$(".f-com").classList.contains("on"); };
  verPct();
  $$(".f-prod").onclick = () => $$(".f-prod").classList.toggle("on");
  $$(".f-com").onclick  = () => { $$(".f-com").classList.toggle("on"); verPct(); };

  const cerrar = () => { pan.remove(); document.querySelectorAll(".btn-item.abierto").forEach(b=>b.classList.remove("abierto")); };
  $$(".cerrar").onclick = cerrar;
  $$(".cancelar").onclick = cerrar;

  $$(".guardar").onclick = async () => {
    const nombre = $$(".f-nombre").value.trim();
    const precio = parseInt($$(".f-precio").value, 10);
    const categoria = $$(".f-cat").value.trim();
    if(!nombre){ toast("El nombre no puede quedar vacío"); return; }
    if(!(precio > 0)){ toast("El precio tiene que ser mayor a 0"); return; }
    if(!categoria){ toast("Falta la categoría"); return; }
    const pctTexto = $$(".f-pct").value.trim();
    const pct = parseInt(pctTexto, 10);
    if(pctTexto && (isNaN(pct) || pct < 0 || pct > 100)){ toast("La comisión va de 0 a 100"); return; }
    const cuerpo = {nombre, precio, categoria,
                    es_producto: $$(".f-prod").classList.contains("on"),
                    es_comision: $$(".f-com").classList.contains("on"),
                    // -1 es "sacale el propio y que use el general": mandar null
                    // sería "no toques este campo", que no es lo mismo.
                    comision_pct: pctTexto ? pct : -1};
    const r = nuevo
      ? await authFetch("/api/items", {method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({...cuerpo, comision_pct: pctTexto ? pct : null})})
      : await authFetch(`/api/items/${it.id}`, {method:"PUT", headers:{"Content-Type":"application/json"},
          body: JSON.stringify(cuerpo)});
    if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo guardar"); return; }
    toast(nuevo ? "Ítem agregado" : "Guardado");
    if(nuevo){ $("#panelNuevoItem").innerHTML = ""; catActual = categoria; $("#buscarItem").value = ""; }
    ITEMS_ALL = await (await authFetch("/api/items/all")).json();
    await cargarCats();
  };

  const borrar = $$(".borrar");
  if(borrar) borrar.onclick = async () => {
    if(!confirm(`¿Eliminar "${it.nombre}"?\n\nDeja de aparecer al facturar. Los tickets viejos que lo tienen no se tocan.`)) return;
    const r = await authFetch(`/api/items/${it.id}`, {method:"DELETE"});
    if(!r.ok){ toast("No se pudo eliminar"); return; }
    toast("Eliminado");
    ITEMS_ALL = await (await authFetch("/api/items/all")).json();
    await cargarCats();
  };

  pan.querySelectorAll("input").forEach(i => i.addEventListener("keydown", ev => {
    if(ev.key === "Enter") $$(".guardar").click();
    if(ev.key === "Escape") cerrar();
  }));
  setTimeout(() => $$(".f-nombre").focus(), 0);
  return pan;
}

/* Cargar uno nuevo: la misma ficha, vacía, colgada del botón de arriba en vez
   de una tarjeta. Un solo dibujante para las dos, así el día que se agregue un
   campo no queda pidiéndose solo al editar. */
$("#btnNuevoItem").onclick = () => {
  const caja = $("#panelNuevoItem");
  if(caja.firstChild){ caja.innerHTML = ""; return; }   // el mismo botón lo cierra
  cerrarPaneles();
  const ficha = fichaItem(null);
  ficha.classList.add("nueva");
  ficha.querySelector(".cancelar").onclick = () => { caja.innerHTML = ""; };
  ficha.querySelector(".cerrar").onclick   = () => { caja.innerHTML = ""; };
  caja.appendChild(ficha);
};

// Uno solo abierto en toda la tarjeta, el de crear incluido.
function cerrarPaneles(){
  document.querySelectorAll("#catalogo .panel-edicion, #listaItems ~ .ficha-item").forEach(p=>p.remove());
  document.querySelectorAll(".btn-item.abierto").forEach(b=>b.classList.remove("abierto"));
}

$("#btnRenombrar").onclick=async()=>{
  const nuevo=prompt(`Renombrar la categoría "${catActual}" a:`,catActual);
  if(!nuevo||nuevo.trim()===catActual)return;
  await authFetch("/api/categorias",{method:"PUT",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({viejo:catActual,nuevo:nuevo.trim()})});
  toast("Categoría renombrada");await cargarCats();
};

// --- Usuarios ---
// Se dibuja para leer. Los campos aparecen al pedirlos, y de a uno: nombre y
// contraseña no se cambian juntos casi nunca, y tenerlos siempre a la vista
// convertía un dato que se mira en un formulario a medio llenar.
const ROTULO_ROL = {dueno:"Dueña", empleado:"Empleado"};

function panelUsuario(u, tipo, alTerminar){
  // tipo: "clave" o "nombre". Devuelve la fila de edición ya cableada.
  const esClave = tipo === "clave";
  const pan = document.createElement("div");
  pan.className = "usuario-panel";
  pan.innerHTML = `
    <label>${esClave ? `Contraseña nueva (al menos ${LARGO_MINIMO_PASS} caracteres)` : "Nombre de usuario"}</label>
    <input class="valor" type="text"${esClave ? ` minlength="${LARGO_MINIMO_PASS}" placeholder="al menos ${LARGO_MINIMO_PASS} caracteres"` : ""}>
    <span class="acc">
      <button class="b-ok aceptar">Guardar</button>
      <button class="b-out cancelar">Cancelar</button>
    </span>`;
  const campo = pan.querySelector(".valor");
  if (!esClave) campo.value = u.usuario;

  pan.querySelector(".cancelar").onclick = () => alTerminar(false);
  pan.querySelector(".aceptar").onclick = async () => {
    const v = campo.value.trim();
    if (!v) { toast(esClave ? "Escribí la contraseña nueva" : "El nombre no puede quedar vacío"); return; }
    if (esClave && v.length < LARGO_MINIMO_PASS) {
      toast(`La contraseña tiene que tener al menos ${LARGO_MINIMO_PASS} caracteres`); return; }
    const r = await authFetch(`/api/usuarios/${u.id}`, {
      method: "PUT", headers: {"Content-Type": "application/json"},
      body: JSON.stringify(esClave ? {password: v} : {usuario: v})});
    if (!r.ok) { const e = await r.json(); toast(e.detail || "No se pudo"); return; }
    toast(esClave ? "Contraseña cambiada" : "Nombre cambiado");
    alTerminar(true);
  };
  campo.addEventListener("keydown", ev => {
    if (ev.key === "Enter") pan.querySelector(".aceptar").click();
    if (ev.key === "Escape") alTerminar(false);
  });
  setTimeout(() => campo.focus(), 0);
  return pan;
}

async function cargarUsuarios(){
  const us = await (await authFetch("/api/usuarios")).json();
  const cont = $("#listaUsuarios");
  cont.innerHTML = "";
  const yo = getUser();

  us.forEach(u => {
    const fila = document.createElement("div");
    fila.className = "usuario-fila";

    const nom = document.createElement("span");
    nom.className = "n";
    nom.textContent = u.usuario;              // textContent y no innerHTML: el
    const meta = document.createElement("span");   // nombre lo escribe una persona
    meta.className = "meta";
    meta.textContent = ROTULO_ROL[u.rol] || u.rol;
    if (u.usuario === yo) meta.textContent += " · vos";

    const acc = document.createElement("span");
    acc.className = "acc";
    const bClave = Object.assign(document.createElement("button"),
                                 {className: "b-out", textContent: "Contraseña"});
    const bNom = Object.assign(document.createElement("button"),
                               {className: "b-out", textContent: "Renombrar"});
    acc.append(bClave, bNom);

    // Eliminar solo donde puede funcionar: el backend no deja borrarse a uno
    // mismo, así que mostrar el botón ahí es ofrecer un error.
    if (u.usuario !== yo) {
      const bDel = Object.assign(document.createElement("button"),
                                 {className: "b-del", textContent: "Eliminar"});
      bDel.onclick = async () => {
        if (!confirm(`¿Eliminar al usuario "${u.usuario}"?`)) return;
        const r = await authFetch(`/api/usuarios/${u.id}`, {method: "DELETE"});
        if (!r.ok) { const e = await r.json(); toast(e.detail || "No se pudo"); return; }
        toast("Eliminado"); cargarUsuarios();
      };
      acc.appendChild(bDel);
    }

    // Nombre y rol van en la MISMA celda. Si son dos columnas de grilla, el
    // ancho del bloque de botones (dos o tres, según la fila) corre el rol a
    // distinta altura en cada renglón y la lista se lee en zigzag.
    const quien = document.createElement("span");
    quien.className = "quien";
    quien.append(nom, meta);
    fila.append(quien, acc);
    cont.appendChild(fila);

    // Un solo panel abierto por vez en toda la lista: dos formularios abiertos
    // a la vez son otra vez el problema que se quería sacar.
    const abrir = tipo => {
      cont.querySelectorAll(".usuario-panel").forEach(x => x.remove());
      const pan = panelUsuario(u, tipo, recargar => {
        pan.remove();
        if (recargar) cargarUsuarios();
      });
      fila.after(pan);
    };
    bClave.onclick = () => abrir("clave");
    bNom.onclick = () => abrir("nombre");
  });

  dibujarCrearUsuario(us);
}

// El formulario de crear solo existe si hay un rol libre. Con los dos ocupados
// era un formulario que solo podía terminar en el error "ya hay un usuario X".
function dibujarCrearUsuario(us){
  const cont = $("#crearUsuario");
  if (!cont) return;
  cont.innerHTML = "";
  const libres = Object.keys(ROTULO_ROL).filter(r => !us.some(u => u.rol === r));

  if (!libres.length){
    const p = document.createElement("p");
    p.className = "nota-vacio";
    p.textContent = "Los dos roles están ocupados. Para cambiar de persona, "
                  + "renombrá el usuario y cambiale la contraseña, o borralo y creá otro.";
    cont.appendChild(p);
    return;
  }

  const caja = document.createElement("div");
  caja.className = "usuario-panel crear";
  caja.innerHTML = `
    <label>Crear el usuario ${libres.map(r => ROTULO_ROL[r]).join(" o ")}</label>
    <input class="cNom" type="text" placeholder="nombre de usuario">
    <input class="cPass" type="text" minlength="8" placeholder="contraseña inicial (8+)">
    ${libres.length > 1
      ? `<select class="cRol">${libres.map(r => `<option value="${r}">${ROTULO_ROL[r]}</option>`).join("")}</select>`
      : ""}
    <span class="acc"><button class="b-ok crear">Crear</button></span>`;

  caja.querySelector(".crear").onclick = async () => {
    const nom = caja.querySelector(".cNom").value.trim();
    const pass = caja.querySelector(".cPass").value;
    if (!nom || !pass) { toast("Completá usuario y contraseña"); return; }
    if (pass.length < LARGO_MINIMO_PASS) {
      toast(`La contraseña tiene que tener al menos ${LARGO_MINIMO_PASS} caracteres`); return; }
    const rol = libres.length > 1 ? caja.querySelector(".cRol").value : libres[0];
    const r = await authFetch("/api/usuarios", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({usuario: nom, password: pass, rol})});
    if (!r.ok) { const e = await r.json(); toast(e.detail || "No se pudo"); return; }
    toast("Usuario creado"); cargarUsuarios();
  };
  cont.appendChild(caja);
}

// La tarjeta de "mi contraseña" es solo del empleado: para la dueña, cambiar la
// suya es lo mismo que hacerlo desde Usuarios, donde además cambia las de todos.
// Con el empleado la tarjeta está y esto se cablea; con la dueña no está.
if($("#btnMiPass")) $("#btnMiPass").onclick=async()=>{
  const p=$("#miPass").value;
  if(!p){toast("Escribí la nueva contraseña");return;}
  if(p.length < LARGO_MINIMO_PASS){
    toast(`La contraseña tiene que tener al menos ${LARGO_MINIMO_PASS} caracteres`); return; }
  await authFetch("/api/usuarios/password",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({nueva:p})});
  $("#miPass").value="";toast("Contraseña cambiada");
};

// --- Backup completo ---
if(DUENO) $("#btnBackup").onclick=async()=>{
  $("#btnBackup").textContent="Descargando...";
  $("#btnBackup").disabled=true;
  try{
    const r=await authFetch("/api/backup");
    if(!r.ok){toast("Error al generar backup");return;}
    const blob=await r.blob();
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;
    a.download=`backup_pelu_${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Backup descargado ✓");
  }catch(e){toast("Error: "+e.message);}
  finally{$("#btnBackup").textContent="Descargar backup";$("#btnBackup").disabled=false;}
};
/* ---- Listas largas ----

   Admin creció: con veintipico de categorías, más los tipos de egreso, los
   usuarios y el resto, había que barrer media pantalla con el dedo para llegar
   de una tarjeta a la siguiente. Pasando las 5 filas, la lista se queda de ese
   alto y el resto se desliza adentro.

   El alto NO es un número fijo: se mide dónde arranca la fila 6 y se corta ahí.
   Las filas no miden todas lo mismo (la de un usuario tiene inputs, la de un
   alias es un renglón), así que un max-height a ojo mostraría 4 filas y media
   en una lista y 7 en otra.

   Se deja el encadenado del scroll como viene de fábrica: con el dedo sobre la
   lista se mueve la lista, y cuando llega al final sigue la página. Cortarlo
   (overscroll-behavior: contain) obligaría a sacar el dedo de la lista para
   poder seguir bajando, que es justo lo molesto. */
const TOPE_FILAS = 5;

/* Se corta unos píxeles DESPUÉS de la fila 5, así asoma el principio de la 6.
   Con el corte justo al ras, en las listas de filas altas (usuarios, ajustes)
   la última entraba completa y el degradé caía sobre el espacio en blanco de
   abajo: la lista parecía terminar ahí y nadie iba a probar deslizarla. Ver un
   pedazo de la fila siguiente no se puede malinterpretar. */
const ASOMO = 18;

function acotar(cont){
  cont.classList.remove("lista-scroll", "al-fin");
  cont.style.maxHeight = "";
  const hijos = [...cont.children];
  if(!hijos.length) return;
  /* Se cuentan RENGLONES, no elementos. En una lista es lo mismo —un hijo por
     renglón—, pero el catálogo ahora es una grilla de tarjetas de a cinco: ahí
     contar elementos cortaba en el segundo renglón y dejaba una franja de 123px
     con ocho tarjetas adentro. */
  const renglones = [...new Set(hijos.map(h => h.offsetTop))].sort((a,b) => a - b);
  if(renglones.length <= TOPE_FILAS) return;
  cont.style.maxHeight = (renglones[TOPE_FILAS] - renglones[0] + ASOMO) + "px";
  cont.classList.add("lista-scroll");
  marcarFin(cont);
}

// El degradé del pie dice "hay más abajo". Al llegar al final sobra, y encima
// deja la última fila medio borrosa, así que ahí se apaga.
function marcarFin(cont){
  const fin = cont.scrollTop + cont.clientHeight >= cont.scrollHeight - 2;
  cont.classList.toggle("al-fin", fin);
}

/* listas.js dibuja las cinco listas y necesita acotarlas igual que las de acá,
   pero no puede saber de esta función. Se la deja a mano en window: si no está
   (por ejemplo en Facturar, donde el panel es corto y no hace falta), listas.js
   simplemente no acota. */
window.acotarLista = cont => { acotar(cont); cont.addEventListener("scroll", () => marcarFin(cont), {passive:true}); };

// La lista de empleados la dibuja listas.js, el mismo dibujante que las otras
// cinco. Solo la ve la dueña: la tarjeta tiene data-dueno y ajustarPorRol() ya
// la sacó del documento cuando entra el empleado, así que acá no hay nada que
// dibujar y no se pide nada al servidor.
/* Empleados. Tiene su propio dibujante y no el de las listas configurables
   porque además del nombre hay un código, y un código no se muestra: se pone o
   se saca. Es la misma forma que la tarjeta de usuarios —fila de lectura, panel
   que se abre al pedirlo— por la misma razón.

   Todo esto es solo de la dueña: la tarjeta tiene data-dueno y ajustarPorRol()
   ya la sacó del documento cuando entra el empleado, así que acá no hay nada que
   dibujar ni nada que pedirle al servidor. */
/* Los dados de baja quedan escondidos detrás de un botón. Siguen existiendo
   —sus comprobantes dicen su nombre— pero no tienen por qué estar en la lista
   que se lee todos los días. */
let VER_BAJAS = false;

async function cargarEmpleados(){
  const cont = $("#listaEmpleados");
  if(!cont) return;
  const todos = await (await authFetch("/api/empleados?todos=true")).json();
  const bajas = todos.filter(e => !e.activo).length;
  const emps = VER_BAJAS ? todos : todos.filter(e => e.activo);
  cont.innerHTML = "";

  emps.forEach(e => {
    const fila = document.createElement("div");
    fila.className = "usuario-fila";

    const nom = document.createElement("span");
    nom.className = "n"; nom.textContent = e.nombre;   // lo escribe una persona
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = (e.activo ? "" : "de baja · ") + (e.tiene_pin ? "con código" : "sin código");
    if(!e.tiene_pin) meta.style.color = "var(--danger)";

    const quien = document.createElement("span");
    quien.className = "quien"; quien.append(nom, meta);

    const acc = document.createElement("span"); acc.className = "acc";
    const bNom = Object.assign(document.createElement("button"),
                               {className:"b-out", textContent:"Renombrar"});
    const bPin = Object.assign(document.createElement("button"),
                               {className:"b-out", textContent: e.tiene_pin ? "Cambiar código" : "Poner código"});
    const bBaja = Object.assign(document.createElement("button"),
                                {className: e.activo ? "b-del" : "b-ok",
                                 textContent: e.activo ? "Sacar" : "Reactivar"});
    acc.append(bNom, bPin, bBaja);
    fila.append(quien, acc);
    cont.appendChild(fila);

    const abrir = tipo => {
      cont.querySelectorAll(".panel-edicion").forEach(x => x.remove());
      fila.after(panelEmpleado(e, tipo));
    };
    bNom.onclick = () => abrir("nombre");
    bPin.onclick = () => abrir("pin");
    bBaja.onclick = async () => {
      if(!e.activo){
        const r = await authFetch(`/api/empleados/${e.id}`, {method:"PUT",
          headers:{"Content-Type":"application/json"}, body:JSON.stringify({activo: true})});
        if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo"); return; }
        toast("Reactivada"); await refrescarEmpleados(); return;
      }
      // El DELETE decide solo: si nunca hizo nada lo borra de verdad, y si tiene
      // historia lo da de baja. Por eso el aviso cuenta las dos cosas.
      if(!confirm(`Sacar a "${e.nombre}" de la lista.\n\nSi nunca trabajó, se borra del todo. Si ya tiene comprobantes o sueldos, queda dado de baja: deja de aparecer para elegir y no puede entrar a su sueldo, pero lo suyo sigue estando.\n\n¿Seguimos?`)) return;
      const r = await authFetch(`/api/empleados/${e.id}`, {method:"DELETE"});
      if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo"); return; }
      const d = await r.json();
      toast(d.borrado ? "Borrado" : `Dada de baja · tiene ${d.usos} ${d.usos===1?"registro":"registros"} a su nombre`);
      await refrescarEmpleados();
    };
  });

  if(bajas){
    const pie = document.createElement("button");
    pie.className = "b-out";
    pie.style.cssText = "margin-top:var(--sp-2); align-self:flex-start;";
    pie.textContent = VER_BAJAS ? "Ocultar los dados de baja" : `Ver ${bajas} ${bajas===1?"dado":"dados"} de baja`;
    pie.onclick = () => { VER_BAJAS = !VER_BAJAS; cargarEmpleados(); };
    cont.appendChild(pie);
  }

  dibujarCrearEmpleado();
  await cargarFusion();
}

/* Un panel por vez, como en usuarios: el nombre y el código no se cambian juntos
   casi nunca, y tenerlos siempre a la vista convierte una lista que se mira en
   un formulario a medio llenar. */
function panelEmpleado(e, tipo){
  const esPin = tipo === "pin";
  const pan = document.createElement("div");
  pan.className = "panel-edicion";
  pan.innerHTML = `
    <div class="campo"><label>${esPin ? "Código nuevo (4 a 8 números)" : "Nombre"}</label>
      <input class="valor" type="${esPin ? "text" : "text"}" ${esPin ? 'inputmode="numeric" maxlength="8" autocomplete="off" placeholder="Ej: 2468"' : ""}></div>
    <span class="acc">
      <button class="b-ok aceptar">Guardar</button>
      <button class="b-out cancelar">Cancelar</button>
      ${esPin && e.tiene_pin ? `<button class="b-del sacar">Sacar el código</button>` : ""}
    </span>
    ${esPin ? `<p class="muted" style="flex:1 1 100%;margin:0;">El código no se puede volver a ver:
       se guarda encriptado, como las contraseñas. Si se olvida, se pone uno nuevo.</p>` : ""}`;
  const campo = pan.querySelector(".valor");
  if(!esPin) campo.value = e.nombre;

  pan.querySelector(".cancelar").onclick = () => pan.remove();
  const sacar = pan.querySelector(".sacar");
  if(sacar) sacar.onclick = async () => {
    if(!confirm(`Sin código, ${e.nombre} no va a poder entrar a su sueldo. ¿Se lo sacamos?`)) return;
    await guardarEmpleado(`/api/empleados/${e.id}/pin`, {pin: null}, "Código sacado");
  };
  pan.querySelector(".aceptar").onclick = async () => {
    const v = campo.value.trim();
    if(!v){ toast(esPin ? "Escribí el código nuevo" : "El nombre no puede quedar vacío"); return; }
    if(esPin && (!/^\d{4,8}$/.test(v))){ toast("El código son de 4 a 8 números"); return; }
    if(esPin) await guardarEmpleado(`/api/empleados/${e.id}/pin`, {pin: v}, "Código guardado");
    else      await guardarEmpleado(`/api/empleados/${e.id}`, {nombre: v}, "Nombre cambiado");
  };
  campo.addEventListener("keydown", ev => {
    if(ev.key === "Enter") pan.querySelector(".aceptar").click();
    if(ev.key === "Escape") pan.remove();
  });
  setTimeout(() => campo.focus(), 0);
  return pan;
}

async function guardarEmpleado(url, cuerpo, aviso){
  const r = await authFetch(url, {method:"PUT", headers:{"Content-Type":"application/json"},
                                  body: JSON.stringify(cuerpo)});
  if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo"); return false; }
  toast(aviso);
  await refrescarEmpleados();
  return true;
}

function dibujarCrearEmpleado(){
  const caja = $("#crearEmpleado");
  if(!caja) return;
  caja.innerHTML = `
    <div class="panel-edicion crear">
      <div class="campo"><label>Agregar empleado</label>
        <input class="nuevo" placeholder="Ej: Carla"></div>
      <span class="acc"><button class="b-ok agregar">Agregar</button></span>
    </div>`;
  const campo = caja.querySelector(".nuevo");
  caja.querySelector(".agregar").onclick = async () => {
    const nombre = campo.value.trim();
    if(!nombre){ toast("Poné el nombre"); return; }
    const r = await authFetch("/api/empleados", {method:"POST",
      headers:{"Content-Type":"application/json"}, body: JSON.stringify({nombre})});
    if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo"); return; }
    const d = await r.json();
    toast(d.reactivado ? "Estaba dada de baja: volvió a la lista" : "Empleado agregado");
    campo.value = "";
    await refrescarEmpleados();
  };
  campo.addEventListener("keydown", ev => { if(ev.key === "Enter") caja.querySelector(".agregar").click(); });
}

async function refrescarEmpleados(){ await cargarEmpleados(); }

if($("#listaEmpleados")) cargarEmpleados();

/* Unificar dos empleados en uno.

   Se elige a mano y no se adivina: "Agus" y "Agustina" pueden ser la misma
   persona o dos distintas, y juntar a dos que no eran la misma le pasa el sueldo
   de una a la otra. Por eso pide confirmación diciendo los dos nombres.

   Se listan también las dadas de baja: una duplicada muchas veces está
   justamente ahí, desactivada para sacarla del medio. */
async function cargarFusion(){
  const caja = $("#fusionEmpleados");
  if(!caja) return;
  const emps = await (await authFetch("/api/empleados?todos=true")).json();
  const opts = e => emps.map(x =>
    `<option value="${x.id}"${x.id===e?" selected":""}>${esc(x.nombre)}${x.activo?"":" (de baja)"}</option>`).join("");
  $("#fusOrigen").innerHTML  = opts(null);
  $("#fusDestino").innerHTML = opts(emps.length > 1 ? emps[1].id : null);
  caja.style.display = emps.length > 1 ? "" : "none";
}

if($("#btnFusion")) $("#btnFusion").onclick = async () => {
  const origen = Number($("#fusOrigen").value), destino = Number($("#fusDestino").value);
  if(!origen || !destino) return;
  if(origen === destino){ toast("Elegí dos nombres distintos"); return; }
  const nOrigen  = $("#fusOrigen").selectedOptions[0].textContent.trim();
  const nDestino = $("#fusDestino").selectedOptions[0].textContent.trim();
  if(!confirm(`Todo lo de "${nOrigen}" pasa a "${nDestino}" y "${nOrigen}" desaparece de la lista.\n\n`
            + `Sus comprobantes y turnos van a decir "${nDestino}", y sus horas y sueldos también.\n\n`
            + `Esto no se puede deshacer. ¿Seguimos?`)) return;
  const r = await authFetch("/api/empleados/fusionar", {method:"POST",
    headers:{"Content-Type":"application/json"}, body:JSON.stringify({origen_id:origen, destino_id:destino})});
  if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo unificar"); return; }
  const d = await r.json();
  toast(`Quedó ${d.nombre}` + (d.renombrados ? ` · ${d.renombrados} anotaciones actualizadas` : ""));
  await refrescarEmpleados();
};

["#listaItems","#listaUsuarios","#listaEmpleados"].forEach(sel=>{
  const cont = $(sel);
  if(!cont) return;
  // Se escucha el cambio de contenido en vez de llamar a acotar() desde cada
  // función que dibuja: así una pantalla nueva o un renglón que se agrega sin
  // recargar la lista entera no se olvida de acotarse.
  new MutationObserver(()=>acotar(cont)).observe(cont, {childList:true});
  cont.addEventListener("scroll", ()=>marcarFin(cont), {passive:true});
  acotar(cont);
});
// al girar la tablet cambian los anchos y las filas altas cambian de alto
addEventListener("resize", ()=>document.querySelectorAll(".lista-scroll").forEach(acotar));

// Las cinco listas se dibujan solas al crearse (listaEditable() ya llama a su
// recargar()). Acá quedan las dos que tienen carga propia.
cargarCats();
if(DUENO) cargarUsuarios();

