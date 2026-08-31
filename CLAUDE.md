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
  escpos.js      Generador del papel de la comandera (ticket.html y facturar.js)
```

## Levantarlo para probar

```bash
python3 -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Usuarios de la base local de prueba: `dueno` / `test1234`. **Los de producción
son otros** y no están acá.

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
comentarios, los mensajes de commit y lo que se le muestra al usuario. Los
comentarios explican **por qué**, no qué — y en particular explican las
decisiones raras, para que el que venga después no las "arregle" sin saber qué
rompía. Son largos a propósito.

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
