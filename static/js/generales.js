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
   empleada ya tiene su renglón con su valor hora adentro.

   Con `soloDepi: true` dibuja los dos números de la depilación en vez de los del
   sueldo. Es el mismo dibujante porque es la misma tarjeta —escrita, con su
   botón de Editar— y porque los dos escriben en la misma config; lo que cambia
   es dónde se mira cada cosa: el sueldo en Sueldos y la depilación en la suya. */

const _escGral = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const _pesos = n => "$" + (n || 0).toLocaleString("es-AR");

/* `alGuardar` recibe la config nueva, para que cada pantalla refresque lo suyo
   sin que este archivo sepa qué tiene que redibujar. */
function panelGenerales(cont, alGuardar, opciones){
  const soloDepi = !!(opciones && opciones.soloDepi);
  const porPersona = !soloDepi && !(opciones && opciones.porPersona === false);
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
    const campos = soloDepi ? [
      ["Pago a la ayudante",  `<input type="number" class="gAyu" min="0" inputmode="numeric" value="${cfg.pago_ayudante ?? 0}">`,
                              _pesos(cfg.pago_ayudante)],
      ["Las sesiones las lleva", `<select class="gDepi"><option value="">La que más facture</option>${
                                activas().map(e => `<option${e.nombre === sel ? " selected" : ""}>${_escGral(e.nombre)}</option>`).join("")}</select>`,
                              sel ? _escGral(sel) : `<span class="flojo">la que más facture</span>`],
    ] : [
      ["Valor hora",          `<input type="number" class="gHora" min="0" inputmode="numeric" value="${cfg.valor_hora ?? 0}">`,
                              _pesos(cfg.valor_hora)],
      ["Comisión",            `<input type="number" class="gPct" min="0" max="100" inputmode="numeric" value="${cfg.comision_pct ?? 40}">`,
                              (cfg.comision_pct ?? 40) + "%"],
    ];
    caja.innerHTML = `
      <div class="gral-cab">
        <h3>${soloDepi ? "Los números de la depilación" : "Para todas"}</h3>
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
      <p class="nota">${soloDepi ? avisoDepi() : aviso()}</p>
      ${editando && porPersona ? listaPropios() : ""}`;

    const editar = caja.querySelector(".gEditar");
    if(editar) editar.onclick = () => {
      editando = true; pintar();
      caja.querySelector(soloDepi ? ".gAyu" : ".gHora").focus();
    };
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

  function avisoDepi(){
    return "Con quién las lleva puesto, toda sesión nueva arranca con ella —y la que "
         + "se abre sola al cobrar, también—; igual se puede cambiar en la sesión. "
         + "El pago a la ayudante viene puesto al cargar el gasto y se puede cambiar ahí. "
         + "La máquina no tiene número fijo: se alquila por jornada.";
  }

  async function guardarGeneral(){
    const leer = (q, tope) => {
      const el = caja.querySelector(q);
      return el ? Math.max(0, Math.min(tope ?? 1e12, parseInt(el.value, 10) || 0)) : null;
    };
    const v = leer(".gHora"), p = leer(".gPct"), a = leer(".gAyu");
    const selDepi = caja.querySelector(".gDepi");
    const d = selDepi ? selDepi.value : null;
    if(p !== null && p > 100){ toast("La comisión no puede pasar de 100%"); caja.querySelector(".gPct").focus(); return; }

    // Se avisa solo de lo que cambió, y se dice a quién le llega y a quién no.
    // Las dos cosas: "no le cambia a nadie más" tranquiliza tanto como
    // "les cambia a todas" frena.
    const propias = cfg.hora_propia || [];
    const cambios = [];
    if(v !== null && v !== (cfg.valor_hora ?? 0)) cambios.push(`El valor hora pasa a ${_pesos(v)}. ` + (
      propias.length ? `Le llega a todas menos a ${propias.join(", ")}, que cobran la suya.`
                     : "Le llega a todas: ninguna tiene una hora propia."));
    if(p !== null && p !== (cfg.comision_pct ?? 40)) cambios.push(`La comisión pasa a ${p}%. ` + (
      cfg.pct_propio ? `Le llega a todos los servicios menos a ${cfg.pct_propio} que `
                       + `${cfg.pct_propio === 1 ? "tiene" : "tienen"} el suyo.`
                     : "Le llega a todos los servicios: ninguno tiene un porcentaje propio."));
    if(a !== null && a !== (cfg.pago_ayudante ?? 0)) cambios.push(`El pago a la ayudante pasa a ${_pesos(a)}, `
      + "que es el que va a venir puesto en el próximo día de depilación.");
    if(d !== null && d !== (cfg.depi_a_cargo || "")) cambios.push(d
      ? `Las sesiones de depilación nuevas arrancan con ${d}, salvo que al abrirla se elija a otra. `
        + "Las que ya están abiertas no cambian."
      : "Las sesiones nuevas vuelven a arrancar con la que más facture.");
    if(!cambios.length){ editando = false; pintar(); return; }
    if(!confirm(cambios.join("\n\n") + "\n\nLo ya cerrado no cambia. ¿Guardamos?")) return;

    const r = await authFetch("/api/config/sueldos", {method:"PUT",
      headers:{"Content-Type":"application/json"},
      // Solo lo que esta tarjeta edita. Mandar el resto en null no es "no lo
      // toques" para el backend de todos los campos, y mandarlo en cero le
      // borraría a la otra tarjeta lo suyo.
      body: JSON.stringify(Object.fromEntries(Object.entries(
        {valor_hora: v, comision_pct: p, pago_ayudante: a, depi_a_cargo: d})
        .filter(([, x]) => x !== null)))});
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

/* El borrón y cuenta nueva de los sueldos, con el mismo criterio que los dos
   números de arriba: un solo dibujante para Admin y para Sueldos.

   Lo de antes del corte se pagó a mano, por fuera de la app, y no tiene que
   volver a aparecer como pendiente. NO borra nada: los trabajos y las horas
   siguen guardados, así que correr el corte para atrás los devuelve enteros.
   Por eso es esto y no un botón de borrar ciclos viejos, que sí sería para
   siempre y con la plata de otro.

   Y es UNO para todo el local, no por empleada: lo dice el renglón y lo dice el
   cartel de confirmación, que nombra a quiénes deja afuera. El cartel lo arma
   el backend, que es el que sabe lo que cada una tiene pendiente: contándolo en
   la pantalla salía el número de la empleada que estaba abierta.

   Se pone UNA vez en la vida del local, así que puesto se achica a un renglón
   gris: un casillero de fecha y dos botones arriba de la pantalla que se mira
   todos los días es algo que se mueve sin querer. */
function panelCorteSueldos(cont, alGuardar){
  if(!cont) return;
  cargar();

  async function cargar(){
    let cfg = {};
    try{ cfg = await (await authFetch("/api/config")).json(); }catch(e){ return; }
    pintar(cfg.sueldos_arranque || null);
  }

  // Argentina es UTC−3: sin restar las tres horas, después de las 21 el corte
  // viene propuesto con el día de mañana.
  const hoyIso = () => new Date(Date.now() - 3*3600*1000).toISOString().slice(0, 10);
  // El sábado con el que arranca la semana de pago: es donde tiene sentido
  // cortar, porque el ciclo va de sábado a viernes.
  function sabadoDeEstaSemana(){
    const d = new Date(hoyIso() + "T12:00:00");
    d.setDate(d.getDate() - ((d.getDay() + 1) % 7));
    return d.toISOString().slice(0, 10);
  }
  const corto = f => f ? f.slice(8,10) + "/" + f.slice(5,7) : "";

  function pintar(actual){
    const controles = `
      <input type="date" class="arrFecha" value="${actual || sabadoDeEstaSemana()}" max="${hoyIso()}">
      <button class="b-out btn-mini arrOk">${actual ? "Mover el corte" : "Poner el corte"}</button>
      ${actual ? `<button class="b-out btn-mini arrNo">Quitarlo</button>` : ""}`;
    cont.innerHTML = actual
      ? `<div class="arranque puesto">
           <span>Los sueldos de <b>todas</b> cuentan desde el <b>${corto(actual)}</b>.</span>
           <a href="#" class="arrVer">cambiar</a>
           <span class="arrCajon" style="display:none;">${controles}</span>
         </div>`
      : `<div class="arranque">
           <span>Los sueldos cuentan desde siempre: aparece todo lo que quedó sin pagar.
                 El corte vale para <b>todas</b> las empleadas.</span>
           ${controles}
         </div>`;

    const ver = cont.querySelector(".arrVer");
    if(ver) ver.onclick = e => {
      e.preventDefault();
      cont.querySelector(".arrCajon").style.display = "";
      ver.remove();
    };
    cont.querySelector(".arrOk").onclick = async () => {
      const f = cont.querySelector(".arrFecha").value;
      if(!f){ toast("Elegí desde qué día"); return; }
      let afuera = {ciclos: 0, total: 0, detalle: []};
      try{
        afuera = await (await authFetch("/api/sueldos/arranque?fecha=" + f)).json();
      }catch(e){ /* sin el detalle igual se puede poner: el cartel dice menos */ }
      const lista = (afuera.detalle || []).map(d =>
        `· ${d.nombre}: ${d.ciclos} ${d.ciclos === 1 ? "ciclo" : "ciclos"}, ${_pesos(d.total)}`).join("\n");
      if(!confirm(`Los sueldos de TODAS van a contar desde el ${corto(f)}.\n\n`
        + (afuera.ciclos
            ? `Dejan de aparecer ${afuera.ciclos} ${afuera.ciclos === 1 ? "ciclo" : "ciclos"} `
              + `de ${afuera.empleadas} ${afuera.empleadas === 1 ? "empleada" : "empleadas"}, `
              + `por ${_pesos(afuera.total)}:\n${lista}\n\n`
            : "No deja afuera ningún ciclo pendiente.\n\n")
        + "No se borra nada: si te equivocás, corrés el corte para atrás y vuelve todo.")) return;
      await guardar(f, "Corte puesto ✓");
    };
    const quitar = cont.querySelector(".arrNo");
    if(quitar) quitar.onclick = async () => {
      if(!confirm("Van a volver a aparecer todos los ciclos anteriores al corte, "
                + "de todas las empleadas. ¿Seguimos?")) return;
      await guardar(null, "Corte quitado ✓");
    };
  }

  async function guardar(fecha, aviso){
    const r = await authFetch("/api/sueldos/arranque", {method:"PUT",
      headers:{"Content-Type":"application/json"}, body: JSON.stringify({fecha})});
    if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo guardar"); return; }
    toast(aviso);
    await cargar();
    if(alGuardar) alGuardar();
  }
}
