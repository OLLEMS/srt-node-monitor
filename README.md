# 📡 SRT Playout Pro & Node Monitor

Servidor profissional de **Ingest, Tratamento de Sinal, Playout e Monitoramento** para transmissões SRT de baixa latência. Projetado com padrões de engenharia de broadcast para estabilidade ininterrupta em redes desafiadoras (como Wi-Fi, 4G e 5G).

O sistema atua como uma **ponte de estabilização**: recebe múltiplos fluxos SRT, aplica correção de jitter, reordenação de pacotes e entrega um sinal de programa com **Genlock Virtual em 1080p a 59.94 FPS CFR**, acelerado por **GPU**.

---

## ⚡ Instalação, Atualização e Desinstalação (Linux)

### 🚀 1. Instalação Automática (One-Liner)
Para instalar o servidor em qualquer máquina Ubuntu/Debian com todos os serviços configurados no **Systemd**:

```bash
curl -sL https://raw.githubusercontent.com/OLLEMS/srt-node-monitor/main/install.sh | sudo bash -
```

O instalador automático:
- Instala Node.js 20 LTS e dependências nativas (`ffmpeg`, `git`, `curl`, `wget`).
- Detecta automaticamente a GPU do sistema (**Intel**, **AMD** ou **NVIDIA**) e instala os drivers e bibliotecas necessários.
- Clona a aplicação para `/opt/srt-playout`.
- Baixa e configura o binário de alto desempenho do **MediaMTX** (RTSP/HLS fMP4).
- Configura e ativa os serviços do sistema (`srt-webui.service` e `srt-mediamtx.service`).
- Inicia o painel na porta `3000`.

---

### 🔄 2. Atualização para Nova Versão
Para atualizar uma instalação existente sem perder suas configurações locais:

```bash
sudo /opt/srt-playout/update.sh
```
*Ou remotamente via curl:*
```bash
curl -sL https://raw.githubusercontent.com/OLLEMS/srt-node-monitor/main/update.sh | sudo bash -
```

---

### 🗑️ 3. Desinstalação Completa (Limpeza)
Para remover completamente o servidor, encerrar processos e deletar serviços do Systemd:

```bash
sudo /opt/srt-playout/uninstall.sh
```
*Ou remotamente via curl:*
```bash
curl -sL https://raw.githubusercontent.com/OLLEMS/srt-node-monitor/main/uninstall.sh | sudo bash -
```

---

## 🌟 Principais Recursos e Arquitetura

### 1. Fallback em 3 Níveis com Auto-Recuperação
- **Prioridade Dinâmica:** Entradas **MAIN (1)**, **SECUNDÁRIO (2)** e **TERCIÁRIO (3)**.
- **Failover Automático:** Se o canal ativo perder dados por mais de 15 segundos, o Watchdog corta imediatamente para o **Slate (SMPTE Color Bars)** ou comuta para o próximo stream íntegro.
- **Recuperação Prioritária:** Assim que o link principal (MAIN) volta a responder, o switcher reassume o sinal no ar instantaneamente, sem travamentos.

### 2. Aceleração Gráfica por Hardware Multi-GPU (Intel, AMD e NVIDIA)
- **Autodetecção Inteligente de Hardware e Drivers:** O script de instalação e o backend detectam a fabricante da GPU no barramento PCI e aplicam a melhor tecnologia de aceleração disponível:
  - **Intel QuickSync / VAAPI (iHD):** Suporte nativo para gráficos integrados e dedicados Intel (Intel HD, UHD, Iris Xe, Intel Arc) via driver `intel-media-va-driver-non-free`.
  - **AMD Radeon / VAAPI (Mesa):** Suporte para GPUs dedicadas Radeon (RX 5000/6000/7000, Vega) e APUs Ryzen via driver `mesa-va-drivers` / Gallium `radeonsi`.
  - **NVIDIA NVENC:** Habilitado para placas dedicadas NVIDIA (GeForce, RTX, Quadro, Tesla) via `h264_nvenc` e drivers proprietários.
  - **CPU Software:** Fallback transparente para `libx264` caso nenhuma GPU compatível esteja presente.
- **Eficiência Extrema:** O processamento com GPU eleva a velocidade de encode para **> 3.0x** com consumo mínimo de CPU, eliminando gargalos de processamento.

### 3. Genlock Virtual e Saída Contínua a 59.94 FPS
- **Sem Perdas Internas:** O transporte interno entre a recepção SRT e o encoder mestre utiliza fluxo por pipes com controle de *backpressure*, eliminando corrupção de pacotes por buffers UDP locais.
- **Taxa Constante (CFR):** Saída padronizada em **1080p a 59.940 FPS** (`60000/1001`), o dobro uniforme de sinais 29.97p, prevenindo *judder* e engasgos de tempo.
- **Ressincronização de Áudio:** Filtro `aresample` dinâmico que mantém áudio e vídeo alinhados mesmo durante comutações repentinas de entrada.

### 4. Console WebUI Profissional (Dark Broadcast)
- **Player com Retorno ao Vivo:** Reprodução HLS estável com fMP4 e controle manual.
- **VU Meter Estéreo Vertical:** Medição em tempo real do áudio (Canais L e R) calibrada em **dB** (de `-60 dB` a `0 dB`) com alertas de saturação em amarelo/vermelho.
- **Telemetria de Transmissão:** Indicadores em tempo real de `STATUS`, `CANAL ATIVO`, `SPEED`, `BITRATE` (formatado dinamicamente em Mbps), `DROP FRAMES` e `DUP FRAMES`.
- **Card de GPU:** Exibe o chip gráfico ativo e o mecanismo de renderização (`VAAPI HW` / `NVENC HW` / `CPU`).
- **Bloqueio de Porta:** Trava automática da porta SRT de saída durante o playout ativo.
- **Controle de Saída HDMI:** Alternância instantânea de saída para monitor de vídeo local via hardware com indicação de status.

---

## 🛠️ Tratamento Técnico do Protocolo SRT

O Node.js trata a conexão SRT antes de passá-la ao FFmpeg com parâmetros calibrados para resiliência:
- `mode=caller`: Garante conexão bidirecional estável.
- `transtype=live`: Força descarte de pacotes irreparáveis sem interromper o fluxo contínuo.
- `latency=500000` (500 ms): Buffer ideal para recuperação por ARQ em conexões de internet e redes móveis.
- `recv_buffer_size=8192000` & `fc=102400`: Janela ampliada de controle de fluxo para absorver picos de taxa de bits sem estouro de buffer do sistema operacional.

---

## 🔧 Comandos de Manutenção do Servidor

Acesse o painel em: **`http://IP_DO_SERVIDOR:3000`**

### Gerenciando os Serviços
```bash
# Reiniciar o servidor
sudo systemctl restart srt-webui

# Parar temporariamente
sudo systemctl stop srt-webui

# Checar status e consumo
sudo systemctl status srt-webui
```

### Acompanhando Logs em Tempo Real
```bash
# Logs do Node.js (trocas de stream, GPU e watchdog)
sudo journalctl -u srt-webui -f

# Logs do MediaMTX (conexões SRT e HLS)
sudo journalctl -u srt-mediamtx -f
```
