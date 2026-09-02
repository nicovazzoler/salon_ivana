"use strict";

/* Convierte bytes a texto legible para el mensaje de error del test: lo
 * imprimible en ASCII se muestra tal cual, el resto (comandos ESC/POS,
 * acentos en CP850) se muestra en hexadecimal. No hace falta que sea
 * perfecto -es un mensaje de diagnóstico, no el papel real- alcanza con que
 * se pueda leer dónde cae la diferencia. */
function aTextoLegible(bytes){
  let out = "";
  for(const b of bytes){
    out += (b >= 0x20 && b <= 0x7e) ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`;
  }
  return out;
}

/* hoja().lin() siempre cierra cada renglón con un salto de línea (byte 0x0A):
 * es el mismo separador que usamos acá para reconstruir "renglones" a partir
 * de los bytes crudos. */
function renglonesDe(bytes){
  const renglones = [];
  let inicio = 0;
  for(let i = 0; i < bytes.length; i++){
    if(bytes[i] === 0x0A){ renglones.push({ inicio, fin: i }); inicio = i + 1; }
  }
  if(inicio < bytes.length) renglones.push({ inicio, fin: bytes.length });
  return renglones;
}

/* Compara dos Buffer/Uint8Array byte a byte y describe la primera diferencia:
 * en qué posición del archivo cae, qué renglón de texto la contiene, y cómo
 * se ve ese renglón en cada versión. Devuelve null si son idénticos. */
function describirDiferencia(esperado, actual){
  const n = Math.min(esperado.length, actual.length);
  let pos = -1;
  for(let i = 0; i < n; i++){
    if(esperado[i] !== actual[i]){ pos = i; break; }
  }
  if(pos === -1 && esperado.length !== actual.length) pos = n;
  if(pos === -1) return null;

  const renglones = renglonesDe(esperado);
  let numRenglon = renglones.findIndex(r => pos >= r.inicio && pos <= r.fin);
  if(numRenglon === -1) numRenglon = Math.max(0, renglones.length - 1);
  const r = renglones[numRenglon] || { inicio: pos, fin: esperado.length };

  return {
    posicion: pos,
    renglon: numRenglon + 1,
    byteEsperado: pos < esperado.length ? esperado[pos] : null,
    byteActual: pos < actual.length ? actual[pos] : null,
    renglonEsperado: aTextoLegible(esperado.slice(r.inicio, r.fin)),
    renglonActual: aTextoLegible(actual.slice(r.inicio, Math.min(r.fin, actual.length))),
  };
}

module.exports = { describirDiferencia };
