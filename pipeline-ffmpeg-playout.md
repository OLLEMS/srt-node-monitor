# Pipeline Node.js + FFmpeg com tratamento de perdas, travamentos e "genlock" por software

Guia passo a passo para montar manualmente o fluxo do seu diagrama:

```
FONTE ──► [ server Node.js + FFmpeg (tratamento) ] ──► PLAYOUT
                     │
                     └──► interface WebUI (controle + preview já tratado)
```

---

## 1. É possível? Resposta honesta

**Sim, com ressalvas importantes.** Veja o que dá e o que não dá:

| Objetivo | Possível? | Como |
|---|---|---|
| Não entregar o FFmpeg "cru" na WebUI | ✅ Sim | O FFmpeg roda **só no servidor**; a WebUI recebe um preview já tratado (HLS) + status via WebSocket |
| Corrigir **perda de pacotes** | ✅ Sim, **se o transporte permitir** | Use **SRT** (retransmissão ARQ) ou RIST. Em UDP puro, pacote perdido **não volta** (só FEC ajuda parcialmente) |
| Corrigir **travamentos** | ✅ Parcialmente | Watchdog (detecta e reinicia), `freezedetect`, buffer e **fallback** (slate/bars) quando a fonte cai |
| **Genlock** | ⚠️ Só emulado | Genlock de verdade é **hardware** (black burst / tri-level sync). Por software você faz **re-clock**: força frame rate constante (CFR) e áudio contínuo, descartando/duplicando quadros |
| Zero interrupção quando a fonte cai | ⚠️ Depende | Com um único FFmpeg há um "buraco" no reinício. Para saída contínua use a arquitetura em 2 estágios (seção 9) |

> **Regra de ouro:** o buffer é o que compra estabilidade. Quanto maior o buffer (latência), mais perdas você consegue corrigir. Você troca **latência por robustez**.

---

## 2. Informações que você precisa definir antes

Responda isto antes de começar (muda alguns comandos):

1. **Qual é a fonte?** (SRT, RTMP, UDP MPEG-TS, RTSP de câmera, NDI, placa de captura SDI/HDMI?)
2. **Qual é o formato de entrada esperado pelo PLAYOUT?** (SRT, UDP MPEG-TS, NDI, RTMP, SDI via placa?)
3. **Frame rate do seu padrão:** `25`, `30000/1001` (29.97), `50`, `60000/1001`...
4. **Resolução:** 1920x1080? 1280x720?
5. **Latência máxima aceitável** (ex.: 2 s, 5 s?).
6. **A rede entre fonte e servidor é instável?** (internet/4G = precisa de SRT com buffer grande; LAN = mais simples.)

Neste guia assumo: **fonte via SRT**, **1080p 29.97 fps**, **playout recebe SRT/MPEG-TS**. Adapte conforme suas respostas.

---

## 3. Requisitos

### Hardware (servidor de tratamento)
- CPU: mínimo 4 núcleos modernos para 1 stream 1080p com x264 `veryfast`. (Se tiver GPU NVIDIA, dá para usar `h264_nvenc`.)
- RAM: 4 GB+.
- Rede: cabo (evite Wi-Fi), banda ≥ 2× o bitrate do stream.

### Software
- **Linux** (Ubuntu 22.04/24.04 recomendado). Windows funciona, mas os comandos de teste de rede mudam.
- **FFmpeg ≥ 6.0 compilado com `--enable-libsrt` e `--enable-libx264`**
- **Node.js ≥ 20 LTS**
- **MediaMTX** (servidor de mídia leve, para o preview HLS da WebUI)
- Opcional: `iproute2` (`tc netem`) para simular perda de pacotes nos testes

### Portas (ajuste no firewall)
| Porta | Protocolo | Uso |
|---|---|---|
| 9000 | UDP | Entrada SRT (fonte → servidor) |
| 3000 | TCP | Servidor Node.js (WebUI + WebSocket) |
| 8554 | TCP | MediaMTX recebe publicação RTSP (interno/localhost) |
| 8888 | TCP | MediaMTX serve HLS (preview) |
| 9100 | UDP | Saída SRT para o playout (se o playout for listener) |

