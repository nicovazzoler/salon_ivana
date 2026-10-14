# Ivana Salón

App de gestión de una peluquería, **en producción y en uso diario real** desde
una tablet en el local. Facturación, clientes, agenda, caja, inventario,
reportes y administración.

Que esté en uso real cambia las prioridades: un número mal calculado se le cobra
a una persona, y un cambio que rompe la pantalla de facturar deja al local sin
poder trabajar. Ante la duda, verificar antes de dar algo por hecho.

## Cómo está armado

FastAPI + SQLAlchemy en el backend. El frontend es HTML, CSS y JavaScript a
mano: **sin frameworks, sin build, sin CDN**. Es a propósito — el local tiene
internet flojo y la app tiene que abrir rápido y andar aunque se caiga.

```
main.py          API + rutas de las pantallas + migraciones (1.800 líneas)
models.py        Tablas
database.py      SQLite local / PostgreSQL en producción (env DATABASE_URL)
auth.py          Contraseñas y tokens
seed_datos.py    Siembra inicial, idempotente
config_extra.py  Datos del negocio. main.py lo importa EN VIVO, no está en la base
static/
  *.html         Una por pantalla, solo estructura
  css/           tokens → base → layout → components → app  (el orden importa).
                 Ojo con los nombres sueltos: `.num` era a la vez la tarjeta de
                 KPI de Caja, la columna de números de una tabla y el número de
                 un comprobante, así que las celdas se dibujaban con el fondo y
                 las esquinas de una tarjeta. Va acotada a su grilla (`.nums .num`)
  js/            El JS de facturar y admin, que son las grandes
  auth.js        Sesión, menú y helpers compartidos
  js/listas.js   Las cinco listas configurables (formas de pago, tipos de egreso,
                 descuentos, ajustes por ítem, alias): un solo dibujante que usan
                 Admin y el panel del lapicito de facturar
  js/generales.js El valor hora, la comisión general y el corte de los sueldos:
                 un solo dibujante que usan Admin (arriba de la lista de
                 empleados) y Sueldos. El CSS, en components.css
  js/senas.js    Tomar una seña y listarlas. El formulario se usa en depilación,
                 que es donde se toman; la ficha del cliente solo las lista. El
                 CSS vive en components.css: estando en una sola pantalla, en la
                 otra salía sin estilo
  depilacion.html Depilación entera: cuatro solapas —cobrar, la sesión con su
                 reparto y su cierre, el historial de comprobantes y el de
                 sesiones, que tiene la suya para no pasar de largo dos meses de
                 tickets—. No se mezcla con peluquería. Las tablas van adentro de
                 un `.tabla-scroll`: las columnas de plata no se parten, así que
                 abajo de 600px desbordaban la PÁGINA y en el celular el botón de
                 la última columna quedaba fuera de la pantalla
  escpos.js      Generador del papel de la comandera (ticket.html y facturar.js)
```

## Levantarlo para probar

```bash
python3 -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Usuarios de la base local de prueba: `dueno` / `test1234`. **Los de producción
son otros** y no están acá. Si la base está vacía, el arranque la siembra solo.

Para trabajar con una copia de producción, `levantar_local.py` tiene dos
caminos: `--dump` restaura el `.dump` de `pg_dump` en un PostgreSQL local, y
`--json` mete el JSON de `/api/backup` en un SQLite, que es lo único que se
puede en una PC donde no se instala nada. Los dos dejan un usuario
`local`/`local1234`, porque el backup trae los de producción y sus contraseñas
no las sabe nadie. `--a-json` va del `.dump` al JSON, que es el formato que
viaja: el `.dump` sin `pg_restore` no se abre.

`cargar_depilacion.py depilacion_precios.txt` carga la lista de precios de
depilación sin pasar por la app. Ver más abajo, en las reglas.

`simular_sueldos.py` carga un ciclo entero de trabajo para tres empleadas y
después se juega con el valor hora y la comisión desde la app. Factura por la
API, así los precios y las comisiones son los de un cobro de verdad; la duración
de cada trabajo sale del precio del ítem (el más caro del ciclo, 80 minutos).
Solo trabaja contra `127.0.0.1` y se deshace con `--borrar`.

Notas del entorno de trabajo (no del proyecto):

- `curl` necesita `--noproxy '*'` para pegarle a `127.0.0.1`.
- **Nunca `pkill -f uvicorn`**: mata el propio shell del agente. Si hay que
  levantar otro servidor, usar un puerto nuevo.
- Arrancar el servidor así, y esperar ~12 segundos antes de la primera consulta:
  `(setsid python3 -m uvicorn main:app --host 127.0.0.1 --port NNNN > log 2>&1 < /dev/null &)`
- Playwright: `playwright-core` está en el scratchpad; el navegador en
  `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.

## Las reglas del negocio que hay que respetar

Estas son las que ya se rompieron alguna vez. Cada una está explicada en el
código, en el lugar donde vive.

**Dos listas de precios.** Cada ítem tiene precio efectivo y precio
transferencia (`calcular_transfer`: efectivo × 1,1111 redondeado para arriba a
múltiplo de 100). El comprobante se ancla SIEMPRE al de transferencia; el
descuento por pagar en efectivo es la diferencia entre listas y se aplica al
cobrar, no al crear.

