const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

// ---- AUDIO EN SEGUNDO PLANO (yt-dlp + ffmpeg → /radio/stream) ----
// yt-dlp extrae el audio de YouTube y ffmpeg lo transcodifica a un MP3 continuo
// que un <audio> del celular sí puede reproducir con la pantalla apagada.
let ytdlpReady = false, ffmpegReady = false;
function _checkBin(bin, args, cb) {
  try {
    const p = spawn(bin, args);
    p.on('error', () => cb(false));
    p.on('close', () => cb(true));
    if (p.stdout) p.stdout.on('data', () => {});
    if (p.stderr) p.stderr.on('data', () => {});
  } catch (_) { cb(false); }
}
_checkBin('yt-dlp', ['--version'], ok => { ytdlpReady = ok; console.log('[audio] yt-dlp', ok ? 'disponible' : 'NO disponible'); });
_checkBin('ffmpeg', ['-version'], ok => { ffmpegReady = ok; console.log('[audio] ffmpeg', ok ? 'disponible' : 'NO disponible'); });

// Red de seguridad: una radio de 24/7 no debe caerse por un error suelto
// (un fallo de yt-dlp/ffmpeg, un socket roto, etc.). Registramos y seguimos.
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e && e.stack || e); });
process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e && e.stack || e); });

// ---- CONTROL DE VERSIONES Y ACTUALIZACIÓN EN VIVO ----
const SERVER_BOOT_TIME = Date.now();
const SERVER_VERSION = process.env.RAILWAY_DEPLOYMENT_ID || process.env.COMMIT_SHA || `ver-${SERVER_BOOT_TIME}`;

// ---- LOGIN / GATE ----
// Todas las páginas (Cabina, Sucursal, Tienda, Panel, Inicio) requieren login.
// EXCEPCIÓN: /listen es pública (la radio para el público).
// Credenciales por variables de entorno (recomendado en Railway) con respaldo por defecto.
// Cuenta por defecto (respaldo). Se puede sobreescribir con TP_USER / TP_PASS.
const AUTH_USER = process.env.TP_USER || 'EDGAR';
const AUTH_PASS = process.env.TP_PASS || '9970002';
// Secreto para firmar las cookies; si no se define, se deriva de las credenciales
// por defecto (basta para un gate simple; en producción define TP_AUTH_SECRET).
const AUTH_SECRET = process.env.TP_AUTH_SECRET || ('tp-radio-' + AUTH_USER + '-' + AUTH_PASS);
const AUTH_COOKIE = 'tp_auth';

// Varios logins sin backend: TP_USERS = "usuario1:clave1,usuario2:clave2,..."
// Cada usuario recibe su propio token (sha256 user:pass:secret). La cuenta por
// defecto (EDGAR o TP_USER/TP_PASS) siempre existe. No hay bibliotecas por usuario
// (eso requiere backend); esto es solo control de acceso con varias credenciales.
function authToken(user, pass) {
  return crypto.createHash('sha256').update(user + ':' + pass + ':' + AUTH_SECRET).digest('hex');
}
function buildUsers() {
  const list = [];
  const seen = new Set();
  const add = (u, p) => {
    u = String(u || '').trim();
    p = String(p || '');
    if (!u || seen.has(u)) return;
    seen.add(u);
    list.push({ user: u, pass: p, token: authToken(u, p) });
  };
  add(AUTH_USER, AUTH_PASS); // cuenta por defecto siempre presente
  (process.env.TP_USERS || '').split(',').forEach(pair => {
    if (!pair.trim()) return;
    const i = pair.indexOf(':');
    if (i < 0) return;
    add(pair.slice(0, i), pair.slice(i + 1));
  });
  return list;
}
const AUTH_USERS = buildUsers();
const AUTH_TOKENS = new Set(AUTH_USERS.map(u => u.token));
// Compat: token de la cuenta por defecto (usado por rutas antiguas si las hubiera).
const AUTH_TOKEN = AUTH_USERS[0].token;

function parseCookies(req) {
  const out = {};
  const raw = req.headers && req.headers.cookie;
  if (!raw) return out;
  raw.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function isAuthed(req) {
  return AUTH_TOKENS.has(parseCookies(req)[AUTH_COOKIE]);
}
function readBody(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => cb(body));
}

let ytdl = null;
try { ytdl = require('@distube/ytdl-core'); } catch(e) { console.warn('ytdl-core not available:', e.message); }

const PORT = process.env.PORT || 3000;

