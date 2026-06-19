const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { WebSocketServer } = require('ws');

let ytdl = null;
try { ytdl = require('@distube/ytdl-core'); } catch(e) { console.warn('ytdl-core not available:', e.message); }

const PORT = process.env.PORT || 3000;

let radioState = {
  currentTrack: null,
  isPlaying: false,
  position: 0,
  volume: 80,
  playlist: [],
  lastUpdate: Date.now()
};

// ---- RADIO STREAM ENGINE ----
const streamClients = new Set();
let currentStreamDestroy = null; // function to cancel current stream
let streamBusy = false;
let streamGen = 0; // bumped on every startStreamTrack; stale streams stop writing

function writeToStreamClients(chunk) {
  streamClients.forEach(client => {
    if (!client.destroyed && !client.writableEnded) {
      try { client.write(chunk); } catch(_) {}
    }
  });
}

function silenceChunk(ms = 200) {
  // ~200ms of MP3 silence at 128kbps ≈ 3200 bytes of zeros
  return Buffer.alloc(Math.ceil(128000 / 8 * ms / 1000));
}

async function streamYouTubeVideo(videoId, gen) {
  if (!ytdl) throw new Error('ytdl-core not available');
  return new Promise((resolve, reject) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    let stream;
    try {
      stream = ytdl(url, {
        filter: 'audioonly',
        quality: 'highestaudio',
        highWaterMark: 1 << 25 // 32MB buffer
      });
    } catch(e) { reject(e); return; }

    currentStreamDestroy = () => {
      try { stream.destroy(); } catch(_) {}
    };

    // Only the latest stream may write — a cancelled/stale one stays silent.
    stream.on('data', chunk => { if (gen === streamGen) writeToStreamClients(chunk); });
    // Only clear shared stream state if WE are still the latest generation —
    // a stale stream that ends/errors after a new track started must NOT wipe
    // the new generation's currentStreamDestroy/streamBusy.
    stream.on('end', () => { if (gen === streamGen) { currentStreamDestroy = null; streamBusy = false; } resolve(); });
    stream.on('error', (e) => { if (gen === streamGen) { currentStreamDestroy = null; streamBusy = false; } reject(e); });
  });
}

async function streamAudioBuffer(buffer, gen) {
  // Send first ~5 seconds immediately so browser starts playing fast
  const PREBUFFER = 80000; // ~5s at 128kbps
  const HEAD = Math.min(PREBUFFER, buffer.length);
  let cancelled = false;
  currentStreamDestroy = () => { cancelled = true; };
  const stale = () => cancelled || gen !== streamGen;

  if (!stale()) writeToStreamClients(buffer.slice(0, HEAD));
  if (stale() || HEAD >= buffer.length) { if (!cancelled) currentStreamDestroy = null; return; }

  // Stream remainder at 1.5× real-time: 24000 bytes/s → 48KB every 2s
  // This keeps browser buffer ~1.5s ahead, absorbs jitter without excess latency
  const CHUNK = 48000;
  const INTERVAL = 2000;
  for (let i = HEAD; i < buffer.length; i += CHUNK) {
    if (stale()) break;
    writeToStreamClients(buffer.slice(i, i + CHUNK));
    await new Promise(r => setTimeout(r, INTERVAL));
  }
  if (!cancelled) currentStreamDestroy = null;
}

// Called when the panel sends a PLAY/SPOT WebSocket message
function startStreamTrack(track) {
  // Cancel any in-flight stream first, then claim a new generation so that the
  // previous stream's async callbacks/timeouts can no longer write to clients.
  if (currentStreamDestroy) { currentStreamDestroy(); currentStreamDestroy = null; }
  const gen = ++streamGen;
  streamBusy = false;
  if (!track) return;

  if (track.type === 'yt' && track.ytId && ytdl) {
    streamBusy = true;
    console.log('[stream] start yt', track.ytId, '(gen', gen + ')');
    streamYouTubeVideo(track.ytId, gen)
      .then(() => { if (gen === streamGen) streamBusy = false; })
      .catch(e => {
        console.error('[stream] ytdl error for', track.ytId, e.message);
        if (gen === streamGen) streamBusy = false;
        // Do NOT send invalid silence bytes — just let the connection stay open silently
      });
  } else if (track.b64) {
    // Uploaded MP3: base64-encoded audio from panel
    streamBusy = true;
    console.log('[stream] start mp3 (gen', gen + ')');
    const buf = Buffer.from(track.b64, 'base64');
    streamAudioBuffer(buf, gen)
      .then(() => { if (gen === streamGen) streamBusy = false; })
      .catch(() => { if (gen === streamGen) streamBusy = false; });
  }
}