---

## 4. Passo 1 — Instalar e validar o FFmpeg

```bash
sudo apt update
sudo apt install -y ffmpeg
ffmpeg -version
```

Verifique se SRT e x264 existem:

```bash
ffmpeg -hide_banner -protocols | grep -i srt      # deve listar srt
ffmpeg -hide_banner -encoders  | grep -i libx264  # deve listar libx264
```

Se `srt` **não** aparecer, o FFmpeg do apt não tem suporte. Opções: usar um build estático recente (johnvansickle.com/ffmpeg) ou compilar com `--enable-libsrt`.

> **Importante:** a unidade do parâmetro `latency` do SRT **varia entre versões do FFmpeg** (ms ou µs). Confira com:
> ```bash
> ffmpeg -hide_banner -h protocol=srt
> ```
> e teste um valor pequeno primeiro.

---

## 5. Passo 2 — Instalar o MediaMTX (preview para a WebUI)

O navegador **não toca** SRT/MPEG-TS direto. O MediaMTX recebe o stream já tratado e entrega **HLS** para a WebUI.

```bash
mkdir -p ~/mediamtx && cd ~/mediamtx
# Baixe a release linux_amd64 mais recente em:
# https://github.com/bluenviron/mediamtx/releases
tar xzf mediamtx_*_linux_amd64.tar.gz
./mediamtx
```

Com a config padrão ele já aceita publicação RTSP em `rtsp://127.0.0.1:8554/live` e serve HLS em `http://IP:8888/live/index.m3u8`.

> **Nota:** WebRTC no navegador exige áudio **Opus** (o AAC não toca). Por isso o preview aqui é **HLS** (latência típica 2–6 s). Para preview mais rápido você pode ativar LL-HLS no MediaMTX.

---

## 6. Passo 3 — Entender o comando FFmpeg de tratamento

Este é o coração do sistema. Teste **primeiro no terminal**, antes de colocar no Node.

```bash
ffmpeg -hide_banner -nostats \
  -fflags +genpts+discardcorrupt \
  -analyzeduration 2000000 -probesize 5000000 \
  -i "srt://0.0.0.0:9000?mode=listener&latency=2000000" \
  -vf "fps=30000/1001,freezedetect=n=-60dB:d=3,blackdetect=d=3:pic_th=0.98" \
  -af "aresample=async=1000:first_pts=0" \
  -fps_mode cfr \
  -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p \
  -b:v 6M -maxrate 6M -bufsize 12M \
  -g 60 -keyint_min 60 -sc_threshold 0 \
  -c:a aac -b:a 192k -ar 48000 -ac 2 \
  -map 0:v:0 -map 0:a:0 \
  -f tee "[f=mpegts:onfail=ignore]srt://IP_DO_PLAYOUT:9100?mode=caller|[f=rtsp:rtsp_transport=tcp:onfail=ignore]rtsp://127.0.0.1:8554/live"
```

### O que cada parte faz

| Trecho | Função |
|---|---|
| `-fflags +genpts+discardcorrupt` | Regenera timestamps ausentes e descarta pacotes corrompidos em vez de travar |
| `srt://...?mode=listener&latency=...` | Recebe SRT. O `latency` é o **buffer de retransmissão**: é ele que recupera pacotes perdidos. Regra prática: **3 a 4× o RTT** da rede |
| `fps=30000/1001` + `-fps_mode cfr` | **"Genlock" por software**: força saída com frame rate **constante**, duplicando/descartando quadros conforme necessário |
| `aresample=async=1000` | Mantém o áudio contínuo e em sincronia, preenchendo/cortando amostras quando há lacunas |
| `freezedetect` / `blackdetect` | Escrevem no log quando a imagem congela ou fica preta (o Node usa isso) |
| `-g 60 -keyint_min 60 -sc_threshold 0` | GOP fixo de 2 s (a 30 fps). Ajuda o playout e o HLS |
| `-maxrate` / `-bufsize` | Bitrate controlado (VBV), importante para transporte estável |
| `-f tee` | Uma única codificação enviada para **duas saídas**: playout (SRT) e preview (MediaMTX) |
| `onfail=ignore` | Se uma saída cair, a outra continua |

