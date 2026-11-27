#!/usr/bin/env python3
"""Siembra una base de DEMO: un salón con movimiento, para mostrar la app.

    python3 sembrar_demo.py                       # arma pelu_demo.db de cero
    python3 sembrar_demo.py --base /tmp/otra.db
    DATABASE_URL=sqlite:///otra.db python3 sembrar_demo.py

Después se levanta apuntando a esa base:

    DATABASE_URL=sqlite:///pelu_demo.db python3 -m uvicorn main:app --port 8000

Todo lo que carga es INVENTADO —clientas, teléfonos, importes, turnos— y no sale
de ningún dato del local.

Factura POR LA API, en el mismo proceso y sin levantar un servidor: los totales,
las comisiones, el stock y el reparto de depilación los calcula el mismo código
que un cobro de verdad, así que la demo no puede mostrar una cuenta que la app
no haría.

Y deja contraseñas propias: con las de `seed_datos.py` la app pone arriba de todo
la barra de "tu contraseña sigue siendo la que vino de fábrica", que es correcta y
arruina la captura.
"""
import argparse
import os
import random
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

BASE_POR_DEFECTO = "pelu_demo.db"
# La fila de config que dice "esta base es de demo". Es lo único que la
# distingue de una de verdad, y sin ella el sembrador no rehace nada.
MARCA = "base_de_demo"
SOLO_LOCAL = {"", "localhost", "127.0.0.1", "::1"}
# La base local de prueba del repo tiene datos del local: no es la de la demo.
BASES_PROHIBIDAS = {"pelu.db"}

SEMANAS = 5                      # cuántas atrás se factura (el tope de la app son 60 días)
DEMO_PASSWORDS = {"dueno": "ivanademo26", "empleado": "mostrador26"}

VALOR_HORA = 7000
COMISION_PCT = 40
PAGO_AYUDANTE = 45000
FONDO_CAJA = 150000

# weekday() de Python: 0=lunes … 6=domingo. El local abre de martes a sábado.
EMPLEADAS = [
    {"nombre": "Carla", "pin": "1357", "valor_hora": 8200,
     "tramos": [(d, h, f) for d in (1, 2, 3, 4, 5) for h, f in (("09:00", "13:00"),
                                                                ("14:00", "18:00"))]},
    {"nombre": "Yamila", "pin": "2468", "valor_hora": None,
     "tramos": [(d, "13:00", "20:00") for d in (1, 2, 3, 4)] + [(5, "09:00", "15:00")]},
    {"nombre": "Brenda", "pin": "3579", "valor_hora": None,
     "tramos": [(d, "10:00", "19:00") for d in (1, 2, 3, 4, 5)]},
    {"nombre": "Micaela", "pin": "4680", "valor_hora": None,
     "tramos": [(d, "09:00", "14:00") for d in (1, 2, 3, 4)] + [(5, "09:00", "17:00")]},
]

CLIENTAS = [
    ("Mariana Gómez", "351 555-0142", "Alergia al amoníaco"),
    ("Lucía Peralta", "351 555-0178", None),
    ("Sofía Benítez", "351 555-0113", "Prefiere turno temprano"),
    ("Valentina Ríos", "351 555-0190", None),
    ("Carolina Duarte", "351 555-0165", "Viene con la nena"),
    ("Daniela Acuña", "351 555-0127", None),
    ("Agustina Vera", "351 555-0154", None),
    ("Romina Cáceres", "351 555-0133", "Paga siempre por transferencia"),
    ("Jimena Soler", "351 555-0109", None),
    ("Paula Figueroa", "351 555-0186", None),
    ("Natalia Quiroga", "351 555-0171", "Pelo muy largo, lleva el doble de tiempo"),
    ("Belén Ibarra", "351 555-0148", None),
    ("Cecilia Arrúa", "351 555-0102", None),
    ("Verónica Leguizamón", "351 555-0159", None),
    ("Silvina Ojeda", "351 555-0196", "Jubilada"),
    ("Noelia Barrios", "351 555-0121", None),
    ("Gabriela Correa", "351 555-0137", None),
    ("Melina Zárate", "351 555-0183", None),
    ("Andrea Maidana", "351 555-0115", None),
    ("Florencia Cabral", "351 555-0168", "Avisa siempre por mensaje"),
    ("Camila Ledesma", "351 555-0104", None),
    ("Antonella Ávalos", "351 555-0193", None),
    ("Martín Aguirre", "351 555-0151", None),
    ("Diego Sandoval", "351 555-0126", None),
    ("Leandro Ruiz Díaz", "351 555-0174", "Corte cada tres semanas"),
    ("Hernán Baigorria", "351 555-0139", None),
]