// Keep stream connections alive between tracks using valid MPEG1 Layer3 silent frames.
// Each frame: sync(FF FB) + header(90 04) + 413 bytes of zeros = 417 bytes ≈ 26ms of silence.
// Sending 8 frames = ~208ms of valid silence keeps the browser's decoder happy during gaps.
const SILENT_FRAME = Buffer.concat([Buffer.from([0xFF,0xFB,0x90,0x04]), Buffer.alloc(413)]);
const SILENT_BURST = Buffer.concat(Array(8).fill(SILENT_FRAME)); // ~208ms silence

let _keepaliveInterval = null;
function startStreamKeepalive() {
  if (_keepaliveInterval) return;
  _keepaliveInterval = setInterval(() => {
    // Stop the timer entirely once no one is listening — avoids a forever-running
    // interval and lets it restart cleanly when the next client connects.
    if (streamClients.size === 0) { clearInterval(_keepaliveInterval); _keepaliveInterval = null; return; }
    if (!streamBusy) {
      writeToStreamClients(SILENT_BURST);
    }
  }, 3000); // every 3s during idle gaps between tracks
}

// ---- TEST RADIO ENGINE (Fase C2 — behind RADIO_ENGINE_TEST=1) ----
// A parallel, isolated continuous stream: loops the 3 synthetic MP3 fixtures
// through FFmpeg and serves them at /radio/stream-test. It does NOT touch the
// production /radio/stream path, startStreamTrack, streamClients, or any HTML.
// No YouTube / no ytdl-core. Engine starts lazily on first listener and stops
// when the last one leaves.
const ENGINE_TEST = process.env.RADIO_ENGINE_TEST === '1';
const TEST_TRACKS = ['track1.mp3', 'track2.mp3', 'track3.mp3'];
const testStreamClients = new Set();
let testFfmpeg = null;
let _testConcatFile = null;

function writeToTestClients(chunk) {
  testStreamClients.forEach(client => {
    if (!client.destroyed && !client.writableEnded) {
      try { client.write(chunk); } catch(_) {}
    }
  });
}

