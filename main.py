from fastapi import FastAPI, Depends, HTTPException, Header, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import text, inspect, func
from pydantic import BaseModel
from datetime import datetime, date, timedelta, timezone
from openpyxl import Workbook
import os
import re, bisect, io, time, hmac

from database import get_db, engine, Base
import models
from config_extra import TIPOS_EGRESO, NEGOCIO
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
    if "cliente" not in vcols:
        with engine.begin() as con:
            con.execute(text("ALTER TABLE ventas ADD COLUMN cliente VARCHAR"))
    if "peluquero" not in vcols:
        with engine.begin() as con:
            con.execute(text("ALTER TABLE ventas ADD COLUMN peluquero VARCHAR"))
    lcols = [c["name"] for c in insp.get_columns("comprobante_lineas")]
    if "precio_efectivo" not in lcols:
        with engine.begin() as con:
            con.execute(text("ALTER TABLE comprobante_lineas ADD COLUMN precio_efectivo INTEGER"))
    if "ajuste_pct" not in lcols:
        with engine.begin() as con:
            con.execute(text("ALTER TABLE comprobante_lineas ADD COLUMN ajuste_pct INTEGER DEFAULT 0"))
    if "ajuste_nombre" not in lcols:
        with engine.begin() as con:
            con.execute(text("ALTER TABLE comprobante_lineas ADD COLUMN ajuste_nombre VARCHAR"))
    if "ajuste_monto" not in lcols:
        with engine.begin() as con:
            con.execute(text("ALTER TABLE comprobante_lineas ADD COLUMN ajuste_monto INTEGER DEFAULT 0"))
    acols = [c["name"] for c in insp.get_columns("ajustes_item")]
    if "monto" not in acols:
        with engine.begin() as con:
            con.execute(text("ALTER TABLE ajustes_item ADD COLUMN monto INTEGER DEFAULT 0"))
    pcols = [c["name"] for c in insp.get_columns("pagos")]
    if "saldado" not in pcols:
        with engine.begin() as con:
            con.execute(text("ALTER TABLE pagos ADD COLUMN saldado INTEGER"))
    ccols = [c["name"] for c in insp.get_columns("comprobantes")]
    if "forma_pago" not in ccols:
        with engine.begin() as con:
            con.execute(text("ALTER TABLE comprobantes ADD COLUMN forma_pago VARCHAR"))
    if "cargado" not in ccols:
        with engine.begin() as con:
            con.execute(text("ALTER TABLE comprobantes ADD COLUMN cargado TIMESTAMP"))
            # En los que ya existen, se cargó el mismo día que se hizo: sin esto
            # todos los comprobantes viejos parecerían "anotados después".
            con.execute(text("UPDATE comprobantes SET cargado = fecha WHERE cargado IS NULL"))
    clcols = [c["name"] for c in insp.get_columns("clientes")]
    if "direccion" not in clcols:
        with engine.begin() as con:
            con.execute(text("ALTER TABLE clientes ADD COLUMN direccion VARCHAR"))
    if "dni" not in clcols:
        with engine.begin() as con:
            con.execute(text("ALTER TABLE clientes ADD COLUMN dni VARCHAR"))
    
migrar()

# Auto-siembra al iniciar (idempotente): crea catalogo y usuarios si la base esta vacia
try:
    from seed_datos import seed as _seed
    _seed()
except Exception as _e:
    print('Aviso: no se pudo sembrar al iniciar:', _e)

app = FastAPI(title="Pelu App")

# ---------- caché del navegador ----------
# Sin una cabecera Cache-Control, el navegador NO pregunta si el archivo cambió:
# adivina cuánto sigue fresco (suele ser una fracción del tiempo desde la última
# modificación) y hasta entonces sirve lo que tiene guardado. En la tablet del
# local, que queda abierta días entre reinicios, eso significa seguir usando el
# HTML, el CSS y el JS de la versión anterior aunque el servidor ya tenga otra.
#
# Se responde distinto según el archivo:
#   - páginas, CSS y JS: "no-cache" NO quiere decir "no lo guardes", quiere decir
#     "guardalo pero preguntá siempre". Con el ETag que ya manda StaticFiles, esa
#     pregunta se contesta con un 304 vacío: es barato y garantiza que un deploy
#     se ve enseguida.
#   - tipografías e ícono: no cambian nunca, así que se guardan un año y no se
#     vuelven a pedir. Si alguna vez cambian, cambia el nombre del archivo.
CACHE_LARGO = ("/static/fonts/", "/static/favicon")

