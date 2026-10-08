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

# 2. Instalar Node.js 20 e dependências nativas
echo "[1/6] Atualizando repositórios e instalando FFmpeg e Git..."
apt-get update -y
apt-get install -y curl git ffmpeg wget

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

echo "============================================="
echo " Instalação Concluída com Sucesso! 🚀"
echo "============================================="
echo "O servidor já está rodando em segundo plano no Linux."
echo "Acesse no navegador: http://IP_DA_MAQUINA:3000"
echo "Comandos úteis:"
echo "  - Ver logs do Node: sudo journalctl -u srt-webui -f"
echo "  - Ver logs do SRT:  sudo journalctl -u srt-mediamtx -f"
echo "  - Reiniciar tudo:   sudo systemctl restart srt-webui"