// ---- TIDECHECK: mareas, sol, luna e índice solunar de pesca ----
// La clave vive SOLO en el servidor (variable de entorno), por límite de cuota
// (50/día) y para no exponerla. Añádela en Railway → Variables: TIDECHECK_KEY.
const TIDECHECK_KEY = process.env.TIDECHECK_KEY || '';
const TIDE_ZONES = {
  los_mochis: { point: 'Topolobampo', lat: 25.5819, lng: -109.0592 },
  culiacan:   { point: 'Altata',      lat: 24.6267, lng: -107.9258 },
  mazatlan:   { point: 'Mazatlán',    lat: 23.2028, lng: -106.4133 },
};
const TIDE_FILE = path.join(__dirname, '.tides.json'); // caché 24 h (gitignored)
let _tideCache = {}; // zone -> { ts, stationId, stationName, data }
try { _tideCache = JSON.parse(fs.readFileSync(TIDE_FILE, 'utf8')) || {}; } catch (_) { _tideCache = {}; }
function _tideSave() { try { fs.writeFileSync(TIDE_FILE, JSON.stringify(_tideCache)); } catch (_) {} }
function _tcGet(apiPath, cb) {
  const r = https.request({ hostname: 'tidecheck.com', path: apiPath, method: 'GET', headers: { 'X-API-Key': TIDECHECK_KEY, 'Accept': 'application/json', 'User-Agent': 'terrapesca-radio' } }, (res) => {
    let raw = ''; res.on('data', c => raw += c); res.on('end', () => { try { cb(JSON.parse(raw), res.statusCode); } catch (e) { cb(null, res.statusCode); } });
  });
  r.on('error', () => cb(null, 0));
  r.setTimeout(12000, () => { r.destroy(); cb(null, 0); });
  r.end();
}
// ---- CACHÉ de búsquedas de YouTube (ahorra cuota de la YouTube Data API) ----
// Cada /youtube/v3/search cuesta 100 unidades (10,000/día). Importar una playlist
// de Spotify hace 1 búsqueda por canción; sin caché, reimportar la misma playlist
// (o varias que comparten canciones) agota la cuota rápido. Guardamos query->items
// para que una reimportación cueste ~0 cuota. Mapeo canción→video es estable, TTL 30 días.
const YTS_FILE = path.join(__dirname, '.ytsearch.json'); // caché (gitignored)
const YTS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días
const YTS_MAX = 4000; // tope de entradas para no crecer sin límite
let _ytsCache = {}; // qNorm -> { ts, items }
try { _ytsCache = JSON.parse(fs.readFileSync(YTS_FILE, 'utf8')) || {}; } catch (_) { _ytsCache = {}; }
let _ytsDirty = false, _ytsTimer = null;
function _ytsSaveSoon() {
  _ytsDirty = true;
  if (_ytsTimer) return;
  _ytsTimer = setTimeout(() => {
    _ytsTimer = null;
    if (!_ytsDirty) return;
    _ytsDirty = false;
    try { fs.writeFileSync(YTS_FILE, JSON.stringify(_ytsCache)); } catch (_) {}
  }, 4000); // agrupa escrituras durante una importación
}
function _ytsKey(q) { return String(q || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function _ytsGet(q) {
  const e = _ytsCache[_ytsKey(q)];
  if (e && (Date.now() - e.ts) < YTS_TTL_MS && Array.isArray(e.items)) return e.items;
  return null;
}
function _ytsPut(q, items) {
  if (!Array.isArray(items) || !items.length) return; // no cachear vacíos (reintenta luego)
  const keys = Object.keys(_ytsCache);
  if (keys.length >= YTS_MAX) { // evicción simple: quita las más viejas
    keys.sort((a, b) => (_ytsCache[a].ts || 0) - (_ytsCache[b].ts || 0));
    for (let i = 0; i < Math.ceil(YTS_MAX * 0.1); i++) delete _ytsCache[keys[i]];
  }
  _ytsCache[_ytsKey(q)] = { ts: Date.now(), items };
  _ytsSaveSoon();
}
const _moonES = { 'New Moon': 'luna nueva', 'Waxing Crescent': 'luna creciente', 'First Quarter': 'cuarto creciente', 'Waxing Gibbous': 'gibosa creciente', 'Full Moon': 'luna llena', 'Waning Gibbous': 'gibosa menguante', 'Last Quarter': 'cuarto menguante', 'Waning Crescent': 'luna menguante' };
function _tcHHMM(iso) { const m = String(iso || '').match(/T(\d{2}):(\d{2})/); return m ? m[1] + ':' + m[2] : ''; }
function parseTide(zone, d) {
  const now = Date.now();
  const ex = (d.extremes || [])
    .filter(e => { const t = Date.parse(e.time); return isNaN(t) || t >= now - 30 * 60000; })
    .slice(0, 4)
    .map(e => ({ type: e.type, hhmm: _tcHHMM(e.localTime || e.time), height: Math.round((+e.height || 0) * 100) / 100 }));
  const dc = (d.dailyConditions && d.dailyConditions[0]) || d.conditions || {};
  const periods = (dc.solunarPeriods || []).map(p => ({ type: p.type, start: _tcHHMM(p.startLocal), peak: _tcHHMM(p.peakLocal), end: _tcHHMM(p.endLocal) }));
  return {
    ok: true, zone, point: TIDE_ZONES[zone].point,
    station: (d.station && d.station.name) || '', tz: (d.station && d.station.timezone) || '',
    extremes: ex,
    sunrise: _tcHHMM(dc.sunriseLocal || dc.sunrise), sunset: _tcHHMM(dc.sunsetLocal || dc.sunset),
    moonPhase: _moonES[dc.moonPhase] || dc.moonPhase || '', moonIllum: (dc.moonIllumination != null ? dc.moonIllumination : null),
    solunar: (dc.solunarRating != null ? dc.solunarRating : null), solunarLabel: dc.solunarLabel || '',
    periods, updated: new Date().toISOString(),
  };
}
function buildTideZone(zone, cb) {
  const z = TIDE_ZONES[zone]; if (!z) { cb(null); return; }
  const cached = _tideCache[zone];
  const fresh = cached && cached.data && (Date.now() - cached.ts < 24 * 3600 * 1000);
  if (fresh) { cb(cached.data); return; }
  const withStation = (stationId, stationName) => {
    _tcGet(`/api/station/${encodeURIComponent(stationId)}/tides?days=2&datum=MSL`, (d) => {
      if (!d || !d.station) { cb(cached && cached.data ? cached.data : null); return; }
      const data = parseTide(zone, d);
      _tideCache[zone] = { ts: Date.now(), stationId, stationName: d.station.name || stationName || '', data };
      _tideSave();
      cb(data);
    });
  };
  if (cached && cached.stationId) { withStation(cached.stationId, cached.stationName); return; }
  // Resolver la estación más cercana (una sola vez; luego se guarda el ID).
  _tcGet(`/api/stations/nearest?lat=${z.lat}&lng=${z.lng}`, (d) => {
    const st = (d && (d.station || d)) || {};
    const id = st.id || st.stationId || (d && d.id);
    if (!id) { cb(cached && cached.data ? cached.data : null); return; }
    withStation(id, st.name || '');
  });
}

// Caché del pronóstico oficial SMN (CONAGUA). Los Mochis = municipio Ahome.
let _smnCache = null, _smnTs = 0;
const SMN_TARGETS = { culiacan: ['culiacán', 'culiacan'], mazatlan: ['mazatlán', 'mazatlan'], los_mochis: ['ahome'] };
// Lee el archivo del SMN en streaming (gzip) y extrae solo las 3 ciudades objetivo,
// tomando la hora más cercana a "ahora" (nhor 0). No carga todo el archivo en memoria.
function smnExtract(pathUrl, cb) {
  const zlib2 = zlib;
  const N = v => { const n = parseFloat(String(v).replace(',', '.')); return isNaN(n) ? null : n; };
  const MUNI2KEY = { 'culiacán': 'culiacan', 'culiacan': 'culiacan', 'mazatlán': 'mazatlan', 'mazatlan': 'mazatlan', 'ahome': 'los_mochis' };
  const out = {}; let partial = ''; let finished = false; let processed = 0; let done = false;
  const req2 = https.request({ hostname: 'smn.conagua.gob.mx', path: pathUrl, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'gzip' } }, (r2) => {
    const finish = (err) => {
      if (finished) return; finished = true;
      try { r2.destroy(); } catch (_) {}
      const keys = Object.keys(out);
      keys.forEach(k => { delete out[k]._nh; });
      cb(keys.length ? out : null, err);
    };
    const onText = (txt) => {
      if (done) return;
      partial += txt; processed += txt.length;
      if (processed > 200 * 1024 * 1024) { done = true; finish('too big'); return; }
      let start;
      while ((start = partial.indexOf('{')) !== -1) {
        let depth = 0, end = -1, inStr = false, esc = false;
        for (let i = start; i < partial.length; i++) {
          const ch = partial[i];
          if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
          if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
        }
        if (end === -1) { if (start > 0) partial = partial.slice(start); break; }
        const objStr = partial.slice(start, end + 1);
        partial = partial.slice(end + 1);
        let o; try { o = JSON.parse(objStr); } catch (_) { continue; }
        const key = MUNI2KEY[String(o.nmun || o.name || '').toLowerCase().trim()];
        if (!key) continue;
        const isSin = String(o.nes || o.state || '').toLowerCase().includes('sinaloa') || String(o.ides || '') === '25';
        if (!isSin) continue;
        const nh = (o.nhor != null) ? N(o.nhor) : null;
        const hourly = (o.temp != null && nh != null);
        const cand = hourly
          ? { city: o.nmun || o.name, temp: N(o.temp), prob: N(o.probprec), cielo: o.desciel || '', viento: N(o.velvien), dir: o.dirvienc || '', hr: N(o.hr), _nh: (nh >= 0 ? nh : 9999) }
          : { city: o.nmun || o.name, prob: N(o.probprec), tmax: N(o.tmax), tmin: N(o.tmin), cielo: o.desciel || '', viento: N(o.velvien), dir: o.dirvienc || '', _nh: 0 };
        if (!out[key] || cand._nh < out[key]._nh) out[key] = cand;
        if (out.culiacan && out.mazatlan && out.los_mochis && [out.culiacan, out.mazatlan, out.los_mochis].every(x => x._nh <= 1)) { done = true; finish(); return; }
      }
    };
    const gunzip = zlib2.createGunzip();
    gunzip.on('data', c => onText(c.toString('utf8')));
    gunzip.on('end', () => finish());
    gunzip.on('error', () => finish('gunzip'));
    r2.on('error', () => finish('stream'));
    r2.pipe(gunzip);
  });
  req2.on('error', () => { if (!finished) { finished = true; cb(null, 'request'); } });
  req2.setTimeout(30000, () => { try { req2.destroy(); } catch (_) {} if (!finished) { finished = true; cb(null, 'timeout'); } });
  req2.end();
}

let radioState = {
  currentTrack: null,
  isPlaying: false,
  position: 0,
  volume: 80,
  playlist: [],
  autopilotOn: false,
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

// Extrae audio con yt-dlp y lo transcodifica a MP3 continuo con ffmpeg.
function streamYouTubeYtdlp(videoId, gen) {
  return new Promise((resolve, reject) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    let yt = null, ff = null, settled = false;
    const finish = (fn, arg) => {
      if (settled) return; settled = true;
      try { yt && yt.kill('SIGKILL'); } catch (_) {}
      try { ff && ff.kill('SIGKILL'); } catch (_) {}
      if (gen === streamGen) { currentStreamDestroy = null; streamBusy = false; }
      fn(arg);
    };
    try {
      yt = spawn('yt-dlp', ['-q', '--no-warnings', '--no-playlist', '-f', 'bestaudio/best', '-o', '-', url]);
      ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '2', '-ar', '44100', '-b:a', '128k', '-f', 'mp3', 'pipe:1']);
    } catch (e) { finish(reject, e); return; }
    // Cancelar (nueva pista) = terminar en silencio.
    currentStreamDestroy = () => finish(resolve);
    yt.on('error', e => finish(reject, e));
    ff.on('error', e => finish(reject, e));
    // Blindaje: ningún stream hijo puede tumbar el servidor (EPIPE, etc.).
    yt.stdout.on('error', () => {});
    yt.stderr.on('error', () => {});
    ff.stdin.on('error', () => {});
    ff.stdout.on('error', () => {});
    ff.stderr.on('error', () => {});
    ff.stderr.on('data', () => {}); // drenar stderr para que no bloquee a ffmpeg
    yt.stderr.on('data', d => { const s = d.toString(); if (/error/i.test(s)) console.error('[yt-dlp]', s.trim().slice(0, 180)); });
    ff.stdout.on('data', chunk => { if (gen === streamGen) writeToStreamClients(chunk); });
    try { yt.stdout.pipe(ff.stdin); } catch (e) { finish(reject, e); return; }
    ff.on('close', () => finish(resolve));
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

  if (track.ytId && ytdlpReady && ffmpegReady) {
    // Motor nuevo: yt-dlp + ffmpeg (audio en segundo plano, robusto).
    streamBusy = true;
    console.log('[stream] start yt-dlp', track.ytId, '(gen', gen + ')');
    streamYouTubeYtdlp(track.ytId, gen)
      .then(() => { if (gen === streamGen) streamBusy = false; })
      .catch(e => { console.error('[stream] yt-dlp error for', track.ytId, e && e.message); if (gen === streamGen) streamBusy = false; });
  } else if (track.ytId && ytdl) {
    // Respaldo: ytdl-core (si yt-dlp/ffmpeg no están disponibles).
    streamBusy = true;
    console.log('[stream] start ytdl', track.ytId, '(gen', gen + ')');
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
  } else if (track.url && typeof track.url === 'string' && track.url.startsWith('/')) {
    try {
      const p = path.join(__dirname, 'public', track.url);
      if (fs.existsSync(p)) {
        streamBusy = true;
        console.log('[stream] start local audio (gen', gen + ')', track.url);
        const buf = fs.readFileSync(p);
        streamAudioBuffer(buf, gen)
          .then(() => { if (gen === streamGen) streamBusy = false; })
          .catch(() => { if (gen === streamGen) streamBusy = false; });
      }
    } catch (_) {}
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

// ---- HTTP PROXY HELPERS ----
const PROXY_TIMEOUT_MS = 60000;       // upstream APIs must answer within 60s (TTS puede tardar)
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

// Returns true if AI spot generation is allowed right now (9:00–17:59 America/Mazatlan).
// Override for local testing: AI_SPOT_TEST_TIME=HH:MM
function aiHoursAllowed() {
  let h, m;
  const testTime = process.env.AI_SPOT_TEST_TIME;
  if (testTime && /^\d{1,2}:\d{2}$/.test(testTime)) {
    [h, m] = testTime.split(':').map(Number);
  } else {
    const mzt = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Mazatlan' }));
    h = mzt.getHours();
    m = mzt.getMinutes();
  }
  const mins = h * 60 + m;
  return mins >= 9 * 60 && mins < 18 * 60; // 09:00 to 17:59
}

// Extrae [{title,artist}] de la página embed pública de una playlist de Spotify.
// Spotify no permite retransmitir su audio (DRM); esto SOLO lee metadatos para
// luego resolver cada canción en YouTube. Es best-effort: si Spotify cambia el
// formato del embed, el recorrido recursivo intenta hallar la lista igualmente.
function parseSpotifyEmbed(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('formato de Spotify no reconocido');
  const data = JSON.parse(m[1]);
  let name = 'Playlist de Spotify';
  try { name = data.props.pageProps.state.data.entity.name || name; } catch (_) {}
  let list = null;
  try {
    const tl = data.props.pageProps.state.data.entity.trackList;
    if (Array.isArray(tl) && tl.length) list = tl;
  } catch (_) {}
  if (!list) {
    // Fallback: buscar recursivamente un arreglo de objetos {title,subtitle}.
    const found = [];
    (function walk(o) {
      if (!o || typeof o !== 'object' || found.length) return;
      if (Array.isArray(o)) {
        if (o.length && o.every(x => x && typeof x === 'object' &&
            typeof x.title === 'string' && typeof x.subtitle === 'string')) {
          found.push(o); return;
        }
        for (const it of o) walk(it);
      } else {
        for (const k in o) walk(o[k]);
      }
    })(data);
    if (found.length) list = found[0];
  }
  if (!list) throw new Error('la playlist no trae canciones (¿privada o vacía?)');
  const tracks = list
    .map(t => ({ title: String(t.title || '').trim(), artist: String(t.subtitle || '').trim() }))
    .filter(t => t.title)
    .slice(0, 200);
  return { name, count: tracks.length, tracks };
}

function _clientIP(req) {
  const xf = (req.headers && req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xf || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
}

const _loginRateLimit = new Map(); // ip -> { count, resetAt }
function checkLoginRateLimit(ip) {
  const now = Date.now();
  const entry = _loginRateLimit.get(ip);
  if (entry && entry.resetAt > now) {
    if (entry.count >= 10) return false;
    entry.count++;
  } else {
    _loginRateLimit.set(ip, { count: 1, resetAt: now + 60000 });
  }
  return true;
}
function recordLoginSuccess(ip) {
  _loginRateLimit.delete(ip);
}

// ---- HTTP SERVER ----
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, xi-api-key, x-api-key, x-openai-key, api-key, userid, x-shopify-shop, x-shopify-token, anthropic-version');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Login: valida credenciales y setea cookie httpOnly con rate-limit ──
  if (req.url === '/api/login' && req.method === 'POST') {
    const ip = _clientIP(req);
    if (!checkLoginRateLimit(ip)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Demasiados intentos fallidos. Espera 1 minuto antes de reintentar.' }));
      return;
    }
    readBody(req, (body) => {
      let user = '', pass = '';
      try { const j = JSON.parse(body || '{}'); user = String(j.user || '').trim(); pass = String(j.pass || ''); } catch (_) {}
      const match = AUTH_USERS.find(u => u.user.toUpperCase() === user.toUpperCase() && u.pass === pass);
      if (match) {
        recordLoginSuccess(ip);
        const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
        res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${match.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Usuario o contraseña incorrectos' }));
      }
    });
    return;
  }

  // ── Logout: borra la cookie ──
  if (req.url === '/api/logout' && (req.method === 'POST' || req.method === 'GET')) {
    res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    if (req.method === 'GET') { res.writeHead(302, { Location: '/' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Health check ──
  if (req.url === '/health' || req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      clients: wss.clients.size,
      streamClients: streamClients.size,
      streamBusy,
      ytdlAvailable: !!ytdl,
      ytdlpReady,   // true = yt-dlp instalado (motor de audio en segundo plano)
      ffmpegReady,  // true = ffmpeg instalado
      tideKeySet: !!TIDECHECK_KEY, // true = el servidor SÍ ve TIDECHECK_KEY (no expone la clave)
      users: AUTH_USERS.length  // número de logins activos (no expone nombres ni claves)
    }));
    return;
  }

  // ── /radio/stream — continuous HTTP audio stream ──
  const urlPath = req.url.split('?')[0].replace(/\/+$/, '') || '/';
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
    if (req.headers['x-tp-ai-spot'] === '1') {
      const allowed = aiHoursAllowed();
      console.log(allowed ? '[ai-hours] permitido' : '[ai-hours] bloqueado fuera de horario');
      if (!allowed) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Generación de IA fuera de horario. Permitido solo de 9:00 AM a 6:00 PM.' }));
        return;
      }
    }
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

  // ── Proxy YouTube search (Fase 2 plan Spotify) ──
function searchYouTubeNoKey(q) {
  return new Promise((resolve) => {
    const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q + ' audio');
    const sReq = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8'
      },
      timeout: 10000
    }, res => {
      let html = '';
      res.on('data', chunk => { if (html.length < 2 * 1024 * 1024) html += chunk; });
      res.on('end', () => {
        try {
          const match = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData\s*=\s*({.+?});/);
          if (!match) return resolve([]);
          const data = JSON.parse(match[1]);
          const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];
          const results = [];
          for (const item of contents) {
            const vr = item.videoRenderer;
            if (vr && vr.videoId) {
              const title = vr.title?.runs?.[0]?.text || '';
              const channel = vr.ownerText?.runs?.[0]?.text || '';
              const durText = vr.lengthText?.simpleText || '';
              let duration = 0;
              if (durText) {
                const parts = durText.split(':').map(Number);
                if (parts.length === 2) duration = parts[0] * 60 + parts[1];
                else if (parts.length === 3) duration = parts[0] * 3600 + parts[1] * 60 + parts[2];
              }
              results.push({
                ytId: vr.videoId,
                title,
                channel,
                duration: duration || 210,
                thumb: `https://img.youtube.com/vi/${vr.videoId}/mqdefault.jpg`
              });
              if (results.length >= 8) break;
            }
          }
          resolve(results);
        } catch (_) { resolve([]); }
      });
    });
    sReq.on('error', () => resolve([]));
    sReq.on('timeout', () => { sReq.destroy(); resolve([]); });
  });
}

  // GET /api/ytsearch?q=...&key=... → busca videos de música y devuelve
  // items:[{ytId,title,channel,thumb,duration}] con duración en segundos
  // (search.list + videos.list o búsqueda directa sin key cuando no hay cuota).
  if (req.url.startsWith('/api/ytsearch') && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const q      = u.searchParams.get('q')   || '';
    const apiKey = u.searchParams.get('key') || '';
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'q required' }));
      return;
    }
    // Caché: si ya resolvimos esta búsqueda antes, la devolvemos sin gastar
    // cuota de YouTube (reimportar una playlist cuesta ~0).
    const cached = _ytsGet(q);
    if (cached) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: cached, cached: true }));
      return;
    }
    const getJson = (path) => new Promise((resolve, reject) => {
      const r = https.request({ hostname: 'www.googleapis.com', path, method: 'GET', headers: { 'Accept': 'application/json' } }, (apiRes) => {
        let raw = '';
        apiRes.on('data', c => raw += c);
        apiRes.on('end', () => {
          try { resolve({ status: apiRes.statusCode, json: JSON.parse(raw) }); }
          catch (e) { reject(new Error('Respuesta inválida de YouTube')); }
        });
        apiRes.on('error', reject);
      });
      r.on('error', reject);
      r.setTimeout(PROXY_TIMEOUT_MS, () => { r.destroy(); reject(new Error('Tiempo de espera agotado')); });
      r.end();
    });
    const iso8601ToSecs = (iso) => {
      const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
      if (!m) return 0;
      return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
    };
    (async () => {
      let items = [];
      if (apiKey) {
        try {
          const sr = await getJson(`/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=8&q=${encodeURIComponent(q)}&key=${encodeURIComponent(apiKey)}`);
          if (sr.status === 200) {
            items = (sr.json.items || []).filter(it => it.id && it.id.videoId).map(it => ({
              ytId: it.id.videoId,
              title: it.snippet?.title || 'YouTube',
              channel: it.snippet?.channelTitle || '',
              thumb: it.snippet?.thumbnails?.medium?.url || `https://img.youtube.com/vi/${it.id.videoId}/mqdefault.jpg`,
              duration: 0,
            }));
            if (items.length) {
              try {
                const vr = await getJson(`/youtube/v3/videos?part=contentDetails&id=${items.map(i => i.ytId).join(',')}&key=${encodeURIComponent(apiKey)}`);
                const durs = {};
                (vr.json.items || []).forEach(v => { durs[v.id] = iso8601ToSecs(v.contentDetails?.duration); });
                items.forEach(i => { i.duration = durs[i.ytId] || 0; });
              } catch (_) {}
            }
          }
        } catch (_) {}
      }

      // Si no hay key o falló la API oficial (cuota o error), usar búsqueda directa sin key
      if (!items || !items.length) {
        items = await searchYouTubeNoKey(q);
      }

      if (items && items.length) {
        _ytsPut(q, items);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: items || [] }));
    })().catch(e => {
      searchYouTubeNoKey(q).then(items => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: items || [] }));
      }).catch(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [] }));
      });
    });
    return;
  }

  // ── Duraciones de videos (para la Radio 24/7) ──
  // GET /api/ytdur?ids=a,b,c&key=... → { durations: {id: segundos} }
  if (req.url.startsWith('/api/ytdur') && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const ids    = (u.searchParams.get('ids') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 50);
    const apiKey = u.searchParams.get('key') || '';
    if (!ids.length || !apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ids and key required' }));
      return;
    }
    const path = `/youtube/v3/videos?part=contentDetails&id=${ids.map(encodeURIComponent).join(',')}&key=${encodeURIComponent(apiKey)}`;
    const r = https.request({ hostname: 'www.googleapis.com', path, method: 'GET', headers: { 'Accept': 'application/json' } }, (apiRes) => {
      let raw = ''; apiRes.on('data', c => raw += c);
      apiRes.on('end', () => {
        const durations = {};
        try {
          const j = JSON.parse(raw);
          (j.items || []).forEach(v => {
            const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(v.contentDetails?.duration || '');
            durations[v.id] = m ? (+m[1]||0)*3600 + (+m[2]||0)*60 + (+m[3]||0) : 0;
          });
        } catch (_) {}
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ durations }));
      });
    });
    r.on('error', (e) => { try { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } catch (_) {} });
    r.setTimeout(PROXY_TIMEOUT_MS, () => { r.destroy(); try { res.writeHead(504); res.end('{}'); } catch (_) {} });
    r.end();
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

  // ── API Versión y Estado del Servidor (para auto-recarga de oyentes y cabina) ──
  if (urlPath === '/api/version') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(JSON.stringify({
      ok: true,
      version: SERVER_VERSION,
      bootTime: SERVER_BOOT_TIME,
      autopilotOn: !!radioState.autopilotOn,
      isPlaying: !!radioState.isPlaying
    }));
    return;
  }

  // ── API Playlist Compartida de Cabina (GET / POST) ──
  // Sincroniza la playlist de Cabina con la Radio 24/7 y los oyentes
  if (urlPath === '/api/playlist') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const plFile = path.join(__dirname, '.playlist.json');
    if (req.method === 'GET') {
      try {
        if (fs.existsSync(plFile)) {
          const content = fs.readFileSync(plFile, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(content);
          return;
        }
      } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ playlist: (radioState.playlist && radioState.playlist.length) ? radioState.playlist : autopilot.list }));
      return;
    }

    if (req.method === 'POST') {
      readLimitedBody(req, res, (body) => {
        try {
          const data = JSON.parse(body);
          const list = Array.isArray(data) ? data : (data.playlist || []);
          if (Array.isArray(list) && list.length) {
            radioState.playlist = list;
            try { fs.writeFileSync(plFile, JSON.stringify(list)); } catch (_) {}
            
            const valid = list.filter(x => x && x.ytId).map(x => ({
              ytId: x.ytId,
              name: x.name || x.title || '',
              artist: x.artist || x.channelTitle || '',
              duration: +x.duration || 210
            }));
            if (valid.length) {
              autopilot.list = valid;
              _apHistory = [];
              if (autopilot.idx >= valid.length) autopilot.idx = 0;
              _apSave();
              _apUpdatePreview();
              console.log(`[API] Playlist de cabina sincronizada (${valid.length} canciones) — baraja aleatoria lista`);
            }
            broadcast({ type: 'PLAYLIST_UPDATE', playlist: list });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, count: list.length }));
            return;
          }
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Playlist inválida o vacía' }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }

  // ── Sincronización de spots de audio (personalizados de cabina y oficiales) ──
  if (req.url.startsWith('/api/spots')) {
    const spFile = path.join(__dirname, '.spots_custom.json');
    if (req.method === 'GET') {
      let list = [];
      try {
        if (fs.existsSync(spFile)) list = JSON.parse(fs.readFileSync(spFile, 'utf8')) || [];
      } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(list));
      return;
    }

    if (req.method === 'POST') {
      readLimitedBody(req, res, (body) => {
        try {
          const data = JSON.parse(body);
          const rawList = Array.isArray(data) ? data : (data.spots || []);
          const spotsDir = path.join(__dirname, 'public', 'spots');
          if (!fs.existsSync(spotsDir)) fs.mkdirSync(spotsDir, { recursive: true });

          const savedList = rawList.map((s, idx) => {
            const sid = s.id || ('spot_' + Date.now() + '_' + idx);
            let sUrl = s.url || '';
            if (!sUrl && s.b64) {
              try {
                const fname = `${sid}.mp3`;
                fs.writeFileSync(path.join(spotsDir, fname), Buffer.from(s.b64, 'base64'));
                sUrl = `/spots/${fname}`;
              } catch (_) {}
            }
            return {
              id: sid,
              name: s.name || 'Spot Personalizado',
              bed: s.bed || 'none',
              mime: s.mime || 'audio/mpeg',
              url: sUrl,
              b64: sUrl ? '' : (s.b64 || ''),
              duration: s.duration || 28
            };
          });

          customSpots = savedList;
          try { fs.writeFileSync(spFile, JSON.stringify(customSpots, null, 2)); } catch (_) {}
          console.log(`[API] Spots personalizados sincronizados (${customSpots.length} spots)`);
          broadcast({ type: 'SPOTS_LIBRARY_UPDATE', spots: customSpots });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, count: customSpots.length }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }

  // ── Feed público de productos (para el carrusel de /listen) ──
  // Shopify expone /products.json público (sin token). No requiere credenciales.
  if (req.url.startsWith('/api/shop-feed') && req.method === 'GET') {
    const fr = https.request({
      hostname: 'www.terrapesca.com', path: '/products.json?limit=50', method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TerrapescaRadio/1.0)', 'Accept': 'application/json' }, timeout: 10000
    }, (fRes) => {
      let raw = '', size = 0, aborted = false;
      fRes.on('data', c => { if (aborted) return; size += c.length; if (size > MAX_PROXY_BYTES) { aborted = true; fRes.destroy(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ products: [] })); return; } raw += c; });
      fRes.on('end', () => {
        if (aborted) return;
        res.setHeader('Access-Control-Allow-Origin', '*');
        try {
          const j = JSON.parse(raw);
          const products = (j.products || []).map(p => ({
            title: p.title,
            price: (p.variants && p.variants[0] && p.variants[0].price) || '',
            image: (p.images && p.images[0] && p.images[0].src) || '',
            url: 'https://www.terrapesca.com/products/' + p.handle
          })).filter(p => p.image).slice(0, 30);
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600' });
          res.end(JSON.stringify({ products }));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ products: [], error: 'parse' }));
        }
      });
    });
    fr.on('error', (e) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ products: [], error: e.message })); });
    fr.setTimeout(10000, () => { fr.destroy(); });
    fr.end();
    return;
  }

  // ── Proxy Shopify Storefront API (buscar productos para spots) ──
  // El cliente manda la query GraphQL + su dominio y token (solo-lectura de
  // productos) por header. El servidor no guarda credenciales.
  if (req.url === '/api/shopify/products' && req.method === 'POST') {
    readLimitedBody(req, res, (body) => {
      const shop = String(req.headers['x-shopify-shop'] || '').replace(/^https?:\/\//,'').replace(/\/.*$/,'').replace(/[^a-zA-Z0-9.\-]/g,'');
      const token = String(req.headers['x-shopify-token'] || '').replace(/[^\x21-\x7E]/g,'');
      if (!shop || !token) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Falta el dominio o el token de Shopify' })); }
      proxyPost(shop, '/api/2024-10/graphql.json', {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': token
      }, body, res);
    });
    return;
  }

  // ── Proxy VoiceKiller TTS (motor de voz alternativo) ──
  // El cliente manda {script,voice_name,instructions} y sus credenciales por
  // header (api-key + userid). El servidor no las guarda. Devuelve MP3 directo,
  // que proxyPost detecta (audio/mpeg) y transmite tal cual.
  if (req.url === '/api/voicekiller/tts' && req.method === 'POST') {
    readLimitedBody(req, res, (body) => {
      proxyPost('voicekiller.com', '/api/generate-speech', {
        'Content-Type': 'application/json',
        'api-key': req.headers['api-key'] || '',
        'userid': req.headers['userid'] || ''
      }, body, res);
    });
    return;
  }

  // ── Proxy OpenAI TTS (voz para DJ Rodo + spots) ──
  // The client posts {model,input,voice,instructions,response_format} and holds the
  // key itself (x-openai-key). Server never stores it — same model as ElevenLabs.
  // proxyPost detects the audio/mpeg response and streams it back untouched.
  if (req.url === '/api/openai/tts' && req.method === 'POST') {
    readLimitedBody(req, res, (body) => {
      const apiKey = req.headers['x-openai-key'] || '';
      proxyPost('api.openai.com', '/v1/audio/speech', {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      }, body, res);
    });
    return;
  }

  // ── Proxy OpenAI Chat Completions (guiones para spots + intervenciones) ──
  if (req.url === '/api/openai/chat' && req.method === 'POST') {
    readLimitedBody(req, res, (body) => {
      const apiKey = req.headers['x-openai-key'] || '';
      proxyPost('api.openai.com', '/v1/chat/completions', {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      }, body, res);
    });
    return;
  }

  // ── Importar playlist o album público de Spotify (título+artista) ──
  // Lee SOLO metadatos de la página embed pública; el cliente resuelve cada
  // canción en YouTube (que sí se puede transmitir a las sucursales).
  if ((req.url.startsWith('/api/spotify/playlist') || req.url.startsWith('/api/spotify/album')) && req.method === 'GET') {
    let id = '';
    const isAlbum = req.url.startsWith('/api/spotify/album');
    try { id = (new URL(req.url, 'http://x').searchParams.get('id') || '').replace(/[^A-Za-z0-9]/g, ''); } catch (_) {}
    if (!id) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Falta el id de Spotify' })); }
    const sReq = https.request({
      hostname: 'open.spotify.com',
      path: `/${isAlbum ? 'embed/album' : 'embed/playlist'}/${id}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TerrapescaRadio/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-MX,es;q=0.9'
      },
      timeout: 12000
    }, (sRes) => {
      let raw = '', size = 0, aborted = false;
      sRes.on('error', () => { try { sRes.destroy(); } catch (_) {} });
      sRes.on('data', c => {
        if (aborted) return;
        size += c.length;
        if (size > MAX_PROXY_BYTES) { aborted = true; sRes.destroy(); res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Respuesta demasiado grande' })); return; }
        raw += c;
      });
      sRes.on('end', () => {
        if (aborted) return;
        res.setHeader('Access-Control-Allow-Origin', '*');
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(parseSpotifyEmbed(raw)));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No se pudo leer la lista de Spotify: ' + e.message }));
        }
      });
    });
    sReq.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); });
    sReq.setTimeout(12000, () => { sReq.destroy(); });
    sReq.end();
    return;
  }

  // ── Importar canción individual de Spotify ──
  if (req.url.startsWith('/api/spotify/track') && req.method === 'GET') {
    let id = '';
    try { id = (new URL(req.url, 'http://x').searchParams.get('id') || '').replace(/[^A-Za-z0-9]/g, ''); } catch (_) {}
    if (!id) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Falta el id de la canción' })); }
    const sReq = https.request({
      hostname: 'open.spotify.com',
      path: `/embed/track/${id}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TerrapescaRadio/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'es-MX,es;q=0.9'
      },
      timeout: 10000
    }, (sRes) => {
      let raw = '';
      sRes.on('data', c => { if (raw.length < 500000) raw += c; });
      sRes.on('end', () => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        try {
          const m = raw.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
          if (m) {
            const data = JSON.parse(m[1]);
            const entity = data.props?.pageProps?.state?.data?.entity;
            if (entity) {
              const title = entity.name || '';
              const artist = (entity.artists && entity.artists[0]?.name) || '';
              res.writeHead(200, { 'Content-Type': 'application/json' });
              return res.end(JSON.stringify({ title, artist }));
            }
          }
          const tm = raw.match(/<title>([^<]+)<\/title>/i);
          if (tm) {
            const parts = tm[1].replace(/ \| Spotify$/, '').split(' - ');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ title: parts[0]?.trim() || '', artist: parts[1]?.trim() || '' }));
          }
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No se pudo leer la canción' }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    });
    sReq.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); });
    sReq.end();
    return;
  }

  // ── TideCheck: mareas, sol/luna e índice solunar (1 consulta por zona al día, caché 24 h) ──
  if (req.url.startsWith('/api/tides') && req.method === 'GET') {
    const send = (o) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!TIDECHECK_KEY) { send({ ok: false, error: 'Servicio de mareas temporalmente no disponible' }); return; }
    let zone = ''; try { zone = (new URL(req.url, 'http://x').searchParams.get('zone') || '').toLowerCase(); } catch (_) {}
    if (!TIDE_ZONES[zone]) zone = 'culiacan';
    buildTideZone(zone, (data) => { send(data || { ok: false, error: 'sin datos de mareas' }); });
    return;
  }

  // ── SMN CONAGUA: pronóstico oficial por municipio (prob. de lluvia, cielo). ──
  // El archivo del SMN es enorme (~100 MB al descomprimir), así que lo leemos en
  // STREAMING y extraemos solo Culiacán/Mazatlán/Ahome sin cargar todo en memoria.
  if (req.url.startsWith('/api/smn') && req.method === 'GET') {
    const send = (obj) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (_smnCache && Date.now() - _smnTs < 2 * 3600 * 1000) { send(_smnCache); return; }
    smnExtract('/webservices/?method=1', (out1) => {
      if (out1) { _smnCache = out1; _smnTs = Date.now(); send(out1); return; }
      smnExtract('/webservices/?method=3', (out3) => {
        if (out3) { _smnCache = out3; _smnTs = Date.now(); send(out3); }
        else send({ ok: false, error: 'sin datos del SMN' });
      });
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
  // Núcleo compartido JS (Fase A): sirve /core/<nombre>.js del repo.
  // Nombre saneado a [a-z0-9_-] para no salir del directorio.
  {
    const mCore = (req.url.split('?')[0]).match(/^\/core\/([a-z0-9_\-]+\.js)$/i);
    if (mCore) {
      const cPath = path.join(__dirname, 'core', mCore[1]);
      if (fs.existsSync(cPath)) {
        res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
        fs.createReadStream(cPath).pipe(res);
      } else { res.writeHead(404); res.end(); }
      return;
    }
  }

  if (urlPath === '/sw.js') {
    const swPath = path.join(__dirname, 'sw.js');
    if (fs.existsSync(swPath)) {
      res.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Service-Worker-Allowed': '/',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      fs.createReadStream(swPath).pipe(res);
    } else {
      res.writeHead(404); res.end();
    }
    return;
  }

  // Jingles/fondos empaquetados: sirve cualquier jingle-*.mp3 del repo (Terrapesca,
  // Costa Kayaks, etc.). Nombre saneado a [a-z0-9-] para no salir del directorio.
  if (/^\/jingle-[a-z0-9\-]+\.mp3$/i.test(req.url)) {
    const fname = req.url.slice(1).replace(/[^a-z0-9.\-]/gi, '');
    const jPath = path.join(__dirname, fname);
    if (fs.existsSync(jPath)) {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(jPath).pipe(res);
    } else {
      res.writeHead(404); res.end();
    }
    return;
  }

  // Intervenciones de DJ Rodo (hora, consejos, identificaciones)
  {
    const mRodo = (req.url.split('?')[0]).match(/^\/rodo\/([a-z0-9_\-.]+)$/i);
    if (mRodo) {
      const rPath = path.join(__dirname, 'public', 'rodo', mRodo[1]);
      if (fs.existsSync(rPath)) {
        const stat = fs.statSync(rPath);
        const ext = path.extname(rPath).toLowerCase();
        const cType = ext === '.json' ? 'application/json' : 'audio/mpeg';
        res.writeHead(200, {
          'Content-Type': cType,
          'Content-Length': stat.size,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*'
        });
        fs.createReadStream(rPath).pipe(res);
        return;
      }
    }
  }

  // Spots personalizados subidos o creados en Cabina
  {
    const mSpot = (req.url.split('?')[0]).match(/^\/spots\/([a-z0-9_\-.]+)$/i);
    if (mSpot) {
      const sPath = path.join(__dirname, 'public', 'spots', mSpot[1]);
      if (fs.existsSync(sPath)) {
        const stat = fs.statSync(sPath);
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': stat.size,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=86400',
          'Access-Control-Allow-Origin': '*'
        });
        fs.createReadStream(sPath).pipe(res);
        return;
      }
    }
  }

  // Buen Fin assets (fotos, QRs, audios locales de spots, videos MP4)
  {
    const mBf = (req.url.split('?')[0]).match(/^\/buenfin\/([a-z0-9_\-.]+)$/i);
    if (mBf) {
      const bPath = path.join(__dirname, 'public', 'buenfin', mBf[1]);
      if (fs.existsSync(bPath)) {
        const ext = path.extname(bPath).toLowerCase();
        const types = {
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.mp3': 'audio/mpeg',
          '.mp4': 'video/mp4',
          '.webm': 'video/webm',
          '.json': 'application/json'
        };
        const stat = fs.statSync(bPath);
        const contentType = types[ext] || 'application/octet-stream';
        const cacheHeader = (ext === '.json' || ext === '.html')
          ? 'no-cache, no-store, must-revalidate'
          : 'public, max-age=86400';

        if (req.method === 'HEAD') {
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stat.size,
            'Accept-Ranges': 'bytes',
            'Cache-Control': cacheHeader,
            'Access-Control-Allow-Origin': '*'
          });
          res.end();
          return;
        }

        const range = req.headers.range;
        if (range && ext === '.mp4') {
          const parts = range.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
          const chunksize = (end - start) + 1;
          const file = fs.createReadStream(bPath, { start, end });
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*'
          });
          file.pipe(res);
          return;
        }

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': stat.size,
          'Accept-Ranges': 'bytes',
          'Cache-Control': cacheHeader,
          'Access-Control-Allow-Origin': '*'
        });
        fs.createReadStream(bPath).pipe(res);
        return;
      }
    }
  }

  // PWA Web App Manifest (Instalable en Android, iOS y Escritorio)
  if (urlPath === '/manifest.json') {
    res.writeHead(200, {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    });
    res.end(JSON.stringify({
      id: "/listen",
      name: "Radio Terrapesca 24/7",
      short_name: "Radio TP",
      description: "Radio oficial Terrapesca — Transmisión continua 24/7 de música y pesca deportiva",
      start_url: "/listen?utm_source=pwa",
      scope: "/",
      display: "standalone",
      orientation: "portrait-primary",
      background_color: "#040914",
      theme_color: "#e0241c",
      categories: ["music", "entertainment", "sports"],
      icons: [
        {
          src: "/buenfin/logo_terrapesca_marine.png",
          sizes: "192x192 512x512",
          type: "image/png",
          purpose: "any maskable"
        },
        {
          src: "/icon-192.png",
          sizes: "192x192",
          type: "image/png",
          purpose: "any"
        },
        {
          src: "/icon-512.png",
          sizes: "512x512",
          type: "image/png",
          purpose: "any maskable"
        },
        {
          src: "https://cdn.shopify.com/s/files/1/0205/5752/9188/files/Logo-Terrapesca-01_205270e5-d546-4e33-a8d1-db0a91f1e554.png?v=1700262873",
          sizes: "512x512",
          type: "image/png",
          purpose: "any maskable"
        }
      ]
    }));
    return;
  }

  // Iconos PWA locales
  if (urlPath === '/icon-192.png' || urlPath === '/icon-512.png') {
    const iconName = urlPath === '/icon-192.png' ? 'icon-192.png' : 'icon-512.png';
    const iconPath = path.join(__dirname, 'public', iconName);
    if (fs.existsSync(iconPath)) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' });
      fs.createReadStream(iconPath).pipe(res);
      return;
    }
  }

  // Favicon
  if (urlPath === '/favicon.ico') {
    res.writeHead(302, { Location: 'https://cdn.shopify.com/s/files/1/0205/5752/9188/files/Logo-Terrapesca-01_205270e5-d546-4e33-a8d1-db0a91f1e554.png?v=1700262873' });
    res.end();
    return;
  }

  // Robots.txt
  if (urlPath === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end("User-agent: *\nAllow: /\nDisallow: /studio\nDisallow: /sucursal\nDisallow: /panel\n");
    return;
  }

  // Página de login (siempre pública)
  if (urlPath === '/login' || urlPath === '/login.html') {
    const lp = path.join(__dirname, 'login.html');
    if (fs.existsSync(lp)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'SAMEORIGIN'
      });
      fs.createReadStream(lp).pipe(res);
      return;
    }
  }

  let filePath = null;
  let isPublicPage = false; // /listen es pública, el resto exige login
  if (urlPath === '/' || urlPath === '/index.html') {
    // Portada: selector de rol (Cabina / Sucursal / Escuchar / Tienda)
    filePath = path.join(__dirname, 'index.html');
  } else if (urlPath === '/panel' || urlPath === '/panel.html') {
    // panel.html jubilado (Fase B): la cabina única es /studio. La URL vieja redirige.
    res.writeHead(302, { Location: '/studio' }); res.end(); return;
  } else if (urlPath === '/studio' || urlPath === '/studio.html') {
    filePath = path.join(__dirname, 'studio.html');
  } else if (urlPath === '/tienda' || urlPath === '/tienda.html') {
    filePath = path.join(__dirname, 'tienda.html');
  } else if (urlPath === '/sucursal' || urlPath === '/sucursal.html') {
    filePath = path.join(__dirname, 'sucursal.html');
  } else if (urlPath === '/listen' || urlPath === '/listen.html') {
    filePath = path.join(__dirname, 'listen.html');
    isPublicPage = true;
  } else if (urlPath === '/tv' || urlPath === '/tv.html' || urlPath === '/pantalla' || urlPath === '/pantalla.html' || urlPath === '/videos' || urlPath === '/videos.html') {
    filePath = path.join(__dirname, 'videos.html');
    isPublicPage = true; // Pública para que las pantallas de tienda carguen directo
  }

  if (filePath && fs.existsSync(filePath)) {
    // Gate: si la página no es pública y no hay sesión, muestra el login.
    if (!isPublicPage && !isAuthed(req)) {
      const lp = path.join(__dirname, 'login.html');
      if (fs.existsSync(lp)) {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'SAMEORIGIN'
        });
        fs.createReadStream(lp).pipe(res);
        return;
      }
      res.writeHead(302, { Location: '/login' }); res.end(); return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
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

