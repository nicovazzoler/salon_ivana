"use strict";

/* Instante congelado para los golden: deCuenta() imprime la fecha de hoy, así
 * que sin congelar el reloj el golden falla todos los días.
 *
 * Va al MEDIODÍA argentino y no cerca de la medianoche: la fecha se resuelve con
 * la zona del proceso, y así un desfasaje de un par de horas no cambia el día. */
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
  /* Los cuatro casos de la seña: las dos puntas de sena_saldado(), una seña que
     tapa también los extras, y la combinación de todos los días —seña en
     efectivo y la clienta paga en efectivo—, que es la que más se imprime. */
  { fixture: "sena-transfer-cuenta-efectivo.json", golden: "sena-transfer-cuenta-efectivo.bin", fn: "deComprobante" },
  { fixture: "sena-efectivo-cuenta-transfer.json", golden: "sena-efectivo-cuenta-transfer.bin", fn: "deComprobante" },
  { fixture: "sena-tapa-los-extras.json", golden: "sena-tapa-los-extras.bin", fn: "deComprobante" },
  { fixture: "sena-efectivo-cuenta-efectivo.json", golden: "sena-efectivo-cuenta-efectivo.bin", fn: "deComprobante" },
  { fixture: "cuenta-tres-comprobantes.json", golden: "cuenta-tres-comprobantes.bin", fn: "deCuenta" },
];

module.exports = { FECHA_CONGELADA, CASOS };
