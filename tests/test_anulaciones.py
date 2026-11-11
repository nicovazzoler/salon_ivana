"""Quién puede anular plata, y qué queda escrito cuando la anula.

Se levanta la app contra una base nueva y se reemplaza `usuario_actual` por el
rol que cada test quiere probar: lo que se mide es la regla de permiso, no el
login. La fecha importa, así que cada fila se inserta con la que hace falta
—hoy, o dos días atrás— en vez de depender de cuándo corran los tests.

Lo que se protege acá: que el empleado no pueda cambiarle el número a una caja
que ya cerró, que ninguna anulación entre sin motivo, que borrar de verdad sea
solo de la dueña, y que lo anulado deje de contar pero siga a la vista.
"""
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import models
from database import get_db
from main import (
    app,
    fecha_hora_now_utc,
    plata_que_entro,
    usuario_actual,
)

DUENO = {"usuario": "ivana", "rol": "dueno"}
EMPLEADO = {"usuario": "sofi", "rol": "empleado"}


def ahora():
    return fecha_hora_now_utc().replace(tzinfo=None)


@pytest.fixture
def db(tmp_path):
    """Una base vacía, y la app apuntada a ella."""
    engine = create_engine(f"sqlite:///{tmp_path / 'prueba.db'}",
                           connect_args={"check_same_thread": False})
    models.Base.metadata.create_all(engine)
    Sesion = sessionmaker(bind=engine, autoflush=False)
    sesion = Sesion()

    def _get_db():
        yield sesion

    app.dependency_overrides[get_db] = _get_db
    yield sesion
    app.dependency_overrides.clear()
    sesion.close()


@pytest.fixture
def como(db):
    """`como(EMPLEADO)` devuelve un cliente HTTP logueado con ese rol."""
    def _como(user):
        app.dependency_overrides[usuario_actual] = lambda: user
        return TestClient(app)
    return _como


def un_cobro(db, cuando=None, depilacion=False, sesion=None, monto=5000):
    """Un ticket con un cobro encima. Devuelve el Pago."""
    f = cuando or ahora()
    comp = models.Comprobante(tipo="ticket", numero=1, fecha=f, cargado=f, activo=True,
                              cliente_nombre="Ana", total_lista=monto,
                              depilacion=depilacion,
                              sesion_id=sesion.id if sesion else None)
    db.add(comp); db.flush()
    p = models.Pago(comprobante_id=comp.id, fecha=f, monto=monto, saldado=monto,
                    forma_pago="Efectivo", usuario="sofi")
    db.add(p); db.commit()
    return p


def una_sena(db, cuando=None, monto=3000):
    """Una sena libre, sin comprobante encima. Lleva clienta: una sena es plata a
    favor de alguien, asi que la tabla la pide.
    """
    c = models.Cliente(nombre="Ana")
    db.add(c); db.flush()
    s = models.Sena(numero=1, cliente_id=c.id, monto=monto, forma_pago="Efectivo",
                    fecha=cuando or ahora(), usuario="sofi")
    db.add(s); db.commit()
    return s


def una_sesion(db, cerrada=False):
    ses = models.SesionDepilacion(numero=1, abierta=ahora() - timedelta(days=3),
                                  cerrada=ahora() if cerrada else None)
    db.add(ses); db.commit()
    return ses


# ---------------------------------------------------------------------------
# Cobros: quién y cuándo
# ---------------------------------------------------------------------------

def test_empleado_anula_lo_de_hoy_y_queda_el_rastro(db, como):
    p = un_cobro(db)
    r = como(EMPLEADO).delete(f"/api/pagos/{p.id}", params={"motivo": "lo cobré dos veces"})
    assert r.status_code == 200
    db.refresh(p)
    assert p.anulado is True
    assert p.anulado_por == "sofi"
    assert p.anulado_motivo == "lo cobré dos veces"
    assert p.anulado_en is not None
    # Anular no borra: la fila sigue para poder explicar el día.
    assert db.get(models.Pago, p.id) is not None


def test_empleado_no_anula_lo_de_otro_dia(db, como):
    p = un_cobro(db, cuando=ahora() - timedelta(days=2))
    r = como(EMPLEADO).delete(f"/api/pagos/{p.id}", params={"motivo": "estaba mal"})
    assert r.status_code == 403
    db.refresh(p)
    assert not p.anulado


def test_la_duena_anula_cualquier_fecha_y_queda_registrado(db, como):
    p = un_cobro(db, cuando=ahora() - timedelta(days=40))
    r = como(DUENO).delete(f"/api/pagos/{p.id}", params={"motivo": "duplicado del cierre"})
    assert r.status_code == 200
    db.refresh(p)
    assert p.anulado is True and p.anulado_por == "ivana"


