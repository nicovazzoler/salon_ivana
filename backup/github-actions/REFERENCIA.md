# Referencia de comandos y sintaxis

Referencia general de shell, SQL, YAML y Python. La columna **Acá** marca lo que
aparece en el código de estos backups; el resto es del entorno y lo vas a
necesitar igual.

Las secciones 8 y 9 son las que más sirven cuando lees código ajeno: **lo mismo
dicho en cada lenguaje**, y **cómo descifrar un comando que no conocés**.

---

## 1. Bash

### Comandos externos

| Comando | Acá | Qué hace | Ejemplo |
|---|:-:|---|---|
| `pg_dump` | ✓ | copia una base a un archivo | `pg_dump "$URL" --format=custom --file=b.dump` |
| `pg_restore` | ✓ | restaura o lista un dump | `pg_restore --list b.dump` |
| `psql` | ✓ | consola de PostgreSQL | `psql "$URL" -tAc "SELECT 1"` |
| `mktemp` | ✓ | crea un archivo temporal único | `mktemp -t nombre.XXXXXX.dump` |
| `stat` | ✓ | datos de un archivo | `stat -c%s archivo` → tamaño en bytes |
| `grep` | ✓ | filtra líneas | `grep -c "TABLE DATA"` → cuenta coincidencias |
| `cut` | ✓ | recorta texto | `cut -c1-40` → primeros 40 caracteres |
| `date` | ✓ | fecha y hora | `TZ=America/Argentina/Buenos_Aires date +%Y%m%d_%H%M` |
| `basename` | ✓ | nombre sin la ruta | `basename /a/b/c.dump` → `c.dump` |
| `mkdir -p` | ✓ | crea carpetas, sin quejarse si existen | `mkdir -p "$DESTINO"` |
| `mv` / `rm -f` | ✓ | mover / borrar (`-f` no protesta si no está) | `mv "$TMP" "$FINAL"` |
| `printf` | ✓ | imprime con formato (más preciso que `echo`) | `printf '%-30s %s\n' "$a" "$b"` |
| `sed` | | edita texto por línea | `sed -n '10,20p' archivo` |
| `awk` | | procesa por columnas | `awk '{print $5}'` |
| `find` | | busca archivos | `find . -name "*.dump" -mtime +30` |
| `xargs` | | pasa una lista como argumentos | `find . -name "*.tmp" \| xargs rm` |
| `head` / `tail` | | primeras / últimas líneas | `tail -f log` sigue en vivo |
| `wc -l` | | cuenta líneas | `wc -l < archivo` |
| `curl` | ✓ | baja de una URL | `curl -fsSL URL -o archivo` |
| `tee` | ✓ | escribe a archivo Y a pantalla | `... \| tee -a log` |

### Sintaxis