> Se sua fonte **não tem áudio**, remova `-map 0:a:0` e as opções de áudio, ou gere áudio silencioso com `-f lavfi -i anullsrc`.

### Como testar sem o playout real
Troque a primeira saída do `tee` por um arquivo/UDP local e abra o preview em `http://IP:8888/live/`. Para enviar uma fonte de teste:

```bash
ffmpeg -re -f lavfi -i testsrc2=size=1920x1080:rate=30000/1001 \
       -f lavfi -i sine=frequency=1000:sample_rate=48000 \
       -c:v libx264 -preset veryfast -c:a aac \
       -f mpegts "srt://IP_DO_SERVIDOR:9000?mode=caller&latency=2000000"
```

---

## 7. Passo 4 — Servidor Node.js (supervisor + watchdog)

O Node **não processa vídeo**. Ele:
1. inicia e supervisiona o processo FFmpeg;
2. detecta travamento (sem progresso) e reinicia;
3. interpreta eventos (freeze, black);
4. envia status em tempo real para a WebUI via WebSocket;
5. serve a WebUI.

### 7.1 Criar o projeto

```bash
mkdir playout-server && cd playout-server
npm init -y
npm install express ws
mkdir public
```

No `package.json`, adicione `"type": "module"`.

### 7.2 `server.js`

