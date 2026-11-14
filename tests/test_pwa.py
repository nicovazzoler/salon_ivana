"""La app instalable: que la tablet guarde lo que hay que guardar y nada más.

El service worker baja la lista entera al instalarse y, si UN archivo falla, no
se instala: por eso se pide cada URL de la lista. Y la versión tiene que cambiar
sola cuando cambia algo de static/, o la tablet se queda con lo de antes.
"""
import glob, json, re, struct

import pytest
from fastapi.testclient import TestClient

import pwa
from main import app, PANTALLAS


@pytest.fixture
def api():
    return TestClient(app)


def lista_del_sw(texto):
    return json.loads(re.search(r"const ARCHIVOS = (\[.*?\]);", texto).group(1))


def test_el_sw_se_sirve_desde_la_raiz_y_sin_guardarse(api):
    r = api.get("/sw.js")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/javascript")
    assert r.headers["cache-control"] == "no-cache"
    assert "__VERSION__" not in r.text and "__ARCHIVOS__" not in r.text


def test_todo_lo_de_la_lista_existe(api):
    archivos = lista_del_sw(api.get("/sw.js").text)
    assert set(PANTALLAS) <= set(archivos)
    assert "/static/css/app.css" in archivos and "/static/pwa.js" in archivos
    for url in archivos:
        assert api.get(url).status_code == 200, url


def test_un_archivo_suelto_en_static_no_se_baja(tmp_path):
    (tmp_path / "app.css").write_text("")
    (tmp_path / "backup_viejo.json").write_text("{}")
    (tmp_path / "facturar.html").write_text("")
    assert pwa.archivos_estaticos(str(tmp_path)) == ["/static/app.css"]


def test_la_api_no_se_guarda_nunca(api):
    texto = api.get("/sw.js").text
    assert not [u for u in lista_del_sw(texto) if u.startswith("/api/")]
    assert 'url.pathname.startsWith("/api/")' in texto


def test_la_version_cambia_cuando_cambia_un_archivo(tmp_path):
    (tmp_path / "css").mkdir()
    (tmp_path / "css" / "app.css").write_text("body{color:red}")
    (tmp_path / "sw.js").write_text('const CACHE = "salon-__VERSION__";')
    antes = pwa.version_de(str(tmp_path))
    assert pwa.version_de(str(tmp_path)) == antes

    (tmp_path / "css" / "app.css").write_text("body{color:blue}")
    assert pwa.version_de(str(tmp_path)) != antes


def tamanio_png(ruta):
    with open(ruta, "rb") as f:
        cabecera = f.read(24)
    assert cabecera[:8] == b"\x89PNG\r\n\x1a\n", ruta
    return struct.unpack(">II", cabecera[16:24])


def test_el_manifest_trae_los_iconos_que_dice():
    with open("static/manifest.json", encoding="utf-8") as f:
        m = json.load(f)
    assert m["display"] == "standalone" and m["start_url"] in PANTALLAS
    tamanios = set()
    for icono in m["icons"]:
        ancho, alto = tamanio_png(icono["src"].lstrip("/"))
        assert icono["sizes"] == f"{ancho}x{alto}"
        tamanios.add(ancho)
    assert {192, 512} <= tamanios


@pytest.mark.parametrize("pagina", sorted(glob.glob("static/*.html")))
def test_cada_pantalla_trae_el_manifest_y_el_sw(pagina):
    with open(pagina, encoding="utf-8") as f:
        html = f.read()
    assert '<link rel="manifest" href="/static/manifest.json">' in html
    assert '<script src="/static/pwa.js" defer></script>' in html
    assert 'rel="apple-touch-icon"' in html


def test_cada_pantalla_tiene_su_ruta():
    paginas = {p.split("/")[-1][:-5] for p in glob.glob("static/*.html")}
    assert paginas == set(PANTALLAS.values())
