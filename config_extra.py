# Valores configurables del negocio
import math

FORMAS_PAGO = ["Efectivo", "Transferencia"]
TIPOS_EGRESO = ["Pago proveedor", "Retiro de caja", "Gasto / insumo", "Sueldo", "Otro"]

# Datos del negocio que salen en el encabezado del ticket impreso.
# Los campos vacíos no se imprimen.
NEGOCIO = {
    "nombre": "Ivana Salón",
    "telefono": "",       # ej: "351 555-0000"
    "direccion": "",      # ej: "Av. Siempreviva 123, Córdoba"
    "instagram": "",      # ej: "@ivana.salon"
}

# Días en los que el local no abre, con weekday() de Python (0=lunes … 6=domingo).
# Sueldos no dibuja esos días: la semana de la empleada son los días que viene, y
# dos renglones fijos que siempre dicen "no viniste" son dos renglones de ruido.
# Un día de estos aparece igual si pasó algo —el lunes de depilación, o un
# trabajo cargado a mano—: lo que no se dibuja es el día vacío.
DIAS_CERRADO = {6, 0}          # domingo y lunes

def calcular_transfer(precio_efectivo: int) -> int:
    """Precio de transferencia = efectivo x 1,1111, redondeado PARA ARRIBA a múltiplo de 100."""
    bruto = precio_efectivo * 1.1111
    return math.ceil(bruto / 100) * 100