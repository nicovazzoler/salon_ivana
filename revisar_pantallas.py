#!/usr/bin/env python3
"""Busca, leyendo el código, cosas de las pantallas que están rotas y no se ven:
un botón que no está conectado a nada, un id que el JS busca y no existe, un
link a una ruta que no existe.

    python3 revisar_pantallas.py

Solo LEE e imprime. Lo que no se puede saber leyendo —un id repetido de verdad,
algo escondido que igual se ve, un error de consola— lo mira revisar_pantallas.js,
que abre las pantallas en un navegador.
"""
import re, pathlib

RAIZ = pathlib.Path(__file__).parent
EST = RAIZ / "static"

def texto(p: pathlib.Path) -> str:
    return p.read_text(encoding="utf-8") if p.exists() else ""

def todo_lo_que_ve(html: str) -> str:
    """El HTML de la pantalla más cada .js que carga: donde puede estar el id."""
    js = [EST / s.replace("/static/", "") for s in re.findall(r'<script src="([^"]+)"', html)]
    return html + "".join(texto(j) for j in js)

RUTAS = set(re.findall(r'@app\.get\("(/[^"{]*)"', texto(RAIZ / "main.py")))

def existe(ident: str, fuente: str) -> bool:
    """Si ese id se declara en algún lado: en el HTML, adentro de un innerHTML,
    con `elemento.id = "..."` o en un objeto, como hace Object.assign."""
    return (f'id="{ident}"' in fuente or f"id='{ident}'" in fuente
            or re.search(rf'\.id\s*=\s*["\']{re.escape(ident)}["\']', fuente) is not None
            or re.search(rf'\bid\s*:\s*["\']{re.escape(ident)}["\']', fuente) is not None)

hallazgos = []
for html in sorted(EST.glob("*.html")):
    txt = texto(html)
    fuente = todo_lo_que_ve(txt)

    # Un botón con id que nadie busca y sin onclick propio no hace nada.
    for m in re.finditer(r'<button[^>]*\bid="([^"$]+)"[^>]*>(.*?)</button>', txt, re.S):
        bid, rotulo = m.group(1), re.sub(r"<[^>]+>|\s+", " ", m.group(2)).strip()
        if "onclick" in m.group(0): continue
        # El `id="btnX"` del propio HTML no cuenta como que alguien lo busca.
        if re.search(rf'(?<!id=)["\'#]{re.escape(bid)}["\']', fuente): continue
        hallazgos.append((html.name, f'el botón "{rotulo}" (id {bid}) no está conectado a nada'))

    # El JS busca un id que no se declara en ninguna parte: siempre da null.
    buscados = (set(re.findall(r'\$\("#([\w-]+)"\)', fuente))
                | set(re.findall(r'getElementById\("([\w-]+)"\)', fuente))
                | set(re.findall(r'querySelector\("#([\w-]+)"\)', fuente)))
    for i in sorted(buscados):
        if not existe(i, fuente):
            hallazgos.append((html.name, f'el JS busca #{i} y no se declara en ningún lado'))

    # Un link a una ruta que el backend no sirve es un 404 esperando.
    for href in sorted(set(re.findall(r'href="(/[\w-]*)"', txt))):
        if href not in RUTAS and not href.startswith("/static"):
            hallazgos.append((html.name, f'link a "{href}", que no es una ruta del backend'))

print(f"\nLEYENDO EL CÓDIGO — {len(hallazgos)} hallazgo(s)")
print("-" * 74)
for arch, qué in sorted(hallazgos):
    print(f"  {arch:22} {qué}")
if not hallazgos:
    print("  nada")
