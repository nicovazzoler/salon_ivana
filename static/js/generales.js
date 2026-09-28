/* Los números con los que se paga cuando alguien no tiene el suyo.

   Un solo dibujante para las dos pantallas que los muestran —Admin, arriba de
   la lista de empleados, y Sueldos, que es donde se liquida—, igual que las
   cinco listas de listas.js. Si fueran dos, el día que se agregue un número más
   una de las dos se queda sin pedirlo.

   Se miran mucho más de lo que se tocan —se cambian una vez cada varios meses—,
   así que están escritos, no en casilleros. Un casillero siempre abierto arriba
   de la pantalla que se abre todos los días es un número que se puede pisar sin
   querer, y este le cambia el sueldo a todo el mundo. Para editar hay que
   pedirlo.

   Adentro del modo edición va el valor hora de cada una. Es donde tiene que
   estar: la pregunta "¿esto a quién le llega?" se contesta mirando la lista, y
   la lista solo importa en el momento de tocar el general. Cada renglón se
   guarda solo, con su lapicito: un Guardar que escriba el general y tres
   excepciones a la vez deja de decir qué se cambió.

   El bloque por persona se apaga con `porPersona: false` para Admin, donde cada
   empleada ya tiene su renglón con su valor hora adentro. */

const _escGral = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const _pesos = n => "$" + (n || 0).toLocaleString("es-AR");

/* `alGuardar` recibe la config nueva, para que cada pantalla refresque lo suyo
   sin que este archivo sepa qué tiene que redibujar. */
