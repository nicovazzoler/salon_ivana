from fastapi import FastAPI, Depends, HTTPException, Header, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import text, inspect, func, or_, String
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
    ecols = [c["name"] for c in insp.get_columns("egresos")]
    # trabajos_comision cambió de forma antes de salir a producción: linea_id pasó
    # a poder ser NULL, para los trabajos sin comprobante. En SQLite sacar un NOT
    # NULL es rehacer la tabla, y como todavía está vacía en todos lados, se la
    # borra y create_all la vuelve a crear bien. El guard de filas es para que
    # esto no toque nada si alguna vez tuviera datos.
    if insp.has_table("trabajos_comision"):
        tcols = [c["name"] for c in insp.get_columns("trabajos_comision")]
        if "item_id" not in tcols:
            with engine.begin() as con:
                filas = con.execute(text("SELECT COUNT(*) FROM trabajos_comision")).scalar()
                if not filas:
                    con.execute(text("DROP TABLE trabajos_comision"))
                else:
                    print("Aviso: trabajos_comision tiene datos y forma vieja; no se tocó.")
    if "es_comision" not in icols:
        with engine.begin() as con:
            con.execute(text("ALTER TABLE items ADD COLUMN es_comision BOOLEAN DEFAULT FALSE"))
            con.execute(text("UPDATE items SET es_comision = FALSE WHERE es_comision IS NULL"))
    if "numero" not in ecols:
        with engine.begin() as con:
            con.execute(text("ALTER TABLE egresos ADD COLUMN numero INTEGER"))
            # Los egresos que ya estaban se numeran por orden de carga, una sola
            # vez. Va acá y no con una marca en config porque la condición ya es
            # la marca: si la columna existía, esto no corre.
            filas = con.execute(text("SELECT id FROM egresos ORDER BY fecha, id")).fetchall()
            for n, (eid,) in enumerate(filas, start=1):
                con.execute(text("UPDATE egresos SET numero = :n WHERE id = :i"), {"n": n, "i": eid})
    if "privado" not in ecols:
        with engine.begin() as con:
            # FALSE y no 0: PostgreSQL no acepta un entero como default de un
            # boolean, y SQLite entiende la palabra igual desde hace años.
            con.execute(text("ALTER TABLE egresos ADD COLUMN privado BOOLEAN DEFAULT FALSE"))
            # Los que ya estaban los cargó la dueña sola (el empleado no se usaba
            # todavía), pero igual quedan a la vista: esconder de golpe egresos
            # viejos le cambiaría la caja de días ya cerrados a quien la mire.
            con.execute(text("UPDATE egresos SET privado = FALSE WHERE privado IS NULL"))
    tecols = [c["name"] for c in insp.get_columns("tipos_egreso")]
    if "privado" not in tecols:
        with engine.begin() as con:
            con.execute(text("ALTER TABLE tipos_egreso ADD COLUMN privado BOOLEAN DEFAULT FALSE"))
            con.execute(text("UPDATE tipos_egreso SET privado = FALSE WHERE privado IS NULL"))
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
        # La API no se guarda NUNCA. Hoy no pasaba nada porque estas respuestas
        # tampoco mandan Last-Modified, que es de lo que se agarra el navegador
        # para adivinar cuánto sigue fresco algo sin instrucciones. Pero
        # "no pasa nada porque falta otra cosa" no es una garantía: alcanza con
        # que un día se agregue esa cabecera, o que haya un proxy en el medio,
        # para que la tablet muestre la caja de ayer. En esta app la caché ya
        # explicó dos quejas que parecían bugs distintos.
        #
        # no-store y no no-cache: acá no hay nada que revalidar, son datos que
        # cambian con cada cobro.
        resp.headers["Cache-Control"] = "no-store"
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
    es_comision: bool = False
class ItemEdit(BaseModel):
    categoria: str | None = None; nombre: str | None = None; precio: int | None = None; activo: bool | None = None
    es_comision: bool | None = None
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
    # Sin 'privado': lo decide el TIPO al momento de cargar. Antes venía como una
    # casilla y eran dos formas de decir lo mismo, que tarde o temprano se
    # contradicen entre sí.
    tipo: str; concepto: str | None = None; monto: int; forma_pago: str | None = None; notas: str | None = None
class EgresoEdit(BaseModel):
    tipo: str | None = None; concepto: str | None = None; monto: int | None = None
    forma_pago: str | None = None; notas: str | None = None
class TipoEgresoIn(BaseModel):
    nombre: str; privado: bool = False    # privado solo lo puede pedir la dueña
class TipoEgresoEdit(BaseModel):
    nombre: str | None = None; privado: bool | None = None
class EmpleadoIn(BaseModel):
    nombre: str
class EmpleadoEdit(BaseModel):
    nombre: str | None = None; activo: bool | None = None
class SueldosConfigIn(BaseModel):
    # Los dos números con los que se arma el sueldo. Van juntos porque se miran
    # juntos: cambiar uno sin ver el otro es como no verlos.
    valor_hora: int | None = None; comision_pct: int | None = None
class HorasIn(BaseModel):
    empleado_id: int; fecha: str; minutos: int
class MinutosTrabajoIn(BaseModel):
    # Uno de los dos: linea_id si el trabajo salió de un comprobante, trabajo_id
    # si es suelto. Los sueltos nacen con la duración puesta, pero se tiene que
    # poder corregir: un cero de más ahí le descuenta horas del sueldo.
    empleado_id: int; minutos: int
    linea_id: int | None = None; trabajo_id: int | None = None
class CerrarIn(BaseModel):
    empleado_id: int; notas: str | None = None
class TrabajoSueltoIn(BaseModel):
    empleado_id: int; item_id: int; fecha: str
    cantidad: int = 1; minutos: int = 0
class PeluqueroIn(BaseModel):
    peluquero: str
class NombreEdit(BaseModel):
    nombre: str
class AjusteItemEdit(BaseModel):
    nombre: str | None = None; porcentaje: int | None = None; monto: int | None = None
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

# Vive acá arriba y no al lado de los endpoints que lo usan porque la
# migración de peluqueros, que corre al importar el módulo, lo necesita antes.
def _renombrar_en(db, columna, viejo: str, nuevo: str) -> int:
    """Cambia el nombre copiado en los movimientos ya cargados."""
    if viejo == nuevo: return 0
    return db.query(columna.class_).filter(columna == viejo).update(
        {columna: nuevo}, synchronize_session=False)

def migrar_peluqueros_a_empleados():
    """Los nombres que ya se escribieron a mano pasan a ser empleados.

    Antes `peluquero` era texto libre y en la base hay meses de nombres tipeados.
    Si la lista arrancara vacía, la dueña tendría que volver a cargarlos a mano y,
    peor, los comprobantes viejos quedarían apuntando a nombres que no existen en
    ninguna lista.

    Corre UNA vez, con marca en config: si no, cada reinicio le devolvería los
    empleados que la dueña desactivó a propósito.
    """
    MARCA_EMPLEADOS = "migro_peluqueros_a_empleados"
    from sqlalchemy.orm import Session as _S
    with _S(engine) as db:
        # Corte de arranque de los sueldos. Sin esto, el día que la dueña marque
        # "Corte" como trabajo a comisión le aparecerían como pendientes todos los
        # cortes de la historia del local, y el primer sueldo saldría absurdo.
        # Va ANTES de la marca y con su propia condición: si dependiera de la
        # marca, una base que ya había migrado los nombres con una versión
        # anterior se quedaría sin corte para siempre y arrancaría con toda la
        # historia adentro.
        if not db.query(models.Config).filter_by(clave="sueldos_desde").first():
            db.add(models.Config(clave="sueldos_desde",
                                 valor=fecha_hora_now_utc().replace(tzinfo=None).isoformat()))
            db.commit()
        if db.query(models.Config).filter_by(clave=MARCA_EMPLEADOS).first():
            return
        # Cada nombre crudo se lleva a su forma canónica con nombre_propio(), que
        # es la misma que usa el alta. Sin esto "Carla", "carla " y "CARLA" serían
        # tres empleadas distintas y el sueldo de Carla saldría partido en tres,
        # que es exactamente lo que esta tabla viene a evitar.
        canonico = {}
        for tabla in (models.Comprobante.peluquero, models.Turno.peluquero, models.Venta.peluquero):
            for (n,) in db.query(tabla).filter(tabla.isnot(None)).distinct():
                if n and n.strip():
                    canonico[n] = nombre_propio(n.strip())

        # Y lo ya cargado se normaliza también. Si la lista dice "Carla" pero los
        # comprobantes siguen diciendo "carla ", no hay forma de asociarlos y la
        # tabla no arregló nada.
        for crudo, limpio in canonico.items():
            if crudo != limpio:
                _renombrar_en(db, models.Comprobante.peluquero, crudo, limpio)
                _renombrar_en(db, models.Turno.peluquero, crudo, limpio)
                _renombrar_en(db, models.Venta.peluquero, crudo, limpio)

        # Ordenados para que el alta sea igual en cualquier base, y así los id de
        # una restauración coincidan con los del original.
        nuevos = 0
        for n in sorted(set(canonico.values())):
            if not db.query(models.Empleado).filter(models.Empleado.nombre == n).first():
                db.add(models.Empleado(nombre=n)); nuevos += 1
        db.add(models.Config(clave=MARCA_EMPLEADOS, valor=str(nuevos)))
        db.commit()
        if nuevos:
            print(f"Migración: {nuevos} empleado(s) dados de alta desde los nombres ya cargados.")

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

