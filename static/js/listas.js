/* Las listas configurables de la app, en un solo lugar.
 *
 * Son seis: formas de pago, tipos de egreso, empleados, descuentos, ajustes por
 * ítem y alias de transferencia. Antes cada una tenía su copia del mismo código
 * en admin.js, y solo se podían tocar desde Admin.
 *
 * Este archivo hace dos cosas y las usan dos pantallas:
 *
 *   - Listas.dibujar(): pinta una lista editable adentro de un contenedor. Es
 *     lo que usa Admin, donde las cinco están una abajo de la otra.
 *   - Listas.abrir(): abre esa misma lista en un panel, sin salir de donde
 *     estás. Es lo que usa Facturar desde el lapicito que hay al lado de cada
 *     desplegable: si al cobrar falta un descuento, se carga ahí y se sigue,
 *     en vez de irse a Admin y volver con el ticket a medio hacer.
 *
 * Que sea el MISMO dibujante importa: si fueran dos, un día se agrega un campo
 * en Admin y el panel de facturar sigue sin pedirlo.
 *
 * No lee nada del documento ni depende de las pantallas: los helpers que
 * necesita están acá adentro.
 */
(function(global){
"use strict";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

// El aviso se muestra con el toast de la pantalla que esté abierta, que ya está
// en su lugar y con su estilo. Si no hubiera, al menos no se rompe nada.
function avisar(m){
  const t = document.getElementById("toast");
  if(!t){ console.warn(m); return; }
  t.textContent = m; t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2200);
}

const esDuena = () => localStorage.getItem("pelu_rol") === "dueno";

/* ---------- Qué es cada lista ----------

   Cada una declara sus campos y cómo se traduce lo que se ve a lo que se
   guarda. Agregar una lista nueva es agregar una entrada acá. */
const LISTAS = {
  formas: {
    titulo: "Formas de pago",
    ayuda: "Las opciones que se ofrecen al cobrar un ticket.",
    ruta: "/api/formas",
    vacio: "Todavía no hay formas de pago.",
    campos: [{k:"nombre", etiqueta:"Forma de pago", placeholder:"Ej: Cuenta DNI"}],
    // "Efectivo" y "Transferencia" vienen trabadas del servidor: el arqueo suma
    // comparando contra esos nombres exactos, así que renombrarlas o borrarlas
    // dejaría la caja diciendo que hay más plata de la que hay.
    trabada: f => f.fija ? "La caja hace cuentas con este nombre: no se cambia ni se borra." : null,
    aCuerpo: v => v.nombre ? {nombre: v.nombre} : (avisar("Falta el nombre"), null),
  },

  tipos: {
    titulo: "Tipos de egreso",
    ayuda: "Las categorías con las que se clasifica lo que sale de la caja.",
    ruta: "/api/tipos-egreso",
    vacio: "Todavía no hay tipos de egreso.",
    // La marca de privado solo la ve y la toca la dueña: es lo que esconde el
    // alquiler y los sueldos del empleado.
    campos: () => [
      {k:"nombre", etiqueta:"Tipo de egreso", placeholder:"Ej: Alquiler"},
      ...(esDuena() ? [{k:"privado", etiqueta:"Privado", tipo:"check", ancho:"76px"}] : []),
    ],
    // "Sueldos" viene trabado del servidor, por lo mismo que "Efectivo": el
    // cierre de sueldo anota el egreso con ese nombre exacto, y con dos nombres
    // para lo mismo la caja muestra los sueldos partidos en dos renglones.
    trabada: t => t.fijo ? "Los cierres de sueldo anotan el egreso con este nombre: no se cambia ni se borra." : null,
    aCuerpo: v => v.nombre ? v : (avisar("Falta el nombre"), null),
  },

  /* Quién atendió. Es una lista y no texto libre porque de este nombre sale el
     sueldo: escrito a mano salían "Carla", "carla " y "Karla", que para el
     sistema son tres personas, y el trabajo de una quedaba repartido en tres que
     no cobra nadie. Renombrar arrastra —es una clasificación, no lo que se le
     dijo al cliente—, así que un comprobante viejo nunca queda a nombre de
     alguien que no existe. */
  empleados: {
    titulo: "Empleados",
    ayuda: "Los nombres que se pueden elegir en “Atendió” al facturar y en la agenda.",
    ruta: "/api/empleados",
    vacio: "Todavía no hay empleados.",
    campos: [{k:"nombre", etiqueta:"Nombre", placeholder:"Ej: Carla"}],
    aCuerpo: v => v.nombre ? {nombre: v.nombre} : (avisar("Falta el nombre"), null),
  },

  descuentos: {
    titulo: "Descuentos",
    ayuda: "Se aplican al ticket entero, por porcentaje.",
    ruta: "/api/descuentos",
    vacio: "Todavía no hay descuentos.",
    campos: [
      {k:"nombre", etiqueta:"Nombre", placeholder:"Ej: Jubilado"},
      {k:"porcentaje", etiqueta:"Porcentaje", tipo:"numero", ancho:"110px", min:0, max:100, placeholder:"10"},
      {k:"mostrar_motivo", etiqueta:"Mostrar motivo", tipo:"check", ancho:"124px"},
    ],
    aCuerpo: v => {
      if(!v.nombre){ avisar("Falta el nombre"); return null; }
      if(v.porcentaje === null || v.porcentaje < 0 || v.porcentaje > 100){
        avisar("Porcentaje inválido (0 a 100)"); return null;
      }
      return v;
    },
  },

  /* Lo que se guarda es {porcentaje, monto} con signo, pero eso no es lo que uno
     piensa: uno piensa "un descuento del 10%" o "un recargo de $2.000". Así que
     la fila muestra tres cosas —si descuenta o recarga, si es en % o en pesos, y
     cuánto— y acá se traduce a los dos números y de vuelta. */
  ajustes: {
    titulo: "Ajustes por ítem",
    ayuda: "Se aplican a una línea sola del servicio, no al total.",
    ruta: "/api/ajustes-item",
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
    aCuerpo: v => {
      if(!v.nombre){ avisar("Falta el nombre"); return null; }
      if(v.magnitud === null || v.magnitud <= 0){ avisar("Poné un valor mayor a 0"); return null; }
      const enPesos = v.unidad === "$";
      if(!enPesos && v.magnitud > 100){ avisar("Porcentaje inválido (1 a 100)"); return null; }
      const valor = v.signo === "-" ? -v.magnitud : v.magnitud;
      return {nombre: v.nombre, porcentaje: enPesos ? 0 : valor, monto: enPesos ? valor : 0};
    },
  },

  alias: {
    titulo: "Alias de transferencia",
    ayuda: "Las cuentas que aparecen al cobrar por transferencia.",
    ruta: "/api/alias",
    vacio: "Sin alias cargados.",
    campos: [{k:"nombre", etiqueta:"Alias", placeholder:"Ej: pelu.mp"}],
    aCuerpo: v => v.nombre ? {nombre: v.nombre} : (avisar("Falta el alias"), null),
  },
};

/* ---------- El dibujante ----------

   Una fila por elemento, editable donde está, y arriba de todo la fila para
   cargar uno nuevo. Los rótulos van SOLO en esa primera fila y hacen de
   encabezado de las columnas de abajo, que se alinean con ella: un solo lugar
   donde dice qué es cada campo. */
function dibujar(cont, nombreLista, alCambiar){
  if(typeof cont === "string") cont = document.querySelector(cont);
  const cfg = LISTAS[nombreLista];
  if(!cont || !cfg) return { recargar: async () => {} };

  const campos = typeof cfg.campos === "function" ? cfg.campos() : cfg.campos;

  /* La grilla se arma con los anchos que declara cada campo. Van en píxeles y no
     en "auto" a propósito: cada fila tiene su propia grilla, así que una columna
     "auto" mide distinto arriba (donde está el rótulo "Mostrar motivo") que
     abajo (donde está solo la casilla), y las columnas dejarían de alinearse.
     La última es la de los botones, que reserva su ancho desde el CSS. */
  const cols = campos.map(c => c.ancho || "minmax(0,1fr)").join(" ") + " auto";

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
    campos.forEach(c => {
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
      avisar(detalle);
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
    nueva.innerHTML = campos.map(c =>
        `<span class="celda"><label>${esc(c.etiqueta)}</label>${control(c, c.inicial)}</span>`).join("")
      + `<span class="acc"><button class="b-ok agregar">Agregar</button></span>`;
    nueva.querySelector(".agregar").onclick = async () => {
      const vals = leer(nueva);
      const cuerpo = cfg.aCuerpo ? cfg.aCuerpo(vals) : vals;
      if(cuerpo === null) return;                 // el propio armador ya avisó qué falta
      if(!await mandar("POST", cfg.ruta, cuerpo)) return;
      avisar("Agregado");
      await recargar();
      if(alCambiar) alCambiar();
      cont.querySelector(".nueva input,.nueva select")?.focus();
    };
    // Enter en cualquier campo de la fila de arriba carga: en la tablet, tener
    // que buscar el botón después de tipear un nombre es un toque de más.
    nueva.querySelectorAll("input").forEach(el => el.addEventListener("keydown", e => {
      if(e.key === "Enter"){ e.preventDefault(); nueva.querySelector(".agregar").click(); }
    }));
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
      /* El rótulo va también en las filas de abajo, aunque en pantalla ancha esté
         escondido: ahí alcanza con el encabezado de la fila de arriba, pero en
         angosto la grilla se desarma en un campo por renglón y sin rótulo
         quedaría "Jubilado / 15 / [ ]" sin decir qué es cada cosa. Se decide en
         el CSS y no acá, así la misma fila sirve para los dos anchos. */
      fila.innerHTML = campos.map(c =>
          `<span class="celda"><label>${esc(c.etiqueta)}</label>${control(c, vals[c.k])}</span>`).join("")
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
          avisar("Guardado");
          await recargar();
          if(alCambiar) alCambiar();
        };
        fila.querySelector(".borrar").onclick = async () => {
          if(!confirm(`¿Eliminar "${dato.nombre || "esto"}"?`)) return;
          if(!await mandar("DELETE", `${cfg.ruta}/${dato.id}`, undefined)) return;
          avisar("Eliminado");
          await recargar();
          if(alCambiar) alCambiar();
        };
      }
      caja.appendChild(fila);
    });
    if(global.acotarLista) global.acotarLista(caja);
  }

  recargar();
  return { recargar };
}

