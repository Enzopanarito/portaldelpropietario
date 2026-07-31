#!/bin/bash
set -Eeuo pipefail
IFS=$'\n\t'

PRODUCT_NAME="VLA WhatsApp Connector"
HOST_NAME="com.villaslosapamates.whatsapp_connector"
EXTENSION_ID="oopmhhmkihemkkjghmpepgfcmcomplph"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SUPPORT_DIR="${HOME}/Library/Application Support/Villas Los Apamates/WhatsApp Connector"
BIN_DIR="${SUPPORT_DIR}/bin"
LOG_DIR="${SUPPORT_DIR}/Logs"
EXTENSION_DIR="${SUPPORT_DIR}/Chrome Extension"
BACKUPS_DIR="${SUPPORT_DIR}/Install Backups"
BACKUP_DIR="${BACKUPS_DIR}/$(date +%Y%m%d-%H%M%S)-$$"
INSTALL_METADATA="${SUPPORT_DIR}/CURRENT_INSTALL.json"
APP_DIR="${HOME}/Applications/${PRODUCT_NAME}.app"
APP_CONTENTS="${APP_DIR}/Contents"
APP_MACOS="${APP_CONTENTS}/MacOS"
NATIVE_DIR="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
NATIVE_MANIFEST="${NATIVE_DIR}/${HOST_NAME}.json"
LAUNCH_AGENTS="${HOME}/Library/LaunchAgents"
LAUNCH_AGENT="${LAUNCH_AGENTS}/com.villaslosapamates.whatsapp-menu.plist"
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/vla-whatsapp-install.XXXXXX")"
STAGE_APP="${STAGE_DIR}/${PRODUCT_NAME}.app"
STAGE_HOST="${STAGE_DIR}/VLAWhatsAppHost"
STAGE_EXTENSION="${STAGE_DIR}/Chrome Extension"
STAGE_NATIVE="${STAGE_DIR}/${HOST_NAME}.json"
STAGE_AGENT="${STAGE_DIR}/com.villaslosapamates.whatsapp-menu.plist"
INVENTORY="${BACKUP_DIR}/inventory.tsv"
BACKUP_READY="false"
INSTALL_COMMITTED="false"

fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }
info() { printf '\n==> %s\n' "$1"; }

path_for_key() {
  case "$1" in
    host) printf '%s' "${BIN_DIR}/VLAWhatsAppHost" ;;
    app) printf '%s' "${APP_DIR}" ;;
    extension) printf '%s' "${EXTENSION_DIR}" ;;
    native-manifest) printf '%s' "${NATIVE_MANIFEST}" ;;
    launch-agent) printf '%s' "${LAUNCH_AGENT}" ;;
    install-metadata) printf '%s' "${INSTALL_METADATA}" ;;
    *) return 1 ;;
  esac
}

backup_item() {
  local key="$1" source
  source="$(path_for_key "$key")"
  if [[ -e "$source" ]]; then
    printf '%s\t1\n' "$key" >> "${INVENTORY}"
    cp -R "$source" "${BACKUP_DIR}/${key}"
  else
    printf '%s\t0\n' "$key" >> "${INVENTORY}"
  fi
}

restore_backup() {
  local backup="$1" key present destination
  [[ -f "${backup}/inventory.tsv" ]] || return 1
  launchctl bootout "gui/$(id -u)" "${LAUNCH_AGENT}" >/dev/null 2>&1 || true
  while IFS=$'\t' read -r key present; do
    [[ -n "$key" ]] || continue
    destination="$(path_for_key "$key")"
    rm -rf "$destination"
    if [[ "$present" == "1" ]]; then
      mkdir -p "$(dirname "$destination")"
      cp -R "${backup}/${key}" "$destination"
    fi
  done < "${backup}/inventory.tsv"
  [[ -x "${BIN_DIR}/VLAWhatsAppHost" ]] && chmod 700 "${BIN_DIR}/VLAWhatsAppHost"
  [[ -f "${NATIVE_MANIFEST}" ]] && chmod 600 "${NATIVE_MANIFEST}"
  if [[ -f "${LAUNCH_AGENT}" ]]; then
    chmod 600 "${LAUNCH_AGENT}"
    launchctl bootstrap "gui/$(id -u)" "${LAUNCH_AGENT}" >/dev/null 2>&1 || true
  fi
}

