import express from 'express';
import { spawn, exec, execSync, spawnSync } from 'child_process';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- CONFIGURAÇÕES ---
const CONFIG_FILE = path.join(__dirname, 'config.json');
let config = {
  urls: ["", "", ""],
  outputPort: 9000
};

if (fs.existsSync(CONFIG_FILE)) {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) };
  } catch (e) { console.error('Erro ao ler config.json', e); }
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function updateMediaMtxPort() {
  const ymlPath = path.join(__dirname, 'mediamtx', 'mediamtx.yml');
  if (fs.existsSync(ymlPath)) {
    let yml = fs.readFileSync(ymlPath, 'utf8');
    const match = yml.match(/srtAddress:\s*:(\d+)/);
    
    // SÓ REINICIA O MEDIAMTX SE A PORTA REALMENTE MUDOU!
    // Porque se reiniciar, o systemd reinicia o Node.js junto (devido ao Requires=)
    if (match && parseInt(match[1]) !== config.outputPort) {
      yml = yml.replace(/srtAddress:\s*:\d+/g, `srtAddress: :${config.outputPort}`);
      fs.writeFileSync(ymlPath, yml);
      
      // Usa timeout para dar tempo da API responder "ok" antes do suicídio
      setTimeout(() => {
        exec('systemctl --user restart mediamtx-playout || sudo systemctl restart srt-mediamtx');
      }, 500);
    }
  }
}

const CFG = {
  port: 3000,
  fallbackMs: 180000, // 3 minutos
  internalUdp: 'udp://127.0.0.1:10000'
};

// --- DETECÇÃO DE GPU E ACELERAÇÃO POR HARDWARE ---
function detectGpuAndEncoder() {
  let gpuName = 'CPU Integrada';
  try {
    const pci = execSync('lspci 2>/dev/null | grep -iE "vga|3d|display"', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const m = pci.match(/\[(.*?)\]/);
    if (m) {
      gpuName = (pci.includes('Intel') ? 'Intel ' : (pci.includes('NVIDIA') ? 'NVIDIA ' : (pci.includes('AMD') ? 'AMD ' : ''))) + m[1];
    } else {
      const parts = pci.split(': ');
      gpuName = parts[parts.length - 1] || pci;
    }
  } catch (e) {}

  // 1. Tentar Intel VAAPI com driver iHD
  try {
    const res = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-init_hw_device', 'vaapi=va:/dev/dri/renderD128,driver=iHD',
      '-filter_hw_device', 'va',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-frames:v', '2',
      '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-f', 'null', '-'
    ], { env: { ...process.env, LIBVA_DRIVER_NAME: 'iHD' } });
    if (res.status === 0) {
      console.log(`[GPU] Aceleração ATIVA: ${gpuName} via Intel VAAPI (iHD)`);
      return {
        name: gpuName,
        renderer: `${gpuName} (VAAPI HW)`,
        hardware: true,
        type: 'vaapi',
        driver: 'iHD',
        hwArgs: ['-init_hw_device', 'vaapi=va:/dev/dri/renderD128,driver=iHD', '-filter_hw_device', 'va']
      };
    }
  } catch (e) {}

  // 2. Tentar VAAPI genérico (AMD / Mesa)
  try {
    const res = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-init_hw_device', 'vaapi=va:/dev/dri/renderD128',
      '-filter_hw_device', 'va',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-frames:v', '2',
      '-vf', 'format=nv12,hwupload', '-c:v', 'h264_vaapi', '-f', 'null', '-'
    ]);
    if (res.status === 0) {
      console.log(`[GPU] Aceleração ATIVA: ${gpuName} via VAAPI`);
      return {
        name: gpuName,
        renderer: `${gpuName} (VAAPI HW)`,
        hardware: true,
        type: 'vaapi',
        driver: null,
        hwArgs: ['-init_hw_device', 'vaapi=va:/dev/dri/renderD128', '-filter_hw_device', 'va']
      };
    }
  } catch (e) {}

  // 3. Tentar NVIDIA NVENC
  try {
    const res = spawnSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-frames:v', '2',
      '-c:v', 'h264_nvenc', '-f', 'null', '-'
    ]);
    if (res.status === 0) {
      console.log(`[GPU] Aceleração ATIVA: ${gpuName} via NVENC`);
      return {
        name: gpuName,
        renderer: `${gpuName} (NVENC HW)`,
        hardware: true,
        type: 'nvenc',
        driver: null,
        hwArgs: []
      };
    }
  } catch (e) {}

  console.log(`[GPU] Nenhuma GPU aceleradora disponível. Usando CPU (libx264).`);
  return {
    name: gpuName,
    renderer: 'CPU Software (libx264)',
    hardware: false,
    type: 'cpu',
    driver: null,
    hwArgs: []
  };
}