// Build an FFmpeg concat-demuxer list file pointing at the 3 fixtures.
function _writeTestConcatList() {
  const lines = TEST_TRACKS.map(name => {
    const abs = path.join(__dirname, 'audio-test', name);
    return "file '" + abs.replace(/'/g, "'\\''") + "'";
  });
  const file = path.join(os.tmpdir(), 'tp_stream_test_concat.txt');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function startTestEngine() {
  if (testFfmpeg) return;
  let ffmpegPath;
  try { ffmpegPath = require('ffmpeg-static'); }
  catch (e) { console.error('[stream-test] ffmpeg-static no disponible:', e.message); return; }
  if (!ffmpegPath) { console.error('[stream-test] ffmpeg-static sin ruta de binario'); return; }
  for (const name of TEST_TRACKS) {
    const abs = path.join(__dirname, 'audio-test', name);
    if (!fs.existsSync(abs)) { console.error('[stream-test] falta fixture:', abs); return; }
  }
  _testConcatFile = _writeTestConcatList();
  // -re streams at real-time (radio pacing); -stream_loop -1 loops forever over
  // the concat list. Fixtures are already homogeneous (44100/stereo/128k); we
  // re-encode to keep timestamps clean across the loop boundary.
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-re', '-stream_loop', '-1',
    '-f', 'concat', '-safe', '0', '-i', _testConcatFile,
    '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1'
  ];
  console.log('[stream-test] iniciando motor FFmpeg (loop de ' + TEST_TRACKS.length + ' pistas)');
  testFfmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  testFfmpeg.stdout.on('data', chunk => writeToTestClients(chunk));
  testFfmpeg.stderr.on('data', d => { const s = String(d).trim(); if (s) console.error('[stream-test ffmpeg]', s); });
  testFfmpeg.on('error', e => { console.error('[stream-test] error de proceso:', e.message); testFfmpeg = null; });
  testFfmpeg.on('exit', (code, sig) => {
    console.log('[stream-test] FFmpeg terminó (code ' + code + ' sig ' + sig + ')');
    testFfmpeg = null;
    // Auto-restart only if listeners are still attached (e.g. a mid-stream crash).
    if (testStreamClients.size > 0) {
      console.log('[stream-test] reiniciando motor por clientes activos');
      setTimeout(startTestEngine, 500);
    }
  });
}

function stopTestEngine() {
  if (!testFfmpeg) return;
  console.log('[stream-test] deteniendo motor FFmpeg (sin clientes)');
  const proc = testFfmpeg;
  testFfmpeg = null; // null first so the exit handler won't auto-restart
  try { proc.kill('SIGKILL'); } catch(_) {}
}

// ---- RODO-DUCKING ENGINE (Fase C3 — behind RADIO_ENGINE_TEST=1) ----
// Second parallel carril: same 3-track loop, DJ Rodo mixed in every
// RODO_INTERVAL_SECS. Music ducks to DUCK_LEVEL with smooth fades.
// Completely independent of testFfmpeg/testStreamClients — never touches C2.
const RODO_INTERVAL_SECS = 90;   // music-only gap between Rodo appearances
const DUCK_LEVEL         = 0.25; // 25% ≈ -12 dB
const FADE_DOWN_SECS     = 0.5;  // seconds to ramp music down
const FADE_UP_SECS       = 0.9;  // seconds to ramp music back up

const rodoStreamClients = new Set();
let rodoFfmpeg       = null;
let _rodoMusicConcat = null; // separate tmpfile, same 3 tracks
let _rodoPaddedPath  = null; // [silence][rodo.mp3] pre-baked once per process
let _rodoDurSecs     = null; // probed duration of rodo.mp3

function writeToRodoClients(chunk) {
  rodoStreamClients.forEach(client => {
    if (!client.destroyed && !client.writableEnded) {
      try { client.write(chunk); } catch(_) {}
    }
  });
}

function _writeRodoMusicConcat() {
  const lines = TEST_TRACKS.map(name => {
    const abs = path.join(__dirname, 'audio-test', name);
    return "file '" + abs.replace(/'/g, "'\\''") + "'";
  });
  const file = path.join(os.tmpdir(), 'tp_rodo_music_concat.txt');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

// Synchronously build [RODO_INTERVAL_SECS of silence][rodo.mp3] as one MP3.
// Blocks the event loop for ~1-3 s on first client connect; acceptable for MVP.
function _buildRodoPaddedFile(ffmpegPath) {
  const rodoSrc = path.join(__dirname, 'audio-test', 'rodo.mp3');
  const out = path.join(os.tmpdir(), 'tp_rodo_padded.mp3');
  console.log('[rodo-engine] generando silence+rodo (' + RODO_INTERVAL_SECS + 's + rodo.mp3)…');
  const r = spawnSync(ffmpegPath, [
    '-y',
    '-f', 'lavfi', '-t', String(RODO_INTERVAL_SECS), '-i', 'anullsrc=r=44100:cl=stereo',
    '-i', rodoSrc,
    '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[out]',
    '-map', '[out]', '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100',
    out
  ], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) {
    console.error('[rodo-engine] fallo al generar rodo_padded:', (r.stderr || '').slice(-500));
    return null;
  }
  console.log('[rodo-engine] rodo_padded listo →', out);
  return out;
}

function _probeRodoDuration(ffmpegPath) {
  const rodoSrc = path.join(__dirname, 'audio-test', 'rodo.mp3');
  const r = spawnSync(ffmpegPath, ['-i', rodoSrc], { encoding: 'utf8' });
  const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(r.stderr || '');
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

function startRodoEngine() {
  if (rodoFfmpeg) return;
  let ffmpegPath;
  try { ffmpegPath = require('ffmpeg-static'); }
  catch (e) { console.error('[rodo-engine] ffmpeg-static no disponible:', e.message); return; }
  if (!ffmpegPath) { console.error('[rodo-engine] ffmpeg-static sin ruta de binario'); return; }

  for (const name of [...TEST_TRACKS, 'rodo.mp3']) {
    const abs = path.join(__dirname, 'audio-test', name);
    if (!fs.existsSync(abs)) { console.error('[rodo-engine] falta fixture:', abs); return; }
  }

  if (!_rodoMusicConcat) _rodoMusicConcat = _writeRodoMusicConcat();

  if (_rodoDurSecs === null) _rodoDurSecs = _probeRodoDuration(ffmpegPath);
  if (!_rodoDurSecs) { console.error('[rodo-engine] no se pudo leer duración de rodo.mp3'); return; }

  if (!_rodoPaddedPath) _rodoPaddedPath = _buildRodoPaddedFile(ffmpegPath);
  if (!_rodoPaddedPath) return;

  // Volume automation timed against output clock mod CYCLE.
  // T0: begin fade-down  T1: fully ducked  T2: rodo ends, begin fade-up  T3: fully restored
  const T0    = RODO_INTERVAL_SECS - FADE_DOWN_SECS;
  const T1    = RODO_INTERVAL_SECS;
  const T2    = T1 + _rodoDurSecs;
  const T3    = T2 + FADE_UP_SECS;
  const CYCLE = T3;
  const UP    = (1 - DUCK_LEVEL).toFixed(4);
  const DL    = DUCK_LEVEL.toFixed(4);

  // Single expression: full vol → linear fade-down → ducked → linear fade-up → full vol.
  const volExpr =
    `if(lt(mod(t,${CYCLE}),${T0}),1.0,` +
    `if(lte(mod(t,${CYCLE}),${T1}),` +
      `1.0-${UP}*(mod(t,${CYCLE})-${T0})/${FADE_DOWN_SECS},` +
    `if(lte(mod(t,${CYCLE}),${T2}),${DL},` +
    `if(lte(mod(t,${CYCLE}),${T3}),` +
      `${DL}+${UP}*(mod(t,${CYCLE})-${T2})/${FADE_UP_SECS},` +
    `1.0))))`;

  const filterGraph =
    `[0:a]volume=volume='${volExpr}':eval=frame[m];` +
    `[1:a]volume=1.0[r];` +
    `[m][r]amix=inputs=2:duration=longest:dropout_transition=3[out]`;

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-re',
    '-stream_loop', '-1', '-f', 'concat', '-safe', '0', '-i', _rodoMusicConcat,
    '-stream_loop', '-1', '-i', _rodoPaddedPath,
    '-filter_complex', filterGraph,
    '-map', '[out]',
    '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1'
  ];

  console.log('[rodo-engine] iniciando FFmpeg (CYCLE=' + CYCLE.toFixed(1) + 's, rodo=' + _rodoDurSecs.toFixed(1) + 's)');
  rodoFfmpeg = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  rodoFfmpeg.stdout.on('data', chunk => writeToRodoClients(chunk));
  rodoFfmpeg.stderr.on('data', d => { const s = String(d).trim(); if (s) console.error('[rodo-engine ffmpeg]', s); });
  rodoFfmpeg.on('error', e => { console.error('[rodo-engine] error de proceso:', e.message); rodoFfmpeg = null; });
  rodoFfmpeg.on('exit', (code, sig) => {
    console.log('[rodo-engine] FFmpeg terminó (code ' + code + ' sig ' + sig + ')');
    rodoFfmpeg = null;
    if (rodoStreamClients.size > 0) {
      console.log('[rodo-engine] reiniciando por clientes activos');
      setTimeout(startRodoEngine, 500);
    }
  });
}

function stopRodoEngine() {
  if (!rodoFfmpeg) return;
  console.log('[rodo-engine] deteniendo motor (sin clientes)');
  const proc = rodoFfmpeg;
  rodoFfmpeg = null; // null first — prevents auto-restart in exit handler
  try { proc.kill('SIGKILL'); } catch(_) {}
}

// ---- HTTP PROXY HELPERS ----
const PROXY_TIMEOUT_MS = 15000;       // upstream APIs must answer within 15s
const MAX_PROXY_BYTES = 8 * 1024 * 1024; // cap non-audio proxy responses at 8MB

function proxyPost(hostname, path, headers, body, res) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const options = {
    hostname,
    path,
    method: 'POST',
    headers: { ...headers, 'Content-Length': Buffer.byteLength(data) }
  };

  let settled = false;
  const fail = (code, msg) => {
    if (settled) return; settled = true;
    try { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: msg })); } catch(_) {}
  };

  const req = https.request(options, (apiRes) => {
    const isAudio = (apiRes.headers['content-type'] || '').includes('audio');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (isAudio) {
      // Guard the upstream (ElevenLabs) response stream against mid-stream drops.
      // By the time any async 'error' can fire, headers are already written, so we
      // can only tear down cleanly — we cannot send a 502 at this point.
      apiRes.on('error', () => { try { res.destroy(); } catch(_) {} try { apiRes.destroy(); } catch(_) {} });
      // Destroy upstream if the client hangs up (graceful FIN or socket error).
      res.on('error', () => { try { apiRes.destroy(); } catch(_) {} });
      res.on('close', () => { try { apiRes.destroy(); } catch(_) {} });
      settled = true; // streaming response — headers go out now
      res.writeHead(apiRes.statusCode, { 'Content-Type': apiRes.headers['content-type'] || 'audio/mpeg' });
      apiRes.pipe(res);
    } else {
      // Guard the upstream (Anthropic/JSON) response stream: a mid-body drop would
      // emit 'error' with no listener and crash the process.
      apiRes.on('error', (e) => { fail(502, 'Error del proveedor: ' + (e && e.message || 'desconocido')); try { apiRes.destroy(); } catch(_) {} });
      let raw = '', size = 0, aborted = false;
      apiRes.on('data', chunk => {
        if (aborted) return;
        size += chunk.length;
        if (size > MAX_PROXY_BYTES) { aborted = true; apiRes.destroy(); fail(502, 'Respuesta demasiado grande'); return; }
        raw += chunk;
      });
      apiRes.on('end', () => {
        if (aborted || settled) return; settled = true;
        res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(raw);
      });
    }
  });
  req.on('error', (e) => fail(500, e.message));
  req.setTimeout(PROXY_TIMEOUT_MS, () => { req.destroy(); fail(504, 'Tiempo de espera agotado'); });
  req.write(data);
  req.end();
}