// ═══════════════ RADIO 24/7 (piloto automático) ═══════════════
// El servidor avanza una playlist en el tiempo y transmite PLAY a todos los
// clientes, igual que lo haría la cabina — pero sin necesidad de tener el
// studio abierto. El audio sigue sonando en cada navegador oyente (YouTube).
const AP_FILE = path.join(__dirname, '.autopilot.json');
const PL_FILE = path.join(__dirname, '.playlist.json');

const DEFAULT_AUTOPILOT_PLAYLIST = [
  { ytId: 'YEhRTovQwm4', name: 'Guitarras Blancas (Official Audio)', artist: 'Los Enanitos Verdes', duration: 203 },
  { ytId: 'u1V8YRJnr4Q', name: 'Have You Ever Seen The Rain', artist: 'Creedence Clearwater Revival', duration: 160 },
  { ytId: '09839DpTctU', name: 'Hotel California', artist: 'Eagles', duration: 390 },
  { ytId: '1vrEljMfXYo', name: 'Take Me Home, Country Roads', artist: 'John Denver', duration: 198 },
  { ytId: '8lbsQyMhMT8', name: 'Rayando el Sol', artist: 'Maná', duration: 254 },
  { ytId: 'XfyEpmQM7bw', name: 'Proud Mary', artist: 'Creedence Clearwater Revival', duration: 187 },
  { ytId: '1w7OgIMMRc4', name: "Sweet Child O' Mine", artist: "Guns N' Roses", duration: 303 },
  { ytId: 'J7ATTjg7tpE', name: 'Oye Como Va', artist: 'Santana', duration: 258 },
  { ytId: 'tH2w6Oxx0kQ', name: 'Dust in the Wind', artist: 'Kansas', duration: 206 },
  { ytId: 'dAUUy7NMnaY', name: 'Ventura Highway', artist: 'America', duration: 212 },
  { ytId: '4gA5iaZ11lU', name: 'La Chona', artist: 'Los Tucanes de Tijuana', duration: 203 },
  { ytId: 'xF8VuLSqfQ8', name: 'El Sinaloense', artist: 'Banda El Recodo', duration: 165 },
  { ytId: 'T_FkEw27XJ0', name: 'De Música Ligera', artist: 'Soda Stereo', duration: 213 },
  { ytId: 'kRt2sRyup6A', name: 'La Camisa Negra', artist: 'Juanes', duration: 216 },
  { ytId: 'fJ9rUzIMcZQ', name: 'Bohemian Rhapsody', artist: 'Queen', duration: 359 },
  { ytId: 'pAgnJDJN4VA', name: 'Back In Black', artist: 'AC/DC', duration: 255 },
  { ytId: 'btPJPFnesV4', name: 'Eye of the Tiger', artist: 'Survivor', duration: 245 },
  { ytId: 'VcjzHMhBtf0', name: "Don't Stop Believin'", artist: 'Journey', duration: 251 },
  { ytId: 'NUsoVlDFqZg', name: 'Bailando', artist: 'Enrique Iglesias', duration: 243 },
  { ytId: 'hT_nvWreIhg', name: 'Counting Stars', artist: 'OneRepublic', duration: 257 },
  { ytId: 'teprNzF6J1I', name: 'En el Muelle de San Blás', artist: 'Maná', duration: 352 }
];
let autopilot = { on: false, list: [], idx: 0, timer: null };
let _songsSinceIntervention = 1; // Arranca en 1 para que tras la 1ra canción tras deploy suene intervención inmediata
let _interventionTurn = 0;
let _apHistory = []; // Registro de canciones recientes para evitar repeticiones
let customSpots = [];
try {
  const spFile = path.join(__dirname, '.spots_custom.json');
  if (fs.existsSync(spFile)) customSpots = JSON.parse(fs.readFileSync(spFile, 'utf8')) || [];
} catch (_) { customSpots = []; }

