# Backups de Ivana Salón

Copias de la base de producción (PostgreSQL 18 en Railway) y el mecanismo que las
hace solo, todas las noches.

**El repo es privado y tiene que seguir siéndolo:** los artifacts de un repo
público los baja cualquiera, y cada dump trae DNI, teléfonos y direcciones de las
clientas, más los hash de las contraseñas.

```
.github/workflows/backup.yml   Cuándo corre y qué pasos ejecuta
scripts/hacer_backup.sh        pg_dump + verificación
scripts/verificar_restore.sh   Lo restaura en una base descartable y compara
.gitattributes                 Fuerza LF en los .sh
ULTIMO_BACKUP.md               Lo reescribe cada corrida. Si quedó viejo, algo pasa.
```

---

## Flujo

```
cron 03:00 UTC (00:00 ART)
   │
   ▼
runner Ubuntu, efímero
   │
   ├─[1] psql pregunta la versión del servidor → instala ESE pg_dump
   │
   ├─[2] pg_dump → archivo temporal
   │     ¿pesa > 5 KB?  ¿pg_restore lo lee?  ¿trae ≥ 15 tablas?
   │     falla cualquiera → borra el archivo y exit 1
   │
   ├─[3] docker run postgres:18 → restaura ahí → compara contra la base viva
   │     count(comprobantes), count(pagos), sum(pagos.monto), sum(total_lista)
   │     no coinciden → exit 1
   │
   ├─[4] upload-artifact (retención 90 días)
   │
   └─[5] commit de ULTIMO_BACKUP.md
```

El paso [3] es el que diferencia esto de un backup común: verificar que el archivo
se **lea** solo prueba que no está corrupto, no que sirva.

---

## Lenguajes

| Dónde | Lenguaje | Por qué |
|---|---|---|
| `backup.yml` | YAML | Formato de datos, no lenguaje. Declara *qué*, no *cómo*. La sangría define la estructura. |
| `scripts/*.sh` | Bash | El runner es Linux y el trabajo es encadenar programas (`pg_dump`, `pg_restore`, `psql`). |
| `backup_salon.ps1` | PowerShell | Windows. Viene instalado y habla con el Programador de tareas. |
| `restaurar_backup.py` | Python | Único que entiende los modelos de la app (SQLAlchemy): sabe que un `Comprobante` tiene `lineas` y `extras`. |
| Verificaciones | SQL | La pregunta es sobre datos. |

Regla: **el código que entiende el negocio va en el lenguaje de la app**; el que
mueve archivos, en el del sistema operativo.

Diferencia práctica Bash / PowerShell — en Bash todo es texto, en PowerShell son
objetos:

```powershell
Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\pg_dump.exe" |
    Sort-Object { [int]($_.Directory.Parent.Name) } -Descending
```

Devuelve archivos con propiedades, por eso se puede ordenar por
`.Directory.Parent.Name`. En Bash habría que parsear texto.

---

## psql, pg_dump, pg_restore

| | Qué hace |
|---|---|
| `psql` | Consola. Te conectás y escribís SQL. |
| `pg_dump` | Copia una base entera a un archivo. |
| `pg_restore` | Mete ese archivo en otra base. |

### Regla de versiones

> **`pg_dump` se niega a copiar un servidor más nuevo que él. `psql` no.**

Railway corre 18. Con `pg_dump` 17 el backup falla, pero `psql` 17 conecta igual —
así que **probar la conexión no garantiza que el backup funcione**.

De ahí el paso [1]:

```bash
NUM=$(psql "$DATABASE_URL" -tAc "SHOW server_version_num")   # 180006
MAYOR=$((NUM / 10000))                                        # 18
sudo apt-get install -y -qq "postgresql-client-$MAYOR"
```

Se pregunta con `psql` (que puede aunque sea viejo) y se instala el cliente
correcto. Cuando Railway pase a 19, se adapta solo.

### Formatos

```bash
pg_dump "$URL" --format=custom --file=b.dump   # binario comprimido
pg_dump "$URL" --file=b.sql                    # texto plano
```

