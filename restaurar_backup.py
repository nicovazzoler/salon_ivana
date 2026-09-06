"""Restaura un backup JSON de /api/backup dentro de una base vacía.

El backup existía desde siempre, pero no había con qué volver a meterlo: era un
archivo, no un respaldo. Esto es la otra mitad.

    python3 restaurar_backup.py backup_pelu_20260905_2130.json \
        --destino sqlite:///revisado.db

Por qué pide el destino a mano y por qué se planta si la base tiene datos: la
forma de restaurar sin miedo es levantar una base nueva al lado, mirarla, y
recién ahí decidir. Que el default sea "no piso nada" es a propósito; el día que
haga falta de verdad va a ser un día de nervios y no es momento de descubrir que
el comando por descuido apuntaba a producción.
"""
import argparse
import json
import sys
from datetime import datetime, timedelta, timezone

from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker

import models


def _a_utc_naive(iso, version):
    """Deja la fecha como la base la quiere: UTC y sin tzinfo.

    Los backups versión 1 guardaban la fecha ya pasada a hora argentina y sin
    offset, así que hay que devolverle las 3 horas. Si esto se saltea, todo lo
    cargado después de las 21:00 argentinas cae en el día anterior y la caja de
    cada día cierra con los números de otro. Del 2 en adelante viene el
    '+00:00' escrito y no hay nada que adivinar.
    """
    if not iso:
        return None
    dt = datetime.fromisoformat(iso)
    if dt.tzinfo is not None:
        return dt.astimezone(timezone.utc).replace(tzinfo=None)
    if version < 2:
        return dt + timedelta(hours=3)
    return dt


# Orden de inserción: cada tabla va después de aquellas a las que apunta con una
# clave foránea. comprobantes se apunta a sí misma (convertido_de) y por eso se
# carga en dos pasadas, más abajo.
ORDEN = [
    ("items", models.Item, ["id", "categoria", "nombre", "precio", "precio_transfer",
                            "es_producto", "stock_actual", "stock_minimo", "activo"], []),
    ("clientes", models.Cliente, ["id", "nombre", "telefono", "alias", "notas",
                                  "direccion", "dni", "activo"], ["creado"]),
    ("formas_pago", models.FormaPago, ["id", "nombre", "activo"], []),
    ("tipos_egreso", models.TipoEgreso, ["id", "nombre", "activo"], []),
    ("usuarios", models.Usuario, ["id", "usuario", "salt", "hash", "rol"], []),
    ("config", models.Config, ["clave", "valor"], []),
    ("fondo_caja", models.FondoCaja, ["fecha", "monto"], []),
    ("alias", models.Alias, ["id", "nombre", "activo"], []),
    ("descuentos", models.Descuento, ["id", "nombre", "porcentaje",
                                      "mostrar_motivo", "activo"], []),
    ("ajustes_item", models.AjusteItem, ["id", "nombre", "porcentaje", "monto", "activo"], []),
    ("notas_diarias", models.NotaDiaria, ["id", "fecha", "texto", "activo"], ["creada"]),
    ("egresos", models.Egreso, ["id", "tipo", "concepto", "monto",
                                "forma_pago", "notas"], ["fecha"]),
    ("turnos", models.Turno, ["id", "fecha", "hora", "cliente_id", "cliente",
                              "servicio", "peluquero", "notas", "activo"], []),
    ("movimientos_stock", models.MovimientoStock, ["id", "item_id", "tipo", "antes",
                                                   "despues", "cambio", "motivo",
                                                   "usuario"], ["fecha"]),
    ("ventas", models.Venta, ["id", "forma_pago", "alias", "cliente",
                              "peluquero", "total"], ["fecha"]),
    ("pagos", models.Pago, ["id", "comprobante_id", "monto", "saldado", "forma_pago",
                            "alias", "desc_aplicado"], ["fecha"]),
]

# Tablas que viven anidadas adentro de otra en el JSON.
ANIDADAS = [
    ("ventas", "lineas", models.VentaLinea, "venta_id",
     ["id", "item_id", "nombre", "cantidad", "precio_unit", "dificultad", "subtotal"]),
    ("comprobantes", "lineas", models.ComprobanteLinea, "comprobante_id",
     ["id", "item_id", "nombre", "cantidad", "precio_unit", "precio_efectivo",
      "dificultad", "ajuste_pct", "ajuste_monto", "ajuste_nombre", "subtotal"]),
    ("comprobantes", "extras", models.ComprobanteExtra, "comprobante_id",
     ["id", "concepto", "monto"]),
]

CAMPOS_COMPROBANTE = ["id", "tipo", "numero", "cliente_id", "cliente_nombre", "peluquero",
                      "total_lista", "extra_dificultad", "descuento_pct", "descuento_nombre",
                      "forma_pago", "mostrar_motivo", "activo"]


def _filas(datos, clave, campos, campos_fecha, version):
    salida = []
    for fila in datos.get(clave, []):
        d = {c: fila.get(c) for c in campos}
        for c in campos_fecha:
            d[c] = _a_utc_naive(fila.get(c), version)
        salida.append(d)
    return salida


def _insertar(db, modelo, filas):
    if filas:
        db.execute(modelo.__table__.insert(), filas)
    return len(filas)


def _esta_vacia(db):
    """Mira las tablas donde vive lo que no se puede reponer a mano."""
    for modelo in (models.Comprobante, models.Cliente, models.Item, models.Pago):
        if db.scalar(select(func.count()).select_from(modelo.__table__)):
            return False
    return True


