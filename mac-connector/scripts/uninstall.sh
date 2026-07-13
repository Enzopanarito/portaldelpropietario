#!/bin/bash
set -Eeuo pipefail
IFS=$'\n\t'

PRODUCT_NAME="VLA WhatsApp Connector"
HOST_NAME="com.villaslosapamates.whatsapp_connector"
SUPPORT_DIR="${HOME}/Library/Application Support/Villas Los Apamates/WhatsApp Connector"
BACKUPS_DIR="${SUPPORT_DIR}/Install Backups"
BACKUP_DIR="${BACKUPS_DIR}/uninstall-$(date +%Y%m%d-%H%M%S)-$$"
BIN_DIR="${SUPPORT_DIR}/bin"
EXTENSION_DIR="${SUPPORT_DIR}/Chrome Extension"
INSTALL_METADATA="${SUPPORT_DIR}/CURRENT_INSTALL.json"
APP_DIR="${HOME}/Applications/${PRODUCT_NAME}.app"
NATIVE_MANIFEST="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts/${HOST_NAME}.json"
LAUNCH_AGENT="${HOME}/Library/LaunchAgents/com.villaslosapamates.whatsapp-menu.plist"
INVENTORY="${BACKUP_DIR}/inventory.tsv"
PURGE_DATA="false"
CONFIRM_PURGE="false"
BACKUP_READY="false"
UNINSTALL_COMMITTED="false"

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
backup_item(){
  local key="$1" source
  source="$(path_for_key "$key")"
  if [[ -e "$source" ]]; then
    printf '%s\t1\n' "$key" >> "${INVENTORY}"
    cp -R "$source" "${BACKUP_DIR}/${key}"
  else
    printf '%s\t0\n' "$key" >> "${INVENTORY}"
  fi
}
restore_backup(){
  local key present destination
  [[ -f "${INVENTORY}" ]] || return 1
  while IFS=$'\t' read -r key present; do
    [[ -n "$key" ]] || continue
    destination="$(path_for_key "$key")"
    rm -rf "$destination"
    if [[ "$present" == "1" ]]; then
      mkdir -p "$(dirname "$destination")"
      cp -R "${BACKUP_DIR}/${key}" "$destination"
    fi
  done < "${INVENTORY}"
  if [[ -f "${LAUNCH_AGENT}" ]]; then
    chmod 600 "${LAUNCH_AGENT}"
    launchctl bootstrap "gui/$(id -u)" "${LAUNCH_AGENT}" >/dev/null 2>&1 || true
  fi
}
on_error(){
  local line="${1:-?}" status=$?
  trap - ERR
  printf 'ERROR: desinstalación interrumpida en la línea %s.\n' "$line" >&2
  if [[ "${BACKUP_READY}" == "true" && "${UNINSTALL_COMMITTED}" != "true" ]]; then
    printf 'Restaurando automáticamente los componentes retirados.\n' >&2
    restore_backup || printf 'ADVERTENCIA: use rollback-latest.sh con %s\n' "${BACKUP_DIR}" >&2
  fi
  exit "$status"
}
trap 'on_error $LINENO' ERR

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge-data) PURGE_DATA="true" ;;
    --confirm-purge) CONFIRM_PURGE="true" ;;
    *) fail "Opción no reconocida: $1" ;;
  esac
  shift
done

[[ "$(uname -s)" == "Darwin" ]] || fail "Este desinstalador solo funciona en macOS."
if [[ "${PURGE_DATA}" == "true" && "${CONFIRM_PURGE}" != "true" ]]; then
  fail "La purga total requiere --purge-data --confirm-purge. Sin confirmación se conservarán identidad, registros y respaldos."
fi

printf 'Creando respaldo previo a la desinstalación:\n%s\n' "${BACKUP_DIR}"
mkdir -p "${BACKUPS_DIR}" "${BACKUP_DIR}"
chmod 700 "${SUPPORT_DIR}" "${BACKUPS_DIR}" "${BACKUP_DIR}"
: > "${INVENTORY}"
for key in host app extension native-manifest launch-agent install-metadata; do backup_item "$key"; done
python3 - "${BACKUP_DIR}/backup.json" "${PURGE_DATA}" <<'PY'
import datetime, json, pathlib, sys
path, purge = sys.argv[1:]
data = {"schemaVersion":"vla-uninstall-backup-v2","createdAt":datetime.datetime.now(datetime.timezone.utc).isoformat(),"purgeRequested":purge == "true"}
pathlib.Path(path).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
PY
BACKUP_READY="true"

launchctl bootout "gui/$(id -u)" "${LAUNCH_AGENT}" >/dev/null 2>&1 || true
rm -f "${LAUNCH_AGENT}" "${NATIVE_MANIFEST}"
rm -rf "${APP_DIR}" "${BIN_DIR}" "${EXTENSION_DIR}"

if [[ "${PURGE_DATA}" == "true" ]]; then
  RESCUE_ARCHIVE="${HOME}/Desktop/VLA-WhatsApp-Connector-rescate-$(date +%Y%m%d-%H%M%S).tar.gz"
  mkdir -p "$(dirname "${RESCUE_ARCHIVE}")"
  tar -czf "${RESCUE_ARCHIVE}" -C "$(dirname "${SUPPORT_DIR}")" "$(basename "${SUPPORT_DIR}")"
  chmod 600 "${RESCUE_ARCHIVE}"
  [[ -s "${RESCUE_ARCHIVE}" ]] || fail "No se pudo crear el archivo de rescate antes de la purga."
  UNINSTALL_COMMITTED="true"
  rm -rf "${SUPPORT_DIR}"
  printf 'Conector y datos locales eliminados. Archivo de rescate conservado en:\n%s\n' "${RESCUE_ARCHIVE}"
else
  UNINSTALL_COMMITTED="true"
  printf 'Conector eliminado. Identidad, registros y respaldos se conservaron en:\n%s\n' "${SUPPORT_DIR}"
  printf 'Respaldo exacto previo a esta desinstalación:\n%s\n' "${BACKUP_DIR}"
  printf 'La purga total exige --purge-data --confirm-purge y crea primero un archivo de rescate externo.\n'
fi
