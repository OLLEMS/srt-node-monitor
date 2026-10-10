#!/bin/bash
set -e

echo "============================================="
echo "   Desinstalador: SRT Playout WebUI         "
echo "============================================="

if [ "$EUID" -ne 0 ]; then
  echo "Por favor, rode como root (sudo ./uninstall.sh ou sudo bash uninstall.sh)"
  exit 1
fi

INSTALL_DIR="/opt/srt-playout"

echo "[1/4] Parando e desabilitando serviços do sistema..."
systemctl stop srt-webui srt-mediamtx 2>/dev/null || true
systemctl disable srt-webui srt-mediamtx 2>/dev/null || true

# Encerra eventuais processos remanescentes
pkill -f "$INSTALL_DIR" 2>/dev/null || true

echo "[2/4] Removendo arquivos de serviço do Systemd..."
rm -f /etc/systemd/system/srt-webui.service
rm -f /etc/systemd/system/srt-mediamtx.service
systemctl daemon-reload

echo "[3/4] Removendo diretório da aplicação ($INSTALL_DIR)..."
if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
fi

echo "[4/4] Limpeza concluída!"
echo "============================================="
echo " O SRT Playout foi completamente desinstalado."
echo "============================================="