def _vaciar(db):
    # Al revés del orden de carga, para no chocar con las claves foráneas.
    modelos = [m for _, m, _, _ in ORDEN]
    modelos += [models.VentaLinea, models.ComprobanteLinea,
                models.ComprobanteExtra, models.Comprobante]
    for modelo in reversed(modelos):
        db.execute(modelo.__table__.delete())


def _reiniciar_secuencias(db, engine):
    """En PostgreSQL la secuencia no se entera de los id que insertamos a mano.

    Sin esto la base restaurada arranca dando id 1 y el primer ticket que se
    cobre revienta por clave duplicada. En SQLite no hace falta.
    """
    if not engine.url.get_backend_name().startswith("postgres"):
        return
    for modelo in [m for _, m, _, _ in ORDEN] + [models.VentaLinea, models.ComprobanteLinea,
                                                 models.ComprobanteExtra, models.Comprobante]:
        tabla = modelo.__tablename__
        if "id" not in modelo.__table__.c:
            continue
        db.execute(text(
            "SELECT setval(pg_get_serial_sequence(:t, 'id'), "
            "COALESCE((SELECT MAX(id) FROM " + tabla + "), 0) + 1, false)"
        ), {"t": tabla})


def restaurar(archivo, destino, vaciar=False, sin_preguntar=False):
    with open(archivo, encoding="utf-8") as f:
        datos = json.load(f)

    # Los backups viejos no traían el campo: si no está, es de los que guardaban
    # la fecha en hora argentina.
    version = datos.get("version", 1)
    print(f"Backup versión {version}, del {datos.get('fecha_backup', '?')}")
    if version > 2:
        sys.exit(f"El archivo dice ser versión {version} y este script llega hasta la 2.")

    engine = create_engine(destino)
    models.Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()

    try:
        if not _esta_vacia(db):
            if not vaciar:
                sys.exit(
                    "La base de destino ya tiene datos. Restaurar acá los pisaría.\n"
                    "Apuntá a una base nueva, o pasá --vaciar si de verdad querés "
                    "borrar lo que hay."
                )
            if not sin_preguntar:
                print(f"\nEsto BORRA todo lo que hay en {destino} y lo reemplaza.")
                if input('Escribí BORRAR para seguir: ').strip() != "BORRAR":
                    sys.exit("Cancelado, no se tocó nada.")
            _vaciar(db)

        total = {}
        for clave, modelo, campos, campos_fecha in ORDEN:
            if clave == "pagos":
                continue   # después de comprobantes: apunta a ellos
            total[clave] = _insertar(db, modelo, _filas(datos, clave, campos, campos_fecha, version))

        # Comprobantes en dos pasadas: primero todos sin convertido_de, después el
        # vínculo. Un presupuesto casi siempre tiene id menor que el ticket en que
        # se convirtió, pero "casi siempre" no alcanza para una clave foránea.
        comps = []
        for c in datos.get("comprobantes", []):
            d = {k: c.get(k) for k in CAMPOS_COMPROBANTE}
            d["fecha"] = _a_utc_naive(c.get("fecha"), version)
            d["cargado"] = _a_utc_naive(c.get("cargado"), version)
            d["convertido_de"] = None
            comps.append(d)
        total["comprobantes"] = _insertar(db, models.Comprobante, comps)

        for padre, hija, modelo, fk, campos in ANIDADAS:
            filas = []
            for p in datos.get(padre, []):
                for h in p.get(hija, []):
                    d = {c: h.get(c) for c in campos}
                    d[fk] = p.get("id")
                    filas.append(d)
            total[f"{padre}.{hija}"] = _insertar(db, modelo, filas)

        total["pagos"] = _insertar(db, models.Pago, _filas(
            datos, "pagos",
            ["id", "comprobante_id", "monto", "saldado", "forma_pago", "alias", "desc_aplicado"],
            ["fecha"], version))

        vinculos = [{"_id": c["id"], "conv": c.get("convertido_de")}
                    for c in datos.get("comprobantes", []) if c.get("convertido_de")]
        for v in vinculos:
            db.execute(models.Comprobante.__table__.update()
                       .where(models.Comprobante.__table__.c.id == v["_id"])
                       .values(convertido_de=v["conv"]))

        _reiniciar_secuencias(db, engine)
        db.commit()
    except Exception:
        db.rollback()
        raise

    print("\nFilas restauradas:")
    for k, v in total.items():
        print(f"  {k:26} {v:>7}")

    # Control de plata: que la suma de los pagos que quedó en la base sea la
    # misma que traía el archivo. Si acá no da, algo se perdió en el camino y no
    # hay que confiar en esta base.
    esperado = sum(p.get("monto") or 0 for p in datos.get("pagos", []))
    quedo = db.scalar(select(func.coalesce(func.sum(models.Pago.monto), 0))) or 0
    print(f"\nSuma de pagos: archivo ${esperado:,} / base ${quedo:,}")
    if esperado != quedo:
        db.close()
        sys.exit("NO COINCIDE. La base restaurada no sirve, no la uses.")
    print("Coincide ✓")
    db.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Restaura un backup JSON de la peluquería.")
    ap.add_argument("archivo", help="el .json bajado de /api/backup")
    ap.add_argument("--destino", required=True,
                    help="URL de la base donde restaurar, ej: sqlite:///revisado.db")
    ap.add_argument("--vaciar", action="store_true",
                    help="borra lo que haya en el destino antes de restaurar")
    ap.add_argument("--sin-preguntar", action="store_true",
                    help="no pide confirmación al vaciar (para scripts)")
    a = ap.parse_args()
    restaurar(a.archivo, a.destino, a.vaciar, a.sin_preguntar)
