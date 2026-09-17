/* Los dos números con los que se paga cuando alguien no tiene el suyo.

   Un solo dibujante para las dos pantallas que los muestran —Admin, arriba de
   la lista de empleados, y Sueldos, que es donde se liquida—, igual que las
   cinco listas de listas.js. Si fueran dos, el día que se agregue un tercer
   número una de las dos se queda sin pedirlo.

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
      <button class="b-ok gGuardar">Guardar</button>
      <span class="nota">Se usan para todas. La que tenga lo suyo cobra lo suyo.</span>
    </div>`;

  const hora = cont.querySelector(".gHora"), pct = cont.querySelector(".gPct");

  authFetch("/api/config").then(r => r.json()).then(c => {
    hora.value = c.valor_hora ?? 0;
    pct.value  = c.comision_pct ?? 40;
  }).catch(() => {});

  cont.querySelector(".gGuardar").onclick = async () => {
    const v = Math.max(0, parseInt(hora.value, 10) || 0);
    const p = Math.max(0, parseInt(pct.value, 10) || 0);
    if(p > 100){ toast("La comisión no puede pasar de 100%"); pct.focus(); return; }
    const r = await authFetch("/api/config/sueldos", {method:"PUT",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({valor_hora: v, comision_pct: p})});
    if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo"); return; }
    toast("Guardado");
    if(alGuardar) alGuardar({valor_hora: v, comision_pct: p});
  };

  [hora, pct].forEach(i => i.addEventListener("keydown", ev => {
    if(ev.key === "Enter") cont.querySelector(".gGuardar").click();
  }));
}
