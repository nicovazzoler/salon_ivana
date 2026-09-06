# Backups

La base de la peluquería tiene los comprobantes, los pagos, la cuenta corriente
de cada cliente y el stock. Si se pierde, no hay de dónde sacarla de nuevo: el
papel que se imprime no vuelve para atrás.

Hay tres copias y son tres a propósito, porque cada una falla distinto. Dos
corren solas; la tercera es un botón.

| | Qué es | Cada cuánto | De qué NO te salva |
|---|---|---|---|
| 1 | Backups de Railway | — | **no disponible en el plan Hobby** |
| 2 | `pg_dump` en la PC → Drive | diario, 22:30 | si la PC está apagada, ese día no hay |
| 3 | GitHub Actions → artifact privado | diario, 00:00 arg. | si se pierde la cuenta de GitHub |

Las capas 2 y 3 son independientes a propósito: distinta máquina, distinta
cuenta, distinto lugar donde queda el archivo. Que se caigan las dos el mismo
día es mucho más difícil que que se caiga una.

## 1. Los backups de Railway — HOY NO LOS TENEMOS

Railway tiene snapshots del volumen y Point-in-Time Recovery (volver a un
momento exacto, no solo al último snapshot), pero **PITR es exclusivo del plan
Pro** y el proyecto está en Hobby.

O sea que del lado del proveedor no hay red. **Las otras dos capas no son un
extra: son todo lo que hay.** Por eso son dos y automáticas las dos, y por eso
cada una avisa fuerte cuando falla.

Si algún día se pasa a Pro, esto se habilita desde el panel del servicio de
Postgres, pestaña Backups, y conviene hacerlo: es la única capa que puede
recuperar un borrado de hace veinte minutos sin perder lo del resto del día.

Aun con Pro, seguiría haciendo falta una copia propia: los backups de Railway
viven adentro de Railway. Si se pierde el acceso a la cuenta, si se cae la
tarjeta, si hay un problema de facturación, se pierden junto con la base.

## 2. El backup automático a tu PC y a Drive

Un `pg_dump` que corre todas las noches en la PC con Windows y deja el archivo
en una carpeta sincronizada con Google Drive u OneDrive. De una sola pasada
quedan las dos copias, la del disco y la de la nube, las dos afuera de Railway.

### Instalarlo (una sola vez)

1. **Instalar el cliente de PostgreSQL.** Bajar el instalador de
   <https://www.postgresql.org/download/windows/>. En la pantalla de componentes
   alcanza con tildar **Command Line Tools**; el servidor no hace falta.

