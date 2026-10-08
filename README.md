# 📡 SRT Playout Node Monitor

Um servidor robusto de **Ingest, Playout e Monitoramento** de transmissões SRT de baixa latência, projetado para estabilidade extrema em ambientes de broadcast e redes instáveis (como Wi-Fi ou 4G/5G).

Desenvolvido para gerenciar as quedas naturais de conexões sem fio sem derrubar o playout final, utilizando **FFmpeg**, **MediaMTX** e **Node.js**.

---

## 🚀 Instalação Rápida e Profissional (Linux)

A maneira recomendada e mais robusta de instalar este servidor em qualquer máquina Ubuntu/Debian é através do nosso Script de Instalação Universal.

Basta rodar **um único comando** no terminal (requer privilégios de `root`/`sudo`):

```bash
curl -sL https://raw.githubusercontent.com/OLLEMS/srt-node-monitor/main/install.sh | sudo bash -
```

### O que este script faz por trás dos panos?
1. Adiciona o repositório oficial do Node.js (NodeSource) e instala o **Node 20**.
2. Instala dependências vitais de sistema (`ffmpeg`, `git`, `curl`, `wget`).
3. Clona este repositório para o diretório padrão de servidores: `/opt/srt-playout`.
4. Baixa e descompacta o binário do **MediaMTX** (motor de conversão de vídeo RTSP/HLS de altíssimo desempenho).
5. Instala os pacotes necessários (`npm install`).
6. Configura a inicialização automática, criando dois serviços ("daemons") no **Systemd**.
7. Inicia automaticamente a WebUI na porta `3000`.

---

## 🛠️ Como Funciona e Tratamento do Protocolo SRT

O grande diferencial deste projeto é como ele lida com o protocolo SRT para garantir que o seu Playout final não saia do ar devido a oscilações normais da rede.

### 1. Injeção Automática de Parâmetros de Sobrevivência
Quando você cola um link SRT simples (ex: `srt://192.168.1.100:25000`) na interface, o Node.js **intercepta** e turbina essa URL automaticamente antes de enviar para o FFmpeg. 
Ele adiciona:
- `?mode=caller`: Define quem inicia a conexão.
- `&transtype=live`: O FFmpeg, por padrão, trata conexões SRT como transferência de arquivos. Se houver 1 único pacote perdido na rede Wi-Fi, ele aborta a conexão para não "corromper" o arquivo. A injeção de `live` diz ao FFmpeg para ignorar buracos e continuar tocando!
- `&latency=1000000`: Cria um buffer massivo de 1 segundo (1000ms) no receptor para reordenar pacotes perdidos em redes sem fio muito ruins, absorvendo os "soluços" (jitters).

### 2. Watchdog Inteligente (Anti-Zumbi)
As conexões SRT, quando perdem o sinal abruptamente (ex: se o computador que está enviando for desligado puxando a tomada), podem fazer com que o FFmpeg fique "congelado" esperando um pacote que nunca virá.
O nosso Node.js implementa um **Watchdog**: ele lê a saída padrão do FFmpeg milhares de vezes por minuto. Se o FFmpeg parar de reportar progresso por mais de `15 segundos`, o Node.js "assassina" brutalmente (SIGKILL) o processo zumbi e zera o estado, liberando o sistema para uma nova conexão limpa.

### 3. Recuperação Anti-Cache do Player (HLS.js)
Se o player de vídeo da WebUI tenta puxar o sinal antes do backend estar completamente pronto, o navegador (Chrome/Edge) pode guardar em cache um "Erro 404 (Não Encontrado)" e deixar a tela preta para sempre.
Nós contornamos isso utilizando um mecanismo de cache-busting dinâmico no Javascript (`?t=timestamp`), o que força o player a destruir a si mesmo e renascer das cinzas tentando buscar a imagem verdadeira no servidor a cada 2 segundos até o sinal SRT se estabelecer com sucesso.

### 4. Proteção contra Deadlocks (`tee` Muxer e UDP)
O FFmpeg usa o muxer `tee` para dividir o sinal simultaneamente para o monitoramento (RTSP) e para a porta local de Playout. Se a porta de playout estivesse aguardando um handshake SRT, o FFmpeg congelaria a tela inteira de monitoramento. Para blindar isso, enviamos o sinal interno de saída como `udp://127.0.0.1:9100`. Como o UDP é do tipo "fire and forget" (atira e esquece), ele nunca trava o FFmpeg mesmo se não houver ninguém ouvindo a porta.

---

## 🔧 Comandos Úteis de Manutenção

Após a instalação automática, o sistema roda silenciosamente em segundo plano, protegido pelo Kernel do Linux.

Acesse o painel em: **`http://IP_DA_SUA_MAQUINA:3000`**

### Gerenciando a Aplicação
- **Reiniciar o servidor inteiro:**
  `sudo systemctl restart srt-webui`
- **Parar a aplicação temporariamente:**
  `sudo systemctl stop srt-webui`

### Acompanhando os Logs Profissionais
- **Ver logs gerais do Node.js (erros, alertas e prints do watchdog):**
  `sudo journalctl -u srt-webui -f`
- **Ver logs detalhados do MediaMTX:**
  `sudo journalctl -u srt-mediamtx -f`

*(Para sair da tela de logs, pressione `CTRL+C`).*
