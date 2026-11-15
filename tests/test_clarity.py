"""El estudio de uso se prende y se apaga con CLARITY_ID, sin tocar código.

Sin la variable /clarity.js tiene que venir vacío: es lo que corre en cada copia
local y lo que queda cuando termina el estudio.
"""
import glob, os
import pytest
from fastapi.testclient import TestClient

from main import app

ID = "k8abc12xyz"


@pytest.fixture
def api():
    return TestClient(app)


def test_sin_la_variable_no_carga_nada(api, monkeypatch):
    monkeypatch.delenv("CLARITY_ID", raising=False)
    r = api.get("/clarity.js")
    assert r.status_code == 200 and r.text == ""
    assert r.headers["content-type"].startswith("text/javascript")
    assert r.headers["cache-control"] == "no-cache"


def test_con_la_variable_carga_clarity_enmascarado(api, monkeypatch):
    monkeypatch.setenv("CLARITY_ID", f" {ID}\n")
    js = api.get("/clarity.js").text
    assert f'"{ID}"' in js and "https://www.clarity.ms/tag/" in js
    assert 'setAttribute("data-clarity-mask","True")' in js


@pytest.mark.parametrize("malo", ["", "abc", 'k8abc12xyz");alert(1);("', "k8abc 12xyz"])
def test_un_id_raro_no_se_mete_en_el_script(api, monkeypatch, malo):
    monkeypatch.setenv("CLARITY_ID", malo)
    assert api.get("/clarity.js").text == ""


def test_lo_carga_cada_pantalla_menos_el_login():
    with open("static/auth.js", encoding="utf-8") as f:
        assert '"/clarity.js"' in f.read()
    for pagina in glob.glob("static/*.html"):
        with open(pagina, encoding="utf-8") as f:
            carga = "/static/auth.js" in f.read()
        assert carga == (os.path.basename(pagina) != "login.html"), pagina


def test_ningun_link_lleva_el_nombre_de_una_clienta():
    # Clarity enmascara la pantalla pero graba la URL tal cual
    import re
    for archivo in glob.glob("static/**/*.*", recursive=True):
        if not archivo.endswith((".html", ".js")):
            continue
        with open(archivo, encoding="utf-8") as f:
            texto = f.read()
        assert not re.search(r"\?[\w&=${}.]*=\$\{encodeURIComponent\([^)]*nombre", texto), archivo
