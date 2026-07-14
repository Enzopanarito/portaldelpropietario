#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

PRODUCT_NAME="VLA WhatsApp Connector"
HOST_NAME="com.villaslosapamates.whatsapp_connector"
SUPPORT_DIR="${HOME}/Library/Application Support/Villas Los Apamates/WhatsApp Connector"
BACKUPS_DIR="${SUPPORT_DIR}/Install Backups"
APP_DIR="${HOME}/Applications/${PRODUCT_NAME}.app"
NATIVE_DIR="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
NATIVE_MANIFEST="${NATIVE_DIR}/${HOST_NAME}.json"
LAUNCH_AGENT="${HOME}/Library/LaunchAgents/com.villaslosapamates.whatsapp-menu.plist"

[[ -d "${BACKUPS_DIR}" ]] || { echo "No existen respaldos de instalación." >&2; exit 1; }
LATEST="$(find "${BACKUPS_DIR}" -mindepth 1 -maxdepth 1 -type d -print | sort | tail -1)"
[[ -n "${LATEST}" ]] || { echo "No existe un respaldo utilizable." >&2; exit 1; }

printf 'Restaurando respaldo: %s\n' "${LATEST}"
launchctl bootout "gui/$(id -u)" "${LAUNCH_AGENT}" >/dev/null 2>&1 || true

restore_item() {
  local source="$1" destination="$2"
  if [[ -e "$source" ]]; then
    rm -rf "$destination"
    mkdir -p "$(dirname "$destination")"
    cp -R "$source" "$destination"
  fi
}

restore_item "${LATEST}/VLAWhatsAppHost" "${SUPPORT_DIR}/bin/VLAWhatsAppHost"
restore_item "${LATEST}/${PRODUCT_NAME}.app" "${APP_DIR}"
restore_item "${LATEST}/Chrome Extension" "${SUPPORT_DIR}/Chrome Extension"
restore_item "${LATEST}/${HOST_NAME}.json" "${NATIVE_MANIFEST}"
restore_item "${LATEST}/com.villaslosapamates.whatsapp-menu.plist" "${LAUNCH_AGENT}"

[[ -x "${SUPPORT_DIR}/bin/VLAWhatsAppHost" ]] && chmod 700 "${SUPPORT_DIR}/bin/VLAWhatsAppHost"
[[ -f "${NATIVE_MANIFEST}" ]] && chmod 600 "${NATIVE_MANIFEST}"
[[ -f "${LAUNCH_AGENT}" ]] && {
  chmod 600 "${LAUNCH_AGENT}"
  launchctl bootstrap "gui/$(id -u)" "${LAUNCH_AGENT}" || true
}

printf 'Rollback local finalizado. La identidad y los registros no fueron eliminados.\n'
