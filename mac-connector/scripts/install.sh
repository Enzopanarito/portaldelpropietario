#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

PRODUCT_NAME="VLA WhatsApp Connector"
HOST_NAME="com.villaslosapamates.whatsapp_connector"
EXTENSION_ID="oopmhhmkihemkkjghmpepgfcmcomplph"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SUPPORT_DIR="${HOME}/Library/Application Support/Villas Los Apamates/WhatsApp Connector"
BIN_DIR="${SUPPORT_DIR}/bin"
EXTENSION_DIR="${SUPPORT_DIR}/Chrome Extension"
BACKUP_DIR="${SUPPORT_DIR}/Install Backups/$(date +%Y%m%d-%H%M%S)"
APP_DIR="${HOME}/Applications/${PRODUCT_NAME}.app"
APP_CONTENTS="${APP_DIR}/Contents"
APP_MACOS="${APP_CONTENTS}/MacOS"
NATIVE_DIR="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
NATIVE_MANIFEST="${NATIVE_DIR}/${HOST_NAME}.json"
LAUNCH_AGENTS="${HOME}/Library/LaunchAgents"
LAUNCH_AGENT="${LAUNCH_AGENTS}/com.villaslosapamates.whatsapp-menu.plist"

fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }
info() { printf '\n==> %s\n' "$1"; }

[[ "$(uname -s)" == "Darwin" ]] || fail "Este instalador solo funciona en macOS."
command -v swift >/dev/null 2>&1 || fail "Swift no está disponible. Instale las herramientas de línea de comandos de Xcode."
[[ -d "/Applications/Google Chrome.app" ]] || fail "Google Chrome no está instalado en /Applications."
[[ -f "${PROJECT_DIR}/Package.swift" ]] || fail "No se encontró Package.swift."
[[ -f "${PROJECT_DIR}/chrome-extension/manifest.json" ]] || fail "No se encontró la extensión de Chrome."

mkdir -p "${SUPPORT_DIR}" "${BIN_DIR}" "${NATIVE_DIR}" "${LAUNCH_AGENTS}" "${HOME}/Applications" "${BACKUP_DIR}"
chmod 700 "${SUPPORT_DIR}" "${BIN_DIR}" "${BACKUP_DIR}"

info "Creando respaldo de la instalación anterior"
for item in "${BIN_DIR}/VLAWhatsAppHost" "${APP_DIR}" "${EXTENSION_DIR}" "${NATIVE_MANIFEST}" "${LAUNCH_AGENT}"; do
  if [[ -e "$item" ]]; then
    cp -R "$item" "${BACKUP_DIR}/" || fail "No se pudo respaldar $item"
  fi
done

info "Compilando el conector para esta Mac"
cd "${PROJECT_DIR}"
swift test
swift build -c release --product VLAWhatsAppHost
swift build -c release --product VLAWhatsAppMenu
BUILD_DIR="$(swift build -c release --show-bin-path)"
[[ -x "${BUILD_DIR}/VLAWhatsAppHost" ]] || fail "No se generó VLAWhatsAppHost."
[[ -x "${BUILD_DIR}/VLAWhatsAppMenu" ]] || fail "No se generó VLAWhatsAppMenu."

info "Instalando binarios sin borrar identidad ni registros"
install -m 700 "${BUILD_DIR}/VLAWhatsAppHost" "${BIN_DIR}/VLAWhatsAppHost"
rm -rf "${APP_DIR}"
mkdir -p "${APP_MACOS}"
install -m 700 "${BUILD_DIR}/VLAWhatsAppMenu" "${APP_MACOS}/VLAWhatsAppMenu"
cat > "${APP_CONTENTS}/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleDisplayName</key><string>${PRODUCT_NAME}</string>
  <key>CFBundleExecutable</key><string>VLAWhatsAppMenu</string>
  <key>CFBundleIdentifier</key><string>com.villaslosapamates.whatsapp-menu</string>
  <key>CFBundleName</key><string>${PRODUCT_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
chmod 600 "${APP_CONTENTS}/Info.plist"

info "Instalando la extensión privada"
rm -rf "${EXTENSION_DIR}"
cp -R "${PROJECT_DIR}/chrome-extension" "${EXTENSION_DIR}"
find "${EXTENSION_DIR}" -type d -exec chmod 700 {} \;
find "${EXTENSION_DIR}" -type f -exec chmod 600 {} \;

info "Registrando Native Messaging solo para la extensión autorizada"
python3 - "${NATIVE_MANIFEST}" "${BIN_DIR}/VLAWhatsAppHost" "${EXTENSION_ID}" <<'PY'
import json, pathlib, sys
path, host, extension_id = sys.argv[1:]
data = {
    "name": "com.villaslosapamates.whatsapp_connector",
    "description": "Villas Los Apamates WhatsApp native connector",
    "path": host,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{extension_id}/"]
}
pathlib.Path(path).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
chmod 600 "${NATIVE_MANIFEST}"

info "Configurando inicio automático opcional de la app de barra"
cat > "${LAUNCH_AGENT}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.villaslosapamates.whatsapp-menu</string>
  <key>ProgramArguments</key><array><string>${APP_MACOS}/VLAWhatsAppMenu</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${SUPPORT_DIR}/Logs/menu.stdout.log</string>
  <key>StandardErrorPath</key><string>${SUPPORT_DIR}/Logs/menu.stderr.log</string>
</dict></plist>
PLIST
chmod 600 "${LAUNCH_AGENT}"
launchctl bootout "gui/$(id -u)" "${LAUNCH_AGENT}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "${LAUNCH_AGENT}" || fail "No se pudo iniciar la app de barra."

info "Verificando la instalación"
python3 - "${NATIVE_MANIFEST}" "${EXTENSION_ID}" <<'PY'
import json, pathlib, sys
path, extension_id = sys.argv[1:]
data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
assert data["name"] == "com.villaslosapamates.whatsapp_connector"
assert data["allowed_origins"] == [f"chrome-extension://{extension_id}/"]
assert pathlib.Path(data["path"]).is_file()
print("Manifest Native Messaging válido.")
PY

printf '\nINSTALACIÓN LOCAL COMPLETADA.\n'
printf '1. Abra chrome://extensions en Google Chrome.\n'
printf '2. Active “Modo de desarrollador”.\n'
printf '3. Pulse “Cargar extensión sin empaquetar”.\n'
printf '4. Seleccione esta carpeta:\n   %s\n' "${EXTENSION_DIR}"
printf '5. Confirme que el ID sea: %s\n' "${EXTENSION_ID}"
printf '6. Abra WhatsApp Web y vincule la sesión si Chrome lo solicita.\n'
printf '\nEl envío real sigue bloqueado por el servidor hasta la certificación final.\n'
open "chrome://extensions" >/dev/null 2>&1 || true
open -R "${EXTENSION_DIR}" >/dev/null 2>&1 || true