`custom` porque es el único que `pg_restore` lee de forma selectiva (una tabla
sola, listar sin restaurar) y comprime.

- `--no-owner` / `--no-privileges`: no guarda dueños ni permisos, para poder
  restaurar en cualquier servidor sin que existan los roles de Railway. Sin esto,
  la restauración se llena de `role "postgres" does not exist`.

---

## Código

### Temporal + trap

```bash
TEMPORAL="$(mktemp -t salon_ivana.XXXXXX.dump)"
trap 'rm -f "$TEMPORAL"' EXIT

pg_dump "$DATABASE_URL" --format=custom --file="$TEMPORAL"
# ... verificaciones ...
mv "$TEMPORAL" "$ARCHIVO"
```

`pg_dump` **crea el archivo antes de conectarse**. Si falla, deja uno de 0 bytes.
Escribiendo derecho al destino, un intento fallido pisaba al backup bueno del
mismo minuto.

`trap ... EXIT` corre pase lo que pase al terminar el script. Es el `finally` de
Bash.

### set -euo pipefail

| | Qué hace |
|---|---|
| `-e` | corta si un comando falla |
| `-u` | error si usás una variable inexistente (un `$ARCHVIO` mal escrito no pasa como cadena vacía) |
| `-o pipefail` | en `a \| b`, si falla `a` falla todo |

Sin `-e` un script que falla a la mitad sigue y termina diciendo que salió bien.

### Las tres verificaciones

```bash
BYTES=$(stat -c%s "$TEMPORAL")
[ "$BYTES" -lt "$MINIMO_BYTES" ] && exit 1          # vacío

LISTADO=$(pg_restore --list "$TEMPORAL") || exit 1   # corrupto

TABLAS=$(echo "$LISTADO" | grep -c "TABLE DATA")
[ "$TABLAS" -lt "$MINIMO_TABLAS" ] && exit 1        # incompleto
```

Cada una atrapa lo que las otras dejan pasar: un dump vacío pesa 0 pero existe;
uno truncado pesa bien y no se lee; uno cortado a la mitad pesa bien, se lee bien,
y le faltan tablas.

### Códigos de salida y stderr

Convención de Unix: **0 = bien, cualquier otro = falló**. La cadena es
`exit 1` → paso falla → corrida en rojo → mail.

```bash
echo "ERROR: falta DATABASE_URL" >&2
```

`>&2` manda a **stderr** en vez de **stdout**, para que los errores no se mezclen
con la salida al encadenar con `|`.

### Pasar datos entre pasos

Cada paso corre en su propio shell; las variables no sobreviven.

```bash
echo "MAYOR=$MAYOR"        >> "$GITHUB_ENV"      # para los pasos siguientes
echo "archivo=$ARCHIVO"    >> "$GITHUB_OUTPUT"   # salida de este paso
```

```yaml
- name: Hacer el backup
  id: dump
  run: bash ./scripts/hacer_backup.sh backups

- uses: actions/upload-artifact@v7
  with:
    path: ${{ steps.dump.outputs.archivo }}
```

`${{ }}` se resuelve **antes** de que el paso corra.

### Cron

```
"0 3 * * *"
 │ │ │ │ └── día de semana (0-6, dom=0)
 │ │ │ └──── mes (1-12)
 │ │ └────── día del mes (1-31)
 │ └──────── hora (0-23)
 └────────── minuto (0-59)
```

**Siempre UTC.** 03:00 UTC = 00:00 ART. Para las 22:00 ART sería `0 1 * * *`
(01:00 UTC del día siguiente).

### SQL de las comprobaciones

```sql
SELECT coalesce(sum(monto), 0) FROM pagos
```

`sum()` sobre tabla vacía da `NULL`, y `NULL = NULL` **no da verdadero, da
`NULL`**. El `coalesce` tapa ese agujero.

---

## Comandos

```powershell
$URL = "postgresql://usuario:clave@host:puerto/railway"   # DATABASE_PUBLIC_URL de Railway
```