**Argentina es UTC−3 todo el año.** Todo se guarda en UTC, pero cuando el local
dice "hoy" habla del día argentino. El servidor corre en UTC, así que **a partir
de las 21:00 argentinas el servidor ya está en el día siguiente**. Usar
`hoy_argentina()` y `_rango_dia()`, nunca `date.today()`. Esto ya causó que los
egresos cargados a las 21:23 aparecieran en la caja del día siguiente.

**La caja se arma por la fecha de los PAGOS, no la del comprobante.** Un abono
que cierra la venta pertenece al día del servicio (`del_servicio: true`); uno
que salda una deuda vieja pertenece al día en que entra la plata. El backend
saca la fecha de `comp.fecha`: la pantalla dice cuál de los dos casos es, nunca
manda una fecha.

**El comprobante tiene dos fechas.** `fecha` es cuándo se atendió (manda para
caja y reportes) y `cargado` cuándo se anotó. Solo difieren cuando se anota un
servicio de un día anterior, y de ahí sale el "Anotado el x/x" del papel.

**El stock se mueve solo con la venta.** Un presupuesto es un precio que se
pasa, no mercadería que sale. Al anular un ticket el stock vuelve; al anular un
presupuesto no, porque nunca salió.

**Hay dos roles y un usuario de cada uno.** La dueña ve todo; el empleado ve
todo menos reportes, usuarios, backup, el fondo de caja y la corrección de stock
(el inventario lo lee, no lo edita). Las listas de Admin con las que se factura
todos los días —catálogo, formas de pago, tipos de egreso, descuentos, ajustes
por ítem, alias— las maneja también el empleado. La pantalla esconde lo que no
corresponde marcando el elemento con `data-dueno` o `data-empleado` y llamando a
`ajustarPorRol()`; eso es para no mostrar lo que no sirve, **nunca** el control:
el que frena de verdad es el backend, con `solo_dueno` o `es_dueno(user)`.

**Los egresos privados no existen para el empleado.** El alquiler y los sueldos
se anotan igual que todo, con `privado` puesto: no salen en su lista ni suman en
los totales de su caja (ni en el desglose ni en el arqueo). Se marcan por la
casilla al cargarlos o porque el tipo de egreso está marcado privado, que además
lo saca del desplegable de facturar. Un egreso que cargó el empleado **nunca** es
privado, aunque tipee un nombre de tipo reservado: esconderle lo que él mismo
anotó le deja el arqueo sin explicación. Y ojo con el `privado != True` a secas:
en SQL el NULL no entra, y `restaurar_backup.py` levantando un backup viejo
escribe NULL — por eso está `_no_privado()`.

**La depilación es otro negocio, no otra categoría.** Tiene su pantalla, su
facturación, su historial y su cierre del día, y nada de eso se mezcla con
peluquería: Sueldos es exclusivamente peluquería. Lo que las ata es el ítem
marcado `es_depilacion`, y de ahí sale todo lo demás:

- El catálogo se parte en dos: `/api/catalogo?de=pelu` (el default, sin
  depilación) lo usa Facturar, `?de=depi` la pantalla de depilación y `?de=todo`
  la agenda, que anota turnos de cualquier cosa.
- Un comprobante nace marcado `depilacion` cuando TODAS sus líneas lo son, y el
  historial se parte con el mismo `de=`. Se guarda en el comprobante y no se
  deduce de las líneas: de esa marca cuelga cada lista paginada, y preguntarlo
  con un join por fila es la diferencia entre que el historial abra o no.
- **La plata SÍ está en la caja del local.** La clienta paga en el mostrador y el
  efectivo queda en el cajón, así que sacarla de la caja dejaría el arqueo
  pidiendo menos plata de la que hay. Caja la cuenta y la marca; el resumen
  propio del día vive en la pantalla de depilación.

**Y no se paga por comisión: se reparte la SESIÓN.** El local abre una jornada al
mes solo para depilación —uno o dos días seguidos, lunes y martes—. La lleva
Carolina, que consigue la máquina, más una ayudante que a veces no es del salón:

    trabajos de depilación de la sesión, como se cobraron
    − gastos de la sesión (máquina + insumos + el pago a la ayudante)
    = resto  →  50% Carolina · 50% el salón, que pone el local

**La unidad es la sesión y no el día**, y eso no es cosmético: con el día, los
gastos cargados todos juntos caían sobre uno solo. Ese día quedaba en negativo
—y en negativo no se reparte nada ni se puede cerrar, así que el negativo no se
arrastraba a ningún lado— y el otro día se repartía entero. Medido: dos días de
$27.000 y $81.000 con una máquina de $50.000 cargada en el primero le pagaban
$40.500 en vez de $29.000, y los $50.000 de la máquina no se los descontaba
nadie.