on_error() {
  local line="${1:-?}" status="${2:-1}"
  trap - ERR
  printf '\nERROR: instalación interrumpida en la línea %s (código %s).\n' "$line" "$status" >&2
  if [[ "${BACKUP_READY}" == "true" && "${INSTALL_COMMITTED}" != "true" ]]; then
    printf 'Restaurando automáticamente el estado anterior desde:\n%s\n' "${BACKUP_DIR}" >&2
    restore_backup "${BACKUP_DIR}" || printf 'ADVERTENCIA: el rollback automático no pudo completarse. Use rollback-latest.sh.\n' >&2
  fi
  exit "$status"
}

cleanup() { rm -rf "${STAGE_DIR}"; }
trap cleanup EXIT
trap 'status=$?; on_error "$LINENO" "$status"' ERR

[[ "$(uname -s)" == "Darwin" ]] || fail "Este instalador solo funciona en macOS."
command -v swift >/dev/null 2>&1 || fail "Swift no está disponible. Instale las herramientas de línea de comandos de Xcode."
command -v python3 >/dev/null 2>&1 || fail "Python 3 no está disponible."
command -v plutil >/dev/null 2>&1 || fail "plutil no está disponible."
command -v codesign >/dev/null 2>&1 || fail "codesign no está disponible."
[[ -d "/Applications/Google Chrome.app" ]] || fail "Google Chrome no está instalado en /Applications."
[[ -f "${PROJECT_DIR}/Package.swift" ]] || fail "No se encontró Package.swift."
[[ -f "${PROJECT_DIR}/chrome-extension/manifest.json" ]] || fail "No se encontró la extensión de Chrome."

info "Compilando y probando en un área temporal, sin tocar la instalación activa"
cd "${PROJECT_DIR}"
swift test
swift build -c release --product VLAWhatsAppHost
swift build -c release --product VLAWhatsAppMenu
BUILD_DIR="$(swift build -c release --show-bin-path)"
[[ -x "${BUILD_DIR}/VLAWhatsAppHost" ]] || fail "No se generó VLAWhatsAppHost."
[[ -x "${BUILD_DIR}/VLAWhatsAppMenu" ]] || fail "No se generó VLAWhatsAppMenu."

install -m 700 "${BUILD_DIR}/VLAWhatsAppHost" "${STAGE_HOST}"
mkdir -p "${STAGE_APP}/Contents/MacOS"
install -m 700 "${BUILD_DIR}/VLAWhatsAppMenu" "${STAGE_APP}/Contents/MacOS/VLAWhatsAppMenu"
cp -R "${PROJECT_DIR}/chrome-extension" "${STAGE_EXTENSION}"

cat > "${STAGE_APP}/Contents/Info.plist" <<PLIST
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

python3 - "${STAGE_NATIVE}" "${BIN_DIR}/VLAWhatsAppHost" "${EXTENSION_ID}" <<'PY'
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

cat > "${STAGE_AGENT}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.villaslosapamates.whatsapp-menu</string>
  <key>ProgramArguments</key><array><string>${APP_MACOS}/VLAWhatsAppMenu</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${LOG_DIR}/menu.stdout.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/menu.stderr.log</string>
</dict></plist>
PLIST

info "Validando identidad de la extensión, JSON, plist y firmas locales"
python3 - "${STAGE_EXTENSION}/manifest.json" "${EXTENSION_ID}" <<'PY'
import base64, hashlib, json, pathlib, sys
manifest_path, expected = sys.argv[1:]
data = json.loads(pathlib.Path(manifest_path).read_text(encoding="utf-8"))
raw = base64.b64decode(data["key"], validate=True)
hex_id = hashlib.sha256(raw).hexdigest()[:32]
actual = "".join(chr(ord("a") + int(ch, 16)) for ch in hex_id)
assert actual == expected, f"ID de extensión inesperado: {actual}"
assert data["externally_connectable"]["matches"] == ["https://villalosapamates.netlify.app/*"]
print(f"Identidad estable de extensión verificada: {actual}")
PY
python3 -m json.tool "${STAGE_NATIVE}" >/dev/null
plutil -lint "${STAGE_APP}/Contents/Info.plist" >/dev/null
plutil -lint "${STAGE_AGENT}" >/dev/null
xattr -dr com.apple.quarantine "${STAGE_APP}" "${STAGE_HOST}" "${STAGE_EXTENSION}" 2>/dev/null || true
codesign --force --sign - "${STAGE_HOST}"
codesign --force --deep --sign - "${STAGE_APP}"
codesign --verify --strict "${STAGE_HOST}"
codesign --verify --deep --strict "${STAGE_APP}"

