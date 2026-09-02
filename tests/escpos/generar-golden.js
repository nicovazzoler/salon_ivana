"use strict";

/* Regenera los .bin de referencia en tests/escpos/golden/ a partir de los
 * fixtures. Se corre a mano cuando un cambio en escpos.js cambia el papel a
 * propósito: node tests/escpos/generar-golden.js
 *
 * Usa el mismo instante congelado que el test (FECHA_CONGELADA, en
 * config.js): así el .bin que se genera acá es exactamente el que
 * escpos.test.js espera encontrar, sin importar qué día se corra este
 * script. */
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
