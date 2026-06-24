from fastapi import FastAPI, Depends, HTTPException, Header
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import text, inspect
from pydantic import BaseModel
from datetime import datetime, date, timedelta
from openpyxl import Workbook
import os, bisect, io

from database import get_db, engine, Base
import models
from config_extra import EXTRA_DIFICULTAD, TIPOS_EGRESO
import auth

Base.metadata.create_all(engine)

# mini-migracion: agrega columnas nuevas si faltan (no rompe datos existentes).
# Funciona en SQLite y PostgreSQL: el ALTER TABLE ... ADD COLUMN es compatible con ambos.
def migrar():
    insp = inspect(engine)
    icols = [c["name"] for c in insp.get_columns("items")]
    if "stock_minimo" not in icols:
        with engine.begin() as con:
            con.execute(text("ALTER TABLE items ADD COLUMN stock_minimo INTEGER DEFAULT 0"))
    vcols = [c["name"] for c in insp.get_columns("ventas")]
    if "alias" not in vcols:
        with engine.begin() as con:
            con.execute(text("ALTER TABLE ventas ADD COLUMN alias VARCHAR"))
migrar()

# Auto-siembra al iniciar (idempotente): crea catalogo y usuarios si la base esta vacia
try:
    from seed_datos import seed as _seed
    _seed()
except Exception as _e:
    print('Aviso: no se pudo sembrar al iniciar:', _e)

app = FastAPI(title="Pelu App")

# ---------- esquemas ----------
class LineaIn(BaseModel):
    item_id: int; cantidad: int = 1; dificultad: bool = False
class VentaIn(BaseModel):
    forma_pago: str; alias: str | None = None; lineas: list[LineaIn]
class ItemIn(BaseModel):
    categoria: str; nombre: str; precio: int; es_producto: bool = False
class ItemEdit(BaseModel):
    categoria: str | None = None; nombre: str | None = None; precio: int | None = None; activo: bool | None = None
class RenombrarCat(BaseModel):
    viejo: str; nuevo: str
class FormaIn(BaseModel):
    nombre: str
class EgresoIn(BaseModel):
    tipo: str; concepto: str | None = None; monto: int; forma_pago: str | None = None; notas: str | None = None
class EgresoEdit(BaseModel):
    tipo: str | None = None; concepto: str | None = None; monto: int | None = None
    forma_pago: str | None = None; notas: str | None = None
class StockIn(BaseModel):
    stock_actual: int; stock_minimo: int = 0
class LoginIn(BaseModel):
    usuario: str; password: str
class UsuarioIn(BaseModel):
    usuario: str; password: str; rol: str = "empleado"
class UsuarioEdit(BaseModel):
    usuario: str | None = None; password: str | None = None; rol: str | None = None
class PasswordIn(BaseModel):
    nueva: str
class ExtraIn(BaseModel):
    valor: int
class FondoIn(BaseModel):
    valor: int; fecha: str | None = None
class NombreIn(BaseModel):
    nombre: str

# ---------- auth ----------
def usuario_actual(authorization: str = Header(default="")):
    token = authorization.replace("Bearer ", "").strip()
    payload = auth.verificar_token(token)
    if not payload:
        raise HTTPException(401, "No autorizado")
    return payload

def solo_dueno(user = Depends(usuario_actual)):
    if user.get("rol") != "dueno":
        raise HTTPException(403, "Requiere rol dueño")
    return user

def get_extra(db) -> int:
    c = db.query(models.Config).filter_by(clave="extra_dificultad").first()
    return int(c.valor) if c else 0

def get_fondo(db) -> int:
    c = db.query(models.Config).filter_by(clave="fondo_caja").first()
    return int(c.valor) if c else 0

def get_fondo_dia(db, d) -> int:
    """Fondo del día d. Si ese día no tiene fondo propio, arrastra el último
    cargado en una fecha anterior o igual. Si no hay ninguno, cae al global viejo."""
    iso = d.isoformat()
    f = db.query(models.FondoCaja).filter(models.FondoCaja.fecha == iso).first()
    if f:
        return f.monto
    prev = (db.query(models.FondoCaja)
              .filter(models.FondoCaja.fecha <= iso)
              .order_by(models.FondoCaja.fecha.desc()).first())
    if prev:
        return prev.monto
    return get_fondo(db)

def _puede_modificar(user, fecha) -> bool:
    # el dueño puede modificar cualquier fecha; el empleado solo lo de hoy
    return user.get("rol") == "dueno" or fecha.date() == date.today()