| Forma | Acá | Qué hace |
|---|:-:|---|
| `$(comando)` | ✓ | sustitución: reemplaza por la SALIDA del comando |
| `$((3 + 4))` | ✓ | aritmética. `$((NUM / 10000))` |
| `${VAR:-valor}` | ✓ | si `VAR` no existe, usa `valor`. `${1:-.}` |
| `${VAR:?mensaje}` | ✓ | si no existe, corta con ese error. `${1:?falta el archivo}` |
| `"$VAR"` | ✓ | **siempre con comillas.** Sin ellas, una ruta con espacios se parte en dos |
| `[ ... ]` | ✓ | test. `[ "$N" -lt 5 ]`, `[ -z "$V" ]` (vacío), `[ -f "$A" ]` (existe) |
| `a && b` | ✓ | corre `b` solo si `a` salió bien |
| `a \|\| b` | ✓ | corre `b` solo si `a` falló |
| `>&2` | ✓ | manda a stderr en vez de stdout |
| `2>&1` | ✓ | manda stderr a donde va stdout |
| `>>` | ✓ | agrega al final del archivo (`>` pisa) |
| `\|` | ✓ | tubería: la salida de uno es la entrada del otro |
| `\` al final | ✓ | parte un comando en varias líneas |
| `arr=(a b c)` | ✓ | array. `"${arr[@]}"` recorre todos |
| `for x in ...; do ... done` | ✓ | bucle |
| `if ...; then ... fi` | ✓ | condicional |

### Builtins

| Builtin | Acá | Qué hace |
|---|:-:|---|
| `set -e` | ✓ | corta el script si un comando falla |
| `set -u` | ✓ | error si usás una variable inexistente |
| `set -o pipefail` | ✓ | en `a \| b`, si falla `a` falla todo |
| `trap 'cmd' EXIT` | ✓ | corre `cmd` al terminar, salga por donde salga. Es el `finally` |
| `exit N` | ✓ | termina. **0 = bien, otro = falló** |
| `echo` | ✓ | imprime |
| `export VAR=x` | | pasa la variable a los programas que se llamen |
| `read VAR` | | lee de la entrada |
| `shift` | | corre los argumentos: `$2` pasa a ser `$1` |

### Variables especiales

| | Qué es |
|---|---|
| `$1`, `$2`… | argumentos del script |
| `$0` | nombre del script |
| `$#` | cuántos argumentos llegaron |
| `$?` | código de salida del último comando |
| `$$` | PID del proceso |

---

## 2. PowerShell

Los cmdlets son **Verbo-Sustantivo**, siempre. Si sabés el verbo, adivinás el
nombre.

### Cmdlets

| Cmdlet | Acá | Qué hace | Alias |
|---|:-:|---|---|
| `Get-ChildItem` | ✓ | lista archivos y carpetas | `dir`, `ls` |
| `Get-Content` | ✓ | lee un archivo | `cat`, `gc` |
| `Set-Content` | ✓ | escribe un archivo (pisa) | `sc` |
| `Add-Content` | | agrega al final | `ac` |
| `Test-Path` | ✓ | ¿existe? devuelve `$true`/`$false` | |
| `Join-Path` | ✓ | arma rutas sin pelearse con las barras | |
| `Split-Path` | ✓ | saca la carpeta o el nombre de una ruta | |
| `New-Item` | ✓ | crea archivo o carpeta | `mkdir`, `ni` |
| `Remove-Item` | ✓ | borra | `del`, `rm` |
| `Move-Item` | ✓ | mueve o renombra | `mv` |
| `Copy-Item` | | copia | `copy`, `cp` |
| `Get-Item` | ✓ | un archivo como objeto (para leer `.Length`) | |
| `Get-Date` | ✓ | fecha y hora | |
| `Get-Command` | ✓ | ¿dónde está este programa? | `where.exe` |
| `Write-Host` | ✓ | imprime en pantalla (acepta `-ForegroundColor`) | |
| `Write-Error` | ✓ | escribe un error | |
| `Sort-Object` | ✓ | ordena | `sort` |
| `Select-Object` | ✓ | elige propiedades | `select` |
| `Where-Object` | | filtra | `where`, `?` |
| `ForEach-Object` | ✓ | hace algo con cada elemento | `foreach`, `%` |
| `Measure-Object` | | cuenta, suma, promedia | |
| `Tee-Object` | ✓ | a archivo Y a pantalla | `tee` |
| `Out-Null` | ✓ | descarta la salida | |
| `Start-Process` | ✓ | lanza un programa (`-Wait` para esperarlo) | |
| `Push-Location` / `Pop-Location` | | entrar y volver | `pushd` / `popd` |

### Tareas programadas

| Cmdlet | Acá | Qué hace |
|---|:-:|---|
| `New-ScheduledTaskAction` | ✓ | qué ejecutar |
| `New-ScheduledTaskTrigger` | ✓ | cuándo (`-Daily -At "23:30"`) |
| `New-ScheduledTaskSettingsSet` | ✓ | opciones (`-StartWhenAvailable` = si la PC estaba apagada, corre al prender) |
| `Register-ScheduledTask` | ✓ | la crea (`-Force` pisa una existente) |
| `Get-ScheduledTask` | | listar |
| `Start-ScheduledTask` | | dispararla a mano |
| `Unregister-ScheduledTask` | | borrarla |

