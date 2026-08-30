from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Numeric
from sqlalchemy.orm import relationship
from datetime import datetime, timezone, timedelta
from database import Base

# ---------- Huso horario ----------

def fecha_hora_now_utc():
    return datetime.now(timezone.utc)

def hora_argentina(dt):
    return dt - timedelta(hours=3)

class Item(Base):
    """Cada cosa vendible: servicio, producto o servicio de peluqueria."""
    __tablename__ = "items"
    id = Column(Integer, primary_key=True)
    categoria = Column(String, nullable=False, index=True)
    nombre = Column(String, nullable=False)
    precio = Column(Integer, nullable=False)
    precio_transfer = Column(Integer, default=0)   # calculado: efectivo redondeado a transferencia
    es_producto = Column(Boolean, default=False)
    stock_actual = Column(Integer, default=0)   # solo aplica a productos
    stock_minimo = Column(Integer, default=0)
    activo = Column(Boolean, default=True)

class Venta(Base):
    """Cabecera de una venta (puede tener varias lineas)."""
    __tablename__ = "ventas"
    id = Column(Integer, primary_key=True)
    fecha = Column(DateTime, default=fecha_hora_now_utc)
    forma_pago = Column(String)
    alias = Column(String)        # alias de transferencia (opcional)
    cliente = Column(String)      # nombre del cliente (opcional)
    peluquero = Column(String)    # quién atendió (opcional)
    total = Column(Integer, default=0)
    lineas = relationship("VentaLinea", back_populates="venta", cascade="all, delete-orphan")

class VentaLinea(Base):
    __tablename__ = "venta_lineas"
    id = Column(Integer, primary_key=True)
    venta_id = Column(Integer, ForeignKey("ventas.id"), nullable=False)
    item_id = Column(Integer, ForeignKey("items.id"))
    nombre = Column(String)        # snapshot del nombre al momento de la venta
    cantidad = Column(Integer, default=1)
    precio_unit = Column(Integer)  # snapshot del precio
    dificultad = Column(Boolean, default=False)
    subtotal = Column(Integer)
    venta = relationship("Venta", back_populates="lineas")

class Egreso(Base):
    __tablename__ = "egresos"
    id = Column(Integer, primary_key=True)
    fecha = Column(DateTime, default=fecha_hora_now_utc)
    tipo = Column(String)
    concepto = Column(String)
    monto = Column(Integer)
    forma_pago = Column(String)
    notas = Column(String)

class FormaPago(Base):
    __tablename__ = "formas_pago"
    id = Column(Integer, primary_key=True)
    nombre = Column(String, nullable=False, unique=True)
    activo = Column(Boolean, default=True)

class Usuario(Base):
    __tablename__ = "usuarios"
    id = Column(Integer, primary_key=True)
    usuario = Column(String, unique=True, nullable=False)
    salt = Column(String, nullable=False)
    hash = Column(String, nullable=False)
    rol = Column(String, default="empleado")  # "dueno" o "empleado"

class TipoEgreso(Base):
    __tablename__ = "tipos_egreso"
    id = Column(Integer, primary_key=True)
    nombre = Column(String, unique=True, nullable=False)
    activo = Column(Boolean, default=True)

class Config(Base):
    __tablename__ = "config"
    clave = Column(String, primary_key=True)
    valor = Column(String)

class FondoCaja(Base):
    """Fondo inicial de caja por día. La fecha es un ISO 'YYYY-MM-DD'.
    Si un día no tiene fila, se arrastra el último fondo cargado (ver get_fondo_dia)."""
    __tablename__ = "fondo_caja"
    fecha = Column(String, primary_key=True)   # 'YYYY-MM-DD'
    monto = Column(Integer, default=0)

class Alias(Base):
    __tablename__ = "alias_transferencia"
    id = Column(Integer, primary_key=True)
    nombre = Column(String, unique=True, nullable=False)
    activo = Column(Boolean, default=True)