# Lo que más se vende, con su peso. Los nombres son los del catálogo del repo.
PRINCIPALES = [
    ("Corte autor unisex", 10), ("Corte en seco", 7), ("Corte salón hombre", 6),
    ("Corte + barba", 4), ("Planchita (M)", 5), ("Semirecogido (M)", 2),
    ("Shock (M)", 4), ("Botox (M)", 4), ("3E (M)", 3), ("Alisado vincha (M)", 2),
    ("Mantenimiento de color", 6), ("Aplicacion de color", 5), ("Rojos y negros (M)", 3),
    ("Claritos (M)", 4), ("Claritos (L)", 2), ("Bases permanentes (M)", 1),
    ("Semi manos", 4), ("Kapping", 2), ("Perfilado básico (botox + tinte)", 3),
    ("Lifting c/nutri + tinte", 2), ("Higiene básica", 2), ("Limpieza profunda", 2),
    ("Social", 1),
]
COMPLEMENTOS = [("Lavado", 4), ("Flequillo", 2), ("Ampollas (M)", 2),
                ("Encerado (M)", 2), ("Planchita (M)", 2)]
PRODUCTOS = [("Shampoo de leche x500ml", 4), ("Brillo de argán", 3), ("Protector termico", 3),
             ("Máscara Keratina", 2), ("Cera", 2), ("Mousse", 2),
             ("Shampoo matizador 500ml", 2), ("Keratina x1kg", 1)]

# Cuánto dura cada cosa, por categoría: de acá salen los minutos del trabajo a
# comisión y el largo del bloque en la agenda.
DURACION = {
    "CORTES DE PELO": (30, 50), "COLOR": (60, 90), "REFLEJOS / ILUMINACIÓN": (90, 150),
    "TRATAMIENTOS": (40, 60), "PERMANENTES": (90, 120), "EXTENSIONES": (120, 180),
    "UÑAS": (45, 60), "CEJAS": (30, 40), "PESTAÑAS": (40, 50), "MAQUILLAJE": (50, 70),
    "ROSTRO": (50, 70),
}
# Las que llevan horas no pagan el mismo porcentaje que un flequillo.
COMISION_PROPIA = {"REFLEJOS / ILUMINACIÓN": 35, "PERMANENTES": 35, "EXTENSIONES": 30}
SIN_COMISION = {"Productos", "ROSTRO"}

NOTAS_TURNO = ["Trae la foto del color", "Avisó que llega 10 minutos tarde",
               "Lava con el shampoo de ella", "Viene con la hija", "Retoque de raíz nada más"]


# ---------- la base ----------

def url_de_base(elegida: str | None) -> str:
    """La base en la que se va a escribir, o se corta.

    Carga comprobantes, pagos y sueldos de mentira: contra producción sería
    ensuciar la caja de verdad, y después no hay forma de separarlos.
    """
    url = elegida or os.getenv("DATABASE_URL") or f"sqlite:///{BASE_POR_DEFECTO}"
    if elegida and not elegida.startswith(("sqlite:", "postgres")):
        if "://" in elegida:
            sys.exit(f"No sé escribir en {elegida}: solo SQLite local o PostgreSQL local.")
        url = "sqlite:///" + elegida
    if url.startswith("postgres"):
        host = urlparse(url).hostname or ""
        if host not in SOLO_LOCAL:
            sys.exit(f"La base apunta a {host}, que no es local. Esto solo siembra en "
                     f"SQLite o en un PostgreSQL de 127.0.0.1.")
        return url
    if not url.startswith("sqlite"):
        sys.exit(f"No sé escribir en {url}: solo SQLite local o PostgreSQL local.")
    archivo = Path(url.split("sqlite:///", 1)[-1])
    if archivo.name in BASES_PROHIBIDAS:
        sys.exit(f"{archivo.name} es la base de prueba del repo, no la de la demo. "
                 f"Dejá el default ({BASE_POR_DEFECTO}) o pasá otra con --base.")
    return url


def vaciar_base():
    """Deja la base sin nada, y se niega si no es una base de demo.

    La marca en `config` la escribe este sembrador y nadie más: sin ese control,
    un --base mal tipeado borra la copia de producción que levantar_local.py deja
    en un SQLite.
    """
    from sqlalchemy import inspect, text
    import models                                   # registra las tablas en Base
    from database import Base, engine

    insp = inspect(engine)
    # Cualquier tabla ya creada, aunque esté vacía: una base de la app que no
    # lleva la marca es de otro —la de prueba, una copia de producción— y acá se
    # borra todo. Que esté vacía hoy no dice nada de mañana.
    if insp.get_table_names():
        marca = None
        if insp.has_table("config"):
            with engine.connect() as con:
                marca = con.execute(text("SELECT valor FROM config WHERE clave = :c"),
                                    {"c": MARCA}).first()
        if not marca:
            sys.exit("Esa base ya existe y no la armó el sembrador: no la toca.\n"
                     f"Sembrá en otra con --base, o borrá esa a mano si de verdad va ahí.")
    Base.metadata.drop_all(engine)
    print(f"Base vacía: {engine.url.render_as_string(hide_password=True)}")


