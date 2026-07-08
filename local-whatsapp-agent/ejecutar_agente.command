#!/bin/bash
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "Ejecuta primero instalar_agente.command"
  read -p "Presiona ENTER para cerrar..."
  exit 1
fi
source .venv/bin/activate
python3 whatsapp_agent.py
