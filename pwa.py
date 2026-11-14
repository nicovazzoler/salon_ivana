"""La app instalable: qué archivos guarda la tablet y con qué versión."""
import hashlib, json, os

MOLDE_SW = "sw.js"
# Lo que guarda la tablet va por tipo: un archivo suelto en static/ —un backup,
# algo de prueba— no se baja solo.
SE_GUARDAN = (".css", ".js", ".svg", ".png", ".woff2")


def archivos_estaticos(carpeta: str) -> list[str]:
    """Las URLs de lo que guarda la tablet. Las páginas van por su ruta, no acá."""
    urls = []
    for raiz, _, nombres in os.walk(carpeta):
        for n in nombres:
            rel = os.path.relpath(os.path.join(raiz, n), carpeta).replace(os.sep, "/")
            if rel == MOLDE_SW or not (rel.endswith(SE_GUARDAN) or rel == "manifest.json"):
                continue
            urls.append("/static/" + rel)
    return sorted(urls)


def version_de(carpeta: str) -> str:
    """Un hash de TODO lo que hay en static/: cambia una coma, cambia la versión.

    Un deploy que solo toca el backend da la misma y la tablet no baja nada.
    """
    h = hashlib.sha256()
    for raiz, dirs, nombres in os.walk(carpeta):
        dirs.sort()
        for n in sorted(nombres):
            ruta = os.path.join(raiz, n)
            h.update(os.path.relpath(ruta, carpeta).replace(os.sep, "/").encode() + b"\0")
            with open(ruta, "rb") as f:
                h.update(f.read() + b"\0")
    return h.hexdigest()[:12]


def armar_sw(carpeta: str, pantallas: list[str]) -> str:
    """El service worker con la versión y la lista de archivos ya escritas adentro."""
    with open(os.path.join(carpeta, MOLDE_SW), encoding="utf-8") as f:
        molde = f.read()
    archivos = list(dict.fromkeys(pantallas)) + archivos_estaticos(carpeta)
    return (molde.replace("__VERSION__", version_de(carpeta))
                 .replace("__ARCHIVOS__", json.dumps(archivos)))
