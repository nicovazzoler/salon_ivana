"""Carga un ciclo entero de trabajo para probar la pantalla de sueldos.

Factura POR LA API, igual que el local: así los comprobantes, los precios y las
comisiones son exactamente los que hubiera generado un cobro de verdad, y no una
segunda versión de la cuenta escrita acá.

    python3 simular_sueldos.py                    # el último ciclo cerrado
    python3 simular_sueldos.py --ciclo actual     # la semana en curso
    python3 simular_sueldos.py --empleadas 3      # cuántas (default 3)
    python3 simular_sueldos.py --borrar           # deshace lo que cargó

La duración de cada trabajo sale del precio del ítem: el más caro del catálogo
son 80 minutos y el más barato 15, con el resto repartido en el medio y una
variación chica para que no salgan todos iguales. Es una regla inventada para
la prueba, no una del negocio.

Después de cargar, el valor hora y la comisión se cambian donde se cambian
siempre —Admin, arriba de la lista de empleados, o Sueldos— y los totales se
recalculan solos: lo pendiente se calcula en vivo y recién se congela al cerrar.

OJO: esto CREA comprobantes y pagos, así que solo trabaja contra una base local.
"""
import argparse
import json
import random
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlparse

MARCA = "SIMULACIÓN"          # va en el nombre del cliente, para poder borrarlo
MIN_MINUTOS, MAX_MINUTOS = 15, 80
SOLO_LOCAL = {"127.0.0.1", "localhost", "::1"}


class Api:
    def __init__(self, base, usuario, password):
        self.base = base.rstrip("/")
        self.avisos = []
        self.token = self.pedir("/api/login", {"usuario": usuario, "password": password})["token"]

    def pedir(self, ruta, datos=None, metodo=None, opcional=False):
        """`opcional` devuelve None en vez de cortar: para lo que la app puede
        negarse con razón, como cargar horas de un día que ya se pagó."""
        cuerpo = json.dumps(datos).encode() if datos is not None else None
        r = urllib.request.Request(self.base + ruta, data=cuerpo,
                                   method=metodo or ("POST" if datos is not None else "GET"))
        r.add_header("Content-Type", "application/json")
        if getattr(self, "token", None):
            r.add_header("Authorization", "Bearer " + self.token)
        try:
            with urllib.request.urlopen(r) as f:
                return json.loads(f.read() or b"null")
        except urllib.error.HTTPError as e:
            detalle = e.read().decode()[:300]
            if opcional:
                try: detalle = json.loads(detalle).get("detail", detalle)
                except Exception: pass
                self.avisos.append(detalle)
                return None
            sys.exit(f"La API contestó {e.code} en {metodo or 'GET'} {ruta}:\n  {detalle}")
        except urllib.error.URLError as e:
            sys.exit(f"No pude hablar con {self.base}: {e.reason}\n"
                     f"¿Está levantada la app? python3 -m uvicorn main:app --port 8000")


def hoy_argentina() -> date:
    """El "hoy" del local, no el del servidor.

    Argentina es UTC−3 todo el año, así que después de las 21 el reloj de la
    máquina ya está en el día siguiente. Sin esto, la simulación intenta
    facturar mañana y la app la frena por fecha futura, con razón.
    """
    return (datetime.now(timezone.utc) - timedelta(hours=3)).date()


def ciclo_de(f: date) -> tuple[date, date]:
    """El mismo corte que usa la app: de sábado a viernes, y el lunes suelto."""
    dow = f.weekday()
    if dow == 0: return f, f
    if dow == 5: return f, f + timedelta(days=6)
    if dow == 6: return f - timedelta(days=1), f + timedelta(days=5)
    ini = f - timedelta(days=dow + 2)
    return ini, ini + timedelta(days=6)


def items_a_comision(api):
    """Los ítems marcados a comisión, que son los únicos que generan sueldo."""
    cats = api.pedir("/api/categorias")
    cats = cats if isinstance(cats, list) else cats.get("categorias", [])
    salida = []
    for c in cats:
        nombre = c if isinstance(c, str) else c.get("nombre")
        if not nombre: continue
        it = api.pedir("/api/items?categoria=" + urllib.parse.quote(nombre))
        it = it if isinstance(it, list) else it.get("items", [])
        salida += [i for i in it if i.get("es_comision") and i.get("precio")]
    return salida


def minutos_por_precio(precio, barato, caro, rnd):
    """Del precio del ítem a cuánto duró: el más caro del catálogo son 80 minutos.

    Con una variación de ±8 minutos para que no salgan todos iguales, que es lo
    que se quiere mirar en la pantalla. Nunca pasa de 80 ni baja de 15.
    """
    if caro <= barato:
        base = (MIN_MINUTOS + MAX_MINUTOS) // 2
    else:
        proporcion = (precio - barato) / (caro - barato)
        base = MIN_MINUTOS + proporcion * (MAX_MINUTOS - MIN_MINUTOS)
    return max(MIN_MINUTOS, min(MAX_MINUTOS, round(base + rnd.uniform(-8, 8))))


