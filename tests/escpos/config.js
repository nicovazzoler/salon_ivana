"use strict";

/* Instante congelado para los golden tests de escpos.js.
 *
 * deCuenta() imprime la fecha de "hoy" con new Date().toLocaleDateString(),
 * sin argumento: si no se congela el reloj, ese renglón cambia todos los días
 * y el golden falla aunque el código no se haya tocado.
 *
 * Elegimos mediodía en Argentina (15:00 UTC = 12:00 ART, UTC-3) a propósito,
 * no una hora cercana a la medianoche. toLocaleDateString() no recibe un
 * timeZone explícito en escpos.js, así que resuelve la fecha con la zona
 * horaria del proceso que lo ejecuta (ver cargar-escpos.js). Si el instante
 * congelado cayera cerca de la medianoche, un desfasaje de zona horaria -sea
 * de la máquina que corre el test, sea un futuro bug de UTC contra ART en el
 * código bajo prueba- podría correr la fecha impresa al día siguiente o
 * anterior, y el test podría seguir pasando por pura casualidad en unas
 * corridas y fallar en otras. A mediodía, un desfasaje razonable de un par de
 * horas para cualquier lado no cruza la línea de cambio de día: si el test
 * llegara a fallar por esto, sería un fallo limpio y reproducible, no uno
 * intermitente. Es el mismo tipo de trampa horaria que ya afectó a este
 * proyecto una vez (los egresos cargados a las 21:23 cayendo en la caja del
 * día siguiente, ver CLAUDE.md), así que elegimos alejarnos de esa zona de
 * riesgo a propósito.
 */
const FECHA_CONGELADA = new Date("2026-08-30T15:00:00Z").getTime();

/* Cada caso: qué fixture cargar, contra qué golden compararlo, y con cuál
 * función de EscPos generarlo. Se declara acá (no se adivina por el nombre
 * del archivo) para que generar-golden.js y escpos.test.js usen exactamente
 * la misma lista y no se desincronicen. */
const CASOS = [
  { fixture: "nombre-largo.json", golden: "nombre-largo.bin", fn: "deComprobante" },
  { fixture: "importe-grande.json", golden: "importe-grande.bin", fn: "deComprobante" },
  { fixture: "con-extras.json", golden: "con-extras.bin", fn: "deComprobante" },
  { fixture: "presupuesto-con-descuento.json", golden: "presupuesto-con-descuento.bin", fn: "deComprobante" },
  { fixture: "pago-parcial.json", golden: "pago-parcial.bin", fn: "deComprobante" },
  { fixture: "sin-cliente.json", golden: "sin-cliente.bin", fn: "deComprobante" },
  { fixture: "cuenta-tres-comprobantes.json", golden: "cuenta-tres-comprobantes.bin", fn: "deCuenta" },
];

module.exports = { FECHA_CONGELADA, CASOS };
