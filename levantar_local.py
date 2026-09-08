"""Levanta la app en tu PC con una copia del último backup de producción.

Restaura el .dump más nuevo en una base LOCAL, te deja un usuario con una
contraseña que sí sabés, y arranca el servidor.

    python3 levantar_local.py                    # busca el backup más nuevo
    python3 levantar_local.py --dump ruta.dump   # uno en particular
    python3 levantar_local.py --puerto 8001
    python3 levantar_local.py --solo-restaurar   # sin levantar el servidor

La base local se toma de la variable de entorno POSTGRES_LOCAL, o de
postgresql://postgres:postgres@127.0.0.1:5432 si no está.

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


def main():
    ap = argparse.ArgumentParser(description="Levanta la app local con el último backup.")
    ap.add_argument("--dump", type=Path, help="el .dump a restaurar")
    ap.add_argument("--carpeta", type=Path, help="dónde buscar el .dump más nuevo")
    ap.add_argument("--base", default="salon_local", help="nombre de la base local")
    ap.add_argument("--puerto", type=int, default=8000)
    ap.add_argument("--solo-restaurar", action="store_true")
    a = ap.parse_args()

    servidor = os.getenv("POSTGRES_LOCAL", "postgresql://postgres:postgres@127.0.0.1:5432")
    if not es_local(servidor):
        sys.exit(f"POSTGRES_LOCAL apunta a {urlparse(servidor).hostname}, que no es local.\n"
                 f"Este script BORRA la base de destino: solo trabaja contra 127.0.0.1.")

    dump = a.dump or buscar_dump(a.carpeta)
    if not dump.exists():
        sys.exit(f"No existe {dump}")
    url_base = f"{servidor.rstrip('/')}/{a.base}"

    print(f"Backup:  {dump.name}  ({dump.stat().st_size // 1024} KB)")
    print(f"Destino: {url_base}\n")

    psql, pg_restore = buscar_binario("psql"), buscar_binario("pg_restore")

    # Todo lo que puede faltar se comprueba ANTES de borrar la base. Si no, un
    # requirements sin instalar te deja sin la copia local y sin la app: el paso
    # destructivo ya corrió y el que avisa del problema viene después.
    if not a.solo_restaurar:
        faltan = [m for m in ("uvicorn", "fastapi") if importlib.util.find_spec(m) is None]
        if faltan:
            sys.exit(f"Falta instalar: {', '.join(faltan)}.\n"
                     f"  pip install -r requirements.txt\n"
                     f"(o corré con --solo-restaurar si solo querés la base)")

    print("Recreando la base local...")
    admin = f"{servidor.rstrip('/')}/postgres"
    for sql in (f'DROP DATABASE IF EXISTS "{a.base}"', f'CREATE DATABASE "{a.base}"'):
        correr([psql, admin, "-q", "-c", sql])

    print("Restaurando...")
    # pg_restore avisa de cosas menores con exit code 1 aunque haya restaurado
    # bien, así que acá no se corta: lo que decide es el conteo de abajo.
    subprocess.run([pg_restore, "--dbname", url_base, "--no-owner",
                    "--no-privileges", str(dump)], capture_output=True, text=True)

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

        # El dump trae los usuarios de producción y sus contraseñas no las sabe
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

    if a.solo_restaurar:
        print(f"Listo. Para levantarla:\n  DATABASE_URL={url_base} "
              f"python3 -m uvicorn main:app --port {a.puerto}")
        return

    print(f"Servidor en http://127.0.0.1:{a.puerto}   (Ctrl+C para cortar)\n")
    subprocess.run([sys.executable, "-m", "uvicorn", "main:app",
                    "--host", "127.0.0.1", "--port", str(a.puerto)],
                   env={**os.environ, "DATABASE_URL": url_base})


if __name__ == "__main__":
    main()
