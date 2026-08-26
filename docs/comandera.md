# Comandera térmica Bluetooth (ESC/POS)

La app imprime tickets y presupuestos en una impresora térmica de **80mm** con
protocolo **ESC/POS**, conectada por **Bluetooth** a la tablet (o al celular).

El botón **🖨️ Imprimir** de la pantalla de ticket (`/ticket?id=...`) genera los
comandos ESC/POS y se los pasa a la app **RawBT**, que es la que habla por
Bluetooth con la impresora. La app web no necesita ningún permiso especial.

## Instalación (una sola vez por dispositivo)

1. **Instalar RawBT** desde Play Store: buscar "RawBT print service"
   (desarrollador: 402d). Es el "plugin" de impresión.
2. **Vincular la impresora** en Ajustes de Android → Bluetooth → buscar
   dispositivos → seleccionar la comandera (suele llamarse `InnerPrinter`,
   `BlueTooth Printer`, `MTP-II` o similar). Si pide PIN: probar `0000` o `1234`.
3. **Configurar RawBT**: abrir RawBT → Ajustes (⚙️) → *Impresora* →
   - Conexión: **Bluetooth** → elegir la impresora vinculada.
   - Ancho de papel: **80mm / 48 caracteres**.
4. **Probar desde RawBT**: en la app RawBT hay un botón de impresión de prueba.
   Si esa prueba no sale, el problema es de vínculo Bluetooth, no de nuestra app.
5. **Probar desde la app**: abrir el sistema → Historial → 🖨️ en cualquier
   comprobante → botón **🖨️ Imprimir**. La primera vez Chrome pregunta si abrir
   con RawBT: elegir "Permitir siempre".

## Datos del encabezado

El nombre, teléfono, dirección e Instagram que salen arriba del ticket se
cargan en `config_extra.py` (diccionario `NEGOCIO`). Los campos vacíos no se
imprimen.

## Notas y problemas comunes

- **Caracteres raros**: los tickets se mandan sin tildes a propósito
  (las comanderas baratas manejan mal los acentos). Es normal.
- **Papel de 58mm**: si algún día se usa una impresora chica, cambiar
  `const ANCHO=48` a `32` en `static/ticket.html`.
- **No corta el papel**: el comando de corte se manda igual; si la impresora
  no tiene cortador, simplemente lo ignora.
- **RawBT gratis**: la versión gratuita puede agregar una línea de publicidad
  al final del ticket. La licencia de pago se compra una sola vez y la saca.
- **Botón PDF**: imprime con el diálogo del navegador (para guardar en PDF o
  compartir por WhatsApp). No usa la comandera.
