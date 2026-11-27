"""Pagar hasta un día, el pago mixto, los adelantos y los productos que se descuentan.

Por HTTP, como test_anulaciones: lo que es solo de la dueña lo frena un
`Depends`, y el código de la empleada también.
"""
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import main
import models
from database import get_db
from main import app, token_sueldo, usuario_actual

DUENO = {"usuario": "ivana", "rol": "dueno"}
EMPLEADO = {"usuario": "local", "rol": "empleado"}


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


def como_ella(emp):
    """La empleada que entró con su código."""
    app.dependency_overrides[usuario_actual] = lambda: EMPLEADO
    app.dependency_overrides[token_sueldo] = lambda: emp.id
    return TestClient(app)


def dias_abiertos(n=2):
    """Los últimos `n` días vividos en los que el local abre, del más viejo al de hoy."""
    f, salida = main.hoy_argentina(), []
    while len(salida) < n:
        if f.weekday() not in main.DIAS_CERRADO: salida.append(f.isoformat())
        f -= timedelta(days=1)
    return salida[::-1]


def carla(db):
    e = models.Empleado(nombre="Carla", activo=True, cobra_sueldo=True, valor_hora=6000)
    db.add(e); db.commit()
    return e


def servicio(db, **mas):
    it = models.Item(categoria="Color", nombre=mas.pop("nombre", "Color raíz"), precio=20000,
                     precio_transfer=22300, activo=True, es_comision=True, comision_pct=40,
                     **{"duracion_min": 60, **mas})
    db.add(it); db.commit()
    return it


def horas(api, emp, fecha, desde, hasta):
    r = api.put("/api/sueldos/horas", json={"empleado_id": emp.id, "fecha": fecha,
                                            "tandas": [{"desde": desde, "hasta": hasta}]})
    assert r.status_code == 200, r.text


def trabajo(api, emp, item, fecha, **mas):
    r = api.post("/api/sueldos/trabajo-suelto", json={"empleado_id": emp.id, "item_id": item.id,
                                                      "fecha": fecha, **mas})
    assert r.status_code == 200, r.text


def pendiente(api, emp, hasta=None):
    return api.get(f"/api/sueldos/pendiente?empleado_id={emp.id}" + (f"&hasta={hasta}" if hasta else "")).json()


def pagar(api, hasta, *pagos):
    return api.post("/api/sueldos/pagar", json={"hasta": hasta, "pagos": list(pagos)})


# --- pagar hasta un día ---

def test_se_paga_hasta_el_dia_y_lo_de_despues_queda(db, api):
    e, it = carla(db), servicio(db)
    ayer, hoy = dias_abiertos()
    for f in (ayer, hoy):
        horas(api, e, f, "10:00", "18:00"); trabajo(api, e, it, f)
    # Cada día: comisión 8000 y 7 h a $6000 = 42000.
    assert pendiente(api, e, ayer)["total"] == 50000
    r = pagar(api, ayer, {"empleado_id": e.id})
    assert r.status_code == 200, r.text
    liq = db.query(models.Liquidacion).one()
    assert (liq.hasta, liq.total, liq.egreso.monto, liq.egreso.privado) == (ayer, 50000, 50000, True)
    quedan = pendiente(api, e)
    assert [d["fecha"] for d in quedan["dias"] if d["minutos"]] == [hoy]
    assert quedan["total"] == 50000


def test_las_horas_de_los_trabajos_se_restan_del_mismo_dia(db, api):
    e = carla(db)
    largo = servicio(db, nombre="Alisado", duracion_min=180)
    ayer, hoy = dias_abiertos()
    horas(api, e, ayer, "10:00", "11:00"); trabajo(api, e, largo, ayer)
    horas(api, e, hoy, "10:00", "14:00")
    # Ayer el trabajo duró más que el día: cero horas, no menos. Hoy, 4 horas enteras.
    assert pendiente(api, e)["minutos_pagados"] == 240


def test_mixto_son_dos_egresos(db, api):
    e, it = carla(db), servicio(db)
    (hoy,) = dias_abiertos(1)
    horas(api, e, hoy, "10:00", "18:00"); trabajo(api, e, it, hoy)
    assert pagar(api, hoy, {"empleado_id": e.id, "forma_pago": "Mixto", "efectivo": 60000}).status_code == 400
    r = pagar(api, hoy, {"empleado_id": e.id, "forma_pago": "Mixto", "efectivo": 20000})
    assert r.status_code == 200, r.text
    assert sorted((x.forma_pago, x.monto) for x in db.query(models.Egreso)) == [
        ("Efectivo", 20000), ("Transferencia", 30000)]
    assert api.get("/api/sueldos/liquidaciones").json()[0]["forma_pago"] == "Mixto"


