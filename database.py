import os
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

# En produccion se usa DATABASE_URL (PostgreSQL). En local, SQLite.
url = os.getenv("DATABASE_URL", "sqlite:///pelu.db")
if url.startswith("postgres://"):
    url = url.replace("postgres://", "postgresql://", 1)

connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
engine = create_engine(url, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False)
Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
