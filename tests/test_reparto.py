"""El reparto de una sesión de depilación cuenta cada ticket como dice el papel.

La seña se resta del ticket a la par de la lista de transferencia, y el 10% es
solo de lo que se paga en efectivo en el mostrador. Se mide con un trabajo de
$17.000 de lista ($15.300 en efectivo) y una seña de $7.000: cobrado en efectivo
el ticket vale $16.000 (seña $7.000 + $9.000), por transferencia $17.000.
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


def senar(db, api, cli, forma, vieja=False):
    if vieja:   # en efectivo, de cuando se cobraba con el 10% menos
        db.add(models.Sena(numero=1, cliente_id=cli.id, monto=6300, forma_pago="Efectivo",
                           con_descuento=True))
        db.commit(); return
    r = api.post("/api/senas", json={"cliente_id": cli.id, "valor": 7000, "forma_pago": forma})
    assert r.status_code == 200, r.text


def cobrar(api, item, cli, forma_cuenta):
    r = api.post("/api/comprobantes", json={
        "tipo": "ticket", "cliente_id": cli.id, "forma_pago": forma_cuenta,
        "lineas": [{"item_id": item.id, "cantidad": 1}], "aplicar_senas": True, "cobrar": True})
    assert r.status_code == 200, r.text
    return r.json()


CASOS = [
    pytest.param("Transferencia", False, "efectivo", 16000, id="transfer-ticket-efvo"),
    pytest.param("Efectivo", False, "efectivo", 16000, id="efvo-ticket-efvo"),
    pytest.param("Efectivo", True, "efectivo", 16000, id="efvo-vieja-ticket-efvo"),
    pytest.param("Transferencia", False, "transfer", 17000, id="transfer-ticket-transfer"),
    pytest.param("Efectivo", False, "transfer", 17000, id="efvo-ticket-transfer"),
    pytest.param("Efectivo", True, "transfer", 17000, id="efvo-vieja-ticket-transfer"),
]


@pytest.mark.parametrize("forma_sena, vieja, forma_cuenta, vale", CASOS)
def test_el_ticket_vale_lo_que_dice_el_papel(db, api, forma_sena, vieja, forma_cuenta, vale):
    ses, item, cli = preparar(db)
    senar(db, api, cli, forma_sena, vieja)
    hecho = cobrar(api, item, cli, forma_cuenta)
    db.expire_all()
    ses = db.get(models.SesionDepilacion, ses.id)
    assert main.cuenta_depilacion(db, ses)["base"] == vale
    pantalla = main._sesion_payload(db, ses)
    assert sum(pantalla["cobrado"].values()) == vale
    assert [c["total"] for c in pantalla["comprobantes"]] == [vale]
    assert hecho["vale"] == vale
    lista = api.get(f"/api/comprobantes?de=depi&sesion_id={ses.id}").json()["comprobantes"]
    assert [c["vale"] for c in lista] == [vale]


def test_una_sesion_contada_en_efectivo_sigue_igual(db, api):
    ses, item, cli = preparar(db, reparto_efectivo=True)
    senar(db, api, cli, "Transferencia")
    cobrar(api, item, cli, "efectivo")
    db.expire_all()
    assert main.cuenta_depilacion(db, db.get(models.SesionDepilacion, ses.id))["base"] == 15300


@pytest.mark.parametrize("forma_sena, vieja", [("Transferencia", False), ("Efectivo", True)])
def test_el_cierre_viejo_queda_en_lo_que_se_pago(db, api, forma_sena, vieja):
    # Ticket en efectivo: se había repartido sobre $15.300 y el papel dice $16.000.
    ses, item, cli = preparar(db)
    senar(db, api, cli, forma_sena, vieja)
    cobrar(api, item, cli, "efectivo")
    eg = models.Egreso(numero=1, tipo="Sueldo", concepto="Depilación", monto=7650, forma_pago="Efectivo")
    db.add(eg); db.flush()
    liq = models.Liquidacion(empleado_id=ses.empleado_id, total=7650, depilacion=True,
                             sesion_id=ses.id, recaudado=15300, gastos=0, egreso_id=eg.id)
    db.add(liq); db.commit()

    assert main.corregir_cierres_por_senas(db) == 1
    db.commit(); db.expire_all()
    assert db.get(models.Liquidacion, liq.id).total == 8000
    assert db.get(models.Egreso, eg.id).monto == 8000
    nota = db.query(models.CorreccionSesion).filter_by(sesion_id=ses.id).one()
    assert (nota.parte_antes, nota.parte_despues) == (7650, 8000)
    ses = db.get(models.SesionDepilacion, ses.id)
    assert main.cuenta_depilacion(db, ses)["parte_empleada"] == 8000