def test_un_dia_con_trabajos_y_sin_horario_frena(db, api):
    e, it = carla(db), servicio(db)
    (hoy,) = dias_abiertos(1)
    trabajo(api, e, it, hoy)
    r = pagar(api, hoy, {"empleado_id": e.id})
    assert r.status_code == 400 and "falta el horario" in r.json()["detail"]


def test_pagar_es_de_la_duena(db, api):
    e, it = carla(db), servicio(db)
    (hoy,) = dias_abiertos(1)
    horas(api, e, hoy, "10:00", "18:00")
    assert pagar(como_ella(e), hoy, {"empleado_id": e.id}).status_code == 403


# --- adelantos ---

def test_el_adelanto_sale_de_la_caja_y_se_descuenta(db, api):
    e, it = carla(db), servicio(db)
    (hoy,) = dias_abiertos(1)
    horas(api, e, hoy, "10:00", "18:00"); trabajo(api, e, it, hoy)
    r = como_ella(e).post("/api/sueldos/adelanto", json={"empleado_id": e.id, "monto": 15000})
    assert r.status_code == 200, r.text
    eg = db.query(models.Egreso).one()
    # Lo dio el empleado: si fuera privado, su arqueo pediría plata que no ve salir.
    assert (eg.monto, eg.forma_pago, eg.privado) == (15000, "Efectivo", False)
    app.dependency_overrides[usuario_actual] = lambda: DUENO
    assert pendiente(api, e)["total"] == 50000 - 15000
    assert pagar(api, hoy, {"empleado_id": e.id}).status_code == 200
    liq = db.query(models.Liquidacion).one()
    assert (liq.descuentos, liq.total) == (15000, 35000)
    assert db.query(models.MovimientoSueldo).one().liquidacion_id == liq.id


def test_si_los_adelantos_cubren_todo_no_se_paga(db, api):
    e, it = carla(db), servicio(db)
    (hoy,) = dias_abiertos(1)
    horas(api, e, hoy, "10:00", "11:00")
    api.post("/api/sueldos/adelanto", json={"empleado_id": e.id, "monto": 20000})
    r = pagar(api, hoy, {"empleado_id": e.id})
    assert r.status_code == 400 and "cubren" in r.json()["detail"]


def test_un_adelanto_reintentado_no_sale_dos_veces(db, api):
    e = carla(db)
    pedido = {"empleado_id": e.id, "monto": 10000, "clave": "adelanto-1"}
    a, b = api.post("/api/sueldos/adelanto", json=pedido), api.post("/api/sueldos/adelanto", json=pedido)
    assert a.json()["id"] == b.json()["id"]
    assert db.query(models.Egreso).count() == 1
    assert api.post("/api/sueldos/adelanto", json={**pedido, "monto": 12000}).status_code == 409


def test_anular_un_adelanto_devuelve_la_plata(db, api):
    e = carla(db)
    m = api.post("/api/sueldos/adelanto", json={"empleado_id": e.id, "monto": 10000,
                                                "forma_pago": "Mixto", "efectivo": 4000}).json()
    assert db.query(models.Egreso).count() == 2
    eg = db.query(models.Egreso).first()
    assert api.delete(f"/api/egresos/{eg.id}").status_code == 409     # desde Caja no
    assert api.delete(f"/api/sueldos/movimientos/{m['id']}").status_code == 400   # sin motivo
    assert api.delete(f"/api/sueldos/movimientos/{m['id']}?motivo=Se arrepintió").status_code == 200
    assert db.query(models.Egreso).count() == 0
    assert pendiente(api, e)["descuentos"] == 0


def test_la_empleada_no_anula_uno_de_ayer(db, api):
    e = carla(db)
    m = api.post("/api/sueldos/adelanto", json={"empleado_id": e.id, "monto": 10000}).json()
    db.get(models.MovimientoSueldo, m["id"]).fecha = (main.hoy_argentina() - timedelta(days=1)).isoformat()
    db.commit()
    r = como_ella(e).delete(f"/api/sueldos/movimientos/{m['id']}?motivo=Me equivoqué")
    assert r.status_code == 403


# --- productos ---

def test_el_producto_sale_del_stock_y_vuelve_al_anularlo(db, api):
    e = carla(db)
    p = models.Item(categoria="Productos", nombre="Shampoo", precio=18500, precio_transfer=20600,
                    activo=True, es_producto=True, stock_actual=5)
    db.add(p); db.commit()
    r = como_ella(e).post("/api/sueldos/producto", json={"empleado_id": e.id, "item_id": p.id,
                                                         "cantidad": 2, "precio": 15000})
    assert r.status_code == 200, r.text
    db.expire_all()
    assert p.stock_actual == 3
    assert (r.json()["monto"], r.json()["precio_lista"]) == (30000, 18500)
    assert db.query(models.Egreso).count() == 0          # no sale plata: se descuenta
    assert como_ella(e).delete(f"/api/sueldos/movimientos/{r.json()['id']}?motivo=Lo devolvió").status_code == 200
    db.expire_all()
    assert p.stock_actual == 5
