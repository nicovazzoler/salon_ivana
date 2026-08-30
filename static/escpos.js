/* Generador ESC/POS para la comandera de 80mm (48 columnas).
 *
 * Vive acá y no adentro de ticket.html porque lo usan dos pantallas: la vista
 * de impresión, donde se toca el botón, y facturar, que manda el papel sola
 * apenas se termina de cobrar. Tener dos copias del generador sería garantía
 * de que un día el papel que sale al cobrar diga algo distinto del que sale al
 * reimprimir desde el historial.
 *
 * Todo lo que la comandera necesita saber entra por parámetro (el comprobante y
 * los datos del negocio): el archivo no lee nada del documento ni de la red.
 */
(function(global){
"use strict";

const ANCHO = 48;

/* ---------- acentos en la comandera ----------

   La comandera no habla UTF-8: trabaja con una tabla de 256 caracteres, y la
   que trae de fábrica es ASCII. Si le mandás la "ó" de "Salón" en crudo,
   imprime un símbolo cualquiera; por eso antes se mandaba todo sin tildes.

   ESC/POS permite cambiarle la tabla: "ESC t 2" selecciona CP850
   (multilingüe), que tiene todos los acentos del español. Es la tabla más
   estándar y la soportan tanto las Epson como los clones genéricos.

   Si esta unidad no la soportara, las palabras con tilde saldrían con
   símbolos raros. En ese caso poné ACENTOS en false: vuelve a imprimir sin
   tildes, que es más feo pero se lee siempre. */
const ACENTOS = true;
const CP850 = { "á":0xA0,"é":0x82,"í":0xA1,"ó":0xA2,"ú":0xA3,
                "Á":0xB5,"É":0x90,"Í":0xD6,"Ó":0xE0,"Ú":0xE9,
                "ñ":0xA4,"Ñ":0xA5,"ü":0x81,"Ü":0x9A,
                "¿":0xA8,"¡":0xAD,"°":0xF8,"ª":0xA6,"º":0xA7 };
// un carácter -> su byte en la tabla de la comandera
const byteDe = ch => (ACENTOS && CP850[ch] !== undefined) ? CP850[ch] : ch.charCodeAt(0);

/* El aviso legal va arriba Y abajo, enmarcando todo el papel: así queda claro
   de entrada y de salida que esto no reemplaza a una factura, mire por donde
   mire el que lo recibe. Se escribe sin tildes porque el mismo texto se manda
   a la comandera. */
const LEGAL_TXT = "DOCUMENTO NO VALIDO COMO FACTURA";

/* Deja solo lo que la comandera puede imprimir. IMPORTANTE: devuelve UN
   carácter por posición, nunca dos, porque de este largo dependen todas las
   columnas. Cada acentuado ocupa un byte en CP850, así que la cuenta da igual
   con acentos o sin ellos. */
function translit(s){
  if(!ACENTOS)
    return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[×]/g,"x").replace(/[−–—]/g,"-").replace(/[·]/g,"-")
    .replace(/[“”]/g,'"').replace(/[’‘]/g,"'").replace(/[✂✓]/g,"")
    .replace(/[^\x20-\x7e\n]/g,"");
  return String(s)
    .replace(/[×]/g,"x").replace(/[−–—]/g,"-").replace(/[·]/g,"-")
    .replace(/[“”]/g,'"').replace(/[’‘]/g,"'").replace(/[✂✓]/g,"")
    .replace(/[^\x20-\x7e\n]/g, c => (c in CP850) ? c : "");
}

function fmtP(n){ return "$"+(n||0).toLocaleString("es-AR"); }

function numComp(tipo, n){ return (tipo==="ticket"?"N-":"P-")+String(n).padStart(5,"0"); }

function fechaLocal(iso){
  // el backend guarda UTC sin zona: agregamos la Z para que el dispositivo la convierta
  const d = new Date(iso.endsWith("Z") ? iso : iso+"Z");
  return d.toLocaleDateString("es-AR")+" "+d.toLocaleTimeString("es-AR",{hour:"2-digit",minute:"2-digit",hour12:false});
}
function fechaSolo(iso){
  return new Date(iso.endsWith("Z") ? iso : iso+"Z").toLocaleDateString("es-AR");
}

/* Precios unitarios de una línea, ya con su ajuste aplicado. El backend los manda
   calculados; el fallback es por si el comprobante viene de una versión anterior. */
const pu = l => l.precio_unit_final     ?? l.precio_unit     ?? 0;
const pe = l => l.precio_efectivo_final ?? l.precio_efectivo ?? 0;

// Si la línea tiene un ajuste, sea en porcentaje o en pesos.
const hayAjuste = l => !!(l.ajuste_pct || l.ajuste_monto);

function fila2(izq, der, w=ANCHO){
  izq=translit(izq); der=translit(der);
  const max=w-der.length-1;
  if(izq.length>max) izq=izq.slice(0,max);
  return izq+" ".repeat(w-izq.length-der.length)+der;
}

/* Corta un texto en renglones del ancho del papel SIN partir palabras.
   El papel tiene 48 columnas: los nombres largos hay que bajarlos de renglón,
   no recortarlos, o se pierde parte del nombre. */
function envolver(txt, w=ANCHO){
  const palabras = translit(txt).split(/\s+/).filter(Boolean);
  const lineas = []; let actual = "";
  palabras.forEach(pal => {
    if(!actual){ actual = pal; return; }
    if((actual + " " + pal).length <= w) actual += " " + pal;
    else { lineas.push(actual); actual = pal; }
  });
  if(actual) lineas.push(actual);
  // una sola palabra más larga que el papel: ahí sí no queda otra que cortarla
  return lineas.flatMap(l => l.length <= w ? [l] : (l.match(new RegExp(`.{1,${w}}`,"g")) || [l]));
}

/* Renglón de ítem: el nombre envuelve y el precio se pega a la derecha del
   último renglón; si no entra, el precio baja a un renglón propio. */
function filaItem(etiqueta, precio, w=ANCHO){
  const der = translit(precio);
  const lineas = envolver(etiqueta, w);
  const ultima = lineas[lineas.length-1];
  if(ultima.length + der.length + 1 <= w){
    lineas[lineas.length-1] = ultima + " ".repeat(w - ultima.length - der.length) + der;
  } else {
    lineas.push(" ".repeat(Math.max(0, w - der.length)) + der);
  }
  return lineas;
}

function fila3(a,b,c){                       // detalle | lista | con desc. (26+11+11)
  a=translit(a); b=translit(b); c=translit(c);
  if(a.length>26) a=a.slice(0,26);
  return a+" ".repeat(26-a.length)+b.padStart(11)+c.padStart(11);
}

/* Fila de 3 columnas cuyo detalle no entra en 26: el nombre sigue abajo,
   sangrado, en vez de quedar cortado a la mitad. */
function fila3Larga(a,b,c){
  const partes = envolver(a, 26);
  const salida = [fila3(partes[0], b, c)];
  partes.slice(1).forEach(p => salida.push("  " + p));
  return salida;
}

/* Cómo se describe el ajuste de una línea, en porcentaje o en pesos.

   Sin el "c/u": los cuatro lugares donde se usa esto lo muestran al lado de la
   columna "$25.600 > $23.600 c/u", que ya lo aclara. Ponerlo también acá daba
   "Cliente frecuente -$2.000 c/u  $25.600 > $23.600 c/u". */
function textoAjuste(l){
  const neg = (l.ajuste_monto || l.ajuste_pct) < 0;
  const cuanto = l.ajuste_monto
    ? `${neg?"-":"+"}${fmtP(Math.abs(l.ajuste_monto))}`
    : `${neg?"-":"+"}${Math.abs(l.ajuste_pct)}%`;
  return (l.ajuste_nombre || (neg ? "Descuento" : "Recargo")) + " " + cuanto;
}

/* Renglón del ajuste de una línea, para la comandera.

   El porcentaje NO se puede recortar. Con fila2, que corta por la derecha lo de
   la izquierda, un nombre de ajuste medianamente largo se comía el número:
   "Cliente frecuente -10%" salía "Cliente frecuente -1" y el ticket del cliente
   decía 1% en vez de 10%. Un nombre cortado se ve; un porcentaje cortado se lee
   como si fuera otro.

   filaItem envuelve la etiqueta y baja los precios a un renglón propio si no
   entran, sin recortar nada. Se sangra 2 para que el "> " marque que el ajuste
   es de la línea de arriba, y por eso se envuelve contra ANCHO-2. */
function lineaAjuste(l){
  const precios = fmtP(l.precio_unit)+" > "+fmtP(pu(l))+" c/u";
  return filaItem("> "+textoAjuste(l), precios, ANCHO-2).map(x => "  "+x);
}

/* Un renglón de la tabla de la cuenta corriente, con los anchos que calculó
   anchosCuenta(). La etiqueta se recorta si hace falta; los importes no, nunca. */
function fila4(etiqueta, b, c, d_, an){
  let a = translit(etiqueta);
  if(a.length > an.etiqueta) a = a.slice(0, an.etiqueta);
  return a + " ".repeat(an.etiqueta - a.length)
       + translit(b).padStart(ANCHO - an.etiqueta - 2*an.monto)
       + translit(c).padStart(an.monto)
       + translit(d_).padStart(an.monto);
}

function fechaCorta(fecha){          // 27/8/26
  const f=new Date(fecha);
  return f.getDate()+"/"+(f.getMonth()+1)+"/"+String(f.getFullYear()).slice(-2);
}
function fechaSinAnio(fecha){        // 27/8
  const f=new Date(fecha);
  return f.getDate()+"/"+(f.getMonth()+1);
}

/* Cuánto mide cada columna de la cuenta corriente.

   Los importes NO se recortan nunca: un número mal impreso en la cuenta de un
   cliente es mucho peor que una fecha corta. Así que se miden los importes de
   ESTA cuenta, las tres columnas de plata se llevan lo que necesitan y el
   comprobante se queda con el resto. Se calcula una sola vez para toda la
   tabla; si se hiciera por renglón, las columnas bailarían.

   Si no entra, se cede de a poco y siempre del lado de la etiqueta: primero el
   "N-" (la columna ya se llama "Servicio" y son todos del mismo tipo) y
   final el año. Con el año entero "A-00024 27/8/2026" mide 17 contra 16 de
   columna, y el ticket del cliente salía diciendo "27/8/202". */
function anchosCuenta(comps){
  const montos = comps.flatMap(c=>[fmtP(c.total_final), fmtP(c.pagado), fmtP(c.saldo)]);
  const monto = Math.max(9, ...montos.map(m=>m.length+1));   // +1 de aire entre columnas
  const etiqueta = ANCHO - 3*monto;

  const formatos = [
    c => "N-"+String(c.numero).padStart(5,"0")+" "+fechaCorta(c.fecha),
    c =>      String(c.numero).padStart(5,"0")+" "+fechaCorta(c.fecha),
    c =>      String(c.numero).padStart(5,"0")+" "+fechaSinAnio(c.fecha),
  ];
  const fmt = formatos.find(f => comps.every(c => f(c).length <= etiqueta))
           || formatos[formatos.length-1];
  return {monto, etiqueta, fmt};
}

/* Las órdenes de la comandera, todas juntas: cada generador arma su papel
   llamando a estas y al final pide los bytes. */
function hoja(){
  const B = [];
  const raw = (...x) => B.push(...x);
  const txt = s => { for(const ch of translit(s)) B.push(byteDe(ch)); };
  return {
    raw, txt,
    lin: (s="") => { txt(s); raw(10); },
    centro:  on => raw(0x1b,0x61,on?1:0),
    negrita: on => raw(0x1b,0x45,on?1:0),
    grande:  on => raw(0x1d,0x21,on?0x11:0x00),
    sep: function(){ this.lin("-".repeat(ANCHO)); },
    bytes: () => new Uint8Array(B),
  };
}

/* Encabezado común: el aviso legal, después el nombre del negocio y sus datos. */
function encabezado(h, negocio){
  h.raw(0x1b,0x40);                          // reset
  if(ACENTOS) h.raw(0x1b,0x74,2);            // tabla CP850: acentos del español
  h.centro(true);
  h.lin(LEGAL_TXT);                          // el aviso abre el papel
  h.centro(false); h.sep(); h.centro(true);
  h.grande(true); h.negrita(true); h.lin(negocio.nombre||""); h.negrita(false); h.grande(false);
  [negocio.direccion, negocio.telefono&&("Tel: "+negocio.telefono), negocio.instagram]
    .filter(Boolean).forEach(x=>h.lin(x));
  h.centro(false);
  h.sep();
}

/* Pie común: el saludo, el aviso legal de nuevo y la línea que cierra el papel. */
function pie(h, conSaludo){
  if(conSaludo){ h.lin(); h.centro(true); h.lin("¡Gracias por su visita!"); h.centro(false); }
  else h.lin();
  h.sep();
  h.centro(true); h.lin(LEGAL_TXT); h.centro(false);
  h.sep();                                   // la línea que cierra el papel
  h.raw(0x1b,0x64,4);                        // avanzar papel
  h.raw(0x1d,0x56,0x42,0x00);                // corte parcial (si la comandera tiene cortador)
  return h.bytes();
}

/* ---------- el papel de un servicio o presupuesto ---------- */
function deComprobante(d, negocio){
  const esPresu = d.tipo === "presupuesto";
  const h = hoja();
  encabezado(h, negocio||{});

  h.lin(fila2((esPresu?"PRESUPUESTO ":"SERVICIO ")+numComp(d.tipo,d.numero), fechaLocal(d.fecha)));
  // El peluquero NO va en el papel: es dato interno. Se sigue guardando en el
  // comprobante y se ve en historial y en la cuenta, pero no en lo que se
  // entrega al cliente.
  if(d.cliente_nombre) envolver("Cliente: "+d.cliente_nombre).forEach(h.lin);
  // Un servicio que se atendió un día y se anotó otro lo dice en el papel: la
  // fecha de arriba es la del servicio, y sin esta aclaración el que lo recibe
  // no tendría cómo entender por qué no coincide con el día que se lo dan.
  if(d.anotado_despues) h.lin("Anotado el "+fechaSolo(d.anotado_despues));
  h.sep();

  if(esPresu){
    h.lin(fila3("Detalle","Lista","C/desc."));
    d.lineas.forEach(l=>{
      fila3Larga(l.cantidad+"x "+l.nombre+(l.dificultad?" *":""),
                 fmtP(pu(l)*l.cantidad), fmtP(pe(l)*l.cantidad)).forEach(h.lin);
      if(hayAjuste(l)) lineaAjuste(l).forEach(h.lin);
    });
    // El extra por dificultad se sacó; solo aparece en comprobantes viejos.
    if(d.extra_dificultad>0) h.lin(fila2("* Extra dificultad","+"+fmtP(d.extra_dificultad)));
    h.sep();
    const extra=d.extra_dificultad||0;
    let totLista=d.lineas.reduce((a,l)=>a+pu(l)*l.cantidad,0)+extra;
    let totPromo=d.lineas.reduce((a,l)=>a+pe(l)*l.cantidad,0)+extra;
    if(d.descuento_pct>0){
      h.lin(fila2((d.descuento_nombre||"Descuento")+" "+d.descuento_pct+"%","aplicado"));
      totLista=Math.round(totLista*(100-d.descuento_pct)/100);
      totPromo=Math.round(totPromo*(100-d.descuento_pct)/100);
    }
    (d.extras||[]).forEach(e=>{
      filaItem("+ "+e.concepto, fmtP(e.monto)).forEach(h.lin);
      totLista+=e.monto; totPromo+=e.monto;
    });
    h.negrita(true);
    h.lin(fila2("Total lista",fmtP(totLista)));
    h.lin(fila2("Total con descuento",fmtP(totPromo)));
    h.negrita(false);
    h.lin(); h.centro(true);
    h.lin("Presupuesto sin valor fiscal.");
    h.lin("Precios sujetos a cambio sin previo aviso.");
    h.centro(false);
  } else {
    d.lineas.forEach(l=>{
      filaItem(l.cantidad+"x "+l.nombre+(l.dificultad?" *":""), fmtP(pu(l)*l.cantidad)).forEach(h.lin);
      if(hayAjuste(l)) lineaAjuste(l).forEach(h.lin);
    });
    if(d.extra_dificultad>0) h.lin(fila2("* Extra dificultad","+"+fmtP(d.extra_dificultad)));
    h.sep();
    // Subtotal antes de descuentos, sumado de los renglones de arriba
    const subtotal = d.lineas.reduce((a,l)=>a+pu(l)*l.cantidad,0) + (d.extra_dificultad||0);
    const hayDesc = d.desc_efectivo>0 || d.desc_jubilado>0
                 || d.pagos.reduce((a,p)=>a+(p.desc_aplicado||0),0)>0;
    if(hayDesc) h.lin(fila2("Subtotal", fmtP(subtotal)));
    if(d.desc_efectivo>0) h.lin(fila2("Descuento "+(d.desc_efectivo/d.total_transfer*100).toFixed(2)+"%","-"+fmtP(d.desc_efectivo)));
    if(d.desc_jubilado>0) h.lin(fila2((d.descuento_nombre||"Descuento")+" "+d.descuento_pct+"%","-"+fmtP(d.desc_jubilado)));
    const descPagos=d.pagos.reduce((a,p)=>a+(p.desc_aplicado||0),0);
    if(descPagos>0) h.lin(fila2("Descuento (al abonar)","-"+fmtP(descPagos)));
    (d.extras||[]).forEach(e=>filaItem("+ "+e.concepto, fmtP(e.monto)).forEach(h.lin));
    h.negrita(true); h.grande(true);
    h.lin(fila2("TOTAL",fmtP(d.ingresado+Math.max(d.saldo,0)),24));   // 24 cols: la letra es doble ancho
    h.grande(false); h.negrita(false);
    if(d.pagos.length){
      h.sep();
      d.pagos.forEach(p=>{
        const fp = p.forma_pago ? " ("+p.forma_pago+")" : "";
        h.lin(fila2("Recibido "+fechaSolo(p.fecha)+fp, fmtP(p.monto)));
      });
    }
    if(d.saldo>0){ h.negrita(true); h.lin(fila2("PENDIENTE",fmtP(d.saldo))); h.negrita(false); }
  }

  return pie(h, true);
}

/* ---------- el papel de una cuenta corriente ---------- */
function deCuenta(cuenta, negocio){
  const c = cuenta.cliente, comps = cuenta.comprobantes;
  const conDeuda = comps.filter(x=>x.saldo>0).slice(0,20);
  const h = hoja();
  encabezado(h, negocio||{});

  h.centro(true); h.negrita(true); h.lin("CUENTA CORRIENTE"); h.negrita(false); h.centro(false);
  h.lin(fila2("Cliente: "+c.nombre, new Date().toLocaleDateString("es-AR")));
  h.sep();

  if(conDeuda.length===0){
    h.lin("Sin deuda pendiente.");
  } else {
    const an = anchosCuenta(conDeuda);
    h.lin(fila4("Servicio","Total","Pagado","Saldo", an));
    h.sep();
    conDeuda.forEach(comp=>{
      h.lin(fila4(an.fmt(comp), fmtP(comp.total_final), fmtP(comp.pagado), fmtP(comp.saldo), an));
    });
  }
  h.sep();
  h.negrita(true); h.grande(true);
  h.lin(fila2("SALDO TOTAL",fmtP(cuenta.saldo_total),24));
  h.grande(false); h.negrita(false);

  return pie(h, false);
}

/* La comandera se maneja con la app RawBT (Play Store): recibe los bytes
   ESC/POS por el esquema rawbt: y los manda por Bluetooth a la impresora. */
function urlRawbt(bytes){
  let bin = "";
  bytes.forEach(b => bin += String.fromCharCode(b));
  return "rawbt:base64," + btoa(bin);
}

global.EscPos = {
  ANCHO, LEGAL_TXT,
  deComprobante, deCuenta, urlRawbt,
  numComp, fechaLocal, fechaSolo, pu, pe, hayAjuste, textoAjuste,
};

})(window);