def cargar(api, cuantas, cual_ciclo, semilla):
    rnd = random.Random(semilla)
    hoy = hoy_argentina()
    desde, hasta = ciclo_de(hoy if cual_ciclo == "actual" else hoy - timedelta(days=7))
    if cual_ciclo != "actual" and desde == hasta:        # cayó en un lunes suelto
        desde, hasta = ciclo_de(desde - timedelta(days=1))

    empleadas = [e for e in api.pedir("/api/empleados") if e.get("activo", True)][:cuantas]
    if len(empleadas) < cuantas:
        sys.exit(f"Hay {len(empleadas)} empleada(s) activa(s) y pediste {cuantas}. "
                 f"Cargá más en Admin, o corré con --empleadas {len(empleadas)}.")
    items = items_a_comision(api)
    if not items:
        sys.exit("No hay ningún ítem marcado a comisión. Marcá alguno en Admin → catálogo.")

    dias = [desde + timedelta(days=i) for i in range(7) if desde + timedelta(days=i) <= hoy]
    # Cada una trabaja los días que tiene cargados en su horario. Facturarle un
    # día que el local no abre ensucia la prueba de dos formas: le suma trabajo
    # que no existe, y si cae en lunes la app lo toma como día de depilación y
    # le arma un reparto arriba de las comisiones.
    horarios = api.pedir("/api/horarios") or {}
    def trabaja(emp, dia):
        suyos = {t["dia_semana"] for t in horarios.get(str(emp["id"]), [])}
        return dia.weekday() in (suyos or {1, 2, 3, 4, 5})   # sin horario: martes a sábado

    print(f"Ciclo {desde} a {hasta}  ·  {len(empleadas)} empleadas  ·  "
          f"{len(items)} ítems a comisión\n")

    # --- 1. se factura, que es lo que hace aparecer el trabajo en su pantalla ---
    por_dia = {}          # (empleada, día) -> cuántos trabajos, para las horas
    for emp in empleadas:
        for dia in dias:
            if not trabaja(emp, dia):
                continue
            # Y un franco cada tanto entre los que sí trabaja: la semana no puede
            # ser un bloque parejo, que la pantalla tiene que mostrar días con y
            # sin trabajo.
            if rnd.random() < 0.2:
                continue
            for _ in range(rnd.randint(1, 3)):
                item = rnd.choice(items)
                comp = api.pedir("/api/comprobantes", {
                    "tipo": "ticket", "peluquero": emp["nombre"],
                    "cliente_nombre": f"{MARCA} {rnd.randint(100, 999)}",
                    "fecha": dia.isoformat(), "forma_pago": "efectivo",
                    "lineas": [{"item_id": item["id"], "cantidad": 1}]})
                estado = api.pedir(f"/api/comprobantes/{comp['id']}")
                if estado.get("saldo", 0) > 0:
                    api.pedir(f"/api/comprobantes/{comp['id']}/pagos",
                              {"monto": estado["saldo"], "saldado": estado["saldo"],
                               "forma_pago": "Efectivo", "del_servicio": True})
                por_dia[(emp["id"], dia.isoformat())] = por_dia.get((emp["id"], dia.isoformat()), 0) + 1

    # --- 2. y recién ahí se le carga la duración, como hace ella ---
    # La escala sale de lo que efectivamente entró: el trabajo más caro del ciclo
    # son 80 minutos y el más barato 15.
    pendientes = {e["id"]: api.pedir(f"/api/sueldos/pendiente?empleado_id={e['id']}") for e in empleadas}
    # Solo el ciclo que se acaba de cargar. Si la base tiene semanas viejas sin
    # pagar, sus trabajos también vienen sin duración, y la simulación no puede
    # completar lo que está esperando que cargue una persona.
    def del_ciclo(r):
        return [t for c in r["ciclos"] if c["desde"] == desde.isoformat()
                for d in c["dias"] for t in d["trabajos"] if not t["minutos"]]
    bases = [t["base"] for r in pendientes.values() for t in del_ciclo(r)]
    if not bases:
        sys.exit("No quedó ningún trabajo a comisión pendiente: ¿el corte de sueldos es posterior?")
    barato, caro = min(bases), max(bases)
    print(f"Los trabajos van de ${barato:,} a ${caro:,}, o sea de {MIN_MINUTOS} a {MAX_MINUTOS} minutos.\n")

    # El último queda sin duración a propósito: es el estado que frena el cierre,
    # y conviene verlo en la pantalla antes de encontrárselo un viernes.
    sueltos = [(r, t) for r in pendientes.values() for t in del_ciclo(r)]
    sin_duracion = sueltos[-1]
    minutos_dia = {}
    for r, t in sueltos:
        if t is sin_duracion[1]:
            continue
        mins = minutos_por_precio(t["base"], barato, caro, rnd)
        api.pedir("/api/sueldos/trabajo-minutos",
                  {"empleado_id": r["empleado"]["id"],
                   ("trabajo_id" if t["id"] else "linea_id"): t["id"] or t["linea_id"],
                   "minutos": mins}, metodo="PUT")
        clave = (r["empleado"]["id"], t["fecha"])
        minutos_dia[clave] = minutos_dia.get(clave, 0) + mins

    # --- 3. las horas del día: las de sus trabajos más un rato de mostrador ---
    # Esa diferencia es lo que se paga aparte de la comisión; sin ella el ciclo
    # sería solo comisiones y la mitad de la cuenta no se probaría.
    for (emp_id, fecha), mins in minutos_dia.items():
        api.pedir("/api/sueldos/horas",
                  {"empleado_id": emp_id, "fecha": fecha,
                   "minutos": mins + rnd.choice([30, 45, 60, 90])}, metodo="PUT", opcional=True)

    quien = sin_duracion[0]["empleado"]["nombre"]
    print(f"{len(sueltos) - 1} trabajos con duración, más uno sin cargar para {quien}.")
    if api.avisos:
        unicos = sorted(set(api.avisos))
        print(f"\nLa app se negó a {len(api.avisos)} cosa(s), con razón:")
        for a in unicos[:3]:
            print(f"  · {a}")
        print("  Las comisiones se cargaron igual. Probá con --ciclo actual, o con una base "
              "sin sueldos ya cerrados.")
    resumen(api, empleadas, desde)


