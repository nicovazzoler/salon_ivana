from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Numeric
from sqlalchemy.orm import relationship
from datetime import datetime
from database import Base

class Item(Base):
    """Cada cosa vendible: servicio, producto o servicio de peluqueria."""
    __tablename__ = "items"
    id = Column(Integer, primary_key=True)
    categoria = Column(String, nullable=False, index=True)
    nombre = Column(String, nullable=False)
    precio = Column(Integer, nullable=False)
    es_producto = Column(Boolean, default=False)
    stock_actual = Column(Integer, default=0)   # solo aplica a productos
    stock_minimo = Column(Integer, default=0)
    activo = Column(Boolean, default=True)

class Venta(Base):
    """Cabecera de una venta (puede tener varias lineas)."""
    __tablename__ = "ventas"
    id = Column(Integer, primary_key=True)
    fecha = Column(DateTime, default=datetime.now)
    forma_pago = Column(String)
    alias = Column(String)        # alias de transferencia (opcional)
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
    fecha = Column(DateTime, default=datetime.now)
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