```js
import { spawn } from 'node:child_process';
import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';

// ---------- CONFIGURAÇÃO ----------
const CFG = {
  port: 3000,
  input: 'srt://0.0.0.0:9000?mode=listener&latency=2000000',
  playoutOut: 'srt://IP_DO_PLAYOUT:9100?mode=caller',
  previewOut: 'rtsp://127.0.0.1:8554/live',
  fps: '30000/1001',
  videoBitrate: '6M',
  stallTimeoutMs: 6000,   // sem progresso por X ms = travado
  backoffMinMs: 1000,
  backoffMaxMs: 15000,
};

// ---------- ESTADO ----------
const state = {
  status: 'stopped',      // stopped | starting | running | stalled | restarting
  restarts: 0,
  lastProgress: 0,
  freeze: false,
  black: false,
  speed: null,
  startedAt: null,
};

let ff = null;
let backoff = CFG.backoffMinMs;
let wantRunning = false;

let dynamicInput = CFG.input;

// ---------- WEB + WEBSOCKET ----------
const app = express();
app.use(express.static('public'));
app.use(express.json());

app.post('/api/start', (req, res) => {
  let changed = false;
  if (req.body && req.body.inputUrl && req.body.inputUrl !== dynamicInput) {
    dynamicInput = req.body.inputUrl;
    changed = true;
  }
  if (changed && ff) { stop(); setTimeout(start, 500); }
  else { start(); }
  res.json({ ok: true });
});

app.post('/api/stop',  (_, res) => { stop();  res.json({ ok: true }); });
app.get('/api/status', (_, res) => res.json(state));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast() {
  const msg = JSON.stringify(state);
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}
setInterval(broadcast, 1000);

// ---------- FFMPEG ----------
function buildArgs() {
  const tee =
    `[f=mpegts:onfail=ignore]${CFG.playoutOut}|` +
    `[f=rtsp:rtsp_transport=tcp:onfail=ignore]${CFG.previewOut}`;

  return [
    '-hide_banner', '-nostats',
    '-progress', 'pipe:1',
    '-fflags', '+genpts+discardcorrupt',
    '-analyzeduration', '2000000', '-probesize', '5000000',
    '-i', dynamicInput,
    '-vf', `fps=${CFG.fps},freezedetect=n=-60dB:d=3,blackdetect=d=3:pic_th=0.98`,
    '-af', 'aresample=async=1000:first_pts=0',
    '-fps_mode', 'cfr',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p',
    '-b:v', CFG.videoBitrate, '-maxrate', CFG.videoBitrate, '-bufsize', '12M',
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-map', '0:v:0', '-map', '0:a:0',
    '-f', 'tee', tee,
  ];
}

function start() {
  if (ff) return;
  wantRunning = true;
  state.status = 'starting';
  state.freeze = false;
  state.black = false;
  state.lastProgress = Date.now();
  state.startedAt = Date.now();

  ff = spawn('ffmpeg', buildArgs(), { stdio: ['ignore', 'pipe', 'pipe'] });

  // stdout: -progress (chave=valor)
  let buf = '';
  ff.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const [k, v] = line.trim().split('=');
      if (k === 'out_time_us' && v !== 'N/A') {
        state.lastProgress = Date.now();
        if (state.status !== 'running') { state.status = 'running'; backoff = CFG.backoffMinMs; }
      }
      if (k === 'speed') state.speed = v;
    }
  });

  // stderr: logs (freeze/black/erros)
  ff.stderr.on('data', (d) => {
    const s = d.toString();
    if (s.includes('freeze_start')) state.freeze = true;
    if (s.includes('freeze_end'))   state.freeze = false;
    if (s.includes('black_start'))  state.black = true;
    if (s.includes('black_end'))    state.black = false;
    // Descomente para depurar:
    // process.stderr.write(s);
  });

  ff.on('exit', (code, sig) => {
    console.log(`[ffmpeg] saiu code=${code} sig=${sig}`);
    ff = null;
    if (!wantRunning) { state.status = 'stopped'; return; }
    state.status = 'restarting';
    state.restarts++;
    setTimeout(start, backoff);
    backoff = Math.min(backoff * 2, CFG.backoffMaxMs);
  });
}

function stop() {
  wantRunning = false;
  if (ff) ff.kill('SIGTERM');
  else state.status = 'stopped';
}

// ---------- WATCHDOG ----------
setInterval(() => {
  if (!ff) return;
  const idle = Date.now() - state.lastProgress;
  if (idle > CFG.stallTimeoutMs) {
    console.log(`[watchdog] sem progresso há ${idle}ms — matando ffmpeg`);
    state.status = 'stalled';
    ff.kill('SIGKILL');
  }
}, 1000);

server.listen(CFG.port, () => console.log(`WebUI em http://localhost:${CFG.port}`));
start();
```

> **Ponto de atenção:** ao ficar em modo `listener`, o FFmpeg **espera** a fonte conectar. Nesse período não há "progresso", e o watchdog poderia matá-lo à toa. Se isso incomodar, aumente `stallTimeoutMs` ou só ative o watchdog depois do primeiro `running` (basta checar `state.status === 'running'` no `setInterval`).

---

## 8. Passo 5 — WebUI

### 8.1 `public/index.html`

```html
<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <title>Playout — Controle</title>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
  <style>
    body { font-family: system-ui; background:#111; color:#eee; margin:20px }
    video { width:640px; background:#000; display:block; margin-bottom:12px }
    .ok { color:#4ade80 } .bad { color:#f87171 } .warn { color:#facc15 }
    button { padding:8px 14px; margin-right:6px }
  </style>
</head>
<body>
  <h2>Preview (já tratado)</h2>
  <video id="v" controls muted autoplay></video>

  <h2>Configuração de Entrada</h2>
  <div style="margin-bottom: 15px;">
    <input type="text" id="srtUrl" placeholder="srt://0.0.0.0:9000?mode=listener&latency=2000000" style="width: 400px; padding: 8px;" value="srt://0.0.0.0:9000?mode=listener&latency=2000000" />
    <span id="urlError" class="bad" style="display:none; margin-left:10px;">URL SRT inválida! (ex: srt://ip:porta?mode=...)</span>
  </div>

  <h2>Status</h2>
  <pre id="st">conectando...</pre>

  <button onclick="startStream()">Iniciar</button>
  <button onclick="fetch('/api/stop',{method:'POST'})">Parar</button>

  <script>
    function startStream() {
      const urlInput = document.getElementById('srtUrl').value.trim();
      const errorSpan = document.getElementById('urlError');
      
      const srtRegex = /^srt:\/\/[a-zA-Z0-9.-]+:\d+(\?.*)?$/;
      if (!srtRegex.test(urlInput)) {
        errorSpan.style.display = 'inline';
        return;
      }
      errorSpan.style.display = 'none';

      fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputUrl: urlInput })
      });
    }

    // Preview HLS vindo do MediaMTX (troque pelo IP do servidor)
    const src = `http://${location.hostname}:8888/live/index.m3u8`;
    const v = document.getElementById('v');
    if (Hls.isSupported()) { const h = new Hls({ lowLatencyMode:true }); h.loadSource(src); h.attachMedia(v); }
    else v.src = src;

    // Status em tempo real
    const ws = new WebSocket(`ws://${location.host}`);
    ws.onmessage = (e) => {
      const s = JSON.parse(e.data);
      document.getElementById('st').textContent =
        `status:   ${s.status}\n` +
        `reinícios:${s.restarts}\n` +
        `speed:    ${s.speed}\n` +
        `freeze:   ${s.freeze}\n` +
        `black:    ${s.black}`;
    };
  </script>