### Sintaxis

| Forma | Acá | Qué hace |
|---|:-:|---|
| `$var = ...` | ✓ | asignación |
| `$env:USERPROFILE` | ✓ | variable de entorno. También `$env:TEMP`, `$env:OneDrive` |
| `$PSScriptRoot` | ✓ | carpeta donde está el script |
| `$LASTEXITCODE` | ✓ | código de salida del último `.exe` |
| `$script:var` | ✓ | variable visible en todo el script, no solo en la función |
| `$_` | ✓ | el elemento actual dentro de un pipeline |
| `& $ruta arg` | ✓ | ejecuta un programa cuya ruta está en una variable |
| `@( ... )` | ✓ | array |
| `@{ }` | ✓ | hashtable (diccionario) |
| `"texto $var"` | ✓ | interpola. `'texto $var'` **no** |
| `"$($obj.Prop)"` | ✓ | interpola una expresión |
| `` ` `` al final | ✓ | parte en varias líneas (backtick, no `\`) |
| `param(...)` | ✓ | argumentos del script |
| `function N($a) { }` | ✓ | función |
| `-ErrorAction Stop` | ✓ | que un error corte en vez de seguir |
| `$ErrorActionPreference = "Stop"` | ✓ | lo mismo para todo el script |
| `\| Out-Null` | ✓ | tirar la salida |

**Trampa:** en Bash `$a` es texto; en PowerShell es un **objeto**. Por eso podés
`$_.Directory.Parent.Name` sin parsear nada.

---

## 3. psql, pg_dump, pg_restore

### Flags compartidos

| Flag | Acá | Qué hace |
|---|:-:|---|
| `--dbname=URL` o la URL suelta | ✓ | a qué base conectarse |
| `-h host` `-p puerto` `-U usuario` `-d base` | ✓ | lo mismo, por partes |
| `PGPASSWORD=x` (variable) | ✓ | la contraseña sin que la pida |

### psql

| Flag | Acá | Qué hace |
|---|:-:|---|
| `-c "SQL"` | ✓ | corre una consulta y sale |
| `-t` | ✓ | sin encabezados |
| `-A` | ✓ | sin alineación (salida limpia para scripts) |
| `-tAc` | ✓ | los tres juntos: **la forma de usarlo desde un script** |
| `-f archivo.sql` | | corre un archivo |
| `-q` | ✓ | callado |

Meta-comandos (adentro de la consola):

| | Qué hace |
|---|---|
| `\dt` | listar tablas |
| `\d tabla` | estructura de una tabla |
| `\l` | listar bases |
| `\du` | listar usuarios |
| `\x` | salida vertical (para filas anchas) |
| `\timing` | mostrar cuánto tarda cada consulta |
| `\q` | salir |

### pg_dump

| Flag | Acá | Qué hace |
|---|:-:|---|
| `--format=custom` (`-Fc`) | ✓ | binario comprimido, el que lee `pg_restore` |
| `--file=X` (`-f`) | ✓ | dónde escribir |
| `--no-owner` | ✓ | no guarda dueños |
| `--no-privileges` | ✓ | no guarda permisos |
| `--table=X` (`-t`) | | solo esa tabla |
| `--schema-only` (`-s`) | | estructura sin datos |
| `--data-only` (`-a`) | | datos sin estructura |

### pg_restore

| Flag | Acá | Qué hace |
|---|:-:|---|
| `--list` (`-l`) | ✓ | **lista el contenido sin restaurar nada** |
| `--dbname=X` (`-d`) | ✓ | dónde restaurar |
| `--no-owner` `--no-privileges` | ✓ | ídem pg_dump |
| `--table=X` (`-t`) | | restaurar una sola tabla |
| `--clean --if-exists` | | borra antes de crear. **Cuidado: destructivo** |
| `--jobs=N` (`-j`) | | en paralelo, más rápido |

> **Regla:** `pg_dump` y `pg_restore` se niegan si el servidor es **más nuevo**
> que ellos. `psql` no. Probar con `psql` no garantiza que el backup funcione.

---

## 4. SQL

| | Acá | Qué hace |
|---|:-:|---|
| `SELECT count(*) FROM t` | ✓ | cuántas filas |
| `sum(col)` | ✓ | suma. **Sobre tabla vacía da `NULL`, no 0** |
| `coalesce(a, b)` | ✓ | el primero que no sea nulo |
| `max(col)` / `min(col)` | ✓ | mayor / menor |
| `SHOW server_version_num` | ✓ | versión como entero (`180006` = 18.6) |
| `SELECT version()` | ✓ | versión como texto |
| `md5(string_agg(t::text, '\|'))` | | huella de una tabla entera, para comparar |
| `WHERE` / `ORDER BY` / `GROUP BY` | | filtrar / ordenar / agrupar |
| `col::text` | ✓ | convertir de tipo |
| `pg_get_serial_sequence('t','id')` | ✓ | nombre de la secuencia de un `id` |
| `setval(seq, N, false)` | ✓ | mover la secuencia. **Sin esto una base restaurada da `id` 1 y choca** |

`NULL` no es un valor, es "no se sabe": `NULL = NULL` da `NULL`, no verdadero.

---

## 5. GitHub Actions (YAML)

| Clave | Acá | Qué hace |
|---|:-:|---|
| `name:` | ✓ | nombre que se ve en la pestaña Actions |
| `on:` | ✓ | qué lo dispara |
| `on.schedule.cron:` | ✓ | horario, **siempre UTC** |
| `on.workflow_dispatch:` | ✓ | habilita el botón "Run workflow" |
| `on.push:` | | correr en cada push |
| `permissions:` | ✓ | qué puede tocar el token (`contents: write` para commitear) |
| `concurrency:` | ✓ | evita dos corridas simultáneas |
| `jobs:` | ✓ | los trabajos |
| `runs-on:` | ✓ | qué máquina (`ubuntu-latest`) |
| `timeout-minutes:` | ✓ | corta si se cuelga |
| `env:` | ✓ | variables de entorno |
| `steps:` | ✓ | los pasos, en orden |
| `uses:` | ✓ | usa una acción de otro (`actions/checkout@v7`) |
| `run:` | ✓ | corre comandos de shell |
| `id:` | ✓ | nombre del paso, para leer sus outputs |
| `with:` | ✓ | argumentos de un `uses:` |
| `if:` | | condicional (`if: always()`, `if: failure()`) |
| `needs:` | | esperar a otro job |
| `services:` | | contenedores auxiliares |

### Expresiones y archivos especiales

| | Acá | Qué hace |
|---|:-:|---|
| `${{ secrets.X }}` | ✓ | lee un secret |
| `${{ steps.ID.outputs.X }}` | ✓ | lee la salida de un paso |
| `${{ github.sha }}` | | commit, rama, etc. |
| `$GITHUB_ENV` | ✓ | `echo "V=1" >> $GITHUB_ENV` → variable para los pasos siguientes |
| `$GITHUB_OUTPUT` | ✓ | `echo "k=v" >> $GITHUB_OUTPUT` → salida de este paso |
| `$GITHUB_PATH` | ✓ | agrega una carpeta al PATH |

### Acciones usadas

| | Acá | Qué hace |
|---|:-:|---|
| `actions/checkout@v7` | ✓ | baja el código del repo al runner |
| `actions/upload-artifact@v7` | ✓ | guarda un archivo (`retention-days`, `if-no-files-found`) |
| `actions/download-artifact@v7` | | lo recupera |
| `actions/setup-python@v5` | | instala Python |

**YAML:** la sangría define la estructura, y **son espacios, nunca tabs**. `-` es
un elemento de lista. `|` en `run: |` conserva los saltos de línea.

---

## 6. Python + SQLAlchemy

Solo en `restaurar_backup.py`, del repo de la app.

### Módulos estándar

| | Acá | Qué hace |
|---|:-:|---|
| `argparse.ArgumentParser()` | ✓ | argumentos de línea de comandos |
| `.add_argument("--x", action="store_true")` | ✓ | define un flag |
| `.parse_args()` | ✓ | los lee |
| `json.load(f)` / `json.dump(o, f)` | ✓ | leer / escribir JSON |
| `sys.exit("mensaje")` | ✓ | cortar con error |
| `datetime.fromisoformat(s)` | ✓ | texto ISO → fecha |
| `.astimezone(timezone.utc)` | ✓ | cambiar de huso |
| `.replace(tzinfo=None)` | ✓ | sacar el huso |
| `timedelta(hours=3)` | ✓ | intervalo, se suma o se resta a una fecha |

### SQLAlchemy

| | Acá | Qué hace |
|---|:-:|---|
| `create_engine(url)` | ✓ | conexión (perezosa: no conecta hasta que hace falta) |
| `sessionmaker(bind=engine)()` | ✓ | abre una sesión |
| `Base.metadata.create_all(engine)` | ✓ | crea las tablas que falten |
| `db.execute(...)` | ✓ | ejecuta |
| `db.scalar(select(...))` | ✓ | ejecuta y devuelve **un solo valor** |
| `db.commit()` / `db.rollback()` | ✓ | confirmar / deshacer |
| `Modelo.__table__.insert()` | ✓ | insert masivo preservando los `id` |
| `.update().where(...).values(...)` | ✓ | update |
| `.delete()` | ✓ | delete |
| `select(func.count()).select_from(t)` | ✓ | contar |
| `func.coalesce(func.sum(c), 0)` | ✓ | el `coalesce` de SQL, desde Python |
| `text("SQL crudo")` | ✓ | SQL literal cuando no alcanza el ORM |

Patrón que se repite:

```python
try:
    ...                 # todo el trabajo
    db.commit()         # confirmar al final
