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

/* ---------- Listas de Admin ----------

   Las cinco listas —formas de pago, tipos de egreso, descuentos, ajustes por
   ítem y alias— hacían lo mismo con cinco copias del mismo código y cinco
   formas distintas de cargar un nombre: un renglón de solo lectura con un botón
   de Eliminar, y abajo de todo, después de una línea, un formulario aparte.
   Para corregir una letra había que borrar y volver a cargar.

   Ahora las cinco (y el catálogo, que ya era así) funcionan igual:

     - Cada fila se edita donde está. Se toca, se escribe, Guardar.
     - Lo nuevo se carga ARRIBA, no al final. Y los rótulos de esa primera fila
       hacen de encabezado de las columnas de abajo, que se alinean con ella:
       un solo lugar donde dice qué es cada campo.
     - Se dibuja todo desde acá, así una lista nueva son diez líneas de
       configuración y no otra copia del mismo código.
*/
function listaEditable(cfg){
  const cont = $(cfg.cont);
  if(!cont) return { recargar: async()=>{} };

  /* La grilla se arma con los anchos que declara cada campo. Van en píxeles y no
     en "auto" a propósito: cada fila tiene su propia grilla, así que una columna
     "auto" mide distinto arriba (donde está el rótulo "Mostrar motivo") que
     abajo (donde está solo la casilla), y las columnas dejarían de alinearse.
     La última es la de los botones, que reserva su ancho desde el CSS. */
  const cols = cfg.campos.map(c => c.ancho || "minmax(0,1fr)").join(" ") + " auto";

  function control(campo, valor){
    const v = valor ?? "";
    if(campo.tipo === "check")
      return `<input type="checkbox" data-k="${campo.k}"${v ? " checked" : ""}>`;
    if(campo.tipo === "select")
      return `<select data-k="${campo.k}">` + campo.opciones.map(o =>
        `<option value="${o.v}"${String(o.v)===String(v)?" selected":""}>${esc(o.txt)}</option>`).join("") + `</select>`;
    const num = campo.tipo === "numero";
    return `<input data-k="${campo.k}" type="${num?"number":"text"}"`
         + `${campo.min!==undefined?` min="${campo.min}"`:""}${campo.max!==undefined?` max="${campo.max}"`:""}`
         + ` placeholder="${esc(campo.placeholder||"")}" value="${esc(v)}">`;
  }

  // Lee lo que hay tipeado en una fila y lo devuelve como objeto.
  function leer(fila){
    const vals = {};
    cfg.campos.forEach(c => {
      const el = fila.querySelector(`[data-k="${c.k}"]`);
      if(!el) return;
      vals[c.k] = c.tipo === "check" ? el.checked
                : c.tipo === "numero" ? (el.value === "" ? null : parseInt(el.value))
                : el.value.trim();
    });
    return vals;
  }

  async function mandar(metodo, ruta, cuerpo){
    const r = await authFetch(ruta, {method:metodo, headers:{"Content-Type":"application/json"},
                                     body: JSON.stringify(cuerpo)});
    if(!r.ok){
      let detalle = "No se pudo";
      try{ detalle = (await r.json()).detail || detalle; }catch(e){}
      toast(detalle);
      return false;
    }
    return true;
  }

  async function recargar(){
    const datos = await (await authFetch(cfg.ruta)).json();
    cont.innerHTML = "";

    // --- la fila de arriba: cargar uno nuevo ---
    const nueva = document.createElement("div");
    nueva.className = "fila-lista nueva";
    nueva.style.gridTemplateColumns = cols;
    nueva.innerHTML = cfg.campos.map(c =>
        `<span class="celda"><label>${esc(c.etiqueta)}</label>${control(c, c.inicial)}</span>`).join("")
      + `<span class="acc"><button class="b-ok agregar">Agregar</button></span>`;
    nueva.querySelector(".agregar").onclick = async () => {
      const vals = leer(nueva);
      const cuerpo = cfg.aCuerpo ? cfg.aCuerpo(vals) : vals;
      if(cuerpo === null) return;                 // el propio armador ya avisó qué falta
      if(!await mandar("POST", cfg.ruta, cuerpo)) return;
      toast("Agregado");
      await recargar();
      if(cfg.alCambiar) cfg.alCambiar();
      nueva.querySelector("input,select")?.focus();
    };
    cont.appendChild(nueva);

    if(datos.length === 0){
      const vacio = document.createElement("p");
      vacio.className = "muted sin-nada";
      vacio.textContent = cfg.vacio || "Todavía no hay nada cargado.";
      cont.appendChild(vacio);
      return;
    }

    /* Las que ya están van en su propio contenedor y no sueltas en la tarjeta.
       Es lo que permite que, cuando la lista es larga, se deslice SOLO esta
       parte y la fila de "agregar" se quede fija arriba: si el corte fuera
       sobre la tarjeta entera, cargar algo nuevo con veinte tipos de egreso
       cargados obligaría a subir hasta arriba de todo primero. */
    const caja = document.createElement("div");
    caja.className = "filas";
    cont.appendChild(caja);

    datos.forEach(dato => {
      const vals = cfg.desdeDato ? cfg.desdeDato(dato) : dato;
      const trabada = cfg.trabada ? cfg.trabada(dato) : null;
      const fila = document.createElement("div");
      fila.className = "fila-lista" + (trabada ? " trabada" : "");
      fila.style.gridTemplateColumns = cols;
      fila.innerHTML = cfg.campos.map(c => `<span class="celda">${control(c, vals[c.k])}</span>`).join("")
        + `<span class="acc">`
        + (trabada
            ? `<span class="candado" title="${esc(trabada)}">🔒</span>`
            : `<button class="b-tinta guardar">Guardar</button><button class="b-del borrar">Eliminar</button>`)
        + `</span>`;

      if(trabada){
        fila.querySelectorAll("input,select").forEach(el => el.disabled = true);
      } else {
        /* Marca de "esto todavía no se guardó".

           Hace falta por dos motivos. Uno: con las filas editables, mirar la
           lista ya no alcanza para saber qué hay guardado, porque lo que se ve
           es lo que uno tipeó. Y dos: si el guardado se rechaza —un nombre
           repetido, por ejemplo— el campo se queda con el texto nuevo para poder
           corregirlo, y sin esta marca la lista mostraría dos renglones iguales
           como si los dos estuvieran así en la base. Es el mismo gesto que usa
           el inventario cuando se toca una cantidad. */
        const original = JSON.stringify(leer(fila));
        const marcarSucia = () => fila.classList.toggle("sucia", JSON.stringify(leer(fila)) !== original);
        fila.querySelectorAll("input,select").forEach(el => {
          el.addEventListener("input", marcarSucia);
          el.addEventListener("change", marcarSucia);
        });

        fila.querySelector(".guardar").onclick = async () => {
          const nuevos = leer(fila);
          const cuerpo = cfg.aCuerpo ? cfg.aCuerpo(nuevos) : nuevos;
          if(cuerpo === null) return;
          if(!await mandar("PUT", `${cfg.ruta}/${dato.id}`, cuerpo)){
            fila.querySelector("input")?.focus();      // que se pueda corregir sin buscar el campo
            return;
          }
          toast("Guardado");
          await recargar();
          if(cfg.alCambiar) cfg.alCambiar();
        };
        fila.querySelector(".borrar").onclick = async () => {
          const como = cfg.nombreDe ? cfg.nombreDe(dato) : (dato.nombre || "esto");
          if(!confirm(`¿Eliminar "${como}"?`)) return;
          if(!await mandar("DELETE", `${cfg.ruta}/${dato.id}`, undefined)) return;
          toast("Eliminado");
          await recargar();
          if(cfg.alCambiar) cfg.alCambiar();
        };
      }
      caja.appendChild(fila);
    });
    acotar(caja);
  }

  recargar();
  return { recargar };
}