```powershell
# Mirar sin tocar
psql $URL -c "SELECT version()"
psql $URL -c "\dt"                                  # listar tablas
psql $URL -c "SELECT count(*) FROM comprobantes"
psql $URL                                           # consola (\q para salir)

# Auditar un backup SIN tocar ninguna base
pg_restore --list backup.dump
pg_restore --list backup.dump | Select-String "TABLE DATA"

# Backup a mano
pg_dump $URL --format=custom --no-owner --no-privileges --file=prueba.dump

# Restaurar una sola tabla
pg_restore --dbname=$URL_DESTINO --table=clientes backup.dump
```

Los scripts no dependen de GitHub, corren en cualquier Linux:

```bash
DATABASE_URL="postgresql://..." bash scripts/hacer_backup.sh /tmp/prueba
```

---

## Restaurar

> **Nunca restaurar encima de la base en uso como primer paso.**

**1. Conseguir el dump.** OneDrive (`C:\Users\nicoe\OneDrive\Backups\salon_ivana\`)
o pestaña **Actions** → la corrida del día → **Artifacts**.

**2. Base vacía.** Railway → New → Database → PostgreSQL. Copiar su
`DATABASE_PUBLIC_URL`.

**3. Restaurar ahí.**

```powershell
pg_restore --dbname=$URL_NUEVA --no-owner --no-privileges salon_ivana_20260906_1857.dump
```

**4. Verificar antes de confiar.**

```powershell
psql $URL_NUEVA -c "SELECT count(*), max(fecha) FROM comprobantes"
psql $URL_NUEVA -c "SELECT coalesce(sum(monto),0) FROM pagos"
```

**5. Recién ahí** apuntar la app cambiando `DATABASE_URL` en Railway, y revisar la
caja del último día en la app.

### Desde un .json (Admin → Backup completo)

```bash
python3 restaurar_backup.py backup_pelu_20260906_2130.json --destino "postgresql://..."
```

Se niega si la base destino ya tiene datos. Al terminar compara la suma de pagos
contra el archivo.

---

## Trampas conocidas

Todas aparecieron probando, ninguna leyendo el código.

| Síntoma | Causa | Solución |
|---|---|---|
| `.dump` de 0 bytes que pisa al bueno | `pg_dump` crea el archivo antes de conectarse | temporal + `mv` al final |
| El backup falla pero `psql` conecta | `pg_dump` más viejo que el servidor | preguntar la versión e instalar el cliente correcto |
| `$'\r': command not found`<br>`set: pipefail: invalid option name` | `.sh` con finales de línea CRLF | `.gitattributes` con `*.sh text eol=lf` |
| `Permission denied` al correr un `.sh` | se perdió el bit de ejecución al subir desde Windows | invocarlo como `bash ./script.sh` |
| `Se creÃ³` en la consola y en `_ULTIMO_BACKUP.txt` | PowerShell 5.1 lee los `.ps1` como ANSI sin BOM | guardar los `.ps1` con BOM UTF-8 |
| `Node.js 20 is deprecated` | acciones apuntando a node20 (se saca el 16/09/2026) | `checkout@v7`, `upload-artifact@v7` |

---

## Glosario

**Runner** — VM efímera donde corre el workflow. Se crea vacía y se destruye; por
eso el dump tiene que subirse como artifact antes de terminar.

**Artifact** — archivo que el workflow guarda para después. Se baja desde la
corrida. Acá duran 90 días.

**Secret** — variable cifrada del repo. Se puede reemplazar, no leer. Si aparece en
la salida de un paso, GitHub la tapa con `***`.

**Idempotente** — correrlo dos veces da lo mismo que una. El backup lo es; una
restauración no, y por eso pide confirmación.

**PITR** — volver a un instante exacto, no solo al último backup. Railway lo da
desde el plan Pro; el proyecto está en Hobby, así que **no hay backups del lado del
proveedor**: estas copias son todo lo que hay.