try:
    migrar_peluqueros_a_empleados()
except Exception as _e:
    print("Aviso: no se pudo pasar los peluqueros a empleados:", _e)

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

def es_dueno(user) -> bool:
    """Si el que pide es la dueña.

    Casi todo lo de Admin lo maneja también el empleado (el catálogo, las formas
    de pago, los descuentos): es la parte que cambia sola con el día a día y
    esperar a que la dueña la toque era el cuello de botella. Lo que queda
    reservado es lo que no tiene vuelta atrás o no es asunto suyo: los usuarios,
    el backup, el fondo de caja, los reportes y el stock.
    """
    return (user or {}).get("rol") == "dueno"

def _no_privado(col):
    """Condición SQL para "esto NO es privado", contando el NULL como que no.

    No alcanza con `col != True`: en SQL, NULL != True da NULL, o sea que la fila
    no entra. Y filas con NULL las hay: `restaurar_backup.py` levantando un
    backup viejo, de antes de que la columna existiera, escribe None. Con el
    filtro ingenuo, esos egresos desaparecían de la caja del empleado sin que
    nadie los hubiera marcado privados, y la cuenta le daba mal.
    """
    return or_(col == False, col.is_(None))

"""Buscar sin depender de los acentos.

   El nombre se guarda como se escribe —"Núñez", "María"— pero se busca como se
   tipea, apurado y en una tablet: "nunez", "maria". Antes eso no encontraba
   nada, y no era un detalle: el buscador del historial y el de clientes son la
   forma de llegar a la ficha de alguien.

   Se comparan las dos puntas sin acentos. Del lado de Python es una línea; del
   lado de la base hay que armar la misma transformación con REPLACE anidados,
   que es feo pero es lo único que anda IGUAL en SQLite y en PostgreSQL: unaccent
   es una extensión de Postgres que en SQLite no existe, y el lower() de SQLite
   no toca la Ú.

   No se pierde velocidad: un LIKE con % adelante nunca podía usar un índice, con
   acentos o sin ellos.
"""
_ACENTOS = {"á":"a","é":"e","í":"i","ó":"o","ú":"u","ü":"u","ñ":"n",
            "Á":"a","É":"e","Í":"i","Ó":"o","Ú":"u","Ü":"u","Ñ":"n"}

def _plano(texto: str) -> str:
    """El texto buscado, en minúscula y sin acentos."""
    salida = (texto or "").lower()
    for acentuada, plana in _ACENTOS.items():
        salida = salida.replace(acentuada, plana)
    return salida

def _plano_sql(col):
    """La misma cuenta que _plano(), pero para que la haga la base."""
    expr = col
    for acentuada, plana in _ACENTOS.items():
        expr = func.replace(expr, acentuada, plana)
    return func.lower(expr)

def _busca(col, texto: str):
    """Condición 'esta columna contiene ese texto', sin importar acentos ni mayúsculas."""
    return _plano_sql(col).like(f"%{_plano(texto)}%")

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

def siguiente_numero_egreso(db) -> int:
    """El próximo correlativo de egreso. Igual que el de los comprobantes: se
    mira el mayor y se le suma uno, sin secuencia de la base, para que ande
    igual en SQLite y en PostgreSQL."""
    ultimo = db.query(models.Egreso).order_by(models.Egreso.numero.desc()).first()
    return ((ultimo.numero or 0) + 1) if ultimo else 1

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

"""Un usuario por rol.

   El local es uno solo: hay una dueña y hay una persona atendiendo. Con varias
   cuentas del mismo rol, "lo que anotó el empleado" deja de querer decir algo
   —¿cuál de los tres?— y la contraseña termina siendo la misma para todos, que
   es peor que tener una cuenta compartida y saberlo.

   El tope se controla al crear y al cambiar el rol, no al arrancar: si alguna
   base quedó con dos, nadie pierde el acceso de golpe; simplemente no se puede
   sumar otro hasta borrar uno.
"""
ROLES = ("dueno", "empleado")

def _rol_ocupado(db, rol: str, salvo_id: int | None = None):
    q = db.query(models.Usuario).filter(models.Usuario.rol == rol)
    if salvo_id is not None:
        q = q.filter(models.Usuario.id != salvo_id)
    return q.first()

def _chequear_rol_libre(db, rol: str, salvo_id: int | None = None):
    if rol not in ROLES:
        raise HTTPException(400, "Rol inválido")
    ya = _rol_ocupado(db, rol, salvo_id)
    if ya:
        comose = "dueña" if rol == "dueno" else "empleado"
        raise HTTPException(400, f"Ya hay un usuario {comose} ({ya.usuario}). "
                                 f"Cambiale la contraseña a ese, o borralo antes de crear otro.")

