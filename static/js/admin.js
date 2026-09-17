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
/* La categoría que se está mirando, con tres estados y no dos:
   - un nombre  → esa categoría, que es lo que se le pide al servidor;
   - null       → "Todas", que es una VISTA y no una categoría;
   - undefined  → todavía no se eligió nada (la primera carga elige la primera).
   El "Todas" no se podía representar y por eso el botón no hacía nada: caía en
   `cargarItems()`, que pedía los ítems de la categoría en la que estabas parado
   y volvía a dibujar exactamente lo mismo. */
let catActual;
/* La categoría elegida MIENTRAS hay un filtro puesto, que no es lo mismo que
   `catActual`. Sin filtro, la categoría ES la vista: se le piden al servidor los
   ítems de esa y nada más. Con el filtro de comisión prendido la vista es el
   catálogo entero filtrado, y la categoría pasa a ser un recorte de arriba de
   eso —"de los que van a comisión, los de color"—. Son dos cosas distintas y
   guardarlas en la misma variable dejaba la pantalla mostrando una y el rail
   marcando la otra. null = todas. */
let catFiltro=null;
let ITEMS_ALL=[];
/* El porcentaje general de comisión, el que rige cuando el ítem no tiene el
   suyo. Se muestra como sugerencia en la ficha para que se vea contra qué se
   está eligiendo; el que manda es el del servidor. */
let COMISION_GENERAL = 40;
/* El valor hora general, el mismo que se edita en Sueldos. Acá se lee para
   mostrar contra qué se está eligiendo cuando alguien cobra distinto. */
let VALOR_HORA_GENERAL = 0;
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
  if(c && c.valor_hora  != null) VALOR_HORA_GENERAL = c.valor_hora;
  if($("#listaEmpleados")) cargarEmpleados();   // redibuja con el general ya sabido
}).catch(()=>{});

async function cargarCats(){
  const cats=await (await authFetch("/api/categorias")).json();
  $("#selCat").innerHTML=cats.map(c=>`<option>${c}</option>`).join("");
  $("#cats").innerHTML=cats.map(c=>`<option value="${c}">`).join("");
  // Se respeta la categoría que se estaba mirando. Sin esto, guardar un precio
  // devolvía la lista a la primera categoría del abecedario y había que volver a
  // buscar dónde estabas para tocar el ítem de al lado.
  if(catActual && cats.includes(catActual)) $("#selCat").value=catActual;
  // Solo en la primera carga se adopta la primera del abecedario. Después manda
  // lo que eligió el usuario, "Todas" incluido, que es null y no hay que pisar.
  if(catActual === undefined) catActual=$("#selCat").value;
  ITEMS_ALL=await (await authFetch("/api/items/all")).json();
  filtrarItems();
}

$("#selCat").onchange=()=>{catActual=$("#selCat").value;$("#buscarItem").value="";filtrarItems();};
// Escribir en el buscador sale del recorte por categoría: buscar dentro de una
// sola es justo lo que no sirve cuando no te acordás en cuál lo pusiste.
$("#buscarItem").oninput=()=>{ catFiltro=null; filtrarItems(); };

/* El filtro de comisión y el buscador son lo mismo: los dos dejan de mirar una
   categoría y pasan a mirar el catálogo entero. Por eso están en la misma
   función y se pueden usar juntos ("de los que van a comisión, los que dicen
   color"). */
$("#soloComision").onclick=()=>{
  $("#soloComision").classList.toggle("on");
  if(!$("#soloComision").classList.contains("on")){
    /* Apagar el filtro no tiene por qué mudarte de categoría: si venías mirando
       los de comisión de CORTES, la vista normal se queda en CORTES. Sin esto
       volvía a la última categoría que se había pedido al servidor, que podía
       ser cualquiera de hace diez clicks. */
    if(catFiltro){ catActual = catFiltro; $("#selCat").value = catFiltro; }
    catFiltro=null;
  }
  filtrarItems();
};

function filtrarItems(){
  const q=$("#buscarItem").value.trim().toLowerCase();
  const soloCom=$("#soloComision").classList.contains("on");
  const cuenta=$("#cuentaComision");
  if(!q && !soloCom){ cuenta.textContent=""; catFiltro=null; cargarItems(); return; }
  // Con el buscador o el filtro prendidos se sale de la categoría y se mira el
  // catálogo entero: buscar dentro de una sola es justo lo que no sirve cuando
  // no te acordás en cuál lo pusiste.
  let f=ITEMS_ALL;
  if(soloCom) f=f.filter(i=>i.es_comision);
  /* Si a la categoría recortada se le sacó la comisión al último ítem, el rail
     ya no la muestra: sin esto quedaba recortando por una categoría que no está
     en ninguna parte y la lista aparecía vacía sin decir por qué. */
  if(catFiltro && !f.some(i=>i.categoria===catFiltro)) catFiltro=null;
  if(soloCom && catFiltro) f=f.filter(i=>i.categoria===catFiltro);
  if(q) f=f.filter(i=>i.nombre.toLowerCase().includes(q));
  cuenta.textContent = soloCom
    ? `${f.length} ${f.length===1?"ítem":"ítems"} en ${new Set(f.map(i=>i.categoria)).size} ${new Set(f.map(i=>i.categoria)).size===1?"categoría":"categorías"}`
    : "";
  renderItems(f, true);
}

