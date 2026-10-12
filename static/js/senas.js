/* Señas: plata que la clienta deja adelantada, sin atarla a ningún ticket.

   Un solo dibujante para las dos pantallas que la usan —la ficha del cliente y
   facturar—, igual que las listas de Admin. Si fueran dos, el día que se agregue
   un campo acá una de las dos se queda sin pedirlo.

   La plata entra a la caja el día que se cobra la seña. Al aplicarla a un ticket
   no vuelve a entrar: ese abono salda la cuenta y nada más. */

const _escSena = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const _plataSena = n => "$" + (n || 0).toLocaleString("es-AR");

/* Cuánto vale una seña contra cada una de las dos listas.

   Lo guardado es la plata que ENTRÓ, que en efectivo es el 10% menos. Lo que la
   clienta tiene a favor es el otro número —el que se le dijo, el de la lista de
   transferencia— y es el que va en los carteles y en las listas. Tiene que dar
   igual que sena_saldado() en el backend: lo que la pantalla le dice es lo que
   se le va a cobrar. */
const valorSena = s => (s.forma_pago || "") === "Efectivo"
  ? Math.ceil((s.monto / 0.9) / 100) * 100 : s.monto;
const valorSenaEfectivo = s => (s.forma_pago || "") === "Efectivo"
  ? s.monto : Math.round(s.monto * 0.9);

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
   cada pantalla refresque lo suyo sin que este archivo sepa cómo.

   El monto es el monto, se pague como se pague: la cuenta de cuánto tapa de una
   factura se hace al facturar y no acá. Los tres botones son los montos de
   siempre, para no tipearlos. */
const MONTOS_SENA = [5000, 10000, 15000];

