#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_FILE="$REPO_DIR/tests/whatsapp-admin-control.test.js"

if [[ ! -f "$TEST_FILE" ]]; then
  echo "ERROR: no se encontró $TEST_FILE"
  exit 1
fi

command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js no está disponible."; exit 1; }

echo "VLA · Validación WhatsApp Admin 100x"
echo "Repositorio: $REPO_DIR"
echo "No usa credenciales, no llama WhatsApp real y no modifica producción."
echo

TMP_LOG="$(mktemp -t vla-wa-test.XXXXXX)"
trap 'rm -f "$TMP_LOG"' EXIT

for i in {1..100}; do
  if ! (cd "$REPO_DIR" && node --test tests/whatsapp-admin-control.test.js >"$TMP_LOG" 2>&1); then
    echo "❌ Falló la iteración $i/100"
    cat "$TMP_LOG"
    exit 1
  fi
  printf "\r✅ Iteración %3d/100" "$i"
done

echo
echo
cat "$TMP_LOG" | tail -12

echo
echo "RESULTADO: 100/100 iteraciones superadas."
echo "Este resultado certifica la batería offline; no sustituye la prueba integral de producción del corte DALE PLAY."