</body>
</html>
```

> O preview HLS depende do MediaMTX **estar rodando** e do FFmpeg já estar publicando nele.

---

## 9. Passo 6 — Evolução: 2 estágios + fallback (saída sempre no ar)

O problema do modelo acima: quando o FFmpeg reinicia, o playout fica sem sinal por alguns segundos. Para evitar isso, separe em dois processos:

```
FONTE ─► [Estágio 1: ingest + tratamento] ─► UDP interno (127.0.0.1:10000)
                                                       │
                          [Estágio 2: saída contínua] ◄┘  (lê o UDP interno;
                                  │                        se não chega nada, mostra SLATE)
                                  ├─► PLAYOUT (SRT)
                                  └─► MediaMTX (preview)
```

- **Estágio 1** pode cair/reiniciar à vontade (é o que o watchdog mata).
- **Estágio 2** nunca reinicia; se a entrada interna sumir, ele precisa continuar emitindo algo.

Uma forma simples de fazer o fallback é o **Node alternar a fonte do Estágio 2** entre o feed tratado e um slate gerado pelo próprio FFmpeg:

```bash
# SLATE (barras + tom) — exemplo de fonte de fallback
ffmpeg -re \
  -f lavfi -i "smptebars=size=1920x1080:rate=30000/1001" \
  -f lavfi -i "sine=frequency=1000:sample_rate=48000" \
  -c:v libx264 -preset veryfast -c:a aac \
  -f mpegts "udp://127.0.0.1:10000?pkt_size=1316"
```

Estratégia sugerida (implementação em fases):

1. **Fase A:** só o modelo da seção 7 (já resolve 90% dos casos de rede ruim).
2. **Fase B:** adicionar o Estágio 2 lendo `udp://127.0.0.1:10000?fifo_size=5000000&overrun_nonfatal=1` e publicando nas saídas.
3. **Fase C:** Node inicia o processo de slate no mesmo UDP interno quando o Estágio 1 cai, e o encerra quando ele volta.

> Cuidado: a troca entre fontes gera **descontinuidade de timestamps** no MPEG-TS. Mantenha `-fflags +genpts` no Estágio 2 e teste bem; o playout precisa tolerar a descontinuidade. Se for crítico, considere um switcher dedicado em vez de resolver só com FFmpeg.

---

## 10. Passo 7 — Testes (não pule!)

### 10.1 Simular perda de pacotes (Linux)
Na máquina que **envia** a fonte (ou no servidor, na interface correta):

```bash
# 5% de perda + 50ms de atraso
sudo tc qdisc add dev eth0 root netem loss 5% delay 50ms

# remover depois
sudo tc qdisc del dev eth0 root
```