let _rodoManifest = [];
try {
  const rFile = path.join(__dirname, 'public', 'rodo', 'rodo_manifest.json');
  if (fs.existsSync(rFile)) _rodoManifest = JSON.parse(fs.readFileSync(rFile, 'utf8')) || [];
} catch (_) { _rodoManifest = []; }

function _apSave() {
  try { fs.writeFileSync(AP_FILE, JSON.stringify({ on: autopilot.on, list: autopilot.list, idx: autopilot.idx })); } catch (_) {}
}
function _apCover(id) { return 'https://img.youtube.com/vi/' + id + '/mqdefault.jpg'; }

// Selección aleatoria inteligente: evita repeticiones y alterna estilos/artistas
function _apPickNextTrack() {
  if (!autopilot.list || !autopilot.list.length) return null;
  if (autopilot.list.length === 1) {
    autopilot.idx = 0;
    return autopilot.list[0];
  }

  // Ventana de historial (hasta el 40% de la playlist, min 2, max 15) para no repetir
  const histLimit = Math.min(Math.max(2, Math.floor(autopilot.list.length * 0.4)), 15);
  const recentSet = new Set(_apHistory.slice(-histLimit));
  let candidates = autopilot.list.filter(t => !recentSet.has(t.ytId));
  if (!candidates.length) candidates = autopilot.list;

  // Variación de géneros y artistas: evitar dos temas seguidos del mismo artista
  const lastArtist = (radioState.currentTrack && radioState.currentTrack.channelTitle) ? radioState.currentTrack.channelTitle.toLowerCase() : '';
  const diffArtists = candidates.filter(t => (t.artist || '').toLowerCase() !== lastArtist);
  const pool = diffArtists.length ? diffArtists : candidates;

  const picked = pool[Math.floor(Math.random() * pool.length)];
  _apHistory.push(picked.ytId);
  if (_apHistory.length > 30) _apHistory.shift();

  const foundIdx = autopilot.list.findIndex(t => t.ytId === picked.ytId);
  autopilot.idx = foundIdx >= 0 ? foundIdx : 0;
  return picked;
}