Lo que hay que respetar:
- **Lo que entra se MARCA al cargarlo**, no se deduce de la fecha: el comprobante
  y el egreso nacen con `sesion_id`. Así entran bien la máquina pagada el viernes
  anterior y el trabajo anotado al otro día. El egreso conserva **su propia
  fecha** para la caja —la plata sale del cajón el día que sale—; de qué reparto
  se resta lo dice la sesión.
- **Una sola sesión abierta por vez.** Se abre eligiendo quién la lleva, que es de
  quien es la mitad; deducirlo de quién facturó más alcanzaba hasta el día que
  esa persona se olvida de ponerse en un ticket. Si se cobra o se carga un gasto
  sin abrirla, se abre sola con la de Admin: un cobro no se puede caer porque
  nadie apretó un botón, y la máquina se paga antes de atender a la primera.
- **Cerrada no quiere decir pagada.** `cerrada` es que no recibe más trabajo; lo
  pagado son sus liquidaciones. Una sesión cerrada sin pagar sigue a la vista en
  el historial y se paga desde ahí. Por eso la migración cierra todo lo viejo:
  dejarlo abierto haría que lo que se facture mañana caiga adentro de una jornada
  de hace tres meses. Y por eso **sin nada para pagar se cierra igual**, sin
  liquidación ni egreso: una sesión en la que solo se tomó una seña, o una que se
  reabrió para sacarle un ticket que no iba, si no quedaba abierta para siempre y
  se tragaba la jornada siguiente.
- **Y se puede REABRIR, que es de la dueña.** Cerrada no acepta nada: ni trabajo,
  ni un gasto, ni anular un ticket que no iba. Eso protege un reparto ya pagado,
  pero deja sin salida el error que se descubre después, así que
  `POST /api/depilacion/reabrir` la vuelve a abrir —una sola abierta por vez, así
  que la otra tiene que estar cerrada—. Los cierres no se tocan: lo pagado,
  pagado está. Si al corregirla la cuenta queda por debajo de lo cobrado, la
  pantalla no lo grita: cada cosa que se le toca después de cerrarla queda en su
  **historial de correcciones** (`anotar_correccion()`, con la parte de antes y
  la de después), la sesión se marca "Corregida" y listo. El cartel de alarma
  decía un número suelto que no explicaba nada; el historial dice qué ticket
  salió, cuál entró y cuánto movió cada uno.
- **Y lo pagado de más se descuenta solo del próximo cierre**, que es como se
  arregla en el local: la jornada siguiente cobra de menos. El descuento queda
  como una liquidación NEGATIVA contra la sesión de la que salió, así esa sesión
  se salda sola y `deuda_de_sesiones()` —que cuenta en vivo— deja de verla: no
  hay forma de cobrarlo dos veces. El egreso sale por lo que realmente se le da.
  Lo que NO se toca es el egreso del cierre viejo: esa plata salió del cajón de
  verdad, y bajarlo dejaría el arqueo de ese día pidiendo más de lo que hay.
  Se avisa antes de cerrar, con la cuenta hecha.
- **La base son las LÍNEAS de depilación, no los comprobantes enteros.** Una
  sesión que además tuvo peluquería no se reparte por eso, y esa peluquería se
  paga por comisión como cualquier otro día. Por lo mismo, la comisión se excluye
  por LÍNEA. La marca está en el ítem (`es_depilacion`) y no en el nombre de la
  categoría, que se renombra desde Admin: la cuenta de la plata no puede depender
  de un texto.
- Entra **todo lo facturado**, cada línea en la lista con la que se cobró el
  comprobante: no importa si fue en efectivo o por transferencia, lo que se
  parte es la plata que entró al local (`base_facturada()`). Ojo que NO es
  `base_comision()`: la comisión de peluquería se paga siempre en efectivo
  porque la diferencia entre listas no es un descuento que se le hizo a nadie,
  pero el reparto de la sesión es otra cuenta y ahí lo que se parte es lo que
  cobró el local.
- **Una cuenta ya cobrada no se vuelve a calcular con otra fórmula.** Las
  sesiones que ya estaban pagadas cuando el reparto pasó a contar todo lo
  facturado llevan `reparto_efectivo` y se siguen contando en efectivo. Sin esa
  marca, cada sesión vieja con tickets por transferencia aparecía debiendo plata
  sola —dos trabajos de $20.000 de lista pasaban la parte de $18.000 a $20.000—
  y la pantalla ofrecía cerrarla otra vez, con un egreso de verdad. La marca la
  pone una migración de datos, UNA sola vez, y no se mira "si tiene cierres":
  eso haría que la cuenta cambiara justo al cobrarla.
- Se reparte lo **facturado**, no lo cobrado: lo que se reparte es el trabajo
  hecho. Lo que falta cobrar se dice aparte y a la vista.
- **Solo restan los gastos DE esa sesión**, los que se cargan desde su pantalla
  y quedan con su `sesion_id`. No los egresos del día: uno de peluquería del
  mismo día le bajaría la mitad a quien lleva la depilación. Aparecen en Caja
  como cualquier egreso —la plata sale del cajón— pero marcados.
