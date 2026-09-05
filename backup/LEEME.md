# Backups

La base de la peluquería tiene los comprobantes, los pagos, la cuenta corriente
de cada cliente y el stock. Si se pierde, no hay de dónde sacarla de nuevo: el
papel que se imprime no vuelve para atrás.

Hay tres copias, y son tres a propósito, porque cada una falla distinto.

## 1. Los backups de Railway

Los hace Railway solo, no hay nada que programar. En el servicio de Postgres,
pestaña **Backups**: snapshots del volumen, y Point-in-Time Recovery, que
permite volver a un momento exacto y no solo al último snapshot. Al restaurar,
Railway crea un servicio nuevo al lado (`<origen>-restored-AAAAMMDD-HHMM`), así
que no pisa la base que está en uso.

Es lo que salva del susto común: se borró algo sin querer, una migración salió
mal. **Andá al panel y confirmá que están habilitados**, según el plan cambia
qué hay disponible.

Lo que NO cubre: vive adentro de Railway. Si se pierde el acceso a la cuenta, si
se cae la tarjeta, si hay un problema de facturación, se pierden los backups
junto con la base. Por eso hay una segunda copia.

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

## 3. El JSON desde la app

En **Admin → Backup completo → Descargar backup** baja un `.json` con todas las
tablas. Es manual, pero tiene algo que el `.dump` no: se abre y se lee con
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
