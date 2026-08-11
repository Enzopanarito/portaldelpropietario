#!/bin/zsh
set -euo pipefail

N8N_DIR="$HOME/n8n"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$N8N_DIR/backups/whatsapp-controller-rollback-$STAMP"

[[ -d "$N8N_DIR" ]] || { echo "❌ No existe $N8N_DIR"; exit 1; }
cd "$N8N_DIR"
mkdir -p "$ARCHIVE"
chmod 700 "$ARCHIVE"

echo "===== ROLLBACK AISLADO WHATSAPP CONTROLLER ====="
echo "Este rollback NO toca whatsapp-agent, perfil, n8n actual, saldos, pagos ni portón."

echo
echo "1. Deteniendo únicamente whatsapp-controller..."
if [[ -f docker-compose.whatsapp-control.yml ]]; then
  docker compose \
    -f compose.yaml \
    -f docker-compose.whatsapp.yml \
    -f docker-compose.whatsapp-control.yml \
    stop whatsapp-controller 2>/dev/null || true
  docker compose \
    -f compose.yaml \
    -f docker-compose.whatsapp.yml \
    -f docker-compose.whatsapp-control.yml \
    rm -f whatsapp-controller 2>/dev/null || true
fi

echo "2. Conservando copia de diagnóstico..."
[[ -f docker-compose.whatsapp-control.yml ]] && cp -p docker-compose.whatsapp-control.yml "$ARCHIVE/"
[[ -d whatsapp-controller ]] && cp -a whatsapp-controller "$ARCHIVE/"
[[ -d whatsapp-controller-data ]] && cp -a whatsapp-controller-data "$ARCHIVE/"

echo "3. Retirando solo el overlay del controlador..."
rm -f docker-compose.whatsapp-control.yml

echo
echo "✅ Controlador aislado retirado."
echo "✅ whatsapp-agent no fue modificado."
echo "✅ n8n actual no fue modificado por este rollback."
echo "✅ Datos del controlador conservados en: $ARCHIVE"
echo
echo "Si ya se hubiera realizado el corte DALE PLAY, la restauración del workflow anterior se hace siguiendo CUTOVER_DALE_PLAY.md; no se automatiza aquí para evitar habilitar dos planificadores por accidente."
