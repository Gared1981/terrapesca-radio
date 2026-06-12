const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
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

async function streamYouTubeVideo(videoId) {
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

    stream.on('data', writeToStreamClients);
    stream.on('end', () => { currentStreamDestroy = null; streamBusy = false; resolve(); });
    stream.on('error', (e) => { currentStreamDestroy = null; streamBusy = false; reject(e); });
  });
}

async function streamAudioBuffer(buffer) {
  // Send first ~5 seconds immediately so browser starts playing fast
  const PREBUFFER = 80000; // ~5s at 128kbps
  const HEAD = Math.min(PREBUFFER, buffer.length);
  let cancelled = false;
  currentStreamDestroy = () => { cancelled = true; };

  writeToStreamClients(buffer.slice(0, HEAD));
  if (cancelled || HEAD >= buffer.length) { if (!cancelled) currentStreamDestroy = null; return; }

  // Stream remainder at 1.5× real-time: 24000 bytes/s → 48KB every 2s
  // This keeps browser buffer ~1.5s ahead, absorbs jitter without excess latency
  const CHUNK = 48000;
  const INTERVAL = 2000;
  for (let i = HEAD; i < buffer.length; i += CHUNK) {
    if (cancelled) break;
    writeToStreamClients(buffer.slice(i, i + CHUNK));
    await new Promise(r => setTimeout(r, INTERVAL));
  }
  if (!cancelled) currentStreamDestroy = null;
}

// Called when the panel sends a PLAY/SPOT WebSocket message
function startStreamTrack(track) {
  if (currentStreamDestroy) { currentStreamDestroy(); currentStreamDestroy = null; }
  streamBusy = false;
  if (!track) return;

  if (track.type === 'yt' && track.ytId && ytdl) {
    streamBusy = true;
    streamYouTubeVideo(track.ytId)
      .then(() => { streamBusy = false; })
      .catch(e => {
        console.error('ytdl error for', track.ytId, e.message);
        streamBusy = false;
        // Do NOT send invalid silence bytes — just let the connection stay open silently
      });
  } else if (track.b64) {
    // Uploaded MP3: base64-encoded audio from panel
    streamBusy = true;
    const buf = Buffer.from(track.b64, 'base64');
    streamAudioBuffer(buf)
      .then(() => { streamBusy = false; })
      .catch(() => { streamBusy = false; });
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
    if (streamClients.size > 0 && !streamBusy) {
      writeToStreamClients(SILENT_BURST);
    }
  }, 3000); // every 3s during idle gaps between tracks
}

// ---- HTTP PROXY HELPERS ----
function proxyPost(hostname, path, headers, body, res) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const options = {
    hostname,
    path,
    method: 'POST',
    headers: { ...headers, 'Content-Length': Buffer.byteLength(data) }
  };

  const req = https.request(options, (apiRes) => {
    const isAudio = (apiRes.headers['content-type'] || '').includes('audio');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (isAudio) {
      res.writeHead(apiRes.statusCode, { 'Content-Type': apiRes.headers['content-type'] || 'audio/mpeg' });
      apiRes.pipe(res);
    } else {
      let raw = '';
      apiRes.on('data', chunk => raw += chunk);
      apiRes.on('end', () => {
        res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
        res.end(raw);
      });
    }
  });
  req.on('error', (e) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  });
  req.write(data);
  req.end();
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
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
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
    ytReq.end();
    return;
  }

  // ── Proxy ElevenLabs TTS ──
  if (req.url.startsWith('/api/elevenlabs/') && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
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
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    });
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
  } else if (req.url === '/sucursal' || req.url === '/sucursal.html') {
    filePath = path.join(__dirname, 'sucursal.html');
  } else if (req.url === '/listen' || req.url === '/listen.html') {
    filePath = path.join(__dirname, 'listen.html');
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

wss.on('connection', (ws) => {
  console.log('Cliente conectado. Total:', wss.clients.size);
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
          radioState.jingleB64 = msg.b64;
          broadcast({ type: 'JINGLE_SET', b64: msg.b64 }, ws);
          break;
      }
    } catch (e) {
      console.error('Error:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('Cliente desconectado. Total:', wss.clients.size);
  });
});

server.listen(PORT, () => {
  console.log(`Terrapesca Radio corriendo en puerto ${PORT}`);
  console.log(`Stream disponible en /radio/stream`);
  console.log(`ytdl-core: ${ytdl ? 'disponible' : 'no disponible'}`);
});