- La máquina y el pago a la ayudante tienen además su marca propia (`maquina`,
  `ayudante`) y no se reconocen por el texto del tipo, que renombrarlo haría que
  la pantalla ofrezca cargarlos de nuevo y el día se reparta con la máquina dos
  veces. El pago a la ayudante tiene monto fijo; la máquina **no**: se alquila
  por jornada y un día de pocas horas sale menos.
- Cargar un gasto abre la sesión si no había ninguna: la máquina se paga antes de
  atender a la primera, y pedir que ya hubiera movimiento para poder cargarla no
  dejaba cargar nada nunca.
- Los egresos **privados** no entran: el alquiler no es costo de la depilación, y
  el detalle se lo muestra a ella. Sin ese filtro, cerrar la liquidación —que
  crea un egreso privado con el sueldo, con fecha de hoy— le cambiaba la cuenta
  al día que se estaba cerrando.
- La sesión le toca a UNA sola persona, la que se eligió al abrirla. Si fuera "la
  que tenga alguna línea", la ayudante que atendió algo vería el reparto entero y
  el número aparecería dos veces. `empleada_del_dia()` quedó solo para la
  migración: es la regla con la que se liquidó lo viejo, día por día.
- **Las horas de los días de su sesión no se pagan aparte**: las paga el reparto.
  Lo mismo las del día que alguien trabajó de ayudante, que ya cobró por el día
  entero. Sus
  comisiones de lo que no fue depilación sí se pagan: antes se iba el día entero
  del ciclo y se las llevaba puestas, y andaba porque el día de depilación era un
  lunes en el que no se hacía otra cosa.
- La sesión se mira y se cierra en la solapa "La sesión". **Ahí adentro la
  empleada hace todo**: cobra, carga los gastos, devuelve una seña y la cierra.
  Se trabaja entre dos con una sola tablet y un código en el medio sería pedirlo
  diez veces por día. Por eso el egreso del cierre es
  privado **solo si lo cerró la dueña**: uno que cargó el empleado y no puede
  ver le deja el arqueo pidiendo plata que no está.
- La liquidación guarda la foto: `recaudado` es lo facturado en efectivo y
  `gastos` lo que se restó. **Una sesión se puede cerrar más de una vez**: la
  cuenta sigue viva, así que lo que se facture después de cerrar sube el reparto y esa
  diferencia se cobra con otro cierre. Con un cierre único, esa plata no se
  podía pagar por ninguna pantalla. Lo que no se toca después de un cierre son
  los gastos: moverlos cambiaría una cuenta ya liquidada.
- El monto de un gasto se corrige desde la pantalla, con las reglas de la
  SESIÓN —que no esté cerrada— y no con las de Caja, donde el empleado solo
  puede tocar lo de hoy: una sesión se cierra días después y para entonces ya no
  podría corregir nada.
- Un día de una sesión suya no paga ni comisiones ni horas: lo paga el reparto.
  En Sueldos se ve igual, marcado "las paga el día de depilación" y sin casillero
  de horas. Esconderlo era mejor cuando en Sueldos estaban solo los días con
  movimiento; ahora están los siete, y un día en blanco se lee como "no vine":
  ahí cargaría las horas de un día que ya cobró entero. La peluquería de ese día,
  si la hubo, se paga por comisión como cualquier otra.

**Sueldos es la pantalla de la empleada, no un informe que se le muestra.**
Están TODOS los días del ciclo hasta hoy, y el ciclo en curso aparece siempre,
aunque no haya pasado nada: es donde ella carga sus horas. Los días que todavía
no pasaron no se muestran y el backend los rebota, que un casillero de horas en
un día que no existe es plata.

Las horas de cualquier día las carga ella. Antes el backend pedía que el día
tuviera un trabajo suyo detrás y, si no, "pediselo a la dueña": el día que vino
y no facturó nada no tenía dónde declararse, y de los días que faltan no se
acuerda nadie. Un día con horas y sin ningún trabajo detrás queda marcado
(`sin_respaldo`) en la pantalla de la dueña y avisado en el cierre: es lo único
que no se puede cruzar contra un comprobante, y el control va donde importa, que
es antes de pagar. No frena el cierre: se puede venir a ordenar el local.

Y lo que frena el cierre es **un día CON trabajos y sin horas**, no cualquier día
sin horas: con los días de la semana a la vista, esa regla no cerraría nunca. Un
día vacío es un día que no vino. Un trabajo sin duración sigue frenando igual.

**Los días que el local no abre no se dibujan**: `DIAS_CERRADO` en
`config_extra.py` (domingo y lunes, que el lunes es de depilación). Dos
renglones fijos diciendo "no viniste" son ruido en la pantalla que se mira todos
los días. Un día cerrado en el que pasó algo —el lunes de depilación con
peluquería adentro, un trabajo cargado a mano— **aparece igual**: lo que no se
agrega es el día en blanco, y esconder un día con plata adentro sería perderla.

**El corte de los sueldos es UNO para todo el local**, no uno por empleada: el
borón y cuenta nueva de lo que se pagó a mano antes de la app. Se dibuja con
`panelCorteSueldos()` en `generales.js` —el mismo dibujante para Admin y para
Sueldos— y lo que deja afuera lo contesta el backend
(`GET /api/sueldos/arranque?fecha=`), que es el que sabe lo que cada una tiene
pendiente: contándolo en la pantalla, el cartel decía los ciclos de la empleada
que estaba abierta y parecía que el corte valía solo para ella.

