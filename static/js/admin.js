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

async function cargarFormas(){
  const formas=await (await authFetch("/api/formas")).json();
  const cont=$("#listaFormas");cont.innerHTML="";
  formas.forEach(f=>{
    const row=document.createElement("div");row.className="item-row simple";
    row.innerHTML=`<span class="n">${f.nombre}</span><button class="b-del">Eliminar</button>`;
    row.querySelector("button").onclick=async()=>{
      await authFetch(`/api/formas/${f.id}`,{method:"DELETE"});toast("Eliminada");cargarFormas();
    };
    cont.appendChild(row);
  });
}
$("#btnForma").onclick=async()=>{
  const n=$("#nForma").value.trim();if(!n){return;}
  await authFetch("/api/formas",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({nombre:n})});
  $("#nForma").value="";toast("Forma agregada");cargarFormas();
};

/* --- Tipos de egreso ---

   La marca de "privado" solo la ve y la toca la dueña. Es el interruptor que
   contesta el pedido de anotar el alquiler y los sueldos sin que el empleado los
   vea: el tipo desaparece de su desplegable al facturar y lo que se anote con él
   no entra en los totales de su caja. */
async function cargarTipos(){
  const tipos=await (await authFetch("/api/tipos-egreso")).json();
  const cont=$("#listaTipos");cont.innerHTML="";
  tipos.forEach(t=>{
    const row=document.createElement("div");row.className="item-row simple"+(DUENO?" con-marca":"");
    const marca = DUENO
      ? `<label class="marca-privado" title="No se le muestra al empleado">
           <input type="checkbox" class="priv"${t.privado?" checked":""}> privado</label>`
      : "";
    row.innerHTML=`<span class="n">${esc(t.nombre)}</span>${marca}<button class="b-del">Eliminar</button>`;
    const chk=row.querySelector(".priv");
    if(chk) chk.onchange=async()=>{
      const r=await authFetch(`/api/tipos-egreso/${t.id}`,{method:"PUT",
        headers:{"Content-Type":"application/json"},body:JSON.stringify({privado:chk.checked})});
      if(!r.ok){ chk.checked=!chk.checked; toast("No se pudo"); return; }
      toast(chk.checked ? "El empleado ya no ve este tipo" : "Tipo visible para todos");
      cargarTipos();
    };
    row.querySelector(".b-del").onclick=async()=>{await authFetch(`/api/tipos-egreso/${t.id}`,{method:"DELETE"});toast("Eliminado");cargarTipos();};
    cont.appendChild(row);
  });
}
$("#btnTipo").onclick=async()=>{
  const n=$("#nTipo").value.trim();if(!n)return;
  await authFetch("/api/tipos-egreso",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({nombre:n})});
  $("#nTipo").value="";toast("Tipo agregado");cargarTipos();
};


// --- Descuentos ---

async function cargarDescuentos(){
  const ds = await (await authFetch("/api/descuentos")).json();
  const cont = $("#listaDescuentos"); cont.innerHTML = "";
  if(ds.length === 0){ cont.innerHTML = '<p class="muted">Todavía no hay descuentos.</p>'; }
  ds.forEach(d => {
    const row = document.createElement("div"); row.className = "item-row simple";
    const motivo = d.mostrar_motivo ? ' · <span class="tag neutro">muestra motivo</span>' : '';
    row.innerHTML = `<span class="n">${esc(d.nombre)} — ${d.porcentaje}%${motivo}</span><button class="b-del">Eliminar</button>`;
    row.querySelector("button").onclick = async () => {
      await authFetch(`/api/descuentos/${d.id}`, {method:"DELETE"});
      toast("Eliminado"); cargarDescuentos();
    };
    cont.appendChild(row);
  });
}

$("#btnDesc").onclick = async () => {
  const nombre = $("#nDescNombre").value.trim();
  const porcentaje = parseInt($("#nDescPct").value);
  if(!nombre){ toast("Falta el nombre"); return; }
  if(isNaN(porcentaje) || porcentaje < 0 || porcentaje > 100){ toast("Porcentaje inválido (0 a 100)"); return; }
  await authFetch("/api/descuentos", {method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ nombre, porcentaje, mostrar_motivo: $("#nDescMotivo").checked })});
  $("#nDescNombre").value = ""; $("#nDescPct").value = ""; $("#nDescMotivo").checked = false;
  toast("Descuento agregado"); cargarDescuentos();
};


