"use strict";

/* deCuenta() llama a toLocaleDateString() sin pasarle timeZone: usa la zona
 * horaria del proceso que lo ejecuta, no la de Argentina. Sin fijarla acá, el
 * mismo FECHA_CONGELADA (config.js) podría imprimir un día distinto según la
 * zona horaria de la máquina que corre el test (el reloj del desarrollador,
 * un servidor de CI, etc.), y el golden dejaría de ser reproducible entre
 * máquinas aunque el instante esté congelado. Se fija ANTES de tocar
 * cualquier Date porque Node cachea la zona horaria por proceso.
 */
process.env.TZ = "America/Argentina/Buenos_Aires";

const fs = require("node:fs");
const path = require("node:path");

const RUTA_ESCPOS = path.join(__dirname, "..", "..", "static", "escpos.js");

/* escpos.js se autoejecuta como (function(global){...})(window): solo
 * necesita ese "window" como bolsa donde colgar EscPos, no toca document,
 * fetch ni localStorage (ver CLAUDE.md y la respuesta de la sesión anterior).
 *
 * Lo cargamos con el constructor Function, no con vm.runInContext() ni con
 * require(). require() no sirve porque el archivo no tiene module.exports:
 * solo cuelga EscPos de su parámetro "window". Y vm.runInContext() crea un
 * realm nuevo con su PROPIO Date, aislado del de este proceso; ahí
 * mock.timers.enable() -que parchea el Date global de Node- no tendría
 * ningún efecto sobre el Date que ve escpos.js, y el reloj no se podría
 * congelar sin tocar el archivo. Con Function, en cambio, el código corre en
 * el mismo realm que el test: comparte el Date real de Node, y
 * mock.timers.enable() sí lo intercepta.
 */
function cargarEscPos(){
  const codigo = fs.readFileSync(RUTA_ESCPOS, "utf8");
  const fakeWindow = {};
  new Function("window", codigo)(fakeWindow);
  return fakeWindow.EscPos;
}

module.exports = { cargarEscPos };
