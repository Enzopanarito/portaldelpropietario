#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
N8N_DIR="$HOME/n8n"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$N8N_DIR/backups/whatsapp-admin-control-$STAMP"

fail(){ echo "❌ $*"; exit 1; }

[[ -d "$N8N_DIR" ]] || fail "No existe $N8N_DIR"
command -v docker >/dev/null 2>&1 || fail "Docker no está disponible."
command -v curl >/dev/null 2>&1 || fail "curl no está disponible."
command -v python3 >/dev/null 2>&1 || fail "python3 no está disponible."

for f in controller.js Dockerfile bootstrap-control.json docker-compose.whatsapp-control.yml; do
  [[ -f "$SCRIPT_DIR/$f" ]] || fail "Falta archivo preparado: $SCRIPT_DIR/$f"
done

cd "$N8N_DIR"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

echo "===== 1. RESPALDO PREVIO ====="
for f in .env compose.yaml docker-compose.whatsapp.yml docker-compose.whatsapp-control.yml; do
  [[ -f "$f" ]] && cp -p "$f" "$BACKUP_DIR/$f"
done

if [[ -d whatsapp-controller ]]; then
  cp -a whatsapp-controller "$BACKUP_DIR/whatsapp-controller"
fi
if [[ -d whatsapp-controller-data ]]; then
  cp -a whatsapp-controller-data "$BACKUP_DIR/whatsapp-controller-data"
fi
if [[ -f whatsapp-agent/server.js ]]; then
  mkdir -p "$BACKUP_DIR/whatsapp-agent"
  cp -p whatsapp-agent/server.js "$BACKUP_DIR/whatsapp-agent/server.js"
  [[ -f whatsapp-agent/Dockerfile ]] && cp -p whatsapp-agent/Dockerfile "$BACKUP_DIR/whatsapp-agent/Dockerfile"
  [[ -f whatsapp-agent/package.json ]] && cp -p whatsapp-agent/package.json "$BACKUP_DIR/whatsapp-agent/package.json"
fi
if [[ -f whatsapp-agent-data/state.json ]]; then
  mkdir -p "$BACKUP_DIR/whatsapp-agent-data"
  cp -p whatsapp-agent-data/state.json "$BACKUP_DIR/whatsapp-agent-data/state.json"
fi

N8N_CID="$(docker compose -f compose.yaml -f docker-compose.whatsapp.yml ps -q n8n 2>/dev/null || true)"
[[ -n "$N8N_CID" ]] || N8N_CID="$(docker ps -q --filter 'name=^/n8n$' | head -1)"
[[ -n "$N8N_CID" ]] || fail "No se localizó el contenedor n8n. No se modifica nada."

docker exec -u node "$N8N_CID" n8n export:workflow --all --output=/tmp/vla-workflows-before-wa-admin.json >/dev/null || fail "No se pudo exportar workflows. No se modifica nada."
docker cp "$N8N_CID:/tmp/vla-workflows-before-wa-admin.json" "$BACKUP_DIR/n8n-workflows-before.json" >/dev/null

# Secretos/respaldos: archivos 600, directorios 700. Nunca quitar permiso de
# traversal a directorios, porque volvería inútil el propio respaldo.
find "$BACKUP_DIR" -type d -exec chmod 700 {} +
find "$BACKUP_DIR" -type f -exec chmod 600 {} +

echo "Backup local creado: $BACKUP_DIR"

echo
echo "===== 2. VALIDANDO TOKEN SIN MOSTRARLO ====="
[[ -f .env ]] || fail "Falta ~/n8n/.env"
TOKEN_LEN="$(python3 - <<'PY'
from pathlib import Path
p=Path.home()/"n8n"/".env"
value=""
for line in p.read_text().splitlines():
    if line.startswith("WA_AGENT_TOKEN="):
        value=line.split("=",1)[1].strip().strip('"').strip("'")
        break
print(len(value))
PY
)"
[[ "$TOKEN_LEN" -ge 32 ]] || fail "WA_AGENT_TOKEN no está configurado correctamente. No se modifica nada."
echo "Token presente y con longitud válida. Valor oculto."