**La migración a sesiones agrupa lo viejo por día**, que es como se trabajó y se
liquidó: así ningún número cambia. Todas quedan cerradas, pagadas o no. La
excepción es **la jornada que están trabajando ahora**: los días seguidos sin
pagar que terminan hoy o ayer son UNA sola sesión, y queda abierta. Partida en
dos, la máquina de los dos días caería sobre uno solo, que es el problema que
las sesiones vienen a arreglar.

**La lista de precios de depilación se siembra sola.** `sembrar_depilacion()`
corre al arrancar y la carga si la base no tiene ninguna zona, con marca en
`config` para que sea UNA sola vez: en producción no hay consola —se deploya
haciendo push— y sin esto la lista habría que tipearla en la tablet. Corriendo
cada vez, le pisaría a la dueña los precios que haya corregido desde Admin.

**Y se puede cargar o corregir con un script.** No se cobra por
zona sino por CANTIDAD de zonas —"3 zonas", "5 zonas"— y son dos listas, mujeres
y masculino. Está en `depilacion_precios.txt` tal como está impresa en el local,
con los precios de TRANSFERENCIA, y la carga `cargar_depilacion.py`, que escribe
directo contra `DATABASE_URL` sin pasar por la app. De la lista impresa saca el
precio de efectivo —10% menos— y controla que `calcular_transfer()` de ese
efectivo devuelva exactamente el precio impreso; si alguno no cierra, no escribe
nada. Veinte renglones tipeados a mano en la tablet son media hora, y un número
mal puesto se le cobra a alguien.

Una zona suelta se agrega desde la pantalla, con la casilla "+ Agregar" de cada
lista, y ahí también se pone el precio de TRANSFERENCIA: es el que está impreso
y el único orden en el que se copia un renglón del papel sin hacer ninguna
cuenta. El de efectivo lo saca el backend con el mismo `efectivo_de()` del
script, y un precio que no cierra se rebota con 400 en vez de guardar uno que en
el papel saldría distinto. Es al revés que el catálogo de peluquería, que se
carga en efectivo.

**La seña es plata de la clienta, no un pago de un ticket.** Se toma sin
comprobante y entra a la caja del día en que se cobra. Desde la pantalla de
depilación, que es donde se señan los trabajos, y desde la ficha de la clienta,
que es donde se la pide cuando llama por teléfono. Las dos dibujan el mismo
formulario (`panelSena()` en `senas.js`). La lista que se ve en depilación es la
de TODAS las señas sin usar, no la de la clienta que se está facturando: es el
pizarrón de lo que el local debe trabajo, y la que viene hoy puede no ser la que
señó ayer.

**La seña es de DEPILACIÓN y solo salda depilación.** Es donde se señan los
turnos: puesta en un ticket de peluquería le gasta a la clienta, en un corte, la
plata que había dejado para la jornada de dentro de un mes. El freno está en
`_aplicar_senas()`, que no toca un comprobante sin `depilacion`, y el endpoint
contesta 400; Facturar directamente ni las pide. Como la seña no es de ninguna
sesión —la tabla no tiene `sesion_id`—, **la que no se usa queda libre para la
jornada que venga**, que es justo para lo que se toma.

**Y no entra en el reparto.** La base son las líneas facturadas, no los pagos:
una seña es trabajo que todavía no se hizo. Cuando la clienta viene, esa sesión
cuenta el trabajo ENTERO —aunque parte ya estuviera pagada— y ahí se reparte. Lo
contrario le pagaría a quien lleva la sesión por un trabajo que todavía no hizo,
y después se lo descontaría del que sí.

En la pantalla se pone **de cuánto es** la seña, en los precios de la lista —los
de transferencia, que son a los que se ancla el comprobante— y pagando en
efectivo la clienta entrega el 10% menos. Lo que se GUARDA es lo que entró, que
es de lo que depende el arqueo; el valor contra una factura lo recalcula
`sena_saldado()`. Es la peluquería al revés: allá el catálogo se carga en
efectivo y el de transferencia sale solo. Una seña de $5.000 en efectivo son
$4.500 en el cajón y tapan $5.000 de un trabajo de $20.000. Al facturarle, se aplican todas las que tenga libres y cada una deja un
abono con `sena_id`. **Ese abono no es plata del día**: ya entró. Por eso
`plata_que_entro()` saltea los abonos con `sena_id` y suma las señas cobradas, y
todo lo que cuenta plata por fecha —caja, reportes, el Excel, los gráficos— pasa
por ahí. Contándolos dos veces, el arqueo pide más efectivo del que hay en el
cajón y no avisa por qué. El filtro va por el id y no por el texto "Seña", que se
puede tipear distinto.

**Cuánto tapa una seña depende de en qué lista está escrita cada cosa**
(`sena_saldado()`). El 10% es de la plata que entra en EFECTIVO, no del trabajo,
y la seña entró antes:

| La seña fue en | La cuenta está en | Tapa |
|---|---|---|
| Efectivo | Transferencia | monto ÷ 0,9 — esos pesos valen más contra una cuenta sin el descuento adentro |
| Transferencia | Efectivo | monto × 0,9 — la cuenta ya viene con el 10% sacado y esa plata entró sin descuento |
| La misma | | el monto, tal cual |

Las dos puntas se rompieron alguna vez. Sin la primera, señar $10.000 en
efectivo y pagar el resto por transferencia salía $1.111 más caro que pagar todo
junto en efectivo. Sin la segunda, una seña de $5.000 por transferencia sobre un
trabajo de $20.000 pagado en efectivo le regalaba el 10% de la seña: entraban
$18.000 cuando correspondían $18.500.

**La cuenta se lee de arriba a abajo, y es la misma en las cinco pantallas.**
Subtotal en transferencia, la seña que ya dejó, subtotal otra vez y recién al
final el 10% de pagar en efectivo; el total es lo que pone sobre el mostrador
HOY, porque la seña ya la pagó. El descuento sale de RESTAR y no de multiplicar:
así la columna cierra siempre y el total que se le dice a la clienta es
exactamente el que cobra el backend. La arma `cuentaDeComprobante()` en
`escpos.js` —el archivo que cargan las cuatro pantallas que la dibujan: el
papel, la vista de impresión, la ficha del cliente y el historial—. La pantalla
de depilación tiene la suya, porque ahí todavía no hay comprobante: son los
mismos renglones y tiene que dar lo mismo. Si fueran cuatro cuentas, un día el
papel que sale al cobrar diría otra cosa que la ficha.

Los abonos de seña no se repiten abajo, en lo recibido: ya se restaron arriba, y
listados otra vez lo recibido sumaba más que el total. Por lo mismo la tarjeta
del historial y la de la ficha muestran `cobrado`, que es lo que entró sin
contar señas, y no `ingresado`.

**Y lo que se MUESTRA de una seña es siempre el valor de la lista de
transferencia**, no la plata que entró al cajón: es el número que se le dijo al
tomarla y el que después tapa. Vale para el cartel de "tiene $X de seña" de
Facturar y de Depilación, para la lista de las libres y para la ficha de la
clienta, que al lado aclara lo que entró. Sale de `valorSena()` en `senas.js`,
uno solo para las tres pantallas. Con el número del cajón, una seña de $5.000
pagada en efectivo avisaba $4.500: menos de lo que esa seña iba a tapar.

**La comisión sale de lo que la clienta terminó pagando por ESE trabajo.**
`base_comision()` arranca del precio efectivo, le aplica el ajuste de la línea y
después el descuento del comprobante. Lo que NO baja la base es la diferencia
entre la lista de transferencia y la de efectivo: no es un descuento que se le
hizo a nadie, son las dos listas de precios. Por eso se parte del efectivo y no
del de transferencia. Lo ya cerrado no se recalcula nunca: cada liquidación
guarda `base` y `comision` como estaban ese día.

**El cobro de depilación va en UN solo pedido.** `POST /api/comprobantes` con
`aplicar_senas` y `cobrar` crea el comprobante, aplica las señas y registra el
abono en la misma transacción: o queda cobrado o no queda nada. Eran tres
llamadas —crear, aplicar señas, cobrar— y con el internet del local la que no
llegaba dejaba el ticket cobrado a medias: con seña quedaba cobrado SOLO con la
seña y el resto como deuda, y si lo que fallaba era la consulta del saldo, el
`if (c.saldo > 0)` con `c.saldo` en `undefined` se saltaba el cobro **sin
avisar**. Facturar sigue cobrando en dos pasos porque ahí el cobro no siempre es
entero —cobrar una parte, dejar a cuenta, pago mixto—; las dos banderas vienen
apagadas por defecto.

**Anular un comprobante devuelve las señas que había usado.** Quedaban
apuntando al comprobante anulado: no saldaban nada y tampoco volvían a aparecer
como disponibles, así que esa plata se le perdía a la clienta sin que nada
avisara. En depilación se anula desde su propio historial lo de **toda la sesión
mientras siga abierta**, no solo lo de hoy: la jornada dura dos días y el error
se encuentra al otro, cuando se cierra la cuenta. Cerrada sí frena —el reparto
ya se liquidó y sacarle un ticket le cambiaría la cuenta a lo que se pagó—, que
es la misma regla de los gastos de la sesión. El que frena es el backend; la
pantalla solo deja de ofrecer el botón.

**La seña no es un ítem del catálogo.** Cargada como ítem SUMA al ticket en vez de
descontar, y después la seña de verdad descuenta aparte: pasó, y al cliente se le
cobraron $4.500 de más. Por eso `_no_es_sena()` rebota el ítem que se llame así,
al crearlo y al renombrarlo.

**Los extras no los toca ningún descuento.** Entran al final, después de todo.

**Ajuste por línea: porcentaje O monto fijo**, nunca los dos. Va por unidad y
con signo. El monto se resta igual de las dos listas.

## El papel impreso

