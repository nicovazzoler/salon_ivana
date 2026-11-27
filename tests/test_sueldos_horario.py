"""El horario del día en tandas y la duración de cada servicio en el catálogo.

Por HTTP, como test_sueldos_valores: los permisos y la validación viven en el
endpoint.
"""
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import main
import models
from database import get_db
from main import app, usuario_actual

DUENO = {"usuario": "ivana", "rol": "dueno"}


@pytest.fixture
def db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'prueba.db'}",
                           connect_args={"check_same_thread": False})
    models.Base.metadata.create_all(engine)
    sesion = sessionmaker(bind=engine, autoflush=False)()
    app.dependency_overrides[get_db] = lambda: (yield sesion)
    app.dependency_overrides[usuario_actual] = lambda: DUENO
    yield sesion
    app.dependency_overrides.clear()
    sesion.close()


@pytest.fixture
def api(db):
    return TestClient(app)


def carla(db):
    e = models.Empleado(nombre="Carla", activo=True, cobra_sueldo=True, valor_hora=6000)
    db.add(e); db.commit()
    return e


def dia_abierto():
    """Un día ya vivido en el que el local abre, para que el resumen lo dibuje."""
    f = main.hoy_argentina()
    while f.weekday() in main.DIAS_CERRADO: f -= timedelta(days=1)
    return f.isoformat()


def el_dia(api, emp, fecha):
    r = api.get(f"/api/sueldos/pendiente?empleado_id={emp.id}").json()
    return next(d for c in r["ciclos"] for d in c["dias"] if d["fecha"] == fecha)


def test_las_tandas_dan_los_minutos(db, api):
    e, f = carla(db), dia_abierto()
    r = api.put("/api/sueldos/horas", json={"empleado_id": e.id, "fecha": f, "tandas": [
        {"desde": "10:00", "hasta": "13:30"}, {"desde": "14:30", "hasta": "19:00"}]})
    assert r.status_code == 200, r.text
    d = el_dia(api, e, f)
    assert d["minutos"] == 8 * 60
    assert d["tandas"] == [["10:00", "13:30"], ["14:30", "19:00"]]


@pytest.mark.parametrize("tandas", [
    [{"desde": "10:00", "hasta": "14:00"}, {"desde": "13:00", "hasta": "18:00"}],
    [{"desde": "14:00", "hasta": "10:00"}],
    [{"desde": "8:00", "hasta": "9:00"}, {"desde": "10:00", "hasta": "11:00"}, {"desde": "12:00", "hasta": "13:00"}],
])
def test_un_horario_que_no_cierra_se_rebota(db, api, tandas):
    e = carla(db)
    r = api.put("/api/sueldos/horas", json={"empleado_id": e.id, "fecha": dia_abierto(), "tandas": tandas})
    assert r.status_code == 400


def test_sin_tandas_es_que_no_vino(db, api):
    e, f = carla(db), dia_abierto()
    api.put("/api/sueldos/horas", json={"empleado_id": e.id, "fecha": f,
                                         "tandas": [{"desde": "10:00", "hasta": "18:00"}]})
    api.put("/api/sueldos/horas", json={"empleado_id": e.id, "fecha": f, "tandas": []})
    assert db.query(models.HoraTrabajada).count() == 0


def test_un_dia_sin_horas_trae_el_horario_de_la_agenda(db, api):
    e, f = carla(db), dia_abierto()
    dow = main.date.fromisoformat(f).weekday()
    db.add_all([models.HorarioEmpleado(empleado_id=e.id, dia_semana=dow, desde="14:30", hasta="19:00"),
                models.HorarioEmpleado(empleado_id=e.id, dia_semana=dow, desde="10:00", hasta="13:30")])
    db.commit()
    assert el_dia(api, e, f)["sugerido"] == [["10:00", "13:30"], ["14:30", "19:00"]]


def test_el_trabajo_toma_la_duracion_del_catalogo(db, api):
    e, f = carla(db), dia_abierto()
    it = models.Item(categoria="Color", nombre="Color raíz", precio=28000, precio_transfer=31200,
                     activo=True, es_comision=True, comision_pct=40, duracion_min=90)
    db.add(it); db.commit()
    r = api.post("/api/sueldos/trabajo-suelto", json={"empleado_id": e.id, "item_id": it.id,
                                                      "fecha": f, "cantidad": 2})
    assert r.status_code == 200, r.text
    t = el_dia(api, e, f)["trabajos"][0]
    assert (t["minutos"], t["minutos_propios"], t["duracion_catalogo"]) == (180, False, 180)

    # Cambiar el catálogo mueve lo pendiente; lo que se cerró queda con su número.
    api.put(f"/api/items/{it.id}", json={"duracion_min": 60})
    assert el_dia(api, e, f)["trabajos"][0]["minutos"] == 120
    api.put("/api/sueldos/horas", json={"empleado_id": e.id, "fecha": f,
                                         "tandas": [{"desde": "10:00", "hasta": "18:00"}]})
    assert api.post("/api/sueldos/cerrar", json={"empleado_id": e.id}).status_code == 200
    api.put(f"/api/items/{it.id}", json={"duracion_min": 30})
    db.expire_all()
    assert db.query(models.TrabajoComision).one().minutos == 120


def test_sin_duracion_en_ningun_lado_no_se_carga(db, api):
    e = carla(db)
    it = models.Item(categoria="Color", nombre="Alisado", precio=95000, precio_transfer=105600,
                     activo=True, es_comision=True, comision_pct=40)
    db.add(it); db.commit()
    r = api.post("/api/sueldos/trabajo-suelto", json={"empleado_id": e.id, "item_id": it.id,
                                                      "fecha": dia_abierto()})
    assert r.status_code == 400
