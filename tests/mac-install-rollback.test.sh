#!/bin/bash
set -Eeuo pipefail
IFS=$'\n\t'

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/vla-rollback-test.XXXXXX")"
trap 'rm -rf "${TEST_ROOT}"' EXIT
export HOME="${TEST_ROOT}/home"
FAKE_BIN="${TEST_ROOT}/bin"
mkdir -p "${HOME}" "${FAKE_BIN}"
cat > "${FAKE_BIN}/launchctl" <<'SH'
#!/bin/bash
exit 0
SH
chmod +x "${FAKE_BIN}/launchctl"
export PATH="${FAKE_BIN}:${PATH}"

SUPPORT="${HOME}/Library/Application Support/Villas Los Apamates/WhatsApp Connector"
BACKUPS="${SUPPORT}/Install Backups"
APP="${HOME}/Applications/VLA WhatsApp Connector.app"
NATIVE="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.villaslosapamates.whatsapp_connector.json"
AGENT="${HOME}/Library/LaunchAgents/com.villaslosapamates.whatsapp-menu.plist"
HOST="${SUPPORT}/bin/VLAWhatsAppHost"
EXTENSION="${SUPPORT}/Chrome Extension"
METADATA="${SUPPORT}/CURRENT_INSTALL.json"
ROLLBACK="${ROOT}/mac-connector/scripts/rollback-latest.sh"

write_current(){
  mkdir -p "$(dirname "${HOST}")" "${APP}/Contents" "${EXTENSION}" "$(dirname "${NATIVE}")" "$(dirname "${AGENT}")"
  printf 'new-host' > "${HOST}"; chmod +x "${HOST}"
  printf 'new-app' > "${APP}/Contents/value.txt"
  printf 'new-extension' > "${EXTENSION}/value.txt"
  printf 'new-native' > "${NATIVE}"
  printf 'new-agent' > "${AGENT}"
  printf 'new-metadata' > "${METADATA}"
}

assert_file_value(){
  local path="$1" expected="$2"
  [[ -f "$path" ]] || { echo "Falta archivo: $path" >&2; exit 1; }
  [[ "$(cat "$path")" == "$expected" ]] || { echo "Valor inesperado en $path" >&2; exit 1; }
}

# Escenario A: existe una instalación anterior y debe restaurarse byte por byte.
BACKUP_A="${BACKUPS}/20260713-rollback-existing"
mkdir -p "${BACKUP_A}/app/Contents" "${BACKUP_A}/extension"
cat > "${BACKUP_A}/inventory.tsv" <<'EOF'
host	1
app	1
extension	1
native-manifest	1
launch-agent	0
install-metadata	1
EOF
printf 'old-host' > "${BACKUP_A}/host"; chmod +x "${BACKUP_A}/host"
printf 'old-app' > "${BACKUP_A}/app/Contents/value.txt"
printf 'old-extension' > "${BACKUP_A}/extension/value.txt"
printf 'old-native' > "${BACKUP_A}/native-manifest"
printf 'old-metadata' > "${BACKUP_A}/install-metadata"
write_current
"${ROLLBACK}" "${BACKUP_A}"
assert_file_value "${HOST}" 'old-host'
assert_file_value "${APP}/Contents/value.txt" 'old-app'
assert_file_value "${EXTENSION}/value.txt" 'old-extension'
assert_file_value "${NATIVE}" 'old-native'
assert_file_value "${METADATA}" 'old-metadata'
[[ ! -e "${AGENT}" ]] || { echo 'El agente ausente en el respaldo no fue eliminado.' >&2; exit 1; }

# Escenario B: antes no existía ningún componente. El rollback debe deshacer la primera instalación.
BACKUP_B="${BACKUPS}/20260713-rollback-first-install"
mkdir -p "${BACKUP_B}"
cat > "${BACKUP_B}/inventory.tsv" <<'EOF'
host	0
app	0
extension	0
native-manifest	0
launch-agent	0
install-metadata	0
EOF
write_current
"${ROLLBACK}" "${BACKUP_B}"
for path in "${HOST}" "${APP}" "${EXTENSION}" "${NATIVE}" "${AGENT}" "${METADATA}"; do
  [[ ! -e "$path" ]] || { echo "El rollback de primera instalación no eliminó: $path" >&2; exit 1; }
done

printf 'MAC_INSTALL_ROLLBACK_TESTS_OK\n'