except Exception:
    db.rollback()       # si algo falló, no queda nada a medias
    raise
```

---

## 7. Git

| Comando | Qué hace |
|---|---|
| `git status` | qué cambió y en qué rama estás |
| `git branch --show-current` | solo la rama |
| `git log --oneline -5` | últimos 5 commits, una línea cada uno |
| `git ls-files` | **qué está commiteado de verdad** (para "¿subí el archivo?") |
| `git diff` / `git diff --staged` | cambios sin agregar / ya agregados |
| `git add .` | agregar todo |
| `git commit -m "msg"` | commitear |
| `git pull` / `git push` | traer / subir |
| `git checkout rama` | cambiar de rama |
| `git checkout -b rama` | crearla y cambiar |
| `git fetch origin rama` | traer sin mezclar |
| `git config --global core.editor notepad` | para no caer en vim |

Si caés en **vim**: `Esc`, `:wq`, Enter (guarda y sale). `:q!` cancela.

---

## 8. Lo mismo, en cada lenguaje

Casi todo lo que hace un script es una de estas quince cosas. Cambia cómo se
escribe, no qué es.

| Qué querés hacer | Bash | PowerShell | Python |
|---|---|---|---|
| Asignar | `x=5` (sin espacios) | `$x = 5` | `x = 5` |
| Usar la variable | `$x` / `"$x"` | `$x` | `x` |
| Interpolar en texto | `"hola $x"` | `"hola $x"` | `f"hola {x}"` |
| Comentario | `# ...` | `# ...` | `# ...` |
| Comparar igualdad | `[ "$a" = "$b" ]` | `$a -eq $b` | `a == b` |
| Comparar menor | `[ "$a" -lt "$b" ]` | `$a -lt $b` | `a < b` |
| Condicional | `if ...; then ... fi` | `if (...) { }` | `if ...:` |
| Bucle sobre lista | `for x in "${a[@]}"; do ... done` | `foreach ($x in $a) { }` | `for x in a:` |
| Función | `f() { ... }` | `function f($a) { }` | `def f(a):` |
| Lista / array | `a=(1 2 3)` | `$a = @(1,2,3)` | `a = [1,2,3]` |
| Diccionario | `declare -A d` | `$d = @{k="v"}` | `d = {"k":"v"}` |
| Argumentos del script | `$1 $2` | `param($a,$b)` | `sys.argv[1]` |
| Variable de entorno | `$HOME` | `$env:USERPROFILE` | `os.getenv("HOME")` |
| Salida de un comando | `$(cmd)` | `$(cmd)` o `& cmd` | `subprocess.run(..., capture_output=True)` |
| Código del último comando | `$?` | `$LASTEXITCODE` | `.returncode` |
| Terminar con error | `exit 1` | `exit 1` | `sys.exit(1)` |
| Imprimir | `echo x` | `Write-Host x` | `print(x)` |
| Imprimir a stderr | `echo x >&2` | `Write-Error x` | `print(x, file=sys.stderr)` |
| Limpiar pase lo que pase | `trap 'cmd' EXIT` | `try { } finally { }` | `try: ... finally:` |
| ¿Existe el archivo? | `[ -f "$a" ]` | `Test-Path $a` | `os.path.exists(a)` |
| Leer archivo | `cat a` | `Get-Content a` | `open(a).read()` |
| Escribir archivo | `echo x > a` | `Set-Content a x` | `open(a,"w").write(x)` |
| Agregar al final | `echo x >> a` | `Add-Content a x` | `open(a,"a").write(x)` |
| Listar archivos | `ls` | `Get-ChildItem` | `os.listdir()` |
| Crear carpeta | `mkdir -p a/b` | `mkdir a\b` | `os.makedirs(a, exist_ok=True)` |
| Unir rutas | `"$a/$b"` | `Join-Path $a $b` | `os.path.join(a,b)` |
| Borrar | `rm -f a` | `Remove-Item a -Force` | `os.remove(a)` |
| Fecha formateada | `date +%Y%m%d` | `Get-Date -Format "yyyyMMdd"` | `datetime.now().strftime("%Y%m%d")` |
| Encadenar | `a \| b` | `a \| b` | anidar llamadas |

