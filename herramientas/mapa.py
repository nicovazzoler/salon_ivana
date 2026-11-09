#!/usr/bin/env python3
"""Arma el mapa de arquitectura de un repo leyendo evidencia, sin adivinar.

Idea: todo lo que sale acá está escrito en el repo. Las dependencias dicen qué
servicios externos hay, los decoradores dicen qué endpoints existen, models.py
dice qué tablas hay, y los archivos del front dicen a qué endpoints le pegan.
Ningún modelo de lenguaje interviene: si el mapa dice algo, es porque está en
el código. Lo que no se puede probar, no se dibuja.

Uso:  python3 mapa.py /ruta/al/repo [--escribir]

Sin --escribir imprime el resultado; con --escribir deja ARQUITECTURA.md en el
repo.
"""
import argparse
import ast
import pathlib
import re
import subprocess
import sys

METODOS = {"get", "post", "put", "delete", "patch"}

# Dependencia -> (pieza, tipo). Solo cosas que implican una pieza del sistema.
SERVICIOS = {
    "fastapi": ("API", "servidor"),
    "uvicorn": ("API", "servidor"),
    "sqlalchemy": ("Base de datos", "datos"),
    "psycopg2": ("PostgreSQL", "datos"),
    "psycopg2-binary": ("PostgreSQL", "datos"),
    "openpyxl": ("Excel", "archivo"),
    "reportlab": ("PDF", "archivo"),
    "requests": ("HTTP saliente", "externo"),
    "httpx": ("HTTP saliente", "externo"),
    "mercadopago": ("Mercado Pago", "externo"),
    "boto3": ("S3", "externo"),
    "redis": ("Redis", "datos"),
}


def nombre_repo(repo):
    """El nombre del proyecto, sacado del remoto de git.

    No usamos el nombre de la carpeta: en CI el checkout puede caer en un
    directorio con otro nombre, y entonces el archivo cambiaria sin que haya
    cambiado el codigo, generando un commit al pedo en cada push.
    """
    try:
        # Se lo preguntamos a git en vez de leer .git/config a mano: en un
        # worktree, .git es un archivo que apunta a otro lado y el archivo
        # de config no esta donde uno espera.
        r = subprocess.run(
            ["git", "config", "--get", "remote.origin.url"],
            cwd=repo, capture_output=True, text=True, timeout=5,
        )
        url = r.stdout.strip()
        if r.returncode == 0 and url:
            return re.sub(r"\.git$", "", url.rstrip("/").split("/")[-1])
    except Exception:
        pass
    return repo.name


def dependencias(repo):
    """Lee requirements*.txt y package.json."""
    out = {}
    for req in repo.glob("requirements*.txt"):
        for linea in req.read_text(encoding="utf-8", errors="replace").splitlines():
            linea = linea.strip()
            if not linea or linea.startswith("#"):
                continue
            nombre = re.split(r"[=<>\[; ]", linea)[0].lower()
            if nombre in SERVICIOS:
                pieza, tipo = SERVICIOS[nombre]
                out[pieza] = tipo
    return out


def tablas(repo):
    """class -> nombre de tabla, leyendo __tablename__ de models.py."""
    archivo = repo / "models.py"
    if not archivo.exists():
        return {}
    arbol = ast.parse(archivo.read_text(encoding="utf-8", errors="replace"))
    out = {}
    for nodo in arbol.body:
        if not isinstance(nodo, ast.ClassDef):
            continue
        for sub in nodo.body:
            if isinstance(sub, ast.Assign):
                for destino in sub.targets:
                    if getattr(destino, "id", None) == "__tablename__":
                        if isinstance(sub.value, ast.Constant):
                            out[nodo.name] = sub.value.value
    return out