def test_sin_motivo_no_se_anula_ni_siendo_duena(db, como):
    p = un_cobro(db)
    cli = como(DUENO)
    assert cli.delete(f"/api/pagos/{p.id}").status_code == 400
    assert cli.delete(f"/api/pagos/{p.id}", params={"motivo": "  "}).status_code == 400
    db.refresh(p)
    assert not p.anulado


def test_anular_dos_veces_avisa_que_ya_estaba(db, como):
    p = un_cobro(db)
    cli = como(EMPLEADO)
    assert cli.delete(f"/api/pagos/{p.id}", params={"motivo": "mal cargado"}).status_code == 200
    assert cli.delete(f"/api/pagos/{p.id}", params={"motivo": "otra vez"}).status_code == 409
    db.refresh(p)
    # El segundo intento no le pisa el motivo al primero.
    assert p.anulado_motivo == "mal cargado"


# ---------------------------------------------------------------------------
# Depilación: la unidad es la sesión, no el día
# ---------------------------------------------------------------------------

def test_empleado_anula_depilacion_de_otro_dia_si_la_sesion_sigue_abierta(db, como):
    ses = una_sesion(db)
    p = un_cobro(db, cuando=ahora() - timedelta(days=2), depilacion=True, sesion=ses)
    r = como(EMPLEADO).delete(f"/api/pagos/{p.id}", params={"motivo": "era de otra clienta"})
    assert r.status_code == 200
    db.refresh(p)
    assert p.anulado is True


def test_empleado_no_anula_depilacion_de_una_sesion_ya_cerrada(db, como):
    ses = una_sesion(db, cerrada=True)
    p = un_cobro(db, cuando=ahora() - timedelta(days=2), depilacion=True, sesion=ses)
    r = como(EMPLEADO).delete(f"/api/pagos/{p.id}", params={"motivo": "era de otra clienta"})
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# Borrar de verdad
# ---------------------------------------------------------------------------

def test_borrar_de_verdad_no_lo_puede_el_empleado(db, como):
    p = un_cobro(db)
    assert como(EMPLEADO).delete(f"/api/pagos/{p.id}", params={"motivo": "mal"}).status_code == 200
    r = como(EMPLEADO).delete(f"/api/pagos/{p.id}/definitivo")
    assert r.status_code == 403
    assert db.get(models.Pago, p.id) is not None


def test_borrar_de_verdad_pide_que_este_anulado_antes(db, como):
    """El motivo vive en la fila: borrar en un paso no dejaría nada escrito."""
    p = un_cobro(db)
    r = como(DUENO).delete(f"/api/pagos/{p.id}/definitivo")
    assert r.status_code == 409
    assert db.get(models.Pago, p.id) is not None


def test_la_duena_borra_de_verdad_lo_ya_anulado(db, como):
    p = un_cobro(db)
    cli = como(DUENO)
    assert cli.delete(f"/api/pagos/{p.id}", params={"motivo": "duplicado"}).status_code == 200
    assert cli.delete(f"/api/pagos/{p.id}/definitivo").status_code == 200
    assert db.get(models.Pago, p.id) is None


# ---------------------------------------------------------------------------
# Señas
# ---------------------------------------------------------------------------

def test_empleado_anula_sena_de_hoy_con_motivo(db, como):
    s = una_sena(db)
    r = como(EMPLEADO).delete(f"/api/senas/{s.id}", params={"motivo": "se arrepintió"})
    assert r.status_code == 200
    db.refresh(s)
    assert s.anulada is True
    assert s.anulado_por == "sofi" and s.anulado_motivo == "se arrepintió"
    assert s.anulado_en is not None
    # La seña queda anulada y no borrada: el número sigue estando.
    assert db.get(models.Sena, s.id) is not None


def test_empleado_no_anula_sena_de_otro_dia(db, como):
    s = una_sena(db, cuando=ahora() - timedelta(days=2))
    r = como(EMPLEADO).delete(f"/api/senas/{s.id}", params={"motivo": "devolución"})
    assert r.status_code == 403
    db.refresh(s)
    assert not s.anulada


def test_sena_sin_motivo_no_se_anula(db, como):
    s = una_sena(db)
    assert como(DUENO).delete(f"/api/senas/{s.id}").status_code == 400
    db.refresh(s)
    assert not s.anulada