info "Creando respaldo transaccional del estado exacto anterior"
mkdir -p "${SUPPORT_DIR}" "${BACKUPS_DIR}" "${BACKUP_DIR}"
chmod 700 "${SUPPORT_DIR}" "${BACKUPS_DIR}" "${BACKUP_DIR}"
: > "${INVENTORY}"
for key in host app extension native-manifest launch-agent install-metadata; do backup_item "$key"; done
python3 - "${BACKUP_DIR}/backup.json" "${BACKUP_DIR}" <<'PY'
import datetime, json, pathlib, sys
path, backup = sys.argv[1:]
data = {"schemaVersion":"vla-install-backup-v2","createdAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),"backupPath":backup}
pathlib.Path(path).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
BACKUP_READY="true"

info "Aplicando la instalación validada"
mkdir -p "${BIN_DIR}" "${LOG_DIR}" "${NATIVE_DIR}" "${LAUNCH_AGENTS}" "${HOME}/Applications"
chmod 700 "${SUPPORT_DIR}" "${BIN_DIR}" "${LOG_DIR}" "${BACKUPS_DIR}"
launchctl bootout "gui/$(id -u)" "${LAUNCH_AGENT}" >/dev/null 2>&1 || true
install -m 700 "${STAGE_HOST}" "${BIN_DIR}/VLAWhatsAppHost"
rm -rf "${APP_DIR}" "${EXTENSION_DIR}"
cp -R "${STAGE_APP}" "${APP_DIR}"
cp -R "${STAGE_EXTENSION}" "${EXTENSION_DIR}"
install -m 600 "${STAGE_NATIVE}" "${NATIVE_MANIFEST}"
install -m 600 "${STAGE_AGENT}" "${LAUNCH_AGENT}"
find "${EXTENSION_DIR}" -type d -exec chmod 700 {} \;
find "${EXTENSION_DIR}" -type f -exec chmod 600 {} \;
chmod 700 "${APP_MACOS}/VLAWhatsAppMenu"

python3 - "${INSTALL_METADATA}" "${BACKUP_DIR}" "${EXTENSION_ID}" <<'PY'
import datetime, json, pathlib, sys
path, backup, extension_id = sys.argv[1:]
data = {
    "schemaVersion":"vla-local-install-v2",
    "installedAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "version":"1.0.0",
    "extensionId":extension_id,
    "rollbackBackup":backup
}
pathlib.Path(path).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
chmod 600 "${INSTALL_METADATA}"
launchctl bootstrap "gui/$(id -u)" "${LAUNCH_AGENT}"

info "Verificando la instalación aplicada"
[[ -x "${BIN_DIR}/VLAWhatsAppHost" ]] || fail "El host nativo no quedó instalado."
[[ -x "${APP_MACOS}/VLAWhatsAppMenu" ]] || fail "La app de barra no quedó instalada."
[[ -d "${EXTENSION_DIR}" ]] || fail "La extensión no quedó instalada."
python3 - "${NATIVE_MANIFEST}" "${EXTENSION_ID}" <<'PY'
import json, pathlib, sys
path, extension_id = sys.argv[1:]
data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
assert data["name"] == "com.villaslosapamates.whatsapp_connector"
assert data["allowed_origins"] == [f"chrome-extension://{extension_id}/"]
assert pathlib.Path(data["path"]).is_file()
print("Manifest Native Messaging válido.")
PY
plutil -lint "${APP_CONTENTS}/Info.plist" >/dev/null
plutil -lint "${LAUNCH_AGENT}" >/dev/null
codesign --verify --strict "${BIN_DIR}/VLAWhatsAppHost"
codesign --verify --deep --strict "${APP_DIR}"
INSTALL_COMMITTED="true"

printf '\nINSTALACIÓN LOCAL COMPLETADA Y VERIFICADA.\n'
printf 'Respaldo reversible creado en:\n%s\n' "${BACKUP_DIR}"
printf '1. Abra chrome://extensions en Google Chrome.\n'
printf '2. Active “Modo de desarrollador”.\n'
printf '3. Pulse “Cargar extensión sin empaquetar”.\n'
printf '4. Seleccione esta carpeta:\n   %s\n' "${EXTENSION_DIR}"
printf '5. Confirme que el ID sea: %s\n' "${EXTENSION_ID}"
printf '6. Abra WhatsApp Web y vincule la sesión si Chrome lo solicita.\n'
printf '\nEl envío real sigue bloqueado por el servidor hasta la certificación final.\n'
open "chrome://extensions" >/dev/null 2>&1 || true
open -R "${EXTENSION_DIR}" >/dev/null 2>&1 || true
