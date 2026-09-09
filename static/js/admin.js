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
/* Dos modos para la misma lista.

   Leyendo, que es como se entra casi siempre —a mirar un precio—, la fila no
   tiene ni un casillero abierto: un campo abierto invita a escribir, y un precio
   cambiado sin querer se cobra.

   Editando, que es cuando hay que actualizar precios y son veinte de una
   sentada, se abren todos juntos como estaban antes. Ir de a uno ahí es abrir y
   cerrar veinte paneles. */
let modoEdicion=false;

function toast(m){const t=$("#toast");t.textContent=m;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2200);}

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
  if($("#buscarItem").value.trim()) filtrarItems(); else cargarItems();
}

$("#selCat").onchange=()=>{catActual=$("#selCat").value;$("#buscarItem").value="";cargarItems();};
$("#buscarItem").oninput=filtrarItems;

function filtrarItems(){
  const q=$("#buscarItem").value.trim().toLowerCase();
  if(!q){ cargarItems(); return; }
  const f=ITEMS_ALL.filter(i=>i.nombre.toLowerCase().includes(q));
  renderItems(f, true);
}

async function cargarItems(){
  const items=await (await authFetch("/api/items?categoria="+encodeURIComponent(catActual))).json();
  renderItems(items, false);
}

/* El catálogo se dibuja para LEER: nombre, precio y las marcas. Los casilleros
   aparecen cuando se toca Editar, y de a uno por vez.

   Antes cada renglón tenía el nombre y el precio en campos habilitados, con
   Guardar y Eliminar al lado. Con veinte ítems eran cuarenta campos abiertos en
   una pantalla a la que casi siempre se entra a mirar un precio, y el que se
   quería tocar había que encontrarlo entre los otros treinta y nueve. Peor: un
   campo abierto invita a escribir, y un precio cambiado sin querer se cobra. */