function panelSena(clienteId, nombre, alGuardar){
  const pan = document.createElement("div");
  pan.className = "panel-sena";
  // Sin clienta puesta, el formulario la pide: la seña se toma de la pantalla
  // de depilación, donde la lista es de TODAS, así que a quién es se dice acá.
  const eligeCliente = !clienteId;
  let elegido = clienteId || null;
  pan.innerHTML = `
    <div class="cab">
      <b>${eligeCliente ? "Tomar una seña" : "Seña de " + _escSena(nombre || "")}</b>
      <span class="det">Entra a la caja de hoy y se usa sola cuando se le facture, el día que sea.</span>
    </div>
    <div class="campos">
      ${eligeCliente ? `<div class="campo ancho sCli"><label>Cliente</label>
        <input class="sNombre" autocomplete="off" placeholder="Buscar o escribir el nombre">
        <div class="cli-drop sDrop"></div></div>` : ""}
      <div class="campo"><label>De cuánto es</label>
        <input type="number" class="sMonto" min="1" inputmode="numeric" placeholder="0"></div>
      <div class="campo"><label>Con qué paga</label><select class="sForma"></select></div>
    </div>
    <div class="montos">${MONTOS_SENA.map(m =>
      `<button type="button" class="b-out btn-mini sTipico" data-m="${m}">${_plataSena(m)}</button>`).join("")}</div>
    <p class="nota sCuenta"></p>
    <div class="acc">
      <button class="b-ok sGuardar">Tomar la seña</button>
      <button class="b-out sCancelar">Cancelar</button>
    </div>`;

  formasParaSena().then(fs => {
    pan.querySelector(".sForma").innerHTML =
      fs.map(f => `<option${f === "Efectivo" ? " selected" : ""}>${_escSena(f)}</option>`).join("");
    cuenta();
  });

  /* Lo que la clienta entrega y lo que le queda a favor.

     El monto que se pone es de cuánto es la seña, en los precios de la lista
     —los de transferencia, que son a los que se ancla el comprobante—. Pagando
     en efectivo entrega el 10% menos, igual que cualquier cosa en este local, y
     esa plata es la que entra a la caja: lo que se guarda es lo que entró.
     Mostrar los dos números es lo que evita la pregunta de todos los días. */
  const enEfectivo = () => pan.querySelector(".sForma").value === "Efectivo";
  const valor = () => parseInt(pan.querySelector(".sMonto").value, 10) || 0;
  const entra = () => enEfectivo() ? Math.round(valor() * 0.9) : valor();
  function cuenta(){
    const v = valor();
    pan.querySelector(".sCuenta").textContent = !v ? ""
      : enEfectivo()
        ? `Le cobrás ${_plataSena(entra())} en efectivo y le quedan ${_plataSena(v)} a favor.`
        : `Le cobrás ${_plataSena(v)} por transferencia y le quedan ${_plataSena(v)} a favor.`;
  }
  pan.querySelector(".sMonto").addEventListener("input", cuenta);
  pan.querySelector(".sForma").addEventListener("change", cuenta);

  pan.querySelector(".sCancelar").onclick = () => pan.remove();
  pan.querySelectorAll(".sTipico").forEach(b => {
    b.onclick = () => { pan.querySelector(".sMonto").value = b.dataset.m; cuenta(); };
  });

  if(eligeCliente){
    const inp = pan.querySelector(".sNombre"), drop = pan.querySelector(".sDrop");
    let t;
    inp.addEventListener("input", () => {
      elegido = null;
      clearTimeout(t);
      const q = inp.value.trim();
      if(!q){ drop.style.display = "none"; return; }
      t = setTimeout(async () => {
        const res = await (await authFetch("/api/clientes?q=" + encodeURIComponent(q))).json();
        if(!res.length){ drop.style.display = "none"; return; }
        drop.innerHTML = res.slice(0, 8).map(c => `
          <div class="cli-opt" data-id="${c.id}" data-nom="${_escSena(c.nombre)}">
            <b>${_escSena(c.nombre)}</b></div>`).join("");
        drop.style.display = "block";
      }, 200);
    });
    drop.addEventListener("click", e => {
      const o = e.target.closest(".cli-opt"); if(!o) return;
      elegido = Number(o.dataset.id); inp.value = o.dataset.nom;
      drop.style.display = "none";
      pan.querySelector(".sMonto").focus();
    });
  }

  pan.querySelector(".sGuardar").onclick = async () => {
    const v = valor();
    if(v <= 0){ toast("Poné de cuánto es la seña"); pan.querySelector(".sMonto").focus(); return; }
    if(eligeCliente && !elegido){
      // Tipeó un nombre y no lo eligió de la lista: si existe tal cual es esa,
      // y si no se pregunta antes de crearla. Una seña a nombre de una clienta
      // escrita apenas distinto no se le aplica nunca.
      const nom = pan.querySelector(".sNombre").value.trim();
      if(!nom){ toast("Decí de quién es la seña"); pan.querySelector(".sNombre").focus(); return; }
      const res = await (await authFetch("/api/clientes?q=" + encodeURIComponent(nom))).json();
      const igual = res.find(c => c.nombre.toLowerCase() === nom.toLowerCase());
      if(igual){ elegido = igual.id; }
      else {
        if(!confirm(`"${nom}" no está en la lista de clientes.\n\n¿Lo creamos?`)) return;
        const rc = await authFetch("/api/clientes", {method:"POST",
          headers:{"Content-Type":"application/json"}, body: JSON.stringify({nombre: nom})});
        if(!rc.ok){ toast((await rc.json().catch(()=>({}))).detail || "No se pudo crear"); return; }
        elegido = (await rc.json()).id;
      }
    }
    // Se guarda lo que ENTRÓ, no el valor: de eso depende el arqueo. Lo que
    // vale contra una factura lo calcula el backend al aplicarla.
    const r = await authFetch("/api/senas", {method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({cliente_id: elegido, monto: entra(),
                            forma_pago: pan.querySelector(".sForma").value})});
    if(!r.ok){ toast((await r.json().catch(()=>({}))).detail || "No se pudo"); return; }
    const s = await r.json();
    pan.remove();
    toast(`Seña de ${_plataSena(v)} tomada`);
    if(alGuardar) alGuardar(s);
    // El papel es opcional: la seña ya quedó registrada. Se ofrece acá y no se
    // imprime solo porque casi siempre alcanza con que esté anotada.
    if(confirm(`Seña anotada: entraron ${_plataSena(s.monto)}.\n\n¿Le imprimimos el recibo?`))
      location.href = `/ticket?tipo=sena&id=${s.id}`;
  };
  pan.querySelector(".sMonto").addEventListener("keydown", e => {
    if(e.key === "Enter"){ e.preventDefault(); pan.querySelector(".sGuardar").click(); }
  });
  setTimeout(() => pan.querySelector(eligeCliente ? ".sNombre" : ".sMonto").focus(), 0);
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
        <b>${_plataSena(valorSena(s))}</b>
        <span class="det">N-${String(s.numero || 0).padStart(5,"0")} · ${s.fecha} · ${_escSena(s.forma_pago || "")}${
          valorSena(s) !== s.monto ? ` (entraron ${_plataSena(s.monto)})` : ""}${
          s.notas ? " · " + _escSena(s.notas) : ""}</span>
      </div>
      <span class="estado">${s.anulada ? "devuelta"
        : s.usada ? `usada en N-${String(s.comprobante_numero || 0).padStart(5,"0")}`
        : "a favor"}</span>`;
    const imp = document.createElement("a");
    imp.className = "b-out"; imp.textContent = "🖨️ Recibo";
    imp.href = `/ticket?tipo=sena&id=${s.id}`;
    fila.appendChild(imp);
    if(!s.usada && !s.anulada && alAnular && getRol() === "dueno"){
      const b = document.createElement("button");
      b.className = "b-out"; b.textContent = "Devolver";
      b.onclick = () => alAnular(s);
      fila.appendChild(b);
    }
    cont.appendChild(fila);
  });
}