class Cliente(Base):
    __tablename__ = "clientes"
    id = Column(Integer, primary_key=True)
    nombre = Column(String, nullable=False, index=True)
    telefono = Column(String)              
    alias = Column(String)                 
    notas = Column(String)
    direccion = Column(String)
    dni = Column(String)                 
    activo = Column(Boolean, default=True)
    creado = Column(DateTime, default=fecha_hora_now_utc)

class Turno(Base):
    """Turnos / citas agendadas."""
    __tablename__ = "turnos"
    id = Column(Integer, primary_key=True)
    fecha = Column(String, nullable=False, index=True)   # 'YYYY-MM-DD'
    hora = Column(String, nullable=False)                 # 'HH:MM'
    cliente_id = Column(Integer, ForeignKey("clientes.id"))   # opcional: vínculo al cliente registrado
    cliente = Column(String, nullable=False)
    servicio = Column(String, nullable=False)
    peluquero = Column(String)                            # opcional
    notas = Column(String)                                # opcional
    activo = Column(Boolean, default=True)

class NotaDiaria(Base):
    """Notas internas del día en agenda."""
    __tablename__ = "notas_diarias"
    id = Column(Integer, primary_key=True)
    fecha = Column(String, nullable=False, index=True)
    texto = Column(String, nullable=False)
    creada = Column(DateTime, default=fecha_hora_now_utc)
    activo = Column(Boolean, default=True)

class MovimientoStock(Base):
    """Log de cada cambio de stock."""
    __tablename__ = "movimientos_stock"
    id = Column(Integer, primary_key=True)
    item_id = Column(Integer, ForeignKey("items.id"), nullable=False)
    fecha = Column(DateTime, default=fecha_hora_now_utc)
    tipo = Column(String, nullable=False)
    antes = Column(Integer)
    despues = Column(Integer)
    cambio = Column(Integer)
    motivo = Column(String)
    usuario = Column(String)

class Comprobante(Base):
    """Ticket o presupuesto. El campo 'tipo' los diferencia."""
    __tablename__ = "comprobantes"
    id = Column(Integer, primary_key=True)
    tipo = Column(String, nullable=False)        # "ticket" o "presupuesto"
    numero = Column(Integer, nullable=False)
    # Cuándo se HIZO el servicio. Es la fecha que manda para la caja y los reportes.
    fecha = Column(DateTime, default=fecha_hora_now_utc)
    # Cuándo se CARGÓ en el sistema. Normalmente es el mismo momento que `fecha`;
    # solo difiere cuando se anota un servicio de un día anterior que se pasó por
    # alto. Que sean dos campos distintos es lo que permite decir en el papel
    # "servicio anotado el 30/8" sin mentir sobre el día en que se atendió.
    cargado = Column(DateTime, default=fecha_hora_now_utc)
    cliente_id = Column(Integer, ForeignKey("clientes.id"))  # opcional (puede ser None: mostrador)
    cliente_nombre = Column(String)               # snapshot del nombre al momento
    peluquero = Column(String)                    
    total_lista = Column(Integer, default=0)    # total a precio de lista (sin descuento)
    extra_dificultad = Column(Integer, default=0)   # total del extra por dificultad (snapshot)
    descuento_pct = Column(Integer, default=0)       # % de descuento aplicado al comprobante
    descuento_nombre = Column(String)                # snapshot del nombre del descuento
    forma_pago = Column(String)                      # snapshot de la forma de pago
    mostrar_motivo = Column(Boolean, default=False)  # si se imprime el motivo
    convertido_de = Column(Integer, ForeignKey("comprobantes.id"))  # si vino de un presupuesto
    activo = Column(Boolean, default=True)
    cliente = relationship("Cliente")
    lineas = relationship("ComprobanteLinea", back_populates="comprobante", cascade="all, delete-orphan")
    extras = relationship("ComprobanteExtra", back_populates="comprobante", cascade="all, delete-orphan")