80 mm, ESC/POS, **48 columnas exactas** (576 puntos ÷ 12 de la Font A). Se manda
a la app RawBT por el esquema `rawbt:base64,...`, que es una **navegación**: si
el aparato no tiene RawBT instalado, se va de la página. Por eso en facturar se
imprime siempre DESPUÉS de guardar y limpiar la pantalla.

Un solo generador, `static/escpos.js`, compartido por la vista de impresión y
por facturar. No duplicarlo: si hay dos, un día el papel que sale al cobrar dice
algo distinto del que sale al reimprimir.

Nada se recorta por la derecha si es un número. Un nombre cortado se ve; un
precio o un porcentaje cortado se lee como si fuera otro. Ya pasó: "Cliente
frecuente -10%" salía "-1" y el papel decía 1% en vez de 10%.

## Migraciones

`migrar()` en `main.py` corre al arrancar: agrega columnas que falten con
`ALTER TABLE ... ADD COLUMN`, que anda igual en SQLite y en PostgreSQL. No hay
Alembic ni nada parecido. Toda columna nueva se agrega ahí, y toda migración
tiene que poder correr muchas veces sin romper nada.

Para migrar DATOS (no esquema), dejar una marca en la tabla `config` para que
corra una sola vez; si no, cada reinicio le pisa al usuario lo que haya editado
a mano después.

**Las listas configurables se editan donde están.** Las cinco viven en
`static/js/listas.js` con un solo dibujante: fila editable, lo nuevo arriba y los
rótulos de esa primera fila haciendo de encabezado de las columnas. Lo usan Admin
y el panel que abre el lapicito al lado de cada desplegable en facturar, para no
tener que irse de un cobro a medio hacer. **Si son dos dibujantes, un día se
agrega un campo en Admin y el panel sigue sin pedirlo.**

Renombrar arrastra o no según qué sea el nombre: los tipos de egreso, los alias
y las formas de pago son una CLASIFICACIÓN y se arrastran a lo ya cargado (si no,
la caja muestra dos renglones para lo mismo); los descuentos y los ajustes por
ítem son lo que se le DIJO al cliente y salieron impresos, así que no se tocan
hacia atrás.

**"Efectivo" y "Transferencia" no se renombran ni se borran.** No son dos
opciones de una lista: el arqueo suma comparando `pago.forma_pago == "Efectivo"`
y facturar guarda ese texto exacto al cobrar. Sin ellas los pagos salen con la
forma vacía y el arqueo dice que hay más plata de la que hay, sin avisar. Por eso
`FORMAS_FIJAS` en `main.py` y el candado en la lista.

**El historial se pide de a páginas.** `/api/comprobantes` no devuelve todo: se
le pasa ventana de fechas, búsqueda, filtro, orden y `limite`/`offset`, y
contesta `{comprobantes, total, total_sin_filtros, deuda_total}`. La pantalla
arranca en los últimos 30 días y salta sola a "Todo" cuando escribís en el
buscador, porque buscar un servicio de hace dos años es justo para lo que se usa.
Ordenar y filtrar los hace el servidor: hacerlo sobre lo que está dibujado
pondría arriba el más caro de los primeros 60 y no el más caro de todos.

Ordenar por fecha o por número se resuelve en SQL. **"Con deuda", "convertidos",
"sin convertir" y ordenar por monto, no**: el saldo sale de
`estado_comprobante()`, que recorre las líneas con `precio_con_ajuste()` y los
redondeos de las dos listas, y escribir esa cuenta también en SQL sería tener dos
versiones de la cuenta de la plata. Esos casos traen lo que pasó los filtros de
SQL y calculan en Python, como antes. Si alguna vez hay que acelerarlos, la
salida NO es reescribir la cuenta en SQL: es guardar el total en una columna al
crear y al cobrar.

## Caché del navegador

Sin `Cache-Control`, el navegador no pregunta si el archivo cambió: adivina. En
la tablet, que queda abierta días, eso significaba seguir usando el CSS y el JS
de la semana pasada. **Esto explicaba dos quejas que parecían bugs distintos**
("el modo oscuro se buguea" y "va lento"): el local nunca estaba corriendo los
arreglos. Hoy el middleware manda `no-cache` a las páginas, el CSS y el JS
(guardalo pero preguntá siempre, y el ETag contesta 304 vacío), y un año a las
tipografías y el ícono.

## Cómo verificar antes de dar algo por terminado

No alcanza con que compile. Lo que se usa acá, de menor a mayor:

1. **Levantar el servidor y pegarle a la API de verdad.** Los cálculos de plata
   se comprueban con números, no leyendo el código.
2. **Playwright contra la app real**, mirando también que no haya errores de
   JavaScript en consola.
3. **Comparación byte a byte del papel** cuando se toca la impresión: se genera
   con el código viejo y con el nuevo sobre los mismos comprobantes y no puede
   salir un byte distinto.
4. **Comparación píxel a píxel** cuando el cambio es un refactor que no debería
   cambiar nada: capturas completas antes y después, en tema claro y oscuro.

**Hay dos suites versionados y corren en cada PR** (`.github/workflows/tests.yml`):