2. **Copiar la carpeta `backup\` a la PC** (o clonar el repo).

3. Botón derecho sobre **`instalar_tarea.ps1`** → *Ejecutar con PowerShell*.

   Se abre el Bloc de notas con el archivo de configuración. Hay que completar:

   - **`DATABASE_URL`**: en Railway, servicio Postgres → pestaña *Variables* →
     **`DATABASE_PUBLIC_URL`**. Ojo: la que termina en `.railway.internal` **no
     sirve**, esa solo funciona adentro de Railway.
   - **`CARPETA_DESTINO`**: una carpeta que sincronice con Drive u OneDrive.

   Guardar, cerrar, y el script agenda la tarea y corre un backup de prueba.

Queda corriendo todos los días a las 22:30. Si a esa hora la PC estaba apagada,
corre apenas se prende: no se saltea el día.

### Cómo saber que sigue andando

En la carpeta de destino hay un archivo **`_ULTIMO_BACKUP.txt`** con la fecha del
último backup bueno. **Si esa fecha quedó vieja, el backup dejó de correr.**

Si algo falla aparece **`_FALLO_BACKUP.txt`** con el motivo, y el detalle está en
`backup.log`, en la misma carpeta.

Un backup que falla callado es peor que no tener backup, porque uno se queda
tranquilo. Por eso los avisos son archivos en la carpeta de Drive y no una línea
en un log que nadie abre.

## 3. El backup automático en GitHub Actions

El mismo `pg_dump`, pero corriendo en GitHub en vez de en tu PC. Es la copia que
sigue andando aunque la PC esté apagada, de viaje o rota.

Antes de darlo por bueno **restaura el dump en un Postgres descartable y compara
contra la base**: cantidad de comprobantes, de pagos y la suma de la plata. Si
no coinciden, la corrida falla. Un backup que nunca restauraste no es un backup,
es un archivo.

### Instalarlo (una sola vez)

1. **Crear un repositorio nuevo y PRIVADO** en GitHub, por ejemplo
   `salon_ivana_backups`.

   Tiene que ser privado. Los artifacts de un repo público los baja cualquiera,
   y el dump tiene datos de los clientes y los hash de las contraseñas.

2. **Copiar tres archivos** de `backup/github-actions/` de este repo:

   ```
   .github/workflows/backup.yml   <- backup.yml
   scripts/hacer_backup.sh        <- hacer_backup.sh
   scripts/verificar_restore.sh   <- verificar_restore.sh
   ```


3. **Cargar la URL de la base** en ese repo: *Settings → Secrets and variables →
   Actions → New repository secret*.

   - Nombre: `DATABASE_URL`
   - Valor: el `DATABASE_PUBLIC_URL` de Railway (el mismo del backup de la PC)

4. **Probarlo**: pestaña *Actions* → *Backup de la base* → *Run workflow*.

   Si sale verde, en la portada del repo aparece `ULTIMO_BACKUP.md` con la fecha,
   y el `.dump` queda en los artifacts de esa corrida.

### Cómo bajar un backup

Pestaña **Actions** → entrar a la corrida del día que se busca → abajo de todo,
en **Artifacts**, está el `.dump`. Se guardan 90 días.

### Dos cosas para no dejar pasar

**Si el workflow falla, GitHub te manda un mail.** No lo ignores: significa que
esa noche no hubo copia, o —peor— que el backup salió pero no restaura bien.

**GitHub apaga los workflows programados en repos sin actividad durante 60
días.** Por eso cada corrida commitea `ULTIMO_BACKUP.md`, que además de dejar la
fecha a la vista genera actividad. Igual, si alguna vez llega el mail avisando
que lo va a desactivar, hay que entrar y reactivarlo.

## 4. El JSON desde la app

En **Admin → Backup completo → Descargar backup** baja un `.json` con todas las
tablas. Es el único manual, y no reemplaza a los otros dos. Pero tiene algo que
el `.dump` no: se abre y se lee con
cualquier cosa, sin tener PostgreSQL instalado. Sirve para consultar un dato de
apuro, o para restaurar si alguna vez no hay a mano un Postgres.

**El archivo tiene DNI, teléfonos y direcciones de los clientes, y los hash de
las contraseñas. No va al repositorio, que es público, ni a ningún lado
compartido.**

---

# Restaurar

## Desde un `.dump` (backup automático)

La forma segura es levantar una base nueva al lado, mirarla, y recién después
decidir. Nunca restaurar encima de la base que está en uso como primer paso.

```powershell
# 1. Crear una base vacía nueva (en Railway: New -> Database -> PostgreSQL)
# 2. Restaurar el dump ahí
pg_restore --dbname="URL_DE_LA_BASE_NUEVA" --no-owner --no-privileges salon_ivana_20260905_2230.dump
```

Después apuntar la app a esa base (variable `DATABASE_URL`) y revisar que la
caja del último día dé bien antes de dar nada por hecho.

## Desde el `.json`

```bash
python3 restaurar_backup.py backup_pelu_20260905_2130.json --destino "postgresql://..."
```

Por las dudas, el script se niega a escribir sobre una base que ya tenga datos.
Para pisarla igual hay que pasar `--vaciar` y escribir `BORRAR` cuando lo pide.

Al terminar compara la suma de los pagos del archivo contra la de la base, y si
no coincide avisa que esa base no sirve. Entiende los dos formatos: los backups
viejos guardaban la fecha en hora argentina y sin offset, y el script les
devuelve las tres horas para que la caja de cada día no quede corrida.

---

# Qué se probó

Antes de dar esto por bueno, sobre la app real:

- Ida y vuelta completo: base con datos → `/api/backup` → `restaurar_backup.py`
  → base nueva. Las 20 tablas quedaron **idénticas celda por celda**.
- La caja del día, comparada entre las dos bases con la app corriendo contra
  cada una. Incluye un pago de las 21:23 argentinas (00:23 UTC del día
  siguiente), que es el caso que ya rompió una vez.
- Lo mismo con un backup del formato viejo, para confirmar que no se corren las
  fechas.
- `pg_dump` + `pg_restore` contra PostgreSQL: 20 tablas, contenido idéntico.
- Restauración en PostgreSQL y después un `INSERT`, para confirmar que las
  secuencias quedan donde tienen que quedar. Sin eso la base restaurada arranca
  dando `id` 1 y el primer ticket que se cobra revienta por clave duplicada.

Del backup de GitHub Actions, contra un PostgreSQL de verdad:

- `hacer_backup.sh` en el caso bueno y en los cuatro de falla: sin
  `DATABASE_URL`, base inexistente, dump corrupto (truncado a propósito) y dump
  con menos tablas de las que corresponden. En todos, sale con error y **no deja
  archivo**.
- `verificar_restore.sh` en los dos sentidos: contra una copia sana da todo
  igual, y cuando se le mete un pago a la base después de hacer el dump, lo
  detecta y falla.
- El dump que genera el workflow, restaurado y comparado tabla por tabla contra
  el original: idéntico.

Probando eso apareció un error real: `pg_dump` **crea el archivo antes** de
conectarse, así que un intento fallido dejaba un `.dump` de cero bytes en la
carpeta, y si caía en el mismo minuto pisaba al bueno. Ahora los dos scripts
escriben en un temporal y recién mueven el archivo a su lugar cuando pasó todas
las verificaciones.

Lo único que no se pudo probar acá: los dos `.ps1` (no hay Windows en el entorno
donde se escribieron) y el paso del workflow que levanta el Postgres descartable
con Docker. La lógica que corre adentro de ese paso sí está probada.