def resumen(api, empleadas, desde):
    """Lo que la pantalla propone para ESTE ciclo.

    Por ciclo y no por empleada: el total de una puede arrastrar semanas viejas
    sin pagar, y entonces no cierra contra las comisiones y las horas de acá.
    """
    cfg = api.pedir("/api/config")
    print(f"\nCon valor hora ${cfg.get('valor_hora', 0):,} y comisión {cfg.get('comision_pct', 0)}%, "
          f"el ciclo del {desde} propone:\n")
    print(f"  {'':<12} {'comisiones':>12} {'horas':>12} {'total':>12}   falta")
    for emp in empleadas:
        r = api.pedir(f"/api/sueldos/pendiente?empleado_id={emp['id']}")
        c = next((x for x in r["ciclos"] if x["desde"] == desde.isoformat()), None)
        if not c:
            print(f"  {emp['nombre']:<12} {'sin nada en este ciclo':>40}")
            continue
        falta = f"{c['sin_tiempo']} sin duración" if c["sin_tiempo"] else ""
        print(f"  {emp['nombre']:<12} ${c['total_comisiones']:>11,} ${c['total_horas']:>11,} "
              f"${c['total']:>11,}   {falta}")
    print("\nCambiá el valor hora o la comisión en Admin (arriba de Empleados) o en Sueldos,\n"
          "y volvé a mirar: lo pendiente se calcula en vivo hasta que se cierra el ciclo.")


def borrar(api):
    """Saca lo que cargó la simulación. Se reconoce por el nombre del cliente."""
    datos = api.pedir("/api/comprobantes?limite=1000&desde=2000-01-01&hasta=2100-01-01")
    comps = datos.get("comprobantes", datos) if isinstance(datos, dict) else datos
    mios = [c for c in comps if (c.get("cliente_nombre") or "").upper().startswith(MARCA)]
    if not mios:
        print("No encontré comprobantes de la simulación.")
        return
    for c in mios:
        api.pedir(f"/api/comprobantes/{c['id']}", metodo="DELETE")
    print(f"{len(mios)} comprobantes de la simulación anulados.")
    print("Las horas declaradas quedan: son de la empleada, no de la simulación.\n"
          "Se sacan desde la pantalla de sueldos si molestan.")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--url", default="http://127.0.0.1:8000")
    ap.add_argument("--usuario", default="dueno")
    ap.add_argument("--password", default="test1234")
    ap.add_argument("--empleadas", type=int, default=3)
    ap.add_argument("--ciclo", choices=["anterior", "actual"], default="anterior",
                    help="anterior (default) carga un ciclo ya terminado, que se puede cerrar")
    ap.add_argument("--semilla", type=int, default=7,
                    help="misma semilla, mismos números: para comparar dos corridas")
    ap.add_argument("--borrar", action="store_true", help="anula lo que cargó la simulación")
    a = ap.parse_args()

    # Crea comprobantes y pagos de mentira: contra producción sería ensuciar la
    # caja de verdad, y no hay forma de distinguirlos después salvo por el nombre.
    if (urlparse(a.url).hostname or "") not in SOLO_LOCAL:
        sys.exit(f"--url apunta a {urlparse(a.url).hostname}, que no es local.\n"
                 f"Esto carga comprobantes y pagos: solo contra 127.0.0.1.")

    api = Api(a.url, a.usuario, a.password)
    if a.borrar:
        borrar(api)
    else:
        cargar(api, a.empleadas, a.ciclo, a.semilla)


if __name__ == "__main__":
    main()