**O que esperar:**
- Com SRT e `latency` adequado, o vídeo segue limpo (ou com microfalhas raras).
- Com UDP puro, você verá blocos/artefatos — comprovando por que SRT é necessário.

### 10.2 Simular fonte caindo
Derrube o encoder de origem por ~10 s. Verifique:
- [ ] `freeze`/`black` ou `stalled` aparecem na WebUI
- [ ] O Node reinicia o FFmpeg com backoff
- [ ] O playout volta sozinho quando a fonte volta

### 10.3 Checklist final
- [ ] Frame rate de saída constante (`ffprobe` na saída)
- [ ] Áudio sem desincronia depois de 1 hora
- [ ] CPU abaixo de ~70%
- [ ] `speed` do FFmpeg ≥ `1.0x` (se ficar menor, o servidor não aguenta: use preset mais rápido ou GPU)

```bash
ffprobe -v error -show_entries stream=codec_name,r_frame_rate,width,height srt://...
```

---

## 11. Problemas comuns

| Sintoma | Causa provável | Solução |
|---|---|---|
| `Protocol not found` ao usar `srt://` | FFmpeg sem libsrt | Build estático ou compilar com `--enable-libsrt` |
| Vídeo picota mesmo com SRT | `latency` baixo demais para o RTT | Aumente (3–4× RTT) |
| `speed` abaixo de 1.0x | CPU insuficiente | `-preset ultrafast`, reduzir resolução/bitrate ou usar NVENC |
| Áudio dessincroniza com o tempo | Fonte com clock instável | Manter `aresample=async=1000`; avaliar `-af aresample=async=1:min_hard_comp=0.1` |
| Watchdog mata o FFmpeg no início | Esperando a fonte conectar | Ativar watchdog só após o 1º `running` |
| Preview HLS não toca | MediaMTX parado ou áudio incompatível | Confira `http://IP:8888/live/index.m3u8` direto no navegador |
| Playout não recebe | Caller/listener invertidos | Um lado precisa ser `listener` e o outro `caller` |

---

## 12. Resumo da arquitetura final

1. **Fonte → Servidor:** SRT com `latency` ajustado (recupera perdas).
2. **FFmpeg:** normaliza FPS (CFR), áudio contínuo, descarta corrompidos, detecta freeze/black, reencoda com bitrate controlado.
3. **Node.js:** supervisiona, aplica watchdog, reinicia com backoff e informa o status.
4. **Saídas:** SRT para o **playout** + RTSP para o **MediaMTX** (preview HLS).
5. **WebUI:** mostra preview **já tratado** e status em tempo real. Ela **nunca** recebe o FFmpeg cru.

---

## 13. Próximos passos sugeridos

1. Fazer funcionar a **Fase A** (seção 7) com uma fonte de teste.
2. Validar com `tc netem`.
3. Só então evoluir para 2 estágios + slate (seção 9).
4. Depois, se necessário: múltiplos canais, logs persistentes, autenticação na WebUI e rodar como serviço `systemd`.

## 14. Empacotando como executável (.exe / .appimage)

Para distribuir o projeto como um único arquivo executável (sem precisar que o cliente instale o Node.js), podemos usar a biblioteca `pkg` do Vercel. O `pkg` empacota o seu Node.js, os scripts e os assets da pasta `public/` num binário final.

### 14.1 Instalando o pkg globalmente
```bash
npm install -g pkg
```

### 14.2 Ajustando o package.json
Para que o `pkg` saiba que precisa incluir a pasta `public/` no executável, adicione isto ao seu `package.json`:
```json
{
  "name": "playout-server",
  "version": "1.0.0",
  "type": "module",
  "bin": "server.js",
  "pkg": {
    "assets": [
      "public/**/*"
    ]
  },
  "dependencies": {
    "express": "^4.x.x",
    "ws": "^8.x.x"
  }
}
```

*Importante:* Como estamos usando `"type": "module"`, o `pkg` tem algumas ressalvas com ESM puro em versões antigas. Para máxima compatibilidade no empacotamento, você pode rodar o código com o Node 20 (que tem melhor suporte).

