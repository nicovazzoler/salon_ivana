"""La aritmética de plata del backend, llamando las funciones de main.py derecho.

Los comprobantes se arman con SimpleNamespace y siempre con pagos_precargados,
así no se toca la base. Los valores esperados salen de aplicar la regla a mano:
copiar lo que devuelve la función haría que el test no agarre un cambio de fórmula.
"""
from types import SimpleNamespace

import pytest

from main import (
    _aplicar_senas,
    base_comision,
    base_facturada,
    calcular_transfer,
    estado_comprobante,
    precio_con_ajuste,
    sena_saldado,
)


# ---------------------------------------------------------------------------
# calcular_transfer: efectivo x 1,1111 redondeado PARA ARRIBA a múltiplo de 100.
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "efectivo, transfer_esperado",
    [
        pytest.param(1000, 1200, id="1111,1-sube-a-1200"),
        pytest.param(1800, 2000, id="1999,98-a-centavos-de-2000-igual-sube"),
        pytest.param(9000, 10000, id="9999,9-sube-a-10000"),
        pytest.param(0, 0, id="cero"),
        pytest.param(1_000_000, 1_111_100, id="ya-es-multiplo-no-suma-un-escalon-de-mas"),
    ],
)
def test_calcular_transfer(efectivo, transfer_esperado):
    assert calcular_transfer(efectivo) == transfer_esperado


# ---------------------------------------------------------------------------
# precio_con_ajuste: porcentaje O monto fijo (si vienen los dos manda el monto).
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "base, pct, monto, esperado",
    [
        pytest.param(1000, None, None, 1000, id="sin-ajuste-none"),
        pytest.param(1000, 0, 0, 1000, id="sin-ajuste-cero"),
        pytest.param(1000, -10, None, 900, id="solo-pct-descuento-10"),
        pytest.param(1000, 15, None, 1150, id="solo-pct-recargo-15"),
        pytest.param(1000, None, -200, 800, id="solo-monto-descuento-200"),
        pytest.param(1000, None, 300, 1300, id="solo-monto-recargo-300"),
        pytest.param(1000, -50, -200, 800, id="vienen-los-dos-manda-el-monto"),
        pytest.param(500, None, -800, 0, id="el-monto-no-baja-el-precio-de-cero"),
        pytest.param(150, 1, None, 152, id="151,5-redondea-al-par-mas-cercano"),
    ],
)
def test_precio_con_ajuste(base, pct, monto, esperado):
    assert precio_con_ajuste(base, pct, monto) == esperado


# ---------------------------------------------------------------------------
# estado_comprobante
# ---------------------------------------------------------------------------

def _linea(precio_efectivo=1000, ajuste_pct=0, ajuste_monto=0, cantidad=2):
    return SimpleNamespace(
        precio_efectivo=precio_efectivo,
        ajuste_pct=ajuste_pct,
        ajuste_monto=ajuste_monto,
        cantidad=cantidad,
    )


def _pago(monto, saldado=None, sena_id=None, comp_id=1):
    # sena_id va siempre: estado_comprobante separa lo que se cobró de mostrador
    # de lo que vino de una seña, y un pago sin ese atributo no existe en la base.
    return SimpleNamespace(
        monto=monto, saldado=saldado, sena_id=sena_id, comprobante_id=comp_id
    )


def _comprobante(
    *,
    forma_pago="transferencia",
    descuento_pct=0,
    extras=None,
    extra_dificultad=0,
    tipo="ticket",
    # 2400 = calcular_transfer(1000) x 2 = 1200 x 2: el ancla transferencia
    # de un comprobante con la misma línea de 1000 x 2 que usan todos los
    # casos de abajo. estado_comprobante no la calcula, solo la lee.
    total_lista=2400,
    lineas=None,
    comp_id=1,
    depilacion=False,
):
    return SimpleNamespace(
        id=comp_id,
        forma_pago=forma_pago,
        descuento_pct=descuento_pct,
        extras=extras or [],
        extra_dificultad=extra_dificultad,
        tipo=tipo,
        total_lista=total_lista,
        lineas=lineas if lineas is not None else [_linea()],
        depilacion=depilacion,
    )


def test_estado_comprobante_caso_base_sin_extras_sin_descuentos():
    comp = _comprobante()
    resultado = estado_comprobante(None, comp, pagos_precargados={comp.id: []})
    assert resultado == {
        "total_transfer": 2400,
        "desc_efectivo": 0,
        "subtotal": 2400,
        "desc_jubilado": 0,
        "extras_total": 0,
        "total_final": 2400,
        "pagado": 0,
        "ingresado": 0,
        "cobrado": 0,
        "saldo": 2400,
        "estado": "pendiente",
    }


def test_estado_comprobante_desc_efectivo_es_la_diferencia_entre_listas():
    # Misma línea (1000 x 2 = 2000 en lista efectivo) contra el mismo ancla
    # transferencia (2400): la diferencia entre listas es el descuento por
    # pagar en efectivo, y solo se aplica cuando forma_pago es "efectivo".
    comp = _comprobante(forma_pago="efectivo")
    resultado = estado_comprobante(None, comp, pagos_precargados={comp.id: []})
    assert resultado["desc_efectivo"] == 400
    assert resultado["subtotal"] == 2000
    assert resultado["total_final"] == 2000


def test_estado_comprobante_desc_jubilado_va_sobre_el_subtotal():
    comp = _comprobante(descuento_pct=10)
    resultado = estado_comprobante(None, comp, pagos_precargados={comp.id: []})
    assert resultado["desc_jubilado"] == 240  # 10% de 2400
    assert resultado["total_final"] == 2160