def test_borrar_sena_de_verdad_es_solo_de_la_duena(db, como):
    s = una_sena(db)
    assert como(EMPLEADO).delete(f"/api/senas/{s.id}", params={"motivo": "devolución"}).status_code == 200
    assert como(EMPLEADO).delete(f"/api/senas/{s.id}/definitivo").status_code == 403
    assert como(DUENO).delete(f"/api/senas/{s.id}/definitivo").status_code == 200
    assert db.get(models.Sena, s.id) is None


# ---------------------------------------------------------------------------
# Lo anulado deja de contar, pero se ve
# ---------------------------------------------------------------------------

def test_un_cobro_anulado_sale_de_la_plata_que_entro(db, como):
    p = un_cobro(db, monto=5000)
    pagos, _ = plata_que_entro(db, None, None)
    assert sum(x.monto for x in pagos) == 5000
    como(EMPLEADO).delete(f"/api/pagos/{p.id}", params={"motivo": "mal cargado"})
    pagos, _ = plata_que_entro(db, None, None)
    assert sum(x.monto for x in pagos) == 0


def test_la_caja_del_dia_muestra_lo_anulado_con_su_motivo(db, como):
    p = un_cobro(db, monto=5000)
    s = una_sena(db, monto=3000)
    cli = como(DUENO)
    cli.delete(f"/api/pagos/{p.id}", params={"motivo": "lo cobré dos veces"})
    cli.delete(f"/api/senas/{s.id}", params={"motivo": "se arrepintió"})

    d = cli.get("/api/caja/dia").json()
    # Ninguno de los dos cuenta en el total del día.
    assert d["ingresos"] == 0
    # Pero los dos se ven, con quién y por qué.
    assert d["anulado_total"] == 8000
    assert len(d["anulaciones"]) == 2
    motivos = {a["motivo"] for a in d["anulaciones"]}
    assert motivos == {"lo cobré dos veces", "se arrepintió"}
    assert all(a["por"] == "ivana" for a in d["anulaciones"])


def test_los_reportes_cuentan_las_anulaciones_aparte(db, como):
    p = un_cobro(db, monto=5000)
    cli = como(DUENO)
    cli.delete(f"/api/pagos/{p.id}", params={"motivo": "duplicado"})
    r = cli.get("/api/reportes/resumen", params={"dias": 30}).json()
    assert r["ingresos"] == 0
    assert r["anuladas"] == 1 and r["anulado"] == 5000


def test_una_anulacion_de_hoy_queda_en_el_dia_que_fue(db, como):
    """La dueña anula hoy algo de la semana pasada: cuenta en el día original."""
    p = un_cobro(db, cuando=ahora() - timedelta(days=6), monto=5000)
    cli = como(DUENO)
    cli.delete(f"/api/pagos/{p.id}", params={"motivo": "duplicado del cierre"})
    # Hoy no pasó nada: la caja de hoy no se enteró.
    hoy = cli.get("/api/caja/dia").json()
    assert hoy["anulaciones"] == [] and hoy["anulado_total"] == 0


# ---------------------------------------------------------------------------
# Cobrar también deja quién
# ---------------------------------------------------------------------------

def test_registrar_un_cobro_guarda_quien_lo_cobro(db, como):
    """Un cobro mal cargado se arregla preguntándole al que lo cargó."""
    comp = models.Comprobante(tipo="ticket", numero=1, fecha=ahora(), cargado=ahora(),
                              activo=True, cliente_nombre="Ana", total_lista=5000)
    db.add(comp); db.flush()
    db.add(models.ComprobanteLinea(comprobante_id=comp.id, nombre="Corte", cantidad=1,
                                   precio_unit=5000, precio_efectivo=5000, subtotal=5000))
    db.commit()

    r = como(EMPLEADO).post(f"/api/comprobantes/{comp.id}/pagos",
                            json={"monto": 5000, "forma_pago": "Efectivo"})
    assert r.status_code == 200, r.text
    p = db.query(models.Pago).filter(models.Pago.comprobante_id == comp.id).one()
    assert p.usuario == "sofi"


# ---------------------------------------------------------------------------
# Lo que anular tiene que devolver
# ---------------------------------------------------------------------------

