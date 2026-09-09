/* Quién atendió, adentro del detalle de un comprobante ya emitido.

   Es lo único editable de un comprobante cobrado, y a propósito: los importes no
   se tocan nunca después de emitido. Pero el peluquero se olvida seguido, y sin
   él la comisión de ese trabajo no le llega a nadie: el sueldo se arma
   comparando este nombre con la lista de empleados.

   Un solo dibujante, usado por el detalle de Cuenta y por el de Historial. Si
   fueran dos, el día que se agregue algo acá una de las dos pantallas se
   quedaría sin ello, que es lo que ya pasó con las listas de Admin. */

let _EMPLEADOS = null;
// Propio y no el de la pantalla: este archivo lo usan dos, y no todas tienen un
// esc() a mano.
const _escPelu = s => String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

async function empleadosParaElegir(){
  // Se pide una sola vez por pantalla: la lista es de tres nombres y el detalle
  // se abre y se cierra muchas veces seguidas.
  if(!_EMPLEADOS){
    try{ _EMPLEADOS = await (await authFetch("/api/empleados")).json(); }
    catch(e){ _EMPLEADOS = []; }
  }
  return _EMPLEADOS;
}

/* Se dibuja para LEER: dice quién atendió y listo. El desplegable aparece recién
   cuando se toca "cambiar", así el detalle de un comprobante no es un formulario
   a medio llenar. Si no hay nadie puesto, en cambio, arranca abierto: es un dato
   que falta y hay que verlo. */
async function pintarPeluquero(caja, comp){
  if(!caja) return;
  const emps = await empleadosParaElegir();
  if(!emps.length) return;               // sin lista de empleados no hay nada que elegir
  let actual = comp.peluquero || null;

  const dibujar = (abierto) => {
    if(!abierto){
      caja.innerHTML = `<span class="lbl">Atendió</span>
        <span class="quien">${_escPelu(actual)}</span>
        <button type="button" class="b-out cambiar">Cambiar</button>`;
      caja.querySelector(".cambiar").onclick = () => dibujar(true);
      return;
    }
    const opciones = emps.map(e=>`<option${e.nombre===actual?" selected":""}>${_escPelu(e.nombre)}</option>`).join("");
    caja.innerHTML = `<span class="lbl">${actual ? "Atendió" : "¿Quién atendió?"}</span>
      <select class="sel">${actual?"":`<option value="">Elegí…</option>`}${opciones}</select>
      <button type="button" class="b-ok guardar">Guardar</button>`;
    caja.querySelector(".guardar").onclick = async () => {
      const nombre = caja.querySelector(".sel").value;
      if(!nombre) return;
      const r = await authFetch(`/api/comprobantes/${comp.id}/peluquero`,
        {method:"PUT", headers:{"Content-Type":"application/json"},
         body: JSON.stringify({peluquero: nombre})});
      if(!r.ok){
        const e = await r.json().catch(()=>({}));
        if(window.toast) toast(e.detail || "No se pudo guardar");
        return;
      }
      actual = (await r.json()).peluquero;
      comp.peluquero = actual;
      if(window.toast) toast("Atendió " + actual);
      dibujar(false);
    };
  };
  caja.className = "quien-atendio";
  dibujar(!actual);
}