def marcar_como_demo():
    """Deja la marca antes de sembrar: una corrida cortada a la mitad también es
    una base de demo, y tiene que poder rehacerse."""
    import models
    from database import SessionLocal
    db = SessionLocal()
    db.add(models.Config(clave=MARCA, valor=datetime.now().isoformat(timespec="seconds")))
    db.commit(); db.close()


# ---------- la app, llamada en el mismo proceso ----------

class Api:
    """La app contestando sin servidor: lo mismo que pide la pantalla."""

    def __init__(self, usuario, password):
        try:
            from fastapi.testclient import TestClient
        except ImportError:
            sys.exit("Falta httpx (lo usa TestClient): pip install -r requirements-dev.txt")
        import main
        self.cliente = TestClient(main.app)
        self.token = None
        self.entrar(usuario, password)

    def entrar(self, usuario, password):
        self.token = None
        self.token = self.post("/api/login", {"usuario": usuario, "password": password})["token"]

    def pedir(self, metodo, ruta, datos=None):
        cabeceras = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        r = self.cliente.request(metodo, ruta, json=datos, headers=cabeceras)
        # Corta en el primer error: media demo sembrada es peor que ninguna,
        # porque la pantalla igual abre y no se ve qué falta.
        if r.status_code >= 400:
            sys.exit(f"La app contestó {r.status_code} en {metodo} {ruta}:\n  {r.text[:400]}")
        return r.json() if r.content else None

    def get(self, ruta): return self.pedir("GET", ruta)
    def post(self, ruta, datos=None): return self.pedir("POST", ruta, datos or {})
    def put(self, ruta, datos=None): return self.pedir("PUT", ruta, datos or {})


# ---------- helpers ----------

def dia_abierto(f: date) -> bool:
    from config_extra import DIAS_CERRADO
    return f.weekday() not in DIAS_CERRADO


def elegir(rnd, pesados):
    nombres = [n for n, _ in pesados]
    return rnd.choices(nombres, weights=[p for _, p in pesados], k=1)[0]


def hhmm(minutos: int) -> str:
    return f"{minutos // 60:02d}:{minutos % 60:02d}"


def minutos_de(hora: str) -> int:
    h, m = hora.split(":")
    return int(h) * 60 + int(m)


# ---------- siembra ----------

def contrasenas_propias(api):
    """Les cambia la contraseña de fábrica a los dos usuarios.

    Mientras alguna siga siendo la de `seed_datos.py`, la app muestra en todas
    las pantallas una barra roja que avisa —con razón— y tapa la captura.
    """
    for u in api.get("/api/usuarios"):
        nueva = DEMO_PASSWORDS.get(u["usuario"])
        if nueva:
            api.put(f"/api/usuarios/{u['id']}", {"password": nueva})
    api.entrar("dueno", DEMO_PASSWORDS["dueno"])


