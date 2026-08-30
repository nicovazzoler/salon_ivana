import hashlib, hmac, os, json, base64, time, secrets

TOKEN_HORAS = 12

# Clave con la que se firman los tokens de sesión.
#
# Con esta clave se puede FABRICAR un token válido: no hace falta usuario ni
# contraseña, alcanza con firmar {"usuario": "x", "rol": "dueno"} y ya se entra
# como dueño a todo, backup de la base incluido. O sea que la clave es, en los
# hechos, la contraseña maestra del sistema.
#
# Antes acá había un valor por defecto escrito en el código. Como el repositorio
# es público, ese valor está publicado: cualquiera que encontrara la dirección
# de la app entraba sin saber ninguna contraseña. Y no era un descuido evidente,
# porque la app arrancaba y funcionaba perfecto sin la variable de entorno.
#
# Ahora no hay valor por defecto. La clave sale de:
#   1. la variable de entorno SECRET_KEY, si está;
#   2. si no, una al azar que se guarda en la base la primera vez y se reusa
#      siempre (por eso los tokens sobreviven a los reinicios).
#
# La opción 2 hace que la app sea segura sin que haya que configurar nada. La 1
# sigue existiendo porque es la única forma de compartir la misma clave entre
# varias instancias, si algún día se corre más de una.
_CLAVE_EN_BASE = "secret_key"
_cache = None

def _clave() -> str:
    global _cache
    if _cache:
        return _cache
    del_entorno = os.getenv("SECRET_KEY")
    if del_entorno:
        _cache = del_entorno
        return _cache

    # Se pide tarde y no al importar el módulo: cuando esto corre, las tablas ya
    # están creadas.
    from database import SessionLocal
    import models
    db = SessionLocal()
    try:
        fila = db.query(models.Config).filter_by(clave=_CLAVE_EN_BASE).first()
        if not fila:
            fila = models.Config(clave=_CLAVE_EN_BASE, valor=secrets.token_hex(32))
            db.add(fila)
            db.commit()
            print("Se generó una clave de firma nueva y quedó guardada en la base.")
        _cache = fila.valor
    finally:
        db.close()
    return _cache

def hash_password(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000).hex()

def nuevo_salt() -> str:
    return os.urandom(16).hex()

def _firmar(data: bytes) -> str:
    return hmac.new(_clave().encode(), data, hashlib.sha256).hexdigest()

def crear_token(usuario: str, rol: str) -> str:
    payload = {"usuario": usuario, "rol": rol, "exp": int(time.time()) + TOKEN_HORAS * 3600}
    raw = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    return f"{raw}.{_firmar(raw.encode())}"

def verificar_token(token: str):
    try:
        raw, firma = token.split(".")
        if not hmac.compare_digest(firma, _firmar(raw.encode())):
            return None
        payload = json.loads(base64.urlsafe_b64decode(raw.encode()))
        if payload["exp"] < time.time():
            return None
        return payload
    except Exception:
        return None
