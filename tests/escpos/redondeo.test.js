"use strict";

/* La pantalla y el backend tienen que redondear igual: lo que se le dice a la
 * clienta es lo que cobra round() de Python, que manda el medio peso al par. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { cargarEscPos } = require("./cargar-escpos");

const { redondear } = cargarEscPos();

test("redondear() da lo mismo que round() de Python", () => {
  // [cuenta, lo que da Python]: el 15% de $4.550 son $682,50 y Python cobra $682
  const casos = [[4550 * 15 / 100, 682], [1350 * 15 / 100, 202], [4450 * 15 / 100, 668],
                 [450 * 85 / 100, 382], [450 * 115 / 100, 518], [2.5, 2], [3.5, 4],
                 [682.4, 682], [682.6, 683], [0, 0], [-2.5, -2], [-3.5, -4]];
  for(const [x, py] of casos) assert.equal(redondear(x), py, `redondear(${x})`);
});