// --- Formas de pago ---
// "Efectivo" y "Transferencia" vienen trabadas del servidor: el arqueo suma
// comparando contra esos nombres exactos, así que renombrarlas o borrarlas
// dejaría la caja diciendo que hay más plata de la que hay.
const LISTA_FORMAS = listaEditable({
  cont: "#listaFormas", ruta: "/api/formas",
  vacio: "Todavía no hay formas de pago.",
  campos: [{k:"nombre", etiqueta:"Forma de pago", placeholder:"Ej: Cuenta DNI"}],
  trabada: f => f.fija ? "La caja hace cuentas con este nombre: no se cambia ni se borra." : null,
  aCuerpo: v => v.nombre ? {nombre: v.nombre} : (toast("Falta el nombre"), null),
});

// --- Tipos de egreso ---
// La marca de privado solo la ve y la toca la dueña: es lo que esconde el
// alquiler y los sueldos del empleado.
const LISTA_TIPOS = listaEditable({
  cont: "#listaTipos", ruta: "/api/tipos-egreso",
  vacio: "Todavía no hay tipos de egreso.",
  campos: [
    {k:"nombre", etiqueta:"Tipo de egreso", placeholder:"Ej: Alquiler"},
    ...(DUENO ? [{k:"privado", etiqueta:"Privado", tipo:"check", ancho:"76px"}] : []),
  ],
  aCuerpo: v => v.nombre ? v : (toast("Falta el nombre"), null),
});

