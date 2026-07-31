#!/bin/bash
set -euo pipefail
IFS=$'\n\t'

PRODUCT_NAME="VLA WhatsApp Connector"
HOST_NAME="com.villaslosapamates.whatsapp_connector"
SUPPORT_DIR="${HOME}/Library/Application Support/Villas Los Apamates/WhatsApp Connector"
APP_DIR="${HOME}/Applications/${PRODUCT_NAME}.app"
NATIVE_MANIFEST="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json"
LAUNCH_AGENT="${HOME}/Library/LaunchAgents/com.villaslosapamates.whatsapp-menu.plist"
PURGE_DATA="false"

if [[ "${1:-}" == "--purge-data" ]]; then PURGE_DATA="true"; fi

launchctl bootout "gui/$(id -u)" "${LAUNCH_AGENT}" >/dev/null 2>&1 || true
rm -f "${LAUNCH_AGENT}" "${NATIVE_MANIFEST}"
rm -rf "${APP_DIR}"
rm -rf "${SUPPORT_DIR}/bin" "${SUPPORT_DIR}/Chrome Extension"

if [[ "${PURGE_DATA}" == "true" ]]; then
  rm -rf "${SUPPORT_DIR}"
  printf 'Conector y datos locales eliminados.\n'
else
  printf 'Conector eliminado. La identidad, los registros y los respaldos locales se conservaron en:\n%s\n' "${SUPPORT_DIR}"
  printf 'Use --purge-data solamente si desea borrar también esos datos.\n'
fi
