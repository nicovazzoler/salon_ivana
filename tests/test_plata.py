"""Tests de la aritmética de plata: calcular_transfer, precio_con_ajuste y
estado_comprobante.

No levantan el servidor ni usan TestClient: llaman las funciones de main.py
directo. Para estado_comprobante se arman los comprobantes con SimpleNamespace
(no hace falta que sean instancias reales de SQLAlchemy, alcanza con que
tengan los mismos atributos) y siempre se pasa pagos_precargados, así la
función no dispara ninguna consulta a la base.

Los valores esperados salen de aplicar la regla a mano, no de correr la
función y copiar lo que devuelve — así el test sirve para agarrar un cambio
en la fórmula, no solo un cambio accidental en el resultado.
"""
from types import SimpleNamespace

import pytest

from main import calcular_transfer, estado_comprobante, precio_con_ajuste


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
# precio_con_ajuste: ajuste por línea, porcentaje O monto fijo (si vienen los
# dos manda el monto), con signo en los dos, nunca baja de 0.
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
    pago = SimpleNamespace(monto=1000, saldado=None, comprobante_id=comp.id)
    resultado = estado_comprobante(None, comp, pagos_precargados={comp.id: [pago]})
    assert resultado["pagado"] == 1000
    assert resultado["ingresado"] == 1000
    assert resultado["saldo"] == 1400
    assert resultado["estado"] == "parcial"
