import hashlib, hmac, os, json, base64, time, secrets

TOKEN_HORAS = 12

# Con esta clave se fabrica un token de dueño sin saber ninguna contraseña, así
# que es la contraseña maestra: NUNCA un valor por defecto en el código, que el
# repositorio es público. Sale de SECRET_KEY o de una al azar guardada en la base.
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
        # Los tokens que no son de sesión llevan "t": los firma la misma clave, así
        # que sin esto el código de sueldos pasaría como sesión válida y el que lo
        # tuviera entraría a todo lo demás.
        if payload.get("t"):
            return None
        return payload
    except Exception:
        return None

# ---------- el código de la pantalla de sueldos ----------
# Dice QUIÉN de las empleadas abrió su sueldo, no quién entró a la app. El
# navegador lo guarda en memoria y lo tira al salir, así que el vencimiento es
# el último techo de un permiso que se hubiera escapado.
SUELDO_MINUTOS = 30

def crear_token_sueldo(empleado_id: int) -> str:
    payload = {"t": "sueldo", "empleado": int(empleado_id),
               "exp": int(time.time()) + SUELDO_MINUTOS * 60}
    raw = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    return f"{raw}.{_firmar(raw.encode())}"

def verificar_token_sueldo(token: str):
    """Devuelve el id de la empleada, o None."""
    try:
        raw, firma = token.split(".")
        if not hmac.compare_digest(firma, _firmar(raw.encode())):
            return None
        payload = json.loads(base64.urlsafe_b64decode(raw.encode()))
        if payload.get("t") != "sueldo" or payload["exp"] < time.time():
            return None
        return int(payload["empleado"])
    except Exception:
        return None