function renderItems(items, mostrarCat){
  const cont=$("#listaItems");
  cerrarPaneles();
  if(items.length===0){cont.innerHTML='<p class="muted">Sin ítems para mostrar.</p>';return;}
  cont.innerHTML="";
  if(modoEdicion){ renderItemsEditables(items, mostrarCat); return; }
  items.forEach(it=>{
    const fila=document.createElement("div"); fila.className="item-fila";

    const nom=document.createElement("span"); nom.className="n";
    nom.textContent=it.nombre;                 // textContent y no innerHTML: el
                                               // nombre lo escribe una persona
    const meta=document.createElement("span"); meta.className="meta";
    const partes=[fmt(it.precio), `transf ${fmt(it.precio_transfer||0)}`];
    if(mostrarCat) partes.push(it.categoria);
    if(it.es_producto) partes.push("producto");
    if(it.es_comision) partes.push("comisión");
    meta.textContent = partes.join(" · ");

    const quien=document.createElement("span"); quien.className="quien";
    quien.append(nom, meta);

    const acc=document.createElement("span"); acc.className="acc";
    const bEd=Object.assign(document.createElement("button"),
                            {className:"b-out", textContent:"Editar"});
    acc.appendChild(bEd);
    fila.append(quien, acc);
    cont.appendChild(fila);

    // Un solo panel abierto por vez en toda la pantalla: dos formularios
    // abiertos a la vez son otra vez el problema que se quería sacar.
    bEd.onclick=()=>{
      const yaEstaba = fila.nextElementSibling?.classList.contains("panel-edicion");
      cerrarPaneles();
      if(yaEstaba) return;                     // el mismo botón cierra lo que abrió
      fila.after(panelItem(it));
    };
  });
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
  const filas=[];
  items.forEach(it=>{
    const row=document.createElement("div"); row.className="item-row";
    const cat = mostrarCat ? `<span class="tag neutro">${esc(it.categoria)}</span>` : "";
    row.innerHTML=`
      <input class="n" value="${esc(it.nombre)}" aria-label="Nombre">
      <input class="p" type="number" min="0" value="${it.precio}" aria-label="Precio efectivo">
      <span class="meta">
        <span class="transf" style="white-space:nowrap;">→ transf ${fmt(it.precio_transfer||0)}</span>
        ${cat}${it.es_producto?'<span class="tag">prod</span>':''}
        <label class="chk-com" title="La empleada que lo haga cobra comisión por este trabajo">
          <input type="checkbox" class="com" ${it.es_comision?"checked":""}> comisión
        </label>
      </span>
      <span class="acc"></span>`;
    const leer=()=>({nombre:row.querySelector(".n").value.trim(),
                     precio:parseInt(row.querySelector(".p").value,10),
                     es_comision:row.querySelector(".com").checked});
    const original=JSON.stringify(leer());
    const marcar=()=>{
      const sucia = JSON.stringify(leer())!==original;
      row.classList.toggle("sucia", sucia);
      // El de transferencia lo calcula el servidor al guardar. Mientras el
      // precio está tocado, el que se ve al lado es el viejo: mostrarlo pegado a
      // un efectivo nuevo se lee como si fueran los dos de ahora. Y calcularlo
      // acá sería tener la cuenta de la plata escrita en dos lugares.
      row.querySelector(".transf").textContent = sucia
        ? "→ transf: se calcula al guardar"
        : `→ transf ${fmt(it.precio_transfer||0)}`;
      pintarBarra();
    };
    row.querySelectorAll("input").forEach(el=>{
      el.addEventListener("input", marcar); el.addEventListener("change", marcar);
    });
    cont.appendChild(row);
    filas.push({it, row, leer, sucia:()=>row.classList.contains("sucia")});
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

  function pintarBarra(){
    const cuantos=filas.filter(f=>f.sucia()).length;
    btn.style.display = cuantos ? "" : "none";
    btn.textContent = `Guardar ${cuantos} ${cuantos===1?"cambio":"cambios"}`;
    nota.textContent = cuantos
      ? "Sin guardar todavía."
      : "Tocá los precios o los nombres que haya que cambiar y guardalos todos juntos.";
  }

  async function guardarTodos(){
    const cambiadas=filas.filter(f=>f.sucia());
    const malos=[];
    for(const f of cambiadas){
      const v=f.leer();
      if(!v.nombre || !(v.precio>0)){ malos.push(f.it.nombre + " (nombre o precio vacío)"); continue; }
      const r=await authFetch(`/api/items/${f.it.id}`,{method:"PUT",
        headers:{"Content-Type":"application/json"}, body:JSON.stringify(v)});
      if(!r.ok) malos.push(f.it.nombre);
    }
    if(malos.length) toast("No se pudieron guardar: " + malos.join(", "));
    else toast(`${cambiadas.length} ${cambiadas.length===1?"ítem guardado":"ítems guardados"}`);
    ITEMS_ALL=await (await authFetch("/api/items/all")).json();
    await cargarCats();          // redibuja con los precios de transferencia nuevos
  }

  pintarBarra();
}

/* El botón que cambia de modo. Al apagarlo se redibuja de cero: si quedó algo
   tipeado sin guardar, la lista vuelve a mostrar lo que está en la base y no lo
   que se había escrito, que es lo que corresponde ver cuando se está leyendo. */
$("#btnEditarTodos").onclick=async()=>{
  const pendientes=document.querySelectorAll("#listaItems .item-row.sucia").length;
  if(modoEdicion && pendientes &&
     !confirm(`Hay ${pendientes} ${pendientes===1?"cambio":"cambios"} sin guardar.\n\n¿Salir igual y perderlos?`)) return;
  modoEdicion=!modoEdicion;
  const b=$("#btnEditarTodos");
  b.textContent = modoEdicion ? "✓ Listo" : "✏️ Editar todos";
  b.className = modoEdicion ? "b-tinta" : "b-out";
  $("#panelNuevoItem").innerHTML="";
  cerrarPaneles();
  if($("#buscarItem").value.trim()) filtrarItems(); else await cargarItems();
};

// Uno solo abierto en toda la tarjeta, el de crear incluido.
function cerrarPaneles(){
  document.querySelectorAll("#catalogo .panel-edicion").forEach(p=>p.remove());
}

/* El panel de edición de un ítem. Todo lo del ítem junto y un solo Guardar: el
   precio y la marca de comisión son del mismo ítem, y con un botón por campo se
   guarda uno y se pierde el otro sin que nada avise. */
function panelItem(it){
  const pan=document.createElement("div");
  pan.className="panel-edicion";
  pan.innerHTML=`
    <div class="campo"><label>Nombre</label><input class="f-nombre" type="text"></div>
    <div class="campo chico"><label>Precio efectivo</label><input class="f-precio" type="number" min="0"></div>
    <div class="campo chico"><label>Categoría</label><input class="f-cat" list="cats"></div>
    <div class="marcas">
      <label><input type="checkbox" class="f-prod"> Es producto (descuenta stock)</label>
      <label><input type="checkbox" class="f-com"> Va a comisión</label>
    </div>
    <span class="acc">
      <button class="b-ok guardar">Guardar</button>
      <button class="b-out cancelar">Cancelar</button>
      <button class="b-del borrar">Eliminar</button>
    </span>`;
  const $$=s=>pan.querySelector(s);
  $$(".f-nombre").value=it.nombre;
  $$(".f-precio").value=it.precio;
  $$(".f-cat").value=it.categoria||catActual;
  $$(".f-prod").checked=!!it.es_producto;
  $$(".f-com").checked=!!it.es_comision;

  $$(".cancelar").onclick=()=>pan.remove();
  $$(".guardar").onclick=async()=>{
    const nombre=$$(".f-nombre").value.trim();
    const precio=parseInt($$(".f-precio").value,10);
    const categoria=$$(".f-cat").value.trim();
    if(!nombre){ toast("El nombre no puede quedar vacío"); return; }
    if(!(precio>0)){ toast("El precio tiene que ser mayor a 0"); return; }
    if(!categoria){ toast("Falta la categoría"); return; }
    const r=await authFetch(`/api/items/${it.id}`,{method:"PUT",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({nombre, precio, categoria,
                           es_producto:$$(".f-prod").checked, es_comision:$$(".f-com").checked})});
    if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo guardar"); return; }
    toast("Guardado");
    ITEMS_ALL=await (await authFetch("/api/items/all")).json();
    await cargarCats();
  };
  $$(".borrar").onclick=async()=>{
    if(!confirm(`¿Eliminar "${it.nombre}"?\n\nDeja de aparecer al facturar. Los tickets viejos que lo tienen no se tocan.`)) return;
    const r=await authFetch(`/api/items/${it.id}`,{method:"DELETE"});
    if(!r.ok){ toast("No se pudo eliminar"); return; }
    toast("Eliminado");
    ITEMS_ALL=await (await authFetch("/api/items/all")).json();
    await cargarCats();
  };
  $$(".f-nombre").addEventListener("keydown", ev=>{
    if(ev.key==="Enter") $$(".guardar").click();
    if(ev.key==="Escape") pan.remove();
  });
  setTimeout(()=>$$(".f-nombre").focus(), 0);
  return pan;
}

/* Cargar uno nuevo. Mismo panel que el de editar, pero vacío y colgado del
   botón de arriba en vez de una fila. */
$("#btnNuevoItem").onclick=()=>{
  const caja=$("#panelNuevoItem");
  if(caja.firstChild){ caja.innerHTML=""; return; }   // el mismo botón lo cierra
  cerrarPaneles();
  const pan=document.createElement("div");
  pan.className="panel-edicion crear";
  pan.innerHTML=`
    <div class="campo"><label>Nombre</label><input class="f-nombre" placeholder="Ej: Corte nuevo"></div>
    <div class="campo chico"><label>Precio efectivo</label><input class="f-precio" type="number" min="0" placeholder="0"></div>
    <div class="campo chico"><label>Categoría</label><input class="f-cat" list="cats" placeholder="existente o nueva"></div>
    <div class="marcas">
      <label><input type="checkbox" class="f-prod"> Es producto (descuenta stock)</label>
      <label><input type="checkbox" class="f-com"> Va a comisión</label>
    </div>
    <span class="acc">
      <button class="b-ok guardar">Agregar</button>
      <button class="b-out cancelar">Cancelar</button>
    </span>`;
  const $$=s=>pan.querySelector(s);
  $$(".f-cat").value=catActual||"";            // la que se está mirando, que es
                                               // casi siempre donde va el nuevo
  $$(".cancelar").onclick=()=>{ caja.innerHTML=""; };
  $$(".guardar").onclick=async()=>{
    const nombre=$$(".f-nombre").value.trim();
    const precio=parseInt($$(".f-precio").value,10);
    const categoria=$$(".f-cat").value.trim();
    if(!categoria||!nombre||!(precio>0)){ toast("Completá categoría, nombre y precio"); return; }
    const r=await authFetch("/api/items",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({categoria, nombre, precio,
                           es_producto:$$(".f-prod").checked, es_comision:$$(".f-com").checked})});
    if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo agregar"); return; }
    toast("Ítem agregado");
    caja.innerHTML="";
    catActual=categoria;                        // que quede mirando donde cayó
    $("#buscarItem").value="";
    await cargarCats();
  };
  $$(".f-nombre").addEventListener("keydown", ev=>{
    if(ev.key==="Enter") $$(".guardar").click();
    if(ev.key==="Escape") caja.innerHTML="";
  });
  caja.appendChild(pan);
  setTimeout(()=>$$(".f-nombre").focus(), 0);
};

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
    <label>${esClave ? "Contraseña nueva" : "Nombre de usuario"}</label>
    <input class="valor" type="text">
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
    <input class="cPass" type="text" placeholder="contraseña inicial">
    ${libres.length > 1
      ? `<select class="cRol">${libres.map(r => `<option value="${r}">${ROTULO_ROL[r]}</option>`).join("")}</select>`
      : ""}
    <span class="acc"><button class="b-ok crear">Crear</button></span>`;

  caja.querySelector(".crear").onclick = async () => {
    const nom = caja.querySelector(".cNom").value.trim();
    const pass = caja.querySelector(".cPass").value;
    if (!nom || !pass) { toast("Completá usuario y contraseña"); return; }
    const rol = libres.length > 1 ? caja.querySelector(".cRol").value : libres[0];
    const r = await authFetch("/api/usuarios", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({usuario: nom, password: pass, rol})});
    if (!r.ok) { const e = await r.json(); toast(e.detail || "No se pudo"); return; }
    toast("Usuario creado"); cargarUsuarios();
  };
  cont.appendChild(caja);
}

$("#btnMiPass").onclick=async()=>{
  const p=$("#miPass").value;if(!p){toast("Escribí la nueva contraseña");return;}
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
  const filas = [...cont.children];
  if(filas.length <= TOPE_FILAS) return;
  const cinco = filas[TOPE_FILAS].offsetTop - filas[0].offsetTop;
  cont.style.maxHeight = (cinco + ASOMO) + "px";
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
const LISTA_EMPLEADOS = $("#listaEmpleados")
  ? Listas.dibujar("#listaEmpleados", "empleados", () => cargarFusion())
  : null;

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
  await LISTA_EMPLEADOS?.recargar();
  await cargarFusion();
};
if($("#fusionEmpleados")) cargarFusion();

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