def test_anular_un_cobro_le_devuelve_el_saldo_al_ticket(db, como):
    """Lo que el endpoint promete: el comprobante vuelve a quedar con saldo.

    Si el cobro anulado siguiera contando como pagado, la plata saldría de la
    caja y el ticket quedaría saldado igual: la clienta sin deuda y sin pagar.
    """
    comp = models.Comprobante(tipo="ticket", numero=1, fecha=ahora(), cargado=ahora(),
                              activo=True, cliente_nombre="Ana", total_lista=5000)
    db.add(comp); db.flush()
    db.add(models.ComprobanteLinea(comprobante_id=comp.id, nombre="Corte", cantidad=1,
                                   precio_unit=5000, precio_efectivo=5000, subtotal=5000))
    db.commit()
    cli = como(EMPLEADO)
    assert cli.post(f"/api/comprobantes/{comp.id}/pagos",
                    json={"monto": 5000, "forma_pago": "Efectivo"}).status_code == 200
    assert cli.get(f"/api/comprobantes/{comp.id}").json()["saldo"] == 0

    p = db.query(models.Pago).filter(models.Pago.comprobante_id == comp.id).one()
    assert cli.delete(f"/api/pagos/{p.id}", params={"motivo": "lo cobre dos veces"}).status_code == 200
    assert cli.get(f"/api/comprobantes/{comp.id}").json()["saldo"] == 5000


def test_anular_un_abono_que_salio_de_una_sena_la_deja_libre_otra_vez(db, como):
    """La plata que la clienta dejó adelantada vuelve a estar a su favor."""
    from main import usado_de_senas
    s = una_sena(db, monto=3000)
    comp = models.Comprobante(tipo="ticket", numero=1, fecha=ahora(), cargado=ahora(),
                              activo=True, cliente_nombre="Ana", total_lista=3000)
    db.add(comp); db.flush()
    s.comprobante_id = comp.id
    db.add(models.Pago(comprobante_id=comp.id, fecha=ahora(), monto=3000, saldado=3000,
                       forma_pago="Efectivo", sena_id=s.id))
    db.commit()
    p = db.query(models.Pago).filter(models.Pago.sena_id == s.id).one()
    assert usado_de_senas(db, [s.id]).get(s.id) == 3000

    assert como(EMPLEADO).delete(f"/api/pagos/{p.id}",
                                 params={"motivo": "se equivoco de clienta"}).status_code == 200
    db.refresh(s)
    assert s.comprobante_id is None
    assert not usado_de_senas(db, [s.id]).get(s.id)


# ---------------------------------------------------------------------------
# Comprobantes: las mismas reglas que un cobro suelto
# ---------------------------------------------------------------------------

def un_ticket_cobrado(db, cuando=None, cobrado_el=None, depilacion=False, sesion=None,
                      tipo="ticket"):
    """Un ticket de $5.000 con su cobro. Devuelve el Comprobante."""
    f = cuando or ahora()
    comp = models.Comprobante(tipo=tipo, numero=12, fecha=f, cargado=f, activo=True,
                              cliente_nombre="Ana", total_lista=5000, forma_pago="efectivo",
                              depilacion=depilacion, sesion_id=sesion.id if sesion else None)
    db.add(comp); db.flush()
    db.add(models.ComprobanteLinea(comprobante_id=comp.id, nombre="Corte", cantidad=1,
                                   precio_unit=5000, precio_efectivo=5000, subtotal=5000))
    if tipo == "ticket":
        db.add(models.Pago(comprobante_id=comp.id, fecha=cobrado_el or f, monto=5000,
                           saldado=5000, forma_pago="Efectivo", usuario="sofi"))
    db.commit()
    return comp


def test_empleado_no_anula_un_ticket_de_otro_dia(db, como):
    comp = un_ticket_cobrado(db, cuando=ahora() - timedelta(days=2))
    r = como(EMPLEADO).delete(f"/api/comprobantes/{comp.id}", params={"motivo": "estaba mal"})
    assert r.status_code == 403
    db.refresh(comp)
    assert comp.activo


def test_empleado_no_anula_un_ticket_de_hoy_cuya_plata_entro_otro_dia(db, como):
    # No se arma desde la pantalla, pero la regla mira cada cobro, no solo el ticket.
    comp = un_ticket_cobrado(db, cobrado_el=ahora() - timedelta(days=2))
    r = como(EMPLEADO).delete(f"/api/comprobantes/{comp.id}", params={"motivo": "estaba mal"})
    assert r.status_code == 403


def test_empleado_anula_un_presupuesto_viejo(db, como):
    # Un presupuesto no movió plata: no hay caja de otro día que cuidar.
    comp = un_ticket_cobrado(db, cuando=ahora() - timedelta(days=20), tipo="presupuesto")
    r = como(EMPLEADO).delete(f"/api/comprobantes/{comp.id}", params={"motivo": "no volvió"})
    assert r.status_code == 200


def test_anular_un_ticket_sin_motivo_no_se_puede(db, como):
    comp = un_ticket_cobrado(db)
    assert como(DUENO).delete(f"/api/comprobantes/{comp.id}").status_code == 400
    db.refresh(comp)
    assert comp.activo


