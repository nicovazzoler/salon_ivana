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

function toast(m){const t=$("#toast");t.textContent=m;t.classList.add("show");setTimeout(()=>t.classList.remove("show"),2200);}

async function cargarCats(){
  const cats=await (await authFetch("/api/categorias")).json();
  $("#selCat").innerHTML=cats.map(c=>`<option>${c}</option>`).join("");
  $("#cats").innerHTML=cats.map(c=>`<option value="${c}">`).join("");
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

function renderItems(items, mostrarCat){
  const cont=$("#listaItems");
  if(items.length===0){cont.innerHTML='<p class="muted">Sin ítems para mostrar.</p>';return;}
  cont.innerHTML="";
  items.forEach(it=>{
    const row=document.createElement("div");row.className="item-row";
    const cat = mostrarCat ? `<span class="tag neutro">${it.categoria}</span>` : "";
    row.innerHTML=`
      <input class="n" value="${it.nombre.replace(/"/g,'&quot;')}">
      <input class="p" type="number" value="${it.precio}">
      <span class="meta">
        <span style="white-space:nowrap;">→ transf ${fmt(it.precio_transfer||0)}</span>
        ${cat}${it.es_producto?'<span class="tag">prod</span>':''}
        <label class="chk-com" title="La empleada que lo haga cobra comisión por este trabajo">
          <input type="checkbox" class="com" ${it.es_comision?"checked":""}> comisión
        </label>
      </span>
      <span class="acc">
        <button class="b-tinta guardar">Guardar</button>
        <button class="b-del borrar">Eliminar</button>
      </span>`;
    row.querySelector(".guardar").onclick=async()=>{
      // La comisión va en el mismo Guardar que el precio y el nombre: es una
      // propiedad del ítem, y separarla en su propio botón haría que se guarde
      // el precio y se pierda la marca sin que nada avise.
      await authFetch(`/api/items/${it.id}`,{method:"PUT",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({nombre:row.querySelector(".n").value,precio:parseInt(row.querySelector(".p").value),
                             es_comision:row.querySelector(".com").checked})});
      toast("Guardado"); ITEMS_ALL=await (await authFetch("/api/items/all")).json();
    };
    row.querySelector(".borrar").onclick=async()=>{
      if(!confirm(`¿Eliminar "${it.nombre}"?`))return;
      await authFetch(`/api/items/${it.id}`,{method:"DELETE"});
      toast("Eliminado"); ITEMS_ALL=await (await authFetch("/api/items/all")).json();
      filtrarItems();
    };
    cont.appendChild(row);
  });
}

$("#btnAgregar").onclick=async()=>{
  const cat=$("#nCat").value.trim(),nom=$("#nNom").value.trim(),pre=parseInt($("#nPre").value);
  if(!cat||!nom||!pre){toast("Completá categoría, nombre y precio");return;}
  await authFetch("/api/items",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({categoria:cat,nombre:nom,precio:pre,es_producto:$("#nProd").checked,
                         es_comision:$("#nCom").checked})});
  $("#nNom").value="";$("#nPre").value="";$("#nProd").checked=false;$("#nCom").checked=false;
  toast("Ítem agregado");await cargarCats();
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

["#listaItems","#listaUsuarios"].forEach(sel=>{
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