### Los tres tipos de igualdad, que confunden

| | Bash | PowerShell | Python | SQL |
|---|---|---|---|---|
| Igual | `=` o `-eq` | `-eq` | `==` | `=` |
| Distinto | `!=` o `-ne` | `-ne` | `!=` | `<>` o `!=` |
| Menor | `-lt` | `-lt` | `<` | `<` |
| Y / O | `&&` `\|\|` | `-and` `-or` | `and` `or` | `AND` `OR` |
| Negación | `!` | `-not` o `!` | `not` | `NOT` |

En Bash, `[ "$a" = "$b" ]` compara **texto** y `[ "$a" -eq "$b" ]` compara
**números**. `[ "10" = "10.0" ]` es falso; `[ 10 -eq 10 ]` es verdadero.

### El pipeline: la idea que se repite en todos lados

```bash
comando1 | comando2 | comando3      # bash: pasa TEXTO
```
```powershell
Get-ChildItem | Sort-Object | Select-Object -First 3   # PowerShell: pasa OBJETOS
```

Es la misma idea que `.filter().map()` en JavaScript o las comprensiones de
Python: encadenar transformaciones chicas en vez de un bloque grande. La
diferencia clave: **en Bash lo que viaja por la tubería es texto plano; en
PowerShell son objetos con propiedades.** Por eso en Bash hay que parsear con
`grep`, `cut` y `awk`, y en PowerShell no.