// Read an incoming request body with a hard size cap so a huge/malicious POST
// can't exhaust memory. Calls cb(body) on success; sends 413 and skips cb if over limit.
const MAX_REQUEST_BYTES = 12 * 1024 * 1024; // 12MB (covers large TTS payloads, blocks abuse)
function readLimitedBody(req, res, cb) {
  let body = '', size = 0, aborted = false;
  req.on('data', chunk => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      aborted = true;
      try { res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Cuerpo demasiado grande' })); } catch(_) {}
      req.destroy();
      return;
    }
    body += chunk;
  });
  req.on('end', () => { if (!aborted) cb(body); });
}

// ---- HTTP SERVER ----
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, xi-api-key, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Health check ──
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      clients: wss.clients.size,
      streamClients: streamClients.size,
      streamBusy,
      ytdlAvailable: !!ytdl
    }));
    return;
  }

  // ── /radio/stream — continuous HTTP audio stream ──
  const urlPath = req.url.split('?')[0];
  if (urlPath === '/radio/stream' || urlPath === '/live.mp3' || urlPath === '/stream.mp3') {
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'icy-name': 'Radio Terrapesca',
      'icy-genre': 'Fishing & Outdoor',
      'icy-url': 'https://terrapesca.com',
      'icy-metaint': '0',
      'X-Content-Type-Options': 'nosniff',
    });
    streamClients.add(res);
    console.log(`Stream client connected. Total: ${streamClients.size}`);
    startStreamKeepalive();

    // Only start new stream if nothing is currently streaming
    if (radioState.isPlaying && radioState.currentTrack && !streamBusy) {
      startStreamTrack(radioState.currentTrack);
    }

    req.on('close', () => {
      streamClients.delete(res);
      console.log(`Stream client disconnected. Total: ${streamClients.size}`);
    });
    return;
  }

  // ── /radio/stream-test — Fase C2 continuous test stream (behind RADIO_ENGINE_TEST=1) ──
  // Parallel to /radio/stream; FFmpeg loops the 3 synthetic fixtures. No production impact.
  if (urlPath === '/radio/stream-test') {
    if (!ENGINE_TEST) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'RADIO_ENGINE_TEST no habilitado' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'icy-name': 'Radio Terrapesca (test)',
      'icy-genre': 'Test',
      'icy-url': 'https://terrapesca.com',
      'icy-metaint': '0',
      'X-Content-Type-Options': 'nosniff',
    });
    testStreamClients.add(res);
    console.log(`[stream-test] cliente conectado. Total: ${testStreamClients.size}`);
    startTestEngine();
    req.on('close', () => {
      testStreamClients.delete(res);
      console.log(`[stream-test] cliente desconectado. Total: ${testStreamClients.size}`);
      if (testStreamClients.size === 0) stopTestEngine();
    });
    return;
  }

  // ── /radio/stream-test-rodo — Fase C3: música + Rodo con ducking (behind RADIO_ENGINE_TEST=1) ──
  if (urlPath === '/radio/stream-test-rodo') {
    if (!ENGINE_TEST) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'RADIO_ENGINE_TEST no habilitado' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'icy-name': 'Radio Terrapesca (test + Rodo)',
      'icy-genre': 'Test',
      'icy-url': 'https://terrapesca.com',
      'icy-metaint': '0',
      'X-Content-Type-Options': 'nosniff',
    });
    rodoStreamClients.add(res);
    console.log(`[rodo-engine] cliente conectado. Total: ${rodoStreamClients.size}`);
    startRodoEngine();
    req.on('close', () => {
      rodoStreamClients.delete(res);
      console.log(`[rodo-engine] cliente desconectado. Total: ${rodoStreamClients.size}`);
      if (rodoStreamClients.size === 0) stopRodoEngine();
    });
    return;
  }

  // ── /api/ytaudio/:videoId — direct audio proxy (for <audio> tag fallback) ──
  if (req.url.startsWith('/api/ytaudio/') && req.method === 'GET') {
    if (!ytdl) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ytdl not available' }));
      return;
    }
    const videoId = req.url.replace('/api/ytaudio/', '').split('?')[0].trim();
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    try {
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*'
      });
      const stream = ytdl(url, { filter: 'audioonly', quality: 'highestaudio' });
      stream.pipe(res);
      stream.on('error', () => { try { res.end(); } catch(_) {} });
      req.on('close', () => { try { stream.destroy(); } catch(_) {} });
    } catch(e) {
      try { res.end(); } catch(_) {}
    }
    return;
  }

  // ── /api/ytinfo/:videoId — return stream URL without proxying ──
  if (req.url.startsWith('/api/ytinfo/') && req.method === 'GET') {
    if (!ytdl) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ytdl not available' }));
      return;
    }
    const videoId = req.url.replace('/api/ytinfo/', '').split('?')[0].trim();
    ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`)
      .then(info => {
        const fmt = ytdl.chooseFormat(info.formats, { filter: 'audioonly', quality: 'highestaudio' });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ url: fmt.url, mimeType: fmt.mimeType || 'audio/mp4', title: info.videoDetails.title }));
      })
      .catch(e => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      });
    return;
  }

  // ── Proxy Anthropic ──
  if (req.url === '/api/anthropic' && req.method === 'POST') {
    readLimitedBody(req, res, (body) => {
      const apiKey = req.headers['x-api-key'] || '';
      proxyPost('api.anthropic.com', '/v1/messages', {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }, body, res);
    });
    return;
  }

  // ── Proxy YouTube playlist items (YouTube Data API v3) ──
  if (req.url.startsWith('/api/ytplaylist') && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const playlistId = u.searchParams.get('playlistId') || '';
    const pageToken  = u.searchParams.get('pageToken')  || '';
    const apiKey     = u.searchParams.get('key')        || '';
    if (!playlistId || !apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'playlistId and key required' }));
      return;
    }
    let ytPath = `/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${encodeURIComponent(playlistId)}&key=${encodeURIComponent(apiKey)}`;
    if (pageToken) ytPath += `&pageToken=${encodeURIComponent(pageToken)}`;
    const ytReq = https.request({
      hostname: 'www.googleapis.com',
      path: ytPath,
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    }, (apiRes) => {
      let raw = '';
      apiRes.on('data', chunk => raw += chunk);
      apiRes.on('end', () => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(raw);
      });
    });
    ytReq.on('error', (e) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
    ytReq.setTimeout(PROXY_TIMEOUT_MS, () => { ytReq.destroy(); try { res.writeHead(504, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Tiempo de espera agotado' })); } catch(_) {} });
    ytReq.end();
    return;
  }

  // ── Proxy ElevenLabs TTS ──
  if (req.url.startsWith('/api/elevenlabs/') && req.method === 'POST') {
    readLimitedBody(req, res, (body) => {
      const voiceId = req.url.replace('/api/elevenlabs/', '');
      const apiKey = req.headers['xi-api-key'] || '';
      proxyPost('api.elevenlabs.io', `/v1/text-to-speech/${voiceId}`, {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey
      }, body, res);
    });
    return;
  }

  // ── Proxy CONAGUA SINAV presas ──
  if (req.url.startsWith('/api/conagua') && req.method === 'GET') {
    const siReq = https.request({
      hostname: 'sinav30.conagua.gob.mx',
      port: 8080,
      path: '/Presas/',
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      rejectUnauthorized: false
    }, (apiRes) => {
      let raw = '';
      apiRes.on('data', chunk => raw += chunk);
      apiRes.on('end', () => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(raw);
      });
    });
    siReq.on('error', (e) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    });
    siReq.setTimeout(8000, () => { siReq.destroy(); });
    siReq.end();
    return;
  }

  // ── Proxy YouTube oEmbed ──
  // ── /api/scrape — fetch a URL and return plain text (for spot generator) ──
  if (req.url === '/api/scrape' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let targetUrl;
      try { targetUrl = new URL(JSON.parse(body).url); } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'URL inválida' }));
      }
      const lib = targetUrl.protocol === 'https:' ? https : http;
      const options = {
        hostname: targetUrl.hostname,
        path: targetUrl.pathname + targetUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TerrapescaBot/1.0)',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'es-MX,es;q=0.9',
        },
        timeout: 10000,
      };
      const scrapeReq = lib.request(options, (scrapeRes) => {
        // Follow one redirect
        if ((scrapeRes.statusCode === 301 || scrapeRes.statusCode === 302) && scrapeRes.headers.location) {
          try {
            const redir = new URL(scrapeRes.headers.location, targetUrl.href);
            const rLib = redir.protocol === 'https:' ? https : http;
            const rOpts = { hostname: redir.hostname, path: redir.pathname + redir.search, method: 'GET',
              headers: options.headers, timeout: 10000 };
            const rReq = rLib.request(rOpts, (rRes) => {
              let raw = '';
              rRes.on('data', c => raw += c);
              rRes.on('end', () => {
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ html: raw.slice(0, 80000) }));
              });
            });
            rReq.on('error', e => { try { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); } catch(_) {} });
            rReq.setTimeout(PROXY_TIMEOUT_MS, () => { rReq.destroy(); try { res.writeHead(504); res.end(JSON.stringify({ error: 'Tiempo de espera agotado' })); } catch(_) {} });
            rReq.end();
          } catch(e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
          return;
        }
        let raw = '';
        scrapeRes.on('data', c => raw += c);
        scrapeRes.on('end', () => {
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ html: raw.slice(0, 80000) }));
        });
      });
      scrapeReq.on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      scrapeReq.end();
    });
    return;
  }

  if (req.url.startsWith('/api/ytmeta/') && req.method === 'GET') {
    const videoId = req.url.replace('/api/ytmeta/', '').split('?')[0].trim();
    const oembedPath = `/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`;
    const oReq = https.request({
      hostname: 'www.youtube.com',
      path: oembedPath,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, (apiRes) => {
      let raw = '';
      apiRes.on('data', chunk => raw += chunk);
      apiRes.on('end', () => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(raw);
      });
    });
    oReq.on('error', (e) => {
      try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } catch(_) {}
    });
    oReq.setTimeout(PROXY_TIMEOUT_MS, () => { oReq.destroy(); try { res.writeHead(504, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Tiempo de espera agotado' })); } catch(_) {} });
    oReq.end();
    return;
  }

  // ── Serve static files ──
  if (req.url === '/sw.js') {
    const swPath = path.join(__dirname, 'sw.js');
    if (fs.existsSync(swPath)) {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/' });
      fs.createReadStream(swPath).pipe(res);
    } else {
      res.writeHead(404); res.end();
    }
    return;
  }

  let filePath = null;
  if (req.url === '/' || req.url === '/panel' || req.url === '/panel.html') {
    filePath = path.join(__dirname, 'panel.html');
  } else if (req.url === '/studio' || req.url === '/studio.html') {
    filePath = path.join(__dirname, 'studio.html');
  } else if (req.url === '/tienda' || req.url === '/tienda.html') {
    filePath = path.join(__dirname, 'tienda.html');
  } else if (req.url === '/sucursal' || req.url === '/sucursal.html') {
    filePath = path.join(__dirname, 'sucursal.html');
  } else if (req.url === '/listen' || req.url === '/listen.html') {
    filePath = path.join(__dirname, 'listen.html');
  } else if (ENGINE_TEST && (req.url === '/sucursal-stream' || req.url === '/sucursal-stream.html')) {
    filePath = path.join(__dirname, 'sucursal-stream.html');
  } else if (ENGINE_TEST && (req.url === '/sucursal-stream-rodo' || req.url === '/sucursal-stream-rodo.html')) {
    filePath = path.join(__dirname, 'sucursal-stream-rodo.html');
  }

  if (filePath && fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Terrapesca Radio Server running');
});

// ---- WEBSOCKET ----
const wss = new WebSocketServer({ server });

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === 1) {
      client.send(msg);
    }
  });
}

// Reject jingles larger than this over WS — keeps radioState small and avoids
// re-sending a heavy blob to every new connection. (HTTP delivery is a Fase 2 item.)
const MAX_JINGLE_B64 = 3 * 1024 * 1024; // ~2.2MB of audio

wss.on('connection', (ws) => {
  console.log('Cliente conectado. Total:', wss.clients.size);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ type: 'SYNC', state: radioState }));
  if (radioState.jingleB64) ws.send(JSON.stringify({ type: 'JINGLE_SET', b64: radioState.jingleB64 }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        case 'PLAY':
          radioState.isPlaying = true;
          radioState.currentTrack = msg.track;
          radioState.position = msg.position || 0;
          radioState.lastUpdate = Date.now();
          broadcast({ type: 'PLAY', track: msg.track, position: radioState.position }, ws);
          // Trigger server-side stream for mobile clients
          if (streamClients.size > 0) startStreamTrack(msg.track);
          break;
        case 'PAUSE':
          radioState.isPlaying = false;
          radioState.position = msg.position || 0;
          if (currentStreamDestroy) { currentStreamDestroy(); currentStreamDestroy = null; }
          broadcast({ type: 'PAUSE', position: radioState.position }, ws);
          break;
        case 'RESUME':
          radioState.isPlaying = true;
          radioState.position = msg.position || 0;
          radioState.lastUpdate = Date.now();
          broadcast({ type: 'RESUME', position: radioState.position }, ws);
          if (streamClients.size > 0 && radioState.currentTrack) startStreamTrack(radioState.currentTrack);
          break;
        case 'VOLUME':
          radioState.volume = msg.volume;
          broadcast({ type: 'VOLUME', volume: msg.volume }, ws);
          break;
        case 'PLAYLIST_UPDATE':
          radioState.playlist = msg.playlist;
          broadcast({ type: 'PLAYLIST_UPDATE', playlist: msg.playlist }, ws);
          break;
        case 'SPOT':
          radioState.currentTrack = msg.track;
          radioState.isPlaying = true;
          radioState.position = 0;
          radioState.lastUpdate = Date.now();
          broadcast({ type: 'SPOT', track: msg.track }, ws);
          break;
        case 'JINGLE_SET':
          if (typeof msg.b64 === 'string' && msg.b64.length > MAX_JINGLE_B64) {
            console.warn('[ws] JINGLE_SET rechazado: demasiado grande (', msg.b64.length, 'bytes )');
            break;
          }
          radioState.jingleB64 = msg.b64;
          broadcast({ type: 'JINGLE_SET', b64: msg.b64 }, ws);
          break;
        case 'MIC_ONAIR':
          radioState.micOnAir = msg.active || false;
          broadcast({ type: 'MIC_ONAIR', active: radioState.micOnAir }, ws);
          break;
      }
    } catch (e) {
      console.error('Error:', e.message);
    }
  });

  ws.on('error', () => { try { ws.terminate(); } catch(_) {} });

  ws.on('close', () => {
    console.log('Cliente desconectado. Total:', wss.clients.size);
  });
});

// Heartbeat: every 30s ping all clients; any that didn't answer the previous
// ping (dead/zombie sockets) get terminated so wss.clients can't grow forever.
const _wsHeartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch(_) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch(_) {}
  });
}, 30000);
wss.on('close', () => clearInterval(_wsHeartbeat));

server.listen(PORT, () => {
  console.log(`Terrapesca Radio corriendo en puerto ${PORT}`);
  console.log(`Stream disponible en /radio/stream`);
  console.log(`ytdl-core: ${ytdl ? 'disponible' : 'no disponible'}`);
  if (ENGINE_TEST) {
    console.log(`[stream-test] HABILITADO — /radio/stream-test, /sucursal-stream, /radio/stream-test-rodo, /sucursal-stream-rodo activos`);
  }
});
