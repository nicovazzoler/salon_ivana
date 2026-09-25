/* Los números con los que se paga cuando alguien no tiene el suyo.

   Un solo dibujante para las dos pantallas que los muestran —Admin, arriba de
   la lista de empleados, y Sueldos, que es donde se liquida—, igual que las
   cinco listas de listas.js. Si fueran dos, el día que se agregue un número más
   una de las dos se queda sin pedirlo.

   Son lo más general que hay en la app: cambiar el valor hora acá le cambia el
   sueldo a todas las que no tengan uno propio. Lo ya cerrado no se toca, que
   cada liquidación guarda el valor con el que se pagó.

   Se miran mucho más de lo que se tocan —se cambian una vez cada varios meses—,
   así que están escritos, no en casilleros. Un casillero siempre abierto arriba
   de la pantalla que se abre todos los días es un número que se puede pisar sin
   querer, y este le cambia el sueldo a todo el mundo. Para editar hay que
   pedirlo.

   Abajo va el valor hora de UNA en particular. Es la excepción, tiene su propio
   botón y su propio guardado: juntarlo con el general haría que un solo Guardar
   escriba dos cosas distintas, y ahí ya no se sabe cuál se cambió.

   Ese bloque se apaga con `porPersona: false` para Admin, donde cada empleada ya
   tiene su renglón con su valor hora adentro: dos caminos a lo mismo en la misma
   pantalla es una pregunta más, no una comodidad. */

const _escGral = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const _pesos = n => "$" + (n || 0).toLocaleString("es-AR");

/* `alGuardar` recibe la config nueva, para que cada pantalla refresque lo suyo
   sin que este archivo sepa qué tiene que redibujar. */