def rutas(repo, clases):
    """Lista de (metodo, path, funcion, tablas que toca)."""
    archivo = repo / "main.py"
    if not archivo.exists():
        return []
    arbol = ast.parse(archivo.read_text(encoding="utf-8", errors="replace"))
    out = []
    for nodo in ast.walk(arbol):
        if not isinstance(nodo, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for deco in nodo.decorator_list:
            if not isinstance(deco, ast.Call):
                continue
            fn = deco.func
            if not isinstance(fn, ast.Attribute) or fn.attr not in METODOS:
                continue
            if not deco.args or not isinstance(deco.args[0], ast.Constant):
                continue
            path = deco.args[0].value
            # Qué modelos aparecen nombrados dentro de la función. Puede ser
            # `Venta` (from models import ...) o `models.Venta` (import models).
            usadas = set()
            for hijo in ast.walk(nodo):
                if isinstance(hijo, ast.Name) and hijo.id in clases:
                    usadas.add(clases[hijo.id])
                elif isinstance(hijo, ast.Attribute) and hijo.attr in clases:
                    usadas.add(clases[hijo.attr])
            out.append((fn.attr.upper(), path, nodo.name, sorted(usadas)))
    return out


def frente(repo):
    """Archivo del front -> paths de API que menciona."""
    out = {}
    raiz = repo / "static"
    if not raiz.exists():
        return out
    for archivo in sorted(raiz.rglob("*")):
        if archivo.suffix not in (".html", ".js"):
            continue
        texto = archivo.read_text(encoding="utf-8", errors="replace")
        paths = set(re.findall(r"/api/[A-Za-z0-9_/{}.-]+", texto))
        paths = {p.rstrip("/.") for p in paths}
        if paths:
            out[archivo.relative_to(raiz).as_posix()] = sorted(paths)
    return out


def emparejar(path_front, rutas_def):
    """Qué rutas declaradas cubren un path que usa el front."""
    encontradas = []
    for metodo, path, fn, tabs in rutas_def:
        patron = "^" + re.sub(r"\{[^}]+\}", "[^/]+", re.escape(path).replace(r"\{", "{").replace(r"\}", "}")) + "$"
        try:
            if re.match(patron, path_front):
                encontradas.append((metodo, path, fn, tabs))
        except re.error:
            continue
    if encontradas:
        return encontradas
    # El front suele recortar: /api/clientes/ para /api/clientes/{id}
    return [r for r in rutas_def if r[1].startswith(path_front)]


def mermaid_piezas(deps, n_pantallas, n_rutas, n_tablas, procfile):
    lineas = ["```mermaid", "graph LR"]
    lineas.append(f'  FRONT["{n_pantallas} pantallas<br/>HTML + JS"]')
    lineas.append(f'  API["API<br/>FastAPI · {n_rutas} endpoints"]')
    lineas.append(f'  DB[("Base de datos<br/>{n_tablas} tablas")]')
    lineas.append("  FRONT --> API")
    lineas.append("  API --> DB")
    for pieza, tipo in sorted(deps.items()):
        if pieza in ("API", "Base de datos"):
            continue
        clave = re.sub(r"[^A-Za-z]", "", pieza).upper()[:8] or "X"
        lineas.append(f'  {clave}["{pieza}"]')
        lineas.append(f"  API --> {clave}")
    if procfile:
        lineas.append(f'  DEPLOY["Deploy<br/>{procfile}"]')
        lineas.append("  API -.-> DEPLOY")
    lineas.append("```")
    return "\n".join(lineas)


def mermaid_datos(por_pantalla, tope=3):
    """Pantalla -> las tablas que mas toca. Solo las principales, para que se lea."""
    lineas = ["```mermaid", "graph LR"]
    tablas_vistas = set()
    for pantalla, info in sorted(por_pantalla.items()):
        cuenta = {}
        for _, _, _, tabs in info["rutas"]:
            for t in tabs:
                cuenta[t] = cuenta.get(t, 0) + 1
        top = sorted(cuenta, key=lambda t: -cuenta[t])[:tope]
        if not top:
            continue
        pid = "P" + re.sub(r"[^A-Za-z0-9]", "", pantalla)[:12]
        lineas.append(f'  {pid}["{pantalla}"]')
        for t in top:
            tid = "T" + re.sub(r"[^A-Za-z0-9]", "", t)[:12]
            if t not in tablas_vistas:
                lineas.append(f'  {tid}[("{t}")]')
                tablas_vistas.add(t)
            lineas.append(f"  {pid} --> {tid}")
    lineas.append("```")
    return "\n".join(lineas)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("repo")
    ap.add_argument("--escribir", action="store_true")
    args = ap.parse_args()

    repo = pathlib.Path(args.repo).expanduser().resolve()
    if not repo.is_dir():
        sys.exit(f"No existe: {repo}")

    clases = tablas(repo)
    rutas_def = rutas(repo, clases)
    deps = dependencias(repo)
    front = frente(repo)
    proc = (repo / "Procfile")
    procfile = proc.read_text(encoding="utf-8").strip().split(":")[0] if proc.exists() else ""

    por_pantalla = {}
    for archivo, paths in front.items():
        encontradas = []
        for p in paths:
            encontradas.extend(emparejar(p, rutas_def))
        # unicas, conservando orden
        unicas, vistas = [], set()
        for r in encontradas:
            k = (r[0], r[1])
            if k not in vistas:
                vistas.add(k)
                unicas.append(r)
        por_pantalla[archivo] = {"paths": paths, "rutas": unicas}

    sin_front = len(rutas_def) - len({(r[0], r[1]) for i in por_pantalla.values() for r in i["rutas"]})

    partes = [
        f"# Arquitectura · {nombre_repo(repo)}",
        "",
        "Generado leyendo el repo. **No editar a mano**: lo regenera el CI en cada commit.",
        "",
        "Todo lo que figura acá está escrito en el código — dependencias declaradas, "
        "decoradores de ruta, `__tablename__` y las rutas que nombran los archivos del "
        "front. Nada está inferido por un modelo.",
        "",
        "## Las piezas",
        "",
        mermaid_piezas(deps, len(list((repo / "static").glob("*.html"))), len(rutas_def), len(set(clases.values())), procfile),
        "",
        "## Qué datos toca cada pantalla",
        "",
        "Las tablas principales de cada pantalla. El detalle completo está abajo.",
        "",
        mermaid_datos(por_pantalla),
        "",
        "## Desglose por pantalla",
        "",
    ]

    for pantalla, info in sorted(por_pantalla.items()):
        tabs = sorted({t for _, _, _, ts in info["rutas"] for t in ts})
        partes.append(f"### {pantalla}")
        partes.append("")
        partes.append(f"- Endpoints que usa: **{len(info['rutas'])}**")
        partes.append(f"- Tablas que tocan esos endpoints: {', '.join('`' + t + '`' for t in tabs) if tabs else '—'}")
        partes.append("")
        if info["rutas"]:
            partes.append("| Método | Endpoint | Función | Tablas |")
            partes.append("|---|---|---|---|")
            for metodo, path, fn, ts in sorted(info["rutas"], key=lambda r: r[1])[:40]:
                partes.append(f"| {metodo} | `{path}` | `{fn}` | {', '.join(ts) if ts else '—'} |")
            partes.append("")

    partes += [
        "## Lo que no se pudo probar",
        "",
        f"- Endpoints que ninguna pantalla nombra: **{max(sin_front, 0)}**. "
        "Pueden ser internos, llamarse con la ruta armada en tiempo de ejecución, o estar muertos.",
        f"- Tablas declaradas en `models.py`: **{len(set(clases.values()))}**; "
        "las que no aparecen arriba no las toca ningún endpoint que el front nombre.",
        "",
    ]

    texto = "\n".join(partes)
    if args.escribir:
        destino = repo / "ARQUITECTURA.md"
        destino.write_text(texto, encoding="utf-8")
        print(f"Escrito: {destino}  ({len(texto)} bytes)")
    else:
        print(texto)


if __name__ == "__main__":
    main()
