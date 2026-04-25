const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

let radioState = {
  currentTrack: null, isPlaying: false,
  position: 0, volume: 80, playlist: [], lastUpdate: Date.now()
};

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TerrapescaRadio/1.0)',
        'Accept': 'text/html,*/*', 'Accept-Language': 'es-MX,es;q=0.9'
      }
    }, (res) => {
      if ([301,302,307,308].includes(res.statusCode) && res.headers.location)
        return httpGet(res.headers.location).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function parseMareas(html) {
  const mareas = [];
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  for (const row of rows) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim());
    if (cells.length >= 2 && /^\d{1,2}:\d{2}/.test(cells[0]))
      mareas.push({ hora: cells[0], altura: cells[1], tipo: cells[2]||'' });
  }
  return mareas.slice(0, 8);
}

function parseBigfish(html) {
  const seen = new Set(), titulos = [];
  const re1 = /<(?:h[23])[^>]*>([\s\S]*?)<\/h[23]>/gi;
  for (const m of html.matchAll(re1)) {
    const t = m[1].replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim();
    if (t.length > 12 && t.length < 200 && !seen.has(t) && !/^(Menú|Home|Inicio|JavaScript)/i.test(t)) {
      seen.add(t); titulos.push(t);
    }
    if (titulos.length >= 6) break;
  }
  return titulos;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', clients: wss.clients.size, uptime: process.uptime() }));
    return;
  }

  if (req.url === '/api/mareas') {
    try {
      const html = await httpGet('https://tablademareas.com/mx/sinaloa');
      const mareas = parseMareas(html);
      const fecha = new Date().toLocaleDateString('es-MX', {
        weekday:'long', day:'numeric', month:'long', year:'numeric', timeZone:'America/Mazatlan'
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, fecha, mareas, region: 'Sinaloa, México' }));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message, mareas: [] }));
    }
    return;
  }

  if (req.url === '/api/bigfish') {
    try {
      const html = await httpGet('https://www.bigfish.mx/');
      const titulos = parseBigfish(html);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, titulos, fecha: new Date().toLocaleDateString('es-MX') }));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message, titulos: [] }));
    }
    return;
  }

  let filePath = null;
  if (req.url === '/' || req.url === '/panel' || req.url === '/panel.html')
    filePath = path.join(__dirname, 'panel.html');
  else if (req.url === '/sucursal' || req.url === '/sucursal.html')
    filePath = path.join(__dirname, 'sucursal.html');

  if (filePath && fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocketServer({ server });

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c !== excludeWs && c.readyState === 1) c.send(msg); });
}

function broadcastCount() {
  const msg = JSON.stringify({ type: 'CLIENT_COUNT', count: wss.clients.size });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

wss.on('connection', (ws) => {
  console.log(`[+] Conectado. Total: ${wss.clients.size}`);
  ws.send(JSON.stringify({ type: 'SYNC', state: radioState }));
  broadcastCount();

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      switch (msg.type) {
        case 'PLAY':
          Object.assign(radioState, { isPlaying:true, currentTrack:msg.track, position:msg.position||0, lastUpdate:Date.now() });
          broadcast({ type:'PLAY', track:msg.track, position:radioState.position }, ws); break;
        case 'PAUSE':
          Object.assign(radioState, { isPlaying:false, position:msg.position||0 });
          broadcast({ type:'PAUSE', position:radioState.position }, ws); break;
        case 'RESUME':
          Object.assign(radioState, { isPlaying:true, position:msg.position||0, lastUpdate:Date.now() });
          broadcast({ type:'RESUME', position:radioState.position }, ws); break;
        case 'VOLUME':
          radioState.volume = msg.volume;
          broadcast({ type:'VOLUME', volume:msg.volume }, ws); break;
        case 'PLAYLIST_UPDATE':
          radioState.playlist = msg.playlist;
          broadcast({ type:'PLAYLIST_UPDATE', playlist:msg.playlist }, ws); break;
        case 'SPOT':
          Object.assign(radioState, { currentTrack:msg.track, isPlaying:true, position:0, lastUpdate:Date.now() });
          broadcast({ type:'SPOT', track:msg.track }, ws); break;
        case 'MIC_SPOT':
          broadcast({ type:'MIC_SPOT', b64:msg.b64, nombre:msg.nombre||'🎤 Locutor en vivo' }, ws); break;
      }
    } catch(e) { console.error('Error:', e.message); }
  });

  ws.on('close', () => {
    console.log(`[-] Desconectado. Total: ${wss.clients.size}`);
    broadcastCount();
  });
});

server.listen(PORT, () => console.log(`🎙️  Terrapesca Radio en http://localhost:${PORT}`));