class ComprobanteLinea(Base):
    __tablename__ = "comprobante_lineas"
    id = Column(Integer, primary_key=True)
    comprobante_id = Column(Integer, ForeignKey("comprobantes.id"), nullable=False)
    item_id = Column(Integer, ForeignKey("items.id"))
    nombre = Column(String)            # snapshot del nombre
    cantidad = Column(Integer, default=1)
    precio_unit = Column(Integer)      # snapshot del precio transferencia (precio de referencia)
    precio_efectivo = Column(Integer)  # snapshot del precio efectivo de catálogo (para el descuento)
    # Ajuste de ESTA línea, POR UNIDAD y con signo. Dos formas excluyentes:
    #   ajuste_pct:   -10 = 10% de descuento, +15 = 15% de recargo
    #   ajuste_monto: -2000 = $2000 de descuento, +1500 = $1500 de recargo
    # Los precios de arriba quedan como el catálogo los tenía, así el ticket puede
    # mostrar "precio de lista → precio ajustado" por unidad.
    ajuste_pct = Column(Integer, default=0)
    ajuste_monto = Column(Integer, default=0)
    ajuste_nombre = Column(String)     # snapshot del motivo ("Fidelidad", "Pelo largo"...)
    # Ya no se usa: el extra por dificultad se sacó. Queda la columna para que los
    # comprobantes viejos sigan mostrando el mismo total que el día que se cobraron.
    dificultad = Column(Boolean, default=False)
    subtotal = Column(Integer)
    comprobante = relationship("Comprobante", back_populates="lineas")

class ComprobanteExtra(Base):
    """Cargo suelto del comprobante (traslado, producto que se lleva, seña...).
    Se suma DESPUÉS de todos los descuentos: ni la diferencia entre listas ni el
    descuento de catálogo lo tocan. Siempre se imprime."""
    __tablename__ = "comprobante_extras"
    id = Column(Integer, primary_key=True)
    comprobante_id = Column(Integer, ForeignKey("comprobantes.id"), nullable=False)
    concepto = Column(String, nullable=False)
    monto = Column(Integer, nullable=False)
    comprobante = relationship("Comprobante", back_populates="extras")

class Pago(Base):
    """Un abono a un comprobante. Un comprobante puede tener varios (cuotas)."""
    __tablename__ = "pagos"
    id = Column(Integer, primary_key=True)
    comprobante_id = Column(Integer, ForeignKey("comprobantes.id"), nullable=False)
    fecha = Column(DateTime, default=fecha_hora_now_utc)
    monto = Column(Integer, nullable=False)      # lo que entró (a la caja)
    saldado = Column(Integer)                     # deuda (a precio transferencia) que cubre este pago
    forma_pago = Column(String)
    alias = Column(String)                       # si fue transferencia (opcional)
    desc_aplicado = Column(Integer, default=0)   # descuento en pesos de este abono (saldado - monto)
    comprobante = relationship("Comprobante")

class Descuento(Base):
    """Catálogo de descuentos configurables. Se aplican al comprobante entero."""
    __tablename__ = "descuentos"
    id = Column(Integer, primary_key=True)
    nombre = Column(String, nullable=False)            # "Efectivo", "Jubilado", etc.
    porcentaje = Column(Integer, nullable=False)        # 10, 15, 20...
    mostrar_motivo = Column(Boolean, default=False)     # default de si se imprime el motivo
    activo = Column(Boolean, default=True)

class AjusteItem(Base):
    """Descuentos y recargos que se aplican a UNA línea, no al comprobante entero.
    Van con signo: negativo descuenta, positivo recarga. Cada ajuste guardado es
    de un tipo o del otro: si tiene monto, es en pesos; si no, es en porcentaje."""
    __tablename__ = "ajustes_item"
    id = Column(Integer, primary_key=True)
    nombre = Column(String, nullable=False)             # "Fidelidad", "Pelo largo"...
    porcentaje = Column(Integer, nullable=False)        # -10 descuenta, +15 recarga
    monto = Column(Integer, default=0)                  # -2000 descuenta $2000, +1500 recarga
    activo = Column(Boolean, default=True)