/* ---------- El panel ----------

   La misma lista, pero encima de la pantalla en la que estás. Existe para un
   caso concreto: estás cobrando, falta un descuento o un alias, y la única
   forma de cargarlo era irse a Admin, buscarlo entre seis tarjetas y volver.

   Se cierra con la X, con Escape o tocando afuera, y al cerrar avisa para que
   la pantalla vuelva a leer sus desplegables: si cargaste algo y el select
   sigue mostrando lo de antes, el viaje no sirvió de nada. */
let abierto = null;

function abrir(nombreLista, alCerrar){
  if(abierto) cerrar();
  const cfg = LISTAS[nombreLista];
  if(!cfg) return;
  let huboCambios = false;

  const fondo = document.createElement("div");
  fondo.className = "panel-lista-fondo";
  fondo.innerHTML = `
    <div class="panel-lista" role="dialog" aria-modal="true" aria-label="${esc(cfg.titulo)}">
      <div class="panel-lista-cab">
        <div>
          <h2>${esc(cfg.titulo)}</h2>
          ${cfg.ayuda ? `<p>${esc(cfg.ayuda)}</p>` : ""}
        </div>
        <button class="b-out cerrar" aria-label="Cerrar">✕</button>
      </div>
      <div class="panel-lista-cuerpo"></div>
    </div>`;
  document.body.appendChild(fondo);
  document.body.classList.add("con-panel");

  dibujar(fondo.querySelector(".panel-lista-cuerpo"), nombreLista, () => { huboCambios = true; });

  function cerrar(){
    document.removeEventListener("keydown", porTecla);
    fondo.remove();
    document.body.classList.remove("con-panel");
    abierto = null;
    if(alCerrar) alCerrar(huboCambios);
  }
  function porTecla(e){ if(e.key === "Escape") cerrar(); }

  fondo.querySelector(".cerrar").onclick = cerrar;
  // Solo el fondo cierra, no un click adentro del panel.
  fondo.onclick = e => { if(e.target === fondo) cerrar(); };
  document.addEventListener("keydown", porTecla);
  abierto = { cerrar };
  fondo.querySelector("input,select")?.focus();
}

function cerrar(){ if(abierto) abierto.cerrar(); }

/* El lapicito que se pone al lado de un desplegable. Devuelve el botón ya
   armado; quien lo llama decide dónde meterlo. */
function botonEditar(nombreLista, alCerrar){
  const b = document.createElement("button");
  b.type = "button";
  b.className = "editar-lista";
  b.title = "Editar la lista de " + LISTAS[nombreLista].titulo.toLowerCase();
  b.setAttribute("aria-label", b.title);
  b.innerHTML = "✎";
  b.onclick = e => { e.preventDefault(); abrir(nombreLista, alCerrar); };
  return b;
}

global.Listas = { LISTAS, dibujar, abrir, cerrar, botonEditar };

})(window);