def test_empleado_anula_depilacion_de_otro_dia_con_la_sesion_abierta(db, como):
    ses = una_sesion(db)
    comp = un_ticket_cobrado(db, cuando=ahora() - timedelta(days=1), depilacion=True, sesion=ses)
    r = como(EMPLEADO).delete(f"/api/comprobantes/{comp.id}", params={"motivo": "no iba"})
    assert r.status_code == 200, r.text


def test_anular_un_ticket_deja_rastro_y_no_borra_sus_cobros(db, como):
    comp = un_ticket_cobrado(db, cuando=ahora() - timedelta(days=40))
    cli = como(DUENO)
    r = cli.delete(f"/api/comprobantes/{comp.id}", params={"motivo": "se cargó dos veces"})
    assert r.status_code == 200
    db.refresh(comp)
    assert not comp.activo
    assert (comp.anulado_por, comp.anulado_motivo) == ("ivana", "se cargó dos veces")
    assert comp.anulado_en is not None
    p = db.query(models.Pago).filter(models.Pago.comprobante_id == comp.id).one()
    assert p.anulado is True and p.anulado_por == "ivana"
    assert p.anulado_motivo == "Se anuló el N-00012: se cargó dos veces"


def test_un_cobro_ya_anulado_conserva_su_motivo_al_anular_el_ticket(db, como):
    comp = un_ticket_cobrado(db)
    cli = como(EMPLEADO)
    p = db.query(models.Pago).filter(models.Pago.comprobante_id == comp.id).one()
    cli.delete(f"/api/pagos/{p.id}", params={"motivo": "lo cobré dos veces"})
    assert cli.delete(f"/api/comprobantes/{comp.id}", params={"motivo": "no iba"}).status_code == 200
    db.refresh(p)
    assert (p.anulado_por, p.anulado_motivo) == ("sofi", "lo cobré dos veces")


def test_el_cobro_de_un_ticket_anulado_sale_en_la_caja_de_su_dia(db, como):
    comp = un_ticket_cobrado(db)
    cli = como(DUENO)
    antes = cli.get("/api/caja/dia").json()
    cli.delete(f"/api/comprobantes/{comp.id}", params={"motivo": "se cargó dos veces"})
    despues = cli.get("/api/caja/dia").json()
    assert despues["ingresos"] == antes["ingresos"] - 5000
    assert despues["anulado_total"] == 5000
    assert "se cargó dos veces" in despues["anulaciones"][0]["motivo"]


def test_la_sena_de_un_ticket_anulado_queda_libre_y_dice_donde_estuvo(db, como):
    s = una_sena(db, monto=3000)
    comp = models.Comprobante(tipo="ticket", numero=12, fecha=ahora(), cargado=ahora(),
                              activo=True, cliente_nombre="Ana", total_lista=3000,
                              forma_pago="efectivo", cliente_id=s.cliente_id)
    db.add(comp); db.flush()
    s.comprobante_id = comp.id
    db.add(models.Pago(comprobante_id=comp.id, fecha=ahora(), monto=3000, saldado=3000,
                       forma_pago="Seña", sena_id=s.id))
    db.commit()
    cli = como(EMPLEADO)

    assert cli.delete(f"/api/comprobantes/{comp.id}", params={"motivo": "otra clienta"}).status_code == 200

    sena = cli.get(f"/api/senas/{s.id}").json()
    assert sena["usada"] is False and sena["libre"] == 3000
    assert sena["estuvo_en"] == ["N-00012"]
    # La plata de la seña no entra a la caja como anulación: no salió del cajón.
    assert cli.get("/api/caja/dia").json()["anulado_total"] == 0


def test_anular_solo_el_abono_de_la_sena_no_dice_que_el_ticket_se_anulo(db, como):
    s = una_sena(db, monto=3000)
    comp = models.Comprobante(tipo="ticket", numero=12, fecha=ahora(), cargado=ahora(),
                              activo=True, cliente_nombre="Ana", total_lista=3000,
                              forma_pago="efectivo", cliente_id=s.cliente_id)
    db.add(comp); db.flush()
    db.add(models.Pago(comprobante_id=comp.id, fecha=ahora(), monto=3000, saldado=3000,
                       forma_pago="Seña", sena_id=s.id))
    db.commit()
    cli = como(EMPLEADO)
    p = db.query(models.Pago).filter(models.Pago.sena_id == s.id).one()

    assert cli.delete(f"/api/pagos/{p.id}", params={"motivo": "otra clienta"}).status_code == 200

    assert cli.get(f"/api/senas/{s.id}").json()["estuvo_en"] == []