function panelGenerales(cont, alGuardar, opciones){
  const porPersona = !(opciones && opciones.porPersona === false);
  let cfg = {}, emps = [], editando = false;

  cont.innerHTML = `<div class="generales"></div>`;
  const caja = cont.querySelector(".generales");
  cargar();

  async function cargar(){
    try{
      cfg  = await (await authFetch("/api/config")).json();
      emps = await (await authFetch("/api/empleados")).json();
    }catch(e){ return; }
    pintar();
  }

  const activas = () => emps.filter(e => e.activo !== false);

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
    const sel = cfg.depi_a_cargo || "";
    const campos = [
      ["Valor hora",          `<input type="number" class="gHora" min="0" inputmode="numeric" value="${cfg.valor_hora ?? 0}">`,
                              _pesos(cfg.valor_hora)],
      ["Comisión",            `<input type="number" class="gPct" min="0" max="100" inputmode="numeric" value="${cfg.comision_pct ?? 40}">`,
                              (cfg.comision_pct ?? 40) + "%"],
      ["Ayudante depilación", `<input type="number" class="gAyu" min="0" inputmode="numeric" value="${cfg.pago_ayudante ?? 0}">`,
                              _pesos(cfg.pago_ayudante)],
      ["Depilación la lleva", `<select class="gDepi"><option value="">La que más facture</option>${
                                activas().map(e => `<option${e.nombre === sel ? " selected" : ""}>${_escGral(e.nombre)}</option>`).join("")}</select>`,
                              sel ? _escGral(sel) : `<span class="flojo">la que más facture</span>`],
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
        ${campos.map(([rot, edit, texto]) => `
          <div class="campo"><label>${rot}</label>
            ${editando ? edit : `<b class="val">${texto}</b>`}</div>`).join("")}
      </div>
      <p class="nota">${aviso()}</p>
      ${editando && porPersona ? listaPropios() : ""}`;

    const editar = caja.querySelector(".gEditar");
    if(editar) editar.onclick = () => { editando = true; pintar(); caja.querySelector(".gHora").focus(); };
    const cancelar = caja.querySelector(".gCancelar");
    if(cancelar) cancelar.onclick = () => { editando = false; pintar(); };
    const guardar = caja.querySelector(".gGuardar");
    if(guardar){
      guardar.onclick = guardarGeneral;
      caja.querySelectorAll(".gral-valores input").forEach(i => i.addEventListener("keydown", ev => {
        if(ev.key === "Enter") guardar.click();
        if(ev.key === "Escape") cancelar.click();
      }));
      engancharPropios();
    }
  }

  async function guardarGeneral(){
    const v = Math.max(0, parseInt(caja.querySelector(".gHora").value, 10) || 0);
    const p = Math.max(0, parseInt(caja.querySelector(".gPct").value, 10) || 0);
    const a = Math.max(0, parseInt(caja.querySelector(".gAyu").value, 10) || 0);
    const d = caja.querySelector(".gDepi").value;
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
    if(d !== (cfg.depi_a_cargo || "")) cambios.push(d
      ? `Los lunes de depilación pasan a ser de ${d}, salvo que al abrir un lunes se elija a otra.`
      : "Los lunes de depilación vuelven a ser de la que más facture ese día.");
    if(!cambios.length){ editando = false; pintar(); return; }
    if(!confirm(cambios.join("\n\n") + "\n\nLo ya cerrado no cambia. ¿Guardamos?")) return;

    const r = await authFetch("/api/config/sueldos", {method:"PUT",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({valor_hora: v, comision_pct: p, pago_ayudante: a, depi_a_cargo: d})});
    if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo"); return; }
    toast("Guardado");
    editando = false;
    await cargar();
    if(alGuardar) alGuardar(cfg);
  }

  /* El valor hora de cada una, con el general como respaldo.

     Se dice "GENERAL" con todas las letras en vez de repetir el número: lo que
     hay que poder leer de un vistazo es cuáles siguen al de arriba y cuáles no,
     y tres veces "$4.500" no distingue una cosa de la otra. */
  function listaPropios(){
    const gral = cfg.valor_hora ?? 0;
    return `
      <div class="propios">
        <div class="propios-cab"><h4>Valor hora de cada una</h4>
          <span>El general son ${_pesos(gral)}</span></div>
        ${activas().map(e => `
          <div class="propio-fila" data-emp="${e.id}">
            <b>${_escGral(e.nombre)}</b>
            <span class="vh${e.valor_hora == null ? " es-general" : ""}">${
              e.valor_hora == null ? "GENERAL" : _pesos(e.valor_hora)}</span>
            <button class="b-out btn-mini lapiz" title="Cambiar el valor hora de ${_escGral(e.nombre)}">✎</button>
          </div>`).join("")}
      </div>`;
  }

  function engancharPropios(){
    caja.querySelectorAll(".propio-fila").forEach(fila => {
      const e = emps.find(x => String(x.id) === fila.dataset.emp);
      fila.querySelector(".lapiz").onclick = () => abrirPropio(fila, e);
    });
  }

  /* Un renglón por vez, editado en el lugar. Con todos abiertos, la lista deja
     de decir cuál es el valor guardado y cuál el tipeado. */
  function abrirPropio(fila, e){
    caja.querySelectorAll(".editor-vh").forEach(x => x.remove());
    caja.querySelectorAll(".propio-fila").forEach(f => f.classList.remove("editando"));
    fila.classList.add("editando");
    const cajita = document.createElement("div");
    cajita.className = "editor-vh";
    cajita.innerHTML = `
      <input type="number" min="0" inputmode="numeric" class="vhNuevo"
             value="${e.valor_hora == null ? "" : e.valor_hora}"
             placeholder="${cfg.valor_hora ?? 0}">
      <button class="b-ok btn-mini vhOk">Guardar</button>
      ${e.valor_hora == null ? "" : `<button class="b-out btn-mini vhGral">Que use el general</button>`}
      <button class="b-out btn-mini vhNo">Cancelar</button>
      <span class="det">Vacío es el general, ${_pesos(cfg.valor_hora)}.</span>`;
    fila.after(cajita);
    const inp = cajita.querySelector(".vhNuevo");
    inp.focus(); inp.select();
    const cerrar = () => { cajita.remove(); fila.classList.remove("editando"); };
    cajita.querySelector(".vhNo").onclick = cerrar;
    const gral = cajita.querySelector(".vhGral");
    if(gral) gral.onclick = () => mandarPropio(e, -1);
    cajita.querySelector(".vhOk").onclick = () => {
      const texto = inp.value.trim();
      // -1 es "sacale el propio y que use el general": mandar null sería "no
      // toques este campo", que no es lo mismo.
      mandarPropio(e, texto === "" ? -1 : Math.max(0, parseInt(texto, 10) || 0));
    };
    inp.addEventListener("keydown", ev => {
      if(ev.key === "Enter") cajita.querySelector(".vhOk").click();
      if(ev.key === "Escape") cerrar();
    });
  }

  async function mandarPropio(e, valor){
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
  }
}
