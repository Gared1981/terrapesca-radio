const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');

// ---- LOGIN / GATE ----
// Todas las páginas (Cabina, Sucursal, Tienda, Panel, Inicio) requieren login.
// EXCEPCIÓN: /listen es pública (la radio para el público).
// Credenciales por variables de entorno (recomendado en Railway) con respaldo por defecto.
const AUTH_USER = process.env.TP_USER || 'EDGAR';
const AUTH_PASS = process.env.TP_PASS || '9970002';
// Secreto para firmar la cookie; si no se define, se deriva de las credenciales
// (basta para un gate simple de una sola cuenta; en producción define TP_AUTH_SECRET).
const AUTH_SECRET = process.env.TP_AUTH_SECRET || ('tp-radio-' + AUTH_USER + '-' + AUTH_PASS);
const AUTH_TOKEN = crypto.createHash('sha256').update(AUTH_USER + ':' + AUTH_PASS + ':' + AUTH_SECRET).digest('hex');
const AUTH_COOKIE = 'tp_auth';

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
  return parseCookies(req)[AUTH_COOKIE] === AUTH_TOKEN;
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

// ---- HTTP SERVER ----
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, xi-api-key, x-api-key, x-openai-key, api-key, userid, x-shopify-shop, x-shopify-token, anthropic-version');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Login: valida credenciales y setea cookie httpOnly ──
  if (req.url === '/api/login' && req.method === 'POST') {
    readBody(req, (body) => {
      let user = '', pass = '';
      try { const j = JSON.parse(body || '{}'); user = String(j.user || ''); pass = String(j.pass || ''); } catch (_) {}
      if (user === AUTH_USER && pass === AUTH_PASS) {
        const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
        res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
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
  // GET /api/ytsearch?q=...&key=... → busca videos de música y devuelve
  // items:[{ytId,title,channel,thumb,duration}] con duración en segundos
  // (search.list + videos.list). La key viaja del navegador (tp_yt), como en /api/ytplaylist.
  if (req.url.startsWith('/api/ytsearch') && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const q      = u.searchParams.get('q')   || '';
    const apiKey = u.searchParams.get('key') || '';
    if (!q || !apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'q and key required' }));
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
      const sr = await getJson(`/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=12&q=${encodeURIComponent(q)}&key=${encodeURIComponent(apiKey)}`);
      if (sr.status !== 200) {
        const msg = sr.json?.error?.message || 'Error de YouTube';
        res.writeHead(sr.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg }));
        return;
      }
      const items = (sr.json.items || []).filter(it => it.id && it.id.videoId).map(it => ({
        ytId: it.id.videoId,
        title: it.snippet?.title || 'YouTube',
        channel: it.snippet?.channelTitle || '',
        thumb: it.snippet?.thumbnails?.medium?.url || `https://img.youtube.com/vi/${it.id.videoId}/mqdefault.jpg`,
        duration: 0,
      }));
      // Duraciones en una sola llamada extra (best effort — si falla, van en 0)
      if (items.length) {
        try {
          const vr = await getJson(`/youtube/v3/videos?part=contentDetails&id=${items.map(i => i.ytId).join(',')}&key=${encodeURIComponent(apiKey)}`);
          const durs = {};
          (vr.json.items || []).forEach(v => { durs[v.id] = iso8601ToSecs(v.contentDetails?.duration); });
          items.forEach(i => { i.duration = durs[i.ytId] || 0; });
        } catch (_) {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items }));
    })().catch(e => {
      try { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } catch (_) {}
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

  // ── Importar playlist pública de Spotify (título+artista) ──
  // Lee SOLO metadatos de la página embed pública; el cliente resuelve cada
  // canción en YouTube (que sí se puede transmitir a las sucursales).
  if (req.url.startsWith('/api/spotify/playlist') && req.method === 'GET') {
    let id = '';
    try { id = (new URL(req.url, 'http://x').searchParams.get('id') || '').replace(/[^A-Za-z0-9]/g, ''); } catch (_) {}
    if (!id) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Falta el id de la playlist' })); }
    const sReq = https.request({
      hostname: 'open.spotify.com',
      path: `/embed/playlist/${id}`,
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
          res.end(JSON.stringify({ error: 'No se pudo leer la playlist: ' + e.message }));
        }
      });
    });
    sReq.on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); });
    sReq.setTimeout(12000, () => { sReq.destroy(); });
    sReq.end();
    return;
  }

  // ── TideCheck: mareas, sol/luna e índice solunar (1 consulta por zona al día, caché 24 h) ──
  if (req.url.startsWith('/api/tides') && req.method === 'GET') {
    const send = (o) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (!TIDECHECK_KEY) { send({ ok: false, error: 'Falta TIDECHECK_KEY en el servidor (Railway → Variables)' }); return; }
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

  // Página de login (siempre pública)
  if (req.url === '/login' || req.url === '/login.html') {
    const lp = path.join(__dirname, 'login.html');
    if (fs.existsSync(lp)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(lp).pipe(res);
      return;
    }
  }

  let filePath = null;
  let isPublicPage = false; // /listen es pública, el resto exige login
  if (req.url === '/' || req.url === '/index.html') {
    // Portada: selector de rol (Cabina / Sucursal / Escuchar / Tienda)
    filePath = path.join(__dirname, 'index.html');
  } else if (req.url === '/panel' || req.url === '/panel.html') {
    filePath = path.join(__dirname, 'panel.html');
  } else if (req.url === '/studio' || req.url === '/studio.html') {
    filePath = path.join(__dirname, 'studio.html');
  } else if (req.url === '/tienda' || req.url === '/tienda.html') {
    filePath = path.join(__dirname, 'tienda.html');
  } else if (req.url === '/sucursal' || req.url === '/sucursal.html') {
    filePath = path.join(__dirname, 'sucursal.html');
  } else if (req.url === '/listen' || req.url === '/listen.html') {
    filePath = path.join(__dirname, 'listen.html');
    isPublicPage = true;
  }

  if (filePath && fs.existsSync(filePath)) {
    // Gate: si la página no es pública y no hay sesión, muestra el login.
    if (!isPublicPage && !isAuthed(req)) {
      const lp = path.join(__dirname, 'login.html');
      if (fs.existsSync(lp)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(lp).pipe(res);
        return;
      }
      res.writeHead(302, { Location: '/login' }); res.end(); return;
    }
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

// ═══════════════ RADIO 24/7 (piloto automático) ═══════════════
// El servidor avanza una playlist en el tiempo y transmite PLAY a todos los
// clientes, igual que lo haría la cabina — pero sin necesidad de tener el
// studio abierto. El audio sigue sonando en cada navegador oyente (YouTube).
const AP_FILE = path.join(__dirname, '.autopilot.json');
let autopilot = { on: false, list: [], idx: 0, timer: null };

function _apSave() {
  try { fs.writeFileSync(AP_FILE, JSON.stringify({ on: autopilot.on, list: autopilot.list, idx: autopilot.idx })); } catch (_) {}
}
function _apCover(id) { return 'https://img.youtube.com/vi/' + id + '/mqdefault.jpg'; }

function _apBroadcast() {
  const t = autopilot.list[autopilot.idx];
  if (!t) { stopAutopilot(); return; }
  radioState.currentTrack = { type: 'yt', ytId: t.ytId, name: t.name || '', channelTitle: t.artist || '', cover: _apCover(t.ytId), duration: t.duration || 0 };
  radioState.isPlaying = true;
  radioState.position = 0;
  radioState.lastUpdate = Date.now();
  broadcast({ type: 'PLAY', track: radioState.currentTrack, position: 0 });

  // Próximas canciones
  const preview = [];
  for (let i = 1; i <= 5 && i < autopilot.list.length; i++) {
    const n = autopilot.list[(autopilot.idx + i) % autopilot.list.length];
    preview.push({ ytId: n.ytId, name: n.name || '', artist: n.artist || '', cover: _apCover(n.ytId) });
  }
  radioState.queuePreview = preview;
  broadcast({ type: 'QUEUE_PREVIEW', items: preview });

  // Programar el avance a la siguiente pista (+1s de colchón entre canciones).
  // Si no se conoce la duración, usar 210s como estimación segura.
  const secs = (t.duration && t.duration > 0) ? t.duration : 210;
  clearTimeout(autopilot.timer);
  autopilot.timer = setTimeout(() => {
    autopilot.idx = (autopilot.idx + 1) % autopilot.list.length;
    _apSave();
    _apBroadcast();
  }, (secs + 1) * 1000);
  _apSave();
  console.log('[24/7] ▶', t.name || t.ytId, '(' + secs + 's) [' + (autopilot.idx + 1) + '/' + autopilot.list.length + ']');
}

function startAutopilot(list, startIdx) {
  if (!Array.isArray(list) || !list.length) return;
  autopilot.on = true;
  radioState.autopilotOn = true;
  autopilot.list = list.filter(x => x && x.ytId).map(x => ({ ytId: x.ytId, name: x.name || '', artist: x.artist || '', duration: +x.duration || 0 }));
  autopilot.idx = (startIdx && startIdx < autopilot.list.length) ? startIdx : 0;
  console.log('[24/7] iniciando con', autopilot.list.length, 'canciones');
  broadcast({ type: 'AUTOPILOT', on: true });
  _apBroadcast();
}
function stopAutopilot() {
  autopilot.on = false;
  radioState.autopilotOn = false;
  clearTimeout(autopilot.timer); autopilot.timer = null;
  _apSave();
  broadcast({ type: 'AUTOPILOT', on: false });
  console.log('[24/7] detenido');
}
function autopilotAdvance(dir) {
  if (!autopilot.on || !autopilot.list.length) return;
  if (dir === 'prev') autopilot.idx = (autopilot.idx - 1 + autopilot.list.length) % autopilot.list.length;
  else autopilot.idx = (autopilot.idx + 1) % autopilot.list.length;
  _apBroadcast();
}

// ---- OYENTES: ubicación aproximada por IP (solo ciudad, nunca dirección) ----
const _geoCache = new Map(); // ip -> {city,region,country,lat,lon}
const LISTENER_ROLES = ['listener', 'sucursal', 'tienda'];
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
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ type: 'SYNC', state: radioState }));
  if (radioState.jingleB64) ws.send(JSON.stringify({ type: 'JINGLE_SET', b64: radioState.jingleB64 }));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        case 'HELLO':
          // El cliente se identifica (listener/sucursal/tienda/studio/panel).
          ws._role = String(msg.role || '').slice(0, 20);
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
        case 'NEXT_TRACK':
        case 'PREV_TRACK':
          // En modo 24/7 el servidor avanza la playlist; si no, se reenvía al studio.
          if (autopilot.on) autopilotAdvance(msg.type === 'PREV_TRACK' ? 'prev' : 'next');
          else broadcast({ type: msg.type }, ws);
          break;
        case 'AUTOPILOT_START':
          // La cabina entrega su playlist (con duraciones) y el servidor toma el control 24/7.
          startAutopilot(msg.playlist, msg.startIdx);
          break;
        case 'AUTOPILOT_STOP':
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
  // Reanudar Radio 24/7 si estaba activa antes de reiniciar
  try {
    const saved = JSON.parse(fs.readFileSync(AP_FILE, 'utf8'));
    if (saved && saved.on && Array.isArray(saved.list) && saved.list.length) {
      console.log('[24/7] reanudando desde el disco…');
      startAutopilot(saved.list, saved.idx || 0);
    }
  } catch (_) {}
});
