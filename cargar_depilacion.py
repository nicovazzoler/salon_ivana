"""Carga la lista de precios de depilación en el catálogo, sin pasar por la app.

Existe porque la lista entera son veinte zonas y cargarlas a mano desde Admin, en
la tablet, es media hora de tipear precios: justo lo que no se quiere hacer a
mano cuando un número mal puesto se le cobra a una persona. Y porque hace falta
poder cargarla sin tener el usuario de producción.

    python3 cargar_depilacion.py zonas.txt --dry        # mira y no toca nada
    DATABASE_URL=postgresql://... python3 cargar_depilacion.py zonas.txt

El archivo es la lista tal como está impresa, una zona por renglón, con el precio
de TRANSFERENCIA —que es el que figura en la lista del local— y las categorías
entre corchetes:

    [DEPILACION MUJERES]
    Media pierna      14000
    Axilas            10000

    [DEPILACION MASCULINO]
    Espalda           25000

De ahí sale el precio de efectivo, que es el que guarda el catálogo: la base
guarda el efectivo y el de transferencia se calcula con calcular_transfer(). Como
la lista impresa es la de transferencia y tiene un 10% de descuento en efectivo,
el camino es al revés: efectivo = transferencia − 10%, y después se CONTROLA que
calcular_transfer() de ese efectivo devuelva exactamente el precio impreso. Si
alguno no cierra, lo dice y no escribe nada: un ítem cuyo transfer no es el de la
lista imprime en el ticket un precio distinto del que se le dijo a la clienta.

Se puede correr muchas veces: lo que falta lo crea, lo que cambió lo actualiza,
lo que ya está igual lo deja. Nunca borra ni desactiva nada.
"""
import argparse
import math
import sys

from sqlalchemy.orm import Session

import models
from database import engine


def calcular_transfer(precio_efectivo: int) -> int:
    """La misma cuenta que main.py: efectivo × 1,1111 para arriba a múltiplo de 100.

    Copiada a propósito y no importada: importar main.py levanta la app entera,
    con sus migraciones y su siembra, que es justo lo que un script que apunta a
    producción no tiene que hacer de costado.
    """
    return math.ceil(precio_efectivo * 1.1111 / 100) * 100


def leer_lista(ruta):
    """El archivo impreso → [(categoría, nombre, precio transferencia)]."""
    filas, categoria = [], None
    for n, linea in enumerate(open(ruta, encoding="utf-8"), 1):
        linea = linea.strip()
        if not linea or linea.startswith("#"):
            continue
        if linea.startswith("[") and linea.endswith("]"):
            categoria = linea[1:-1].strip()
            continue
        if categoria is None:
            sys.exit(f"Renglón {n}: hay una zona antes de la primera categoría")
        # El precio es lo último del renglón; el nombre es todo lo de antes, así
        # que un nombre con espacios ("Media pierna") no necesita comillas ni tabs.
        partes = linea.replace("\t", " ").rsplit(" ", 1)
        if len(partes) != 2:
            sys.exit(f"Renglón {n}: falta el precio en «{linea}»")
        nombre, precio = partes[0].strip(), partes[1].replace(".", "").replace("$", "")
        if not precio.isdigit():
            sys.exit(f"Renglón {n}: «{partes[1]}» no es un precio")
        filas.append((categoria, nombre, int(precio)))
    return filas


def efectivo_de(transfer: int) -> int:
    """El precio de efectivo que hay que guardar para que salga ESE transfer.

    El 10% de descuento en efectivo es el camino de ida; la vuelta la hace
    calcular_transfer() con el 1,1111, y las dos cuentas no son inversas exactas.
    Por eso se prueba el valor de al lado: con la lista del local los veinte dan
    justo, pero el día que entre un precio nuevo que no cierre, mejor que lo
    arregle el script que descubrirlo en el papel.
    """
    base = round(transfer * 0.9)
    for cand in sorted(range(base - 60, base + 61), key=lambda c: (abs(c - base), c)):
        if cand > 0 and calcular_transfer(cand) == transfer:
            return cand
    return 0


def main():
    ap = argparse.ArgumentParser(description="Carga la lista de precios de depilación")
    ap.add_argument("lista", help="archivo con las zonas y sus precios de transferencia")
    ap.add_argument("--dry", action="store_true", help="muestra la cuenta y no escribe")
    ap.add_argument("--si", action="store_true", help="no pregunta antes de escribir")
    args = ap.parse_args()

    filas = leer_lista(args.lista)
    if not filas:
        sys.exit("La lista está vacía")

    # Toda la cuenta ANTES de abrir la base: si un precio no cierra, no se escribe
    # ni la mitad de la lista.
    calculadas, rotas = [], []
    for categoria, nombre, transfer in filas:
        efectivo = efectivo_de(transfer)
        if not efectivo:
            rotas.append((nombre, transfer))
        else:
            calculadas.append((categoria, nombre, efectivo, transfer))
    if rotas:
        for nombre, transfer in rotas:
            print(f"  ✗ {nombre}: no hay precio de efectivo que dé ${transfer:,} de transferencia")
        sys.exit("Ningún precio se cargó.")

    print(f"Base: {engine.url.render_as_string(hide_password=True)}")
    print(f"{len(calculadas)} zonas:\n")
    cat = None
    for categoria, nombre, efectivo, transfer in calculadas:
        if categoria != cat:
            cat = categoria
            print(f"  [{cat}]")
        print(f"    {nombre:<34} efectivo ${efectivo:>8,}   transfer ${transfer:>8,}")
    print()

    if args.dry:
        print("--dry: no se escribió nada.")
        return
    if not args.si and input("¿Cargar en esa base? [escribir SI] ").strip() != "SI":
        sys.exit("No se escribió nada.")

    nuevos = cambiados = iguales = 0
    with Session(engine) as db:
        for categoria, nombre, efectivo, transfer in calculadas:
            item = (db.query(models.Item)
                      .filter(models.Item.categoria == categoria,
                              models.Item.nombre == nombre).first())
            if item is None:
                db.add(models.Item(categoria=categoria, nombre=nombre, precio=efectivo,
                                   precio_transfer=transfer, es_producto=False,
                                   es_comision=False, es_depilacion=True, activo=True))
                nuevos += 1
                continue
            # Un ítem que ya existe se corrige pero no se revive: si la dueña lo
            # desactivó, fue a propósito.
            antes = (item.precio, item.precio_transfer, bool(item.es_depilacion))
            item.precio, item.precio_transfer, item.es_depilacion = efectivo, transfer, True
            if antes == (efectivo, transfer, True):
                iguales += 1
            else:
                cambiados += 1
        db.commit()
    print(f"Listo: {nuevos} nuevas, {cambiados} corregidas, {iguales} ya estaban igual.")


if __name__ == "__main__":
    main()
