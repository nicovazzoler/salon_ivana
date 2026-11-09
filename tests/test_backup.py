"""Un backup restaurado tiene que volver igual: todas las tablas, todas las columnas.

Se llena una base con una fila en cada tabla y TODAS sus columnas puestas, se
exporta con armar_backup(), se restaura con restaurar_backup y se compara fila
por fila. Una columna nueva que no viaja hace fallar esto, que es justo lo que
pasó con las sesiones de depilación: el backup salía entero y sin ellas.
"""
import json
from datetime import datetime

import pytest
from sqlalchemy import Boolean, DateTime, Integer, create_engine, select
from sqlalchemy.orm import sessionmaker

import models
import restaurar_backup
from main import armar_backup

FECHA = datetime(2026, 3, 4, 5, 6, 7)


def _valor(col):
    if isinstance(col.type, Boolean):
        return True
    if isinstance(col.type, DateTime):
        return FECHA
    if isinstance(col.type, Integer):
        # Todas las claves en 1, así cada foránea apunta a una fila que existe.
        return 1 if (col.primary_key or col.foreign_keys) else 7
    return f"{col.table.name}.{col.name}"


@pytest.fixture
def ida_y_vuelta(tmp_path):
    origen = create_engine(f"sqlite:///{tmp_path / 'origen.db'}")
    models.Base.metadata.create_all(origen)
    with origen.begin() as con:
        for tabla in models.Base.metadata.sorted_tables:
            con.execute(tabla.insert(), {c.name: _valor(c) for c in tabla.columns})

    archivo = tmp_path / "backup.json"
    with sessionmaker(bind=origen)() as db:
        archivo.write_text(json.dumps(armar_backup(db)), encoding="utf-8")

    url_destino = f"sqlite:///{tmp_path / 'destino.db'}"
    restaurar_backup.restaurar(str(archivo), url_destino, sin_preguntar=True)
    return origen, create_engine(url_destino)


@pytest.mark.parametrize("tabla", models.Base.metadata.sorted_tables, ids=lambda t: t.name)
def test_cada_tabla_vuelve_entera(ida_y_vuelta, tabla):
    origen, destino = ida_y_vuelta
    with origen.connect() as a, destino.connect() as b:
        antes = [dict(f._mapping) for f in a.execute(select(tabla))]
        despues = [dict(f._mapping) for f in b.execute(select(tabla))]
    assert despues, f"{tabla.name} no está en el backup"
    faltan = {k: (antes[0][k], despues[0].get(k)) for k in antes[0] if antes[0][k] != despues[0].get(k)}
    assert not faltan, f"{tabla.name}: estas columnas no vuelven iguales {faltan}"