function _apUpdatePreview() {
  if (!autopilot.list || !autopilot.list.length) {
    radioState.queuePreview = [];
    broadcast({ type: 'QUEUE_PREVIEW', items: [] });
    return;
  }
  const preview = [];
  const curId = (radioState.currentTrack && radioState.currentTrack.ytId) || '';
  const remaining = autopilot.list.filter(t => t.ytId !== curId);
  for (let i = 0; i < 5 && i < remaining.length; i++) {
    const item = remaining[(autopilot.idx + 1 + i) % remaining.length];
    preview.push({ ytId: item.ytId, name: item.name || '', artist: item.artist || '', cover: _apCover(item.ytId) });
  }
  radioState.queuePreview = preview;
  broadcast({ type: 'QUEUE_PREVIEW', items: preview });
}

function _apBroadcast() {
  const t = autopilot.list[autopilot.idx];
  if (!t) { stopAutopilot(); return; }
  radioState.currentTrack = { type: 'yt', ytId: t.ytId, name: t.name || '', channelTitle: t.artist || '', cover: _apCover(t.ytId), duration: t.duration || 0 };
  radioState.isPlaying = true;
  radioState.position = 0;
  radioState.lastUpdate = Date.now();
  broadcast({ type: 'PLAY', track: radioState.currentTrack, position: 0 });
  if (streamClients.size > 0) startStreamTrack(radioState.currentTrack);

  _apUpdatePreview();

  // Programar el avance a la siguiente pista
  const secs = (t.duration && t.duration > 0) ? t.duration : 210;
  clearTimeout(autopilot.timer);
  autopilot.timer = setTimeout(() => {
    _songsSinceIntervention++;
    // Cada 2 canciones, lanzar intervención (DJ Rodo / Spot Personalizado / Spot Buen Fin)
    if (_songsSinceIntervention >= 2) {
      _songsSinceIntervention = 0;
      _apPlayInterventionThenAdvance();
    } else {
      _apAdvanceNextTrack();
    }
  }, (secs + 1) * 1000);
  _apSave();
  console.log('[24/7 Aleatorio] ▶', t.name || t.ytId, '(' + secs + 's) [' + (autopilot.idx + 1) + '/' + autopilot.list.length + ']');
}