@app.middleware("http")
async def cabeceras_de_cache(request, call_next):
    resp = await call_next(request)
    ruta = request.url.path
    if ruta.startswith("/api/"):
        return resp
    if ruta.startswith(CACHE_LARGO):
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif ruta.startswith("/static/") or resp.headers.get("content-type", "").startswith("text/html"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp

# ---------- esquemas ----------
# Nota: la tabla `ventas` es del diseño viejo, anterior a los comprobantes. Ya no se
# escribe y sus endpoints se sacaron, pero los modelos quedan para que el backup
# siga levantando las filas históricas si alguna base todavía las tiene.
class ClienteIn(BaseModel):
    nombre: str; telefono: str | None = None; alias: str | None = None; notas: str | None = None; direccion: str | None = None; dni: str | None = None
class ClienteEdit(BaseModel):
    nombre: str | None = None; telefono: str | None = None; alias: str | None = None; notas: str | None = None; activo: bool | None = None; direccion: str | None = None; dni: str | None = None
class ItemIn(BaseModel):
    categoria: str; nombre: str; precio: int; es_producto: bool = False
class ItemEdit(BaseModel):
    categoria: str | None = None; nombre: str | None = None; precio: int | None = None; activo: bool | None = None
class RenombrarCat(BaseModel):
    viejo: str; nuevo: str
class LineaCompIn(BaseModel):
    item_id: int | None = None; cantidad: int = 1; precio_custom: int | None = None; nombre: str | None = None
    ajuste_pct: int = 0                      # ajuste de esta línea, con signo: -10 descuenta, +15 recarga
    ajuste_monto: int = 0                    # o en pesos por unidad: -2000 descuenta, +1500 recarga
    ajuste_nombre: str | None = None         # motivo, si salió de la lista de ajustes
class ExtraIn(BaseModel):
    concepto: str; monto: int
class ComprobanteIn(BaseModel):
    tipo: str; cliente_id: int | None = None; cliente_nombre: str | None = None; peluquero: str | None = None
    forma_pago: str = "efectivo"
    descuento_pct: int = 0; descuento_nombre: str | None = None; mostrar_motivo: bool = False
    fecha: str | None = None              # 'YYYY-MM-DD' argentino: para anotar un servicio de otro día
    lineas: list[LineaCompIn]
    extras: list[ExtraIn] = []            # cargos que ningún descuento toca
class PagoIn(BaseModel):
    monto: int; forma_pago: str; alias: str | None = None; saldado: int | None = None
    # True = este abono cierra la venta, así que la plata pertenece al día del
    # servicio. False = está saldando una deuda vieja, y entra el día de hoy.
    del_servicio: bool = False
class FormaIn(BaseModel):
    nombre: str
class DescuentoIn(BaseModel):
    nombre: str; porcentaje: int; mostrar_motivo: bool = False
class AjusteItemIn(BaseModel):
    nombre: str; porcentaje: int = 0      # con signo: negativo descuenta, positivo recarga
    monto: int = 0                        # o en pesos por unidad, también con signo
class DescuentoEdit(BaseModel):
    nombre: str | None = None; porcentaje: int | None = None
    mostrar_motivo: bool | None = None; activo: bool | None = None
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
class FondoIn(BaseModel):
    valor: int; fecha: str | None = None
class NombreIn(BaseModel):
    nombre: str
class TurnoIn(BaseModel):
    fecha: str | None = None; hora: str; cliente: str; cliente_id: int | None = None; servicio: str; peluquero: str | None = None; notas: str | None = None
class NotaIn(BaseModel):
    texto: str; fecha: str | None = None

# ---------- Huso horario ----------

"""Zona horaria.

   Todo se guarda en UTC, pero el negocio vive en Argentina: cuando el local
   dice "hoy", habla del día argentino. Argentina está en UTC-3 todo el año
   (no tiene horario de verano), así que alcanza con un corrimiento fijo.

   Esto importa más de lo que parece: el servidor corre en UTC, así que a
   partir de las 21:00 argentinas el servidor YA está en el día siguiente. Un
   egreso cargado a las 21:23 de un martes se contaba en la caja del miércoles.
"""
HORAS_ARG = 3
# El huso, para cuando hay que ESCRIBIR una fecha argentina con su offset a la
# vista. hora_argentina() resta las horas pero no toca el tzinfo, que es lo que
# quiere casi todo el código; acá el -03:00 tiene que quedar escrito.
ARGENTINA = timezone(timedelta(hours=-HORAS_ARG))

def fecha_hora_now_utc():
    return datetime.now(timezone.utc)

def hora_argentina(dt):
    return dt - timedelta(hours=HORAS_ARG)

def hoy_argentina():
    """La fecha de hoy EN EL LOCAL, no la del servidor."""
    return hora_argentina(fecha_hora_now_utc()).date()

_SEPARA_PALABRA = re.compile(r"([^\W\d_]+)", re.UNICODE)

# Partículas que en castellano van en minúscula dentro de un nombre: se escribe
# "María de los Ángeles", no "María De Los Ángeles". Nunca se aplica a la
# primera palabra: "De Luca" como apellido sí lleva mayúscula.
_PARTICULAS = {"de", "del", "la", "las", "los", "y", "e", "da", "das", "do",
               "dos", "van", "von", "di", "der", "el"}

def nombre_propio(s: str) -> str:
    """Cada palabra con la inicial en mayúscula, salvo las partículas.

    Se normaliza al GUARDAR, no solo al mostrar: los nombres se tipean apurado
    entre cliente y cliente y quedaban como "MARIA lopez" o "maria LOPEZ", y
    después el mismo cliente aparecía escrito de tres formas distintas.

    No se usa str.title() de Python porque parte también en los apóstrofos:
    "o'brien" saldría "O'Brien" (bien) pero cualquier palabra con apóstrofo
    interno queda cortada. Acá se parte solo por letras, así que los guiones y
    apóstrofos no rompen nada.
    """
    if not s:
        return s
    limpio = " ".join(s.split())      # de paso, espacios dobles al tipear apurado
    primera = [True]                  # la primera palabra siempre va en mayúscula

    def cap(m):
        pal = m.group(1)
        arranque = primera[0]
        primera[0] = False
        if not arranque and pal.lower() in _PARTICULAS:
            return pal.lower()
        return pal[:1].upper() + pal[1:].lower()

    return _SEPARA_PALABRA.sub(cap, limpio)

# Un paréntesis AL FINAL del nombre: "Mónica (mamá de Sofía)" → "Mónica" + "mamá de Sofía".
_COLA_PARENTESIS = re.compile(r"\s*\(([^()]*)\)\s*$")

def migrar_notas_entre_parentesis():
    """Saca del nombre el aclarador entre paréntesis y lo pasa a las notas.

    Hasta que existió el campo de notas, la única forma de anotar "es la mamá de
    Sofía" era meterlo adentro del nombre. Eso ensucia el buscador, el historial y
    el papel impreso, que terminan diciendo "Mónica (mamá de Sofía)".

    Corre UNA sola vez y deja la marca en config: si después alguien escribe un
    paréntesis a propósito, el próximo reinicio no se lo borra. Solo mueve el
    paréntesis que está al final y solo si no está ya en las notas, así que
    volver a correrla no duplica nada.
    """
    MARCA = "migro_notas_parentesis"
    from sqlalchemy.orm import Session as _S
    with _S(engine) as db:
        if db.query(models.Config).filter_by(clave=MARCA).first():
            return
        movidos = 0
        for cli in db.query(models.Cliente).filter(models.Cliente.nombre.like("%(%")):
            m = _COLA_PARENTESIS.search(cli.nombre or "")
            if not m:
                continue
            aclaracion = m.group(1).strip()
            limpio = _COLA_PARENTESIS.sub("", cli.nombre).strip()
            if not aclaracion or not limpio:
                continue          # "(sin nombre)" o similar: mejor no tocarlo
            previas = (cli.notas or "").strip()
            if aclaracion.lower() not in previas.lower():
                cli.notas = f"{previas} · {aclaracion}".strip(" ·") if previas else aclaracion
            cli.nombre = nombre_propio(limpio)
            movidos += 1
        db.add(models.Config(clave=MARCA, valor=str(movidos)))
        db.commit()
        if movidos:
            print(f"Migración: {movidos} cliente(s) con el paréntesis pasado a notas.")

try:
    migrar_notas_entre_parentesis()
except Exception as _e:
    print("Aviso: no se pudo migrar los nombres entre paréntesis:", _e)

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

def calcular_transfer(precio_efectivo: int) -> int:
    """Precio de transferencia = efectivo x 1.1111, redondeado PARA ARRIBA a múltiplo de 100."""
    import math
    bruto = precio_efectivo * 1.1111
    return math.ceil(bruto / 100) * 100

def precio_con_ajuste(base: int, pct: int | None, monto: int | None = 0) -> int:
    """Precio unitario con el ajuste de la línea aplicado.

    El ajuste es POR UNIDAD y viene de dos formas, con signo en las dos:
      - porcentaje: -10 descuenta un 10%, +15 recarga un 15%
      - monto fijo: -2000 descuenta $2000, +1500 recarga $1500

    Son excluyentes; si por lo que sea vinieran los dos, manda el monto fijo,
    que es el que alguien escribió a mano. El monto se resta igual de las dos
    listas (efectivo y transferencia): son $2000 de descuento, no un porcentaje
    disfrazado, así que la diferencia entre listas no se mueve. Nunca baja de 0.
    """
    base = base or 0
    if monto:
        return max(base + monto, 0)
    if not pct:
        return base
    return round(base * (100 + pct) / 100)

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

def pagos_por_comprobante(db, comps) -> dict:
    """Todos los pagos de una tanda de comprobantes, en UNA consulta.

    Sin esto, estado_comprobante() pide los pagos de a un comprobante por vez: con
    1.500 tickets son 1.500 consultas solo para eso (el clásico N+1), y el historial
    se va a más de un segundo. Acá se traen todos juntos y se indexan en memoria.
    """
    ids = [c.id for c in comps]
    if not ids: return {}
    agrupados = {}
    # SQLite tiene un tope de parámetros por consulta, así que se va de a tandas
    for i in range(0, len(ids), 500):
        for p in db.query(models.Pago).filter(models.Pago.comprobante_id.in_(ids[i:i+500])):
            agrupados.setdefault(p.comprobante_id, []).append(p)
    return agrupados

def con_relaciones(query):
    """Trae líneas y extras de toda la tanda en una consulta por relación,
    en vez de una por comprobante."""
    return query.options(selectinload(models.Comprobante.lineas),
                         selectinload(models.Comprobante.extras))

def estado_comprobante(db, comp, pagos_precargados=None) -> dict:
    """pagos_precargados: mapa {comprobante_id: [pagos]} armado con
    pagos_por_comprobante(). Si viene, no se consulta la base por este comprobante."""
    # El extra por dificultad se sacó; los comprobantes nuevos lo tienen en 0.
    # Se sigue sumando para que los viejos den el mismo total de siempre.
    extra = comp.extra_dificultad or 0
    total_transfer = comp.total_lista                                    # suma en lista transfer
    # Las dos listas llevan el mismo ajuste por línea, así los totales quedan parejos.
    total_efectivo = sum(precio_con_ajuste(l.precio_efectivo, l.ajuste_pct, l.ajuste_monto) * l.cantidad
                         for l in comp.lineas)

    # El comprobante se precia según su forma: efectivo usa lista efectivo; cualquier otra, transfer.
    if comp.forma_pago == "efectivo":
        desc_efectivo = total_transfer - total_efectivo                  # diferencia entre listas
        subtotal = total_efectivo + extra
    else:
        desc_efectivo = 0
        subtotal = total_transfer + extra

    # El descuento de listado (jubilado) va sobre el subtotal YA con el descuento efectivo restado.
    desc_jubilado = round(subtotal * (comp.descuento_pct or 0) / 100)
    # Los extras entran al final, después de TODOS los descuentos: son cargos que
    # no se negocian (traslado, un producto que se lleva, etc.).
    extras_total = sum(e.monto or 0 for e in comp.extras)
    total_final = subtotal - desc_jubilado + extras_total

    pagos = (pagos_precargados.get(comp.id, []) if pagos_precargados is not None
             else db.query(models.Pago).filter(models.Pago.comprobante_id == comp.id).all())
    pagado = sum((p.saldado if p.saldado is not None else p.monto) for p in pagos)
    ingresado = sum(p.monto for p in pagos)
    saldo = total_final - pagado

    if comp.tipo == "presupuesto": estado = "presupuesto"
    elif pagado <= 0: estado = "pendiente"
    elif saldo <= 0: estado = "pagado"
    else: estado = "parcial"

    return {
        "total_transfer": total_transfer + extra,   # "Precios (transfer)"
        "desc_efectivo": desc_efectivo,             # diferencia entre listas (0 si no es efectivo)
        "subtotal": subtotal,                       # subtotal ya con el descuento efectivo
        "desc_jubilado": desc_jubilado,             # descuento de listado
        "extras_total": extras_total,               # cargos que no toca ningún descuento
        "total_final": total_final,                 # lo que paga el cliente
        "pagado": pagado, "ingresado": ingresado, "saldo": saldo, "estado": estado,
    }

def forma_comprobante(db, comp, pagos_precargados=None) -> str:
    """Forma de pago mostrada: se DEDUCE de los pagos, no se guarda.
    Sin pagos = a cuenta; una sola forma = esa; varias formas = mixto."""
    if comp.tipo == "presupuesto":
        return "—"
    pagos = (pagos_precargados.get(comp.id, []) if pagos_precargados is not None
             else db.query(models.Pago).filter(models.Pago.comprobante_id == comp.id).all())
    if not pagos:
        return "A cuenta"
    formas = {p.forma_pago for p in pagos}     # set: descarta repetidos
    if len(formas) == 1:
        return next(iter(formas))              # "Efectivo" o "Transferencia"
    return "Pago mixto"

# Hasta acá se puede retroceder al anotar un servicio olvidado. No es una regla
# contable: es un freno para el error de tipeo (un año mal puesto mandaría la
# venta a una caja de 2024 y nadie la vería nunca más).
DIAS_ATRAS_MAX = 60

def fecha_del_servicio(iso: str | None, ahora):
    """Instante UTC que hay que guardar para un servicio hecho el día `iso`.

    Sin `iso` (el caso normal) es simplemente ahora. Con `iso`, se guarda el
    mediodía argentino de ese día: cae con holgura adentro de la ventana que la
    caja usa para agrupar (03:00 a 03:00 UTC), así que no hay forma de que por
    un par de horas la venta termine contada en el día de al lado.
    """
    if not iso:
        return ahora
    try:
        d = date.fromisoformat(iso[:10])
    except ValueError:
        raise HTTPException(400, "Fecha inválida (se espera AAAA-MM-DD)")
    hoy = hoy_argentina()
    if d > hoy:
        raise HTTPException(400, "No se puede anotar un servicio con fecha futura")
    if (hoy - d).days > DIAS_ATRAS_MAX:
        raise HTTPException(400, f"No se puede retroceder más de {DIAS_ATRAS_MAX} días")
    if d == hoy:
        return ahora
    return datetime(d.year, d.month, d.day, 12, 0) + timedelta(hours=HORAS_ARG)

def anotado_despues(comp) -> str | None:
    """Fecha ISO en que se anotó el comprobante, SOLO si no es la del servicio.

    Devuelve None en el caso normal (se cargó el mismo día que se atendió), así
    que quien lo lee puede preguntar simplemente "¿hay algo acá?" para saber si
    corresponde aclarar "servicio anotado el ...".
    """
    if not comp.cargado or not comp.fecha:
        return None
    if hora_argentina(comp.cargado).date() == hora_argentina(comp.fecha).date():
        return None
    return comp.cargado.isoformat()

def siguiente_numero(db, tipo: str) -> int:
    """Devuelve el próximo número de la secuencia para ese tipo de comprobante."""
    ultimo = db.query(models.Comprobante).filter(
        models.Comprobante.tipo == tipo
    ).order_by(models.Comprobante.numero.desc()).first()
    return (ultimo.numero + 1) if ultimo else 1

def _puede_modificar(user, fecha) -> bool:
    # el dueño puede modificar cualquier fecha; el empleado solo lo de hoy
    return user.get("rol") == "dueno" or hora_argentina(fecha).date() == hoy_argentina()

"""Freno a la prueba de contraseñas por fuerza bruta.

   Sin esto, /api/login contesta tan rápido como se le pida: una contraseña de
   ocho caracteres en minúscula se agota en un rato desde una sola máquina, y no
   queda registro de que alguien lo intentó.

   Se cuentan los fallos por IP y por usuario a la vez, porque tapan agujeros
   distintos: por IP frena a uno que prueba contra muchos usuarios, y por
   usuario frena a muchas IPs probando contra el mismo. Los aciertos limpian el
   contador, así que a quien se le escapó el dedo una vez no le pasa nada.

   Los dos topes NO son iguales, y la diferencia importa: en el local la tablet,
   el celular y la computadora salen todos por la misma IP. Con un tope de IP
   bajo, la empleada que se olvidó su contraseña y probó ocho veces dejaría
   afuera también a la dueña, que no hizo nada. Así que el tope por usuario es
   bajo (protege esa cuenta y solo esa) y el de IP es alto: sigue cortando la
   fuerza bruta, que necesita miles de intentos, sin castigar al de al lado.

   Vive en memoria: se borra al reiniciar y no se comparte si algún día hay más
   de una instancia. No es un candado perfecto, es sacarle al que prueba la
   posibilidad de hacer miles de intentos por minuto, que es lo que importa.
"""
TOPE = {"ip": 25, "us": 8}
ESPERA_SEG = 300          # 5 minutos de castigo
_fallos: dict[str, list[float]] = {}

def _recientes(clave: str) -> list[float]:
    ahora = time.monotonic()
    quedan = [t for t in _fallos.get(clave, []) if ahora - t < ESPERA_SEG]
    if quedan: _fallos[clave] = quedan
    else: _fallos.pop(clave, None)
    return quedan

def _frenado(claves) -> int:
    """Segundos que faltan para poder volver a probar. 0 = puede intentar."""
    espera = 0
    for c in claves:
        intentos = _recientes(c)
        if len(intentos) >= TOPE[c.split(":")[0]]:
            espera = max(espera, int(ESPERA_SEG - (time.monotonic() - intentos[0])) + 1)
    return espera

@app.post("/api/login")
def login(datos: LoginIn, request: Request, db: Session = Depends(get_db)):
    usuario = datos.usuario.strip()
    # request.client puede venir vacío detrás de un proxy raro: ahí queda solo el
    # freno por usuario, que igual sirve.
    ip = request.client.host if request.client else "?"
    claves = [f"ip:{ip}", f"us:{usuario.lower()}"]

    faltan = _frenado(claves)
    if faltan:
        raise HTTPException(429, f"Demasiados intentos. Probá de nuevo en {faltan//60+1} min.")

    u = db.query(models.Usuario).filter(models.Usuario.usuario == usuario).first()
    if not u or not hmac.compare_digest(u.hash, auth.hash_password(datos.password, u.salt)):
        ahora = time.monotonic()
        for c in claves: _fallos.setdefault(c, []).append(ahora)
        print(f"Login fallido: usuario={usuario!r} ip={ip}")
        raise HTTPException(401, "Usuario o contraseña incorrectos")

    for c in claves: _fallos.pop(c, None)      # entró bien: se limpia el contador
    return {"token": auth.crear_token(u.usuario, u.rol), "rol": u.rol, "usuario": u.usuario}

# Las contraseñas con las que se crean los usuarios la primera vez. Están en
# seed_datos.py, que es público como todo el repositorio: mientras alguien siga
# usando una de estas, no hay contraseña que valga.
PASSWORDS_DE_FABRICA = {"dueno": "dueno1234", "empleado": "empleado1234"}

def con_password_de_fabrica(db) -> list[str]:
    """Usuarios que todavía tienen la contraseña con la que se crearon."""
    flojos = []
    for u in db.query(models.Usuario):
        original = PASSWORDS_DE_FABRICA.get(u.usuario)
        if original and hmac.compare_digest(u.hash, auth.hash_password(original, u.salt)):
            flojos.append(u.usuario)
    return flojos

@app.get("/api/yo")
def yo(user = Depends(usuario_actual), db: Session = Depends(get_db)):
    # Se avisa acá, y no en una pantalla suelta, porque /api/yo lo llama cada
    # pantalla al abrirse: el aviso aparece en toda la app hasta que se arregle.
    # El empleado ve solo lo suyo; el dueño ve todas las que faltan cambiar.
    flojos = con_password_de_fabrica(db)
    mias = user.get("usuario") in flojos
    return {**user,
            "password_de_fabrica": mias,
            "usuarios_sin_cambiar": flojos if user.get("rol") == "dueno" else []}

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
    return [{"id": i.id, "nombre": i.nombre, "precio": i.precio, "precio_transfer": i.precio_transfer, "es_producto": i.es_producto} for i in q]

@app.get("/api/items/all")
def items_all(_ = Depends(solo_dueno), db: Session = Depends(get_db)):
    q = db.query(models.Item).filter(models.Item.activo == True).order_by(models.Item.nombre)
    return [{"id": i.id, "nombre": i.nombre, "precio": i.precio, "categoria": i.categoria, "precio_transfer": i.precio_transfer,
             "es_producto": i.es_producto} for i in q]

@app.get("/api/catalogo")
def catalogo(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
    """Todo el catálogo activo de una sola vez (para buscador y agrupado en Facturación)."""
    q = (db.query(models.Item).filter(models.Item.activo == True)
           .order_by(models.Item.categoria, models.Item.nombre))
    return [{"id": i.id, "nombre": i.nombre, "precio": i.precio, "precio_transfer": i.precio_transfer,"categoria": i.categoria,  
             "es_producto": i.es_producto} for i in q]

@app.get("/api/config")
def config(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
    formas = [f.nombre for f in db.query(models.FormaPago).filter(models.FormaPago.activo == True)]
    tipos = [t.nombre for t in db.query(models.TipoEgreso).filter(models.TipoEgreso.activo == True)]
    alias = [a.nombre for a in db.query(models.Alias).filter(models.Alias.activo == True)]
    return {"formas_pago": formas, "tipos_egreso": tipos, "alias": alias,
            "negocio": NEGOCIO}

@app.put("/api/config/fondo-caja")
def set_fondo(datos: FondoIn, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    iso = (datos.fecha or hoy_argentina().isoformat())[:10]
    f = db.query(models.FondoCaja).filter(models.FondoCaja.fecha == iso).first()
    if not f:
        f = models.FondoCaja(fecha=iso); db.add(f)
    f.monto = datos.valor
    db.commit()
    return {"ok": True}

# precios transferencia

@app.post("/api/admin/recalcular-transfer")
def recalcular_transfer(_ = Depends(solo_dueno), db: Session = Depends(get_db)):
    items = db.query(models.Item).all()
    for it in items:
        it.precio_transfer = calcular_transfer(it.precio)
    db.commit()
    return {"recalculados": len(items)}

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

# ---------- clientes ----------
def _cliente_json(c):
    """Cliente en JSON para API. No incluye fecha de creación ni activo."""
    return {"id": c.id, "nombre": c.nombre, "telefono": c.telefono, "alias": c.alias,
            "notas": c.notas, "direccion": c.direccion, "dni": c.dni}


@app.get("/api/clientes")
def listar_clientes(q: str | None = None, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    query = db.query(models.Cliente).filter(models.Cliente.activo == True)
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(models.Cliente.nombre.ilike(like) | models.Cliente.telefono.ilike(like))
    return [_cliente_json(c) for c in query.order_by(models.Cliente.nombre)]

@app.post("/api/clientes")
def crear_cliente(cli: ClienteIn, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    nombre = nombre_propio(cli.nombre)
    if not nombre:
        raise HTTPException(400, "El nombre no puede estar vacío")
    # ¿ya existe un cliente activo con ese nombre? (sin distinguir mayúsculas)
    existe = db.query(models.Cliente).filter(
        func.lower(models.Cliente.nombre) == nombre.lower(),
        models.Cliente.activo == True
    ).first()
    if existe:
        raise HTTPException(409, "Ya existe un cliente con ese nombre")
    nuevo = models.Cliente(
        nombre=nombre,
        telefono=(cli.telefono or "").strip() or None,
        alias=(cli.alias or "").strip() or None,
        notas=(cli.notas or "").strip() or None,
        direccion=(cli.direccion or "").strip() or None,
        dni=(cli.dni or "").strip() or None)
    db.add(nuevo); db.commit(); db.refresh(nuevo); return {"id": nuevo.id}

@app.get("/api/clientes/deudas")
def deudas_clientes(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
    """Saldo por cliente, solo de los que deben. Va ANTES de /{cliente_id}: las rutas fijas primero."""
    # 1) cuánto se pagó por comprobante — UNA query agregada, la suma la hace la base
    pagado_por_comp = dict(
        db.query(models.Pago.comprobante_id,
                 func.sum(func.coalesce(models.Pago.saldado, models.Pago.monto)))
          .group_by(models.Pago.comprobante_id).all())

    # 2) todos los tickets con cliente — UNA query, con líneas y extras incluidos
    tickets = con_relaciones(db.query(models.Comprobante).filter(
        models.Comprobante.tipo == "ticket",
        models.Comprobante.activo == True,
        models.Comprobante.cliente_id != None)).all()

    # 3) filtro barato (total_final NUNCA supera total_lista + extra): los que lo pasan
    # necesitan el cálculo fino, y sus pagos se traen todos juntos, no de a uno.
    candidatos = [t for t in tickets
                  if pagado_por_comp.get(t.id, 0) < (t.total_lista or 0) + (t.extra_dificultad or 0)]
    pagos_map = pagos_por_comprobante(db, candidatos)

    deudas = {}
    for t in candidatos:
        est = estado_comprobante(db, t, pagos_map)
        if est["saldo"] > 0:
            deudas[t.cliente_id] = deudas.get(t.cliente_id, 0) + est["saldo"]

    return [{"cliente_id": k, "saldo": v} for k, v in deudas.items()]

@app.get("/api/clientes/{cliente_id}")
def ver_cliente(cliente_id: int, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    c = db.get(models.Cliente, cliente_id)
    if not c or not c.activo: raise HTTPException(404, "Cliente no existe")
    return _cliente_json(c)

@app.put("/api/clientes/{cliente_id}")
def editar_cliente(cliente_id: int, cambios: ClienteEdit, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    c = db.get(models.Cliente, cliente_id)
    if not c: raise HTTPException(404, "Cliente no existe")
    if cambios.nombre is not None:
        nombre = nombre_propio(cambios.nombre)
        if not nombre: raise HTTPException(400, "El nombre no puede quedar vacío")
        existe = db.query(models.Cliente).filter(
            func.lower(models.Cliente.nombre) == nombre.lower(),
            models.Cliente.activo == True,
            models.Cliente.id != cliente_id
        ).first()
        if existe: raise HTTPException(409, "Ya existe un cliente con ese nombre")
        c.nombre = nombre
    if cambios.telefono is not None: c.telefono = cambios.telefono.strip() or None
    if cambios.alias is not None: c.alias = cambios.alias.strip() or None
    if cambios.notas is not None: c.notas = cambios.notas.strip() or None
    if cambios.direccion is not None: c.direccion = cambios.direccion.strip() or None
    if cambios.dni is not None: c.dni = cambios.dni.strip() or None
    if cambios.activo is not None: c.activo = cambios.activo
    db.commit(); return {"ok": True}

@app.delete("/api/clientes/{cliente_id}")
def borrar_cliente(cliente_id: int, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    c = db.get(models.Cliente, cliente_id)
    if not c: raise HTTPException(404, "Cliente no existe")

    comps = con_relaciones(db.query(models.Comprobante).filter(
        models.Comprobante.cliente_id == cliente_id,
        models.Comprobante.tipo == "ticket",
        models.Comprobante.activo == True)).all()
    pagos_map = pagos_por_comprobante(db, comps)
    deuda = sum(est["saldo"] for comp in comps
                if (est := estado_comprobante(db, comp, pagos_map))["saldo"] > 0)
    if deuda > 0:
        raise HTTPException(409, f"No se puede eliminar: {c.nombre} debe ${deuda:,}".replace(",", "."))

    c.activo = False; db.commit(); return {"ok": True}

@app.get("/api/clientes/{cliente_id}/cuenta")
def cuenta_cliente(cliente_id: int, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    cli = db.get(models.Cliente, cliente_id)
    if not cli or not cli.activo: raise HTTPException(404, "Cliente no existe")
    # Trae tickets Y presupuestos. Solo los tickets suman al saldo: un presupuesto
    # todavía no es una deuda, es un precio que se pasó.
    comps = con_relaciones(db.query(models.Comprobante).filter(
        models.Comprobante.cliente_id == cliente_id,
        models.Comprobante.activo == True
    )).order_by(models.Comprobante.fecha.desc()).all()
    pagos_map = pagos_por_comprobante(db, comps)
    out = []; saldo_total = 0
    for comp in comps:
        est = estado_comprobante(db, comp, pagos_map)
        if comp.tipo == "ticket" and est["saldo"] > 0: saldo_total += est["saldo"]
        conv = None
        if comp.tipo == "presupuesto":
            t = db.query(models.Comprobante).filter(models.Comprobante.convertido_de == comp.id).first()
            conv = t.numero if t else None
        out.append({"id": comp.id, "tipo": comp.tipo, "numero": comp.numero, "fecha": comp.fecha.isoformat(),
                    "descuento_nombre": comp.descuento_nombre, "descuento_pct": comp.descuento_pct,
                    "total_transfer": est["total_transfer"], "desc_efectivo": est["desc_efectivo"],
                    "subtotal": est["subtotal"], "desc_jubilado": est["desc_jubilado"],
                    "total_final": est["total_final"], "pagado": est["pagado"],
                    "ingresado": est["ingresado"], "convertido_a": conv,
                    "forma_pago": forma_comprobante(db, comp, pagos_map), "forma_origen": comp.forma_pago,
                    "saldo": est["saldo"], "estado": est["estado"]})
    return {"cliente": _cliente_json(cli),
            "saldo_total": saldo_total, "comprobantes": out}

@app.get("/api/clientes/{cliente_id}/proximo-turno")
def proximo_turno(cliente_id: int, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    hoy = hora_argentina(fecha_hora_now_utc()).strftime("%Y-%m-%d")
    t = db.query(models.Turno).filter(
        models.Turno.cliente_id == cliente_id,
        models.Turno.activo == True,
        models.Turno.fecha >= hoy
    ).order_by(models.Turno.fecha, models.Turno.hora).first()
    if not t: return {"turno": None}
    return {"turno": {"fecha": t.fecha, "hora": t.hora, "servicio": t.servicio, "es_hoy": t.fecha == hoy}}

# ---------- catalogo (admin: solo dueño) ----------
@app.post("/api/items")
def crear_item(item: ItemIn, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    nuevo = models.Item(categoria=item.categoria.strip(), nombre=item.nombre.strip(),
                        precio=item.precio, precio_transfer=calcular_transfer(item.precio), es_producto=item.es_producto)
    db.add(nuevo); db.commit(); db.refresh(nuevo); return {"id": nuevo.id}

@app.put("/api/items/{item_id}")
def editar_item(item_id: int, cambios: ItemEdit, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    item = db.get(models.Item, item_id)
    if not item: raise HTTPException(404, "Item no existe")
    if cambios.categoria is not None: item.categoria = cambios.categoria.strip()
    if cambios.nombre is not None: item.nombre = cambios.nombre.strip()
    if cambios.precio is not None:
        item.precio = cambios.precio
        item.precio_transfer = calcular_transfer(cambios.precio)
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

# ---------- log de stock ----------
def log_stock(db, item, tipo, cambio, motivo, usuario="sistema"):
    antes = item.stock_actual or 0
    db.add(models.MovimientoStock(
        item_id=item.id, tipo=tipo, antes=antes,
        despues=antes + cambio, cambio=cambio,
        motivo=motivo, usuario=usuario))

# ---------- comprobantes ----------
@app.get("/api/comprobantes")
def listar_comprobantes(tipo: str | None = None, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    query = con_relaciones(db.query(models.Comprobante).filter(models.Comprobante.activo == True))
    if tipo: query = query.filter(models.Comprobante.tipo == tipo)
    comps = query.order_by(models.Comprobante.fecha.desc()).all()

    # Todo lo que hace falta para la tanda entera, en tres consultas fijas en vez de
    # tres por comprobante.
    pagos_map = pagos_por_comprobante(db, comps)
    convertidos = {}
    if any(c.tipo == "presupuesto" for c in comps):
        for origen, numero in db.query(models.Comprobante.convertido_de, models.Comprobante.numero)\
                                .filter(models.Comprobante.convertido_de.isnot(None)):
            convertidos[origen] = numero

    out = []
    for comp in comps:
        conv = convertidos.get(comp.id) if comp.tipo == "presupuesto" else None
        out.append({"id": comp.id, "tipo": comp.tipo, "numero": comp.numero,
                    "fecha": comp.fecha.isoformat(), "cliente_nombre": comp.cliente_nombre, "cliente_id": comp.cliente_id,
                    "total_lista": comp.total_lista, "extra_dificultad": comp.extra_dificultad,
                    "convertido_a": conv, "forma_pago": forma_comprobante(db, comp, pagos_map),
                     "forma_origen": comp.forma_pago, "anotado_despues": anotado_despues(comp),
                    **estado_comprobante(db, comp, pagos_map)})
    return out

@app.get("/api/comprobantes/{comp_id}")
def ver_comprobante(comp_id: int, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    comp = db.get(models.Comprobante, comp_id)
    if not comp or not comp.activo: raise HTTPException(404, "Comprobante no existe")
    return {"id": comp.id, "tipo": comp.tipo, "numero": comp.numero, "fecha": comp.fecha.isoformat(),
        "anotado_despues": anotado_despues(comp),
        "cliente_id": comp.cliente_id, "cliente_nombre": comp.cliente_nombre, "peluquero": comp.peluquero,
        "descuento_pct": comp.descuento_pct, "descuento_nombre": comp.descuento_nombre,
        "mostrar_motivo": comp.mostrar_motivo, "forma_pago": comp.forma_pago, "total_lista": comp.total_lista, "extra_dificultad": comp.extra_dificultad,
        # precio_unit / precio_efectivo son los del catálogo; los "_final" ya llevan el
        # ajuste de la línea, así el ticket puede imprimir los dos y mostrar el descuento.
        "lineas": [{"nombre": l.nombre, "cantidad": l.cantidad, "precio_unit": l.precio_unit,
                    "precio_efectivo": l.precio_efectivo, "dificultad": l.dificultad, "subtotal": l.subtotal,
                    "ajuste_pct": l.ajuste_pct or 0, "ajuste_monto": l.ajuste_monto or 0,
                    "ajuste_nombre": l.ajuste_nombre,
                    "precio_unit_final": precio_con_ajuste(l.precio_unit, l.ajuste_pct, l.ajuste_monto),
                    "precio_efectivo_final": precio_con_ajuste(l.precio_efectivo, l.ajuste_pct, l.ajuste_monto)}
                   for l in comp.lineas],
        "extras": [{"concepto": e.concepto, "monto": e.monto} for e in comp.extras],
        "pagos": [{"id": p.id, "fecha": p.fecha.isoformat(), "monto": p.monto, "saldado": p.saldado,
                   "desc_aplicado": p.desc_aplicado, "forma_pago": p.forma_pago, "alias": p.alias}
                  for p in db.query(models.Pago).filter(models.Pago.comprobante_id == comp.id).order_by(models.Pago.fecha)],
        **estado_comprobante(db, comp)}

@app.post("/api/comprobantes")
def crear_comprobante(c: ComprobanteIn, user = Depends(usuario_actual), db: Session = Depends(get_db)):
    if c.tipo not in ("ticket", "presupuesto"): raise HTTPException(400, "Tipo inválido")
    if not c.lineas: raise HTTPException(400, "El comprobante no tiene líneas")
    nombre_cli = None
    if c.cliente_id:
        cli = db.get(models.Cliente, c.cliente_id)
        if not cli: raise HTTPException(404, "Cliente no existe")
        nombre_cli = cli.nombre
    elif c.cliente_nombre:
        # el nombre que queda en el comprobante también, si no el mismo cliente
        # aparece escrito distinto en el historial y en el papel impreso
        nombre_cli = nombre_propio(c.cliente_nombre) or None
    ahora = fecha_hora_now_utc().replace(tzinfo=None)
    comp = models.Comprobante(
        tipo=c.tipo, numero=siguiente_numero(db, c.tipo),
        fecha=fecha_del_servicio(c.fecha, ahora), cargado=ahora,
        cliente_id=c.cliente_id, cliente_nombre=nombre_cli, peluquero=c.peluquero,
        forma_pago=c.forma_pago,
        descuento_pct=c.descuento_pct or 0, descuento_nombre=c.descuento_nombre, mostrar_motivo=c.mostrar_motivo)
    db.add(comp); db.flush()
    total = 0
    for ln in c.lineas:
        # El precio guardado es el del catálogo; el subtotal ya lleva el ajuste de la línea,
        # así el ticket puede mostrar "precio de lista → precio ajustado" por unidad.
        # El ajuste es porcentaje O monto fijo, nunca los dos.
        ajuste = 0 if ln.ajuste_monto else (ln.ajuste_pct or 0)
        aj_monto = ln.ajuste_monto or 0
        hay_ajuste = bool(ajuste or aj_monto)
        motivo = (ln.ajuste_nombre or None) if hay_ajuste else None
        if(ln.item_id):
            item = db.get(models.Item, ln.item_id)
            if not item: raise HTTPException(404, f"Item {ln.item_id} no existe")
            # El comprobante se ancla SIEMPRE al precio transferencia (precio de referencia).
            # El descuento por efectivo se aplica al cobrar, no acá.
            precio = item.precio_transfer
            sub = precio_con_ajuste(precio, ajuste, aj_monto) * ln.cantidad
            total += sub
            db.add(models.ComprobanteLinea(comprobante_id=comp.id, item_id=item.id, nombre=item.nombre,
            cantidad=ln.cantidad, precio_unit=precio, precio_efectivo=item.precio,
            ajuste_pct=ajuste, ajuste_monto=aj_monto, ajuste_nombre=motivo, subtotal=sub))
            # El stock se mueve SOLO cuando hay venta. Un presupuesto es un precio
            # que se pasa, no mercadería que sale: si descontara, cada presupuesto
            # que no se concreta dejaría el inventario mal para siempre.
            if c.tipo == "ticket" and item.es_producto and item.stock_actual is not None:
                log_stock(db, item, "venta", -ln.cantidad, f"Comprobante #{comp.id}", user.get("usuario","?"))
                item.stock_actual -= ln.cantidad
        else:
            precio = calcular_transfer(ln.precio_custom)
            sub = precio_con_ajuste(precio, ajuste, aj_monto) * ln.cantidad
            total += sub
            db.add(models.ComprobanteLinea(comprobante_id=comp.id, item_id=None, nombre=ln.nombre,
            cantidad=ln.cantidad, precio_unit=precio, precio_efectivo=ln.precio_custom,
            ajuste_pct=ajuste, ajuste_monto=aj_monto, ajuste_nombre=motivo, subtotal=sub))
    for ex in c.extras:
        concepto = (ex.concepto or "").strip()
        if not concepto or not ex.monto: continue
        db.add(models.ComprobanteExtra(comprobante_id=comp.id, concepto=concepto, monto=ex.monto))
    comp.total_lista = total
    comp.extra_dificultad = 0        # el extra por dificultad ya no existe
    db.commit(); db.refresh(comp)
    return {"id": comp.id, "numero": comp.numero, "tipo": comp.tipo,
            "fecha": comp.fecha.isoformat(), "anotado_despues": anotado_despues(comp)}

@app.post("/api/comprobantes/{comp_id}/pagos")
def registrar_pago(comp_id: int, pago: PagoIn, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    comp = db.get(models.Comprobante, comp_id)
    if not comp or not comp.activo: raise HTTPException(404, "Comprobante no existe")
    if comp.tipo != "ticket": raise HTTPException(400, "Solo se cobran tickets, no presupuestos")
    est = estado_comprobante(db, comp)
    if pago.monto <= 0: raise HTTPException(400, "El monto debe ser positivo")
    # 'saldado' es cuánto de la cuenta (a precio transferencia) cubre este pago.
    # Si no viene, se asume igual al monto (caso transferencia, sin descuento).
    saldado = pago.saldado if pago.saldado is not None else pago.monto
    if saldado <= 0: raise HTTPException(400, "Lo saldado debe ser positivo")
    if saldado > est["saldo"]: raise HTTPException(400, f"Supera el saldo pendiente (${est['saldo']})")
    desc = saldado - pago.monto   # descuento en pesos (0 si no hubo)

    """Qué día de caja le toca a esta plata.

    La caja se arma con la fecha de los PAGOS, no con la del comprobante, y eso
    está bien: son dos preguntas distintas y hay que poder contestar las dos.

      - Un abono que CIERRA la venta pertenece al día del servicio. Si se anota
        un servicio del martes que se había pasado por alto, esa plata entró el
        martes y en la caja del martes tiene que aparecer.
      - Un abono que SALDA una deuda vieja pertenece a hoy. El servicio fue hace
        dos semanas, pero la plata entra hoy y hoy hay que arquearla.

    Cuál de los dos es lo dice quien cobra, con del_servicio. La fecha sale
    después de `comp.fecha`, nunca de algo que mande el cliente: así no hay
    forma de mandar plata a un día arbitrario ni de errarle por pasar mal una
    fecha desde una pantalla.
    """
    fecha_pago = comp.fecha if pago.del_servicio else fecha_hora_now_utc().replace(tzinfo=None)
    db.add(models.Pago(comprobante_id=comp.id, monto=pago.monto, saldado=saldado,
                       fecha=fecha_pago,
                       forma_pago=pago.forma_pago, alias=pago.alias, desc_aplicado=desc))
    db.commit(); return estado_comprobante(db, comp)

@app.delete("/api/comprobantes/{comp_id}")
def anular_comprobante(comp_id: int, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    comp = db.get(models.Comprobante, comp_id)
    if not comp or not comp.activo:
        raise HTTPException(404, "Comprobante no existe")
    db.query(models.Pago).filter(models.Pago.comprobante_id == comp.id).delete()
    # Se devuelve stock solo de los tickets: el presupuesto nunca lo descontó,
    # así que devolverlo estaría inventando mercadería.
    if comp.tipo == "ticket":
        for l in comp.lineas:
            if l.item_id:
                it = db.get(models.Item, l.item_id)
                if it and it.es_producto and it.stock_actual is not None:
                    log_stock(db, it, "anulacion", l.cantidad, f"Anulación comprobante #{comp.id}", "sistema")
                    it.stock_actual += l.cantidad
    comp.activo = False
    db.commit()
    return {"ok": True}

@app.delete("/api/pagos/{pago_id}")
def borrar_pago(pago_id: int, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    """Anula un cobro mal cargado. El comprobante vuelve a quedar con saldo pendiente."""
    p = db.get(models.Pago, pago_id)
    if not p: raise HTTPException(404, "Pago no existe")
    db.delete(p); db.commit(); return {"ok": True}

@app.post("/api/comprobantes/{comp_id}/convertir")
def convertir_a_ticket(comp_id: int, user = Depends(usuario_actual), db: Session = Depends(get_db)):
    presu = db.get(models.Comprobante, comp_id)
    if not presu or not presu.activo: raise HTTPException(404, "Comprobante no existe")
    if presu.tipo != "presupuesto": raise HTTPException(400, "Solo se convierten presupuestos")
    ya = db.query(models.Comprobante).filter(models.Comprobante.convertido_de == presu.id).first()
    if ya: raise HTTPException(400, "Este presupuesto ya fue convertido")
    ticket = models.Comprobante(
        tipo="ticket", numero=siguiente_numero(db, "ticket"),
        cliente_id=presu.cliente_id, cliente_nombre=presu.cliente_nombre, peluquero=presu.peluquero,
        descuento_pct=presu.descuento_pct, descuento_nombre=presu.descuento_nombre,
        mostrar_motivo=presu.mostrar_motivo, total_lista=presu.total_lista,
        extra_dificultad=presu.extra_dificultad, convertido_de=presu.id)
    db.add(ticket); db.flush()
    for l in presu.lineas:
        # Ojo: hay que copiar TAMBIÉN precio_efectivo y el ajuste de la línea. Sin
        # precio_efectivo el ticket convertido queda sin lista efectivo y el descuento
        # por pago en efectivo sale mal calculado.
        db.add(models.ComprobanteLinea(comprobante_id=ticket.id, item_id=l.item_id, nombre=l.nombre,
            cantidad=l.cantidad, precio_unit=l.precio_unit, precio_efectivo=l.precio_efectivo,
            ajuste_pct=l.ajuste_pct or 0, ajuste_monto=l.ajuste_monto or 0,
            ajuste_nombre=l.ajuste_nombre, dificultad=l.dificultad, subtotal=l.subtotal))
    for e in presu.extras:
        db.add(models.ComprobanteExtra(comprobante_id=ticket.id, concepto=e.concepto, monto=e.monto))
    # Recién acá sale la mercadería: el presupuesto no había tocado el stock.
    for l in presu.lineas:
        if not l.item_id: continue
        item = db.get(models.Item, l.item_id)
        if item and item.es_producto and item.stock_actual is not None:
            log_stock(db, item, "venta", -l.cantidad,
                      f"Presupuesto P-{presu.numero:05d} → ticket #{ticket.id}", user.get("usuario","?"))
            item.stock_actual -= l.cantidad
    db.commit(); db.refresh(ticket)
    return {"id": ticket.id, "numero": ticket.numero}


# ---------- ventas (cualquier usuario logueado) ----------




# ---------- egresos ----------
@app.post("/api/egresos")
def crear_egreso(e: EgresoIn, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    eg = models.Egreso(tipo=e.tipo, concepto=e.concepto, monto=e.monto,
                       forma_pago=e.forma_pago, notas=e.notas, fecha=fecha_hora_now_utc())
    db.add(eg); db.commit(); db.refresh(eg); return {"id": eg.id}

@app.get("/api/egresos/dia")
def egresos_dia(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
    ini, fin = _rango_dia(hoy_argentina())
    es = db.query(models.Egreso).filter(models.Egreso.fecha >= ini, models.Egreso.fecha < fin
         ).order_by(models.Egreso.id.desc()).all()
    return [{"id": e.id, "hora": hora_argentina(e.fecha).strftime("%H:%M"), "tipo": e.tipo, "concepto": e.concepto,
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
def _rango_dia(d):
    """Ventana en UTC que cubre el día argentino `d`.

    Las fechas se guardan en UTC, así que el día del local —de 00:00 a 24:00 en
    Argentina— es de 03:00 a 03:00 UTC. Antes esta ventana arrancaba a la
    medianoche UTC, o sea a las 21:00 argentinas: todo lo cargado de noche caía
    en el día siguiente."""
    ini = datetime(d.year, d.month, d.day) + timedelta(hours=HORAS_ARG)
    return ini, ini + timedelta(days=1)
def _sv(db, i, f): return sum(p.monto for p in db.query(models.Pago).filter(models.Pago.fecha >= i, models.Pago.fecha < f))
def _se(db, i, f): return sum((e.monto or 0) for e in db.query(models.Egreso).filter(models.Egreso.fecha >= i, models.Egreso.fecha < f))

def _pago_detalle(p):
    """Detalle de un cobro para la caja: hora, monto, forma de pago y a qué comprobante pertenece."""
    comp = p.comprobante
    ref = "—"
    if comp:
        pref = "A" if comp.tipo == "ticket" else "P"
        ref = f"{pref}-{comp.numero:05d}"
        if comp.cliente_nombre:
            ref += f" · {comp.cliente_nombre}"
    return {"id": p.id, "hora": hora_argentina(p.fecha).strftime("%H:%M"), "total": p.monto,
            "forma_pago": p.forma_pago, "alias": p.alias, "ref": ref,
            "comprobante_id": comp.id if comp else None}


@app.get("/api/caja/dia")
def caja_dia(fecha: str | None = None, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    d = date.fromisoformat(fecha) if fecha else hoy_argentina()
    ini, fin = _rango_dia(d)
    pagos = db.query(models.Pago).filter(models.Pago.fecha >= ini, models.Pago.fecha < fin).all()
    egresos = db.query(models.Egreso).filter(models.Egreso.fecha >= ini, models.Egreso.fecha < fin).all()
    ing = sum(p.monto for p in pagos); egr = sum((e.monto or 0) for e in egresos)
    por_pago = {}; por_tipo = {}
    for p in pagos: por_pago[p.forma_pago] = por_pago.get(p.forma_pago, 0) + p.monto
    for e in egresos: por_tipo[e.tipo] = por_tipo.get(e.tipo, 0) + (e.monto or 0)
    efectivo_ventas = sum(p.monto for p in pagos if p.forma_pago == "Efectivo")
    efectivo_egresos = sum((e.monto or 0) for e in egresos if e.forma_pago == "Efectivo")
    fondo = get_fondo_dia(db, d)
    return {"fecha": d.isoformat(), "ingresos": ing, "egresos": egr, "neto": ing - egr,
            "ventas": len(pagos) + len(egresos), "ingresos_por_pago": por_pago, "egresos_por_tipo": por_tipo, # Ventas = "Movimientos"
            "fondo": fondo, "efectivo_ventas": efectivo_ventas, "efectivo_egresos": efectivo_egresos,
            "efectivo_esperado": fondo + efectivo_ventas - efectivo_egresos,
            "ventas_detalle": [_pago_detalle(p) for p in pagos],
            "egresos_detalle": [{"id": e.id, "hora": hora_argentina(e.fecha).strftime("%H:%M"), "tipo": e.tipo,
                                 "concepto": e.concepto, "monto": e.monto, "forma_pago": e.forma_pago}
                                for e in egresos]}

@app.get("/api/caja/diario")
def caja_diario(dias: int = 14, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    hoy = hoy_argentina(); out = []
    for i in range(dias):
        d = hoy - timedelta(days=i); ini, fin = _rango_dia(d)
        ing = _sv(db, ini, fin); egr = _se(db, ini, fin)
        out.append({"fecha": d.isoformat(), "ingresos": ing, "egresos": egr, "neto": ing - egr})
    return out

@app.get("/api/caja/semanal")
def caja_semanal(semanas: int = 8, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    hoy = hoy_argentina(); lunes = hoy - timedelta(days=hoy.weekday()); out = []
    for i in range(semanas):
        ini_d = lunes - timedelta(weeks=i)
        ini, _ = _rango_dia(ini_d); fin = ini + timedelta(days=7)
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
def set_stock(item_id: int, s: StockIn, user = Depends(solo_dueno), db: Session = Depends(get_db)):
    item = db.get(models.Item, item_id)
    if not item or not item.es_producto: raise HTTPException(404, "Producto no existe")
    viejo = item.stock_actual or 0
    nuevo = s.stock_actual
    if viejo != nuevo:
        log_stock(db, item, "manual", nuevo - viejo, f"Ajuste: {viejo} → {nuevo}", user.get("usuario","?"))
    item.stock_actual = nuevo; item.stock_minimo = s.stock_minimo
    db.commit(); return {"ok": True}

@app.get("/api/inventario/historial")
def historial_stock(item_id: int | None = None, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    q = db.query(models.MovimientoStock).order_by(models.MovimientoStock.fecha.desc())
    if item_id:
        q = q.filter(models.MovimientoStock.item_id == item_id)
    movs = q.limit(200).all()
    return [{"id": m.id, "item_id": m.item_id, "fecha": m.fecha.isoformat(),
             "tipo": m.tipo, "antes": m.antes, "despues": m.despues,
             "cambio": m.cambio, "motivo": m.motivo, "usuario": m.usuario} for m in movs]

# ---------- reportes (solo dueño) ----------
def _ventana(dias: int, desde: str | None, hasta: str | None):
    # Si hay rango, lo usa. Si no, últimos `dias` CALENDARIO (hoy inclusive).
    # Si dias<=0, todo el historial.
    if desde or hasta:
        ini = datetime.fromisoformat(desde) if desde else None
        fin = (datetime.fromisoformat(hasta) + timedelta(days=1)) if hasta else None
        return ini, fin
    if dias and dias > 0:
        ini_hoy, fin_hoy = _rango_dia(hoy_argentina())
        return ini_hoy - timedelta(days=dias - 1), fin_hoy
    return None, None

def _filtrar(query, col, ini, fin):
    if ini is not None: query = query.filter(col >= ini)
    if fin is not None: query = query.filter(col < fin)
    return query

@app.get("/api/reportes/resumen")
def rep_resumen(dias: int = 30, desde: str | None = None, hasta: str | None = None,
                _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    ini, fin = _ventana(dias, desde, hasta)
    # Ingresos = plata que entró (igual que caja) → tabla pagos
    pagos = _filtrar(db.query(models.Pago), models.Pago.fecha, ini, fin).all()
    egresos = _filtrar(db.query(models.Egreso), models.Egreso.fecha, ini, fin).all()
    ing = sum(p.monto for p in pagos)
    egr = sum((e.monto or 0) for e in egresos)
    # desglose por forma de pago (mismo formato que /api/caja/dia)
    por_pago = {}
    for p in pagos:
        por_pago[p.forma_pago] = por_pago.get(p.forma_pago, 0) + p.monto
    # Ventas = tickets emitidos (no presupuestos, no anulados)
    q = db.query(models.Comprobante).filter(
        models.Comprobante.tipo == "ticket",
        models.Comprobante.activo == True)
    n = _filtrar(q, models.Comprobante.fecha, ini, fin).count()
    return {"ingresos": ing, "egresos": egr, "neto": ing - egr,
            "ventas": n, "ingresos_por_pago": por_pago}



@app.get("/api/reportes/deuda")
def rep_deuda(_ = Depends(solo_dueno), db: Session = Depends(get_db)):
    """Cuánto se debe HOY. No lleva período: es una foto, no un acumulado."""
    tickets = (db.query(models.Comprobante)
                 .filter(models.Comprobante.tipo == "ticket",
                         models.Comprobante.activo == True)
                 .all())
    total = 0; cuantos = 0
    for t in tickets:
        est = estado_comprobante(db, t)
        if est["saldo"] > 0:
            total += est["saldo"]
            cuantos += 1
    return {"deuda": total, "tickets": cuantos}

def _movimientos(db, ini, fin):
    """Ingresos (pagos) + egresos del período. Fuente ÚNICA para el registro y el Excel."""
    pagos = _filtrar(db.query(models.Pago), models.Pago.fecha, ini, fin).all()
    egresos = _filtrar(db.query(models.Egreso), models.Egreso.fecha, ini, fin).all()
    movs = []
    for p in pagos:
        comp = p.comprobante
        ref = "—"; cliente = ""; items = ""
        if comp:
            pref = "A" if comp.tipo == "ticket" else "P"
            ref = f"{pref}-{comp.numero:05d}"
            cliente = comp.cliente_nombre or ""
            items = ", ".join(f"{l.cantidad}× {l.nombre}" for l in comp.lineas)
        movs.append({"fecha": p.fecha, "clase": "ingreso",
                     "comprobante": ref, "cliente": cliente, "detalle": items,
                     "forma_pago": (p.forma_pago or "") + (f" ({p.alias})" if p.alias else ""),
                     "monto": p.monto})
    for e in egresos:
        det = (e.tipo or "")
        if e.concepto: det += f" — {e.concepto}"
        movs.append({"fecha": e.fecha, "clase": "egreso",
                     "comprobante": "", "cliente": "", "detalle": det,
                     "forma_pago": e.forma_pago or "", "monto": e.monto or 0})
    movs.sort(key=lambda m: m["fecha"], reverse=True)
    return movs

@app.get("/api/reportes/excel")
def reportes_excel(dias: int = 30, desde: str | None = None, hasta: str | None = None,
                   _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    wb = Workbook()
    ws = wb.active
    ws.title = "Movimientos"

    # encabezados
    ws.append(["Fecha", "Hora", "Tipo", "Comprobante", "Cliente", "Detalle", "Forma de pago", "Monto"])

    # una sola fuente: la misma función que usa el registro de pantalla
    ini, fin = _ventana(dias, desde, hasta)
    for m in reversed(_movimientos(db, ini, fin)):
        signo = 1 if m["clase"] == "ingreso" else -1
        ws.append([hora_argentina(m["fecha"]).strftime("%d/%m/%Y"), hora_argentina(m["fecha"]).strftime("%H:%M"),
                   "Ingreso" if m["clase"] == "ingreso" else "Egreso",
                   m["comprobante"], m["cliente"], m["detalle"], m["forma_pago"],
                   signo * m["monto"]])

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)

    return StreamingResponse(
        buffer,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=reportes.xlsx"})

# ---------- series temporales (para gráficos de línea) ----------
def _resolver_ventana(dias, desde, hasta, db):
    """Igual que _ventana, pero garantiza (ini, fin) concretos para bucketizar.

    Todo se maneja en UTC SIN zona: así lo devuelve _ventana y así lo guarda
    SQLite. fecha_hora_now_utc() sí trae zona, y mezclarlas reventaba el caso
    "Todo" con "can't compare offset-naive and offset-aware datetimes".
    """
    ahora = fecha_hora_now_utc().replace(tzinfo=None)
    ini, fin = _ventana(dias, desde, hasta)
    if ini is None:   # caso "Todo": arranca en el primer ticket
        primera = (db.query(models.Comprobante)
                     .filter(models.Comprobante.tipo == "ticket",
                             models.Comprobante.activo == True)
                     .order_by(models.Comprobante.fecha.asc()).first())
        ini = primera.fecha if primera else ahora - timedelta(days=30)
    if ini.tzinfo is not None: ini = ini.replace(tzinfo=None)
    if fin is None:
        fin = ahora + timedelta(days=1)
    if fin.tzinfo is not None: fin = fin.replace(tzinfo=None)
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

def _serie(filas, etiqueta_de, limite, buckets):
    """filas: lista de (linea, fecha, clave). Arma top N por métrica y su serie por bucket."""
    starts = [b[0] for b in buckets]
    val = (lambda l: (l.cantidad or 0)) 
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
def serie_items(dias: int = 30, limite: int = 3, 
                desde: str | None = None, hasta: str | None = None,
                _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    ini, fin = _resolver_ventana(dias, desde, hasta, db)
    buckets, gran = _buckets(ini, fin)
    q = (db.query(models.ComprobanteLinea, models.Comprobante.fecha)
           .join(models.Comprobante)
           .filter(models.Comprobante.tipo == "ticket",
                   models.Comprobante.activo == True,
                   models.Comprobante.fecha >= ini, models.Comprobante.fecha < fin))
    filas = [(l, f, l.nombre) for l, f in q.all()]
    return {"buckets": [b[2] for b in buckets], "granularidad": gran,
            "series": _serie(filas, None, limite, buckets)}

@app.get("/api/reportes/serie-categorias")
def serie_categorias(dias: int = 30, limite: int = 3,
                     desde: str | None = None, hasta: str | None = None,
                     _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    ini, fin = _resolver_ventana(dias, desde, hasta, db)
    buckets, gran = _buckets(ini, fin)
    q = (db.query(models.ComprobanteLinea, models.Comprobante.fecha, models.Item.categoria)
           .join(models.Comprobante)
           .outerjoin(models.Item, models.ComprobanteLinea.item_id == models.Item.id)
           .filter(models.Comprobante.tipo == "ticket",
                   models.Comprobante.activo == True,
                   models.Comprobante.fecha >= ini, models.Comprobante.fecha < fin))
    filas = [(l, f, cat or "Otros") for l, f, cat in q.all()]
    return {"buckets": [b[2] for b in buckets], "granularidad": gran,
            "series": _serie(filas, None, limite, buckets)}

@app.get("/api/reportes/serie-caja")
def serie_caja(dias: int = 30, desde: str | None = None, hasta: str | None = None,
               _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    """Ingresos y egresos período a período, para ver la evolución del negocio."""
    ini, fin = _resolver_ventana(dias, desde, hasta, db)
    buckets, gran = _buckets(ini, fin)

    pagos   = _filtrar(db.query(models.Pago),   models.Pago.fecha,   ini, fin).all()
    egresos = _filtrar(db.query(models.Egreso), models.Egreso.fecha, ini, fin).all()

    def acumular(registros, monto_de):
        serie = [0] * len(buckets)
        for r in registros:
            for i, (b_ini, b_fin, _et) in enumerate(buckets):
                if b_ini <= r.fecha < b_fin:
                    serie[i] += monto_de(r) or 0
                    break
        return serie

    ingresos = acumular(pagos,   lambda p: p.monto)
    egr      = acumular(egresos, lambda e: e.monto)
    return {"buckets": [b[2] for b in buckets], "granularidad": gran,
            "series": [{"nombre": "Ingresos", "valores": ingresos},
                       {"nombre": "Egresos",  "valores": egr}]}

@app.get("/api/reportes/ranking-items")
def ranking_items(dias: int = 30, limite: int = 8,
                  desde: str | None = None, hasta: str | None = None,
                  vista: str = "items",
                  _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    """Lo más vendido del período, por facturación y por cantidad.
    Lee de comprobantes (top-items mira la tabla vieja de ventas)."""
    ini, fin = _resolver_ventana(dias, desde, hasta, db)
    q = (db.query(models.ComprobanteLinea, models.Item.categoria)
           .join(models.Comprobante)
           .outerjoin(models.Item, models.ComprobanteLinea.item_id == models.Item.id)
           .filter(models.Comprobante.tipo == "ticket",
                   models.Comprobante.activo == True,
                   models.Comprobante.fecha >= ini, models.Comprobante.fecha < fin))
    agg = {}
    for linea, categoria in q.all():
        clave = (categoria or "Otros") if vista == "categorias" else (linea.nombre or "—")
        a = agg.setdefault(clave, {"nombre": clave, "cantidad": 0, "total": 0})
        a["cantidad"] += linea.cantidad or 0
        a["total"]    += linea.subtotal or 0
    ordenado = sorted(agg.values(), key=lambda x: x["total"], reverse=True)
    return {"filas": ordenado[:limite], "total_general": sum(a["total"] for a in agg.values())}


@app.get("/api/registro")
def registro_movimientos(desde: str | None = None, hasta: str | None = None,
                         dias: int = 0,
                         _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    ini, fin = _ventana(dias, desde, hasta)
    return [{"fecha": hora_argentina(m["fecha"]).strftime("%d/%m/%Y"), "hora": hora_argentina(m["fecha"]).strftime("%H:%M"),
             "clase": m["clase"], "comprobante": m["comprobante"], "cliente": m["cliente"],
             "detalle": m["detalle"], "forma_pago": m["forma_pago"], "monto": m["monto"]}
            for m in _movimientos(db, ini, fin)[:1000]]

# ---------- agenda de turnos ----------

@app.post("/api/turnos")
def crear_turno(turno: TurnoIn, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    fecha = turno.fecha or hora_argentina(fecha_hora_now_utc()).strftime("%Y-%m-%d")
    nuevo = models.Turno(fecha=fecha, hora=turno.hora, cliente=turno.cliente, cliente_id=turno.cliente_id,
                         servicio=turno.servicio, peluquero=turno.peluquero, notas=turno.notas)
    db.add(nuevo)
    db.commit()
    db.refresh(nuevo)
    return {"id": nuevo.id, "ok": True}

@app.put("/api/turnos/{turno_id}")
def editar_turno(turno_id: int, datos: TurnoIn, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    turno = db.get(models.Turno, turno_id)
    if not turno:
        raise HTTPException(404, "Turno no encontrado")
    turno.hora = datos.hora
    turno.cliente_id = datos.cliente_id
    turno.cliente = datos.cliente
    turno.servicio = datos.servicio
    turno.peluquero = datos.peluquero
    turno.notas = datos.notas
    db.commit()
    return {"ok": True}

@app.delete("/api/turnos/{turno_id}")
def cancelar_turno(turno_id: int, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    turno = db.get(models.Turno, turno_id)
    if not turno:
        raise HTTPException(404, "Turno no encontrado")
    turno.activo = False
    db.commit()
    return {"ok": True}

@app.get("/api/turnos")
def listar_turnos(fecha: str | None = None, desde: str | None = None, hasta: str | None = None,
                  _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    q = db.query(models.Turno)
    if desde and hasta:
        q = q.filter(models.Turno.fecha >= desde, models.Turno.fecha <= hasta)
    else:
        if not fecha: fecha = hora_argentina(fecha_hora_now_utc()).strftime("%Y-%m-%d")
        q = q.filter(models.Turno.fecha == fecha)
    turnos = q.all()
    turnos.sort(key=lambda t: (t.fecha, t.hora))
    return [{"id": t.id, "fecha": t.fecha, "hora": t.hora, "cliente": t.cliente, "cliente_id": t.cliente_id,
             "servicio": t.servicio, "peluquero": t.peluquero, "notas": t.notas,
             "activo": t.activo} for t in turnos]

# ---------- notas diarias ----------

@app.post("/api/notas")
def crear_nota(nota: NotaIn, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    fecha = nota.fecha or hora_argentina(fecha_hora_now_utc()).strftime("%Y-%m-%d")
    nueva = models.NotaDiaria(fecha=fecha, texto=nota.texto)
    db.add(nueva); db.commit(); db.refresh(nueva)
    return {"id": nueva.id, "ok": True}

@app.get("/api/notas")
def listar_notas(fecha: str | None = None, desde: str | None = None, hasta: str | None = None,
                 _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    q = db.query(models.NotaDiaria).filter(models.NotaDiaria.activo == True)
    if desde and hasta: # Esto significa q si existen soalmente no, porque se puede usar la funcion sin que esten por los none? explicame eso de paso
      q = q.filter(models.NotaDiaria.fecha >= desde, models.NotaDiaria.fecha <= hasta)                                        
    elif fecha:
      q = q.filter(models.NotaDiaria.fecha == fecha)
    # si no viene nada, devuelve todo lo activo (lo usa el feed general)
    notas = q.all()
    notas.sort(key=lambda n: (n.fecha, n.creada), reverse=True)
    return [{"id": n.id, "fecha": n.fecha, "texto": n.texto,
             "creada": hora_argentina(n.creada).strftime("%d/%m/%Y %H:%M")}                        # n.creada → hora argentina y formateá (mirá ventas_registro)
            for n in notas]

@app.delete("/api/notas/{nota_id}")
def borrar_nota(nota_id: int, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    nota = db.get(models.NotaDiaria, nota_id)                                     # traela por id (mirá cancelar_turno)
    if not nota: raise HTTPException(404, "Nota no encontrada")
    nota.activo = False
    db.commit(); return {"ok": True}

# ---------- descuentos ----------
@app.get("/api/descuentos")
def listar_descuentos(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
    return [{"id": d.id, "nombre": d.nombre, "porcentaje": d.porcentaje, "mostrar_motivo": d.mostrar_motivo}
            for d in db.query(models.Descuento).filter(models.Descuento.activo == True).order_by(models.Descuento.nombre)]

@app.post("/api/descuentos")
def crear_descuento(d: DescuentoIn, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    if d.porcentaje < 0 or d.porcentaje > 100: raise HTTPException(400, "Porcentaje inválido")
    nuevo = models.Descuento(nombre=d.nombre.strip(), porcentaje=d.porcentaje, mostrar_motivo=d.mostrar_motivo)
    db.add(nuevo); db.commit(); db.refresh(nuevo); return {"id": nuevo.id}

@app.put("/api/descuentos/{desc_id}")
def editar_descuento(desc_id: int, cambios: DescuentoEdit, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    d = db.get(models.Descuento, desc_id)
    if not d: raise HTTPException(404, "Descuento no existe")
    if cambios.nombre is not None: d.nombre = cambios.nombre.strip()
    if cambios.porcentaje is not None:
        if cambios.porcentaje < 0 or cambios.porcentaje > 100: raise HTTPException(400, "Porcentaje inválido")
        d.porcentaje = cambios.porcentaje
    if cambios.mostrar_motivo is not None: d.mostrar_motivo = cambios.mostrar_motivo
    if cambios.activo is not None: d.activo = cambios.activo
    db.commit(); return {"ok": True}

@app.delete("/api/descuentos/{desc_id}")
def borrar_descuento(desc_id: int, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    d = db.get(models.Descuento, desc_id)
    if not d: raise HTTPException(404, "Descuento no existe")
    d.activo = False; db.commit(); return {"ok": True}

# ---------- ajustes por ítem (descuento o recargo de UNA línea) ----------
@app.get("/api/ajustes-item")
def listar_ajustes_item(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
    return [{"id": a.id, "nombre": a.nombre, "porcentaje": a.porcentaje, "monto": a.monto or 0}
            for a in db.query(models.AjusteItem).filter(models.AjusteItem.activo == True)
                       .order_by(models.AjusteItem.porcentaje, models.AjusteItem.nombre)]

@app.post("/api/ajustes-item")
def crear_ajuste_item(a: AjusteItemIn, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    # Un ajuste guardado es de un tipo o del otro, nunca de los dos: si fuera
    # "-10% y -$2000" nadie sabría en qué orden se aplican.
    if a.porcentaje and a.monto: raise HTTPException(400, "Poné porcentaje o monto, no los dos")
    if not a.porcentaje and not a.monto: raise HTTPException(400, "El ajuste no puede ser 0")
    if a.porcentaje < -100 or a.porcentaje > 100: raise HTTPException(400, "Porcentaje inválido (-100 a 100)")
    if not a.nombre.strip(): raise HTTPException(400, "Falta el nombre")
    nuevo = models.AjusteItem(nombre=a.nombre.strip(), porcentaje=a.porcentaje, monto=a.monto)
    db.add(nuevo); db.commit(); db.refresh(nuevo); return {"id": nuevo.id}

@app.delete("/api/ajustes-item/{aj_id}")
def borrar_ajuste_item(aj_id: int, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    a = db.get(models.AjusteItem, aj_id)
    if not a: raise HTTPException(404, "Ajuste no existe")
    a.activo = False; db.commit(); return {"ok": True}

# ---------- backup completo (solo dueño) ----------
# Versión del formato del JSON. La 1 guardaba las fechas ya convertidas a hora
# argentina y sin offset, así que al restaurarla había que acordarse de sumarle
# las 3 horas: si alguien se olvidaba, la caja de todos los días quedaba corrida
# (los servicios de después de las 21:00 se iban al día siguiente). Desde la 2
# las fechas salen en UTC con el "+00:00" escrito, que es como están guardadas.
# `restaurar_backup.py` mira este número para saber cuál de las dos leyó.
BACKUP_VERSION = 2

def _iso_utc(dt):
    """Fecha en ISO con el offset explícito, o None. Lo que hay en la base es
    UTC sin marcar, así que a lo naive se le pone el UTC que ya tenía."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()

@app.get("/api/backup")
def backup_completo(_ = Depends(solo_dueno), db: Session = Depends(get_db)):
    """Descarga un JSON con TODAS las tablas para backup offline."""
    import json as _json

    data = {
        "version": BACKUP_VERSION,
        # Informativa: la mira una persona, no el importador, así que va en hora
        # argentina. Con el -03:00 puesto de verdad: hora_argentina() resta las
        # tres horas pero deja el tzinfo en UTC, y eso acá saldría escrito como
        # un "+00:00" que miente sobre lo que dice el número.
        "fecha_backup": fecha_hora_now_utc().astimezone(ARGENTINA).isoformat(),
        "items": [
            {"id": i.id, "categoria": i.categoria, "nombre": i.nombre, "precio": i.precio,
             # Va guardado y no recalculado al restaurar: calcular_transfer da el
             # valor de catálogo, pero este puede haberse editado a mano.
             "precio_transfer": i.precio_transfer,
             "es_producto": i.es_producto, "stock_actual": i.stock_actual,
             "stock_minimo": i.stock_minimo, "activo": i.activo}
            for i in db.query(models.Item).all()
        ],
        "ventas": [
            {"id": v.id, "fecha": _iso_utc(v.fecha), "forma_pago": v.forma_pago,
             "alias": v.alias, "cliente": v.cliente, "peluquero": v.peluquero, "total": v.total,
             "lineas": [
                 {"id": l.id, "item_id": l.item_id, "nombre": l.nombre,
                  "cantidad": l.cantidad, "precio_unit": l.precio_unit,
                  "dificultad": l.dificultad, "subtotal": l.subtotal}
                 for l in v.lineas
             ]}
            for v in db.query(models.Venta).order_by(models.Venta.fecha).all()
        ],
        "egresos": [
            {"id": e.id, "fecha": _iso_utc(e.fecha), "tipo": e.tipo,
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
        "turnos": [
            # cliente_id es el vínculo al cliente registrado; `cliente` es solo el
            # nombre suelto. Sin el id, al restaurar los turnos quedaban huérfanos.
            {"id": t.id, "fecha": t.fecha, "hora": t.hora, "cliente_id": t.cliente_id,
             "cliente": t.cliente, "servicio": t.servicio, "peluquero": t.peluquero,
             "notas": t.notas, "activo": t.activo}
            for t in db.query(models.Turno).order_by(models.Turno.fecha, models.Turno.hora).all()
        ],
        "notas_diarias": [
            {"id": n.id, "fecha": n.fecha, "texto": n.texto,
             "creada": _iso_utc(n.creada), "activo": n.activo}
            for n in db.query(models.NotaDiaria).order_by(models.NotaDiaria.fecha).all()
        ],
        "movimientos_stock": [
            {"id": m.id, "item_id": m.item_id, "fecha": _iso_utc(m.fecha),
             "tipo": m.tipo, "antes": m.antes, "despues": m.despues,
             "cambio": m.cambio, "motivo": m.motivo, "usuario": m.usuario}
            for m in db.query(models.MovimientoStock).order_by(models.MovimientoStock.fecha).all()
        ],
        "clientes": [
            {"id": c.id, "nombre": c.nombre, "telefono": c.telefono, "alias": c.alias,
             "notas": c.notas, "direccion": c.direccion, "dni": c.dni,
             "activo": c.activo, "creado": _iso_utc(c.creado)}
            for c in db.query(models.Cliente).all()
        ],
        "descuentos": [
            {"id": d.id, "nombre": d.nombre, "porcentaje": d.porcentaje,
             "mostrar_motivo": d.mostrar_motivo, "activo": d.activo}
            for d in db.query(models.Descuento).all()
        ],
        "comprobantes": [
            {"id": c.id, "tipo": c.tipo, "numero": c.numero, "fecha": _iso_utc(c.fecha),
             "cargado": _iso_utc(c.cargado),
             "cliente_id": c.cliente_id, "cliente_nombre": c.cliente_nombre,
             "peluquero": c.peluquero, "total_lista": c.total_lista,
             "extra_dificultad": c.extra_dificultad, "descuento_pct": c.descuento_pct,
             "descuento_nombre": c.descuento_nombre, "forma_pago": c.forma_pago,
             "mostrar_motivo": c.mostrar_motivo, "convertido_de": c.convertido_de,
             "activo": c.activo,
             "lineas": [
                 {"id": l.id, "item_id": l.item_id, "nombre": l.nombre,
                  "cantidad": l.cantidad, "precio_unit": l.precio_unit,
                  "precio_efectivo": l.precio_efectivo, "dificultad": l.dificultad,
                  "ajuste_pct": l.ajuste_pct, "ajuste_monto": l.ajuste_monto,
                  "ajuste_nombre": l.ajuste_nombre, "subtotal": l.subtotal}
                 for l in c.lineas
             ],
             "extras": [{"id": e.id, "concepto": e.concepto, "monto": e.monto} for e in c.extras]}
            for c in con_relaciones(db.query(models.Comprobante)).order_by(models.Comprobante.fecha).all()
        ],
        "ajustes_item": [
            {"id": a.id, "nombre": a.nombre, "porcentaje": a.porcentaje,
             "monto": a.monto, "activo": a.activo}
            for a in db.query(models.AjusteItem).all()
        ],
        "pagos": [
            {"id": p.id, "comprobante_id": p.comprobante_id, "fecha": _iso_utc(p.fecha),
             "monto": p.monto, "saldado": p.saldado, "forma_pago": p.forma_pago,
             "alias": p.alias, "desc_aplicado": p.desc_aplicado}
            for p in db.query(models.Pago).order_by(models.Pago.fecha).all()
        ],
    }

    contenido = _json.dumps(data, ensure_ascii=False, indent=2)
    buffer = io.BytesIO(contenido.encode("utf-8"))
    nombre = f"backup_pelu_{hora_argentina(fecha_hora_now_utc()).strftime('%Y%m%d_%H%M')}.json"

    return StreamingResponse(
        buffer,
        media_type="application/json",
        headers={"Content-Disposition": f"attachment; filename={nombre}"})

# ---------- frontend ----------
if os.path.isdir("static"):
    @app.get("/login")
    def p_login(): return FileResponse("static/login.html")
    @app.get("/")
    def p_root(): return FileResponse("static/facturar.html")
    @app.get("/facturar")
    def pagina_facturar(): return FileResponse("static/facturar.html")
    @app.get("/agenda")
    def p_agenda(): return FileResponse("static/agenda.html")
    @app.get("/admin")
    def p_admin(): return FileResponse("static/admin.html")
    @app.get("/caja")
    def p_caja(): return FileResponse("static/caja.html")
    @app.get("/inventario")
    def p_inv(): return FileResponse("static/inventario.html")
    @app.get("/clientes")
    def pagina_clientes(): return FileResponse("static/clientes.html")
    @app.get("/reportes")
    def p_rep(): return FileResponse("static/reportes.html")
    app.mount("/static", StaticFiles(directory="static"), name="static")
    @app.get("/cuenta")
    def pagina_cuenta(): return FileResponse("static/cuenta.html")
    @app.get("/historial")
    def pagina_historial(): return FileResponse("static/historial.html")
    @app.get("/ticket")
    def pagina_ticket(): return FileResponse("static/ticket.html")