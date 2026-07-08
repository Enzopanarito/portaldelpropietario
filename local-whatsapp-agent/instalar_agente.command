#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "📲 Instalando agente WhatsApp..."
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install pandas openpyxl pywhatkit
if [ ! -f .env ]; then
  cp .env.example .env
  echo "⚠️ Edita .env y coloca ADMIN_PASSWORD."
fi
chmod +x ejecutar_agente.command ejecutar_agente.sh programar_agente_launchd.command 2>/dev/null || true
echo "✅ Listo. Copia aquí Sistema_WhatsApp_Controlado_v4.xlsx y ejecuta ejecutar_agente.command"
read -p "Presiona ENTER para cerrar..."