function panelGenerales(cont, alGuardar, opciones){
  const porPersona = !(opciones && opciones.porPersona === false);
  let cfg = {}, emps = [], editando = false;

  cont.innerHTML = `<div class="generales"></div><div class="propio"></div>`;
  const caja = cont.querySelector(".generales"), propio = cont.querySelector(".propio");

  cargar();

  async function cargar(){
    try{
      cfg  = await (await authFetch("/api/config")).json();
      emps = await (await authFetch("/api/empleados")).json();
    }catch(e){ return; }
    pintar(); pintarPropio();
  }

  /* Quién queda afuera de estos números.

     Las excepciones NO se pisan —vh_de() y pct_de() usan el general solo como
     respaldo— pero eso no se ve por ningún lado, y no verlo lleva a las dos
     equivocaciones opuestas: creer que se pisó lo de alguien, o creer que no se
     le cambió a nadie. */
  function aviso(){
    const propias = cfg.hora_propia || [], n = propias.length;
    const quienes = n === 0
      ? "El valor hora les llega a todas: ninguna tiene uno propio."
      : n === 1 ? `Les llega a todas menos a ${_escGral(propias[0])}, que cobra la suya.`
      : `Les llega a todas menos a ${propias.map(_escGral).join(", ")}, que cobran la suya.`;
    const uno = cfg.pct_propio === 1;
    const items = cfg.pct_propio
      ? ` ${cfg.pct_propio} ${uno ? "servicio tiene" : "servicios tienen"} su propio porcentaje`
        + ` y tampoco ${uno ? "cambia" : "cambian"}.`
      : " Ningún servicio tiene un porcentaje propio.";
    return quienes + items + " Lo ya cerrado no se toca.";
  }

  function pintar(){
    const campos = [
      ["Valor hora",          "gHora", cfg.valor_hora ?? 0,    _pesos(cfg.valor_hora)],
      ["Comisión",            "gPct",  cfg.comision_pct ?? 40, (cfg.comision_pct ?? 40) + "%"],
      ["Ayudante depilación", "gAyu",  cfg.pago_ayudante ?? 0, _pesos(cfg.pago_ayudante)],
    ];
    caja.innerHTML = `
      <div class="gral-cab">
        <h3>Para todas</h3>
        ${editando
          ? `<span class="gral-acc"><button class="b-ok gGuardar">Guardar</button>
             <button class="b-out gCancelar">Cancelar</button></span>`
          : `<button class="b-out btn-mini gEditar">Editar</button>`}
      </div>
      <div class="gral-valores">
        ${campos.map(([rot, clase, valor, texto]) => `
          <div class="campo">
            <label>${rot}</label>
            ${editando
              ? `<input type="number" class="${clase}" min="0" inputmode="numeric" value="${valor}">`
              : `<b class="val">${texto}</b>`}
          </div>`).join("")}
      </div>
      <p class="nota gQuienes">${aviso()}</p>`;

    const editar = caja.querySelector(".gEditar");
    if(editar) editar.onclick = () => { editando = true; pintar(); caja.querySelector(".gHora").focus(); };
    const cancelar = caja.querySelector(".gCancelar");
    if(cancelar) cancelar.onclick = () => { editando = false; pintar(); };
    const guardar = caja.querySelector(".gGuardar");
    if(guardar){
      guardar.onclick = guardarGeneral;
      caja.querySelectorAll("input").forEach(i => i.addEventListener("keydown", ev => {
        if(ev.key === "Enter") guardar.click();
        if(ev.key === "Escape") cancelar.click();
      }));
    }
  }

  async function guardarGeneral(){
    const v = Math.max(0, parseInt(caja.querySelector(".gHora").value, 10) || 0);
    const p = Math.max(0, parseInt(caja.querySelector(".gPct").value, 10) || 0);
    const a = Math.max(0, parseInt(caja.querySelector(".gAyu").value, 10) || 0);
    if(p > 100){ toast("La comisión no puede pasar de 100%"); caja.querySelector(".gPct").focus(); return; }

    // Se avisa solo de lo que cambió, y se dice a quién le llega y a quién no.
    // Las dos cosas: "no le cambia a nadie más" tranquiliza tanto como
    // "les cambia a todas" frena.
    const propias = cfg.hora_propia || [];
    const cambios = [];
    if(v !== (cfg.valor_hora ?? 0)) cambios.push(`El valor hora pasa a ${_pesos(v)}. ` + (
      propias.length ? `Le llega a todas menos a ${propias.join(", ")}, que cobran la suya.`
                     : "Le llega a todas: ninguna tiene una hora propia."));
    if(p !== (cfg.comision_pct ?? 40)) cambios.push(`La comisión pasa a ${p}%. ` + (
      cfg.pct_propio ? `Le llega a todos los servicios menos a ${cfg.pct_propio} que `
                       + `${cfg.pct_propio === 1 ? "tiene" : "tienen"} el suyo.`
                     : "Le llega a todos los servicios: ninguno tiene un porcentaje propio."));
    if(a !== (cfg.pago_ayudante ?? 0)) cambios.push(`El pago a la ayudante pasa a ${_pesos(a)}, `
      + "que es el que va a venir puesto en el próximo lunes de depilación.");
    if(!cambios.length){ editando = false; pintar(); return; }
    if(!confirm(cambios.join("\n\n") + "\n\nLo ya cerrado no cambia. ¿Guardamos?")) return;

    const r = await authFetch("/api/config/sueldos", {method:"PUT",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({valor_hora: v, comision_pct: p, pago_ayudante: a})});
    if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo"); return; }
    toast("Guardado");
    editando = false;
    await cargar();
    if(alGuardar) alGuardar({valor_hora: v, comision_pct: p, pago_ayudante: a});
  }

  /* El valor hora de una sola. Se elige a quién y se ve lo que tiene puesto:
     vacío es "usa el general", y por eso el casillero lo dice en el placeholder
     en vez de mostrar el número general adentro, que se leería como propio. */
  function pintarPropio(){
    const activas = emps.filter(e => e.activo !== false);
    if(!porPersona || !activas.length){ propio.innerHTML = ""; return; }
    propio.innerHTML = `
      <div class="generales">
        <div class="gral-cab"><h3>Una en particular</h3></div>
        <div class="gral-valores">
          <div class="campo"><label>Empleada</label>
            <select class="pQuien">${activas.map(e =>
              `<option value="${e.id}">${_escGral(e.nombre)}</option>`).join("")}</select></div>
          <div class="campo"><label>Valor hora</label>
            <input type="number" class="pHora" min="0" inputmode="numeric"></div>
          <button class="b-ok pGuardar">Guardar</button>
        </div>
        <p class="nota pNota"></p>
      </div>`;
    const sel = propio.querySelector(".pQuien"), inp = propio.querySelector(".pHora");
    const nota = propio.querySelector(".pNota");
    const mostrar = () => {
      const e = activas.find(x => String(x.id) === sel.value) || {};
      inp.value = e.valor_hora != null ? e.valor_hora : "";
      inp.placeholder = String(cfg.valor_hora ?? 0);
      nota.textContent = e.valor_hora != null
        ? `${e.nombre} cobra ${_pesos(e.valor_hora)} la hora. Vaciá el casillero para que vuelva al general.`
        : `${e.nombre} cobra el general, ${_pesos(cfg.valor_hora)}. Poné un número acá para que cobre otra cosa.`;
    };
    sel.onchange = mostrar; mostrar();
    inp.addEventListener("keydown", ev => {
      if(ev.key === "Enter") propio.querySelector(".pGuardar").click();
    });
    propio.querySelector(".pGuardar").onclick = async () => {
      const e = activas.find(x => String(x.id) === sel.value);
      const texto = inp.value.trim();
      // -1 es "sacale el propio y que use el general": mandar null sería "no
      // toques este campo", que no es lo mismo.
      const valor = texto === "" ? -1 : Math.max(0, parseInt(texto, 10) || 0);
      if(valor === (e.valor_hora ?? -1)){ toast("No cambiaste nada"); return; }
      if(!confirm(valor < 0
          ? `${e.nombre} vuelve a cobrar el general, ${_pesos(cfg.valor_hora)} la hora.\n\nLo ya cerrado no cambia. ¿Guardamos?`
          : `${e.nombre} pasa a cobrar ${_pesos(valor)} la hora, en vez del general.\n\nLo ya cerrado no cambia. ¿Guardamos?`)) return;
      const r = await authFetch(`/api/empleados/${e.id}`, {method:"PUT",
        headers:{"Content-Type":"application/json"}, body: JSON.stringify({valor_hora: valor})});
      if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo"); return; }
      toast("Guardado");
      await cargar();
      if(alGuardar) alGuardar(cfg);
    };
  }
}
