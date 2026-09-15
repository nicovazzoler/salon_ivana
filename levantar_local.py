"""Levanta la app en tu PC con una copia del último backup de producción.

Restaura el backup en una base LOCAL, te deja un usuario con una contraseña que
sí sabés, y arranca el servidor.

    python3 levantar_local.py                     # el .dump más nuevo, en PostgreSQL
    python3 levantar_local.py --dump ruta.dump    # uno en particular
    python3 levantar_local.py --json backup.json  # en SQLite, SIN PostgreSQL
    python3 levantar_local.py --puerto 8001
    python3 levantar_local.py --solo-restaurar    # sin levantar el servidor

Dos caminos para lo mismo. Con --dump hace falta PostgreSQL instalado, y la base
local sale de la variable POSTGRES_LOCAL o de
postgresql://postgres:postgres@127.0.0.1:5432. Con --json alcanza con Python:
SQLite viene adentro, que es lo que salva a una PC donde no se puede instalar
nada. El .json se baja de la app, en Admin, con el usuario de la dueña.

OJO: esto BORRA y recrea la base local en cada corrida. Por eso se niega a
apuntar a cualquier cosa que no sea 127.0.0.1: el día que alguien corra esto con
la URL de Railway pegada por error, tiene que dar un error y no borrar la base
del local.
"""
import argparse
import glob
import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

# Contraseña del usuario local. Es pública a propósito y no importa: esta base
# vive en tu PC y es una copia descartable. Lo que NO se puede es quedarse con
# los usuarios de producción, porque sus contraseñas no las sabe nadie acá y no
# habría forma de entrar a la app.
USUARIO_LOCAL, PASS_LOCAL = "local", "local1234"

SOLO_LOCAL = {"127.0.0.1", "localhost", "::1"}


def es_local(url: str) -> bool:
    return (urlparse(url).hostname or "") in SOLO_LOCAL


def buscar_binario(nombre: str) -> str:
    """Encuentra psql / pg_restore aunque no estén en el PATH.

    El instalador de PostgreSQL en Windows NO agrega su carpeta bin al PATH, así
    que llamarlos por nombre revienta con un "WinError 2: el sistema no puede
    encontrar el archivo especificado" que no menciona a PostgreSQL por ningún
    lado. Se busca igual que en backup_salon.ps1: la versión más alta instalada,
    porque pg_restore puede con dumps más viejos pero no al revés.
    """
    ruta = shutil.which(nombre)
    if ruta:
        return ruta
    if os.name == "nt":
        candidatos = glob.glob(rf"C:\Program Files\PostgreSQL\*\bin\{nombre}.exe")
        if candidatos:
            def version(p):
                try:
                    return int(Path(p).parent.parent.name)
                except ValueError:
                    return 0
            return max(candidatos, key=version)
    sys.exit(f"No encuentro {nombre}. Instalá el cliente de PostgreSQL, o agregá "
             f"su carpeta bin al PATH:\n"
             f"  $env:PATH += ';C:\\Program Files\\PostgreSQL\\18\\bin'")