echo
echo "===== 3. INSTALANDO SOLO EL CONTROLADOR ====="
mkdir -p whatsapp-controller whatsapp-controller-data
cp "$SCRIPT_DIR/controller.js" whatsapp-controller/controller.js
cp "$SCRIPT_DIR/Dockerfile" whatsapp-controller/Dockerfile
cp "$SCRIPT_DIR/bootstrap-control.json" whatsapp-controller/bootstrap-control.json
cp "$SCRIPT_DIR/docker-compose.whatsapp-control.yml" docker-compose.whatsapp-control.yml

# Garantía de instalación segura: incluso si existe configuración previa del
# controlador, conservar sus horarios pero forzar PAUSADO antes de levantarlo.
if [[ -f whatsapp-controller-data/control.json ]]; then
  python3 - <<'PY'
import json
from pathlib import Path
p=Path.home()/"n8n"/"whatsapp-controller-data"/"control.json"
try:
    data=json.loads(p.read_text())
except Exception:
    data={}
data['version']=1
data['mode']='paused'
data.setdefault('schedules',['09:00','18:00'])
data.setdefault('warmupMinutes',5)
data['updatedBy']='safe-installer'
p.write_text(json.dumps(data,indent=2,ensure_ascii=False)+"\n")
PY
else
  cp "$SCRIPT_DIR/bootstrap-control.json" whatsapp-controller-data/control.json
fi
chmod 600 whatsapp-controller-data/control.json

# Solo se crea/recrea whatsapp-controller. --no-deps impide reiniciar el agente.
docker compose \
  -f compose.yaml \
  -f docker-compose.whatsapp.yml \
  -f docker-compose.whatsapp-control.yml \
  up -d --no-deps --build whatsapp-controller

echo
echo "===== 4. COMPROBANDO HEALTH ====="
rm -f /tmp/vla-wa-controller-health.json /tmp/vla-wa-controller-status.json
for i in {1..40}; do
  if curl -fsS http://127.0.0.1:8788/health > /tmp/vla-wa-controller-health.json 2>/dev/null; then break; fi
  sleep 0.5
done
[[ -s /tmp/vla-wa-controller-health.json ]] || fail "El controlador no respondió. Use ROLLBACK_CONTROLADOR.command."

MODE="$(python3 - <<'PY'
import json
print(json.load(open('/tmp/vla-wa-controller-health.json')).get('mode',''))
PY
)"
[[ "$MODE" == "paused" ]] || fail "SEGURIDAD: el controlador no arrancó PAUSADO. Use rollback."

echo "Controlador operativo en modo PAUSADO."

echo
echo "===== 5. ESTADO AUTENTICADO ====="
TOKEN="$(python3 - <<'PY'
from pathlib import Path
p=Path.home()/"n8n"/".env"
for line in p.read_text().splitlines():
    if line.startswith("WA_AGENT_TOKEN="):
        print(line.split("=",1)[1].strip().strip('"').strip("'")); break
PY
)"
curl -fsS -H "x-agent-token: $TOKEN" http://127.0.0.1:8788/status >/tmp/vla-wa-controller-status.json || fail "El controlador no pudo consultar al agente existente."
unset TOKEN

python3 - <<'PY'
import json
j=json.load(open('/tmp/vla-wa-controller-status.json'))
assert j.get('config',{}).get('mode')=='paused', j
assert j.get('agent',{}).get('ok') is True, j
print('Agente existente: alcanzable')
print('Modo controlador: PAUSADO')
PY

echo
echo "===== RESULTADO ====="
echo "✅ Respaldo creado antes de modificar."
echo "✅ Controlador agregado sin reiniciar whatsapp-agent."
echo "✅ Controlador PAUSADO, incluso ante configuración previa."
echo "✅ Agente existente alcanzable."
echo "✅ No se importó/publicó ningún workflow nuevo."
echo "✅ No se modificó Netlify."
echo "✅ No se modificó el perfil de WhatsApp."
echo
echo "El siguiente paso pertenece al corte DALE PLAY y NO debe ejecutarse automáticamente."
