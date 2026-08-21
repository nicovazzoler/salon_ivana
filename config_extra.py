# Valores configurables del negocio
import math

EXTRA_DIFICULTAD = 20000  # se suma a una linea marcada como "dificultad"
FORMAS_PAGO = ["Efectivo", "Transferencia"]
TIPOS_EGRESO = ["Pago proveedor", "Retiro de caja", "Gasto / insumo", "Sueldo", "Otro"]

def calcular_transfer(precio_efectivo: int) -> int:
    """Precio de transferencia = efectivo x 1,1111, redondeado PARA ARRIBA a múltiplo de 100."""
    bruto = precio_efectivo * 1.1111
    return math.ceil(bruto / 100) * 100