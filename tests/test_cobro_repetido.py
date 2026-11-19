"""Un cobro que se manda dos veces queda una sola vez.

Con el internet del local el pedido puede llegar y perderse la respuesta: la
pantalla dice "no se pudo" y el segundo toque vuelve a mandarlo. La pantalla
arma una clave por cobro y la repite en cada reintento; acá se mide que el
backend, con la misma clave, devuelva lo que ya hizo en vez de hacerlo otra vez.
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

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


def un_item(db, depilacion=False, precio=18000, transfer=20000):
    it = models.Item(categoria="Depilación" if depilacion else "Cortes", nombre="Zona",
                     precio=precio, precio_transfer=transfer, es_depilacion=depilacion,
                     activo=True)
    db.add(it); db.commit()
    return it


def una_clienta(db):
    c = models.Cliente(nombre="Ana", activo=True)
    db.add(c); db.commit()
    return c


def ticket(item, cliente=None, **mas):
    return {"tipo": "ticket", "cliente_id": cliente.id if cliente else None,
            "cliente_nombre": None if cliente else "Mostrador",
            "forma_pago": "efectivo", "lineas": [{"item_id": item.id, "cantidad": 1}], **mas}


def cuantos(db, modelo):
    db.expire_all()
    return db.query(modelo).count()


def test_cobro_de_depilacion_repetido_es_un_solo_ticket(db, api):
    item, cli = un_item(db, depilacion=True), una_clienta(db)
    db.add(models.Sena(numero=1, cliente_id=cli.id, monto=4500, forma_pago="Efectivo"))
    db.commit()
    pedido = ticket(item, cli, aplicar_senas=True, cobrar=True, clave="cobro-1")

    r1 = api.post("/api/comprobantes", json=pedido)
    r2 = api.post("/api/comprobantes", json=pedido)

    assert r1.status_code == r2.status_code == 200
    assert r1.json() == r2.json()
    assert r1.json()["senas_usadas"] == 1 and r1.json()["saldo"] == 0
    assert cuantos(db, models.Comprobante) == 1
    # la seña y el resto en efectivo, una sola vez
    assert cuantos(db, models.Pago) == 2


def test_sin_clave_cada_pedido_es_un_ticket(db, api):
    item = un_item(db)
    api.post("/api/comprobantes", json=ticket(item))
    api.post("/api/comprobantes", json=ticket(item))
    assert cuantos(db, models.Comprobante) == 2


def test_otra_clave_es_otro_cobro(db, api):
    item = un_item(db)
    api.post("/api/comprobantes", json=ticket(item, clave="a"))
    api.post("/api/comprobantes", json=ticket(item, clave="b"))
    assert cuantos(db, models.Comprobante) == 2


def test_abono_parcial_repetido_se_anota_una_vez(db, api):
    # Es el caso que el saldo no frena: después del primero todavía alcanza.
    comp = api.post("/api/comprobantes", json=ticket(un_item(db), forma_pago="cuenta")).json()
    abono = {"monto": 5000, "forma_pago": "Transferencia", "clave": "abono-1"}

    e1 = api.post(f"/api/comprobantes/{comp['id']}/pagos", json=abono).json()
    e2 = api.post(f"/api/comprobantes/{comp['id']}/pagos", json=abono).json()

    assert e1["saldo"] == e2["saldo"] == 15000
    assert cuantos(db, models.Pago) == 1


def test_la_clave_de_un_abono_no_sirve_en_otro_ticket(db, api):
    item = un_item(db)
    a = api.post("/api/comprobantes", json=ticket(item, forma_pago="cuenta")).json()
    b = api.post("/api/comprobantes", json=ticket(item, forma_pago="cuenta")).json()
    abono = {"monto": 5000, "forma_pago": "Transferencia", "clave": "abono-1"}

    api.post(f"/api/comprobantes/{a['id']}/pagos", json=abono)
    r = api.post(f"/api/comprobantes/{b['id']}/pagos", json=abono)

    assert r.status_code == 409
    assert cuantos(db, models.Pago) == 1


def test_si_cambio_el_pedido_no_contesta_lo_viejo_como_cobrado(db, api):
    # Se cortó la respuesta, se agregó una zona y se volvió a tocar Cobrar.
    item, cli = un_item(db, depilacion=True), una_clienta(db)
    pedido = ticket(item, cli, cobrar=True, clave="cobro-1")
    primero = api.post("/api/comprobantes", json=pedido).json()

    pedido["lineas"][0]["cantidad"] = 2
    r = api.post("/api/comprobantes", json=pedido)

    assert r.status_code == 409
    assert "N-00001" in r.json()["detail"] and "otros datos" in r.json()["detail"]
    assert cuantos(db, models.Comprobante) == 1
    assert primero["saldo"] == 0


def test_la_clave_de_un_ticket_anulado_no_contesta_cobrado(db, api):
    item = un_item(db)
    pedido = ticket(item, clave="cobro-1")
    comp = api.post("/api/comprobantes", json=pedido).json()
    db.get(models.Comprobante, comp["id"]).activo = False
    db.commit()

    r = api.post("/api/comprobantes", json=pedido)

    assert r.status_code == 409 and "anuló" in r.json()["detail"]


def test_abono_repetido_con_otro_monto_no_dice_registrado(db, api):
    comp = api.post("/api/comprobantes", json=ticket(un_item(db), forma_pago="cuenta")).json()
    url = f"/api/comprobantes/{comp['id']}/pagos"
    api.post(url, json={"monto": 5000, "forma_pago": "Transferencia", "clave": "abono-1"})

    r = api.post(url, json={"monto": 8000, "forma_pago": "Transferencia", "clave": "abono-1"})

    assert r.status_code == 409 and "$5.000 en Transferencia" in r.json()["detail"]
    assert cuantos(db, models.Pago) == 1


def test_la_clave_de_un_abono_anulado_no_contesta_registrado(db, api):
    comp = api.post("/api/comprobantes", json=ticket(un_item(db), forma_pago="cuenta")).json()
    url = f"/api/comprobantes/{comp['id']}/pagos"
    abono = {"monto": 5000, "forma_pago": "Transferencia", "clave": "abono-1"}
    api.post(url, json=abono)
    db.query(models.Pago).one().anulado = True
    db.commit()

    r = api.post(url, json=abono)

    assert r.status_code == 409 and "anuló" in r.json()["detail"]


def test_a_cuenta_repetido_con_otra_forma_es_el_mismo_ticket(db, api):
    # Se cortó "Dejar a cuenta" en efectivo y la clienta dijo "te transfiero".
    item, cli = un_item(db), una_clienta(db)
    pedido = ticket(item, cli, clave="k-ticket")
    primero = api.post("/api/comprobantes", json=pedido).json()

    r = api.post("/api/comprobantes", json={**pedido, "forma_pago": "transfer", "cobrar": True})

    assert r.status_code == 200 and r.json()["id"] == primero["id"]
    assert primero["saldo"] == 18000 and r.json()["saldo"] == 20000
    assert cuantos(db, models.Comprobante) == 1


def test_cobrado_repetido_con_otra_forma_no_se_toca(db, api):
    # Ya entró cobrado en efectivo: cambiarle la forma dejaría el arqueo sin esa plata.
    item, cli = un_item(db), una_clienta(db)
    pedido = ticket(item, cli, cobrar=True, clave="k-ticket")
    api.post("/api/comprobantes", json=pedido)

    r = api.post("/api/comprobantes", json={**pedido, "forma_pago": "transfer"})

    assert r.status_code == 409
    db.expire_all()
    assert db.query(models.Comprobante).one().forma_pago == "efectivo"
    assert db.query(models.Pago).one().forma_pago == "Efectivo"


def test_a_cuenta_de_otro_dia_con_otra_forma_no_se_toca(db, api):
    # La deuda de ayer ya figura en la ficha: un borrador viejo no la cambia.
    from datetime import timedelta
    item, cli = un_item(db), una_clienta(db)
    pedido = ticket(item, cli, clave="k-ticket")
    api.post("/api/comprobantes", json=pedido)
    comp = db.query(models.Comprobante).one()
    comp.cargado -= timedelta(days=1); db.commit()

    r = api.post("/api/comprobantes", json={**pedido, "forma_pago": "transfer"})

    assert r.status_code == 409
    db.expire_all()
    assert db.query(models.Comprobante).one().forma_pago == "efectivo"


def test_depilacion_a_cuenta_con_otra_forma_no_se_toca(db, api):
    # Cambiarle la forma movería el reparto de la sesión sin dejarlo anotado.
    item, cli = un_item(db, depilacion=True), una_clienta(db)
    pedido = ticket(item, cli, clave="k-ticket")
    api.post("/api/comprobantes", json=pedido)

    r = api.post("/api/comprobantes", json={**pedido, "forma_pago": "transfer"})

    assert r.status_code == 409


def test_el_mismo_pedido_de_facturar_se_reconoce(db, api):
    # Con ajuste de línea, ítem a mano y extra: todo lo que compara _mismo_pedido.
    item = un_item(db)
    pedido = {"tipo": "ticket", "cliente_nombre": "Mostrador", "forma_pago": "mixto",
              "descuento_pct": 10, "clave": "k",
              "lineas": [{"item_id": item.id, "cantidad": 2, "ajuste_monto": -1000},
                         {"nombre": "Brushing", "cantidad": 1, "precio_custom": 7000, "ajuste_pct": 5}],
              "extras": [{"concepto": "Traslado", "monto": 3000}, {"concepto": " ", "monto": 0}]}
    a = api.post("/api/comprobantes", json=pedido)
    b = api.post("/api/comprobantes", json=pedido)
    assert a.status_code == b.status_code == 200 and a.json()["id"] == b.json()["id"]


def mixto(item, efectivo, clave="mixto-1", alias="ivana.mp"):
    return ticket(item, forma_pago="mixto", clave=clave,
                  mixto={"efectivo": efectivo, "alias": alias})


def test_el_mixto_entra_entero_en_un_pedido(db, api):
    item = un_item(db)                       # $18.000 efectivo / $20.000 transferencia

    r = api.post("/api/comprobantes", json=mixto(item, 9000))

    assert r.status_code == 200 and r.json()["saldo"] == 0
    db.expire_all()
    pagos = {p.forma_pago: p for p in db.query(models.Pago).all()}
    # $9.000 en efectivo tapan $10.000 de la cuenta; el resto va por transferencia
    assert (pagos["Efectivo"].monto, pagos["Efectivo"].saldado, pagos["Efectivo"].desc_aplicado) == (9000, 10000, 1000)
    assert (pagos["Transferencia"].monto, pagos["Transferencia"].alias) == (10000, "ivana.mp")
    assert {p.usuario for p in pagos.values()} == {"ivana"}


def test_el_mixto_repetido_se_cobra_una_vez(db, api):
    item = un_item(db)

    r1 = api.post("/api/comprobantes", json=mixto(item, 9000))
    r2 = api.post("/api/comprobantes", json=mixto(item, 9000))

    assert r1.status_code == r2.status_code == 200 and r1.json() == r2.json()
    assert cuantos(db, models.Comprobante) == 1 and cuantos(db, models.Pago) == 2


def test_el_mixto_repetido_con_otro_efectivo_no_dice_cobrado(db, api):
    item = un_item(db)
    api.post("/api/comprobantes", json=mixto(item, 9000))

    otro_efectivo = api.post("/api/comprobantes", json=mixto(item, 5000))
    otra_cuenta = api.post("/api/comprobantes", json=mixto(item, 9000, alias="otra.cuenta"))

    assert otro_efectivo.status_code == otra_cuenta.status_code == 409
    assert cuantos(db, models.Pago) == 2


@pytest.mark.parametrize("efectivo", [0, 18000, 25000])
def test_un_mixto_que_no_va_no_deja_nada(db, api, efectivo):
    # Como get_db de verdad: una sesión por pedido, que al cerrarse descarta lo
    # que no llegó al commit.
    fabrica = sessionmaker(bind=db.get_bind(), autoflush=False)
    def por_pedido():
        s = fabrica()
        try: yield s
        finally: s.close()
    item = un_item(db)
    app.dependency_overrides[get_db] = por_pedido

    r = api.post("/api/comprobantes", json=mixto(item, efectivo))

    assert r.status_code == 400
    assert cuantos(db, models.Comprobante) == 0 and cuantos(db, models.Pago) == 0


def a_cuenta(item, monto, forma="efectivo", alias=None):
    return ticket(item, forma_pago="cuenta", clave="cuenta-1",
                  deja={"monto": monto, "forma": forma, "alias": alias})


def test_lo_que_deja_en_efectivo_tapa_como_efectivo(db, api):
    # $9.000 en efectivo sobre una cuenta de $20.000 (lista transfer) tapan $10.000:
    # pagando el resto en efectivo, la suma da los $18.000 de la lista de efectivo.
    r = api.post("/api/comprobantes", json=a_cuenta(un_item(db), 9000))

    assert r.status_code == 200 and r.json()["saldo"] == 10000
    pago = db.query(models.Pago).one()
    assert (pago.monto, pago.saldado, pago.forma_pago, pago.desc_aplicado) == (9000, 10000, "Efectivo", 1000)


def test_lo_que_deja_por_transferencia_tapa_lo_mismo(db, api):
    r = api.post("/api/comprobantes", json=a_cuenta(un_item(db), 5000, "transfer", "ivana.mp"))

    assert r.json()["saldo"] == 15000
    pago = db.query(models.Pago).one()
    assert (pago.monto, pago.saldado, pago.forma_pago, pago.alias) == (5000, 5000, "Transferencia", "ivana.mp")


@pytest.mark.parametrize("monto", [0, 18000, 20000])
def test_lo_que_deja_y_no_va_no_deja_nada(db, api, monto):
    # 0 no es dejar nada, y $18.000 en efectivo ya es pagarlo entero: no es a cuenta
    fabrica = sessionmaker(bind=db.get_bind(), autoflush=False)
    def por_pedido():
        s = fabrica()
        try: yield s
        finally: s.close()
    item = un_item(db)
    app.dependency_overrides[get_db] = por_pedido

    r = api.post("/api/comprobantes", json=a_cuenta(item, monto))

    assert r.status_code == 400
    assert cuantos(db, models.Comprobante) == 0 and cuantos(db, models.Pago) == 0


def test_cobrado_entero_por_transferencia_guarda_el_alias(db, api):
    item = un_item(db)
    api.post("/api/comprobantes", json=ticket(item, forma_pago="transfer", cobrar=True, alias="ivana.mp", clave="t"))
    pago = db.query(models.Pago).one()
    assert (pago.forma_pago, pago.monto, pago.alias) == ("Transferencia", 20000, "ivana.mp")
