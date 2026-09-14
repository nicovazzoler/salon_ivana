/* Señas: plata que la clienta deja adelantada, sin atarla a ningún ticket.

   Un solo dibujante para las dos pantallas que la usan —la ficha del cliente y
   facturar—, igual que las listas de Admin. Si fueran dos, el día que se agregue
   un campo acá una de las dos se queda sin pedirlo.

   La plata entra a la caja el día que se cobra la seña. Al aplicarla a un ticket
   no vuelve a entrar: ese abono salda la cuenta y nada más. */

const _escSena = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const _plataSena = n => "$" + (n || 0).toLocaleString("es-AR");

let _FORMAS_SENA = null;
async function formasParaSena(){
  if(!_FORMAS_SENA){
    try{
      const c = await (await authFetch("/api/config")).json();
      _FORMAS_SENA = c.formas_pago || ["Efectivo", "Transferencia"];
    }catch(e){ _FORMAS_SENA = ["Efectivo", "Transferencia"]; }
  }
  return _FORMAS_SENA;
}

async function senasLibres(clienteId){
  if(!clienteId) return [];
  try{ return await (await authFetch(`/api/senas?cliente_id=${clienteId}&solo_libres=true`)).json(); }
  catch(e){ return []; }
}

/* El formulario para tomar una seña. `alGuardar` recibe la seña creada, para que
   cada pantalla refresque lo suyo sin que este archivo sepa cómo. */
function panelSena(clienteId, nombre, alGuardar){
  const pan = document.createElement("div");
  pan.className = "panel-sena";
  pan.innerHTML = `
    <div class="cab">
      <b>Seña de ${_escSena(nombre || "")}</b>
      <span class="det">Entra a la caja de hoy. Se usa cuando se le facture, sin ticket ahora.</span>
    </div>
    <div class="campos">
      <div class="campo"><label>Monto</label>
        <input type="number" class="sMonto" min="1" inputmode="numeric" placeholder="0"></div>
      <div class="campo"><label>Con qué paga</label><select class="sForma"></select></div>
      <div class="campo ancho"><label>Para qué (opcional)</label>
        <input class="sNotas" placeholder="Ej: depilación del lunes 14"></div>
    </div>
    <div class="acc">
      <button class="b-ok sGuardar">Tomar la seña</button>
      <button class="b-out sCancelar">Cancelar</button>
    </div>`;

  formasParaSena().then(fs => {
    pan.querySelector(".sForma").innerHTML =
      fs.map(f => `<option${f === "Efectivo" ? " selected" : ""}>${_escSena(f)}</option>`).join("");
  });

  pan.querySelector(".sCancelar").onclick = () => pan.remove();
  pan.querySelector(".sGuardar").onclick = async () => {
    const monto = parseInt(pan.querySelector(".sMonto").value, 10) || 0;
    if(monto <= 0){ toast("Poné cuánto dejó"); pan.querySelector(".sMonto").focus(); return; }
    const r = await authFetch("/api/senas", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({cliente_id: clienteId, monto,
                            forma_pago: pan.querySelector(".sForma").value,
                            notas: pan.querySelector(".sNotas").value})});
    if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo"); return; }
    const s = await r.json();
    pan.remove();
    toast(`Seña de ${_plataSena(s.monto)} tomada`);
    if(alGuardar) alGuardar(s);
  };
  pan.querySelector(".sMonto").addEventListener("keydown", e => {
    if(e.key === "Enter"){ e.preventDefault(); pan.querySelector(".sGuardar").click(); }
  });
  setTimeout(() => pan.querySelector(".sMonto").focus(), 0);
  return pan;
}

/* La lista de señas de una clienta, para la ficha. Las usadas se ven igual: es
   la prueba de que esa plata ya se descontó, y sin ellas parecería que se perdió. */
function pintarSenas(cont, senas, alAnular){
  if(!senas.length){
    cont.innerHTML = `<p class="muted" style="margin:0;">Sin señas.</p>`;
    return;
  }
  cont.innerHTML = "";
  senas.forEach(s => {
    const fila = document.createElement("div");
    fila.className = "sena-fila" + (s.usada ? " usada" : "") + (s.anulada ? " anulada" : "");
    fila.innerHTML = `
      <div>
        <b>${_plataSena(s.monto)}</b>
        <span class="det">${s.fecha} · ${_escSena(s.forma_pago || "")}${
          s.notas ? " · " + _escSena(s.notas) : ""}</span>
      </div>
      <span class="estado">${s.anulada ? "devuelta"
        : s.usada ? `usada en N-${String(s.comprobante_id).padStart(5,"0")}`
        : "a favor"}</span>`;
    if(!s.usada && !s.anulada && alAnular && getRol() === "dueno"){
      const b = document.createElement("button");
      b.className = "b-out"; b.textContent = "Devolver";
      b.onclick = () => alAnular(s);
      fila.appendChild(b);
    }
    cont.appendChild(fila);
  });
}
