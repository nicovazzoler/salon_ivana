#!/usr/bin/env bash
#
# Restaura el dump en una base descartable y compara contra el original.
#
# Que pg_restore pueda LEER el archivo no prueba que sirva: prueba que el
# archivo no está corrupto. Esto prueba lo otro, que es lo que importa el día
# malo: que restaurándolo vuelven los mismos comprobantes y la misma plata.
#
#   DATABASE_URL="postgresql://..." ./verificar_restore.sh archivo.dump "postgresql://scratch"
#
# El segundo argumento es una base VACÍA y descartable, no la de producción.

set -euo pipefail

ARCHIVO="${1:?falta el archivo .dump}"
SCRATCH="${2:?falta la URL de la base descartable}"

if [ -z "${DATABASE_URL:-}" ]; then
    echo "ERROR: falta DATABASE_URL (la base original, para comparar)" >&2
    exit 1
fi

echo "Restaurando $(basename "$ARCHIVO") en una base descartable..."
pg_restore --dbname="$SCRATCH" --no-owner --no-privileges "$ARCHIVO" > /dev/null

# Se compara lo que no se puede reponer a mano si se pierde. La suma de los
# pagos es el número que importa: si no da, la copia no sirve por más que las
# tablas estén todas.
CONSULTAS=(
    "SELECT count(*) FROM comprobantes"
    "SELECT count(*) FROM comprobante_lineas"
    "SELECT count(*) FROM pagos"
    "SELECT count(*) FROM clientes"
    "SELECT count(*) FROM items"
    "SELECT coalesce(sum(monto), 0) FROM pagos"
    "SELECT coalesce(sum(total_lista), 0) FROM comprobantes"
)

FALLOS=0
for q in "${CONSULTAS[@]}"; do
    ORIGEN=$(psql "$DATABASE_URL" -tAc "$q")
    COPIA=$(psql "$SCRATCH" -tAc "$q")
    ETIQUETA="${q#SELECT }"
    if [ "$ORIGEN" = "$COPIA" ]; then
        printf '  OK   %-46s %s\n' "$ETIQUETA" "$ORIGEN"
    else
        printf '  MAL  %-46s origen=%s copia=%s\n' "$ETIQUETA" "$ORIGEN" "$COPIA"
        FALLOS=$((FALLOS + 1))
    fi
done

if [ "$FALLOS" -ne 0 ]; then
    echo "ERROR: la copia restaurada no coincide con la base. NO sirve como backup." >&2
    exit 1
fi

echo "El backup se restaura y da los mismos números."
