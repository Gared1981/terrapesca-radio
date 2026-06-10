const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

let radioState = {
  currentTrack: null,
  isPlaying: false,
  position: 0,
  volume: 80,
  playlist: [],
  lastUpdate: Date.now()
};

function proxyPost(hostname, path, headers, body, res) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const options = {
    hostname,
    path,
    method: 'POST',
    headers: {
      ...headers,
      'Content-Length': Buffer.byteLength(data)
    }
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

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, xi-api-key, x-api-key, anthropic-version');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', clients: wss.clients.size }));
    return;
  }

  // Proxy Anthropic
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

  // Proxy ElevenLabs TTS
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

  // Serve HTML files
  let filePath = null;
  if (req.url === '/' || req.url === '/panel' || req.url === '/panel.html') {
    filePath = path.join(__dirname, 'panel.html');
  } else if (req.url === '/sucursal' || req.url === '/sucursal.html') {
    filePath = path.join(__dirname, 'sucursal.html');
  }

  if (filePath && fs.existsSync(filePath)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Terrapesca Radio Server running');
});

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
          break;
        case 'PAUSE':
          radioState.isPlaying = false;
          radioState.position = msg.position || 0;
          broadcast({ type: 'PAUSE', position: radioState.position }, ws);
          break;
        case 'RESUME':
          radioState.isPlaying = true;
          radioState.position = msg.position || 0;
          radioState.lastUpdate = Date.now();
          broadcast({ type: 'RESUME', position: radioState.position }, ws);
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
});
