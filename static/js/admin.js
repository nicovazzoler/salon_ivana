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
      </span>
      <span class="acc">
        <button class="b-tinta guardar">Guardar</button>
        <button class="b-del borrar">Eliminar</button>
      </span>`;
    row.querySelector(".guardar").onclick=async()=>{
      await authFetch(`/api/items/${it.id}`,{method:"PUT",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({nombre:row.querySelector(".n").value,precio:parseInt(row.querySelector(".p").value)})});
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
    body:JSON.stringify({categoria:cat,nombre:nom,precio:pre,es_producto:$("#nProd").checked})});
  $("#nNom").value="";$("#nPre").value="";$("#nProd").checked=false;
  toast("Ítem agregado");await cargarCats();
};

$("#btnRenombrar").onclick=async()=>{
  const nuevo=prompt(`Renombrar la categoría "${catActual}" a:`,catActual);
  if(!nuevo||nuevo.trim()===catActual)return;
  await authFetch("/api/categorias",{method:"PUT",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({viejo:catActual,nuevo:nuevo.trim()})});
  toast("Categoría renombrada");await cargarCats();
};

/* ---------- Las cinco listas ----------

   El dibujante y la configuración de cada lista viven en /static/js/listas.js,
   porque Facturar usa lo mismo desde el lapicito que hay al lado de cada
   desplegable. Acá solo se dice dónde va cada una. */
["formas","tipos","descuentos","ajustes","alias"].forEach(nombre =>
  Listas.dibujar("#lista" + {formas:"Formas", tipos:"Tipos", descuentos:"Descuentos",
                             ajustes:"Ajustes", alias:"Alias"}[nombre], nombre));

// --- Usuarios ---
async function cargarUsuarios(){
  const us=await (await authFetch("/api/usuarios")).json();
  const cont=$("#listaUsuarios");cont.innerHTML="";
  us.forEach(u=>{
    const row=document.createElement("div");row.className="item-row usuario";
    row.innerHTML=`
      <input class="uNombre" value="${u.usuario}">
      <select class="uRolEd">
        <option value="empleado"${u.rol==="empleado"?" selected":""}>Empleado</option>
        <option value="dueno"${u.rol==="dueno"?" selected":""}>Dueño</option>
      </select>
      <input class="uClave" type="text" placeholder="nueva clave (opcional)">
      <span class="acc">
        <button class="b-tinta guardarU">Guardar</button>
        <button class="b-del borrarU">Eliminar</button>
      </span>`;
    row.querySelector(".guardarU").onclick=async()=>{
      const cambios={usuario:row.querySelector(".uNombre").value.trim(), rol:row.querySelector(".uRolEd").value};
      const cl=row.querySelector(".uClave").value;
      if(cl) cambios.password=cl;
      const r=await authFetch(`/api/usuarios/${u.id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(cambios)});
      if(!r.ok){const e=await r.json();toast(e.detail||"No se pudo");return;}
      toast("Usuario actualizado");cargarUsuarios();
    };
    row.querySelector(".borrarU").onclick=async()=>{
      if(!confirm(`¿Eliminar al usuario "${u.usuario}"?`))return;
      const r=await authFetch(`/api/usuarios/${u.id}`,{method:"DELETE"});
      if(!r.ok){const e=await r.json();toast(e.detail||"No se pudo");return;}
      toast("Eliminado");cargarUsuarios();
    };
    cont.appendChild(row);
  });
}
if(DUENO) $("#btnUsuario").onclick=async()=>{
  const u=$("#uNom").value.trim(),p=$("#uPass").value;
  if(!u||!p){toast("Completá usuario y contraseña");return;}
  const r=await authFetch("/api/usuarios",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({usuario:u,password:p,rol:$("#uRol").value})});
  if(!r.ok){const e=await r.json();toast(e.detail||"No se pudo");return;}
  $("#uNom").value="";$("#uPass").value="";toast("Usuario creado");cargarUsuarios();
};
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

