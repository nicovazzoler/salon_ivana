"""El reparto de una sesión de depilación cuenta la plata que entró.

El ticket se cuenta en su lista, pero la seña entra con lo que trajo: una seña
por transferencia en un ticket en efectivo no tuvo el 10% menos. Se mide con un
trabajo de $17.000 de lista ($15.300 en efectivo) y $7.000 de seña.
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import main
import models
from database import get_db
from main import app, usuario_actual


@pytest.fixture
def db(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'prueba.db'}",
                           connect_args={"check_same_thread": False})
    models.Base.metadata.create_all(engine)
    sesion = sessionmaker(bind=engine, autoflush=False)()
    app.dependency_overrides[get_db] = lambda: (yield sesion)
    app.dependency_overrides[usuario_actual] = lambda: {"usuario": "ivana", "rol": "dueno"}
    for nombre in ("Efectivo", "Transferencia"):
        sesion.add(models.FormaPago(nombre=nombre, activo=True))
    sesion.commit()
    yield sesion
    app.dependency_overrides.clear()
    sesion.close()


@pytest.fixture
def api(db):
    return TestClient(app)


def preparar(db, **sesion):
    emp = models.Empleado(nombre="Carolina", activo=True)
    item = models.Item(categoria="Depilación", nombre="2 zonas", precio=15300,
                       precio_transfer=17000, es_depilacion=True, activo=True)
    cli = models.Cliente(nombre="Gonzalo", activo=True)
    db.add_all([emp, item, cli]); db.flush()
    ses = models.SesionDepilacion(numero=1, empleado_id=emp.id, **sesion)
    db.add(ses); db.commit()
    return ses, item, cli


def cobrar(api, item, cli, forma_sena, forma_cuenta):
    r = api.post("/api/senas", json={"cliente_id": cli.id, "valor": 7000, "forma_pago": forma_sena})
    assert r.status_code == 200, r.text
    r = api.post("/api/comprobantes", json={
        "tipo": "ticket", "cliente_id": cli.id, "forma_pago": forma_cuenta,
        "lineas": [{"item_id": item.id, "cantidad": 1}], "aplicar_senas": True, "cobrar": True})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.mark.parametrize("forma_sena, forma_cuenta, entro", [
    ("Transferencia", "efectivo", 16000),   # 7.000 sin descuento + 9.000 en efectivo
    ("Efectivo", "transfer", 16300),        # 6.300 en efectivo + 10.000 por transferencia
    ("Transferencia", "transfer", 17000),
    ("Efectivo", "efectivo", 15300),
])
def test_la_sena_entra_al_reparto_con_lo_que_trajo(db, api, forma_sena, forma_cuenta, entro):
    ses, item, cli = preparar(db)
    hecho = cobrar(api, item, cli, forma_sena, forma_cuenta)
    db.expire_all()
    ses = db.get(models.SesionDepilacion, ses.id)
    assert main.cuenta_depilacion(db, ses)["base"] == entro
    pantalla = main._sesion_payload(db, ses)
    assert sum(pantalla["cobrado"].values()) == entro
    assert hecho["ingresado"] + hecho["saldo"] == entro


def test_una_sesion_ya_pagada_sigue_con_su_cuenta(db, api):
    ses, item, cli = preparar(db, reparto_por_lista=True)
    cobrar(api, item, cli, "Transferencia", "efectivo")
    db.expire_all()
    assert main.cuenta_depilacion(db, db.get(models.SesionDepilacion, ses.id))["base"] == 15300