### 14.3 Gerando o AppImage Portátil e Completo (Linux)

Para distribuir o seu servidor como um **aplicativo portátil** no Linux, que contém o Node.js, FFmpeg, FFplay e MediaMTX embutidos (sem o cliente precisar instalar **nada**), usamos o **linuxdeploy** e o **appimagetool**.

#### Passo a Passo de Compilação:
Baixe as ferramentas necessárias:
```bash
wget https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-x86_64.AppImage -O linuxdeploy
chmod +x linuxdeploy

wget https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage -O appimagetool
chmod +x appimagetool
```

Agrupe tudo na pasta `AppDir`:
```bash
# 1. Rastreia e copia os binários e TODAS as bibliotecas (.so) nativas do seu sistema
./linuxdeploy --appdir AppDir -e /usr/bin/node -e /usr/bin/ffmpeg -e /usr/bin/ffplay

# 2. Copia o projeto e o MediaMTX para dentro da estrutura portátil
cp -r playout-server AppDir/usr/share/playout-server
cp playout-server/mediamtx/mediamtx AppDir/usr/bin/mediamtx

# 3. Cria um ícone e o arquivo Desktop
echo '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><circle cx="128" cy="128" r="120" fill="red"/></svg>' > AppDir/srt-playout.svg
cp AppDir/srt-playout.svg AppDir/.DirIcon

cat << 'EOF' > AppDir/srt-playout.desktop
[Desktop Entry]
Name=SRT-Playout
Exec=AppRun
Icon=srt-playout
Type=Application
Categories=AudioVideo;
EOF

# 4. Cria o script de inicialização universal
cat << 'EOF' > AppDir/AppRun
#!/bin/bash
HERE="$(dirname "$(readlink -f "${0}")")"
export PATH="${HERE}/usr/bin:${PATH}"
export LD_LIBRARY_PATH="${HERE}/usr/lib:${LD_LIBRARY_PATH}"
cd "${HERE}/usr/share/playout-server"
exec node server.js "$@"
EOF
chmod +x AppDir/AppRun

# 5. Gera o pacote final compactado
./appimagetool AppDir SRT_Playout-x86_64.AppImage
```

Ao final, você terá um arquivo **`SRT_Playout-x86_64.AppImage`** com cerca de 130MB. Basta copiá-lo para qualquer máquina Linux (até mesmo em pen-drives) e rodar ` ./SRT_Playout-x86_64.AppImage`. Ele já tem TUDO o que precisa!

---

## 4. Executando em Segundo Plano (Serviço de Produção)

Para manter o `playout-server` (e o MediaMTX) rodando continuamente em segundo plano, sem depender de um terminal aberto, você tem duas opções principais:

### 4.1. PM2 (Ecosistema Node.js)
Como você mencionou, o PM2 é excelente, extremamente fácil e já gerencia restarts automáticos para aplicações Node.
Instale o PM2 globalmente:
```bash
sudo npm install -g pm2
```
Inicie a aplicação e salve na inicialização:
```bash
pm2 start server.js --name "srt-playout"
pm2 save
pm2 startup
```

### 4.2. Systemd (Padrão Nativo do Linux - O mais moderno)
Se você busca o que há de mais "moderno" e robusto em termos de infraestrutura Linux pura (sem precisar instalar o PM2 no host do cliente), criar um **Service do Systemd** é o padrão absoluto da indústria. Ele gerencia o processo direto pelo Kernel e inicializa no boot.

Crie o arquivo: `sudo nano /etc/systemd/system/srt-playout.service`
```ini
[Unit]
Description=SRT Playout WebUI
After=network.target

[Service]
Type=simple
User=SEU_USUARIO
WorkingDirectory=/caminho/para/srt-server/playout-server
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```
Ative e inicie:
```bash
sudo systemctl daemon-reload
sudo systemctl enable srt-playout
sudo systemctl start srt-playout
```
Acesse os logs com: `sudo journalctl -u srt-playout -f`
