#!/bin/sh
# Corre las pruebas SQL de la Etapa 1 del onboarding contra la base LOCAL de
# ensayo (contenedor supabase_db_sportmaps-qa-twin). NUNCA contra producción.
#
# Aplica las migraciones de la etapa y las pruebas dentro de UNA transacción y
# termina en ROLLBACK: la base local queda como estaba. Los datos son inventados
# (correos @example.invalid).
#
# Uso (desde la raíz del repo):   sh supabase/tests/onboarding_etapa1/run-local.sh
set -eu

CONTAINER="${TWIN_CONTAINER:-supabase_db_sportmaps-qa-twin}"
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

{
  printf '%s\n' '\set ON_ERROR_STOP on' 'BEGIN;'
  # Las migraciones traen su propio BEGIN/COMMIT: se quitan para que todo quede
  # dentro de la transacción que se revierte.
  for m in \
    20261123082624_escuela_guarda_deporte_del_registro.sql \
    20261123084254_onboarding_status_pasos_reales.sql \
    20261123085942_onboarding_tracking_eventos.sql \
    20261123111624_onboarding_checklist_extras.sql \
    20261123112301_consentimiento_whatsapp_registro.sql \
    ${ETAPA1_MIGRATIONS:-}
  do
    [ -f "$ROOT/supabase/migrations/$m" ] || { echo "falta la migración $m" >&2; exit 1; }
    printf '\n-- ===== migración %s =====\n' "$m"
    sed -e 's/^BEGIN;[[:space:]]*$//' -e 's/^COMMIT;[[:space:]]*$//' "$ROOT/supabase/migrations/$m"
  done
  for t in "$DIR"/T*.sql; do
    printf '\n-- ===== prueba %s =====\n' "$(basename "$t")"
    # T04 incrusta las consultas reales de docs/onboarding (marcadores @@EMBUDO_*@@).
    sed -e "/@@EMBUDO_ACADEMIAS@@/{r $ROOT/docs/onboarding/embudo-academias.sql
d
}" -e "/@@EMBUDO_ACUDIENTES@@/{r $ROOT/docs/onboarding/embudo-acudientes.sql
d
}" "$t"
  done
  printf '\n%s\n' 'ROLLBACK;'
} > "$TMP"

# Guardas: el archivo empieza como debe y no quedó ningún COMMIT suelto.
head -2 "$TMP" | grep -q 'ON_ERROR_STOP on' || { echo "el encabezado de psql quedó mal" >&2; exit 1; }
if grep -n '^COMMIT;' "$TMP"; then echo "quedó un COMMIT en el script: no se corre" >&2; exit 1; fi

docker exec -i "$CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d postgres < "$TMP"
echo "OK: pruebas de onboarding etapa 1 (todo revertido con ROLLBACK)"