---

## 9. Cómo descifrar un comando que no conocés

Cuando te cruzás con algo como `pg_dump -Fc --no-owner -f b.dump`:

**1. Preguntale al comando.**

```bash
comando --help          # resumen (a veces -h)
man comando             # manual completo (q para salir)
comando --version
```

```powershell
Get-Help Get-ChildItem -Examples     # PowerShell: ejemplos
Get-Help Get-ChildItem -Full
```

**2. Leé los flags con estas reglas**, que son casi universales en Unix:

| Forma | Qué significa |
|---|---|
| `-x` | flag corto, una letra |
| `--nombre` | flag largo, lo mismo pero legible. `-f` = `--file` |
| `-abc` | tres flags cortos juntos. `-tAc` es `-t -A -c` |
| `-f valor` / `--file=valor` | flag que lleva un valor |
| `--no-algo` | apaga algo que está prendido por defecto |
| `-v` / `-q` | verbose (hablá más) / quiet (callate) |
| `-f` (a veces) | **force**: hacelo igual, no me preguntes |
| `-r` / `-R` | recursivo: entrá también en las subcarpetas |
| `-n` | dry-run: mostrame qué harías, sin hacerlo |
| `-y` | sí a todo |
| `--` | "se acabaron los flags": lo que sigue son datos |