def correr(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        print(r.stdout, r.stderr, sep="\n", file=sys.stderr)
        sys.exit(f"Falló: {' '.join(str(c) for c in cmd[:3])}...")
    return r


def buscar_dump(carpeta: Path | None) -> Path:
    """El .dump más nuevo. Busca donde el backup de la PC los deja."""
    candidatas = [carpeta] if carpeta else []
    if not carpeta:
        cfg = Path.home() / ".salon_ivana" / "config.txt"
        if cfg.exists():
            for linea in cfg.read_text(encoding="utf-8-sig").splitlines():
                if linea.strip().startswith("CARPETA_DESTINO="):
                    candidatas.append(Path(linea.split("=", 1)[1].strip()))
        candidatas += [Path.home() / "OneDrive" / "Backups" / "salon_ivana", Path(".")]

    dumps = []
    for c in candidatas:
        if c and c.is_dir():
            dumps += list(c.glob("salon_ivana_*.dump"))
    if not dumps:
        sys.exit("No encontré ningún salon_ivana_*.dump. Pasá la carpeta con --carpeta.")
    return max(dumps, key=lambda p: p.stat().st_mtime)


def desde_dump(a) -> str:
    """El camino con PostgreSQL: recrea la base local y le mete el .dump."""
    servidor = os.getenv("POSTGRES_LOCAL", "postgresql://postgres:postgres@127.0.0.1:5432")
    if not es_local(servidor):
        sys.exit(f"POSTGRES_LOCAL apunta a {urlparse(servidor).hostname}, que no es local.\n"
                 f"Este script BORRA la base de destino: solo trabaja contra 127.0.0.1.")

    dump = a.dump if a.dump else buscar_dump(a.carpeta)
    if not dump.exists():
        sys.exit(f"No existe {dump}")
    url_base = f"{servidor.rstrip('/')}/{a.base or 'salon_local'}"

    print(f"Backup:  {dump.name}  ({dump.stat().st_size // 1024} KB)")
    print(f"Destino: {url_base}\n")

    apuntar_la_app_a(url_base)
    psql, pg_restore = buscar_binario("psql"), buscar_binario("pg_restore")
    revisar_dependencias(a)

    print("Recreando la base local...")
    admin = f"{servidor.rstrip('/')}/postgres"
    nombre = a.base or "salon_local"
    for sql in (f'DROP DATABASE IF EXISTS "{nombre}"', f'CREATE DATABASE "{nombre}"'):
        correr([psql, admin, "-q", "-c", sql])

    print("Restaurando...")
    # pg_restore avisa de cosas menores con exit code 1 aunque haya restaurado
    # bien, así que acá no se corta: lo que decide es el conteo de abajo.
    subprocess.run([pg_restore, "--dbname", url_base, "--no-owner",
                    "--no-privileges", str(dump)], capture_output=True, text=True)
    return url_base


def desde_json(a) -> str:
    """El camino sin PostgreSQL: el backup de /api/backup entra en un SQLite.

    SQLite viene adentro de Python, así que en una PC donde no se puede instalar
    nada esto es lo único que hay. La app ya corre contra SQLite cuando no hay
    DATABASE_URL: es lo mismo que se usa para desarrollar.
    """
    if not a.json.exists():
        sys.exit(f"No existe {a.json}")
    archivo = Path(a.base or "pelu.db")
    url = f"sqlite:///{archivo.as_posix()}"
    print(f"Backup:  {a.json.name}  ({a.json.stat().st_size // 1024} KB)")
    print(f"Destino: {archivo}  (SQLite, sin PostgreSQL)\n")
    revisar_dependencias(a)

    # El archivo se borra y se hace de nuevo, no se vacía: uno de una versión
    # anterior tiene las tablas con menos columnas, y `create_all` crea las que
    # falten enteras pero no le agrega una columna a una tabla que ya está. Con
    # vaciarlo, la restauración muere a mitad de camino con un "table empleados
    # has no column named valor_hora". Y no se pierde nada: acá lo que vale es
    # el backup, no lo que hubiera en la copia.
    if archivo.exists():
        print(f"Esto BORRA {archivo} y lo hace de nuevo con el backup.")
        if input("Escribí BORRAR para seguir: ").strip() != "BORRAR":
            sys.exit("Cancelado, no se tocó nada.")
        archivo.unlink()
        print()

    apuntar_la_app_a(url)
    import restaurar_backup
    restaurar_backup.restaurar(str(a.json), url)
    return url


# Los backups salen así de la app y así los tapa el .gitignore. El script no
# escribe uno con otro nombre adentro del repo: adentro hay DNI, teléfonos y
# direcciones de las clientas, y el repositorio es público.
PREFIJO_BACKUP = "backup_pelu_"


def donde_escribir(salida: Path) -> Path:
    """Resuelve el archivo de salida y se niega a dejar uno suelto en el repo."""
    from datetime import datetime
    if not salida.name:
        salida = Path(f"{PREFIJO_BACKUP}{datetime.now().strftime('%Y%m%d_%H%M')}.json")
    repo = Path(__file__).resolve().parent
    adentro = salida.resolve().parent == repo
    if adentro and not salida.name.startswith(PREFIJO_BACKUP):
        sys.exit(f"'{salida.name}' en la carpeta del repo no lo tapa el .gitignore, y este "
                 f"archivo tiene los datos de las clientas.\n"
                 f"Ponele un nombre que empiece con {PREFIJO_BACKUP}, o guardalo afuera:\n"
                 f"  --a-json                     -> {PREFIJO_BACKUP}<fecha>.json\n"
                 f"  --a-json ..\\{salida.name}")
    return salida


def escribir_json(salida: Path):
    """Pasa la base local a un backup JSON, que es lo que se puede llevar.

    Un .dump solo lo abre pg_restore, así que en una PC donde no se puede
    instalar PostgreSQL no vale nada. El JSON lo lee cualquier Python.
    """
    import json
    import main                      # importarlo corre migrar() sobre la copia
    from database import SessionLocal
    db = SessionLocal()
    try:
        datos = main.armar_backup(db)
    finally:
        db.close()
    salida.write_text(json.dumps(datos, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Backup JSON:  {salida}  ({salida.stat().st_size // 1024} KB)")
    print(f"Copialo a la otra PC y levantala con:\n"
          f"  python levantar_local.py --json {salida.name}\n")


def apuntar_la_app_a(url: str):
    """Deja la copia como base de la app, y tiene que correr ANTES de importarla.

    `database.py` lee DATABASE_URL una sola vez, cuando se lo importa, y a partir
    de ahí el motor ya está armado. Cualquier `import models` anterior a esto
    —el de restaurar_backup, sin ir más lejos— deja la app apuntando al SQLite
    de desarrollo, y lo que se exporte después sale de ahí y no de la copia.
    """
    os.environ["DATABASE_URL"] = url


def revisar_dependencias(a):
    """Todo lo que puede faltar se comprueba ANTES de tocar la base.

    Con un requirements sin instalar, el paso destructivo ya corrió y el que
    avisa del problema viene después: te quedás sin la copia local y sin la app.
    """
    if a.solo_restaurar:
        return
    faltan = [m for m in ("uvicorn", "fastapi") if importlib.util.find_spec(m) is None]
    if faltan:
        sys.exit(f"Falta instalar: {', '.join(faltan)}.\n"
                 f"  pip install -r requirements.txt\n"
                 f"(o corré con --solo-restaurar si solo querés la base)")


def main():
    ap = argparse.ArgumentParser(description="Levanta la app local con el último backup.")
    ap.add_argument("--dump", type=Path, help="el .dump a restaurar (necesita PostgreSQL)")
    ap.add_argument("--json", type=Path,
                    help="el .json de /api/backup, para restaurar en SQLite SIN PostgreSQL")
    ap.add_argument("--carpeta", type=Path, help="dónde buscar el .dump más nuevo")
    ap.add_argument("--base", help="dónde va la copia: nombre de la base con --dump "
                                   "(salon_local), archivo con --json (pelu.db)")
    ap.add_argument("--a-json", type=Path, metavar="RUTA", nargs="?", const=Path(""),
                    help="escribe el backup en JSON y no levanta el servidor: es el "
                         "formato que se puede llevar a una PC sin PostgreSQL. Sin ruta, "
                         "usa el mismo nombre que la app: backup_pelu_<fecha>.json")
    ap.add_argument("--puerto", type=int, default=8000)
    ap.add_argument("--solo-restaurar", action="store_true")
    a = ap.parse_args()

    if a.json and a.dump:
        sys.exit("--dump y --json son dos caminos distintos para lo mismo: pasá uno solo.")
    # Antes de restaurar: si el nombre no sirve, que se entere ahora y no después
    # de veinte minutos de restauración.
    salida_json = donde_escribir(a.a_json) if a.a_json is not None else None

    url_base = desde_json(a) if a.json else desde_dump(a)
    os.environ["DATABASE_URL"] = url_base
    sys.path.insert(0, str(Path(__file__).parent))
    from sqlalchemy import create_engine, func, select
    from sqlalchemy.orm import sessionmaker
    import models, auth

    db = sessionmaker(bind=create_engine(url_base))()
    try:
        comps = db.scalar(select(func.count()).select_from(models.Comprobante.__table__))
        plata = db.scalar(select(func.coalesce(func.sum(models.Pago.monto), 0))) or 0
        clientes = db.scalar(select(func.count()).select_from(models.Cliente.__table__))
        if not comps:
            sys.exit("La base quedó vacía: la restauración falló.")
        print(f"  {comps} comprobantes, {clientes} clientes, ${plata:,} en pagos\n")

        # El backup trae los usuarios de producción y sus contraseñas no las sabe
        # nadie acá, así que sin esto la app queda restaurada y sin forma de entrar.
        u = db.query(models.Usuario).filter_by(usuario=USUARIO_LOCAL).first() or models.Usuario(
            usuario=USUARIO_LOCAL)
        u.salt = auth.nuevo_salt()
        u.hash = auth.hash_password(PASS_LOCAL, u.salt)
        u.rol = "dueno"
        db.add(u)
        db.commit()
        print(f"Usuario para entrar:  {USUARIO_LOCAL} / {PASS_LOCAL}")
        print("(los de producción siguen ahí, pero sus contraseñas no están acá)\n")
    finally:
        db.close()

    if a.a_json is not None:
        escribir_json(salida_json)
        return

    if a.solo_restaurar:
        # Con el SQLite por defecto no hace falta DATABASE_URL: es el que la app
        # usa sola cuando no hay ninguna puesta.
        if url_base == "sqlite:///pelu.db":
            print(f"Listo. Para levantarla:\n  python -m uvicorn main:app --port {a.puerto}")
        else:
            print(f"Listo. Para levantarla, con la base puesta en el entorno:\n"
                  f"  PowerShell:  $env:DATABASE_URL='{url_base}'; "
                  f"python -m uvicorn main:app --port {a.puerto}\n"
                  f"  Linux/Mac:   DATABASE_URL={url_base} "
                  f"python3 -m uvicorn main:app --port {a.puerto}")
        return

    print(f"Servidor en http://127.0.0.1:{a.puerto}   (Ctrl+C para cortar)\n")
    # uvicorn se levanta DENTRO de este proceso, no como hijo. Con un proceso
    # hijo, en Windows el Ctrl+C queda repartido entre los dos y no corta ni uno
    # ni el otro: hay que cerrar la ventana. Con os.execvpe tampoco servía, que
    # en Windows no reemplaza el proceso y devuelve la consola antes de tiempo.
    # Corriéndolo acá adentro hay un solo proceso y el Ctrl+C llega derecho.
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=a.puerto)


if __name__ == "__main__":
    main()
