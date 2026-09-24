/* Los números con los que se paga cuando alguien no tiene el suyo.

   Un solo dibujante para las dos pantallas que los muestran —Admin, arriba de
   la lista de empleados, y Sueldos, que es donde se liquida—, igual que las
   cinco listas de listas.js. Si fueran dos, el día que se agregue un número más
   una de las dos se queda sin pedirlo.

   Son lo más general que hay en la app: cambiar el valor hora acá le cambia el
   sueldo a todas las que no tengan uno propio. Lo ya cerrado no se toca, que
   cada liquidación guarda el valor con el que se pagó. */

const _escGral = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

/* `alGuardar` recibe la config nueva, para que cada pantalla refresque lo suyo
   sin que este archivo sepa qué tiene que redibujar. */
function panelGenerales(cont, alGuardar){
  cont.innerHTML = `
    <div class="generales">
      <div class="campo"><label>Valor hora</label>
        <input type="number" class="gHora" min="0" inputmode="numeric"></div>
      <div class="campo"><label>Comisión</label>
        <span class="con-signo"><input type="number" class="gPct" min="0" max="100" inputmode="numeric"><i>%</i></span></div>
      <div class="campo"><label>Ayudante depilación</label>
        <input type="number" class="gAyu" min="0" inputmode="numeric"></div>
      <button class="b-ok gGuardar">Guardar</button>
      <span class="nota gQuienes">Se usan para todas. La que tenga lo suyo cobra lo suyo.
        Lo de la ayudante es por el día y viene puesto en el lunes, donde se puede cambiar.</span>
    </div>`;

  const hora = cont.querySelector(".gHora"), pct = cont.querySelector(".gPct"),
        ayu = cont.querySelector(".gAyu");
  // Lo que había al abrir: solo se avisa de lo que efectivamente se cambió.
  let antes = {}, propios = {hora_propia: [], pct_propio: 0};

  authFetch("/api/config").then(r => r.json()).then(c => {
    hora.value = c.valor_hora ?? 0;
    pct.value  = c.comision_pct ?? 40;
    ayu.value  = c.pago_ayudante ?? 0;
    antes = {v: Number(hora.value), p: Number(pct.value), a: Number(ayu.value)};
    propios = {hora_propia: c.hora_propia || [], pct_propio: c.pct_propio || 0};
    pintarQuienes();
  }).catch(() => {});

  /* Quién queda afuera de estos números, dicho antes de tocarlos.

     El valor hora general le cambia el sueldo a todas las que no tengan uno
     propio, y el porcentaje, a todos los servicios sin el suyo. Las excepciones
     NO se pisan —vh_de() y pct_de() usan el general solo como respaldo— pero eso
     no se ve por ningún lado, y no verlo lleva a las dos equivocaciones: creer
     que se pisó lo de alguien, o creer que no se le cambió a nadie. */
  function pintarQuienes(){
    const n = propios.hora_propia.length;
    const quienes = n === 0 ? "Nadie cobra una hora propia: el valor hora les llega a todas."
      : n === 1 ? `${_escGral(propios.hora_propia[0])} cobra la suya y no le cambia.`
      : `${propios.hora_propia.length} cobran la suya y no les cambia: `
        + propios.hora_propia.map(_escGral).join(", ") + ".";
    const uno = propios.pct_propio === 1;
    const items = propios.pct_propio
      ? ` ${propios.pct_propio} ${uno ? "servicio tiene" : "servicios tienen"}`
        + ` su propio porcentaje y tampoco ${uno ? "cambia" : "cambian"}.`
      : " Ningún servicio tiene un porcentaje propio.";
    cont.querySelector(".gQuienes").innerHTML = quienes + items
      + " Lo ya cerrado no se toca.";
  }

  cont.querySelector(".gGuardar").onclick = async () => {
    const v = Math.max(0, parseInt(hora.value, 10) || 0);
    const p = Math.max(0, parseInt(pct.value, 10) || 0);
    const a = Math.max(0, parseInt(ayu.value, 10) || 0);
    if(p > 100){ toast("La comisión no puede pasar de 100%"); pct.focus(); return; }

    // Se avisa solo de lo que cambió, y se dice a quién le llega y a quién no.
    // Las dos cosas: "no le cambia a nadie más" tranquiliza tanto como
    // "les cambia a todas" frena.
    const cambios = [];
    if(v !== antes.v) cambios.push(`El valor hora pasa a $${v.toLocaleString("es-AR")}. ` + (
      propios.hora_propia.length
        ? `Le llega a todas menos a ${propios.hora_propia.join(", ")}, que cobran la suya.`
        : "Le llega a todas: ninguna tiene una hora propia."));
    if(p !== antes.p) cambios.push(`La comisión pasa a ${p}%. ` + (
      propios.pct_propio
        ? `Le llega a todos los servicios menos a ${propios.pct_propio} que `
          + `${propios.pct_propio === 1 ? "tiene" : "tienen"} el suyo.`
        : "Le llega a todos los servicios: ninguno tiene un porcentaje propio."));
    if(a !== antes.a) cambios.push(`El pago a la ayudante pasa a $${a.toLocaleString("es-AR")}, `
      + "que es el que va a venir puesto en el próximo lunes de depilación.");
    if(!cambios.length){ toast("No cambiaste nada"); return; }
    if(!confirm(cambios.join("\n\n") + "\n\nLo ya cerrado no cambia. ¿Guardamos?")) return;

    const r = await authFetch("/api/config/sueldos", {method:"PUT",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({valor_hora: v, comision_pct: p, pago_ayudante: a})});
    if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo"); return; }
    toast("Guardado");
    antes = {v, p, a};
    if(alGuardar) alGuardar({valor_hora: v, comision_pct: p, pago_ayudante: a});
  };

  [hora, pct, ayu].forEach(i => i.addEventListener("keydown", ev => {
    if(ev.key === "Enter") cont.querySelector(".gGuardar").click();
  }));
}
