# Backups de Ivana Salón

Este repo no tiene la app: tiene **las copias de seguridad de su base de datos** y
el mecanismo que las hace solo, todas las noches.

Está separado del repo de la app —y es privado— por un motivo concreto: el repo
de la app es público, y **los artifacts de un repositorio público los puede bajar
cualquiera**. Adentro de cada backup hay DNI, teléfonos y direcciones de las
clientas, y los hash de las contraseñas de los usuarios.

Este documento explica cómo funciona todo, qué herramienta hace qué, y por qué
está resuelto así y no de otra manera.

---

## Índice

1. [El mapa: por qué tres copias](#1-el-mapa-por-qué-tres-copias)
2. [El recorrido de un backup](#2-el-recorrido-de-un-backup)
3. [Los lenguajes, y por qué cada uno](#3-los-lenguajes-y-por-qué-cada-uno)
4. [Las tres herramientas de PostgreSQL](#4-las-tres-herramientas-de-postgresql)
5. [El código, explicado](#5-el-código-explicado)
6. [Comandos que vas a usar de verdad](#6-comandos-que-vas-a-usar-de-verdad)
7. [El día que haya que restaurar](#7-el-día-que-haya-que-restaurar)
8. [Las trampas que ya nos mordieron](#8-las-trampas-que-ya-nos-mordieron)
9. [Glosario](#9-glosario)

---

## 1. El mapa: por qué tres copias

| | Qué es | Cuándo | Contra qué protege | Contra qué NO |
|---|---|---|---|---|
| 1 | Backups de Railway | — | borrados recientes, migraciones fallidas | **no está: es exclusivo del plan Pro** |
| 2 | `pg_dump` en la PC → OneDrive | 23:30 | perder la cuenta de Railway | si la PC está apagada, ese día no hay |
| 3 | GitHub Actions → artifact | 00:00 arg. | que la PC no exista | si se pierde la cuenta de GitHub |

La idea de fondo es que **cada copia falle por un motivo distinto**. Dos backups
en el mismo lugar no son dos backups: son uno con una fotocopia al lado. Las
capas 2 y 3 corren en máquinas distintas, con cuentas distintas y guardan en
lugares distintos, así que hace falta que pasen dos cosas independientes para
quedarse sin nada.

La capa 1 no existe hoy porque el proyecto está en el plan Hobby de Railway y el
Point-in-Time Recovery es de Pro. Eso convierte a la 2 y la 3 en todo lo que hay,
y es la razón por la que las dos avisan fuerte cuando fallan en vez de fallar
calladas.

---

## 2. El recorrido de un backup

Esto es lo que pasa, de verdad, cada noche a las 03:00 UTC:

```
   GitHub dispara el cron
            │
            ▼
   Levanta un runner: una máquina virtual Ubuntu, vacía, de un solo uso
            │
            ▼
   [1] Le pregunta a Railway qué versión de Postgres corre
       └─ e instala EXACTAMENTE ese pg_dump
            │
            ▼
   [2] pg_dump ──> archivo temporal
       └─ ¿pesa lo suficiente?  ¿pg_restore lo puede leer?  ¿trae 20 tablas?
            │  (si algo falla acá: se borra el archivo y la corrida muere)
            ▼
   [3] Levanta un PostgreSQL descartable en Docker
       └─ restaura el backup ahí adentro
       └─ compara contra la base viva: comprobantes, pagos, SUMA DE LA PLATA
            │  (si los números no dan: la corrida muere)
            ▼
   [4] Recién ahora sube el archivo como artifact (se guarda 90 días)
            │
            ▼
   [5] Escribe ULTIMO_BACKUP.md en la portada del repo
            │
            ▼
   El runner se destruye. No queda nada.
```

El paso **[3] es el que distingue esto de un backup común**. La mayoría de los
sistemas de backup verifican que el archivo se pueda leer y se dan por
satisfechos. Eso prueba que el archivo no está corrupto, no que sirva. Acá se
restaura de verdad y se comparan los números contra la base real.

> Un backup que nunca restauraste no es un backup: es un archivo.

---

## 3. Los lenguajes, y por qué cada uno

En este sistema hay cinco, y ninguno está por gusto.

### YAML — el workflow (`.github/workflows/backup.yml`)

**No es un lenguaje de programación**: es un formato para escribir datos
estructurados, como el JSON pero pensado para que lo lea una persona. La sangría
es la que define qué está adentro de qué, así que **un espacio de más rompe el
archivo**.

GitHub Actions lee este archivo y de ahí saca *cuándo* correr, *en qué máquina* y
*qué pasos* ejecutar. Vos describís el resultado que querés; no programás el cómo.

```yaml
on:
  schedule:
    - cron: "0 3 * * *"
  workflow_dispatch:
```

Eso dice: correr a las 03:00 UTC todos los días, y además dejar un botón para
dispararlo a mano.

### Bash — los scripts que corren en el runner (`scripts/*.sh`)

El runner de GitHub es Linux, y todo lo que hay que hacer es *encadenar
programas*: correr `pg_dump`, mirar si le fue bien, correr `pg_restore`, comparar
salidas. Para eso Bash es la herramienta natural — está hecho exactamente para
pegar programas entre sí.

Podría haber sido Python, pero habría sido Python llamando a los mismos comandos
con más ceremonia alrededor.

### PowerShell — el backup de la PC (`backup_salon.ps1`, en el repo de la app)

El equivalente de Bash en Windows. Viene instalado, no hay que agregar nada, y
sabe hablar con el Programador de tareas.

Una diferencia que se nota: en Bash todo son cadenas de texto; en PowerShell todo
son **objetos**. Por eso podemos hacer cosas como:

```powershell
Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\pg_dump.exe" |
    Sort-Object { [int]($_.Directory.Parent.Name) } -Descending
```

`Get-ChildItem` no devuelve texto: devuelve archivos, con sus propiedades. Por eso
se les puede preguntar `.Directory.Parent.Name` y ordenar por eso. En Bash habría
que parsear texto a mano.

### Python — el importador del JSON (`restaurar_backup.py`, en el repo de la app)

Este es distinto a los otros: **no maneja archivos, maneja los datos de la app**.
Tiene que saber que un `Comprobante` tiene `lineas` y `extras`, que `convertido_de`
apunta a otro comprobante, y que las fechas se guardan en UTC. Para eso necesita
importar los mismos modelos de SQLAlchemy que usa la app.

Es la regla: **el código que entiende el negocio vive en el lenguaje de la app.**

### SQL — las comprobaciones

Las verificaciones se escriben en SQL porque la pregunta es sobre datos:

```sql
SELECT coalesce(sum(monto), 0) FROM pagos
```

`coalesce` devuelve el primer valor que no sea nulo. Si la tabla está vacía,
`sum()` da `NULL` en vez de `0`, y comparar `NULL` con `NULL` en SQL **no da
verdadero** — da `NULL`. El `coalesce` evita ese agujero.

---

## 4. Las tres herramientas de PostgreSQL

Vienen con el cliente de PostgreSQL. No son parte de la app: son las herramientas
oficiales de la base.

| Herramienta | Qué hace |
|---|---|
| **`psql`** | La consola. Te conectás y escribís SQL. Sirve para preguntar cosas. |
| **`pg_dump`** | Saca una copia completa de una base a un archivo. |
| **`pg_restore`** | Toma ese archivo y lo mete en otra base. |

### La regla de las versiones, que es la que más rompe

> **`pg_dump` se niega a copiar un servidor MÁS NUEVO que él. `psql` no tiene ese problema.**

Railway corre PostgreSQL 18. Con un `pg_dump` 17 el backup falla; con `psql` 17 te
conectás igual y parece que está todo bien. Por eso una prueba de conexión con
`psql` **no garantiza** que el backup vaya a funcionar.

De ahí sale este truco, que es el corazón del primer paso del workflow:

```bash
NUM=$(psql "$DATABASE_URL" -tAc "SHOW server_version_num")
MAYOR=$((NUM / 10000))
```

Se le pregunta al servidor con `psql` (que sí puede aunque sea viejo) y se instala
el `pg_dump` que corresponda. **El día que Railway actualice a 19, esto se adapta
solo.**

`server_version_num` devuelve un entero: `180006` para la 18.6. Dividido por
10000 da la versión mayor, 18.

### Los formatos de `pg_dump`

```bash
pg_dump "$URL" --format=custom --file=backup.dump   # binario comprimido
pg_dump "$URL" --file=backup.sql                    # texto plano, SQL
```

Usamos **custom** porque es el único que `pg_restore` puede leer de forma
selectiva (restaurar una sola tabla, listar el contenido sin restaurar nada) y
además comprime. El de texto plano se lee con cualquier editor, pero pesa mucho
más y se restaura entero o nada.

Los otros dos flags:

- `--no-owner`: no guarda quién era el dueño de cada tabla.
- `--no-privileges`: no guarda los permisos.

Los dos van juntos y sirven para lo mismo: que el backup se pueda restaurar **en
cualquier servidor**, sin que ahí existan los mismos usuarios que en Railway. Sin
esto, la restauración se llena de errores del tipo *role "postgres" does not exist*.

---

## 5. El código, explicado

### El archivo temporal, y por qué

```bash
TEMPORAL="$(mktemp -t salon_ivana.XXXXXX.dump)"
trap 'rm -f "$TEMPORAL"' EXIT

pg_dump "$DATABASE_URL" --format=custom --file="$TEMPORAL"
# ... acá van todas las verificaciones ...
mv "$TEMPORAL" "$ARCHIVO"    # recién ahora ocupa su nombre definitivo
```

**`pg_dump` crea el archivo ANTES de conectarse.** Si la conexión falla, deja uno
de cero bytes. Escribiendo derecho al destino, un intento fallido plantaba en la
carpeta algo que parecía un backup, y encima pisaba al bueno del mismo minuto.

Esto no lo encontramos leyendo el código: apareció probando el caso de falla justo
después del caso exitoso.

**`trap 'comando' EXIT`** es una red de seguridad de Bash: ese comando se ejecuta
cuando el script termine, salga por donde salga —bien, mal, o a la mitad—. Es el
equivalente del `finally` de otros lenguajes.

### `set -euo pipefail`

Está arriba de todos los scripts. Son tres seguros distintos:

| | Qué hace | Por qué |
|---|---|---|
| `-e` | corta el script si un comando falla | si `pg_dump` falla, no seguir como si nada |
| `-u` | error si usás una variable que no existe | un `$ARCHVIO` mal escrito da error, no cadena vacía |
| `-o pipefail` | en `a \| b`, si falla `a` falla todo | sin esto, solo cuenta el último de la tubería |

Sin `-e`, un script que falla en el medio **sigue corriendo y termina diciendo que
todo salió bien**. Es la diferencia entre un backup que falla y uno que miente.

### Las tres verificaciones

```bash
BYTES=$(stat -c%s "$TEMPORAL")
[ "$BYTES" -lt "$MINIMO_BYTES" ] && exit 1        # 1. ¿pesa algo?

LISTADO=$(pg_restore --list "$TEMPORAL") || exit 1  # 2. ¿se puede leer?

TABLAS=$(echo "$LISTADO" | grep -c "TABLE DATA")
[ "$TABLAS" -lt "$MINIMO_TABLAS" ] && exit 1      # 3. ¿están todas?
```

Cada una atrapa una falla que las otras dejan pasar:

1. Un dump **vacío** pesa 0 pero existe.
2. Un dump **truncado** pesa mucho y no se puede leer.
3. Un dump que salió **a mitad de camino** pesa bien y se lee bien, pero le faltan
   tablas.

### El código de salida

Todo esto se apoya en una convención de Unix: **un programa devuelve 0 si le fue
bien y cualquier otro número si falló.** No es una elección nuestra, es cómo se
comunican los programas entre sí.

Por eso `exit 1` en el script hace que GitHub marque la corrida en rojo y te mande
el mail. La cadena es: script falla → paso falla → corrida falla → llega el aviso.

### `>&2`, que aparece en todos los `echo` de error

```bash
echo "ERROR: falta DATABASE_URL" >&2
```

Todo programa tiene dos salidas de texto: **stdout** (lo normal) y **stderr** (los
errores). `>&2` manda el mensaje a la segunda. Sirve para que los errores no se
mezclen con la salida cuando encadenás comandos con `|`.

### Cómo se pasan datos entre pasos del workflow

Cada paso corre en su propio shell: las variables no sobreviven de uno al otro.
GitHub resuelve eso con dos archivos especiales:

```bash
echo "MAYOR=$MAYOR" >> "$GITHUB_ENV"        # variable para los pasos siguientes
echo "archivo=$ARCHIVO" >> "$GITHUB_OUTPUT" # salida de ESTE paso
```

Y después se leen así:

```yaml
- name: Hacer el backup
  id: dump                                    # le pongo nombre al paso
  run: bash ./scripts/hacer_backup.sh backups

- uses: actions/upload-artifact@v7
  with:
    path: ${{ steps.dump.outputs.archivo }}   # y acá leo su salida
```

La sintaxis `${{ ... }}` es de GitHub: se reemplaza por el valor **antes** de que
el paso corra.

### El cron

```
"0 3 * * *"
 │ │ │ │ │
 │ │ │ │ └── día de la semana (0-6, domingo = 0)
 │ │ │ └──── mes (1-12)
 │ │ └────── día del mes (1-31)
 │ └──────── hora (0-23)
 └────────── minuto (0-59)
```

El `*` es "todos". Entonces `0 3 * * *` = "el minuto 0 de la hora 3, todos los
días de todos los meses".

**GitHub lo interpreta en UTC**, siempre. Las 03:00 UTC son las 00:00 en Argentina
(UTC−3). Si quisieras que corra a las 22:00 argentinas, serían las 01:00 UTC del
día siguiente: `0 1 * * *`.

---

## 6. Comandos que vas a usar de verdad

Todos necesitan la URL de la base. Está en Railway → servicio Postgres →
Variables → **`DATABASE_PUBLIC_URL`**. La que termina en `.railway.internal` no
sirve desde afuera.

```powershell
# Guardarla en una variable para no repetirla (dura hasta que cerrés la ventana)
$URL = "postgresql://usuario:clave@host:puerto/railway"
```

### Mirar sin tocar nada

```powershell
psql $URL -c "SELECT version()"                    # qué versión corre
psql $URL -c "\dt"                                 # listar las tablas
psql $URL -c "SELECT count(*) FROM comprobantes"   # una consulta suelta
psql $URL                                          # consola interactiva (\q para salir)
```

### Ver qué hay adentro de un backup, sin restaurarlo

```powershell
pg_restore --list backup.dump                      # todo el contenido
pg_restore --list backup.dump | Select-String "TABLE DATA"   # solo las tablas
```

Este es el comando más subestimado de los tres. **Te deja auditar un backup sin
tocar ninguna base.**

### Hacer un backup a mano

```powershell
pg_dump $URL --format=custom --no-owner --no-privileges --file=prueba.dump
```

### Sacar una sola tabla de un backup

```powershell
pg_restore --dbname=$URL_DESTINO --table=clientes backup.dump
```

Útil cuando se rompió *una* cosa y no hace falta restaurar todo.

---

## 7. El día que haya que restaurar

La regla, y es la más importante del documento:

> **Nunca restaurar encima de la base que está en uso como primer paso.**

Se levanta una base nueva al lado, se restaura ahí, se mira, y recién después se
decide. Restaurar es rápido; darse cuenta de que restauraste el backup equivocado
sobre los datos buenos no tiene vuelta.

### Procedimiento

**1. Conseguir el backup más nuevo.** Dos lugares:

- OneDrive: `C:\Users\nicoe\OneDrive\Backups\salon_ivana\`
- Este repo: pestaña **Actions** → entrar a la corrida del día → abajo, en
  **Artifacts**, está el `.dump`

**2. Crear una base vacía.** En Railway: **New** → **Database** → **PostgreSQL**.
Copiar su `DATABASE_PUBLIC_URL`.

**3. Restaurar ahí.**

```powershell
pg_restore --dbname=$URL_NUEVA --no-owner --no-privileges salon_ivana_20260906_1857.dump
```

**4. Mirar antes de confiar.**

```powershell
psql $URL_NUEVA -c "SELECT count(*), max(fecha) FROM comprobantes"
psql $URL_NUEVA -c "SELECT coalesce(sum(monto),0) FROM pagos"
```

¿La fecha del último comprobante es la que esperabas? ¿Los totales tienen sentido?

**5. Recién ahí**, apuntar la app a la base nueva cambiando `DATABASE_URL` en las
variables del servicio en Railway, y revisar la caja del último día en la app
antes de dar nada por terminado.

### Si el backup es un `.json` en vez de un `.dump`

El que baja de **Admin → Backup completo** en la app. Ese se restaura con el
script de Python del repo de la app:

```bash
python3 restaurar_backup.py backup_pelu_20260906_2130.json --destino "postgresql://..."
```

Se niega a escribir sobre una base que ya tenga datos, y al terminar compara la
suma de los pagos contra el archivo.

---

## 8. Las trampas que ya nos mordieron

Todas aparecieron **probando**, ninguna leyendo el código. Las dejo escritas
porque son las que se vuelven a cometer.

### El dump de cero bytes

`pg_dump` crea el archivo antes de conectarse. Un intento fallido dejaba un
`.dump` vacío en la carpeta que pisaba al bueno del mismo minuto.
**Solución:** escribir en un temporal y mover recién al final.

### `pg_dump` viejo contra servidor nuevo

Se niega y no hay forma de forzarlo. Lo traicionero es que `psql` **sí** conecta,
así que probar la conexión te deja tranquilo sin motivo.
**Solución:** preguntarle la versión al servidor e instalar el cliente que
corresponda.

### Finales de línea de Windows en un script de Linux

Si git sube los `.sh` con CRLF, bash lee el retorno de carro como parte del
comando y falla con:

```
$'\r': command not found
set: pipefail: invalid option name
```

Dos mensajes que no mencionan en ningún lado que el problema son los finales de
línea, y que te mandan a buscar el error adentro del script.
**Solución:** el `.gitattributes` con `*.sh text eol=lf`.

### El bit de ejecución

Al subir archivos desde Windows se pierde fácil, y `./script.sh` falla con
*Permission denied*.
**Solución:** invocarlos como `bash ./script.sh`, así el permiso deja de importar.

### Los acentos en PowerShell

Windows PowerShell 5.1 lee los `.ps1` como ANSI salvo que el archivo empiece con
el BOM de UTF-8. Sin él, `Se creó` sale `Se creÃ³` — y eso se filtraba adentro del
archivo `_ULTIMO_BACKUP.txt`, que es justo el que hay que poder leer para saber si
el backup sigue vivo.
**Solución:** guardar los `.ps1` con BOM.

### Las acciones que apuntan a Node 20

GitHub las estuvo forzando a Node 24 con un aviso, y saca Node 20 de los runners
el 16/09/2026. Un aviso ignorado se convierte en una corrida rota.
**Solución:** `actions/checkout@v7` y `actions/upload-artifact@v7`.

---

## 9. Glosario

**Runner** — la máquina virtual donde GitHub corre el workflow. Se crea vacía, hace
lo suyo y se destruye. Nada de lo que dejes ahí sobrevive: por eso el backup tiene
que subirse como artifact antes de que termine.

**Artifact** — un archivo que un workflow guarda para después. Se baja desde la
página de la corrida. Acá duran 90 días.

**Secret** — una variable guardada cifrada en el repo. El workflow la lee, pero
nadie la puede volver a ver: solo reemplazar. Si un secret aparece en la salida de
un paso, GitHub lo tapa con `***` automáticamente.

**Cron** — el formato de cinco campos para decir "cada cuánto". Ver arriba.

**Código de salida** — el número que devuelve un programa al terminar. 0 = salió
bien, cualquier otro = falló. Es lo que hace que un `exit 1` en un script termine
en un mail en tu casilla.

**stdout / stderr** — las dos salidas de texto de un programa: la normal y la de
errores. `>&2` manda algo a la segunda.

**Idempotente** — que correrlo dos veces da lo mismo que correrlo una. El backup lo
es (dos corridas seguidas dejan dos archivos, no rompen nada); una restauración
**no** lo es, y por eso pide confirmación.

**Dump** — el archivo con la copia de la base. En formato `custom` es binario y
comprimido: no se abre con un editor, se lee con `pg_restore --list`.

**PITR (Point-in-Time Recovery)** — poder volver a un instante exacto, no solo al
último backup. Railway lo ofrece a partir del plan Pro.

---

## Los archivos de este repo

```
.github/workflows/backup.yml   El workflow: cuándo corre y qué pasos ejecuta
scripts/hacer_backup.sh        Hace el pg_dump y lo verifica
scripts/verificar_restore.sh   Lo restaura en una base descartable y compara
.gitattributes                 Fuerza finales de línea LF en los .sh
ULTIMO_BACKUP.md               Lo reescribe cada corrida. Si quedó viejo, algo pasa.
```

Los dos scripts **no dependen de GitHub**: son scripts comunes y corren igual en
cualquier Linux con el cliente de PostgreSQL instalado. Eso es a propósito — la
lógica que decide si un backup sirve tiene que poder probarse sin esperar a que
GitHub la ejecute.

```bash
DATABASE_URL="postgresql://..." bash scripts/hacer_backup.sh /tmp/prueba
```