def test_estado_comprobante_extras_no_reciben_ningun_descuento():
    comp = _comprobante(
        forma_pago="efectivo",
        descuento_pct=10,
        extras=[SimpleNamespace(monto=500)],
    )
    resultado = estado_comprobante(None, comp, pagos_precargados={comp.id: []})
    assert resultado["desc_efectivo"] == 400
    assert resultado["desc_jubilado"] == 200  # 10% de 2000, el extra no está adentro
    assert resultado["extras_total"] == 500
    # Si el extra entrara ANTES del descuento jubilado, el total sería
    # round(2500 x 0,9) = 2250. Que dé 2300 prueba que el extra queda afuera.
    assert resultado["total_final"] == 2300


def test_estado_comprobante_pago_parcial():
    comp = _comprobante()  # total_final = 2400, sin descuentos ni extras
    resultado = estado_comprobante(
        None, comp, pagos_precargados={comp.id: [_pago(1000)]}
    )
    assert resultado["pagado"] == 1000
    assert resultado["ingresado"] == 1000
    assert resultado["cobrado"] == 1000
    assert resultado["saldo"] == 1400
    assert resultado["estado"] == "parcial"


def test_estado_comprobante_la_sena_no_es_plata_de_mostrador():
    """`cobrado` deja afuera los abonos que vienen de una seña.

    Es el número del papel y de las tarjetas: esa plata ya había entrado al cajón.
    """
    comp = _comprobante(forma_pago="efectivo")  # total_final = 2000
    # Una seña de 500 tomada por transferencia tapa 450 de una cuenta en
    # efectivo (ver sena_saldado); el resto lo paga en el mostrador.
    pagos = [_pago(500, saldado=450, sena_id=7), _pago(1550, saldado=1550)]
    resultado = estado_comprobante(None, comp, pagos_precargados={comp.id: pagos})
    assert resultado["ingresado"] == 2050  # toda la plata que tocó este ticket
    assert resultado["cobrado"] == 1550  # lo que puso sobre el mostrador
    assert resultado["pagado"] == 2000
    assert resultado["saldo"] == 0
    assert resultado["estado"] == "pagado"


# ---------------------------------------------------------------------------
# sena_saldado: cuánto tapa una seña sale de en qué lista está escrita cada cosa.
# El 10% es de la plata que entra en EFECTIVO, no del trabajo.
# ---------------------------------------------------------------------------

def _sena(monto, forma_pago):
    return SimpleNamespace(monto=monto, forma_pago=forma_pago)


@pytest.mark.parametrize(
    "forma_sena, forma_cuenta, saldado_esperado",
    [
        # Efectivo contra una cuenta sin el descuento adentro: esos pesos valen
        # mas. 5000 / 0,9 = 5555,5 -> para arriba al siguiente múltiplo de 100.
        pytest.param("Efectivo", "transferencia", 5600, id="efvo-contra-transfer-vale-mas"),
        # Transferencia contra una cuenta que ya viene con el 10% sacado:
        # descontarsela entera seria regalarle el 10% de la seña.
        pytest.param("Transferencia", "efectivo", 4500, id="transfer-contra-efvo-vale-menos"),
        pytest.param("Efectivo", "efectivo", 5000, id="la-misma-lista-el-monto-tal-cual"),
        pytest.param("Transferencia", "transferencia", 5000, id="la-misma-lista-transfer"),
    ],
)
def test_sena_saldado_segun_la_lista_de_cada_cosa(forma_sena, forma_cuenta, saldado_esperado):
    comp = _comprobante(forma_pago=forma_cuenta)
    usa, saldado = sena_saldado(_sena(5000, forma_sena), comp, saldo=100_000)
    assert saldado == saldado_esperado
    assert usa == 5000  # entra entera: el saldo es mucho mayor


def test_sena_saldado_mas_grande_que_la_cuenta_se_usa_hasta_ahi():
    # Una seña de 5000 contra una cuenta a la que le faltan 3000: se usa lo
    # justo y el resto le queda a favor en otra fila, sin inventar un vuelto.
    comp = _comprobante(forma_pago="transferencia")
    usa, saldado = sena_saldado(_sena(5000, "Transferencia"), comp, saldo=3000)
    assert (usa, saldado) == (3000, 3000)


# ---------------------------------------------------------------------------
# base_facturada: con qué lista entra cada línea al reparto de la depilación.
# NO es base_comision, que se paga siempre en efectivo.
# ---------------------------------------------------------------------------

def test_base_facturada_usa_la_lista_con_la_que_se_cobro():
    linea = SimpleNamespace(
        precio_unit=1200, precio_efectivo=1000, ajuste_pct=0, ajuste_monto=0, cantidad=2
    )
    en_efvo = _comprobante(forma_pago="efectivo")
    en_transf = _comprobante(forma_pago="transferencia")
    assert base_facturada(linea, en_efvo) == 2000  # lista efectivo
    assert base_facturada(linea, en_transf) == 2400  # lista transferencia


def test_la_sena_no_toca_un_ticket_de_peluqueria():
    """Las señas son de depilación: es donde se señan los turnos.

    Se corta antes de tocar la base, de ahí que `db` pueda ser None.
    """
    assert _aplicar_senas(None, _comprobante(depilacion=False)) == (0, 0)


def test_base_comision_no_mira_la_forma_de_pago():
    """La diferencia entre listas no es un descuento que se le hizo a nadie."""
    linea = SimpleNamespace(
        precio_unit=1200, precio_efectivo=1000, ajuste_pct=0, ajuste_monto=0, cantidad=2
    )
    for forma in ("efectivo", "transferencia"):
        assert base_comision(linea, _comprobante(forma_pago=forma)) == 2000
