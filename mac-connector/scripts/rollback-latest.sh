#!/bin/bash
set -Eeuo pipefail
IFS=$'\n\t'

PRODUCT_NAME="VLA WhatsApp Connector"
HOST_NAME="com.villaslosapamates.whatsapp_connector"
SUPPORT_DIR="${HOME}/Library/Application Support/Villas Los Apamates/WhatsApp Connector"
BACKUPS_DIR="${SUPPORT_DIR}/Install Backups"
BIN_DIR="${SUPPORT_DIR}/bin"
EXTENSION_DIR="${SUPPORT_DIR}/Chrome Extension"
INSTALL_METADATA="${SUPPORT_DIR}/CURRENT_INSTALL.json"
APP_DIR="${HOME}/Applications/${PRODUCT_NAME}.app"
NATIVE_MANIFEST="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json"
LAUNCH_AGENT="${HOME}/Library/LaunchAgents/com.villaslosapamates.whatsapp-menu.plist"

fail(){ printf 'ERROR: %s\n' "$1" >&2; exit 1; }
path_for_key(){
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

[[ "$(uname -s)" == "Darwin" ]] || fail "Este rollback solo funciona en macOS."
[[ -d "${BACKUPS_DIR}" ]] || fail "No existen respaldos de instalación."
LATEST="${1:-}"
if [[ -z "${LATEST}" ]]; then
  LATEST="$(find "${BACKUPS_DIR}" -mindepth 1 -maxdepth 1 -type d -print | sort | tail -1)"
fi
[[ -n "${LATEST}" && -d "${LATEST}" ]] || fail "No existe un respaldo utilizable."
case "${LATEST}" in "${BACKUPS_DIR}"/*) ;; *) fail "El respaldo debe estar dentro de ${BACKUPS_DIR}." ;; esac
[[ -f "${LATEST}/inventory.tsv" ]] || fail "El respaldo no contiene inventario transaccional."

printf 'Restaurando exactamente el respaldo:\n%s\n' "${LATEST}"
launchctl bootout "gui/$(id -u)" "${LAUNCH_AGENT}" >/dev/null 2>&1 || true

while IFS=$'\t' read -r key present; do
  [[ -n "$key" ]] || continue
  destination="$(path_for_key "$key")" || fail "Clave desconocida en inventario: $key"
  rm -rf "$destination"
  if [[ "$present" == "1" ]]; then
    [[ -e "${LATEST}/${key}" ]] || fail "Falta el elemento respaldado: ${key}"
    mkdir -p "$(dirname "$destination")"
    cp -R "${LATEST}/${key}" "$destination"
  elif [[ "$present" != "0" ]]; then
    fail "Indicador de presencia inválido para ${key}."
  fi
done < "${LATEST}/inventory.tsv"

[[ -x "${BIN_DIR}/VLAWhatsAppHost" ]] && chmod 700 "${BIN_DIR}/VLAWhatsAppHost"
[[ -d "${EXTENSION_DIR}" ]] && {
  find "${EXTENSION_DIR}" -type d -exec chmod 700 {} \;
  find "${EXTENSION_DIR}" -type f -exec chmod 600 {} \;
}
[[ -f "${NATIVE_MANIFEST}" ]] && chmod 600 "${NATIVE_MANIFEST}"
[[ -f "${INSTALL_METADATA}" ]] && chmod 600 "${INSTALL_METADATA}"
if [[ -f "${LAUNCH_AGENT}" ]]; then
  chmod 600 "${LAUNCH_AGENT}"
  launchctl bootstrap "gui/$(id -u)" "${LAUNCH_AGENT}" || fail "Los archivos se restauraron, pero no se pudo iniciar el agente anterior."
fi

printf 'Rollback local verificado. Los componentes ausentes en el respaldo fueron eliminados y los existentes fueron restaurados.\n'
printf 'La identidad, los registros y el propio respaldo permanecen intactos.\n'
