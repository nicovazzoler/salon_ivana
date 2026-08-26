# Valores configurables del negocio
import math

EXTRA_DIFICULTAD = 20000  # se suma a una linea marcada como "dificultad"
FORMAS_PAGO = ["Efectivo", "Transferencia"]
TIPOS_EGRESO = ["Pago proveedor", "Retiro de caja", "Gasto / insumo", "Sueldo", "Otro"]

# Datos del negocio que salen en el encabezado del ticket impreso.
# Los campos vacíos no se imprimen.
NEGOCIO = {
    "nombre": "Salón Ivana",
    "telefono": "",       # ej: "351 555-0000"
    "direccion": "",      # ej: "Av. Siempreviva 123, Córdoba"
    "instagram": "",      # ej: "@salon.ivana"
}

def calcular_transfer(precio_efectivo: int) -> int:
    """Precio de transferencia = efectivo x 1,1111, redondeado PARA ARRIBA a múltiplo de 100."""
    bruto = precio_efectivo * 1.1111
    return math.ceil(bruto / 100) * 100