const gpuEngine = detectGpuAndEncoder();

// --- ESTADO DO SISTEMA ---
let state = {
  status: 'stopped',
  activeInput: -1,
  health: [false, false, false],
  deadSince: [0, 0, 0],
  lastProgress: Date.now(),
  stats: { speed: '1.0x', dup: '0', drop: '0', bitrate: 'N/A' },
  gpu: {
    name: gpuEngine.name,
    renderer: gpuEngine.renderer,
    hardware: gpuEngine.hardware
  },
  hdmi: false
};

let masterFF = null;
let inputFF = null;
let hdmiFF = null;
let probers = [null, null, null];

function getSafeInput(url) {
  if (!url || !url.startsWith('srt://')) return url;
  let safe = url;
  if (!safe.includes('mode=')) safe += '?mode=caller';
  if (!safe.includes('transtype=')) safe += '&transtype=live';
  if (!safe.includes('latency=')) safe += '&latency=500000'; // 500ms para recuperação de pacotes
  if (!safe.includes('recv_buffer_size=')) safe += '&recv_buffer_size=8192000';
  if (!safe.includes('fc=')) safe += '&fc=102400'; // Janela grande de Flow Control
  return safe;
}

// --- SAÍDA DE PROGRAMA ---
// 59.94 = exatamente 2x 29.97 → cada quadro da origem é repetido de forma uniforme (sem judder).
const OUT_FPS = '60000/1001';
const OUT_GOP = '60'; // keyframe a cada ~1s → segmentos HLS regulares de 1s