```bash
pytest tests/test_plata.py           # la aritmética de plata del backend
node --test "tests/escpos/**/*.test.js"   # el papel, byte a byte contra los golden
```

`tests/test_plata.py` llama las funciones de `main.py` derecho, sin levantar el
servidor: `calcular_transfer`, `precio_con_ajuste`, `estado_comprobante`,
`sena_saldado` y `base_facturada`. Los comprobantes y los pagos se arman con
`SimpleNamespace`, así que **un campo nuevo en un modelo hay que agregarlo
también ahí**, o el test revienta con un AttributeError que no es un bug.

Los de `tests/escpos/` comparan el papel contra un `.bin` de referencia. Cuando
un cambio mueve el papel A PROPÓSITO se regeneran con
`node tests/escpos/generar-golden.js` y se mira el `git status`: los golden que
no tendrían que haberse movido tienen que seguir sin aparecer. Un caso nuevo se
agrega con su fixture y una línea en `CASOS`, en `tests/escpos/config.js`.

Las pruebas de una sola vez —levantar el servidor, Playwright, comparar
capturas— no se versionan: van al scratchpad de la sesión.

Cuando una prueba falla, **primero preguntarse si está mal la prueba**. En este
proyecto la mayoría de las fallas fueron eso: un puerto viejo, una contraseña
cambiada, un dato de prueba que ya no existía. Corregir la prueba, no el código,
cuando el que se equivocó fue el test.

## Idioma

Todo en castellano rioplatense: los nombres de las variables y funciones, los
comentarios, los mensajes de commit y lo que se le muestra al usuario.

### Cómo se le escribe al usuario

**La pantalla no explica: se usa.** Un renglón de texto solo se gana el lugar si
evita una equivocación en el momento de hacer algo —que unificar dos empleados
no se deshace, que un día suelto se carga desde la agenda y no desde Admin— y
entra en una línea. Todo lo demás se va: lo que describe qué es una pantalla
("Lo que entró, lo que salió y cuántos tickets se emitieron" arriba de un
resumen), lo que cuenta cómo está armada la app por dentro, y lo que los
rótulos, los números o el botón ya dicen.

Dos lugares donde el texto sí rinde, y son los únicos: el **confirm** antes de
algo que mueve plata, con la cuenta hecha, y el **estado vacío**, que contesta
por qué no hay nada. Un aviso dice las excepciones que hay, no que no hay
ninguna: "Menos Carolina, que cobra la suya" sirve; "ninguna tiene una hora
propia" es un renglón para decir que no pasa nada.

Lo que hay que explicar va en un comentario, que lo lee el que toca el código, o
en el mensaje de commit. En la pantalla no.

### Cómo se comenta

**Una línea que diga qué hace esto, y después solo lo que no se deduce leyendo.**
Un comentario largo se saltea, así que el largo hay que gastarlo donde rinde: en
la decisión rara, la que alguien va a querer "arreglar" sin saber qué rompía.

Lo que NO va en un comentario:
- **La historia.** "Antes pasaba X y ahora pasa Y" es para el mensaje de commit,
  que es donde se lee cuando se busca por qué cambió algo. En el código, el
  "antes" es ruido: el que lee tiene adelante el "ahora".
- **Repetir el código en castellano.** Si el nombre de la función ya lo dice, el
  comentario sobra.
- **El caso de prueba.** Los números del ejemplo con el que se encontró un bug
  van en el commit, no arriba de la función.

Un docstring de cinco párrafos casi siempre son dos frases y un commit. Si la
explicación no entra en tres o cuatro renglones, es señal de que la función hace
dos cosas: partirla explica más que el comentario.

    # Bien
    def ciclo_de(f):
        """A qué semana de pago pertenece un día: de sábado a viernes.

        Ojo: el ciclo ARRANCA el sábado, y con weekday() el sábado cae después
        del viernes en el número pero antes en el ciclo; de ahí el `dow + 2`.
        """

    # Mal
    # Antes el ciclo era de martes a sábado, pero resulta que en el local pagan
    # el viernes lo que se hizo desde el sábado, así que ahora... (12 renglones)

## Seguridad

El repositorio es **público**. Nada secreto puede estar en el código.

La clave que firma los tokens sale de `SECRET_KEY` o, si no está, de una al azar
guardada en la base. Es la contraseña maestra en los hechos: con ella se fabrica
un token de dueño sin saber ninguna contraseña. Nunca poner un valor por defecto
en el código — ya pasó, y la app andaba perfecto igual, así que nada avisaba.

Las contraseñas de fábrica de `seed_datos.py` también son públicas: el sistema
detecta quién sigue usando una y lo avisa con un cartel que no se puede cerrar.

## Al terminar un cambio

Commit en castellano explicando **por qué**, no qué (el diff ya dice qué), y
push a `main`. El deploy en Railway es automático.

Acá sí va la historia: qué pasaba antes, con qué caso se encontró el bug y qué
números daba. Es lo que se busca cuando se pregunta "¿por qué cambió esto?", y es
justo lo que no tiene que estar en el comentario. Un título de una línea y dos o
tres párrafos alcanzan; si hace falta más, probablemente sean dos commits.
