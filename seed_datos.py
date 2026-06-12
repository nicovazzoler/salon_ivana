import json
from database import engine, SessionLocal, Base
import models
from config_extra import FORMAS_PAGO, TIPOS_EGRESO, EXTRA_DIFICULTAD
from auth import nuevo_salt, hash_password

def seed():
    Base.metadata.create_all(engine)
    db = SessionLocal()

    if db.query(models.Item).count() == 0:
        for it in json.load(open("catalogo.json", encoding="utf-8")):
            db.add(models.Item(categoria=it["categoria"], nombre=it["nombre"],
                               precio=it["precio"], es_producto=it["es_producto"]))
        db.commit(); print(f"Sembrados {db.query(models.Item).count()} items.")
    else:
        print("Items ya cargados.")

    if db.query(models.FormaPago).count() == 0:
        for f in FORMAS_PAGO: db.add(models.FormaPago(nombre=f))
        db.commit(); print("Formas de pago sembradas.")

    if db.query(models.TipoEgreso).count() == 0:
        for t in TIPOS_EGRESO: db.add(models.TipoEgreso(nombre=t))
        db.commit(); print("Tipos de egreso sembrados.")

    if not db.query(models.Config).filter_by(clave="extra_dificultad").first():
        db.add(models.Config(clave="extra_dificultad", valor=str(EXTRA_DIFICULTAD)))
        db.commit(); print("Config extra_dificultad sembrada.")

    if not db.query(models.Config).filter_by(clave="fondo_caja").first():
        db.add(models.Config(clave="fondo_caja", valor="0"))
        db.commit(); print("Config fondo_caja sembrada.")

    if db.query(models.Usuario).count() == 0:
        for usuario, password, rol in [("dueno", "dueno1234", "dueno"),
                                       ("empleado", "empleado1234", "empleado")]:
            s = nuevo_salt()
            db.add(models.Usuario(usuario=usuario, salt=s, hash=hash_password(password, s), rol=rol))
        db.commit()
        print("Usuarios creados: dueno/dueno1234 y empleado/empleado1234 (CAMBIAR).")

    db.close()

if __name__ == "__main__":
    seed()
