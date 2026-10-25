"use strict";

/* Regenera los .bin de referencia a partir de los fixtures, a mano, cuando un
 * cambio en escpos.js mueve el papel a propósito:
 *     node tests/escpos/generar-golden.js
 * Usa el mismo FECHA_CONGELADA que el test, así el .bin no depende del día. */
const fs = require("node:fs");
const path = require("node:path");
const { mock } = require("node:test");
const { cargarEscPos } = require("./cargar-escpos");
const { FECHA_CONGELADA, CASOS } = require("./config");

const DIR_FIXTURES = path.join(__dirname, "fixtures");
const DIR_GOLDEN = path.join(__dirname, "golden");

function main(){
  fs.mkdirSync(DIR_GOLDEN, { recursive: true });

  const EscPos = cargarEscPos();
  const negocio = JSON.parse(fs.readFileSync(path.join(DIR_FIXTURES, "negocio.json"), "utf8"));

  mock.timers.enable({ apis: ["Date"], now: FECHA_CONGELADA });
  try {
    for(const caso of CASOS){
      const datos = JSON.parse(fs.readFileSync(path.join(DIR_FIXTURES, caso.fixture), "utf8"));
      const bytes = EscPos[caso.fn](datos, negocio);
      fs.writeFileSync(path.join(DIR_GOLDEN, caso.golden), Buffer.from(bytes));
      console.log("generado:", caso.golden, `(${bytes.length} bytes)`);
    }
  } finally {
    mock.timers.reset();
  }
}

main();
