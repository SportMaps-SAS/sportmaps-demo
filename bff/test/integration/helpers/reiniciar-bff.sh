#!/usr/bin/env bash
# Mata el BFF del puerto 3101 (solo ese) y lo relanza. Uso: bash reiniciar-bff.sh [audit|soft|enforce]
GATING="${1:-enforce}"
PID=$(netstat -ano | grep ":3101 " | grep LISTEN | awk '{print $5}' | head -1)
[ -n "$PID" ] && taskkill //PID "$PID" //F >/dev/null 2>&1
cd "$(dirname "$0")/../../../.." || exit 1
LOG="${T1_BFF_LOG:-/tmp/t1-bff.log}"
nohup node bff/test/integration/helpers/levantar-bff-gemelo.mjs --gating="$GATING" > "$LOG" 2>&1 &
for i in $(seq 1 60); do
  sleep 2
  if curl -s localhost:3101/health >/dev/null 2>&1; then echo "BFF arriba (gating=$GATING) en $((i*2))s"; exit 0; fi
done
echo "BFF no levanto"; tail -20 "$LOG"; exit 1
