#!/bin/bash
set -e

echo "============================================="
echo "   Instalador Automático: SRT Playout WebUI  "
echo "============================================="

# 1. Verificar privilégios de root
if [ "$EUID" -ne 0 ]; then 
  echo "Por favor, rode como root (sudo ./install.sh ou sudo bash install.sh)"
  exit 1
fi

# 2. Instalar dependências básicas
echo "[1/6] Atualizando repositórios e instalando dependências base..."
apt-get update -y
apt-get install -y curl git ffmpeg wget vainfo libva2

# Detecção inteligente de GPU (Intel, AMD, NVIDIA) e instalação dos drivers correspondentes
echo "--------------------------------------------------------"
echo " Identificando GPU do sistema e instalando drivers..."
echo "--------------------------------------------------------"
GPU_PCI=$(lspci 2>/dev/null | grep -iE "vga|3d|display" || true)
echo "Hardware gráfico detectado:"
echo "$GPU_PCI"

# A) INTEL (HD Graphics / UHD / Iris Xe / Arc)
if echo "$GPU_PCI" | grep -qiE "\b(Intel)\b"; then
    echo "-> GPU Intel detectada!"
    if dpkg -l | grep -qE "intel-media-va-driver|iHD_drv_video"; then
        echo "   Driver Intel VAAPI (iHD) já instalado."
    else
        echo "   Instalando driver Intel VAAPI de alta performance..."
        apt-get install -y intel-media-va-driver-non-free 2>/dev/null || apt-get install -y intel-media-va-driver 2>/dev/null || true
    fi
fi

# B) AMD / RADEON (RX, Vega, RDNA, APU)
if echo "$GPU_PCI" | grep -qiE "\b(AMD|ATI|Radeon)\b"; then
    echo "-> GPU AMD / Radeon detectada!"
    if dpkg -l | grep -qE "mesa-va-drivers|radeonsi_drv_video"; then
        echo "   Driver AMD VAAPI (Mesa) já instalado."
    else
        echo "   Instalando driver AMD VAAPI (Mesa)..."
        apt-get install -y mesa-va-drivers 2>/dev/null || apt-get install -y va-driver-all 2>/dev/null || true
    fi
fi

# C) NVIDIA (GeForce, Quadro, Tesla, RTX)
if echo "$GPU_PCI" | grep -qiE "\b(NVIDIA)\b"; then
    echo "-> GPU NVIDIA detectada!"
    if command -v nvidia-smi >/dev/null 2>&1; then
        echo "   Driver NVIDIA já instalado e operacional."
    else
        echo "   Driver NVIDIA ausente. Instalando via ubuntu-drivers..."
        if command -v ubuntu-drivers >/dev/null 2>&1; then
            ubuntu-drivers install --gpgpu 2>/dev/null || ubuntu-drivers install 2>/dev/null || true
        fi
        apt-get install -y libnvidia-encode-1 2>/dev/null || true
    fi
fi
echo "--------------------------------------------------------"

echo "[2/6] Instalando Node.js (Repositório Oficial NodeSource)..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 3. Preparar o diretório
INSTALL_DIR="/opt/srt-playout"
echo "[3/6] Baixando a aplicação para $INSTALL_DIR..."
if [ -d "$INSTALL_DIR" ]; then
    echo "Diretório já existe, atualizando o código..."
    cd $INSTALL_DIR
    git pull origin main
else
    git clone https://github.com/OLLEMS/srt-node-monitor.git $INSTALL_DIR
    cd $INSTALL_DIR
fi

# 4. Baixar MediaMTX (pois não subimos pro git por ser um binário)
echo "[4/6] Baixando servidor MediaMTX..."
mkdir -p $INSTALL_DIR/playout-server/mediamtx
cd $INSTALL_DIR/playout-server/mediamtx
MEDIAMTX_VERSION="1.9.3"
wget -qO mediamtx.tar.gz "https://github.com/bluenviron/mediamtx/releases/download/v${MEDIAMTX_VERSION}/mediamtx_v${MEDIAMTX_VERSION}_linux_amd64.tar.gz"
tar -xzf mediamtx.tar.gz mediamtx mediamtx.yml
rm mediamtx.tar.gz
chmod +x mediamtx
# HLS padrão (fMP4, segmentos de 1s) em vez de Low-Latency: buffer estável no navegador, sem engasgos
sed -i 's/^hlsVariant: lowLatency/hlsVariant: fmp4/' mediamtx.yml

# 5. Instalar pacotes NPM
echo "[5/6] Instalando pacotes do Node.js..."
cd $INSTALL_DIR/playout-server
npm install --production

# 6. Criar e habilitar serviços Systemd do SISTEMA (robusto)
echo "[6/6] Configurando serviços (Daemons) de inicialização (Systemd)..."

cat << 'SYS1' > /etc/systemd/system/srt-mediamtx.service
[Unit]
Description=SRT Playout - MediaMTX
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/srt-playout/playout-server/mediamtx
ExecStart=/opt/srt-playout/playout-server/mediamtx/mediamtx
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
SYS1

cat << 'SYS2' > /etc/systemd/system/srt-webui.service
[Unit]
Description=SRT Playout - Node WebUI
After=network.target srt-mediamtx.service
Requires=srt-mediamtx.service

[Service]
Type=simple
WorkingDirectory=/opt/srt-playout/playout-server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
SYS2

systemctl daemon-reload
systemctl enable srt-mediamtx srt-webui
systemctl restart srt-mediamtx srt-webui

chmod +x $INSTALL_DIR/*.sh 2>/dev/null || true

echo "============================================="
echo " Instalação Concluída com Sucesso! 🚀"
echo "============================================="
echo "O servidor já está rodando em segundo plano no Linux."
echo "Acesse no navegador: http://IP_DA_MAQUINA:3000"
echo "Comandos úteis:"
echo "  - Ver logs do Node: sudo journalctl -u srt-webui -f"
echo "  - Ver logs do SRT:  sudo journalctl -u srt-mediamtx -f"
echo "  - Reiniciar tudo:   sudo systemctl restart srt-webui"
echo "  - Atualizar versão: sudo /opt/srt-playout/update.sh"
echo "  - Desinstalar tudo: sudo /opt/srt-playout/uninstall.sh"
