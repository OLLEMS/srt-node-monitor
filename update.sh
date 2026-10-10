#!/bin/bash
set -e

echo "============================================="
echo "   Atualizador: SRT Playout WebUI            "
echo "============================================="

if [ "$EUID" -ne 0 ]; then
  echo "Por favor, rode como root (sudo ./update.sh ou sudo bash update.sh)"
  exit 1
fi

TARGET_DIR="/opt/srt-playout"

# Se /opt/srt-playout não existir, usa o diretório onde o script está localizado
if [ ! -d "$TARGET_DIR" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -d "$SCRIPT_DIR/playout-server" ]; then
    TARGET_DIR="$SCRIPT_DIR"
  fi
fi

echo "[1/5] Diretório alvo: $TARGET_DIR"
cd "$TARGET_DIR"

echo "[2/5] Baixando atualizações do GitHub (origin/main)..."
# Marca o diretório como seguro para o git sob sudo
git config --global --add safe.directory "$TARGET_DIR" 2>/dev/null || true
git fetch origin main
git pull origin main

echo "[3/5] Atualizando pacotes do Node.js..."
cd "$TARGET_DIR/playout-server"
npm install --production

# Garante configuração HLS estável no MediaMTX
if [ -f "$TARGET_DIR/playout-server/mediamtx/mediamtx.yml" ]; then
  sed -i 's/^hlsVariant: lowLatency/hlsVariant: fmp4/' "$TARGET_DIR/playout-server/mediamtx/mediamtx.yml"
fi

# Assegura que os scripts auxiliares tenham permissão de execução
chmod +x "$TARGET_DIR"/*.sh 2>/dev/null || true

# Garante drivers de GPU adequados para o hardware detectado (Intel, AMD, NVIDIA)
GPU_PCI=$(lspci 2>/dev/null | grep -iE "vga|3d|display" || true)

if echo "$GPU_PCI" | grep -qiE "\b(Intel)\b"; then
    dpkg -l | grep -qE "intel-media-va-driver|iHD_drv_video" || apt-get install -y intel-media-va-driver-non-free 2>/dev/null || apt-get install -y intel-media-va-driver 2>/dev/null || true
fi

if echo "$GPU_PCI" | grep -qiE "\b(AMD|ATI|Radeon)\b"; then
    dpkg -l | grep -qE "mesa-va-drivers|radeonsi_drv_video" || apt-get install -y mesa-va-drivers 2>/dev/null || apt-get install -y va-driver-all 2>/dev/null || true
fi

if echo "$GPU_PCI" | grep -qiE "\b(NVIDIA)\b"; then
    if ! command -v nvidia-smi >/dev/null 2>&1; then
        if command -v ubuntu-drivers >/dev/null 2>&1; then
            ubuntu-drivers install --gpgpu 2>/dev/null || ubuntu-drivers install 2>/dev/null || true
        fi
        apt-get install -y libnvidia-encode-1 2>/dev/null || true
    fi
fi
apt-get install -y vainfo libva2 2>/dev/null || true

echo "[4/5] Reiniciando serviços do sistema..."
systemctl daemon-reload
systemctl restart srt-mediamtx srt-webui 2>/dev/null || true

echo "[5/5] Concluído com sucesso! 🚀"
echo "============================================="
echo " Versão atualizada:"
git log -1 --format=" Commit: %h - %s (%ci)"
echo "============================================="
echo "O servidor foi atualizado e já está em execução."