@app.post("/api/usuarios")
def crear_usuario(u: UsuarioIn, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    if db.query(models.Usuario).filter(models.Usuario.usuario == u.usuario.strip()).first():
        raise HTTPException(400, "Ese usuario ya existe")
    _chequear_rol_libre(db, u.rol)
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
    return [{"id": i.id, "nombre": i.nombre, "precio": i.precio, "precio_transfer": i.precio_transfer,
             "es_producto": i.es_producto, "es_comision": bool(i.es_comision)} for i in q]

@app.get("/api/items/all")
def items_all(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
    q = db.query(models.Item).filter(models.Item.activo == True).order_by(models.Item.nombre)
    return [{"id": i.id, "nombre": i.nombre, "precio": i.precio, "categoria": i.categoria, "precio_transfer": i.precio_transfer,
             "es_producto": i.es_producto, "es_comision": bool(i.es_comision)} for i in q]

@app.get("/api/catalogo")
def catalogo(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
    """Todo el catálogo activo de una sola vez (para buscador y agrupado en Facturación)."""
    q = (db.query(models.Item).filter(models.Item.activo == True)
           .order_by(models.Item.categoria, models.Item.nombre))
    return [{"id": i.id, "nombre": i.nombre, "precio": i.precio, "precio_transfer": i.precio_transfer,"categoria": i.categoria,  
             "es_producto": i.es_producto} for i in q]

@app.get("/api/config")
def config(user = Depends(usuario_actual), db: Session = Depends(get_db)):
    formas = [f.nombre for f in db.query(models.FormaPago).filter(models.FormaPago.activo == True)]
    # Al empleado, tipos_visibles le saca los privados: este es el desplegable de
    # facturar y es justo donde leería "Alquiler" y ataría cabos. A la dueña se
    # los devuelve, y primero, que son los que carga ella.
    tipos = [t.nombre for t in tipos_visibles(db, user)]
    alias = [a.nombre for a in db.query(models.Alias).filter(models.Alias.activo == True)]
    vh = db.query(models.Config).filter_by(clave="valor_hora").first()
    return {"formas_pago": formas, "tipos_egreso": tipos, "alias": alias,
            "negocio": NEGOCIO,
            "valor_hora": int(vh.valor) if vh and str(vh.valor).isdigit() else 0,
            "tipos_privados": [t.nombre for t in db.query(models.TipoEgreso).filter(
                models.TipoEgreso.activo == True, models.TipoEgreso.privado == True)] if es_dueno(user) else []}

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
def tipos_visibles(db, user):
    """Los tipos de egreso que le corresponde ver a quien pregunta.

    Un tipo marcado privado ("Alquiler", "Sueldo") no se le ofrece al empleado:
    ni en el desplegable de facturar ni en la lista de Admin. Si lo viera, el
    dato que se quiso esconder se deduce igual del nombre del tipo.
    """
    q = db.query(models.TipoEgreso).filter(models.TipoEgreso.activo == True)
    if not es_dueno(user):
        q = q.filter(_no_privado(models.TipoEgreso.privado))
        return q.order_by(models.TipoEgreso.id).all()
    # A la dueña le van primero los privados. Son los suyos —alquiler, sueldos—
    # y los carga ella; los comunes ya los tiene a mano el resto del día. El
    # empleado no llega acá: para él la lista no tiene privados que ordenar.
    return q.order_by(models.TipoEgreso.privado.desc(), models.TipoEgreso.id).all()

@app.get("/api/tipos-egreso")
def listar_tipos(user = Depends(usuario_actual), db: Session = Depends(get_db)):
    return [{"id": t.id, "nombre": t.nombre, "privado": bool(t.privado)}
            for t in tipos_visibles(db, user)]

@app.post("/api/tipos-egreso")
def crear_tipo(t: TipoEgresoIn, user = Depends(usuario_actual), db: Session = Depends(get_db)):
    existe = db.query(models.TipoEgreso).filter(models.TipoEgreso.nombre == t.nombre.strip()).first()
    if existe:
        # Si el empleado tipeó justo el nombre de un tipo privado, se lo trata
        # como uno cualquiera: NO se le devuelve que existe ni se lo reactiva a
        # escondidas, pero tampoco se le rebota, que sería confirmarle que está.
        if existe.privado and not es_dueno(user):
            return {"id": existe.id}
        existe.activo = True; db.commit(); return {"id": existe.id}
    # Se puede crear ya marcado privado, para no tener que cargarlo y después
    # acordarse de tildarlo. Solo la dueña: el empleado no crea nada privado.
    nuevo = models.TipoEgreso(nombre=t.nombre.strip(), privado=bool(t.privado) and es_dueno(user))
    db.add(nuevo); db.commit(); db.refresh(nuevo); return {"id": nuevo.id}

@app.put("/api/tipos-egreso/{tipo_id}")
def editar_tipo(tipo_id: int, cambios: TipoEgresoEdit, user = Depends(usuario_actual), db: Session = Depends(get_db)):
    t = db.get(models.TipoEgreso, tipo_id)
    if not t or (t.privado and not es_dueno(user)): raise HTTPException(404, "Tipo no existe")
    if cambios.nombre is not None:
        nombre = cambios.nombre.strip()
        if not nombre: raise HTTPException(400, "Falta el nombre")
        otro = db.query(models.TipoEgreso).filter(models.TipoEgreso.nombre == nombre,
                                                  models.TipoEgreso.id != tipo_id).first()
        if otro: raise HTTPException(400, "Ya hay un tipo de egreso con ese nombre")
        # Arrastra: es una clasificación, no lo que se le dijo a nadie.
        _renombrar_en(db, models.Egreso.tipo, t.nombre, nombre)
        t.nombre = nombre
    # La marca de privado sigue siendo solo de la dueña, aunque el nombre lo
    # pueda cambiar cualquiera.
    if cambios.privado is not None and es_dueno(user): t.privado = cambios.privado
    db.commit(); return {"ok": True, "privado": bool(t.privado)}

@app.delete("/api/tipos-egreso/{tipo_id}")
def borrar_tipo(tipo_id: int, user = Depends(usuario_actual), db: Session = Depends(get_db)):
    t = db.get(models.TipoEgreso, tipo_id)
    if not t: raise HTTPException(404, "Tipo no existe")
    if t.privado and not es_dueno(user): raise HTTPException(404, "Tipo no existe")
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
    if cambios.rol is not None and cambios.rol != u.rol:
        _chequear_rol_libre(db, cambios.rol, salvo_id=uid)
        u.rol = cambios.rol
    if cambios.password:
        u.salt = auth.nuevo_salt(); u.hash = auth.hash_password(cambios.password, u.salt)
    db.commit(); return {"ok": True}

# alias de transferencia
# ---------- sueldos ----------
# El porcentaje vive en config y no en el código: cambiarlo no puede depender de
# un deploy. 40 es lo acordado hoy.
COMISION_PCT_DEFECTO = 40

def _cfg_int(db, clave, defecto=0) -> int:
    fila = db.query(models.Config).filter_by(clave=clave).first()
    try:
        return int(fila.valor) if fila else defecto
    except (TypeError, ValueError):
        return defecto

def valor_hora(db) -> int:
    return _cfg_int(db, "valor_hora", 0)

def comision_pct(db) -> int:
    return _cfg_int(db, "comision_pct", COMISION_PCT_DEFECTO)

def base_suelto(t, item) -> int:
    """La base de un trabajo sin comprobante: el precio efectivo del ítem por la
    cantidad. Mismo criterio que los que vienen de una línea, pero sin ajuste:
    no hubo comprobante donde ajustar nada."""
    return (item.precio or 0) * (t.cantidad or 1)

def base_comision(linea) -> int:
    """Sobre cuánta plata se calcula la comisión de una línea.

    Es el precio EFECTIVO con el ajuste de esa línea aplicado, por la cantidad.
    No entra el descuento del comprobante: se acordó que la comisión se cuenta
    sobre el trabajo, no sobre lo que después se le perdonó al cliente.
    """
    unidad = precio_con_ajuste(linea.precio_efectivo or 0,
                               linea.ajuste_pct, linea.ajuste_monto)
    return unidad * (linea.cantidad or 1)

def comision_de(linea, pct: int) -> int:
    return round(base_comision(linea) * pct / 100)

def lineas_a_comision_pendientes(db, empleado):
    """Las líneas a comisión de esa empleada que todavía no se pagaron.

    Pendiente no es "de esta semana": es "no está en ninguna liquidación". Por eso
    algo cargado tarde, o de un día viejo, entra igual en el próximo cierre en vez
    de perderse en una ventana que ya cerró.

    El corte de arranque existe solo para el primer cierre: sin él, el día que se
    prende la función aparecerían como pendientes todos los trabajos de la
    historia del local.
    """
    desde = db.query(models.Config).filter_by(clave="sueldos_desde").first()
    ya = db.query(models.TrabajoComision.linea_id).filter(
        models.TrabajoComision.liquidacion_id.isnot(None))
    q = (db.query(models.ComprobanteLinea, models.Comprobante)
           .join(models.Comprobante, models.ComprobanteLinea.comprobante_id == models.Comprobante.id)
           .join(models.Item, models.ComprobanteLinea.item_id == models.Item.id)
           .filter(models.Comprobante.activo == True,
                   models.Comprobante.tipo == "ticket",
                   models.Comprobante.peluquero == empleado.nombre,
                   models.Item.es_comision == True,
                   models.ComprobanteLinea.id.notin_(ya)))
    if desde and desde.valor:
        # El corte mira CUÁNDO SE ANOTÓ, no la fecha del servicio. Si mirara la
        # fecha del servicio, un trabajo de ayer anotado hoy —que es trabajo
        # nuevo, hecho con la función ya prendida— quedaría afuera para siempre y
        # nadie se enteraría. Los viejos igual quedan afuera: se anotaron antes.
        anotado = func.coalesce(models.Comprobante.cargado, models.Comprobante.fecha)
        q = q.filter(anotado >= datetime.fromisoformat(desde.valor))
    return q.order_by(models.Comprobante.fecha).all()

def resumen_pendiente(db, empleado) -> dict:
    """Lo que se le debe hoy a una empleada, calculado en vivo.

    En vivo y no guardado porque mientras está pendiente todavía puede cambiar:
    si se corrige un comprobante, el número se corrige solo. Recién al cerrar se
    saca la foto.
    """
    pct = comision_pct(db)
    vh = valor_hora(db)

    minutos_por_linea = dict(
        db.query(models.TrabajoComision.linea_id, models.TrabajoComision.minutos)
          .filter(models.TrabajoComision.empleado_id == empleado.id,
                  models.TrabajoComision.liquidacion_id.is_(None)).all())

    # Los que vienen de un comprobante. Se guarda el id del trabajo si ya existe,
    # que es lo que la pantalla necesita para guardar los minutos.
    id_por_linea = dict(
        db.query(models.TrabajoComision.linea_id, models.TrabajoComision.id)
          .filter(models.TrabajoComision.empleado_id == empleado.id,
                  models.TrabajoComision.linea_id.isnot(None),
                  models.TrabajoComision.liquidacion_id.is_(None)).all())

    trabajos, total_com, min_com = [], 0, 0
    for linea, comp in lineas_a_comision_pendientes(db, empleado):
        c = comision_de(linea, pct)
        m = minutos_por_linea.get(linea.id, 0) or 0
        total_com += c; min_com += m
        trabajos.append({
            "id": id_por_linea.get(linea.id), "linea_id": linea.id,
            "comprobante_id": comp.id, "numero": comp.numero,
            # Para que la pantalla pueda linkear a la cuenta del cliente. Sin
            # cliente_id no hay adónde ir: fue una venta de mostrador.
            "cliente_id": comp.cliente_id,
            "fecha": hora_argentina(comp.fecha).date().isoformat(),
            "nombre": linea.nombre, "cantidad": linea.cantidad,
            "base": base_comision(linea), "comision": c, "minutos": m,
            "cliente": comp.cliente_nombre, "suelto": False})

    # Y los sueltos, que no tienen comprobante detrás.
    sueltos = (db.query(models.TrabajoComision)
                 .filter(models.TrabajoComision.empleado_id == empleado.id,
                         models.TrabajoComision.linea_id.is_(None),
                         models.TrabajoComision.liquidacion_id.is_(None))
                 .order_by(models.TrabajoComision.fecha).all())
    for t in sueltos:
        item = db.get(models.Item, t.item_id) if t.item_id else None
        b = base_suelto(t, item) if item else 0
        c = round(b * pct / 100)
        m = t.minutos or 0
        total_com += c; min_com += m
        trabajos.append({
            "id": t.id, "linea_id": None, "comprobante_id": None, "numero": None,
            "cliente_id": None, "fecha": t.fecha,
            "nombre": t.nombre or (item.nombre if item else "—"),
            "cantidad": t.cantidad or 1,
            "base": b, "comision": c, "minutos": m,
            "cliente": None, "suelto": True})

    trabajos.sort(key=lambda t: (t["fecha"] or "", t["numero"] or 0))

    horas = (db.query(models.HoraTrabajada)
               .filter(models.HoraTrabajada.empleado_id == empleado.id,
                       models.HoraTrabajada.liquidacion_id.is_(None))
               .order_by(models.HoraTrabajada.fecha).all())
    min_total = sum(h.minutos or 0 for h in horas)

    # Un día en el que hizo un trabajo es un día que trabajó: aparece solo, con
    # las horas en cero esperando que las complete. Si hubiera que agregarlos a
    # mano, tendría que acordarse de qué días vino, y el día que se olvide de uno
    # se le paga de menos sin que nada avise.
    dias = {h.fecha: {"id": h.id, "fecha": h.fecha, "minutos": h.minutos or 0,
                      "sugerido": False} for h in horas}
    for t in trabajos:
        f = t["fecha"]
        if f and f not in dias:
            dias[f] = {"id": None, "fecha": f, "minutos": 0, "sugerido": True}
    dias = [dias[f] for f in sorted(dias)]

    # Las horas de los trabajos a comisión ya se pagan con la comisión, así que
    # se descuentan. Nunca baja de cero: si declaró menos horas que las que
    # duraron sus trabajos, no se le puede descontar plata por eso.
    min_pagados = max(min_total - min_com, 0)
    total_horas = round(min_pagados * vh / 60)

    return {
        "empleado": {"id": empleado.id, "nombre": empleado.nombre},
        "valor_hora": vh, "comision_pct": pct,
        "dias": dias,
        "trabajos": trabajos,
        "minutos_total": min_total, "minutos_comision": min_com,
        "minutos_pagados": min_pagados,
        "total_comisiones": total_com, "total_horas": total_horas,
        "total": total_com + total_horas,
        "desde": dias[0]["fecha"] if dias else None,
    }

# ---------- empleados ----------
# La lista la lee cualquiera: el desplegable de "peluquero" está en facturar y en
# la agenda, que usa el empleado todos los días. Tocarla es solo de la dueña.
def _empleado_o_404(db, emp_id: int):
    e = db.get(models.Empleado, emp_id)
    if not e: raise HTTPException(404, "Empleado no existe")
    return e

# Quién es la empleada que está cargando lo llega por parámetro: hay un solo
# login compartido y ella elige su nombre al entrar. Está en un solo lugar a
# propósito, para que el día que haya un PIN por persona se cambie acá y no en
# cada endpoint.
@app.get("/api/sueldos/pendiente")
def sueldo_pendiente(empleado_id: int, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    return resumen_pendiente(db, _empleado_o_404(db, empleado_id))

@app.put("/api/sueldos/horas")
def cargar_horas(h: HorasIn, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    """Las horas de un día. Se pisa el valor del día en vez de sumar: la empleada
    corrige lo que puso, no acumula intentos."""
    _empleado_o_404(db, h.empleado_id)
    if h.minutos < 0: raise HTTPException(400, "Las horas no pueden ser negativas")
    if h.minutos > 24 * 60: raise HTTPException(400, "No entran más de 24 horas en un día")
    fila = (db.query(models.HoraTrabajada)
              .filter(models.HoraTrabajada.empleado_id == h.empleado_id,
                      models.HoraTrabajada.fecha == h.fecha,
                      models.HoraTrabajada.liquidacion_id.is_(None)).first())
    if h.minutos == 0:
        if fila: db.delete(fila)
    elif fila:
        fila.minutos = h.minutos
    else:
        db.add(models.HoraTrabajada(empleado_id=h.empleado_id, fecha=h.fecha, minutos=h.minutos))
    db.commit(); return {"ok": True}

@app.put("/api/sueldos/trabajo-minutos")
def cargar_minutos_trabajo(m: MinutosTrabajoIn, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    """Cuánto duró un trabajo a comisión.

    Si viene de un comprobante la línea ya existe y esto es lo único que la
    empleada agrega; si es suelto, corrige lo que puso al cargarlo.
    """
    _empleado_o_404(db, m.empleado_id)
    if m.minutos < 0 or m.minutos > 24 * 60:
        raise HTTPException(400, "Duración fuera de rango")
    if bool(m.linea_id) == bool(m.trabajo_id):
        raise HTTPException(400, "Falta decir de qué trabajo se habla")
    if m.trabajo_id:
        t = db.get(models.TrabajoComision, m.trabajo_id)
        if not t: raise HTTPException(404, "Ese trabajo no existe")
    else:
        t = db.query(models.TrabajoComision).filter_by(linea_id=m.linea_id).first()
    if t and t.liquidacion_id:
        raise HTTPException(400, "Ese trabajo ya está en una liquidación cerrada")
    if t: t.minutos = m.minutos
    else: db.add(models.TrabajoComision(linea_id=m.linea_id, empleado_id=m.empleado_id,
                                        minutos=m.minutos))
    db.commit(); return {"ok": True}

@app.post("/api/sueldos/cerrar")
def cerrar_liquidacion(datos: CerrarIn, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    """Cierra el ciclo: saca la foto de lo pendiente y arranca uno nuevo.

    Cerrar es de la dueña, que es la que paga. Y a partir de acá esos números no
    se mueven aunque después se corrija un comprobante: la corrección va como
    ajuste en el ciclo siguiente.
    """
    emp = _empleado_o_404(db, datos.empleado_id)
    r = resumen_pendiente(db, emp)
    if not r["trabajos"] and not r["dias"]:
        raise HTTPException(400, "No hay nada pendiente para cerrar")

    hoy = hoy_argentina().isoformat()
    liq = models.Liquidacion(
        empleado_id=emp.id, desde=r["desde"], hasta=hoy,
        valor_hora=r["valor_hora"], comision_pct=r["comision_pct"],
        minutos_total=r["minutos_total"], minutos_comision=r["minutos_comision"],
        minutos_pagados=r["minutos_pagados"],
        total_comisiones=r["total_comisiones"], total_horas=r["total_horas"],
        total=r["total"], notas=datos.notas)
    db.add(liq); db.flush()

    for t in r["trabajos"]:
        # Los sueltos ya son una fila; los que vienen de una línea pueden no
        # tenerla todavía, si nadie les cargó los minutos.
        fila = db.get(models.TrabajoComision, t["id"]) if t["id"] else None
        if not fila and t["linea_id"]:
            fila = db.query(models.TrabajoComision).filter_by(linea_id=t["linea_id"]).first()
        if not fila:
            fila = models.TrabajoComision(linea_id=t["linea_id"], empleado_id=emp.id,
                                          minutos=t["minutos"], fecha=t["fecha"],
                                          nombre=t["nombre"], cantidad=t["cantidad"])
            db.add(fila)
        # La foto se completa SIEMPRE, no solo cuando la fila es nueva: una que
        # ya existía porque le habían cargado los minutos guarda el id de la
        # línea y nada más, y sin esto la liquidación cerrada se leería con el
        # trabajo en blanco. El nombre y la fecha son los de hoy: si mañana se
        # renombra el ítem, lo que se pagó tiene que seguir diciendo lo que decía.
        fila.liquidacion_id = liq.id
        fila.fecha = t["fecha"]; fila.nombre = t["nombre"]; fila.cantidad = t["cantidad"]
        fila.base = t["base"]; fila.comision = t["comision"]
    (db.query(models.HoraTrabajada)
       .filter(models.HoraTrabajada.empleado_id == emp.id,
               models.HoraTrabajada.liquidacion_id.is_(None))
       .update({"liquidacion_id": liq.id}, synchronize_session=False))
    db.commit()
    return {"id": liq.id, "total": liq.total}

@app.post("/api/sueldos/trabajo-suelto")
def crear_trabajo_suelto(t: TrabajoSueltoIn, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    """Un trabajo a comisión que no quedó en ningún comprobante.

    Pasa: se atendió a alguien y no se facturó. Si no se pudiera cargar, la
    empleada trabajaría gratis o tendría que reclamarlo de memoria. Queda marcado
    para que la dueña vea, antes de pagar, cuál no tiene respaldo.

    El monto no se tipea: sale del precio del ítem, igual que los que vienen de un
    comprobante. Así la comisión se calcula siempre sobre la misma base y nadie
    puede escribir el número que le conviene.
    """
    _empleado_o_404(db, t.empleado_id)
    item = db.get(models.Item, t.item_id)
    if not item: raise HTTPException(404, "Ese ítem no existe")
    if not item.es_comision: raise HTTPException(400, "Ese ítem no se paga por comisión")
    if t.cantidad < 1: raise HTTPException(400, "La cantidad tiene que ser al menos 1")
    if t.minutos < 0 or t.minutos > 24 * 60: raise HTTPException(400, "Duración fuera de rango")
    try:
        date.fromisoformat(t.fecha)
    except ValueError:
        raise HTTPException(400, "Fecha inválida")
    nuevo = models.TrabajoComision(
        empleado_id=t.empleado_id, item_id=item.id, nombre=item.nombre,
        cantidad=t.cantidad, fecha=t.fecha, minutos=t.minutos)
    db.add(nuevo); db.commit(); db.refresh(nuevo)
    return {"id": nuevo.id}

@app.delete("/api/sueldos/trabajo-suelto/{trabajo_id}")
def borrar_trabajo_suelto(trabajo_id: int, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    t = db.get(models.TrabajoComision, trabajo_id)
    if not t: raise HTTPException(404, "No existe")
    if t.linea_id: raise HTTPException(400, "Ese trabajo viene de un comprobante: se saca anulando el comprobante")
    if t.liquidacion_id: raise HTTPException(400, "Ese trabajo ya está en una liquidación cerrada")
    db.delete(t); db.commit(); return {"ok": True}

@app.put("/api/comprobantes/{comp_id}/peluquero")
def poner_peluquero(comp_id: int, datos: PeluqueroIn, _ = Depends(usuario_actual),
                    db: Session = Depends(get_db)):
    """Completa quién atendió en un comprobante ya hecho.

    Es lo único editable de un comprobante cobrado, y a propósito: los importes no
    se tocan nunca después de emitido. Pero el peluquero se olvida seguido y sin
    él la comisión de ese trabajo no le llega a nadie.
    """
    comp = db.get(models.Comprobante, comp_id)
    if not comp or not comp.activo: raise HTTPException(404, "Comprobante no existe")
    nombre = nombre_propio(datos.peluquero.strip())
    if not nombre: raise HTTPException(400, "Falta el nombre")
    emp = db.query(models.Empleado).filter(models.Empleado.nombre == nombre).first()
    if not emp:
        raise HTTPException(400, f"'{nombre}' no está en la lista de empleados")
    comp.peluquero = emp.nombre
    db.commit(); return {"ok": True, "peluquero": emp.nombre}

@app.get("/api/sueldos/items-comision")
def items_a_comision(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
    """El catálogo que sirve para cargar un trabajo suelto."""
    return [{"id": i.id, "nombre": i.nombre, "categoria": i.categoria, "precio": i.precio}
            for i in db.query(models.Item)
                       .filter(models.Item.activo == True, models.Item.es_comision == True)
                       .order_by(models.Item.categoria, models.Item.nombre)]

@app.get("/api/sueldos/liquidaciones")
def listar_liquidaciones(empleado_id: int | None = None, limite: int = 20,
                         _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    q = db.query(models.Liquidacion)
    if empleado_id: q = q.filter(models.Liquidacion.empleado_id == empleado_id)
    return [{"id": l.id, "empleado_id": l.empleado_id,
             "empleado": l.empleado.nombre if l.empleado else None,
             "cerrada": hora_argentina(l.cerrada).isoformat() if l.cerrada else None,
             "desde": l.desde, "hasta": l.hasta,
             "valor_hora": l.valor_hora, "comision_pct": l.comision_pct,
             "minutos_total": l.minutos_total, "minutos_comision": l.minutos_comision,
             "minutos_pagados": l.minutos_pagados,
             "total_comisiones": l.total_comisiones, "total_horas": l.total_horas,
             "total": l.total, "notas": l.notas}
            for l in q.order_by(models.Liquidacion.cerrada.desc()).limit(limite)]

@app.get("/api/sueldos/liquidaciones/{liq_id}")
def detalle_liquidacion(liq_id: int, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    """Qué se pagó en un cierre. Los números salen de la FOTO guardada, no de
    recalcular: si mañana se corrige un comprobante viejo, lo que ya se pagó
    tiene que seguir diciendo lo mismo que decía el día que se pagó."""
    liq = db.get(models.Liquidacion, liq_id)
    if not liq: raise HTTPException(404, "Esa liquidación no existe")
    trabajos = (db.query(models.TrabajoComision)
                  .filter(models.TrabajoComision.liquidacion_id == liq.id)
                  .order_by(models.TrabajoComision.fecha).all())
    horas = (db.query(models.HoraTrabajada)
               .filter(models.HoraTrabajada.liquidacion_id == liq.id)
               .order_by(models.HoraTrabajada.fecha).all())
    return {
        "id": liq.id, "empleado": liq.empleado.nombre if liq.empleado else None,
        "cerrada": hora_argentina(liq.cerrada).isoformat() if liq.cerrada else None,
        "desde": liq.desde, "hasta": liq.hasta,
        "valor_hora": liq.valor_hora, "comision_pct": liq.comision_pct,
        "minutos_total": liq.minutos_total, "minutos_comision": liq.minutos_comision,
        "minutos_pagados": liq.minutos_pagados,
        "total_comisiones": liq.total_comisiones, "total_horas": liq.total_horas,
        "total": liq.total, "notas": liq.notas,
        "dias": [{"fecha": h.fecha, "minutos": h.minutos or 0} for h in horas],
        "trabajos": [{"fecha": t.fecha, "nombre": t.nombre, "cantidad": t.cantidad or 1,
                      "minutos": t.minutos or 0, "base": t.base or 0, "comision": t.comision or 0,
                      "suelto": t.linea_id is None}
                     for t in trabajos]}

@app.get("/api/empleados")
def listar_empleados(todos: bool = False, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    q = db.query(models.Empleado)
    if not todos:
        q = q.filter(models.Empleado.activo == True)
    return [{"id": e.id, "nombre": e.nombre, "activo": bool(e.activo)}
            for e in q.order_by(models.Empleado.nombre)]

@app.post("/api/empleados")
def crear_empleado(e: EmpleadoIn, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    nombre = nombre_propio(e.nombre.strip())
    if not nombre: raise HTTPException(400, "Falta el nombre")
    ya = db.query(models.Empleado).filter(models.Empleado.nombre == nombre).first()
    if ya:
        # Volver a darlo de alta reactiva al que estaba: si no, el nombre único
        # choca y la dueña no entiende por qué no puede agregar a alguien que ve
        # que no está en la lista.
        if ya.activo: raise HTTPException(400, "Ese empleado ya está en la lista")
        ya.activo = True; db.commit(); return {"id": ya.id, "reactivado": True}
    nuevo = models.Empleado(nombre=nombre)
    db.add(nuevo); db.commit(); db.refresh(nuevo)
    return {"id": nuevo.id, "reactivado": False}

@app.put("/api/empleados/{emp_id}")
def editar_empleado(emp_id: int, cambios: EmpleadoEdit, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    e = db.get(models.Empleado, emp_id)
    if not e: raise HTTPException(404, "Empleado no existe")
    if cambios.nombre is not None:
        nombre = nombre_propio(cambios.nombre.strip())
        if not nombre: raise HTTPException(400, "Falta el nombre")
        otro = db.query(models.Empleado).filter(models.Empleado.nombre == nombre,
                                                models.Empleado.id != emp_id).first()
        if otro: raise HTTPException(400, "Ya hay un empleado con ese nombre")
        # Arrastra, como los tipos de egreso: el nombre del peluquero es una
        # clasificación, no lo que se le dijo al cliente. Si no arrastrara, un
        # comprobante viejo quedaría a nombre de alguien que ya no existe.
        _renombrar_en(db, models.Comprobante.peluquero, e.nombre, nombre)
        _renombrar_en(db, models.Turno.peluquero, e.nombre, nombre)
        e.nombre = nombre
    if cambios.activo is not None:
        e.activo = cambios.activo
    db.commit(); return {"ok": True}

# No hay DELETE a propósito: un empleado que se fue sigue teniendo comprobantes y
# liquidaciones que tienen que poder leerse. Se desactiva con el PUT.

@app.put("/api/config/sueldos")
def set_config_sueldos(datos: SueldosConfigIn, _ = Depends(solo_dueno), db: Session = Depends(get_db)):
    """El valor hora y el porcentaje de comisión.

    Cambiarlos NO toca lo ya cerrado: la liquidación guarda los dos números con
    los que se pagó. Sí cambia lo pendiente, que todavía se está calculando en
    vivo, y eso es a propósito: un aumento acordado a mitad de ciclo se paga en
    el ciclo, no al siguiente.
    """
    def guardar(clave, valor):
        fila = db.query(models.Config).filter_by(clave=clave).first()
        if fila: fila.valor = str(valor)
        else: db.add(models.Config(clave=clave, valor=str(valor)))
    if datos.valor_hora is not None:
        if datos.valor_hora < 0: raise HTTPException(400, "El valor hora no puede ser negativo")
        guardar("valor_hora", datos.valor_hora)
    if datos.comision_pct is not None:
        if not 0 <= datos.comision_pct <= 100:
            raise HTTPException(400, "La comisión va de 0 a 100")
        guardar("comision_pct", datos.comision_pct)
    db.commit()
    return {"ok": True, "valor_hora": valor_hora(db), "comision_pct": comision_pct(db)}

@app.get("/api/alias")
def listar_alias(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
    return [{"id": a.id, "nombre": a.nombre}
            for a in db.query(models.Alias).filter(models.Alias.activo == True)]

@app.post("/api/alias")
def crear_alias(a: NombreIn, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    existe = db.query(models.Alias).filter(models.Alias.nombre == a.nombre.strip()).first()
    if existe:
        existe.activo = True; db.commit(); return {"id": existe.id}
    nuevo = models.Alias(nombre=a.nombre.strip())
    db.add(nuevo); db.commit(); db.refresh(nuevo); return {"id": nuevo.id}

@app.put("/api/alias/{alias_id}")
def editar_alias(alias_id: int, cambios: NombreEdit, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    a = db.get(models.Alias, alias_id)
    if not a: raise HTTPException(404, "Alias no existe")
    nombre = cambios.nombre.strip()
    if not nombre: raise HTTPException(400, "Falta el alias")
    otro = db.query(models.Alias).filter(models.Alias.nombre == nombre,
                                         models.Alias.id != alias_id).first()
    if otro: raise HTTPException(400, "Ya hay un alias con ese nombre")
    # Arrastra: es la cuenta a la que entró la plata, y si cambia el alias uno
    # quiere ver el nombre nuevo también en los cobros de antes.
    _renombrar_en(db, models.Pago.alias, a.nombre, nombre)
    a.nombre = nombre
    db.commit(); return {"ok": True}

@app.delete("/api/alias/{alias_id}")
def borrar_alias(alias_id: int, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
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
        # El mismo criterio que el buscador del historial: sin acentos y sin
        # mayúsculas. Que las dos búsquedas de la app se porten distinto sería
        # peor que si las dos fueran estrictas.
        query = query.filter(or_(_busca(models.Cliente.nombre, q.strip()),
                                 _busca(models.Cliente.telefono, q.strip())))
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
                    # Para saber si la hora de `fecha` es real o es el mediodía
                    # que se le pone a un servicio anotado de otro día.
                    "anotado_despues": anotado_despues(comp),
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

# ---------- catalogo (admin: dueña y empleado) ----------
@app.post("/api/items")
def crear_item(item: ItemIn, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    nuevo = models.Item(categoria=item.categoria.strip(), nombre=item.nombre.strip(),
                        precio=item.precio, precio_transfer=calcular_transfer(item.precio),
                        es_producto=item.es_producto, es_comision=item.es_comision)
    db.add(nuevo); db.commit(); db.refresh(nuevo); return {"id": nuevo.id}

@app.put("/api/items/{item_id}")
def editar_item(item_id: int, cambios: ItemEdit, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    item = db.get(models.Item, item_id)
    if not item: raise HTTPException(404, "Item no existe")
    if cambios.categoria is not None: item.categoria = cambios.categoria.strip()
    if cambios.nombre is not None: item.nombre = cambios.nombre.strip()
    if cambios.precio is not None:
        item.precio = cambios.precio
        item.precio_transfer = calcular_transfer(cambios.precio)
    if cambios.activo is not None: item.activo = cambios.activo
    # Marcar o desmarcar un ítem a comisión NO toca los trabajos ya cargados: los
    # que están pendientes salen de esta marca, así que desmarcar algo hace
    # desaparecer una comisión que la empleada ya se ganó. Se cambia sabiendo eso,
    # y por eso el aviso está en la pantalla.
    if cambios.es_comision is not None: item.es_comision = cambios.es_comision
    db.commit(); return {"ok": True}

@app.delete("/api/items/{item_id}")
def borrar_item(item_id: int, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    item = db.get(models.Item, item_id)
    if not item: raise HTTPException(404, "Item no existe")
    item.activo = False; db.commit(); return {"ok": True}

@app.put("/api/categorias")
def renombrar_categoria(datos: RenombrarCat, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    n = db.query(models.Item).filter(models.Item.categoria == datos.viejo).update(
        {models.Item.categoria: datos.nuevo.strip()})
    db.commit(); return {"actualizados": n}

# ---------- formas de pago ----------
"""Las dos formas de pago que no se tocan.

   "Efectivo" y "Transferencia" no son dos opciones más de una lista: son los
   dos nombres con los que la app hace cuentas. El arqueo suma "lo que entró en
   efectivo" comparando `pago.forma_pago == "Efectivo"`, y al cobrar se guarda
   ese texto exacto. Si alguien las renombra o las borra desde Admin, el
   desplegable de cobro se queda sin la opción, los pagos salen con la forma
   vacía y el arqueo empieza a decir que hay más plata en el cajón de la que
   hay. Y no avisa: la app sigue andando perfecto.

   Se podían borrar desde antes de que existiera este candado. Se agrega ahora
   porque a la lista se le suma poder renombrar, que es la misma trampa con un
   botón más a mano.

   Agregar formas nuevas ("Cuenta DNI", "Débito") sigue siendo libre: esas no
   entran en ninguna cuenta, solo se muestran.
"""
FORMAS_FIJAS = ("Efectivo", "Transferencia")

@app.get("/api/formas")
def listar_formas(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
    return [{"id": f.id, "nombre": f.nombre, "fija": f.nombre in FORMAS_FIJAS}
            for f in db.query(models.FormaPago).filter(models.FormaPago.activo == True)]

@app.post("/api/formas")
def crear_forma(forma: FormaIn, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    nombre = forma.nombre.strip()
    if not nombre: raise HTTPException(400, "Falta el nombre")
    existe = db.query(models.FormaPago).filter(models.FormaPago.nombre == nombre).first()
    if existe: existe.activo = True; db.commit(); return {"id": existe.id}
    nueva = models.FormaPago(nombre=nombre)
    db.add(nueva); db.commit(); db.refresh(nueva); return {"id": nueva.id}

@app.put("/api/formas/{forma_id}")
def editar_forma(forma_id: int, cambios: NombreEdit, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    f = db.get(models.FormaPago, forma_id)
    if not f: raise HTTPException(404, "Forma no existe")
    if f.nombre in FORMAS_FIJAS:
        raise HTTPException(400, f'"{f.nombre}" no se puede renombrar: la caja hace cuentas con ese nombre.')
    nombre = cambios.nombre.strip()
    if not nombre: raise HTTPException(400, "Falta el nombre")
    if nombre in FORMAS_FIJAS:
        raise HTTPException(400, f'"{nombre}" está reservado.')
    otra = db.query(models.FormaPago).filter(models.FormaPago.nombre == nombre,
                                             models.FormaPago.id != forma_id).first()
    if otra: raise HTTPException(400, "Ya hay una forma de pago con ese nombre")
    # Se arrastra a los pagos ya cobrados: la forma de pago es una clasificación,
    # y con dos nombres para lo mismo el desglose de la caja queda partido en dos.
    _renombrar_en(db, models.Pago.forma_pago, f.nombre, nombre)
    _renombrar_en(db, models.Egreso.forma_pago, f.nombre, nombre)
    f.nombre = nombre
    db.commit(); return {"ok": True}

@app.delete("/api/formas/{forma_id}")
def borrar_forma(forma_id: int, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    f = db.get(models.FormaPago, forma_id)
    if not f: raise HTTPException(404, "Forma no existe")
    if f.nombre in FORMAS_FIJAS:
        raise HTTPException(400, f'"{f.nombre}" no se puede eliminar: sin ella el arqueo de caja deja de dar.')
    f.activo = False; db.commit(); return {"ok": True}

"""Renombrar una de estas listas: ¿qué pasa con lo ya cargado?

   Los nombres se guardan copiados en cada movimiento (`egresos.tipo`,
   `pagos.alias`, `comprobantes.descuento_nombre`...), así que renombrar en la
   lista no cambia el pasado por sí solo. Hay que decidir caso por caso, y la
   respuesta no es la misma para todos:

     - Los tipos de egreso y los alias son una CLASIFICACIÓN. Si "Gasto /
       insumo" pasa a llamarse "Insumos", uno espera que la caja diga "Insumos"
       en todo, no que aparezcan dos renglones para lo mismo. Se arrastra, igual
       que ya hacía renombrar una categoría del catálogo.

     - Los descuentos y los ajustes por ítem son lo que se le DIJO al cliente.
       El papel que se imprimió el año pasado decía "Jubilado 10%", y volver a
       imprimirlo tiene que seguir diciendo eso. No se arrastra: el nombre nuevo
       vale para lo que se cobre de acá en adelante.
"""
# ---------- log de stock ----------
def log_stock(db, item, tipo, cambio, motivo, usuario="sistema"):
    antes = item.stock_actual or 0
    db.add(models.MovimientoStock(
        item_id=item.id, tipo=tipo, antes=antes,
        despues=antes + cambio, cambio=cambio,
        motivo=motivo, usuario=usuario))

# ---------- comprobantes ----------
"""Historial paginado.

   Antes esta ruta devolvía TODOS los comprobantes activos y la pantalla se
   arreglaba sola: filtraba, ordenaba y dibujaba de a 60. Con un año de trabajo
   eso son más de mil, y el costo no estaba en dibujarlos sino antes: cada vez
   que se abría el historial se traían las mil filas con sus líneas, sus extras y
   sus pagos, y se calculaba el estado de cada una, para mostrar sesenta.

   Ahora el recorte lo hace la base. Pero hay una parte que NO se puede mover a
   SQL: el saldo de un comprobante sale de estado_comprobante(), que recorre las
   líneas aplicando precio_con_ajuste() y los redondeos de las dos listas.
   Escribir esa misma cuenta en SQL sería tener dos versiones de la cuenta de la
   plata, y el día que se toca una y no la otra el historial dice una cosa y la
   caja otra. Así que hay dos caminos:

     - El de todos los días (ordenar por fecha o por número, con o sin búsqueda):
       filtra, ordena y corta en SQL, y solo calcula el estado de los que entran
       en la página. Es el que hace que la pantalla abra rápido.

     - El de los filtros que dependen del saldo (con deuda, convertidos, sin
       convertir) y el orden por monto: ahí no queda otra que traer lo que pasó
       los filtros de SQL y calcular en Python, como antes. Sale lo mismo que
       salía siempre, pero solo cuando lo pedís, y ya recortado por fecha y por
       lo que hayas buscado.

   Buscar por cliente o por número sigue mirando el historial entero: la pantalla
   pasa el período a "Todo" cuando escribís, y se ve que lo hizo.
"""
TOPE_PAGINA = 200          # techo por si alguien pide una página enorme a mano

# Ordenar por estas dos es barato: son columnas de la tabla. Por cliente y por
# monto hay que calcular o comparar en Python, y por eso caen al camino largo.
ORDEN_SQL = {"fecha": models.Comprobante.fecha, "numero": models.Comprobante.numero}
ESTADOS_LISTA = ("todos", "deuda", "convertidos", "sinconvertir")

def _sin_acentos(s: str) -> str:
    """Para ordenar nombres como los ordena una persona: "Núñez" al lado de
    "Nuñez", no después de todo. Es el equivalente del sensitivity:"base" que
    usaba el localeCompare de la pantalla."""
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFD", (s or "").lower())
                   if unicodedata.category(c) != "Mn")

@app.get("/api/comprobantes")
def listar_comprobantes(tipo: str | None = None,
                        desde: str | None = None, hasta: str | None = None,
                        q: str | None = None, numero: str | None = None,
                        estado: str = "todos",
                        orden: str = "fecha", desc: bool = True,
                        limite: int = 60, offset: int = 0,
                        _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    limite = max(1, min(limite, TOPE_PAGINA))
    offset = max(0, offset)
    if estado not in ESTADOS_LISTA: estado = "todos"

    base = db.query(models.Comprobante).filter(models.Comprobante.activo == True)
    if tipo: base = base.filter(models.Comprobante.tipo == tipo)
    # Cuántos hay en total sin ningún filtro de los de la pantalla: es el "de N"
    # del resumen ("23 de 1.412"), y se cuenta acá porque después la query se
    # ensucia con los filtros.
    total_sin_filtros = base.count()

    # Ventana de fechas. Van por _rango_dia porque `desde` y `hasta` son días
    # ARGENTINOS y lo guardado es UTC: sin esto, "hasta el 7" se comía lo
    # facturado el 7 después de las 21:00, que en UTC ya es el 8.
    if desde:
        try: base = base.filter(models.Comprobante.fecha >= _rango_dia(date.fromisoformat(desde[:10]))[0])
        except ValueError: raise HTTPException(400, "Fecha 'desde' inválida (se espera AAAA-MM-DD)")
    if hasta:
        try: base = base.filter(models.Comprobante.fecha < _rango_dia(date.fromisoformat(hasta[:10]))[1])
        except ValueError: raise HTTPException(400, "Fecha 'hasta' inválida (se espera AAAA-MM-DD)")

    if q and q.strip():
        # Sin acentos y sin mayúsculas de los dos lados: "nunez" encuentra a
        # "Núñez", que es como se tipea entre cliente y cliente.
        base = base.filter(_busca(models.Comprobante.cliente_nombre, q.strip()))
    if numero and numero.strip():
        # Mismo criterio que tenía la pantalla: "12" encuentra el 12, el 120 y el
        # 312. Se compara como texto, así que el número va casteado.
        base = base.filter(func.cast(models.Comprobante.numero, String).like(f"%{numero.strip()}%"))

    # ¿Alcanza con SQL, o hay que calcular el estado de cada uno?
    por_saldo = estado != "todos" or orden not in ORDEN_SQL

    if not por_saldo:
        total = base.count()
        col = ORDEN_SQL[orden]
        # El desempate SIEMPRE por número descendente, igual que en la pantalla:
        # sin él, dos comprobantes del mismo día se pueden cambiar de lugar entre
        # una página y la siguiente, y alguno aparece dos veces o ninguna.
        orden_sql = [col.desc() if desc else col.asc(), models.Comprobante.numero.desc()]
        comps = (con_relaciones(base).order_by(*orden_sql).limit(limite).offset(offset).all())
        return _pagina_comprobantes(db, comps, total, total_sin_filtros, None)

    # Camino largo: se calcula el estado de todo lo que pasó los filtros de SQL.
    todos = con_relaciones(base).all()
    pagos_map = pagos_por_comprobante(db, todos)
    convertidos = _convertidos_de(db, [c.id for c in todos])

    filas = []
    for comp in todos:
        est = estado_comprobante(db, comp, pagos_map)
        conv = convertidos.get(comp.id) if comp.tipo == "presupuesto" else None
        if estado == "deuda" and not (est["saldo"] > 0): continue
        if estado == "convertidos" and not conv: continue
        if estado == "sinconvertir" and conv: continue
        filas.append((comp, est, conv))

    clave = {
        "fecha":   lambda f: f[0].fecha,
        "numero":  lambda f: f[0].numero,
        "monto":   lambda f: f[1]["ingresado"] + f[1]["saldo"],
        "cliente": lambda f: _sin_acentos(f[0].cliente_nombre or "Mostrador"),
    }.get(orden, lambda f: f[0].fecha)
    # Dos pasadas en vez de una clave compuesta: el desempate por número va
    # siempre descendente, dé para donde dé el orden principal.
    filas.sort(key=lambda f: f[0].numero, reverse=True)
    filas.sort(key=clave, reverse=desc)

    total = len(filas)
    # La deuda del período, para el resumen del filtro. Se suma sobre TODO lo que
    # coincide, no sobre la página: "12 con deuda · $340.000" tiene que ser la
    # deuda de los doce, no la de los que se están viendo.
    deuda = sum(f[1]["saldo"] for f in filas if f[1]["saldo"] > 0) if estado == "deuda" else None
    recorte = filas[offset:offset + limite]
    return _pagina_comprobantes(db, [f[0] for f in recorte], total, total_sin_filtros, deuda,
                                precalculado={f[0].id: (f[1], f[2]) for f in recorte})

def _convertidos_de(db, ids) -> dict:
    """{id del presupuesto: número del ticket en que se convirtió}."""
    if not ids: return {}
    salida = {}
    for i in range(0, len(ids), 500):        # el tope de parámetros de SQLite
        for origen, num in db.query(models.Comprobante.convertido_de, models.Comprobante.numero)\
                             .filter(models.Comprobante.convertido_de.in_(ids[i:i+500])):
            salida[origen] = num
    return salida

def _pagina_comprobantes(db, comps, total, total_sin_filtros, deuda, precalculado=None):
    """Arma la respuesta de una página ya elegida.

    `precalculado` viene del camino largo, que ya calculó el estado de estos
    mismos comprobantes: sin él se calcularían dos veces."""
    pagos_map = pagos_por_comprobante(db, comps)
    convertidos = (None if precalculado is not None
                   else _convertidos_de(db, [c.id for c in comps if c.tipo == "presupuesto"]))
    out = []
    for comp in comps:
        if precalculado is not None:
            est, conv = precalculado[comp.id]
        else:
            est = estado_comprobante(db, comp, pagos_map)
            conv = convertidos.get(comp.id) if comp.tipo == "presupuesto" else None
        out.append({"id": comp.id, "tipo": comp.tipo, "numero": comp.numero,
                    "fecha": comp.fecha.isoformat(), "cliente_nombre": comp.cliente_nombre, "cliente_id": comp.cliente_id,
                    "total_lista": comp.total_lista, "extra_dificultad": comp.extra_dificultad,
                    "convertido_a": conv, "forma_pago": forma_comprobante(db, comp, pagos_map),
                    "forma_origen": comp.forma_pago, "anotado_despues": anotado_despues(comp),
                    **est})
    return {"comprobantes": out, "total": total, "total_sin_filtros": total_sin_filtros,
            "deuda_total": deuda}

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
    # Anotar un servicio con fecha de otro día mueve plata de una caja a otra:
    # el cobro sale del día en que se atendió y no del día en que se cargó. Eso
    # lo decide la dueña; el empleado factura siempre en el día.
    #
    # Se compara la fecha YA validada y no el texto que llegó: fecha_del_servicio
    # es la que rebota un "2026-13-40" con un 400 en vez de reventar acá.
    fecha_serv = fecha_del_servicio(c.fecha, ahora)
    if not es_dueno(user) and hora_argentina(fecha_serv).date() != hoy_argentina():
        raise HTTPException(403, "Solo la dueña puede anotar un servicio de otro día")
    comp = models.Comprobante(
        tipo=c.tipo, numero=siguiente_numero(db, c.tipo),
        fecha=fecha_serv, cargado=ahora,
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
"""Egresos privados.

   La dueña anota el alquiler y los sueldos en la misma pantalla que el resto de
   los egresos, pero eso no es asunto de quien atiende: un egreso privado no
   aparece en la lista del empleado ni suma en los totales de SU caja. En la de
   la dueña sale todo, con la marca de que es privado.

   Qué es privado se decide en dos lugares que se complementan:
     - la casilla al cargarlo, que la dueña puede tildar y destildar;
     - el tipo marcado como privado, que la tilda solo y no deja destildarla
       (si "Alquiler" es privado, no hay alquiler que no lo sea).

   Un egreso cargado POR el empleado nunca es privado, aunque le haya puesto un
   nombre de tipo reservado: esconderle lo que él mismo acaba de anotar le
   dejaría el arqueo sin explicación.
"""
def _tipo_privado(db, nombre: str | None) -> bool:
    if not nombre: return False
    t = db.query(models.TipoEgreso).filter(models.TipoEgreso.nombre == nombre.strip()).first()
    return bool(t and t.privado)

def _ve_el_egreso(user, e) -> bool:
    return es_dueno(user) or not e.privado

@app.post("/api/egresos")
def crear_egreso(e: EgresoIn, user = Depends(usuario_actual), db: Session = Depends(get_db)):
    # FOTO: se decide una sola vez, al cargar, según quién carga y qué tipo eligió.
    # Después no se recalcula: un egreso que anotó el empleado le tiene que seguir
    # apareciendo aunque la dueña marque ese tipo como privado el mes que viene.
    privado = es_dueno(user) and _tipo_privado(db, e.tipo)
    eg = models.Egreso(numero=siguiente_numero_egreso(db),
                       tipo=e.tipo, concepto=e.concepto, monto=e.monto,
                       forma_pago=e.forma_pago, notas=e.notas, privado=privado,
                       fecha=fecha_hora_now_utc())
    db.add(eg); db.commit(); db.refresh(eg)
    return {"id": eg.id, "numero": eg.numero, "privado": privado}

@app.get("/api/egresos/dia")
def egresos_dia(user = Depends(usuario_actual), db: Session = Depends(get_db)):
    ini, fin = _rango_dia(hoy_argentina())
    q = db.query(models.Egreso).filter(models.Egreso.fecha >= ini, models.Egreso.fecha < fin)
    if not es_dueno(user):
        q = q.filter(_no_privado(models.Egreso.privado))
    es = q.order_by(models.Egreso.id.desc()).all()
    return [{"id": e.id, "hora": hora_argentina(e.fecha).strftime("%H:%M"), "tipo": e.tipo, "concepto": e.concepto,
             "monto": e.monto, "forma_pago": e.forma_pago, "privado": bool(e.privado),
             "numero": e.numero} for e in es]

@app.put("/api/egresos/{egreso_id}")
def editar_egreso(egreso_id: int, cambios: EgresoEdit, user = Depends(usuario_actual), db: Session = Depends(get_db)):
    e = db.get(models.Egreso, egreso_id)
    # Un egreso que no ve tampoco lo puede tocar, y se contesta 404 y no 403:
    # un "no podés" ya sería confirmarle que ese egreso existe.
    if not e or not _ve_el_egreso(user, e): raise HTTPException(404, "Egreso no existe")
    if not _puede_modificar(user, e.fecha):
        raise HTTPException(403, "Solo el dueño puede editar egresos de otros días")
    if cambios.tipo is not None: e.tipo = cambios.tipo
    if cambios.concepto is not None: e.concepto = cambios.concepto
    if cambios.monto is not None: e.monto = cambios.monto
    if cambios.forma_pago is not None: e.forma_pago = cambios.forma_pago
    if cambios.notas is not None: e.notas = cambios.notas
    # Editar NO reclasifica. Antes, un egreso cuyo tipo hubiera pasado a privado
    # se volvía privado al guardar cualquier corrección, la hiciera quien la
    # hiciera: el empleado corregía el monto de un egreso suyo y ese egreso
    # desaparecía de su propia caja, con el arqueo bajando sin explicación.
    db.commit()
    # Cuando la foto y el tipo dejaron de coincidir, se avisa en vez de
    # emparejarlos por las nuestras: la dueña decide si ese egreso viejo tiene
    # que pasar a privado, y para eso lo mueve a un tipo privado.
    desacuerdo = es_dueno(user) and bool(e.privado) != _tipo_privado(db, e.tipo)
    return {"ok": True, "privado": bool(e.privado), "desacuerda_con_el_tipo": desacuerdo}

@app.delete("/api/egresos/{egreso_id}")
def anular_egreso(egreso_id: int, user = Depends(usuario_actual), db: Session = Depends(get_db)):
    e = db.get(models.Egreso, egreso_id)
    if not e or not _ve_el_egreso(user, e): raise HTTPException(404, "Egreso no existe")
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
def caja_dia(fecha: str | None = None, user = Depends(usuario_actual), db: Session = Depends(get_db)):
    d = date.fromisoformat(fecha) if fecha else hoy_argentina()
    ini, fin = _rango_dia(d)
    pagos = db.query(models.Pago).filter(models.Pago.fecha >= ini, models.Pago.fecha < fin).all()
    q_eg = db.query(models.Egreso).filter(models.Egreso.fecha >= ini, models.Egreso.fecha < fin)
    # Los egresos privados se van de la caja del empleado ENTERA, no solo del
    # detalle: si siguieran contando en el total, el número le diría que salió
    # plata que no puede ver de dónde, que es peor que no mostrarlos.
    if not es_dueno(user):
        q_eg = q_eg.filter(_no_privado(models.Egreso.privado))
    egresos = q_eg.all()
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
            "egresos_detalle": [{"id": e.id, "numero": e.numero,
                                 "hora": hora_argentina(e.fecha).strftime("%H:%M"), "tipo": e.tipo,
                                 "concepto": e.concepto, "monto": e.monto, "forma_pago": e.forma_pago,
                                 "privado": bool(e.privado)}
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

# ---------- inventario ----------
# Lo lee cualquiera: el empleado necesita saber si queda shampoo para venderlo, y
# preguntar por WhatsApp no es una forma de consultar el stock. Corregirlo sigue
# siendo de la dueña: el stock es plata y un número mal contado se arrastra.
@app.get("/api/inventario")
def inventario(_ = Depends(usuario_actual), db: Session = Depends(get_db)):
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
def crear_descuento(d: DescuentoIn, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    if d.porcentaje < 0 or d.porcentaje > 100: raise HTTPException(400, "Porcentaje inválido")
    nuevo = models.Descuento(nombre=d.nombre.strip(), porcentaje=d.porcentaje, mostrar_motivo=d.mostrar_motivo)
    db.add(nuevo); db.commit(); db.refresh(nuevo); return {"id": nuevo.id}

@app.put("/api/descuentos/{desc_id}")
def editar_descuento(desc_id: int, cambios: DescuentoEdit, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
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
def borrar_descuento(desc_id: int, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
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
def crear_ajuste_item(a: AjusteItemIn, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    # Un ajuste guardado es de un tipo o del otro, nunca de los dos: si fuera
    # "-10% y -$2000" nadie sabría en qué orden se aplican.
    if a.porcentaje and a.monto: raise HTTPException(400, "Poné porcentaje o monto, no los dos")
    if not a.porcentaje and not a.monto: raise HTTPException(400, "El ajuste no puede ser 0")
    if a.porcentaje < -100 or a.porcentaje > 100: raise HTTPException(400, "Porcentaje inválido (-100 a 100)")
    if not a.nombre.strip(): raise HTTPException(400, "Falta el nombre")
    nuevo = models.AjusteItem(nombre=a.nombre.strip(), porcentaje=a.porcentaje, monto=a.monto)
    db.add(nuevo); db.commit(); db.refresh(nuevo); return {"id": nuevo.id}

@app.put("/api/ajustes-item/{aj_id}")
def editar_ajuste_item(aj_id: int, cambios: AjusteItemEdit, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
    a = db.get(models.AjusteItem, aj_id)
    if not a: raise HTTPException(404, "Ajuste no existe")
    pct = a.porcentaje if cambios.porcentaje is None else cambios.porcentaje
    monto = a.monto if cambios.monto is None else cambios.monto
    # Las mismas reglas que al crearlo: uno o el otro, nunca los dos, nunca cero.
    if pct and monto: raise HTTPException(400, "Poné porcentaje o monto, no los dos")
    if not pct and not monto: raise HTTPException(400, "El ajuste no puede ser 0")
    if pct < -100 or pct > 100: raise HTTPException(400, "Porcentaje inválido (-100 a 100)")
    if cambios.nombre is not None:
        if not cambios.nombre.strip(): raise HTTPException(400, "Falta el nombre")
        # NO se arrastra: el nombre del ajuste sale impreso en el ticket, así que
        # es lo que se le dijo al cliente ese día. Ver el criterio de arriba.
        a.nombre = cambios.nombre.strip()
    a.porcentaje = pct; a.monto = monto
    db.commit(); return {"ok": True}

@app.delete("/api/ajustes-item/{aj_id}")
def borrar_ajuste_item(aj_id: int, _ = Depends(usuario_actual), db: Session = Depends(get_db)):
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
             "es_producto": i.es_producto, "es_comision": bool(i.es_comision),
             "stock_actual": i.stock_actual,
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
            {"id": e.id, "numero": e.numero, "fecha": _iso_utc(e.fecha), "tipo": e.tipo,
             "concepto": e.concepto, "monto": e.monto,
             "forma_pago": e.forma_pago, "notas": e.notas, "privado": bool(e.privado)}
            for e in db.query(models.Egreso).order_by(models.Egreso.fecha).all()
        ],
        "empleados": [
            {"id": e.id, "nombre": e.nombre, "activo": e.activo}
            for e in db.query(models.Empleado).all()
        ],
        "liquidaciones": [
            {"id": l.id, "empleado_id": l.empleado_id, "cerrada": _iso_utc(l.cerrada),
             "desde": l.desde, "hasta": l.hasta, "valor_hora": l.valor_hora,
             "comision_pct": l.comision_pct, "minutos_total": l.minutos_total,
             "minutos_comision": l.minutos_comision, "minutos_pagados": l.minutos_pagados,
             "total_comisiones": l.total_comisiones, "total_horas": l.total_horas,
             "total": l.total, "notas": l.notas}
            for l in db.query(models.Liquidacion).order_by(models.Liquidacion.id).all()
        ],
        "horas_trabajadas": [
            {"id": h.id, "empleado_id": h.empleado_id, "fecha": h.fecha,
             "minutos": h.minutos, "liquidacion_id": h.liquidacion_id,
             "cargado": _iso_utc(h.cargado)}
            for h in db.query(models.HoraTrabajada).order_by(models.HoraTrabajada.id).all()
        ],
        "trabajos_comision": [
            {"id": t.id, "linea_id": t.linea_id, "empleado_id": t.empleado_id,
             "item_id": t.item_id, "nombre": t.nombre, "cantidad": t.cantidad,
             "fecha": t.fecha, "minutos": t.minutos, "liquidacion_id": t.liquidacion_id,
             "base": t.base, "comision": t.comision}
            for t in db.query(models.TrabajoComision).order_by(models.TrabajoComision.id).all()
        ],
        "formas_pago": [
            {"id": f.id, "nombre": f.nombre, "activo": f.activo}
            for f in db.query(models.FormaPago).all()
        ],
        "tipos_egreso": [
            {"id": t.id, "nombre": t.nombre, "activo": t.activo, "privado": bool(t.privado)}
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
    @app.get("/sueldos")
    def p_sueldos(): return FileResponse("static/sueldos.html")
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