function _apAdvanceNextTrack() {
  _apPickNextTrack();
  _apSave();
  _apBroadcast();
}

function _apPlayInterventionThenAdvance() {
  _interventionTurn++;
  const turnType = _interventionTurn % 3; // 0 = DJ Rodo, 1 = Spot Personalizado, 2 = Spot Buen Fin
  let trackToPlay = null;

  // 1. TURNO DE DJ RODO (La hora oficial o consejos de pesca/kayak)
  if (turnType === 0) {
    try {
      // Calcular hora local en Mazatlán / Sinaloa
      const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Mazatlan', hour: 'numeric', hour12: false }).formatToParts(new Date());
      let curHour = 12;
      for (const x of p) if (x.type === 'hour') curHour = +x.value;

      // Buscar clip de la hora si existe en el rango grabado (12 a 20)
      let hourClip = _rodoManifest.find(m => m.file === `rodo_hora_h${curHour}.mp3`);
      if (!hourClip && Math.random() < 0.6) {
        hourClip = _rodoManifest.find(m => m.file === 'rodo_hora_costakayaks.mp3');
      }

      if (hourClip && Math.random() < 0.65) {
        let b64 = '';
        try {
          const pFile = path.join(__dirname, 'public', 'rodo', hourClip.file);
          if (fs.existsSync(pFile)) b64 = fs.readFileSync(pFile).toString('base64');
        } catch (_) {}
        trackToPlay = {
          type: 'spot',
          name: hourClip.title,
          url: hourClip.url,
          b64: b64,
          mime: 'audio/mpeg',
          duration: 16
        };
      } else {
        // Consejos, tips y saludos variados de Rodo
        const tips = _rodoManifest.filter(m => m.type !== 'hora');
        const clip = tips.length ? tips[Math.floor(Math.random() * tips.length)] : null;
        if (clip) {
          let b64 = '';
          try {
            const pFile = path.join(__dirname, 'public', 'rodo', clip.file);
            if (fs.existsSync(pFile)) b64 = fs.readFileSync(pFile).toString('base64');
          } catch (_) {}
          trackToPlay = {
            type: 'spot',
            name: clip.title,
            url: clip.url,
            b64: b64,
            mime: 'audio/mpeg',
            duration: 22
          };
        }
      }
    } catch (_) {}
  }

  // 2. TURNO DE SPOT PERSONALIZADO DE CABINA
  else if (turnType === 1) {
    if (customSpots && customSpots.length > 0) {
      const spIdx = Math.floor(Math.random() * customSpots.length);
      const cs = customSpots[spIdx];
      let b64 = cs.b64 || '';
      if (!b64 && cs.url && cs.url.startsWith('/')) {
        try {
          const pFile = path.join(__dirname, 'public', cs.url);
          if (fs.existsSync(pFile)) b64 = fs.readFileSync(pFile).toString('base64');
        } catch (_) {}
      }
      trackToPlay = {
        type: 'spot',
        name: '📢 ' + (cs.name || 'Spot Personalizado'),
        url: cs.url || '',
        b64: b64,
        mime: cs.mime || 'audio/mpeg',
        duration: cs.duration || 18
      };
    }
  }

  // 3. TURNO DE SPOT OFICIAL DEL BUEN FIN (o fallback si no hubo personalizado)
  if (!trackToPlay) {
    const BF_SPOTS = [
      { spot_id: 'spot_gorras_50', titulo: '¡EXPLOSIÓN 50% OFF! GORRAS TRUCKER TERRAPESCA', dur: 23 },
      { spot_id: 'spot_shadrap_40', titulo: '¡ADRENALINA PURA! SEÑUELOS DEL 20% AL 40% OFF', dur: 22 },
      { spot_id: 'spot_vanford_15', titulo: '¡PRECISIÓN JAPONESA! CARRETES SHIMANO (15% / 20% EN COMBO)', dur: 24 },
      { spot_id: 'spot_kayak_tilapia', titulo: '¡EL MONSTRUO AZUL! COSTA KAYAK BIG MERO (10% + 6 MSI • PRECIO CONGELADO)', dur: 22 },
      { spot_id: 'spot_maja_30', titulo: 'ROPA TÉCNICA PESCA 20% Y MARCA MAJA 30% OFF (13 AL 17 NOV)', dur: 24 },
      { spot_id: 'spot_hieleras_15', titulo: '¡FRÍO EXTREMO 15% OFF! HIELERAS TERRAPESCA', dur: 20 }
    ];
    const bfIdx = Math.floor(Math.random() * BF_SPOTS.length);
    const sp = BF_SPOTS[bfIdx];
    let b64 = '';
    try {
      const p = path.join(__dirname, 'public', 'buenfin', `${sp.spot_id}.mp3`);
      if (fs.existsSync(p)) b64 = fs.readFileSync(p).toString('base64');
    } catch (_) {}
    trackToPlay = {
      type: 'spot',
      name: sp.titulo,
      spot_id: sp.spot_id,
      url: `/buenfin/${sp.spot_id}.mp3`,
      b64: b64,
      mime: 'audio/mpeg',
      duration: sp.dur || 22
    };
  }

  radioState.currentTrack = trackToPlay;
  radioState.isPlaying = true;
  radioState.position = 0;
  radioState.lastUpdate = Date.now();

  const clipSecs = trackToPlay.duration || 22;
  console.log('[24/7 Intervención] 🎙️ AL AIRE:', trackToPlay.name, '(' + clipSecs + 's)');
  broadcast({ type: 'SPOT', track: trackToPlay });
  if (streamClients.size > 0) startStreamTrack(trackToPlay);

  // Programar avance a la siguiente canción tras finalizar el clip
  clearTimeout(autopilot.timer);
  autopilot.timer = setTimeout(() => {
    _apAdvanceNextTrack();
  }, (clipSecs + 2) * 1000);
}