function videoEncodeArgs() {
  if (gpuEngine.type === 'vaapi') {
    return [
      '-vf', `scale=1920:1080:flags=bicubic,fps=${OUT_FPS},format=nv12,hwupload`,
      '-c:v', 'h264_vaapi', '-profile:v', 'main', '-bf', '0', '-g', OUT_GOP,
      '-b:v', '8M', '-maxrate', '8M', '-bufsize', '8M'
    ];
  }
  if (gpuEngine.type === 'nvenc') {
    return [
      '-vf', `scale=1920:1080:flags=bicubic,fps=${OUT_FPS},format=yuv420p`,
      '-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-zerolatency', '1',
      '-bf', '0', '-g', OUT_GOP,
      '-b:v', '8M', '-maxrate', '8M', '-bufsize', '8M'
    ];
  }
  return [
    '-vf', `scale=1920:1080:flags=bicubic,fps=${OUT_FPS},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-profile:v', 'main', '-level', '4.2', '-threads', '0',
    '-bf', '0', '-g', OUT_GOP, '-keyint_min', OUT_GOP, '-sc_threshold', '0',
    '-b:v', '8M', '-maxrate', '8M', '-bufsize', '8M'
  ];
}

// Lê o "-progress" do FFmpeg (fd 3) e devolve pares chave=valor
function onProgress(stream, cb) {
  stream.on('data', (d) => {
    const kv = {};
    d.toString().split('\n').forEach(l => { const i = l.indexOf('='); if (i > 0) kv[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
    cb(kv);
  });
}

// --- MASTER PLAYOUT ---
// Recebe MPEG-TS pelo stdin (alimentado pelo Node, sem perdas) e entrega 1080p59.94 CFR ao MediaMTX.
function startMaster() {
  if (masterFF) return;
  console.log(`[MASTER] Iniciando playout mestre (${gpuEngine.renderer}, 1080p59.94)...`);

  masterFF = spawn('ffmpeg', [
    '-hide_banner', '-nostats', '-loglevel', 'error',
    ...gpuEngine.hwArgs,
    '-fflags', '+genpts+discardcorrupt', '-thread_queue_size', '4096',
    '-f', 'mpegts', '-i', 'pipe:0',
    '-map', '0:v:0', '-map', '0:a:0?',
    ...videoEncodeArgs(),
    '-af', 'aresample=async=1000:first_pts=0',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-f', 'rtsp', '-rtsp_transport', 'tcp', 'rtsp://127.0.0.1:8554/live',
    '-progress', 'pipe:3', '-stats_period', '1'
  ], {
    stdio: ['pipe', 'ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(gpuEngine.driver === 'iHD' ? { LIBVA_DRIVER_NAME: 'iHD' } : {}) }
  });

  const m = masterFF;
  m.stdin.on('error', () => {}); // EPIPE quando o mestre reinicia não pode derrubar o Node
  m.stderr.on('data', (d) => console.log('[MASTER ERROR]', d.toString().trim()));

  // Estatísticas reais da SAÍDA (é aqui que se mede se o encoder acompanha o tempo real)
  onProgress(m.stdio[3], (kv) => {
    if (kv.speed && kv.speed !== 'N/A') state.stats.speed = kv.speed.replace(/\s/g, '');
    if (kv.drop_frames) state.stats.drop = kv.drop_frames;
    if (kv.dup_frames) state.stats.dup = kv.dup_frames;
  });

  m.on('close', () => {
    console.log('[MASTER] Playout mestre encerrado.');
    if (masterFF === m) masterFF = null;
    if (inputFF) inputFF.stdout.resume(); // não deixa a entrada travada esperando 'drain'
    if (state.status === 'running') setTimeout(startMaster, 2000);
  });
}

function stopMaster() {
  if (masterFF) { masterFF.kill('SIGKILL'); masterFF = null; }
}

// Encaminha os dados da entrada ativa para o mestre, respeitando backpressure (zero perda local)
function feedMaster(p, chunk) {
  if (inputFF !== p) return; // dados de um processo antigo são descartados
  state.lastProgress = Date.now();
  const m = masterFF;
  if (!m || !m.stdin.writable) return;
  if (!m.stdin.write(chunk)) {
    p.stdout.pause();
    m.stdin.once('drain', () => { if (inputFF === p) p.stdout.resume(); });
  }
}

// --- INPUT HANDLER ---
function startInput(index) {
  if (inputFF) { inputFF.kill('SIGKILL'); inputFF = null; }
  state.activeInput = index;
  state.lastProgress = Date.now();

  let args;
  if (index === -1) {
    console.log('[INPUT] Iniciando SLATE (Fallback Leve)...');
    // Mesmo formato da origem (1080p29.97, estéreo 48k) → o mestre não precisa reconfigurar na troca
    args = [
      '-re', '-hide_banner', '-nostats', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'smptebars=size=1920x1080:rate=30000/1001',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-bf', '0', '-g', '30',
      '-b:v', '2M', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-f', 'mpegts', 'pipe:1',
      '-progress', 'pipe:3', '-stats_period', '1'
    ];
  } else {
    console.log(`[INPUT] Iniciando Stream ${index + 1}: ${config.urls[index]}`);
    state.health[index] = true;
    state.deadSince[index] = 0;
    args = [
      '-hide_banner', '-nostats', '-loglevel', 'error',
      '-fflags', '+genpts+discardcorrupt',
      '-i', getSafeInput(config.urls[index]),
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy',
      '-f', 'mpegts', 'pipe:1',
      '-progress', 'pipe:3', '-stats_period', '1'
    ];
  }

  inputFF = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  const p = inputFF;

  p.stdout.on('data', (chunk) => feedMaster(p, chunk));
  // stderr PRECISA ser drenado, senão o buffer enche e o FFmpeg congela a entrada
  p.stderr.on('data', (d) => console.log(`[INPUT ${index}]`, d.toString().trim()));
  onProgress(p.stdio[3], (kv) => {
    if (inputFF !== p) return;
    if (kv.bitrate && kv.bitrate !== 'N/A') state.stats.bitrate = kv.bitrate;
  });

  p.on('close', () => {
    console.log(`[INPUT] FFmpeg (Índice ${index}) foi encerrado.`);
    if (inputFF !== p) return; // processo antigo morto numa troca intencional
    inputFF = null;
    if (state.status === 'running') {
      if (index !== -1) {
        state.health[index] = false;
        state.deadSince[index] = Date.now();
        // Manda pro slate imediatamente para não gerar loop infinito do mesmo erro
        startInput(-1);
      } else {
        // Se o próprio slate crashar, espera 2s pra não torrar a CPU num loop
        setTimeout(() => { if (state.status === 'running' && state.activeInput === -1) startInput(-1); }, 2000);
      }
    }
  });
}

function stopInput() {
  if (inputFF) { inputFF.kill('SIGKILL'); inputFF = null; }
}

// --- SWITCHER AUTOMÁTICO E PROBING ---
// Faz um ping rápido na URL para saber se ela está "viva"
function probe(url, index) {
  if (!url) {
    state.health[index] = false;
    return;
  }
  const p = spawn('ffprobe', [
    '-v', 'error', '-analyzeduration', '1000000', '-probesize', '1000000',
    '-show_streams', getSafeInput(url)
  ]);
  const timeout = setTimeout(() => { p.kill('SIGKILL'); }, 4000);
  p.on('close', (code) => {
    clearTimeout(timeout);
    const isAlive = (code === 0);
    state.health[index] = isAlive;
    if (isAlive) state.deadSince[index] = 0;
    else if (state.deadSince[index] === 0) state.deadSince[index] = Date.now();
  });
}

setInterval(() => {
  if (state.status !== 'running') return;

  // 1. Probing (Verifica a saúde dos streams INATIVOS a cada 10s)
  // O stream ativo não é probado porque já está em uso pelo FFmpeg principal
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    if (i !== state.activeInput && config.urls[i] && (!probers[i] || now - probers[i] > 10000)) {
      probers[i] = now;
      probe(config.urls[i], i);
    }
  }

  // 2. Watchdog Anti-Zumbi do Stream Ativo
  if (state.activeInput !== -1 && inputFF) {
    if (now - state.lastProgress > 15000) {
      console.log(`[WATCHDOG] Stream ${state.activeInput + 1} sem dados há 15s. Matando!`);
      inputFF.kill('SIGKILL'); // Vai acionar o 'close' event e ir pro Slate
      return;
    }
  }

  // 3. Lógica de Fallback de 3 Minutos e Recuperação
  if (state.activeInput === -1) {
    // Estamos no SLATE
    if (config.urls[0] && state.health[0]) {
      console.log('[SWITCHER] Main Stream retornou! Assumindo.');
      startInput(0);
    } else if (config.urls[1] && state.health[1] && (now - state.deadSince[0] > CFG.fallbackMs)) {
      console.log('[SWITCHER] Main morto há 3 mins. Secundário saudável assumindo.');
      startInput(1);
    } else if (config.urls[2] && state.health[2] && (now - state.deadSince[0] > CFG.fallbackMs) && (now - state.deadSince[1] > CFG.fallbackMs)) {
      console.log('[SWITCHER] Main e Sec mortos há 3 mins. Terciário assumindo.');
      startInput(2);
    }
  } else if (state.activeInput === 1) {
    // Secundário no ar. O Main voltou?
    if (config.urls[0] && state.health[0]) {
      console.log('[SWITCHER] Main Stream retornou! Derrubando Secundário e retomando Main.');
      startInput(0);
    }
  } else if (state.activeInput === 2) {
    // Terciário no ar. Alguém superior voltou?
    if (config.urls[0] && state.health[0]) {
      console.log('[SWITCHER] Main Stream retornou! Retomando Main.');
      startInput(0);
    } else if (config.urls[1] && state.health[1] && (now - state.deadSince[0] > CFG.fallbackMs)) {
      console.log('[SWITCHER] Secundário retornou (Main continua fora). Retomando Secundário.');
      startInput(1);
    }
  }
}, 1000);

// --- ROTAS DA API ---
app.get('/api/settings', (req, res) => res.json(config));

app.post('/api/settings', (req, res) => {
  if (state.status === 'running') return res.status(403).json({ error: 'Pare o stream primeiro.' });
  config.urls = req.body.urls || ["", "", ""];
  config.outputPort = parseInt(req.body.outputPort) || 9000;
  saveConfig();
  updateMediaMtxPort();
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => res.json(state));

app.post('/api/start', (req, res) => {
  if (state.status === 'running') return res.json({ ok: true });
  state.status = 'running';
  state.deadSince = [Date.now(), Date.now(), Date.now()]; // o relógio dos 3 min começa no START
  state.health = [false, false, false];
  
  startMaster();
  startInput(-1); // Inicia no Slate, o switcher vai puxar o Main no próximo segundo
  res.json({ ok: true });
});

app.post('/api/stop', (req, res) => {
  state.status = 'stopped';
  state.activeInput = -1;
  stopInput();
  stopMaster();
  if (hdmiFF) { hdmiFF.kill('SIGKILL'); hdmiFF = null; state.hdmi = false; }
  res.json({ ok: true });
});

app.post('/api/hdmi', (req, res) => {
  if (hdmiFF) {
    hdmiFF.kill('SIGKILL'); hdmiFF = null; state.hdmi = false;
  } else {
    state.hdmi = true;
    hdmiFF = spawn('ffplay', [
      '-rtsp_transport', 'tcp', '-i', 'rtsp://127.0.0.1:8554/live', '-fs', '-noborder', '-alwaysontop', '-fflags', 'nobuffer', '-flags', 'low_delay'
    ], { env: { ...process.env, DISPLAY: ':0' } });
    hdmiFF.on('close', () => { hdmiFF = null; state.hdmi = false; });
  }
  res.json({ hdmi: state.hdmi });
});

const server = app.listen(CFG.port, () => console.log(`WebUI em http://localhost:${CFG.port}`));

// --- WEBSOCKET ---
const wss = new WebSocketServer({ server });
wss.on('connection', (c) => {
  if (c.readyState === 1) c.send(JSON.stringify(state));
});
setInterval(() => {
  const payload = JSON.stringify(state);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
}, 1000);