async function cargarItems(){
  /* "Todas" no se le pide al servidor: ya está todo en ITEMS_ALL, que se trae
     entero al cargar la pantalla. Pedirlo sería un viaje al pedo, y además no
     hay nada que pedir —no existe la categoría "todas"—. */
  if(catActual == null){ renderItems(ITEMS_ALL, true); return; }
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
  const soloCom = $("#soloComision").classList.contains("on");
  /* Con el filtro de comisión prendido el rail cuenta SOLO los que van a
     comisión y esconde las categorías que no tienen ninguno: "CORTES 24" y que
     al tocarla no aparezca nada se lee como que la pantalla se rompió. */
  const base = soloCom ? ITEMS_ALL.filter(i=>i.es_comision) : ITEMS_ALL;
  const cuentas=new Map();
  base.forEach(i=>cuentas.set(i.categoria,(cuentas.get(i.categoria)||0)+1));
  const buscando = $("#buscarItem").value.trim() || soloCom;
  rail.innerHTML="";
  const agregar=(nombre, etiqueta, cuenta, activa)=>{
    const b=document.createElement("button");
    b.type="button"; b.className="cat-pill" + (activa ? " on" : "");
    b.innerHTML=`<span class="nom">${esc(etiqueta)}</span><span class="cuenta">${cuenta}</span>`;
    b.onclick=()=>{
      $("#buscarItem").value="";
      /* Tocar una categoría con el filtro de comisión prendido NO lo apaga: es
         justo la combinación que hace falta para revisar los porcentajes de una
         categoría entera. Apagándolo, el que venía a eso perdía el filtro y no
         entendía por qué le aparecieron de golpe los otros veinte ítems. */
      if(soloCom){ catFiltro = nombre; }
      else {
        catFiltro = null;
        catActual = nombre;                       // null = Todas, y es un estado
        if(nombre) $("#selCat").value = nombre;
      }
      filtrarItems();
    };
    rail.appendChild(b);
  };
  agregar(null, "Todas", base.length, buscando ? !catFiltro : catActual == null);
  [...cuentas.keys()].sort().forEach(c =>
    agregar(c, c, cuentas.get(c), buscando ? c === catFiltro : c === catActual));
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
  if(items.length===0){ cont.innerHTML='<p class="muted">Sin ítems para mostrar.</p>'; return; }
  /* Elegir de a varios está en todo el modo edición: en tanda se ponen dos cosas
     —el porcentaje y la categoría— y mover de categoría hace falta justamente
     cuando estás mirando una sola y ves los tres que no van ahí. */
  const eligiendo = items.length > 1;
  if(eligiendo) cont.appendChild(barraSeleccion());
  items.forEach(it=>{
    const row=document.createElement("div");
    row.className = "item-row" + (eligiendo ? " con-sel" : "");
    // Si este ítem ya venía tocado desde otra categoría, se muestra como quedó y
    // no como está en la base: el cambio sigue pendiente hasta que se guarde.
    const pend = CAMBIOS.get(it.id);
    const v = pend || {nombre:it.nombre, precio:it.precio, es_comision:!!it.es_comision,
                       comision_pct:it.comision_pct, categoria:it.categoria};
    /* El chip de categoría aparece siempre que la fila esté MOVIDA, aunque se
       esté mirando una sola categoría: sin eso, mover un ítem afuera lo dejaba
       en la lista sin ninguna señal de que ya no pertenece ahí. */
    const movida = (v.categoria || it.categoria) !== it.categoria;
    const cat = (mostrarCat || movida)
      ? `<span class="tag ${movida?"movido":"neutro"}">${movida?"→ ":""}${esc(v.categoria || it.categoria)}</span>`
      : "";
    /* El porcentaje se edita acá adentro, al lado de la marca de comisión. Es la
       razón principal para entrar a este modo: prendés el filtro de comisión,
       entrás a editar y quedan todos los porcentajes del catálogo uno abajo del
       otro. De a un ítem por vez, cambiar diez es abrir y cerrar diez fichas. */
    row.innerHTML=`
      ${eligiendo ? `<input type="checkbox" class="sel" aria-label="Elegir ${esc(it.nombre)}">` : ""}
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
                 value="${v.comision_pct ?? ""}" placeholder="general (${COMISION_GENERAL}%)"
                 aria-label="Porcentaje de comisión"><span class="u">%</span>
        </span>
      </span>
      <span class="acc"></span>`;
    const leerPct=()=>{
      const t=row.querySelector(".pct").value.trim();
      // "" = sin porcentaje propio. Se guarda como null y el ítem usa el general.
      return t === "" ? null : Math.max(0, Math.min(100, parseInt(t,10) || 0));
    };
    // La categoría no tiene casillero en la fila: se cambia desde la barra de
    // arriba, para varios de una. La fila la lleva puesta para saber si se movió.
    let catFila = v.categoria || it.categoria;
    const leer=()=>({nombre:row.querySelector(".n").value.trim(),
                     precio:parseInt(row.querySelector(".p").value,10),
                     es_comision:row.querySelector(".com").checked,
                     comision_pct:leerPct(), categoria:catFila});
    const original=JSON.stringify({nombre:it.nombre, precio:it.precio,
                                   es_comision:!!it.es_comision,
                                   comision_pct:it.comision_pct ?? null,
                                   categoria:it.categoria});
    const marcar=()=>{
      const ahora=leer();
      const sucia = JSON.stringify(ahora)!==original;
      /* Lo tocado vive en CAMBIOS y no en la fila. La fila se destruye al
         cambiar de categoría —se redibuja la lista entera— y con ella se perdía
         lo tipeado: había que acordarse de guardar antes de moverse, o se perdía
         sin aviso. Así se pueden recorrer todas las categorías y guardar una vez
         al final. */
      /* `catOriginal` es de DÓNDE salió la fila, no a dónde va: sirve para contar
         cuántas categorías se tocaron. Antes se guardaba como `categoria` y le
         pisaba a la de `ahora`, así que mover un ítem se veía en pantalla —el
         chip, la fila marcada, la cuenta— pero al guardar se mandaba la
         categoría vieja y no se movía nada. */
      if(sucia) CAMBIOS.set(it.id, {...ahora, catOriginal:it.categoria, nombreViejo:it.nombre});
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
    row.querySelectorAll("input:not(.sel)").forEach(el=>{
      el.addEventListener("input", marcar); el.addEventListener("change", marcar);
    });
    // El de elegir no es un dato del ítem: no lo ensucia, solo refresca la barra.
    if(eligiendo) row.querySelector(".sel").addEventListener("change", pintarSeleccion);
    // La barra mueve de categoría llamando acá: la fila sigue siendo la única que
    // sabe leerse y marcarse, así no hay dos lugares que escriban en CAMBIOS.
    row.mover = (destino) => {
      catFila = destino;
      row.querySelector(".meta .tag")?.remove();
      const chip = document.createElement("span");
      chip.className = "tag" + (destino !== it.categoria ? " movido" : " neutro");
      chip.textContent = (destino !== it.categoria ? "→ " : "") + destino;
      row.querySelector(".transf").after(chip);
      marcar();
    };
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
  pintarSeleccion();
}

/* Ponerle el mismo porcentaje a varios de una.

   Cambiar el porcentaje de una categoría entera era tipear el mismo número
   quince veces, y quince veces es una en la que se tipea otro sin darse cuenta.
   Acá se eligen —todos los que están a la vista, o los que se marquen a mano— y
   se pone una sola vez.

   No guarda: escribe en los mismos casilleros por los que se hubiera pasado
   tipeando, y de ahí sigue el camino de siempre —queda marcado como tocado y se
   guarda con el botón de abajo—. Así se ve qué va a pasar antes de que pase, y
   si se erró el número se sale del modo edición y no quedó nada. */
function barraSeleccion(){
  const barra=document.createElement("div");
  barra.className="barra-sel";
  barra.innerHTML=`
    <span class="cuantos">Ninguno elegido</span>
    <button type="button" class="b-out todos">Elegir todos</button>
    <button type="button" class="b-out ninguno" disabled>Ninguno</button>
    <span class="separa"></span>
    <label class="rot">Ponerles</label>
    <input type="number" class="pct-todos" min="0" max="100" inputmode="numeric"
           placeholder="%" aria-label="Porcentaje para los elegidos">
    <button type="button" class="b-tinta poner" disabled>Aplicar</button>
    <button type="button" class="b-out general" disabled>Que usen el general</button>
    <span class="corte"></span>
    <label class="rot">Mover a</label>
    <input class="cat-todos" list="cats" placeholder="categoría" aria-label="Categoría destino">
    <button type="button" class="b-tinta mover" disabled>Mover</button>`;

  const filas = () => [...$("#listaItems").querySelectorAll(".item-row")];
  const marcar = (v) => { filas().forEach(r=>{ r.querySelector(".sel").checked=v; }); pintarSeleccion(); };
  barra.querySelector(".todos").onclick   = () => marcar(true);
  barra.querySelector(".ninguno").onclick = () => marcar(false);

  const aplicar = (valor) => {
    const elegidas = filas().filter(r => r.querySelector(".sel").checked);
    let n=0, sinComision=0;
    elegidas.forEach(r=>{
      // Un porcentaje en un ítem que no va a comisión no quiere decir nada, así
      // que se lo saltea en vez de escribirle un número que no se va a usar.
      if(!r.querySelector(".com").checked){ sinComision++; return; }
      const casillero = r.querySelector(".pct");
      casillero.value = valor;
      // Por el mismo camino que tipearlo: así queda en CAMBIOS, la fila se marca
      // y la barra de guardar cuenta bien, sin repetir nada de eso acá.
      casillero.dispatchEvent(new Event("input"));
      n++;
    });
    const hubo = `${n} ${n===1?"ítem":"ítems"}`;
    toast(n === 0
      ? "No quedó ninguno para cambiar"
      : (valor === "" ? `${hubo} vuelven al general` : `${hubo} al ${valor}%`)
        + (sinComision ? ` · ${sinComision} sin comisión, sin tocar` : ""));
  };

  barra.querySelector(".poner").onclick = () => {
    const t = barra.querySelector(".pct-todos").value.trim();
    const n = parseInt(t,10);
    if(t === "" || isNaN(n) || n < 0 || n > 100){
      toast("Escribí un porcentaje de 0 a 100"); barra.querySelector(".pct-todos").focus(); return;
    }
    aplicar(String(n));
  };
  barra.querySelector(".general").onclick = () => aplicar("");

  /* Mover de categoría, que es la otra cosa que se hace de a varios: entrás a
     una categoría, ves los tres que no van ahí y los mandás juntos. Tampoco
     guarda solo —queda como cambio pendiente, con el chip diciendo a dónde van—
     porque mover veinte ítems sin poder mirarlos antes es de las cosas que se
     arreglan de a una. */
  barra.querySelector(".mover").onclick = () => {
    const destino = barra.querySelector(".cat-todos").value.trim();
    if(!destino){ toast("Escribí o elegí la categoría destino"); barra.querySelector(".cat-todos").focus(); return; }
    const elegidas = filas().filter(r => r.querySelector(".sel").checked);
    elegidas.forEach(r => r.mover(destino));
    toast(`${elegidas.length} ${elegidas.length===1?"ítem":"ítems"} a "${destino}" · falta guardar`);
  };
  barra.querySelector(".cat-todos").addEventListener("keydown", e=>{
    if(e.key === "Enter") barra.querySelector(".mover").click();
  });
  barra.querySelector(".pct-todos").addEventListener("keydown", e=>{
    if(e.key === "Enter") barra.querySelector(".poner").click();
  });
  return barra;
}

/* Cuántos hay elegidos y qué botones tienen sentido con eso. Lee del DOM en vez
   de llevar una lista aparte: la lista se redibuja entera al cambiar de
   categoría y una copia se queda hablando de filas que ya no existen. */
function pintarSeleccion(){
  const barra=$("#listaItems").querySelector(".barra-sel");
  if(!barra) return;
  const filas=[...$("#listaItems").querySelectorAll(".item-row .sel")];
  const n=filas.filter(c=>c.checked).length;
  barra.querySelector(".cuantos").textContent =
    n === 0 ? "Ninguno elegido" : `${n} de ${filas.length} elegido${n===1?"":"s"}`;
  barra.classList.toggle("hay", n > 0);
  ["poner","general","ninguno","mover"].forEach(c => barra.querySelector("."+c).disabled = n === 0);
  barra.querySelector(".todos").disabled = n === filas.length;
}

/* Lo tocado en el modo edición, de TODAS las categorías, hasta que se guarda.
   Clave: el id del ítem. */
const CAMBIOS = new Map();

function pintarBarra(){
  const btn=$("#btnGuardarTodos"), nota=btn && btn.nextElementSibling;
  if(!btn) return;
  const n = CAMBIOS.size;
  const cats = new Set([...CAMBIOS.values()].map(c=>c.catOriginal)).size;
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
                            categoria: v.categoria,
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
             placeholder="general (${COMISION_GENERAL}%)"><span>%</span></div></div>
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
$("#btnRenombrar").onclick=async()=>{
  // Renombrar necesita UNA categoría. Con "Todas" o con un filtro puesto no hay
  // ninguna elegida, y antes esto abría un prompt que decía "undefined".
  const cat = catFiltro || catActual;
  if(!cat){ toast("Elegí una categoría para renombrarla"); return; }
  const nuevo=prompt(`Renombrar la categoría "${cat}" a:`,cat);
  if(!nuevo||nuevo.trim()===cat)return;
  await authFetch("/api/categorias",{method:"PUT",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({viejo:cat,nuevo:nuevo.trim()})});
  if(catActual === cat) catActual = nuevo.trim();
  if(catFiltro === cat) catFiltro = nuevo.trim();
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

/* De lo general a lo particular: arriba los dos números que valen para todas, y
   después una línea por persona con un solo botón.

   Antes cada empleada traía cinco botones —renombrar, código, valor hora,
   horario, sacar—. Con cuatro personas eran veinte, que en la tablet no entran
   en una línea y dejan el nombre como lo más chico del renglón. */
let HORARIOS = {};

async function cargarEmpleados(){
  const cont = $("#listaEmpleados");
  if(!cont) return;
  const [todos, horarios] = await Promise.all([
    (await authFetch("/api/empleados?todos=true")).json(),
    (await authFetch("/api/horarios")).json().catch(() => ({})),
  ]);
  HORARIOS = horarios || {};
  const bajas = todos.filter(e => !e.activo).length;
  const emps = VER_BAJAS ? todos : todos.filter(e => e.activo);
  cont.innerHTML = "";

  const gral = document.createElement("div");
  panelGenerales(gral, c => {
    VALOR_HORA_GENERAL = c.valor_hora;
    cargarEmpleados();
  });
  cont.appendChild(gral);

  emps.forEach(e => {
    const fila = document.createElement("div");
    fila.className = "emp-fila";

    const quien = document.createElement("span");
    quien.className = "quien";
    const nom = document.createElement("b");
    nom.textContent = e.nombre;                      // lo escribe una persona
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = resumenHorario(e.id);
    quien.append(nom, meta);

    const marcas = document.createElement("span");
    marcas.className = "marcas";
    // Solo lo que se sale de lo normal. Una columna que dice lo mismo en todas
    // las filas ocupa lugar sin decir nada.
    if(!e.activo) marcas.appendChild(chip("de baja", "gris"));
    if(!e.tiene_pin) marcas.appendChild(chip("sin código"));
    if(e.valor_hora != null) marcas.appendChild(chip(`$${e.valor_hora.toLocaleString("es-AR")} la hora`, "gris"));

    const abrir = Object.assign(document.createElement("button"),
                                {className:"b-out abrir", textContent:"Abrir"});
    fila.append(quien, marcas, abrir);
    cont.appendChild(fila);

    abrir.onclick = () => {
      const abierto = cont.querySelector(".panel-persona");
      const eraEsta = abierto && abierto.dataset.emp === String(e.id);
      cerrarPersona();
      if(eraEsta) return;                            // el mismo botón lo cierra
      fila.after(panelPersona(e));
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
  pintarBarraHorario(todos);
  pintarGrillaHorarios(todos);
}

/* Uno abierto por vez. Con dos personas desplegadas la lista deja de ser una
   lista y pasa a ser dos formularios a medio llenar. */
function cerrarPersona(){
  document.querySelectorAll(".panel-persona").forEach(p => p.remove());
}

function chip(texto, clase){
  const c = document.createElement("span");
  c.className = "chip-emp" + (clase ? " " + clase : "");
  c.textContent = texto;
  return c;
}

/* "Mar a sáb · 10 a 13 · 16 a 20", o el día suelto si no es un bloque seguido.
   Es lo que reemplaza al valor hora en el renglón: el horario se mira mucho más
   seguido que lo que cobra la hora, que casi siempre es el general. */
function resumenHorario(empId){
  const tramos = HORARIOS[String(empId)] || [];
  if(!tramos.length) return "sin horario cargado";
  const dias = [...new Set(tramos.map(t => t.dia_semana))].sort((a,b) => a-b);
  const corto = d => DIAS_SEM[d].slice(0,3).toLowerCase();
  const seguidos = dias.every((d,i) => i === 0 || d === dias[i-1] + 1);
  const cuando = dias.length === 1 ? corto(dias[0])
               : seguidos ? `${corto(dias[0])} a ${corto(dias[dias.length-1])}`
               : dias.map(corto).join(", ");
  // Los tramos del primer día alcanzan: si alguno fuera distinto, se ve en la
  // grilla de abajo, que es justo para lo que está.
  const delDia = tramos.filter(t => t.dia_semana === dias[0])
                       .sort((a,b) => a.desde.localeCompare(b.desde))
                       .map(t => `${hm(t.desde)} a ${hm(t.hasta)}`).join(" · ");
  return `${cuando} · ${delDia}`;
}
const hm = s => (s || "").replace(/^0/, "").replace(/:00$/, "");

/* Todo lo de una persona junto. Cada renglón abre abajo el editor que ya
   existía cuando cada cosa era un botón suelto: lo que cambió es dónde se
   entra, no lo que hace cada uno. */
function panelPersona(e){
  const pan = document.createElement("div");
  pan.className = "panel-persona";
  pan.dataset.emp = e.id;
  const vh = e.valor_hora != null
    ? `$${e.valor_hora.toLocaleString("es-AR")}`
    : `$${VALOR_HORA_GENERAL.toLocaleString("es-AR")} (el general)`;
  pan.innerHTML = `
    <div class="linea" data-tipo="nombre">
      <span class="et">Nombre<small>Arrastra a sus comprobantes y turnos</small></span>
      <span class="dato">${escHtml(e.nombre)}</span>
      <button class="b-out">Cambiar</button></div>
    <div class="linea" data-tipo="pin">
      <span class="et">Código<small>Con esto abre su sueldo</small></span>
      <span class="dato">${e.tiene_pin ? "puesto" : `<span class="chip-emp">no tiene</span>`}</span>
      <button class="b-out">${e.tiene_pin ? "Cambiar" : "Poner código"}</button></div>
    <div class="linea" data-tipo="vh">
      <span class="et">Lo que cobra la hora<small>Vacío quiere decir el general</small></span>
      <span class="dato">${vh}</span>
      <button class="b-out">Cambiar</button></div>
    <div class="linea" data-tipo="horario">
      <span class="et">Horario<small>El de siempre. Un día suelto se cambia en la agenda</small></span>
      <span class="dato">${escHtml(resumenHorario(e.id))}</span>
      <button class="b-out">Cambiar</button></div>
    <div class="linea" data-tipo="baja">
      <span class="et">${e.activo ? "Sacar de la lista" : "Reactivar"}<small>${e.activo
        ? "Si ya trabajó queda de baja y lo suyo sigue estando"
        : "Vuelve a aparecer para elegir"}</small></span>
      <span class="dato"></span>
      <button class="${e.activo ? "b-del" : "b-ok"}">${e.activo ? "Sacar" : "Reactivar"}</button></div>`;

  pan.querySelectorAll(".linea").forEach(linea => {
    linea.querySelector("button").onclick = async () => {
      const tipo = linea.dataset.tipo;
      if(tipo === "baja") return void bajaOReactivar(e);
      pan.querySelectorAll(".panel-edicion, .panel-horario").forEach(x => x.remove());
      linea.after(tipo === "horario" ? panelHorario(e) : panelEmpleado(e, tipo));
    };
  });
  return pan;
}

async function bajaOReactivar(e){
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
}

const escHtml = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

/* Un panel por vez, como en usuarios: el nombre y el código no se cambian juntos
   casi nunca, y tenerlos siempre a la vista convierte una lista que se mira en
   un formulario a medio llenar. */
function panelEmpleado(e, tipo){
  const esPin = tipo === "pin", esVh = tipo === "vh";
  const rotulo = esPin ? "Código nuevo (4 a 8 números)"
               : esVh ? "Lo que cobra la hora" : "Nombre";
  const pan = document.createElement("div");
  pan.className = "panel-edicion";
  pan.innerHTML = `
    <div class="campo"><label>${rotulo}</label>
      <input class="valor" type="${esVh ? "number" : "text"}" ${
        esPin ? 'inputmode="numeric" maxlength="8" autocomplete="off" placeholder="Ej: 2468"' : ""}${
        esVh ? ` min="0" inputmode="numeric" placeholder="${VALOR_HORA_GENERAL} (el general)"` : ""}></div>
    <span class="acc">
      <button class="b-ok aceptar">Guardar</button>
      <button class="b-out cancelar">Cancelar</button>
      ${esPin && e.tiene_pin ? `<button class="b-del sacar">Sacar el código</button>` : ""}
      ${esVh && e.valor_hora != null ? `<button class="b-out general">Que use el general</button>` : ""}
    </span>
    ${esPin ? `<p class="muted" style="flex:1 1 100%;margin:0;">El código no se puede volver a ver:
       se guarda encriptado, como las contraseñas. Si se olvida, se pone uno nuevo.</p>` : ""}
    ${esVh ? `<p class="muted" style="flex:1 1 100%;margin:0;">Vacío quiere decir que cobra el general
       ($${VALOR_HORA_GENERAL.toLocaleString("es-AR")}), que se cambia en Sueldos. Esto es solo para
       quien cobre distinto. Los sueldos ya cerrados no se tocan: cada liquidación guarda el valor
       con el que se pagó.</p>` : ""}`;
  const campo = pan.querySelector(".valor");
  if(!esPin && !esVh) campo.value = e.nombre;
  if(esVh && e.valor_hora != null) campo.value = e.valor_hora;

  pan.querySelector(".cancelar").onclick = () => pan.remove();
  const sacar = pan.querySelector(".sacar");
  if(sacar) sacar.onclick = async () => {
    if(!confirm(`Sin código, ${e.nombre} no va a poder entrar a su sueldo. ¿Se lo sacamos?`)) return;
    await guardarEmpleado(`/api/empleados/${e.id}/pin`, {pin: null}, "Código sacado");
  };
  const general = pan.querySelector(".general");
  // -1 es el centinela de "sacale el propio": mandar null sería "no lo toques".
  if(general) general.onclick = () =>
    guardarEmpleado(`/api/empleados/${e.id}`, {valor_hora: -1}, "Vuelve al valor general");
  pan.querySelector(".aceptar").onclick = async () => {
    const v = campo.value.trim();
    if(!v){
      // En el valor hora, vacío es una respuesta válida: quiere decir el general.
      if(esVh){ await guardarEmpleado(`/api/empleados/${e.id}`, {valor_hora: -1}, "Vuelve al valor general"); return; }
      toast(esPin ? "Escribí el código nuevo" : "El nombre no puede quedar vacío"); return;
    }
    if(esPin && (!/^\d{4,8}$/.test(v))){ toast("El código son de 4 a 8 números"); return; }
    if(esVh){
      const n = parseInt(v, 10);
      if(isNaN(n) || n < 0){ toast("El valor hora tiene que ser un número"); return; }
      await guardarEmpleado(`/api/empleados/${e.id}`, {valor_hora: n}, "Valor hora guardado");
      return;
    }
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

/* El horario fijo de la semana: se edita entera y se guarda de una vez.

   Dos tramos por día como máximo —entra, corta al mediodía, vuelve— y el día
   destildado es "no trabaja", que en la agenda se dibuja distinto de trabajar
   cero horas. */
const DIAS_SEM = ["Lunes","Martes","Miércoles","Jueves","Viernes","Sábado","Domingo"];

function panelHorario(e){
  const pan = document.createElement("div");
  pan.className = "panel-horario";
  pan.innerHTML = `<p class="muted" style="margin:0 0 var(--sp-2);">
      El horario de siempre de ${esc(e.nombre)}. En la agenda se dibuja como su columna del día.
      Un día suelto —se cambió con otra, o el lunes de depilación— se carga desde la agenda, no acá.</p>
    <div class="de-una">
      <span class="rot">El horario de la semana</span>
      <span class="tramo"><input type="time" class="ud1" value="08:00"><span class="a">a</span><input type="time" class="uh1" value="20:00"></span>
      <label class="marca corta"><input type="checkbox" class="udoble"> corta al mediodía</label>
      <span class="tramo ut2" hidden><input type="time" class="ud2" value="15:00"><span class="a">a</span><input type="time" class="uh2" value="19:00"></span>
      <span class="chips">${DIAS_SEM.map((d,i)=>
        `<button type="button" class="chip-dia${i>=1 && i<=5 ? " on":""}" data-d="${i}">${d.slice(0,3)}</button>`).join("")}</span>
      <button class="b-tinta aplicar">Aplicar</button>
    </div>
    <p class="resumen"></p>
    <div class="dias" hidden></div>
    <span class="acc">
      <button class="b-ok guardar">Guardar el horario</button>
      <button class="b-out cancelar">Cancelar</button>
      <button class="b-out porDia">Ajustar día por día</button>
    </span>`;
  const cajaDias = pan.querySelector(".dias");

  const filaDia = (i) => {
    const d = document.createElement("div");
    d.className = "dia-horario";
    d.innerHTML = `
      <label class="marca"><input type="checkbox" class="trabaja"> ${DIAS_SEM[i]}</label>
      <span class="tramo t1"><input type="time" class="d1"><span class="a">a</span><input type="time" class="h1"></span>
      <label class="marca corta"><input type="checkbox" class="doble"> corta al mediodía</label>
      <span class="tramo t2" hidden><input type="time" class="d2"><span class="a">a</span><input type="time" class="h2"></span>`;
    const pintar = () => {
      const on = d.querySelector(".trabaja").checked;
      d.classList.toggle("off", !on);
      d.querySelectorAll("input[type=time], .doble").forEach(x => x.disabled = !on);
      d.querySelector(".t2").hidden = !(on && d.querySelector(".doble").checked);
    };
    d.querySelector(".trabaja").onchange = pintar;
    d.querySelector(".doble").onchange = pintar;
    d._pintar = pintar;
    return d;
  };
  const filas = DIAS_SEM.map((_, i) => { const f = filaDia(i); cajaDias.appendChild(f); return f; });

  const poner = (f, tramos) => {
    f.querySelector(".trabaja").checked = tramos.length > 0;
    f.querySelector(".d1").value = tramos[0] ? tramos[0].desde : "08:00";
    f.querySelector(".h1").value = tramos[0] ? tramos[0].hasta : "20:00";
    f.querySelector(".doble").checked = tramos.length > 1;
    f.querySelector(".d2").value = tramos[1] ? tramos[1].desde : "15:00";
    f.querySelector(".h2").value = tramos[1] ? tramos[1].hasta : "19:00";
    f._pintar();
  };

  /* Lo que se ve primero es la semana entera, que es como se carga de verdad:
     todas hacen el mismo horario casi todos los días. Los renglones de cada día
     aparecen al pedirlos —debajo hay un resumen de lo que está guardado, así
     esconderlos no esconde el dato—. */
  const resumen = pan.querySelector(".resumen");
  const hhmm = t => t;
  const pintarResumen = () => {
    const partes = [];
    filas.forEach((f, i) => {
      if(!f.querySelector(".trabaja").checked) return;
      let t = `${hhmm(f.querySelector(".d1").value)}–${hhmm(f.querySelector(".h1").value)}`;
      if(f.querySelector(".doble").checked)
        t += ` y ${hhmm(f.querySelector(".d2").value)}–${hhmm(f.querySelector(".h2").value)}`;
      partes.push([DIAS_SEM[i], t]);
    });
    if(!partes.length){ resumen.textContent = "Todavía no tiene horario cargado."; return; }
    // Los días seguidos con el mismo horario se juntan: "Mar a Sáb 10–19" en vez
    // de cinco renglones que dicen lo mismo.
    const juntos = [];
    partes.forEach(([dia, t]) => {
      const ult = juntos[juntos.length - 1];
      if(ult && ult.t === t) ult.hasta = dia; else juntos.push({desde: dia, hasta: null, t});
    });
    resumen.innerHTML = juntos.map(g =>
      `<b>${g.hasta ? `${g.desde} a ${g.hasta}` : g.desde}</b> ${esc(g.t)}`).join(" · ");
  };
  filas.forEach(f => f.addEventListener("change", pintarResumen));

  authFetch("/api/horarios").then(r => r.json()).then(todos => {
    const mios = (todos[String(e.id)] || []);
    filas.forEach((f, i) => poner(f, mios.filter(h => h.dia_semana === i)
                                       .sort((a, b) => a.desde.localeCompare(b.desde))));
    // La fila de arriba arranca con el horario que más se repite, para que
    // "Aplicar" sea un retoque y no volver a escribir todo desde cero.
    const conteo = new Map();
    filas.forEach((f, i) => {
      if(!f.querySelector(".trabaja").checked) return;
      const k = [f.querySelector(".d1").value, f.querySelector(".h1").value,
                 f.querySelector(".doble").checked, f.querySelector(".d2").value,
                 f.querySelector(".h2").value].join("|");
      conteo.set(k, (conteo.get(k) || 0) + 1);
    });
    const comun = [...conteo.entries()].sort((a, b) => b[1] - a[1])[0];
    if(comun){
      const [d1, h1, doble, d2, h2] = comun[0].split("|");
      pan.querySelector(".ud1").value = d1; pan.querySelector(".uh1").value = h1;
      pan.querySelector(".udoble").checked = doble === "true";
      pan.querySelector(".ud2").value = d2; pan.querySelector(".uh2").value = h2;
      pan.querySelector(".ut2").hidden = doble !== "true";
    }
    pintarResumen();
  }).catch(() => { filas.forEach(f => poner(f, [])); pintarResumen(); });

  pan.querySelector(".porDia").onclick = () => {
    const caja = pan.querySelector(".dias");
    caja.hidden = !caja.hidden;
    pan.querySelector(".porDia").textContent = caja.hidden ? "Ajustar día por día" : "Ocultar los días";
    resumen.hidden = !caja.hidden;
  };

  /* Cargar la semana entera en un solo gesto: se escribe el horario una vez, se
     marcan los días y se aplica. Vienen marcados de martes a sábado, que es la
     semana del local; el lunes queda afuera porque no se abre todas las semanas y
     se marca desde la agenda, fecha por fecha. */
  pan.querySelectorAll(".chip-dia").forEach(c =>
    c.onclick = () => c.classList.toggle("on"));
  pan.querySelector(".udoble").onchange = () =>
    pan.querySelector(".ut2").hidden = !pan.querySelector(".udoble").checked;
  pan.querySelector(".aplicar").onclick = () => {
    const elegidos = [...pan.querySelectorAll(".chip-dia.on")].map(c => +c.dataset.d);
    if(!elegidos.length){ toast("Marcá a qué días"); return; }
    const tramos = [{desde: pan.querySelector(".ud1").value, hasta: pan.querySelector(".uh1").value}];
    if(pan.querySelector(".udoble").checked)
      tramos.push({desde: pan.querySelector(".ud2").value, hasta: pan.querySelector(".uh2").value});
    if(tramos.some(t => !t.desde || !t.hasta)){ toast("Completá las horas"); return; }
    // Se pisa solo lo marcado: los días que no se eligieron quedan como estaban,
    // así se puede aplicar la tanda y después corregir el sábado a mano.
    elegidos.forEach(i => poner(filas[i], tramos));
    pintarResumen();
    toast(`${elegidos.length} ${elegidos.length===1?"día":"días"} con ese horario · falta guardar`);
  };
  pan.querySelector(".cancelar").onclick = () => pan.remove();
  pan.querySelector(".guardar").onclick = async () => {
    const tramos = [];
    for(let i = 0; i < filas.length; i++){
      const f = filas[i];
      if(!f.querySelector(".trabaja").checked) continue;
      const d1 = f.querySelector(".d1").value, h1 = f.querySelector(".h1").value;
      if(!d1 || !h1){ toast(`Completá las horas del ${DIAS_SEM[i].toLowerCase()}`); return; }
      tramos.push({dia_semana: i, desde: d1, hasta: h1});
      if(f.querySelector(".doble").checked){
        const d2 = f.querySelector(".d2").value, h2 = f.querySelector(".h2").value;
        if(!d2 || !h2){ toast(`Completá el segundo tramo del ${DIAS_SEM[i].toLowerCase()}`); return; }
        tramos.push({dia_semana: i, desde: d2, hasta: h2});
      }
    }
    const r = await authFetch(`/api/horarios/${e.id}`, {method:"PUT",
      headers:{"Content-Type":"application/json"}, body: JSON.stringify({tramos})});
    if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo guardar"); return; }
    pan.remove();
    toast(tramos.length ? "Horario guardado" : "Quedó sin horario cargado");
  };
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

/* La semana del local en una grilla: filas las empleadas, columnas los días.

   Se mira, no se edita: para cambiar están la barra de arriba —ponerle el mismo
   horario a varias de una— y el panel de cada persona. Una celda que fuera un
   formulario se toca sin querer con el dedo, que es con lo que se usa esto.

   Sirve para lo que antes había que reconstruir abriendo panel por panel: quién
   abre el sábado, qué días no viene nadie, a qué hora hay una sola persona. */
function pintarGrillaHorarios(emps){
  const caja = $("#grillaHorario");
  if(!caja) return;
  const activas = emps.filter(e => e.activo);
  if(!activas.length){ caja.innerHTML = `<p class="muted">Todavía no hay nadie en la lista.</p>`; return; }

  const tramosDe = (e, d) => (HORARIOS[String(e.id)] || [])
    .filter(t => t.dia_semana === d)
    .sort((a,b) => a.desde.localeCompare(b.desde));
  // Un día en el que no trabaja nadie es el local cerrado, y se marca entero:
  // es la lectura que más se busca cuando se mira la semana.
  const cerrado = d => activas.every(e => !tramosDe(e, d).length);

  caja.innerHTML = `<div class="tabla-horario"><table>
    <thead><tr><th class="quien">Quién</th>${DIAS_SEM.map((d,i) =>
      `<th${cerrado(i) ? ' class="cerrado"' : ""}>${d.slice(0,3)}</th>`).join("")}</tr></thead>
    <tbody>${activas.map(e => `<tr data-emp="${e.id}">
      <td class="quien">${escHtml(e.nombre)}</td>${DIAS_SEM.map((_, i) => {
        const ts = tramosDe(e, i);
        return `<td class="${ts.length ? "" : "libre"}${cerrado(i) ? " cerrado" : ""}">${
          ts.length ? ts.map(t => `<span>${hm(t.desde)}–${hm(t.hasta)}</span>`).join("") : "—"}</td>`;
      }).join("")}</tr>`).join("")}</tbody></table></div>`;

  // Tocar una fila lleva a esa persona, que es donde se cambia su horario.
  caja.querySelectorAll("tbody tr").forEach(tr => {
    tr.onclick = () => {
      const e = activas.find(x => String(x.id) === tr.dataset.emp);
      const fila = [...document.querySelectorAll("#listaEmpleados .emp-fila")]
        .find(f => f.querySelector("b").textContent === e.nombre);
      if(!fila) return;
      cerrarPersona();
      fila.after(panelPersona(e));
      const pan = fila.nextElementSibling;
      pan.querySelector('.linea[data-tipo="horario"] button').click();
      pan.scrollIntoView({behavior:"smooth", block:"center"});
    };
  });
}

/* Ponerle el mismo horario a varias de una. Es el "para todas" del horario, y
   está arriba por lo mismo que el valor hora general: lo que alcanza a más
   gente va primero.

   Solo pisa los días elegidos: el resto de la semana de cada una queda como
   estaba. Mandar la semana entera con un solo tramo le borraría a Agustina el
   corte del mediodía sin avisar. */
function pintarBarraHorario(emps){
  const caja = $("#barraHorario");
  if(!caja) return;
  const activas = emps.filter(e => e.activo);
  caja.innerHTML = `
    <div class="de-una">
      <span class="rot">Ponerle el mismo horario a</span>
      <span class="chips quienes">${activas.map(e =>
        `<button type="button" class="chip-dia" data-emp="${e.id}">${escHtml(e.nombre)}</button>`).join("")}
        <button type="button" class="chip-dia todas">Todas</button></span>
      <span class="rot">los días</span>
      <span class="chips dias">${DIAS_SEM.map((d,i) =>
        `<button type="button" class="chip-dia" data-d="${i}">${d.slice(0,3)}</button>`).join("")}</span>
      <span class="tramo"><input type="time" class="bd1" value="08:00"><span class="a">a</span><input type="time" class="bh1" value="20:00"></span>
      <label class="marca corta"><input type="checkbox" class="bdoble"> corta al mediodía</label>
      <span class="tramo bt2" hidden><input type="time" class="bd2" value="16:00"><span class="a">a</span><input type="time" class="bh2" value="20:00"></span>
      <button class="b-tinta aplicar" disabled>Aplicar</button>
    </div>
    <p class="muted resumen-barra" style="margin:var(--sp-2) 0 0;">Elegí a quién y qué días. Solo se
      cambian esos días; el resto de la semana de cada una queda como está.</p>`;

  const sel = s => caja.querySelector(s), todos = s => [...caja.querySelectorAll(s)];
  const elegidas = () => todos(".quienes .chip-dia.on[data-emp]").map(b => Number(b.dataset.emp));
  const diasSel  = () => todos(".dias .chip-dia.on").map(b => Number(b.dataset.d));
  const aplicar = sel(".aplicar");

  const repintar = () => {
    const q = elegidas().length, d = diasSel().length;
    aplicar.disabled = !q || !d;
    sel(".resumen-barra").textContent = (!q || !d)
      ? "Elegí a quién y qué días. Solo se cambian esos días; el resto de la semana de cada una queda como está."
      : `Le cambia ${d === 1 ? "1 día" : d + " días"} a ${q === 1 ? "1 persona" : q + " personas"}. El resto de su semana queda como está.`;
    sel(".todas").classList.toggle("on", q === activas.length && q > 0);
  };

  todos(".quienes .chip-dia[data-emp], .dias .chip-dia").forEach(b =>
    b.onclick = () => { b.classList.toggle("on"); repintar(); });
  sel(".todas").onclick = () => {
    const prender = elegidas().length !== activas.length;
    todos(".quienes .chip-dia[data-emp]").forEach(b => b.classList.toggle("on", prender));
    repintar();
  };
  sel(".bdoble").onchange = () => { sel(".bt2").hidden = !sel(".bdoble").checked; };

  aplicar.onclick = async () => {
    const dias = diasSel(), ids = elegidas();
    const tramo1 = {desde: sel(".bd1").value, hasta: sel(".bh1").value};
    const tramos = [tramo1];
    if(sel(".bdoble").checked) tramos.push({desde: sel(".bd2").value, hasta: sel(".bh2").value});
    for(const t of tramos){
      if(!t.desde || !t.hasta || t.hasta <= t.desde){ toast("Revisá las horas: la de salida va después"); return; }
    }
    const nombres = ids.map(id => (emps.find(e => e.id === id) || {}).nombre).filter(Boolean);
    if(!confirm(`Se les pone ${tramos.map(t => `${hm(t.desde)} a ${hm(t.hasta)}`).join(" y ")} `
      + `los ${dias.map(d => DIAS_SEM[d].toLowerCase()).join(", ")} a: ${nombres.join(", ")}.\n\n`
      + `Lo que tuvieran esos días se reemplaza. El resto de la semana no se toca.`)) return;

    aplicar.disabled = true;
    let listas = 0;
    for(const id of ids){
      const quedan = (HORARIOS[String(id)] || []).filter(t => !dias.includes(t.dia_semana));
      const nuevos = dias.flatMap(d => tramos.map(t => ({dia_semana: d, desde: t.desde, hasta: t.hasta})));
      const r = await authFetch(`/api/horarios/${id}`, {method:"PUT",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({tramos: [...quedan.map(t => ({dia_semana: t.dia_semana, desde: t.desde, hasta: t.hasta})), ...nuevos]})});
      if(r.ok) listas++;
      else toast((await r.json().catch(()=>({}))).detail || "No se pudo con alguna");
    }
    toast(`Horario puesto a ${listas} ${listas === 1 ? "persona" : "personas"}`);
    await cargarEmpleados();
  };
  repintar();
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