function startAutopilot(list, startIdx) {
  if (!Array.isArray(list) || !list.length) return;
  autopilot.on = true;
  radioState.autopilotOn = true;
  autopilot.list = list.filter(x => x && x.ytId).map(x => ({ ytId: x.ytId, name: x.name || '', artist: x.artist || '', duration: +x.duration || 0 }));
  autopilot.idx = (typeof startIdx === 'number' && startIdx >= 0 && startIdx < autopilot.list.length) ? startIdx : 0;
  console.log('[24/7 Aleatorio] iniciando con', autopilot.list.length, 'canciones');
  broadcast({ type: 'AUTOPILOT', on: true });
  _apBroadcast();
}
function stopAutopilot() {
  autopilot.on = false;
  radioState.autopilotOn = false;
  clearTimeout(autopilot.timer); autopilot.timer = null;
  _apSave();
  radioState.isPlaying = false;
  radioState.position = 0;
  if (currentStreamDestroy) { currentStreamDestroy(); currentStreamDestroy = null; }
  broadcast({ type: 'AUTOPILOT', on: false, serverVer: SERVER_VERSION });
  broadcast({ type: 'PAUSE', position: 0 });
  broadcast({ type: 'SYNC', state: radioState, serverVer: SERVER_VERSION });
  console.log('[24/7] detenido');
}
function autopilotAdvance(dir) {
  if (!autopilot.on || !autopilot.list.length) return;
  if (dir === 'prev') {
    autopilot.idx = (autopilot.idx - 1 + autopilot.list.length) % autopilot.list.length;
  } else {
    _apPickNextTrack();
  }
  _apBroadcast();
}

