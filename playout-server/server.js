import { spawn } from 'node:child_process';
import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';

// ---------- CONFIGURAÇÃO ----------
const CFG = {
  port: 3000,
  input: 'srt://0.0.0.0:9000?mode=listener&latency=2000000',
  playoutOut: 'udp://127.0.0.1:9100',
  previewOut: 'rtsp://127.0.0.1:8554/live',
  fps: '30000/1001',
  videoBitrate: '6M',
  stallTimeoutMs: 15000,   // sem progresso por X ms = travado
  backoffMinMs: 1000,
  backoffMaxMs: 15000,
};

// ---------- ESTADO ----------
const state = {
  status: 'stopped',
  restarts: 0,
  lastProgress: 0,
  freeze: false,
  black: false,
  speed: null,
  dup: 0,
  drop: 0,
  bitrate: 'N/A',
  hdmi: false,
  startedAt: null,
};

let ff = null;
let hdmiProcess = null;
let backoff = CFG.backoffMinMs;
let wantRunning = false;
let restartPending = false;

let dynamicInput = CFG.input;

// ---------- WEB + WEBSOCKET ----------
const app = express();
app.use(express.static('public'));
app.use(express.json());

app.post('/api/start', (req, res) => {
  if (req.body && req.body.inputUrl && req.body.inputUrl !== dynamicInput) {
    dynamicInput = req.body.inputUrl;
  }
  
  if (ff) {
    restartPending = true;
    stop();
  } else {
    start();
  }
  res.json({ ok: true });
});

app.post('/api/stop',  (_, res) => { restartPending = false; stop(); res.json({ ok: true }); });
app.get('/api/status', (_, res) => res.json(state));

app.post('/api/hdmi', (req, res) => {
  const enable = req.body.enable;
  if (enable && !hdmiProcess) {
    const env = Object.assign({}, process.env);
    if (!env.DISPLAY) env.DISPLAY = ':0';
    if (!env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = '/run/user/1000';
    
    hdmiProcess = spawn('ffplay', [
      '-i', 'udp://127.0.0.1:9100',
      '-fs', '-alwaysontop', '-noborder', '-infbuf', '-fflags', 'nobuffer'
    ], { stdio: 'ignore', env });
    state.hdmi = true;
  } else if (!enable && hdmiProcess) {
    hdmiProcess.kill('SIGKILL');
    hdmiProcess = null;
    state.hdmi = false;
  }
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast() {
  const msg = JSON.stringify(state);
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}
setInterval(broadcast, 1000);

// ---------- FFMPEG ----------
function getSafeInput(url) {
  let u = url;
  if (!u.includes('?')) u += '?mode=caller';
  if (!u.includes('transtype=')) u += '&transtype=live';
  if (!u.includes('latency=')) u += '&latency=1000000'; // 1 segundo de buffer
  if (!u.includes('recv_buffer_size=')) u += '&recv_buffer_size=2000000';
  return u;
}

function buildArgs() {
  const tee =
    `[f=mpegts:onfail=ignore]${CFG.playoutOut}|` +
    `[f=rtsp:rtsp_transport=tcp:onfail=ignore]${CFG.previewOut}`;

  return [
    '-hide_banner', '-nostats',
    '-progress', 'pipe:1',
    '-fflags', '+genpts+discardcorrupt',
    '-analyzeduration', '2000000', '-probesize', '5000000',
    '-i', getSafeInput(dynamicInput),
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
  state.dup = 0;
  state.drop = 0;

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
      if (k === 'dup_frames') state.dup = v;
      if (k === 'drop_frames') state.drop = v;
      if (k === 'bitrate') state.bitrate = v;
    }
  });

  // stderr: logs (freeze/black/erros)
  ff.stderr.on('data', (d) => {
    const s = d.toString();
    if (s.includes('freeze_start')) state.freeze = true;
    if (s.includes('freeze_end'))   state.freeze = false;
    if (s.includes('black_start'))  state.black = true;
    if (s.includes('black_end'))    state.black = false;
    // Mostrar logs de erro do ffmpeg no terminal
    process.stderr.write(s);
  });

  ff.on('exit', (code, sig) => {
    console.log(`[ffmpeg] saiu code=${code} sig=${sig}`);
    ff = null;
    
    if (restartPending) {
      restartPending = false;
      start();
      return;
    }
    
    if (!wantRunning) { state.status = 'stopped'; return; }
    state.status = 'restarting';
    state.restarts++;
    setTimeout(start, backoff);
    backoff = Math.min(backoff * 2, CFG.backoffMaxMs);
  });
}

function stop() {
  wantRunning = false;
  if (ff) ff.kill('SIGKILL');
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