// --- Descuentos ---
const LISTA_DESCUENTOS = listaEditable({
  cont: "#listaDescuentos", ruta: "/api/descuentos",
  vacio: "Todavía no hay descuentos.",
  campos: [
    {k:"nombre", etiqueta:"Nombre", placeholder:"Ej: Jubilado"},
    {k:"porcentaje", etiqueta:"Porcentaje", tipo:"numero", ancho:"110px", min:0, max:100, placeholder:"10"},
    {k:"mostrar_motivo", etiqueta:"Mostrar motivo", tipo:"check", ancho:"124px"},
  ],
  aCuerpo: v => {
    if(!v.nombre){ toast("Falta el nombre"); return null; }
    if(v.porcentaje === null || v.porcentaje < 0 || v.porcentaje > 100){ toast("Porcentaje inválido (0 a 100)"); return null; }
    return v;
  },
});

/* --- Ajustes por ítem ---
   Lo que se guarda es {porcentaje, monto} con signo, pero eso no es lo que uno
   piensa: uno piensa "un descuento del 10%" o "un recargo de $2.000". Así que
   la fila muestra tres cosas —si descuenta o recarga, si es en % o en pesos, y
   cuánto— y acá se traduce a los dos números y de vuelta. */
const LISTA_AJUSTES = listaEditable({
  cont: "#listaAjustes", ruta: "/api/ajustes-item",
  vacio: "Todavía no hay ajustes cargados.",
  campos: [
    {k:"nombre", etiqueta:"Nombre", placeholder:"Ej: Pelo largo"},
    {k:"signo", etiqueta:"Tipo", tipo:"select", ancho:"150px", inicial:"-",
     opciones:[{v:"-",txt:"Descuento (−)"},{v:"+",txt:"Recargo (+)"}]},
    {k:"unidad", etiqueta:"Unidad", tipo:"select", ancho:"140px", inicial:"%",
     opciones:[{v:"%",txt:"Porcentaje"},{v:"$",txt:"Monto fijo"}]},
    {k:"magnitud", etiqueta:"Cuánto", tipo:"numero", ancho:"110px", min:1, placeholder:"10"},
  ],
  desdeDato: a => {
    const enPesos = !!a.monto;
    const valor = enPesos ? a.monto : a.porcentaje;
    return {nombre:a.nombre, signo: valor < 0 ? "-" : "+",
            unidad: enPesos ? "$" : "%", magnitud: Math.abs(valor)};
  },
  nombreDe: a => a.nombre,
  aCuerpo: v => {
    if(!v.nombre){ toast("Falta el nombre"); return null; }
    if(v.magnitud === null || v.magnitud <= 0){ toast("Poné un valor mayor a 0"); return null; }
    const enPesos = v.unidad === "$";
    if(!enPesos && v.magnitud > 100){ toast("Porcentaje inválido (1 a 100)"); return null; }
    const valor = v.signo === "-" ? -v.magnitud : v.magnitud;
    return {nombre: v.nombre, porcentaje: enPesos ? 0 : valor, monto: enPesos ? valor : 0};
  },
});

// --- Alias de transferencia ---
const LISTA_ALIAS = listaEditable({
  cont: "#listaAlias", ruta: "/api/alias",
  vacio: "Sin alias cargados.",
  campos: [{k:"nombre", etiqueta:"Alias", placeholder:"Ej: pelu.mp"}],
  aCuerpo: v => v.nombre ? {nombre: v.nombre} : (toast("Falta el alias"), null),
});

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

