import hashlib, hmac, os, json, base64, time

SECRET_KEY = os.getenv("SECRET_KEY", "clave-de-desarrollo-cambiar-en-produccion")
TOKEN_HORAS = 12

def hash_password(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000).hex()

def nuevo_salt() -> str:
    return os.urandom(16).hex()

def _firmar(data: bytes) -> str:
    return hmac.new(SECRET_KEY.encode(), data, hashlib.sha256).hexdigest()

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