// ---- OYENTES: ubicación aproximada por IP (solo ciudad, nunca dirección) ----
const _geoCache = new Map(); // ip -> {city,region,country,lat,lon}
const LISTENER_ROLES = ['listener', 'sucursal', 'tienda', 'tv'];
const CONTROLLER_ROLES = ['studio', 'panel'];
function _clientIP(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xf || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
}
function _isPrivateIP(ip) {
  return !ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') ||
    ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}
function _geoLookup(ip, cb) {
  if (_isPrivateIP(ip)) { cb(null); return; }
  if (_geoCache.has(ip)) { cb(_geoCache.get(ip)); return; }
  const r = https.request({ hostname: 'ipwho.is', path: '/' + encodeURIComponent(ip), method: 'GET', headers: { 'User-Agent': 'terrapesca-radio' } }, (res) => {
    let raw = ''; res.on('data', c => raw += c); res.on('end', () => {
      try { const d = JSON.parse(raw);
        if (d && d.success) { const g = { city: d.city || '', region: d.region || '', country: d.country || '', lat: d.latitude, lon: d.longitude }; _geoCache.set(ip, g); cb(g); return; }
      } catch (_) {}
      cb(null);
    });
  });
  r.on('error', () => cb(null));
  r.setTimeout(6000, () => { r.destroy(); cb(null); });
  r.end();
}
function collectListeners() {
  const items = []; let total = 0;
  wss.clients.forEach(c => {
    if (c.readyState !== 1 || !LISTENER_ROLES.includes(c._role)) return;
    total++;
    const g = c._geo;
    items.push({ role: c._role, city: (g && g.city) || '', region: (g && g.region) || '', country: (g && g.country) || '', lat: g ? g.lat : null, lon: g ? g.lon : null });
  });
  return { total, items };
}
function broadcastListeners() {
  const data = JSON.stringify(Object.assign({ type: 'LISTENERS' }, collectListeners()));
  wss.clients.forEach(c => { if (c.readyState === 1 && CONTROLLER_ROLES.includes(c._role)) { try { c.send(data); } catch (_) {} } });
}

wss.on('connection', (ws, req) => {
  console.log('Cliente conectado. Total:', wss.clients.size);
  ws.isAlive = true;
  ws._ip = _clientIP(req);
  ws._isAuthed = isAuthed(req);
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ type: 'SYNC', state: radioState, serverVer: SERVER_VERSION }));
  if (radioState.jingleB64) ws.send(JSON.stringify({ type: 'JINGLE_SET', b64: radioState.jingleB64 }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        case 'HELLO':
          // El cliente se identifica (listener/sucursal/tienda/studio/panel).
          const reqRole = String(msg.role || '').slice(0, 20);
          if (CONTROLLER_ROLES.includes(reqRole) && !ws._isAuthed) {
            console.warn(`[ws] Rol '${reqRole}' rechazado (requiere login) para IP ${ws._ip}`);
            ws._role = 'listener';
          } else {
            ws._role = reqRole || 'listener';
          }
          if (LISTENER_ROLES.includes(ws._role) && !ws._geo) {
            _geoLookup(ws._ip, (g) => { if (g) ws._geo = g; broadcastListeners(); });
          }
          broadcastListeners();
          break;
        case 'PLAY':
          // Un PLAY manual (cabina en vivo) tiene prioridad sobre la Radio 24/7.
          if (autopilot.on) stopAutopilot();
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
        case 'PLAYLIST_UPDATE': {
          const list = Array.isArray(msg.playlist) ? msg.playlist : [];
          if (list.length) {
            radioState.playlist = list;
            try { fs.writeFileSync(PL_FILE, JSON.stringify(list)); } catch (_) {}
            const valid = list.filter(x => x && x.ytId).map(x => ({
              ytId: x.ytId,
              name: x.name || x.title || '',
              artist: x.artist || x.channelTitle || '',
              duration: +x.duration || 210
            }));
            if (valid.length) {
              autopilot.list = valid;
              _apHistory = [];
              if (autopilot.idx >= valid.length) autopilot.idx = 0;
              _apSave();
              _apUpdatePreview();
              console.log(`[WS] Playlist de cabina recibida y sincronizada (${valid.length} canciones) — baraja aleatoria lista`);
            }
            broadcast({ type: 'PLAYLIST_UPDATE', playlist: list }, ws);
          }
          break;
        }
        case 'SPOTS_UPDATE': {
          const list = Array.isArray(msg.spots) ? msg.spots : [];
          if (list.length) {
            customSpots = list;
            const spFile = path.join(__dirname, '.spots_custom.json');
            try { fs.writeFileSync(spFile, JSON.stringify(list, null, 2)); } catch (_) {}
            console.log(`[WS] Biblioteca de spots sincronizada (${list.length} spots)`);
            broadcast({ type: 'SPOTS_LIBRARY_UPDATE', spots: list }, ws);
          }
          break;
        }
        case 'SPOT':
          radioState.currentTrack = msg.track;
          radioState.isPlaying = true;
          radioState.position = 0;
          radioState.lastUpdate = Date.now();
          broadcast({ type: 'SPOT', track: msg.track }, ws);
          if (streamClients.size > 0 && msg.track) startStreamTrack(msg.track);
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
        case 'MIC_SPOT':
          broadcast({ type: 'MIC_SPOT', b64: msg.b64, nombre: msg.nombre }, ws);
          break;
        case 'NEXT_TRACK':
        case 'PREV_TRACK':
          // En modo 24/7 el servidor avanza la playlist; si no, se reenvía al studio.
          if (autopilot.on) autopilotAdvance(msg.type === 'PREV_TRACK' ? 'prev' : 'next');
          else broadcast({ type: msg.type }, ws);
          break;
        case 'AUTOPILOT_START':
          if (!ws._isAuthed && CONTROLLER_ROLES.includes(ws._role)) {
            console.warn(`[ws] AUTOPILOT_START no autorizado desde ${ws._ip}`);
            break;
          }
          // La cabina entrega su playlist (con duraciones) y el servidor toma el control 24/7.
          startAutopilot(msg.playlist, msg.startIdx);
          break;
        case 'AUTOPILOT_STOP':
          if (!ws._isAuthed && CONTROLLER_ROLES.includes(ws._role)) {
            console.warn(`[ws] AUTOPILOT_STOP no autorizado desde ${ws._ip}`);
            break;
          }
          stopAutopilot();
          radioState.isPlaying = false;
          broadcast({ type: 'PAUSE', position: 0 });
          break;
        case 'QUEUE_PREVIEW':
          // Próximas canciones (Fase 4) — se guarda para el SYNC de clientes nuevos.
          radioState.queuePreview = Array.isArray(msg.items) ? msg.items.slice(0, 5) : [];
          broadcast({ type: 'QUEUE_PREVIEW', items: radioState.queuePreview }, ws);
          break;
      }
    } catch (e) {
      console.error('Error:', e.message);
    }
  });

  ws.on('error', () => { try { ws.terminate(); } catch(_) {} });

  ws.on('close', () => {
    console.log('Cliente desconectado. Total:', wss.clients.size);
    if (LISTENER_ROLES.includes(ws._role)) broadcastListeners();
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

  // Cargar playlist guardada de cabina si existe en disco
  let loadedPl = null;
  try {
    if (fs.existsSync(PL_FILE)) {
      const plData = JSON.parse(fs.readFileSync(PL_FILE, 'utf8'));
      if (Array.isArray(plData) && plData.length) {
        loadedPl = plData.filter(x => x && x.ytId).map(x => ({
          ytId: x.ytId,
          name: x.name || x.title || '',
          artist: x.artist || x.channelTitle || '',
          duration: +x.duration || 210
        }));
        radioState.playlist = plData;
        console.log(`[24/7] Playlist guardada de cabina cargada (${loadedPl.length} canciones)`);
      }
    }
  } catch (_) {}

  // Reanudar Radio 24/7 si estaba activa antes de reiniciar, o arrancar con playlist disponible
  let resumed = false;
  try {
    const saved = JSON.parse(fs.readFileSync(AP_FILE, 'utf8'));
    if (saved && saved.on && Array.isArray(saved.list) && saved.list.length) {
      console.log('[24/7] reanudando desde el disco…');
      const startList = (loadedPl && loadedPl.length) ? loadedPl : saved.list;
      const startIdx = (typeof saved.idx === 'number' && saved.idx >= 0 && saved.idx < startList.length) ? saved.idx : Math.floor(Math.random() * startList.length);
      startAutopilot(startList, startIdx);
      resumed = true;
    }
  } catch (_) {}

  if (!resumed) {
    console.log('[24/7] arrancando autopilot autónomo con rotación dinámica...');
    const startList = (loadedPl && loadedPl.length) ? loadedPl : DEFAULT_AUTOPILOT_PLAYLIST;
    const startIdx = Math.floor(Math.random() * startList.length);
    startAutopilot(startList, startIdx);
  }
});