@app.post("/api/login")
def login(datos: LoginIn, db: Session = Depends(get_db)):
    u = db.query(models.Usuario).filter(models.Usuario.usuario == datos.usuario.strip()).first()
    if not u or u.hash != auth.hash_password(datos.password, u.salt):
        raise HTTPException(401, "Usuario o contraseña incorrectos")
    return {"token": auth.crear_token(u.usuario, u.rol), "rol": u.rol, "usuario": u.usuario}

@app.get("/api/yo")
def yo(user = Depends(usuario_actual)):
    return user

@app.post("/api/usuarios")
def crear_usuario(u: UsuarioIn, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    if db.query(models.Usuario).filter(models.Usuario.usuario == u.usuario.strip()).first():
        raise HTTPException(400, "Ese usuario ya existe")
    s = auth.nuevo_salt()
    db.add(models.Usuario(usuario=u.usuario.strip(), salt=s, hash=auth.hash_password(u.password, s), rol=u.rol))
    db.commit(); return {"ok": True}

@app.put("/api/usuarios/password")
def cambiar_password(p: PasswordIn, user = Depends(usuario_actual), db: Session = Depends(get_db)):
    u = db.query(models.Usuario).filter(models.Usuario.usuario == user["usuario"]).first()
    u.salt = auth.nuevo_salt(); u.hash = auth.hash_password(p.nueva, u.salt)
    db.commit(); return {"ok": True}

# ---------- catalogo (lectura: cualquier usuario logueado) ----------
@app.get("/api/categorias")
def categorias(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
    filas = db.query(models.Item.categoria).filter(models.Item.activo == True).distinct().all()
    return sorted([f[0] for f in filas])

@app.get("/api/items")
def items(categoria: str, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    q = db.query(models.Item).filter(models.Item.categoria == categoria, models.Item.activo == True)
    return [{"id": i.id, "nombre": i.nombre, "precio": i.precio, "es_producto": i.es_producto} for i in q]

@app.get("/api/items/all")
def items_all(_ = Depends(solo_dueno), db: Session = Depends(get_db)):
    q = db.query(models.Item).filter(models.Item.activo == True).order_by(models.Item.nombre)
    return [{"id": i.id, "nombre": i.nombre, "precio": i.precio, "categoria": i.categoria,
             "es_producto": i.es_producto} for i in q]

@app.get("/api/catalogo")
def catalogo(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
    """Todo el catálogo activo de una sola vez (para buscador y agrupado en Facturación)."""
    q = (db.query(models.Item).filter(models.Item.activo == True)
           .order_by(models.Item.categoria, models.Item.nombre))
    return [{"id": i.id, "nombre": i.nombre, "precio": i.precio, "categoria": i.categoria,
             "es_producto": i.es_producto} for i in q]

@app.get("/api/config")
def config(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
    formas = [f.nombre for f in db.query(models.FormaPago).filter(models.FormaPago.activo == True)]
    tipos = [t.nombre for t in db.query(models.TipoEgreso).filter(models.TipoEgreso.activo == True)]
    alias = [a.nombre for a in db.query(models.Alias).filter(models.Alias.activo == True)]
    return {"extra_dificultad": get_extra(db), "formas_pago": formas, "tipos_egreso": tipos, "alias": alias}

@app.put("/api/config/extra-dificultad")
def set_extra(datos: ExtraIn, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    c = db.query(models.Config).filter_by(clave="extra_dificultad").first()
    if not c:
        c = models.Config(clave="extra_dificultad"); db.add(c)
    c.valor = str(datos.valor); db.commit()
    return {"ok": True}

@app.put("/api/config/fondo-caja")
def set_fondo(datos: FondoIn, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    iso = (datos.fecha or date.today().isoformat())[:10]
    f = db.query(models.FondoCaja).filter(models.FondoCaja.fecha == iso).first()
    if not f:
        f = models.FondoCaja(fecha=iso); db.add(f)
    f.monto = datos.valor
    db.commit()
    return {"ok": True}

# tipos de egreso
@app.get("/api/tipos-egreso")
def listar_tipos(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
    return [{"id": t.id, "nombre": t.nombre}
            for t in db.query(models.TipoEgreso).filter(models.TipoEgreso.activo == True)]

@app.post("/api/tipos-egreso")
def crear_tipo(t: NombreIn, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    existe = db.query(models.TipoEgreso).filter(models.TipoEgreso.nombre == t.nombre.strip()).first()
    if existe:
        existe.activo = True; db.commit(); return {"id": existe.id}
    nuevo = models.TipoEgreso(nombre=t.nombre.strip())
    db.add(nuevo); db.commit(); db.refresh(nuevo); return {"id": nuevo.id}

@app.delete("/api/tipos-egreso/{tipo_id}")
def borrar_tipo(tipo_id: int, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    t = db.get(models.TipoEgreso, tipo_id)
    if not t: raise HTTPException(404, "Tipo no existe")
    t.activo = False; db.commit(); return {"ok": True}

# usuarios
@app.get("/api/usuarios")
def listar_usuarios(_ = Depends(solo_dueno), db: Session = Depends(get_db)):
    return [{"id": u.id, "usuario": u.usuario, "rol": u.rol} for u in db.query(models.Usuario).all()]

@app.delete("/api/usuarios/{uid}")
def borrar_usuario(uid: int, user = Depends(solo_dueno), db: Session = Depends(get_db)):
    u = db.get(models.Usuario, uid)
    if not u: raise HTTPException(404, "Usuario no existe")
    if u.usuario == user["usuario"]:
        raise HTTPException(400, "No podés borrarte a vos mismo")
    db.delete(u); db.commit(); return {"ok": True}

@app.put("/api/usuarios/{uid}")
def editar_usuario(uid: int, cambios: UsuarioEdit, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    u = db.get(models.Usuario, uid)
    if not u: raise HTTPException(404, "Usuario no existe")
    if cambios.usuario is not None:
        otro = db.query(models.Usuario).filter(models.Usuario.usuario == cambios.usuario.strip(),
                                               models.Usuario.id != uid).first()
        if otro: raise HTTPException(400, "Ese nombre de usuario ya existe")
        u.usuario = cambios.usuario.strip()
    if cambios.rol is not None: u.rol = cambios.rol
    if cambios.password:
        u.salt = auth.nuevo_salt(); u.hash = auth.hash_password(cambios.password, u.salt)
    db.commit(); return {"ok": True}

# alias de transferencia
@app.get("/api/alias")
def listar_alias(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
    return [{"id": a.id, "nombre": a.nombre}
            for a in db.query(models.Alias).filter(models.Alias.activo == True)]

@app.post("/api/alias")
def crear_alias(a: NombreIn, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    existe = db.query(models.Alias).filter(models.Alias.nombre == a.nombre.strip()).first()
    if existe:
        existe.activo = True; db.commit(); return {"id": existe.id}
    nuevo = models.Alias(nombre=a.nombre.strip())
    db.add(nuevo); db.commit(); db.refresh(nuevo); return {"id": nuevo.id}

@app.delete("/api/alias/{alias_id}")
def borrar_alias(alias_id: int, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    a = db.get(models.Alias, alias_id)
    if not a: raise HTTPException(404, "Alias no existe")
    a.activo = False; db.commit(); return {"ok": True}

# ---------- catalogo (admin: solo dueño) ----------
@app.post("/api/items")
def crear_item(item: ItemIn, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    nuevo = models.Item(categoria=item.categoria.strip(), nombre=item.nombre.strip(),
                        precio=item.precio, es_producto=item.es_producto)
    db.add(nuevo); db.commit(); db.refresh(nuevo); return {"id": nuevo.id}

@app.put("/api/items/{item_id}")
def editar_item(item_id: int, cambios: ItemEdit, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    item = db.get(models.Item, item_id)
    if not item: raise HTTPException(404, "Item no existe")
    if cambios.categoria is not None: item.categoria = cambios.categoria.strip()
    if cambios.nombre is not None: item.nombre = cambios.nombre.strip()
    if cambios.precio is not None: item.precio = cambios.precio
    if cambios.activo is not None: item.activo = cambios.activo
    db.commit(); return {"ok": True}

@app.delete("/api/items/{item_id}")
def borrar_item(item_id: int, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    item = db.get(models.Item, item_id)
    if not item: raise HTTPException(404, "Item no existe")
    item.activo = False; db.commit(); return {"ok": True}

@app.put("/api/categorias")
def renombrar_categoria(datos: RenombrarCat, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    n = db.query(models.Item).filter(models.Item.categoria == datos.viejo).update(
        {models.Item.categoria: datos.nuevo.strip()})
    db.commit(); return {"actualizados": n}

# ---------- formas de pago ----------
@app.get("/api/formas")
def listar_formas(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
    return [{"id": f.id, "nombre": f.nombre}
            for f in db.query(models.FormaPago).filter(models.FormaPago.activo == True)]

@app.post("/api/formas")
def crear_forma(forma: FormaIn, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    existe = db.query(models.FormaPago).filter(models.FormaPago.nombre == forma.nombre.strip()).first()
    if existe: existe.activo = True; db.commit(); return {"id": existe.id}
    nueva = models.FormaPago(nombre=forma.nombre.strip())
    db.add(nueva); db.commit(); db.refresh(nueva); return {"id": nueva.id}

@app.delete("/api/formas/{forma_id}")
def borrar_forma(forma_id: int, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    f = db.get(models.FormaPago, forma_id)
    if not f: raise HTTPException(404, "Forma no existe")
    f.activo = False; db.commit(); return {"ok": True}

# ---------- ventas (cualquier usuario logueado) ----------
@app.post("/api/ventas")
def crear_venta(venta: VentaIn, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    if not venta.lineas: raise HTTPException(400, "La venta no tiene lineas")
    v = models.Venta(forma_pago=venta.forma_pago, alias=venta.alias, fecha=datetime.now())
    db.add(v); db.flush(); total = 0
    extra = get_extra(db)
    for ln in venta.lineas:
        item = db.get(models.Item, ln.item_id)
        if not item: raise HTTPException(404, f"Item {ln.item_id} no existe")
        base = item.precio * ln.cantidad
        if venta.forma_pago == "Efectivo":
            base = round(base * 0.9)
        sub = base + (extra if ln.dificultad else 0)
        total += sub
        db.add(models.VentaLinea(venta_id=v.id, item_id=item.id, nombre=item.nombre,
                                 cantidad=ln.cantidad, precio_unit=item.precio,
                                 dificultad=ln.dificultad, subtotal=sub))
        if item.es_producto and item.stock_actual is not None:
            item.stock_actual -= ln.cantidad
    v.total = total; db.commit(); db.refresh(v)
    return {"id": v.id, "total": v.total, "fecha": v.fecha.isoformat()}

def _venta_detalle(v):
    return {"id": v.id, "hora": v.fecha.strftime("%H:%M"), "total": v.total,
            "forma_pago": v.forma_pago, "alias": v.alias,
            "lineas": [{"nombre": l.nombre, "cantidad": l.cantidad, "subtotal": l.subtotal} for l in v.lineas]}

@app.get("/api/ventas/dia")
def ventas_dia(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
    ini, fin = _rango_dia(date.today())
    vs = db.query(models.Venta).filter(models.Venta.fecha >= ini, models.Venta.fecha < fin
         ).order_by(models.Venta.id.desc()).all()
    return [_venta_detalle(v) for v in vs]

@app.delete("/api/ventas/{venta_id}")
def anular_venta(venta_id: int, user = Depends(usuario_actual), db: Session = Depends(get_db)):
    v = db.get(models.Venta, venta_id)
    if not v: raise HTTPException(404, "Venta no existe")
    if not _puede_modificar(user, v.fecha):
        raise HTTPException(403, "Solo el dueño puede anular ventas de otros días")
    for l in v.lineas:  # devolver stock de productos
        if l.item_id:
            it = db.get(models.Item, l.item_id)
            if it and it.es_producto and it.stock_actual is not None:
                it.stock_actual += l.cantidad
    db.delete(v); db.commit()
    return {"ok": True}

# ---------- egresos ----------
@app.post("/api/egresos")
def crear_egreso(e: EgresoIn, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    eg = models.Egreso(tipo=e.tipo, concepto=e.concepto, monto=e.monto,
                       forma_pago=e.forma_pago, notas=e.notas, fecha=datetime.now())
    db.add(eg); db.commit(); db.refresh(eg); return {"id": eg.id}

@app.get("/api/egresos/dia")
def egresos_dia(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
    ini, fin = _rango_dia(date.today())
    es = db.query(models.Egreso).filter(models.Egreso.fecha >= ini, models.Egreso.fecha < fin
         ).order_by(models.Egreso.id.desc()).all()
    return [{"id": e.id, "hora": e.fecha.strftime("%H:%M"), "tipo": e.tipo, "concepto": e.concepto,
             "monto": e.monto, "forma_pago": e.forma_pago} for e in es]

@app.put("/api/egresos/{egreso_id}")
def editar_egreso(egreso_id: int, cambios: EgresoEdit, user = Depends(usuario_actual), db: Session = Depends(get_db)):
    e = db.get(models.Egreso, egreso_id)
    if not e: raise HTTPException(404, "Egreso no existe")
    if not _puede_modificar(user, e.fecha):
        raise HTTPException(403, "Solo el dueño puede editar egresos de otros días")
    if cambios.tipo is not None: e.tipo = cambios.tipo
    if cambios.concepto is not None: e.concepto = cambios.concepto
    if cambios.monto is not None: e.monto = cambios.monto
    if cambios.forma_pago is not None: e.forma_pago = cambios.forma_pago
    if cambios.notas is not None: e.notas = cambios.notas
    db.commit(); return {"ok": True}

@app.delete("/api/egresos/{egreso_id}")
def anular_egreso(egreso_id: int, user = Depends(usuario_actual), db: Session = Depends(get_db)):
    e = db.get(models.Egreso, egreso_id)
    if not e: raise HTTPException(404, "Egreso no existe")
    if not _puede_modificar(user, e.fecha):
        raise HTTPException(403, "Solo el dueño puede anular egresos de otros días")
    db.delete(e); db.commit(); return {"ok": True}

# ---------- caja (solo dueño) ----------
def _rango_dia(d): ini = datetime(d.year, d.month, d.day); return ini, ini + timedelta(days=1)
def _sv(db, i, f): return sum(v.total for v in db.query(models.Venta).filter(models.Venta.fecha >= i, models.Venta.fecha < f))
def _se(db, i, f): return sum((e.monto or 0) for e in db.query(models.Egreso).filter(models.Egreso.fecha >= i, models.Egreso.fecha < f))

@app.get("/api/caja/dia")
def caja_dia(fecha: str | None = None, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    d = date.fromisoformat(fecha) if fecha else date.today()
    ini, fin = _rango_dia(d)
    ventas = db.query(models.Venta).filter(models.Venta.fecha >= ini, models.Venta.fecha < fin).all()
    egresos = db.query(models.Egreso).filter(models.Egreso.fecha >= ini, models.Egreso.fecha < fin).all()
    ing = sum(v.total for v in ventas); egr = sum((e.monto or 0) for e in egresos)
    por_pago = {}; por_tipo = {}
    for v in ventas: por_pago[v.forma_pago] = por_pago.get(v.forma_pago, 0) + v.total
    for e in egresos: por_tipo[e.tipo] = por_tipo.get(e.tipo, 0) + (e.monto or 0)
    efectivo_ventas = sum(v.total for v in ventas if v.forma_pago == "Efectivo")
    efectivo_egresos = sum((e.monto or 0) for e in egresos if e.forma_pago == "Efectivo")
    fondo = get_fondo_dia(db, d)
    return {"fecha": d.isoformat(), "ingresos": ing, "egresos": egr, "neto": ing - egr,
            "ventas": len(ventas), "ingresos_por_pago": por_pago, "egresos_por_tipo": por_tipo,
            "fondo": fondo, "efectivo_ventas": efectivo_ventas, "efectivo_egresos": efectivo_egresos,
            "efectivo_esperado": fondo + efectivo_ventas - efectivo_egresos,
            "ventas_detalle": [_venta_detalle(v) for v in ventas],
            "egresos_detalle": [{"id": e.id, "hora": e.fecha.strftime("%H:%M"), "tipo": e.tipo,
                                 "concepto": e.concepto, "monto": e.monto, "forma_pago": e.forma_pago}
                                for e in egresos]}

@app.get("/api/caja/diario")
def caja_diario(dias: int = 14, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    hoy = date.today(); out = []
    for i in range(dias):
        d = hoy - timedelta(days=i); ini, fin = _rango_dia(d)
        ing = _sv(db, ini, fin); egr = _se(db, ini, fin)
        out.append({"fecha": d.isoformat(), "ingresos": ing, "egresos": egr, "neto": ing - egr})
    return out

@app.get("/api/caja/semanal")
def caja_semanal(semanas: int = 8, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    hoy = date.today(); lunes = hoy - timedelta(days=hoy.weekday()); out = []
    for i in range(semanas):
        ini_d = lunes - timedelta(weeks=i)
        ini = datetime(ini_d.year, ini_d.month, ini_d.day); fin = ini + timedelta(days=7)
        ing = _sv(db, ini, fin); egr = _se(db, ini, fin)
        out.append({"semana_desde": ini_d.isoformat(), "ingresos": ing, "egresos": egr, "neto": ing - egr})
    return out

# ---------- inventario (solo dueño) ----------
@app.get("/api/inventario")
def inventario(_ = Depends(solo_dueno), db: Session = Depends(get_db)):
    prods = db.query(models.Item).filter(models.Item.es_producto == True, models.Item.activo == True).all()
    out = []
    for p in prods:
        sa = p.stock_actual or 0; sm = p.stock_minimo or 0
        out.append({"id": p.id, "nombre": p.nombre, "stock_actual": sa, "stock_minimo": sm,
                    "reponer": sa <= sm})
    return sorted(out, key=lambda x: x["nombre"])

@app.put("/api/inventario/{item_id}")
def set_stock(item_id: int, s: StockIn, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    item = db.get(models.Item, item_id)
    if not item or not item.es_producto: raise HTTPException(404, "Producto no existe")
    item.stock_actual = s.stock_actual; item.stock_minimo = s.stock_minimo
    db.commit(); return {"ok": True}

# ---------- reportes (solo dueño) ----------
def _ventana(dias: int, desde: str | None, hasta: str | None):
    # Si hay rango, lo usa. Si no, últimos `dias`. Si dias<=0, todo el historial.
    if desde or hasta:
        ini = datetime.fromisoformat(desde) if desde else None
        fin = (datetime.fromisoformat(hasta) + timedelta(days=1)) if hasta else None
        return ini, fin
    if dias and dias > 0:
        return datetime.now() - timedelta(days=dias), None
    return None, None

def _filtrar(query, col, ini, fin):
    if ini is not None: query = query.filter(col >= ini)
    if fin is not None: query = query.filter(col < fin)
    return query

@app.get("/api/reportes/resumen")
def rep_resumen(dias: int = 30, desde: str | None = None, hasta: str | None = None,
                _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    ini, fin = _ventana(dias, desde, hasta)
    ventas = _filtrar(db.query(models.Venta), models.Venta.fecha, ini, fin).all()
    egresos = _filtrar(db.query(models.Egreso), models.Egreso.fecha, ini, fin).all()
    ing = sum(v.total for v in ventas); egr = sum((e.monto or 0) for e in egresos)
    n = len(ventas)
    return {"ingresos": ing, "egresos": egr, "neto": ing - egr,
            "ventas": n, "ticket_promedio": round(ing / n) if n else 0}

@app.get("/api/reportes/top-items")
def rep_top(dias: int = 30, limite: int = 10, desde: str | None = None, hasta: str | None = None,
            _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    ini, fin = _ventana(dias, desde, hasta)
    lineas = _filtrar(db.query(models.VentaLinea).join(models.Venta), models.Venta.fecha, ini, fin).all()
    agg = {}
    for l in lineas:
        a = agg.setdefault(l.nombre, {"nombre": l.nombre, "cantidad": 0, "total": 0})
        a["cantidad"] += l.cantidad; a["total"] += (l.subtotal or 0)
    return sorted(agg.values(), key=lambda x: x["total"], reverse=True)[:limite]

@app.get("/api/reportes/por-categoria")
def rep_categoria(dias: int = 30, desde: str | None = None, hasta: str | None = None,
                  _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    ini, fin = _ventana(dias, desde, hasta)
    q = db.query(models.VentaLinea, models.Item.categoria).join(models.Venta).outerjoin(
        models.Item, models.VentaLinea.item_id == models.Item.id)
    lineas = _filtrar(q, models.Venta.fecha, ini, fin).all()
    agg = {}
    for l, cat in lineas:
        cat = cat or "Otros"
        agg[cat] = agg.get(cat, 0) + (l.subtotal or 0)
    return sorted([{"categoria": k, "total": v} for k, v in agg.items()], key=lambda x: x["total"], reverse=True)

@app.get("/api/reportes/excel")
def reportes_excel(dias: int = 30, desde: str | None = None, hasta: str | None = None,
                   _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    wb = Workbook()
    ws = wb.active
    ws.title = "Movimientos"
    
    # encabezados
    ws.append(["Fecha", "Hora", "Tipo", "Detalle", "Forma de pago", "Monto"])

    # traigo los movimientos reales reusando la misma lógica que el registro de pantalla
    ini, fin = _resolver_ventana(dias, desde, hasta, db)
    ventas = db.query(models.Venta).filter(models.Venta.fecha >= ini, models.Venta.fecha < fin).all()
    egresos = db.query(models.Egreso).filter(models.Egreso.fecha >= ini, models.Egreso.fecha < fin).all()

    movimientos = []
    for v in ventas:
        detalle = ", ".join(f"{l.cantidad}x {l.nombre}" for l in v.lineas)
        movimientos.append((v.fecha, "Venta", detalle, v.forma_pago or "", v.total or 0))
    for e in egresos:
        detalle = f"{e.tipo or ''} - {e.concepto or ''}".strip(" -")
        movimientos.append((e.fecha, "Egreso", detalle, e.forma_pago or "", -(e.monto or 0)))

    # ordeno por fecha
    movimientos.sort(key=lambda m: m[0])

    # escribo cada fila
    for fecha, tipo, detalle, pago, monto in movimientos:
        ws.append([fecha.strftime("%d/%m/%Y"), fecha.strftime("%H:%M"), tipo, detalle, pago, monto])

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)

    return StreamingResponse(
        buffer,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=reportes.xlsx"})

# ---------- series temporales (para gráficos de línea) ----------
def _resolver_ventana(dias, desde, hasta, db):
    """Devuelve (ini, fin) concretos (datetime) para filtrar y bucketizar."""
    if desde or hasta:
        ini = datetime.fromisoformat(desde) if desde else None
        fin = (datetime.fromisoformat(hasta) + timedelta(days=1)) if hasta else None
    elif dias and dias > 0:
        ini, fin = datetime.now() - timedelta(days=dias), None
    else:
        ini, fin = None, None
    if ini is None:
        primera = db.query(models.Venta).order_by(models.Venta.fecha.asc()).first()
        ini = primera.fecha if primera else datetime.now() - timedelta(days=30)
    if fin is None:
        fin = datetime.now() + timedelta(days=1)
    if fin <= ini:
        fin = ini + timedelta(days=1)
    return ini, fin

def _buckets(ini, fin):
    """Lista de (inicio, fin_excl, etiqueta) y la granularidad elegida por el span."""
    span = (fin - ini).days
    out = []
    if span <= 31:
        gran = "dia"; d = datetime(ini.year, ini.month, ini.day)
        while d < fin:
            nd = d + timedelta(days=1); out.append((d, nd, d.strftime("%d/%m"))); d = nd
    elif span <= 130:
        gran = "semana"; d = datetime(ini.year, ini.month, ini.day)
        d = d - timedelta(days=d.weekday())   # lunes de esa semana
        while d < fin:
            nd = d + timedelta(days=7); out.append((d, nd, d.strftime("%d/%m"))); d = nd
    else:
        gran = "mes"; d = datetime(ini.year, ini.month, 1)
        while d < fin:
            nd = datetime(d.year + 1, 1, 1) if d.month == 12 else datetime(d.year, d.month + 1, 1)
            out.append((d, nd, d.strftime("%m/%Y"))); d = nd
    if not out:
        out = [(ini, fin, ini.strftime("%d/%m"))]; gran = "dia"
    return out, gran

def _serie(filas, etiqueta_de, metrica, limite, buckets):
    """filas: lista de (linea, fecha, clave). Arma top N por métrica y su serie por bucket."""
    starts = [b[0] for b in buckets]
    val = (lambda l: (l.cantidad or 0)) if metrica == "cantidad" else (lambda l: (l.subtotal or 0))
    totales = {}
    for l, f, clave in filas:
        totales[clave] = totales.get(clave, 0) + val(l)
    lim = max(1, min(int(limite or 3), 15))
    top = sorted(totales, key=lambda k: totales[k], reverse=True)[:lim]
    topset = set(top)
    series = {n: [0] * len(buckets) for n in top}
    for l, f, clave in filas:
        if clave not in topset:
            continue
        i = bisect.bisect_right(starts, f) - 1
        if i < 0 or i >= len(buckets) or f >= buckets[i][1]:
            continue
        series[clave][i] += val(l)
    return [{"nombre": n, "valores": series[n], "total": totales[n]} for n in top]

@app.get("/api/reportes/serie-items")
def serie_items(dias: int = 30, limite: int = 3, metrica: str = "ingreso",
                desde: str | None = None, hasta: str | None = None,
                _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    ini, fin = _resolver_ventana(dias, desde, hasta, db)
    buckets, gran = _buckets(ini, fin)
    q = (db.query(models.VentaLinea, models.Venta.fecha).join(models.Venta)
           .filter(models.Venta.fecha >= ini, models.Venta.fecha < fin))
    filas = [(l, f, l.nombre) for l, f in q.all()]
    return {"buckets": [b[2] for b in buckets], "granularidad": gran, "metrica": metrica,
            "series": _serie(filas, None, metrica, limite, buckets)}

@app.get("/api/reportes/serie-categorias")
def serie_categorias(dias: int = 30, limite: int = 3, metrica: str = "ingreso",
                     desde: str | None = None, hasta: str | None = None,
                     _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    ini, fin = _resolver_ventana(dias, desde, hasta, db)
    buckets, gran = _buckets(ini, fin)
    q = (db.query(models.VentaLinea, models.Venta.fecha, models.Item.categoria)
           .join(models.Venta)
           .outerjoin(models.Item, models.VentaLinea.item_id == models.Item.id)
           .filter(models.Venta.fecha >= ini, models.Venta.fecha < fin))
    filas = [(l, f, cat or "Otros") for l, f, cat in q.all()]
    return {"buckets": [b[2] for b in buckets], "granularidad": gran, "metrica": metrica,
            "series": _serie(filas, None, metrica, limite, buckets)}

@app.get("/api/ventas/registro")
def ventas_registro(desde: str | None = None, hasta: str | None = None,
                    _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    ini, fin = _ventana(0, desde, hasta)  # sin rango => desde el origen
    q = _filtrar(db.query(models.Venta), models.Venta.fecha, ini, fin)
    vs = q.order_by(models.Venta.fecha.desc()).limit(1000).all()
    out = []
    for v in vs:
        d = _venta_detalle(v)
        d["fecha"] = v.fecha.strftime("%d/%m/%Y")
        out.append(d)
    return out

@app.get("/api/registro")
def registro_movimientos(desde: str | None = None, hasta: str | None = None,
                         _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    ini, fin = _ventana(0, desde, hasta)
    ventas = _filtrar(db.query(models.Venta), models.Venta.fecha, ini, fin).all()
    egresos = _filtrar(db.query(models.Egreso), models.Egreso.fecha, ini, fin).all()
    movs = []
    for v in ventas:
        movs.append({"_orden": v.fecha.isoformat(), "fecha": v.fecha.strftime("%d/%m/%Y"),
                     "hora": v.fecha.strftime("%H:%M"), "clase": "venta",
                     "detalle": ", ".join(f"{l.cantidad}× {l.nombre}" for l in v.lineas),
                     "forma_pago": v.forma_pago + (f" ({v.alias})" if v.alias else ""), "monto": v.total})
    for e in egresos:
        det = (e.tipo or "")
        if e.concepto: det += f" — {e.concepto}"
        movs.append({"_orden": e.fecha.isoformat(), "fecha": e.fecha.strftime("%d/%m/%Y"),
                     "hora": e.fecha.strftime("%H:%M"), "clase": "egreso",
                     "detalle": det, "forma_pago": e.forma_pago or "", "monto": e.monto or 0})
    movs.sort(key=lambda m: m["_orden"], reverse=True)
    for m in movs: del m["_orden"]
    return movs[:1000]


# ---------- backup completo (solo dueño) ----------
@app.get("/api/backup")
def backup_completo(_ = Depends(solo_dueno), db: Session = Depends(get_db)):
    """Descarga un JSON con TODAS las tablas para backup offline."""
    import json as _json

    data = {
        "fecha_backup": datetime.now().isoformat(),
        "items": [
            {"id": i.id, "categoria": i.categoria, "nombre": i.nombre, "precio": i.precio,
             "es_producto": i.es_producto, "stock_actual": i.stock_actual,
             "stock_minimo": i.stock_minimo, "activo": i.activo}
            for i in db.query(models.Item).all()
        ],
        "ventas": [
            {"id": v.id, "fecha": v.fecha.isoformat(), "forma_pago": v.forma_pago,
             "alias": v.alias, "total": v.total,
             "lineas": [
                 {"id": l.id, "item_id": l.item_id, "nombre": l.nombre,
                  "cantidad": l.cantidad, "precio_unit": l.precio_unit,
                  "dificultad": l.dificultad, "subtotal": l.subtotal}
                 for l in v.lineas
             ]}
            for v in db.query(models.Venta).order_by(models.Venta.fecha).all()
        ],
        "egresos": [
            {"id": e.id, "fecha": e.fecha.isoformat(), "tipo": e.tipo,
             "concepto": e.concepto, "monto": e.monto,
             "forma_pago": e.forma_pago, "notas": e.notas}
            for e in db.query(models.Egreso).order_by(models.Egreso.fecha).all()
        ],
        "formas_pago": [
            {"id": f.id, "nombre": f.nombre, "activo": f.activo}
            for f in db.query(models.FormaPago).all()
        ],
        "tipos_egreso": [
            {"id": t.id, "nombre": t.nombre, "activo": t.activo}
            for t in db.query(models.TipoEgreso).all()
        ],
        "usuarios": [
            {"id": u.id, "usuario": u.usuario, "rol": u.rol,
             "salt": u.salt, "hash": u.hash}
            for u in db.query(models.Usuario).all()
        ],
        "config": [
            {"clave": c.clave, "valor": c.valor}
            for c in db.query(models.Config).all()
        ],
        "fondo_caja": [
            {"fecha": f.fecha, "monto": f.monto}
            for f in db.query(models.FondoCaja).all()
        ],
        "alias": [
            {"id": a.id, "nombre": a.nombre, "activo": a.activo}
            for a in db.query(models.Alias).all()
        ],
    }

    contenido = _json.dumps(data, ensure_ascii=False, indent=2)
    buffer = io.BytesIO(contenido.encode("utf-8"))
    nombre = f"backup_pelu_{datetime.now().strftime('%Y%m%d_%H%M')}.json"

    return StreamingResponse(
        buffer,
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename={nombre}"})

# ---------- frontend ----------
if os.path.isdir("static"):
    @app.get("/login")
    def p_login(): return FileResponse("static/login.html")
    @app.get("/")
    def p_root(): return FileResponse("static/index.html")
    @app.get("/admin")
    def p_admin(): return FileResponse("static/admin.html")
    @app.get("/caja")
    def p_caja(): return FileResponse("static/caja.html")
    @app.get("/inventario")
    def p_inv(): return FileResponse("static/inventario.html")
    @app.get("/reportes")
    def p_rep(): return FileResponse("static/reportes.html")
    app.mount("/static", StaticFiles(directory="static"), name="static")
