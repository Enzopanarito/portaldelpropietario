#!/bin/bash
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "Ejecuta primero instalar_agente.command"
  exit 1
fi
source .venv/bin/activate
python3 whatsapp_agent.py
