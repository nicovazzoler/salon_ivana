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
  css/           tokens → base → layout → components → app  (el orden importa)
  js/            El JS de facturar y admin, que son las grandes
  auth.js        Sesión, menú y helpers compartidos
  js/listas.js   Las cinco listas configurables (formas de pago, tipos de egreso,
                 descuentos, ajustes por ítem, alias): un solo dibujante que usan
                 Admin y el panel del lapicito de facturar
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

**El lunes de depilación no se paga por comisión: se reparte el día.** El local
abre un lunes al mes solo para depilación. Lo lleva Carolina, que consigue la
máquina, más una ayudante que a veces no es del salón. La cuenta es del DÍA, no
de cada trabajo:

    recaudado del día − egresos del día (insumos + el pago a la ayudante)
    = resto  →  50% Carolina · 50% el salón, que pone el local

Lo que la hace distinta de cualquier otro día:
- El pago a la ayudante se anota como un egreso más, así que entra solo en la
  resta: no hay que tratarlo aparte.
- "Recaudado" incluye las señas cobradas días antes, porque son plata de ese
  lunes aunque hayan entrado otro día. Sale de los PAGOS de los comprobantes con
  fecha de ese lunes, no de la caja del lunes.
- Los egresos **privados** no entran: el alquiler no es costo de la depilación, y
  el detalle se lo muestra a ella. Sin ese filtro, cerrar la liquidación —que
  crea un egreso privado con el sueldo, con fecha de hoy— le cambiaba la cuenta
  al lunes que se estaba cerrando.
- El ciclo es de un solo día y le toca a UNA sola persona: `empleada_del_dia()`
  elige la que más facturó ese lunes. Si fuera "la que tenga alguna línea", la
  ayudante que atendió algo vería el reparto entero y el número aparecería dos
  veces.
- El lunes le aparece aunque no tenga un ítem a comisión ni una hora cargada
  (`lunes_depi_pendientes()`), que es lo normal en depilación. Como puede no
  tener ningún trabajo detrás, lo que dice que ya se pagó es la liquidación
  misma: sin ese filtro, un lunes sin trabajos volvía a aparecer pendiente
  después de cobrarlo, siempre.
- La empleada lo ve con su código en Sueldos —es su plata— y **cierra la dueña**,
  como todos los ciclos.

**La seña es plata de la clienta, no un pago de un ticket.** Se toma sin
comprobante —desde la ficha o desde facturar— y entra a la caja del día en que se
cobra. Al facturarle, se aplican todas las que tenga libres y cada una deja un
abono con `sena_id`. **Ese abono no es plata del día**: ya entró. Por eso
`plata_que_entro()` saltea los abonos con `sena_id` y suma las señas cobradas, y
todo lo que cuenta plata por fecha —caja, reportes, el Excel, los gráficos— pasa
por ahí. Contándolos dos veces, el arqueo pide más efectivo del que hay en el
cajón y no avisa por qué. El filtro va por el id y no por el texto "Seña", que se
puede tipear distinto.

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

Las pruebas no están versionadas: se escriben en el scratchpad de la sesión.

Cuando una prueba falla, **primero preguntarse si está mal la prueba**. En este
proyecto la mayoría de las fallas fueron eso: un puerto viejo, una contraseña
cambiada, un dato de prueba que ya no existía. Corregir la prueba, no el código,
cuando el que se equivocó fue el test.

## Idioma

Todo en castellano rioplatense: los nombres de las variables y funciones, los
comentarios, los mensajes de commit y lo que se le muestra al usuario.

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

        El lunes es su propio ciclo de un día —la depilación, una vez por mes—.
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