def preparar_catalogo(api, rnd):
    """Marca a comisión lo que se paga a quien lo hace y le pone stock a los productos."""
    items = api.get("/api/items/all")
    sin_duracion = False
    for it in items:
        if it["es_producto"] or it["es_depilacion"] or it["categoria"] in SIN_COMISION:
            continue
        pct = COMISION_PROPIA.get(it["categoria"], COMISION_PCT)
        minimo, maximo = DURACION.get(it["categoria"], (30, 60))
        # Uno queda sin duración: es el aviso que la dueña tiene que ver en el catálogo.
        sin = it["categoria"] == "EXTENSIONES" and not sin_duracion
        sin_duracion = sin_duracion or sin
        api.put(f"/api/items/{it['id']}", {"es_comision": True, "comision_pct": pct,
                                            "duracion_min": 0 if sin else (minimo + maximo) // 10 * 5})

    for it in items:
        if not it["es_producto"]:
            continue
        minimo = rnd.choice([3, 4, 5, 6])
        # Uno de cada cinco arranca por debajo del mínimo: la franja de estado de
        # Inventario no se entiende si todo está en verde.
        actual = rnd.randint(0, minimo) if rnd.random() < 0.2 else rnd.randint(minimo + 2, minimo + 14)
        api.put(f"/api/inventario/{it['id']}", {"stock_actual": actual, "stock_minimo": minimo})
    return {it["nombre"]: it for it in api.get("/api/items/all")}


def listas_configurables(api):
    for nombre in ("ivana.salon.mp", "carla.transfer"):
        api.post("/api/alias", {"nombre": nombre})
    for nombre, pct, motivo in (("Jubilada", 15, True), ("Promo martes", 10, True)):
        api.post("/api/descuentos", {"nombre": nombre, "porcentaje": pct, "mostrar_motivo": motivo})
    for nombre, pct in (("Pelo largo", 15), ("Fidelidad", -10)):
        api.post("/api/ajustes-item", {"nombre": nombre, "porcentaje": pct})
    api.post("/api/tipos-egreso", {"nombre": "Alquiler", "privado": True})
    api.put("/api/config/sueldos", {"pago_ayudante": PAGO_AYUDANTE})


def crear_empleadas(api):
    creadas = []
    for e in EMPLEADAS:
        emp = api.post("/api/empleados", {"nombre": e["nombre"]})
        api.put(f"/api/empleados/{emp['id']}", {"valor_hora": e["valor_hora"] or VALOR_HORA})
        api.put(f"/api/empleados/{emp['id']}/pin", {"pin": e["pin"]})
        api.put(f"/api/horarios/{emp['id']}",
                {"tramos": [{"dia_semana": d, "desde": h, "hasta": f} for d, h, f in e["tramos"]]})
        creadas.append({**e, "id": emp["id"]})
    return creadas


def crear_clientas(api):
    salida = []
    for nombre, telefono, notas in CLIENTAS:
        cli = api.post("/api/clientes", {"nombre": nombre, "telefono": telefono, "notas": notas})
        salida.append({"id": cli["id"], "nombre": nombre})
    return salida


def quien_trabaja(empleadas, f: date):
    return [e for e in empleadas if any(d == f.weekday() for d, _, _ in e["tramos"])]


def armar_lineas(rnd, catalogo):
    """Las líneas de un ticket: un trabajo principal y a veces algo más."""
    lineas = []

    def agregar(nombre):
        it = catalogo.get(nombre)
        if not it:
            return
        linea = {"item_id": it["id"], "cantidad": 1}
        if not it["es_producto"] and rnd.random() < 0.12:
            nombre_ajuste, pct = rnd.choice([("Pelo largo", 15), ("Fidelidad", -10)])
            linea.update({"ajuste_pct": pct, "ajuste_nombre": nombre_ajuste})
        lineas.append(linea)

    agregar(elegir(rnd, PRINCIPALES))
    if rnd.random() < 0.3:
        agregar(elegir(rnd, COMPLEMENTOS))
    if rnd.random() < 0.18:
        agregar(elegir(rnd, PRODUCTOS))
    return lineas


def cobrar_ticket(api, rnd, comp, forma, alias):
    """Los cobros que no entran con el ticket.

    El de efectivo sí: lo hace el mismo pedido que lo crea. Los otros necesitan
    saber el saldo —el alias de la transferencia, las dos patas del mixto, la
    parte que deja a cuenta— y eso recién existe cuando el ticket existe.
    """
    if forma == "transfer":
        api.post(f"/api/comprobantes/{comp['id']}/pagos",
                 {"monto": comp["saldo"], "forma_pago": "Transferencia", "alias": alias,
                  "del_servicio": True})
    elif forma == "mixto":
        est = api.get(f"/api/comprobantes/{comp['id']}")
        mitad = max(round(est["saldo_efectivo"] * 0.5 / 100) * 100, 100)
        api.post(f"/api/comprobantes/{comp['id']}/pagos",
                 {"monto": mitad, "forma_pago": "Efectivo", "descuento_efectivo": True,
                  "del_servicio": True})
        resto = api.get(f"/api/comprobantes/{comp['id']}")["saldo"]
        api.post(f"/api/comprobantes/{comp['id']}/pagos",
                 {"monto": resto, "forma_pago": "Transferencia", "alias": alias,
                  "del_servicio": True})
    elif forma == "cuenta" and rnd.random() < 0.4:
        # Deja algo a cuenta el mismo día: la ficha queda con un saldo parcial y
        # no debiendo todo, que es la mitad de lo que muestra la cuenta corriente.
        est = api.get(f"/api/comprobantes/{comp['id']}")
        parte = max(round(est["saldo"] * rnd.uniform(0.3, 0.6) / 1000) * 1000, 1000)
        api.post(f"/api/comprobantes/{comp['id']}/pagos",
                 {"monto": parte, "forma_pago": "Efectivo", "del_servicio": True})


def facturar(api, rnd, empleadas, clientas, catalogo, hoy):
    """Las ventas de las últimas semanas, con sus formas de pago y sus comisiones."""
    desde = hoy - timedelta(days=SEMANAS * 7 - 1)
    formas = [("efectivo", 46), ("transfer", 34), ("mixto", 8), ("cuenta", 12)]
    tickets, fiados = 0, []
    f = desde
    while f <= hoy:
        if not dia_abierto(f):
            f += timedelta(days=1)
            continue
        equipo = quien_trabaja(empleadas, f)
        # El sábado es el día fuerte y el martes el flojo: un volumen parejo toda
        # la semana no se parece a ningún local.
        cuantos = {1: (8, 11), 2: (10, 14), 3: (10, 14), 4: (12, 16), 5: (14, 19)}[f.weekday()]
        for _ in range(rnd.randint(*cuantos)):
            emp = rnd.choice(equipo)
            cli = rnd.choice(clientas)
            lineas = armar_lineas(rnd, catalogo)
            forma = elegir(rnd, formas)
            alias = rnd.choice(["ivana.salon.mp", "carla.transfer"]) if forma != "efectivo" else None
            cuerpo = {"tipo": "ticket", "fecha": f.isoformat(), "peluquero": emp["nombre"],
                      "cliente_id": cli["id"], "forma_pago": forma, "lineas": lineas,
                      "cobrar": forma == "efectivo"}
            if rnd.random() < 0.07:
                cuerpo.update({"descuento_pct": 15, "descuento_nombre": "Jubilada",
                               "mostrar_motivo": True})
            if rnd.random() < 0.06:
                cuerpo["extras"] = [{"concepto": "Traslado", "monto": rnd.choice([4000, 6000])}]
            comp = api.post("/api/comprobantes", cuerpo)
            cobrar_ticket(api, rnd, comp, forma, alias)
            if forma == "cuenta":
                fiados.append(comp["id"])
            tickets += 1
        # Un presupuesto de vez en cuando: el historial los filtra aparte.
        if rnd.random() < 0.25:
            lineas = armar_lineas(rnd, catalogo)
            api.post("/api/comprobantes",
                     {"tipo": "presupuesto", "fecha": f.isoformat(),
                      "cliente_id": rnd.choice(clientas)["id"],
                      "peluquero": rnd.choice(equipo)["nombre"],
                      "forma_pago": "transfer", "lineas": lineas})
        f += timedelta(days=1)

    # Deudas viejas que se saldan HOY: esa plata es del día en que entra, no del
    # día del servicio, y es lo que hace que la caja de hoy tenga las dos cosas.
    for comp_id in fiados[:-6]:
        if rnd.random() < 0.45:
            est = api.get(f"/api/comprobantes/{comp_id}")
            if est["saldo"] <= 0:
                continue
            if rnd.random() < 0.5:
                pago = {"monto": est["saldo_efectivo"], "forma_pago": "Efectivo",
                        "descuento_efectivo": True}
            else:
                pago = {"monto": est["saldo"], "forma_pago": "Transferencia",
                        "alias": "ivana.salon.mp"}
            api.post(f"/api/comprobantes/{comp_id}/pagos", {**pago, "del_servicio": False})
    return tickets


def egresos(api, rnd, hoy):
    """Los gastos de todas las semanas, incluidos los que el empleado no ve."""
    cuantos = 0
    f = hoy - timedelta(days=SEMANAS * 7 - 1)
    while f <= hoy:
        plan = []
        if f.weekday() == 1:
            plan.append(("Gasto / insumo", "Insumos de peluquería",
                         rnd.randrange(45_000, 130_000, 1000), "Efectivo"))
        if f.weekday() == 3:
            plan.append(("Pago proveedor", "Distribuidora de color",
                         rnd.randrange(180_000, 420_000, 5000), "Transferencia"))
        if f.weekday() == 5:
            plan.append(("Retiro de caja", "Retiro de la dueña",
                         rnd.randrange(150_000, 350_000, 10_000), "Efectivo"))
        if f.day == 5:
            plan.append(("Alquiler", "Alquiler del local", 950_000, "Transferencia"))
        # Todo día abierto tiene algún gasto chico: una caja sin egresos no es un
        # día tranquilo, es un día que nadie anotó.
        if dia_abierto(f):
            plan.append(("Otro", rnd.choice(["Arreglo del secador", "Café y agua",
                                             "Delivery de almuerzo", "Toallas nuevas",
                                             "Papelería y tickets", "Flete del pedido"]),
                         rnd.randrange(8_000, 38_000, 1000), "Efectivo"))
            if rnd.random() < 0.5:
                plan.append(("Gasto / insumo", rnd.choice(["Tinturas", "Guantes y papel",
                                                           "Shampoo del lavado", "Agua oxigenada"]),
                             rnd.randrange(15_000, 60_000, 1000), "Efectivo"))
        for tipo, concepto, monto, forma in plan:
            api.post("/api/egresos", {"tipo": tipo, "concepto": concepto, "monto": monto,
                                      "forma_pago": forma, "fecha": f.isoformat()})
            cuantos += 1
        f += timedelta(days=1)
    return cuantos


def sueldos(api, rnd, empleadas, catalogo, hoy):
    """Les corrige la duración a algunos trabajos, carga el horario de cada día y
    cierra lo que ya pasó.

    En ese orden y por la API, como pasa en el local: el trabajo aparece en su
    pantalla cuando se factura, la duración sale del catálogo y ella corrige la
    que no fue así, y el cierre es de la dueña.
    """
    cerradas = 0
    for emp in empleadas:
        resumen = api.get(f"/api/sueldos/pendiente?empleado_id={emp['id']}")
        con_trabajo = {}
        for dia in resumen["dias"]:
            for t in dia["trabajos"]:
                item = catalogo.get(t["nombre"]) or {}
                if item.get("duracion_min") and rnd.random() < 0.8:
                    continue
                minimo, maximo = DURACION.get(item.get("categoria"), (30, 60))
                api.put("/api/sueldos/trabajo-minutos",
                        {"empleado_id": emp["id"], "minutos": rnd.randrange(minimo, maximo + 1, 5),
                         **({"trabajo_id": t["id"]} if t["id"] else {"linea_id": t["linea_id"]})})
            if dia["trabajos"]:
                con_trabajo[dia["fecha"]] = dia
        # El horario de la agenda, y a veces se quedó un rato más.
        for fecha, dia in con_trabajo.items():
            tandas = [list(t) for t in (dia["sugerido"] or [["10:00", "18:00"]])]
            tandas[-1][1] = hhmm(min(minutos_de(tandas[-1][1]) + rnd.choice([0, 0, 15, 30]), 23 * 60))
            api.put("/api/sueldos/horas",
                    {"empleado_id": emp["id"], "fecha": fecha,
                     "tandas": [{"desde": a, "hasta": b} for a, b in tandas]})


    # Se paga cada viernes que ya pasó, a todas juntas, y queda pendiente lo de
    # esta semana, que es lo que la pantalla de sueldos tiene para mostrar.
    f = hoy - timedelta(days=7 * (SEMANAS + 1))
    while f < hoy:
        if f.weekday() == 4:
            pagos = [{"empleado_id": e["id"], "forma_pago": "Efectivo"} for e in empleadas
                     if api.get(f"/api/sueldos/pendiente?empleado_id={e['id']}&hasta={f}")["total"] > 0]
            if pagos:
                api.post("/api/sueldos/pagar", {"hasta": f.isoformat(), "fecha": f.isoformat(), "pagos": pagos})
                cerradas += len(pagos)
        f += timedelta(days=1)
    # Un adelanto y un producto de esta semana, para que se vea qué se descuenta.
    api.post("/api/sueldos/adelanto", {"empleado_id": empleadas[0]["id"], "monto": 20000})
    prod = next(p for p in api.get("/api/sueldos/productos") if (p["stock"] or 0) > 0)
    api.post("/api/sueldos/producto", {"empleado_id": empleadas[1]["id"], "item_id": prod["id"],
                                       "cantidad": 1, "precio": round(prod["precio"] * 0.8, -2)})
    return cerradas


def turnos(api, rnd, empleadas, clientas, catalogo, hoy):
    """La agenda: los días que vienen y los que acaban de pasar."""
    servicios = [n for n, _ in PRINCIPALES if n in catalogo]
    puestos = 0
    for delta in range(-4, 13):
        f = hoy + timedelta(days=delta)
        if not dia_abierto(f):
            continue
        for emp in quien_trabaja(empleadas, f):
            tramos = [(h, t) for d, h, t in emp["tramos"] if d == f.weekday()]
            for desde, hasta in tramos:
                reloj = minutos_de(desde)
                fin = minutos_de(hasta)
                while reloj < fin - 30:
                    if rnd.random() < 0.28:                      # el hueco que queda libre
                        reloj += 30
                        continue
                    servicio = rnd.choice(servicios)
                    minimo, maximo = DURACION.get(catalogo[servicio]["categoria"], (30, 60))
                    duracion = min(rnd.randrange(minimo, maximo + 1, 15) or 30, fin - reloj)
                    if duracion < 30:
                        break
                    cli = rnd.choice(clientas)
                    api.post("/api/turnos",
                             {"fecha": f.isoformat(), "hora": hhmm(reloj), "cliente": cli["nombre"],
                              "cliente_id": cli["id"], "servicio": servicio,
                              "peluquero": emp["nombre"], "duracion_min": duracion,
                              "notas": rnd.choice(NOTAS_TURNO) if rnd.random() < 0.2 else None})
                    puestos += 1
                    reloj += duracion + rnd.choice([0, 15, 30])
    for texto in ("Llega el pedido de color a la tarde",
                  "Brenda sale 17:30, la última clienta la toma Carla"):
        api.post("/api/notas", {"texto": texto, "fecha": hoy.isoformat()})
    return puestos


def depilacion(api, rnd, empleadas, clientas, catalogo, hoy):
    """Dos jornadas de depilación: la del mes pasado cobrada y la última abierta.

    Es un lunes, que el local no abre, y la plata se reparte en vez de pagar
    comisiones: el reparto es lo que la pantalla tiene para mostrar.
    """
    # Pesado hacia los paquetes grandes: nadie viene una vez al mes por una zona.
    zonas = [(n, 1 + it["precio"] // 4000) for n, it in catalogo.items() if it["es_depilacion"]]
    if not zonas:
        return 0
    por_nombre = {e["nombre"]: e for e in empleadas}
    ayudante = por_nombre["Micaela"]
    ultimo_lunes = hoy - timedelta(days=hoy.weekday() % 7 or 7)
    # La de hace un mes ya cobrada, la última todavía abierta: la pantalla tiene
    # las dos cosas para mostrar, el reparto en curso y el historial.
    jornadas = [(ultimo_lunes - timedelta(days=28), por_nombre["Yamila"], True),
                (ultimo_lunes, por_nombre["Brenda"], False)]
    cobrados = 0
    for fecha, emp, cerrar in jornadas:
        if (hoy - fecha).days > 55:
            continue
        ses = api.post("/api/depilacion/abrir", {"empleado_id": emp["id"]})
        api.post("/api/agenda/abrir-dia",
                 {"fecha": fecha.isoformat(), "empleados": [emp["id"], ayudante["id"]],
                  "desde": "10:00", "hasta": "18:00", "motivo": "Jornada de depilación",
                  "a_cargo": emp["nombre"]})
        for _ in range(rnd.randint(11, 16)):
            forma = rnd.choice(["efectivo", "efectivo", "transfer"])
            api.post("/api/comprobantes",
                     {"tipo": "ticket", "fecha": fecha.isoformat(), "peluquero": emp["nombre"],
                      "cliente_id": rnd.choice(clientas)["id"], "forma_pago": forma,
                      "cobrar": True,
                      "lineas": [{"item_id": catalogo[elegir(rnd, zonas)]["id"]}]})
            cobrados += 1
        api.post("/api/depilacion/gasto",
                 {"sesion_id": ses["id"], "monto": 90_000, "maquina": True,
                  "fecha": fecha.isoformat(), "concepto": "Alquiler de la máquina"})
        api.post("/api/depilacion/gasto",
                 {"sesion_id": ses["id"], "monto": PAGO_AYUDANTE, "ayudante": True,
                  "ayudante_id": ayudante["id"], "fecha": fecha.isoformat()})
        if cerrar:
            api.post("/api/depilacion/cerrar",
                     {"sesion_id": ses["id"], "forma_pago": "Efectivo",
                      "fecha_pago": fecha.isoformat()})
    for cli in rnd.sample(clientas, 2):
        api.post("/api/senas", {"cliente_id": cli["id"], "valor": rnd.choice([10_000, 14_000]),
                                "forma_pago": "Efectivo", "notas": "Para la próxima jornada"})
    return cobrados


def repartir_horas(rnd, hoy):
    """Les pone hora y día creíbles a los movimientos, de atrás para adelante.

    La API no deja elegir la hora: un servicio de otro día se guarda al mediodía y
    lo de hoy con la hora en que corrió el sembrador, así que la caja mostraría el
    día entero en un solo renglón. El abono que SALDA una deuda vieja entra
    siempre hoy, y todos juntos hacen una caja de hoy que es casi puro fiado
    cobrado: se reparten entre el día del ticket y hoy, que es cuando pudo pasar.
    """
    import models
    from database import SessionLocal
    from main import hora_argentina

    HORAS_ARG = 3

    def a_las(dia: date, desde=9, hasta=19):
        return (datetime(dia.year, dia.month, dia.day, rnd.randint(desde, hasta),
                         rnd.randrange(0, 60, 5)) + timedelta(hours=HORAS_ARG))

    def en_el_dia(cuando, desde=9, hasta=19):
        return a_las(hora_argentina(cuando).date(), desde, hasta)

    db = SessionLocal()
    movidos = {}
    for comp in db.query(models.Comprobante):
        viejo = comp.fecha
        # `cargado` se iguala a `fecha` porque si no cada ticket viejo sale con el
        # cartel de "servicio anotado el x/x", que acá no quiere decir nada.
        comp.fecha = en_el_dia(viejo)
        comp.cargado = comp.fecha
        movidos[comp.id] = (viejo, comp.fecha)
    for pago in db.query(models.Pago):
        viejo, nuevo = movidos.get(pago.comprobante_id, (None, None))
        if nuevo and pago.fecha == viejo:            # el abono que cerró la venta
            pago.fecha = nuevo + timedelta(minutes=rnd.randrange(5, 25, 5))
        elif nuevo:                                  # el que vino a saldar la deuda
            dia_ticket = hora_argentina(nuevo).date()
            margen = max((hoy - dia_ticket).days - 1, 1)
            pago.fecha = a_las(dia_ticket + timedelta(days=rnd.randint(1, margen)))
        else:
            pago.fecha = en_el_dia(pago.fecha)
    for sena in db.query(models.Sena):
        sena.fecha = en_el_dia(sena.fecha)
    for egreso in db.query(models.Egreso):
        egreso.fecha = en_el_dia(egreso.fecha, 10, 19)
    for mov in db.query(models.MovimientoStock):
        # El movimiento de stock pasó cuando se vendió: la fecha es la del ticket.
        if (mov.motivo or "").startswith("Comprobante #"):
            comp_id = int(mov.motivo.split("#")[1])
            if comp_id in movidos:
                mov.fecha = movidos[comp_id][1]
    # El corte de arranque de los sueldos lo pone la app la primera vez que
    # levanta, o sea antes de que exista un solo ticket de la demo, y mira cuándo
    # se ANOTÓ cada trabajo: con `cargado` corrido para atrás, las comisiones
    # pendientes quedarían todas afuera y Sueldos mostraría ceros.
    corte = db.query(models.Config).filter_by(clave="sueldos_desde").first()
    if corte:
        corte.valor = (datetime(hoy.year, hoy.month, hoy.day) - timedelta(days=90)).isoformat()
    db.commit(); db.close()


def fondo_de_caja(api, hoy):
    # Arranca una vez y se arrastra: así el arqueo de cualquier día tiene fondo.
    api.put("/api/config/fondo-caja",
            {"valor": FONDO_CAJA, "fecha": (hoy - timedelta(days=SEMANAS * 7 - 1)).isoformat()})


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--base", help=f"archivo SQLite o URL (default: {BASE_POR_DEFECTO})")
    ap.add_argument("--semilla", type=int, default=2026,
                    help="misma semilla, mismos datos: para repetir una captura")
    args = ap.parse_args()

    os.environ["DATABASE_URL"] = url_de_base(args.base)
    vaciar_base()

    rnd = random.Random(args.semilla)
    api = Api("dueno", "dueno1234")                  # la de fábrica: recién creada, es la que hay
    marcar_como_demo()
    contrasenas_propias(api)

    from main import hoy_argentina
    hoy = hoy_argentina()

    listas_configurables(api)
    catalogo = preparar_catalogo(api, rnd)
    empleadas = crear_empleadas(api)
    clientas = crear_clientas(api)
    fondo_de_caja(api, hoy)
    tickets = facturar(api, rnd, empleadas, clientas, catalogo, hoy)
    gastos = egresos(api, rnd, hoy)
    cerradas = sueldos(api, rnd, empleadas, catalogo, hoy)
    citas = turnos(api, rnd, empleadas, clientas, catalogo, hoy)
    depi = depilacion(api, rnd, empleadas, clientas, catalogo, hoy)
    repartir_horas(rnd, hoy)

    caja = api.get("/api/caja/dia")
    print(f"\n{tickets} tickets en {SEMANAS} semanas, {depi} de depilación, {gastos} egresos, "
          f"{citas} turnos, {cerradas} sueldos cerrados.")
    print(f"Caja de hoy ({caja['fecha']}): entró ${caja['ingresos']:,} y salió ${caja['egresos']:,}"
          .replace(",", "."))
    print(f"\nEntrar con  dueno / {DEMO_PASSWORDS['dueno']}   ·   "
          f"empleado / {DEMO_PASSWORDS['empleado']}")
    print("Códigos de sueldo: " + ", ".join(f"{e['nombre']} {e['pin']}" for e in EMPLEADAS))
    print(f"\nDATABASE_URL={os.environ['DATABASE_URL']} python3 -m uvicorn main:app "
          f"--host 127.0.0.1 --port 8000")


if __name__ == "__main__":
    main()