**3. Ojo con los que se repiten con sentidos distintos.** `-f` es `--file` en
`pg_dump` y `--force` en `rm`. Siempre confirmá con `--help`.

**4. Si vas a correr algo destructivo**, buscá primero la versión que solo mira:

| En vez de | Probá primero |
|---|---|
| `pg_restore -d base x.dump` | `pg_restore --list x.dump` |
| `rm -rf carpeta` | `ls carpeta` |
| `git reset --hard` | `git status` y `git diff` |
| `UPDATE t SET ...` | el mismo `WHERE` con un `SELECT` |

**5. Vocabulario que aparece en todos los mensajes de error:**

| | Qué significa |
|---|---|
| `command not found` | no está instalado, o no está en el PATH |
| `permission denied` | falta el bit de ejecución, o el usuario no puede |
| `no such file or directory` | la ruta está mal (¿estás parado donde creés?) |
| `connection refused` | nadie escuchando en ese puerto |
| `timeout` | el otro lado no contestó a tiempo |
| `syntax error near` | te falta cerrar algo (comilla, paréntesis, `fi`, `done`) |
| `unbound variable` | usaste una variable que no existe (con `set -u`) |
| `argument list too long` | pasaste demasiados archivos; usá `xargs` |

**6. El PATH**, que explica la mitad de los "command not found". Es la lista de
carpetas donde el sistema busca los programas:

```bash
echo $PATH                    # bash
which pg_dump                 # ¿dónde está?
```
```powershell
$env:PATH -split ';'          # PowerShell
Get-Command pg_dump           # ¿dónde está?
```

Si un programa está instalado pero "no existe", casi siempre es que su carpeta no
está en el PATH. Ese fue exactamente el caso del `pg_dump` de Windows: el
instalador no lo agrega, por eso el script lo busca a mano en
`C:\Program Files\PostgreSQL\*\bin\`.

---

## 10. Convenciones que valen en todos

**Códigos de salida.** `0` = bien, cualquier otro = falló. Es lo que hace que un
`exit 1` termine en un mail de GitHub.

**stdout / stderr.** Dos salidas separadas: la normal y la de errores. En Bash
`>&2` manda a la segunda.

**Variables de entorno.** Configuración que se le pasa a un programa desde afuera.
`$VAR` en Bash, `$env:VAR` en PowerShell, `os.getenv("VAR")` en Python.

**Idempotencia.** Que correrlo dos veces dé lo mismo que una. `mkdir -p` lo es,
`mkdir` no.

**Las comillas.** En Bash, `"$VAR"` siempre. Sin comillas, una ruta con espacios
se convierte en dos argumentos y el error no dice eso en ningún lado.
