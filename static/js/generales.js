/* Los dos números de la depilación —el pago a la ayudante y quién lleva las
   sesiones— y el corte de los sueldos, un solo dibujante para Admin y Sueldos.

   Van escritos y no en casilleros, con un botón de Editar: son configuración del
   local, se tocan una vez cada varios meses. */

const _escGral = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const _pesos = n => "$" + (n || 0).toLocaleString("es-AR");

function panelNumerosDepi(cont){
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

  function pintar(){
    const sel = cfg.depi_a_cargo || "";
    const campos = [
      ["Pago a la ayudante",  `<input type="number" class="gAyu" min="0" inputmode="numeric" value="${cfg.pago_ayudante ?? 0}">`,
                              _pesos(cfg.pago_ayudante)],
      ["Las sesiones las lleva", `<select class="gDepi"><option value="">La que más facture</option>${
                                emps.filter(e => e.activo !== false).map(e => `<option${e.nombre === sel ? " selected" : ""}>${_escGral(e.nombre)}</option>`).join("")}</select>`,
                              sel ? _escGral(sel) : `<span class="flojo">la que más facture</span>`],
    ];
    caja.innerHTML = `
      <div class="gral-cab">
        <h3>Los números de la depilación</h3>
        ${editando
          ? `<span class="gral-acc"><button class="b-ok gGuardar">Guardar</button>
             <button class="b-out gCancelar">Cancelar</button></span>`
          : `<button class="b-out btn-mini gEditar">Editar</button>`}
      </div>
      <div class="gral-valores">
        ${campos.map(([rot, edit, texto]) => `
          <div class="campo"><label>${rot}</label>
            ${editando ? edit : `<b class="val">${texto}</b>`}</div>`).join("")}
      </div>`;

    const editar = caja.querySelector(".gEditar");
    if(editar) editar.onclick = () => { editando = true; pintar(); caja.querySelector(".gAyu").focus(); };
    const cancelar = caja.querySelector(".gCancelar");
    if(cancelar) cancelar.onclick = () => { editando = false; pintar(); };
    const guardar = caja.querySelector(".gGuardar");
    if(guardar){
      guardar.onclick = guardarDepi;
      caja.querySelectorAll(".gral-valores input").forEach(i => i.addEventListener("keydown", ev => {
        if(ev.key === "Enter") guardar.click();
        if(ev.key === "Escape") cancelar.click();
      }));
    }
  }

  async function guardarDepi(){
    const a = Math.max(0, parseInt(caja.querySelector(".gAyu").value, 10) || 0);
    const d = caja.querySelector(".gDepi").value;
    const cambios = [];
    if(a !== (cfg.pago_ayudante ?? 0)) cambios.push(`El pago a la ayudante pasa a ${_pesos(a)}, `
      + "que es el que va a venir puesto en el próximo día de depilación.");
    if(d !== (cfg.depi_a_cargo || "")) cambios.push(d
      ? `Las sesiones de depilación nuevas arrancan con ${d}, salvo que al abrirla se elija a otra. `
        + "Las que ya están abiertas no cambian."
      : "Las sesiones nuevas vuelven a arrancar con la que más facture.");
    if(!cambios.length){ editando = false; pintar(); return; }
    if(!await confirmar(cambios.join("\n\n") + "\n\n¿Guardamos?", { si: "Guardar" })) return;
    const r = await authFetch("/api/config/sueldos", {method:"PUT",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({pago_ayudante: a, depi_a_cargo: d})});
    if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo"); return; }
    toast("Guardado");
    editando = false;
    await cargar();
  }
}

/* El borrón y cuenta nueva de los sueldos, un solo dibujante para Admin y para
   Sueldos. NO borra nada: correrlo para atrás devuelve los trabajos y las horas.

   Es UNO para todo el local y no por empleada. El cartel lo arma el backend, que
   es el que sabe lo que cada una tiene pendiente. */
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
           <span>Sin corte, los sueldos cuentan desde siempre.</span>
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
      let afuera = {dias: 0, total: 0, detalle: []};
      try{
        afuera = await (await authFetch("/api/sueldos/arranque?fecha=" + f)).json();
      }catch(e){ /* sin el detalle igual se puede poner: el cartel dice menos */ }
      const lista = (afuera.detalle || []).map(d =>
        `· ${d.nombre}: ${d.dias} ${d.dias === 1 ? "día" : "días"}, ${_pesos(d.total)}`).join("\n");
      if(!await confirmar(`Los sueldos de TODAS van a contar desde el ${corto(f)}.\n\n`
        + (afuera.dias
            ? `Dejan de aparecer ${afuera.dias} ${afuera.dias === 1 ? "día" : "días"} sin pagar `
              + `de ${afuera.empleadas} ${afuera.empleadas === 1 ? "empleada" : "empleadas"}, `
              + `por ${_pesos(afuera.total)}:\n${lista}\n\n`
            : "No deja afuera nada pendiente.\n\n")
        + "No se borra nada: si te equivocás, corrés el corte para atrás y vuelve todo.", { si: "Mover el corte" })) return;
      await guardar(f, "Corte puesto ✓");
    };
    const quitar = cont.querySelector(".arrNo");
    if(quitar) quitar.onclick = async () => {
      if(!await confirmar("Va a volver a aparecer todo lo pendiente anterior al corte, "
                + "de todas las empleadas. ¿Seguimos?", { si: "Quitar el corte" })) return;
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
