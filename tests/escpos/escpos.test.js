"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { cargarEscPos } = require("./cargar-escpos");
const { FECHA_CONGELADA, CASOS } = require("./config");
const { describirDiferencia } = require("./describir-diferencia");

const DIR_FIXTURES = path.join(__dirname, "fixtures");
const DIR_GOLDEN = path.join(__dirname, "golden");

const EscPos = cargarEscPos();
const negocio = JSON.parse(fs.readFileSync(path.join(DIR_FIXTURES, "negocio.json"), "utf8"));

for(const caso of CASOS){
  test(`${caso.fn}: ${caso.fixture} coincide byte a byte con ${caso.golden}`, (t) => {
    // Congelado por test: deCuenta() imprime la fecha de hoy con
    // new Date() sin argumento (ver config.js), y sin esto el golden
    // fallaría según el día en que se corra el test.
    t.mock.timers.enable({ apis: ["Date"], now: FECHA_CONGELADA });

    const datos = JSON.parse(fs.readFileSync(path.join(DIR_FIXTURES, caso.fixture), "utf8"));
    const actual = Buffer.from(EscPos[caso.fn](datos, negocio));
    const esperado = fs.readFileSync(path.join(DIR_GOLDEN, caso.golden));

    const dif = describirDiferencia(esperado, actual);
    if(dif){
      assert.fail(
        `El papel generado difiere del golden "${caso.golden}" ` +
        `(esperado ${esperado.length} bytes, obtenido ${actual.length} bytes).\n` +
        `Primer byte distinto en la posición ${dif.posicion}: ` +
        `esperado 0x${dif.byteEsperado !== null ? dif.byteEsperado.toString(16).padStart(2, "0") : "--"}, ` +
        `obtenido 0x${dif.byteActual !== null ? dif.byteActual.toString(16).padStart(2, "0") : "--"}.\n` +
        `Cae en el renglón ${dif.renglon} del papel:\n` +
        `  esperado: "${dif.renglonEsperado}"\n` +
        `  obtenido: "${dif.renglonActual}"`
      );
    }
  });
}
