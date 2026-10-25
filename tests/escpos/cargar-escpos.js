"use strict";

/* deCuenta() llama a toLocaleDateString() sin timeZone, o sea que usa la del
 * proceso: sin fijarla, el mismo FECHA_CONGELADA imprime un día distinto en la
 * máquina del que programa y en la de CI. Va ANTES de tocar cualquier Date,
 * que Node cachea la zona por proceso. */
process.env.TZ = "America/Argentina/Buenos_Aires";

const fs = require("node:fs");
const path = require("node:path");

const RUTA_ESCPOS = path.join(__dirname, "..", "..", "static", "escpos.js");

/* escpos.js se autoejecuta como (function(global){...})(window) y solo necesita
 * esa bolsa donde colgar EscPos. Va con el constructor Function y no con
 * require() —el archivo no tiene module.exports— ni con vm.runInContext(), que
 * crea un realm con su PROPIO Date y ahí mock.timers no llega. */
function cargarEscPos(){
  const codigo = fs.readFileSync(RUTA_ESCPOS, "utf8");
  const fakeWindow = {};
  new Function("window", codigo)(fakeWindow);
  return fakeWindow.EscPos;
}

module.exports = { cargarEscPos };
