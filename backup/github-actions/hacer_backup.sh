#!/usr/bin/env bash
#
# Hace el pg_dump y NO lo da por bueno hasta verificarlo.
#
# Lo llama el workflow de GitHub Actions, pero es un script común y corre igual
# en cualquier lado. Eso es a propósito: la lógica que decide si un backup sirve
# o no tiene que poder probarse sin esperar a que GitHub la ejecute.
#
#   DATABASE_URL="postgresql://..." ./hacer_backup.sh [carpeta_destino]
#
# Sale con 0 si el backup quedó bueno y con 1 si no. Un backup que falla
# callado es peor que no tener backup, porque uno se queda tranquilo.

set -euo pipefail

DESTINO="${1:-.}"
# La base tiene 20 tablas. Si el dump trae bastantes menos, algo salió mal:
# puede haber cortado a la mitad y el archivo igual existe y pesa.
MINIMO_TABLAS="${MINIMO_TABLAS:-15}"
MINIMO_BYTES="${MINIMO_BYTES:-5000}"

if [ -z "${DATABASE_URL:-}" ]; then
    echo "ERROR: falta DATABASE_URL" >&2
    exit 1
fi

mkdir -p "$DESTINO"

# La fecha del archivo va en hora argentina, que es la que significa algo para
# quien lo va a buscar: si el backup corre a las 03:00 UTC, en UTC el nombre
# diría el día siguiente al que la gente llama "ayer".
SELLO="$(TZ=America/Argentina/Buenos_Aires date +%Y%m%d_%H%M)"
ARCHIVO="$DESTINO/salon_ivana_${SELLO}.dump"

# Se escribe en un temporal y recién al final se mueve al destino. pg_dump CREA
# el archivo antes de conectarse, así que si la conexión falla deja uno de cero
# bytes: escribiendo derecho al destino, un intento fallido planta ahí algo que
# parece un backup y encima pisa al del mismo nombre. Esto se descubrió
# probando, no leyendo el código.
TEMPORAL="$(mktemp -t salon_ivana.XXXXXX.dump)"
trap 'rm -f "$TEMPORAL"' EXIT

echo "Servidor: $(psql "$DATABASE_URL" -tAc 'SELECT version()' | cut -c1-40)"

# --format=custom es el que lee pg_restore. --no-owner y --no-privileges para
# poder restaurar en cualquier servidor sin que existan los roles de Railway.
pg_dump "$DATABASE_URL" \
    --format=custom \
    --no-owner \
    --no-privileges \
    --file="$TEMPORAL"

BYTES=$(stat -c%s "$TEMPORAL")
if [ "$BYTES" -lt "$MINIMO_BYTES" ]; then
    echo "ERROR: el dump salió de $BYTES bytes, está vacío o cortado" >&2
    exit 1
fi

# Que el archivo se pueda LEER, no solo que exista y pese. Un dump corrupto
# ocupa lo mismo que uno sano.
if ! LISTADO=$(pg_restore --list "$TEMPORAL" 2>&1); then
    echo "ERROR: pg_restore no puede leer el dump, está corrupto" >&2
    echo "$LISTADO" >&2
    exit 1
fi

TABLAS=$(echo "$LISTADO" | grep -c "TABLE DATA" || true)
if [ "$TABLAS" -lt "$MINIMO_TABLAS" ]; then
    echo "ERROR: el dump trae $TABLAS tablas con datos y esperábamos al menos $MINIMO_TABLAS" >&2
    exit 1
fi

# Recién acá, ya verificado, ocupa su nombre definitivo.
mv "$TEMPORAL" "$ARCHIVO"

echo "OK: $(basename "$ARCHIVO") — $((BYTES / 1024)) KB, $TABLAS tablas"

# Para que el workflow pueda usar el nombre en el paso siguiente.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
        echo "archivo=$ARCHIVO"
        echo "nombre=$(basename "$ARCHIVO" .dump)"
        echo "kb=$((BYTES / 1024))"
        echo "tablas=$TABLAS"
    } >> "$GITHUB_OUTPUT"
fi
