"""El valor hora es de cada empleada y la comisión de cada servicio, sin generales.

Lo prueba por HTTP, como test_anulaciones: lo que solo puede hacer la dueña lo
frena un `Depends`, y llamando la función derecho el 403 no correría.
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import auth
import main
import models
from database import get_db
from main import app, usuario_actual

DUENO = {"usuario": "ivana", "rol": "dueno"}
EMPLEADO = {"usuario": "local", "rol": "empleado"}


@pytest.fixture
def db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'prueba.db'}",
                           connect_args={"check_same_thread": False})
    models.Base.metadata.create_all(engine)
    sesion = sessionmaker(bind=engine, autoflush=False)()
    app.dependency_overrides[get_db] = lambda: (yield sesion)
    yield sesion
    app.dependency_overrides.clear()
    sesion.close()


def como(rol):
    app.dependency_overrides[usuario_actual] = lambda: rol
    return TestClient(app)


def servicio(db, **mas):
    it = models.Item(categoria="Cortes", nombre=mas.pop("nombre", "Corte"), precio=12000,
                     precio_transfer=13400, activo=True, **mas)
    db.add(it); db.commit()
    return it


def empleada(db, **mas):
    e = models.Empleado(nombre=mas.pop("nombre", "Carla"), activo=True, **mas)
    db.add(e); db.commit()
    return e


# --- la migración: los generales pasan a cada una, sin cambiar ningún número ---

def test_los_generales_pasan_a_cada_empleada_y_a_cada_servicio(db):
    db.add_all([models.Config(clave="valor_hora", valor="7000"),
                models.Config(clave="comision_pct", valor="40")])
    salt = auth.nuevo_salt()
    carla = empleada(db, nombre="Carla", pin_salt=salt, pin_hash=auth.hash_password("1357", salt))
    propia = empleada(db, nombre="Brenda", pin_salt=salt, pin_hash="x", valor_hora=8200)
    ivana = empleada(db, nombre="Ivana")
    general = servicio(db, nombre="Corte", es_comision=True)
    suya = servicio(db, nombre="Claritos", es_comision=True, comision_pct=35)
    sin = servicio(db, nombre="Lavado")
    # Como quedan las filas que ya estaban: la columna nueva llega en NULL.
    db.query(models.Empleado).update({"cobra_sueldo": None}); db.commit()

    main.pasar_generales(db); db.commit(); db.expire_all()

    assert (carla.cobra_sueldo, carla.valor_hora) == (True, 7000)
    assert (propia.cobra_sueldo, propia.valor_hora) == (True, 8200)
    assert (ivana.cobra_sueldo, ivana.valor_hora) == (False, None)
    assert (main.pct_de(general), main.pct_de(suya), main.pct_de(sin)) == (40, 35, 0)


# --- las comisiones las cambia la dueña ---

def test_la_duena_cambia_la_comision_de_varios_juntos(db):
    a, b = servicio(db, nombre="Corte"), servicio(db, nombre="Brushing", es_comision=True, comision_pct=40)
    r = como(DUENO).put("/api/comisiones", json={"ids": [a.id, b.id], "pct": 45})
    assert r.status_code == 200, r.text
    db.expire_all()
    assert (main.pct_de(a), main.pct_de(b)) == (45, 45)
    como(DUENO).put("/api/comisiones", json={"ids": [b.id], "pct": None})
    db.expire_all()
    assert (b.es_comision, b.comision_pct) == (False, None)


def test_el_empleado_no_cambia_comisiones(db):
    it = servicio(db, es_comision=True, comision_pct=40)
    api = como(EMPLEADO)
    assert api.put("/api/comisiones", json={"ids": [it.id], "pct": 50}).status_code == 403
    assert api.put(f"/api/items/{it.id}", json={"comision_pct": 50}).status_code == 403
    # Una pantalla vieja que manda la comisión sin tocarla sí puede cambiar el nombre.
    r = api.put(f"/api/items/{it.id}", json={"nombre": "Corte dama", "es_comision": True, "comision_pct": 40})
    assert r.status_code == 200, r.text
    db.expire_all()
    assert (it.nombre, main.pct_de(it)) == ("Corte dama", 40)


def test_la_depilacion_no_paga_comision(db):
    it = servicio(db, es_depilacion=True)
    assert como(DUENO).put("/api/comisiones", json={"ids": [it.id], "pct": 40}).status_code == 400


# --- valor hora y cobra sueldo ---

def test_sin_cobrar_sueldo_no_hay_valor_hora(db):
    e = empleada(db, cobra_sueldo=True, valor_hora=7000)
    api = como(DUENO)
    assert api.put(f"/api/empleados/{e.id}", json={"cobra_sueldo": False}).status_code == 200
    db.expire_all()
    assert e.valor_hora is None
    assert api.put(f"/api/empleados/{e.id}", json={"valor_hora": 7000}).status_code == 400


def test_la_que_se_agrega_cobra_sueldo(db):
    r = como(DUENO).post("/api/empleados", json={"nombre": "Yamila"})
    assert db.get(models.Empleado, r.json()["id"]).cobra_sueldo is True


# --- códigos ---

def test_el_codigo_lo_ve_solo_la_duena(db):
    empleada(db, cobra_sueldo=True, codigo="1357")
    assert como(DUENO).get("/api/empleados").json()[0]["codigo"] == "1357"
    assert como(EMPLEADO).get("/api/empleados").json()[0]["codigo"] is None


def test_la_que_no_tiene_codigo_lo_elige_y_entra(db):
    e = empleada(db, cobra_sueldo=True)
    api = como(EMPLEADO)
    r = api.post("/api/sueldos/elegir-codigo", json={"empleado_id": e.id, "pin": "2468"})
    assert r.status_code == 200 and r.json()["token"]
    # Ya tiene: no se pisa.
    r = api.post("/api/sueldos/elegir-codigo", json={"empleado_id": e.id, "pin": "1111"})
    assert r.status_code == 409
    assert api.post("/api/sueldos/entrar", json={"empleado_id": e.id, "pin": "2468"}).status_code == 200


def test_el_codigo_viejo_queda_a_la_vista_al_entrar(db):
    salt = auth.nuevo_salt()
    e = empleada(db, cobra_sueldo=True, pin_salt=salt, pin_hash=auth.hash_password("1357", salt))
    r = como(EMPLEADO).post("/api/sueldos/entrar", json={"empleado_id": e.id, "pin": "1357"})
    assert r.status_code == 200
    db.expire_all()
    assert e.codigo == "1357"


def test_la_que_no_cobra_sueldo_no_entra(db):
    e = empleada(db, cobra_sueldo=False, codigo="1357")
    r = como(EMPLEADO).post("/api/sueldos/entrar", json={"empleado_id": e.id, "pin": "1357"})
    assert r.status_code == 403
