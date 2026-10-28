/* Abre cada pantalla en un navegador y busca lo que no se puede saber leyendo
 * el código: algo escondido que igual se ve, un id repetido de verdad en el
 * DOM, un error de JavaScript, una pantalla que desborda en el celular.
 *
 *     node revisar_pantallas.js [http://127.0.0.1:8000] [usuario] [clave]
 *
 * Necesita playwright-core. Si no está instalado en el proyecto, se le pasa
 * dónde está con PLAYWRIGHT=/ruta/a/playwright-core.
 */
const RUTA_PW = process.env.PLAYWRIGHT || "playwright-core";
let chromium;
try { ({ chromium } = require(RUTA_PW)); }
catch { console.error(`No encuentro playwright-core. Instalalo o pasá PLAYWRIGHT=/ruta.`); process.exit(2); }

const BASE  = process.argv[2] || "http://127.0.0.1:8000";
const USER  = process.argv[3] || "dueno";
const CLAVE = process.argv[4] || "dueno1234";
const NAVEGADOR = process.env.CHROME || undefined;
const PANTALLAS = ["facturar","depilacion","caja","clientes","historial",
                   "agenda","inventario","sueldos","reportes","admin"];
const ANCHO_CELU = 390;

(async () => {
  const b = await chromium.launch(NAVEGADOR ? {executablePath:NAVEGADOR} : {});
  const p = await b.newPage({viewport:{width:1280, height:900}});
  const errores = [];                       // los junta por pantalla, abajo
  let dondeEstoy = "login";
  p.on("pageerror", e => errores.push([dondeEstoy, "error de JavaScript: " + e.message]));
  p.on("console", m => { if(m.type() === "error") errores.push([dondeEstoy, "consola: " + m.text()]); });

  await p.goto(BASE + "/login");
  await p.fill("#u", USER); await p.fill("#p", CLAVE); await p.click("#btn");
  await p.waitForTimeout(2500);

  const hallazgos = [];
  for(const r of PANTALLAS){
    dondeEstoy = r;
    await p.goto(`${BASE}/${r}`);
    await p.waitForTimeout(1800);

    /* Escondido pero visible: una clase con `display` le gana al `hidden` del
       navegador, así que el elemento se ve y el botón que lo abre no hace nada. */
    for(const e of await p.$$eval("[hidden]", ns => ns.map(n =>
          getComputedStyle(n).display === "none" ? null
          : `<${n.tagName.toLowerCase()} id="${n.id||"?"}" class="${n.className||"?"}">`).filter(Boolean)))
      hallazgos.push([r, `escondido pero se ve: ${e}`]);

    /* Id repetido: querySelector agarra el primero y el otro queda muerto. */
    for(const e of await p.evaluate(() => {
          const n = {};
          document.querySelectorAll("[id]").forEach(x => n[x.id] = (n[x.id]||0) + 1);
          return Object.entries(n).filter(([,c]) => c > 1).map(([i,c]) => `${i} (${c} veces)`);
        }))
      hallazgos.push([r, `id repetido en el DOM: ${e}`]);

    /* En el celular: la página no se desliza de costado. Una columna de plata
       no se parte, así que empuja el ancho y el botón del final queda afuera. */
    await p.setViewportSize({width:ANCHO_CELU, height:780});
    await p.waitForTimeout(700);
    const desborde = await p.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if(desborde > 2) hallazgos.push([r, `desborda ${desborde}px a lo ancho en el celular`]);
    await p.setViewportSize({width:1280, height:900});
    await p.waitForTimeout(400);
  }

  const todo = hallazgos.concat(errores);
  console.log(`\nEN EL NAVEGADOR — ${todo.length} hallazgo(s)`);
  console.log("-".repeat(74));
  if(!todo.length) console.log("  nada");
  todo.sort().forEach(([d, q]) => console.log(`  ${d.padEnd(14)} ${q}`));
  await b.close();
})();
