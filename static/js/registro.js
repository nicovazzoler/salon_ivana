/* Horas en el local y trabajos con comisión de cada una, por semana de sábado a
   viernes. Lo arma el backend: lo pagado sale de la foto de cada pago y la
   semana en curso de lo pendiente. */
async function panelRegistro(cont){
  let datos;
  try{ datos = await (await authFetch("/api/sueldos/registro?semanas=9")).json(); }
  catch(e){ cont.innerHTML = `<p class="muted">No se pudo cargar.</p>`; return; }
  if(!datos.empleadas.length){ cont.innerHTML = `<p class="muted">Todavía no hay horas cargadas.</p>`; return; }

  // El color es de la persona y no del lugar en la lista: filtrar no repinta a nadie.
  // Más de cuatro no tienen color propio y van juntas en "Otras".
  const SERIES = datos.empleadas.slice(0, datos.empleadas.length > 4 ? 3 : 4)
    .map((e, i) => ({ nombre: e.nombre, color: `var(--serie-${i + 1})`, semanas: e.semanas }));
  if(datos.empleadas.length > 4){
    const resto = datos.empleadas.slice(3);
    SERIES.push({ nombre: "Otras", color: "var(--serie-otras)",
      semanas: datos.semanas.map((_, i) => resto.reduce((a, e) => {
        for(const k in a) a[k] += e.semanas[i][k];
        return a;
      }, { minutos: 0, trabajos: 0, minutos_trabajos: 0, comisiones: 0 })) });
  }
  let filtro = "todas";
  const pesos = n => "$" + (n || 0).toLocaleString("es-AR");
  const horas = m => { const h = Math.floor(m / 60), r = m % 60; return h ? `${h} h${r ? " " + String(r).padStart(2, "0") : ""}` : `${r} min`; };
  const dm = iso => { const [, m, d] = iso.split("-").map(Number); return `${d}/${m}`; };
  const tip = document.createElement("div");
  tip.className = "tip"; tip.hidden = true;
  document.body.appendChild(tip);

  function escala(max, pasos){
    const paso = pasos.find(p => max / p <= 4) || pasos[pasos.length - 1];
    return { paso, tope: Math.max(paso, Math.ceil(max / paso) * paso) };
  }

  function barras(series, campo, titulo, sub){
    const W = 420, H = 210, L = 38, B = 24, T = 8, n = datos.semanas.length;
    const ancho = (W - L) / n, bw = Math.min(26, ancho - 10);
    const tot = datos.semanas.map((_, i) => series.reduce((a, s) => a + s.semanas[i][campo], 0));
    const { paso, tope } = campo === "minutos" ? escala(Math.max(...tot), [300, 600, 1200, 2400, 4800, 9600])
                                               : escala(Math.max(...tot), [5, 10, 20, 50, 100, 200]);
    const y = v => T + (H - T - B) * (1 - v / tope);
    let g = "";
    for(let v = 0; v <= tope; v += paso)
      g += `<line class="${v ? "grilla" : "base"}" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>`
         + `<text class="eje" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${campo === "minutos" ? v / 60 + " h" : v}</text>`;
    datos.semanas.forEach((s, i) => {
      const x = L + i * ancho + (ancho - bw) / 2, actual = i === n - 1;
      const con = series.filter(se => se.semanas[i][campo]);
      let acc = 0;
      con.forEach((se, k) => {
        const v = se.semanas[i][campo], y0 = y(acc), y1 = y(acc + v);
        // 2px de fondo entre un tramo y el de abajo; el de arriba lleva las puntas redondeadas.
        const alto = Math.max(0, y0 - y1 - (k ? 2 : 0));
        const op = actual ? ' fill-opacity=".55"' : "";
        g += k === con.length - 1 && alto > 4
          ? `<path d="M${x},${y1 + alto} V${y1 + 4} Q${x},${y1} ${x + 4},${y1} H${x + bw - 4} Q${x + bw},${y1} ${x + bw},${y1 + 4} V${y1 + alto} Z" fill="${se.color}"${op}/>`
          : `<rect x="${x}" y="${y1}" width="${bw}" height="${alto}" fill="${se.color}"${op}/>`;
        acc += v;
      });
      g += `<text class="eje" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${actual ? "esta" : dm(s.desde)}</text>`;
      g += `<rect class="col-hit" data-i="${i}" x="${L + i * ancho}" y="${T}" width="${ancho}" height="${H - T - B}" rx="6"/>`;
    });
    return `<div class="graf" data-campo="${campo}"><h3>${titulo}</h3><div class="sub">${sub}</div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${titulo}">${g}</svg></div>`;
  }

  function pintar(){
    const series = filtro === "todas" ? SERIES : SERIES.filter(s => s.nombre === filtro);
    const suma = s => s.semanas.reduce((a, x) => ({ minutos: a.minutos + x.minutos, trabajos: a.trabajos + x.trabajos,
      minutos_trabajos: a.minutos_trabajos + x.minutos_trabajos, comisiones: a.comisiones + x.comisiones }),
      { minutos: 0, trabajos: 0, minutos_trabajos: 0, comisiones: 0 });
    const filas = series.map(s => [s, suma(s)]);
    const total = filas.reduce((a, [, t]) => { for(const k in a) a[k] += t[k]; return a; },
      { minutos: 0, trabajos: 0, minutos_trabajos: 0, comisiones: 0 });
    const celdas = t => `<td>${horas(t.minutos)}</td><td>${t.trabajos}</td><td>${horas(t.minutos_trabajos)}</td><td>${pesos(t.comisiones)}</td>`;
    cont.innerHTML = `
      <div class="reg-filtros">${["todas", ...SERIES.map(s => s.nombre)].map(nom =>
        `<button class="chip${filtro === nom ? " on" : ""}" data-n="${esc(nom)}">${nom === "todas" ? "Todas" : esc(nom)}</button>`).join("")}</div>
      ${series.length > 1 ? `<div class="leyenda">${series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.nombre)}</span>`).join("")}</div>` : ""}
      <div class="graficos">
        ${barras(series, "minutos", "Horas en el local", "por semana, de sábado a viernes · la última es la de esta semana")}
        ${barras(series, "trabajos", "Trabajos con comisión", "por semana")}
      </div>
      <div class="tabla-scroll"><table class="tabla-reg">
        <thead><tr><th>Últimas ${datos.semanas.length} semanas</th><th>En el local</th><th>Trabajos</th><th>Tiempo en trabajos</th><th>Comisiones</th></tr></thead>
        <tbody>${filas.map(([s, t]) => `<tr><td><i style="background:${s.color}"></i><b>${esc(s.nombre)}</b></td>${celdas(t)}</tr>`).join("")}
        ${series.length > 1 ? `<tr class="tot"><td>Todas</td>${celdas(total)}</tr>` : ""}</tbody></table></div>`;
    cont.querySelectorAll(".reg-filtros .chip").forEach(b => b.onclick = () => { filtro = b.dataset.n; pintar(); });
    cont.querySelectorAll(".col-hit").forEach(r => {
      const mostrar = ev => {
        const i = Number(r.dataset.i), s = datos.semanas[i], campo = r.closest(".graf").dataset.campo;
        const val = se => campo === "minutos" ? horas(se.semanas[i].minutos) : String(se.semanas[i].trabajos);
        tip.innerHTML = `<b>${i === datos.semanas.length - 1 ? "Esta semana" : `Del ${dm(s.desde)} al ${dm(s.hasta)}`}</b>`
          + series.map(se => `<div class="t"><i style="background:${se.color}"></i><span>${esc(se.nombre)}</span><span>${val(se)}</span></div>`).join("");
        tip.hidden = false;
        tip.style.left = Math.min(ev.clientX + 14, innerWidth - tip.offsetWidth - 8) + "px";
        tip.style.top = (ev.clientY + 14) + "px";
      };
      r.onpointermove = mostrar;
      r.onpointerdown = mostrar;
      r.onpointerleave = () => tip.hidden = true;
    });
  }
  pintar();
  addEventListener("scroll", () => tip.hidden = true, { passive: true });
}