// --- Ajustes por ítem (descuento o recargo de una línea) ---
async function cargarAjustes(){
  const ajs = await (await authFetch("/api/ajustes-item")).json();
  const cont = $("#listaAjustes"); cont.innerHTML = "";
  if(ajs.length === 0){ cont.innerHTML = '<p class="muted">Todavía no hay ajustes cargados.</p>'; return; }
  ajs.forEach(a => {
    const row = document.createElement("div"); row.className = "item-row simple";
    // El ajuste es en pesos o en porcentaje, nunca en los dos a la vez.
    const enPesos = !!a.monto;
    const valor = enPesos ? a.monto : a.porcentaje;
    const esDesc = valor < 0;
    const signo = esDesc ? "−" : "+";
    const cuanto = enPesos ? signo+fmt(Math.abs(a.monto))+" c/u" : signo+Math.abs(a.porcentaje)+"%";
    row.innerHTML = `<span class="n">${esc(a.nombre)}
        <span class="tag ${esDesc?'neutro':''}">${cuanto}</span>
        <span class="muted">${esDesc?'descuento':'recargo'}</span></span>
      <button class="b-del">Eliminar</button>`;
    row.querySelector("button").onclick = async () => {
      await authFetch(`/api/ajustes-item/${a.id}`, {method:"DELETE"});
      toast("Eliminado"); cargarAjustes();
    };
    cont.appendChild(row);
  });
}

/* El campo del valor cambia de nombre y de tope según la unidad: el porcentaje
   va de 1 a 100, los pesos no tienen tope. */
$("#nAjUnidad").onchange = () => {
  const enPesos = $("#nAjUnidad").value === "$";
  $("#nAjLabel").textContent = enPesos ? "Monto por unidad" : "Porcentaje";
  const inp = $("#nAjPct");
  inp.placeholder = enPesos ? "2000" : "10";
  if(enPesos) inp.removeAttribute("max"); else inp.max = 100;
};

$("#btnAjuste").onclick = async () => {
  const nombre = $("#nAjNombre").value.trim();
  const magnitud = parseInt($("#nAjPct").value);
  const enPesos = $("#nAjUnidad").value === "$";
  if(!nombre){ toast("Falta el nombre"); return; }
  if(isNaN(magnitud) || magnitud <= 0){ toast("Poné un valor mayor a 0"); return; }
  if(!enPesos && magnitud > 100){ toast("Porcentaje inválido (1 a 100)"); return; }
  // el signo lo pone el desplegable: adentro se guarda negativo si descuenta
  const valor = $("#nAjSigno").value === "-" ? -magnitud : magnitud;
  const r = await authFetch("/api/ajustes-item", {method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ nombre, porcentaje: enPesos ? 0 : valor, monto: enPesos ? valor : 0 })});
  if(!r.ok){ const e = await r.json(); toast(e.detail || "No se pudo"); return; }
  $("#nAjNombre").value = ""; $("#nAjPct").value = "";
  toast("Ajuste agregado"); cargarAjustes();
};


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

// --- Alias de transferencia ---
async function cargarAlias(){
  const al=await (await authFetch("/api/alias")).json();
  const cont=$("#listaAlias");cont.innerHTML="";
  if(al.length===0){cont.innerHTML='<p class="muted">Sin alias cargados.</p>';}
  al.forEach(a=>{
    const row=document.createElement("div");row.className="item-row simple";
    row.innerHTML=`<span class="n">${a.nombre}</span><button class="b-del">Eliminar</button>`;
    row.querySelector("button").onclick=async()=>{await authFetch(`/api/alias/${a.id}`,{method:"DELETE"});toast("Eliminado");cargarAlias();};
    cont.appendChild(row);
  });
}
$("#btnAlias").onclick=async()=>{
  const n=$("#nAlias").value.trim();if(!n)return;
  await authFetch("/api/alias",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({nombre:n})});
  $("#nAlias").value="";toast("Alias agregado");cargarAlias();
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

["#listaItems","#listaFormas","#listaTipos",
 "#listaDescuentos","#listaAjustes","#listaUsuarios","#listaAlias"].forEach(sel=>{
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

cargarCats();cargarFormas();cargarTipos();cargarAlias();cargarDescuentos();cargarAjustes();
if(DUENO) cargarUsuarios();

