#!/usr/bin/env bash
# Corre las integraciones de reservas contra el gemelo. Uso: bash test/integration/helpers/correr.sh [archivo-filtro]
# Exporta SOLO variables del gemelo (la guarda de produccion exige que SUPABASE_URL no salga de bff/.env).
cd "$(dirname "$0")/../../.." || exit 1
export SUPABASE_URL=http://127.0.0.1:54321
export QA_TWIN_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
npx vitest run -c vitest.integration.config.ts "${1:-test/integration/reservas-}"
