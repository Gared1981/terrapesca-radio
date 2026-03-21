const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// Estado compartido de la radio
let radioState = {
  currentTrack: null,
  isPlaying: false,
  position: 0,
  volume: 80,
  playlist: [],
  branch: 'Los Mochis',
  lastUpdate: Date.now()
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', clients: wss.clients.size }));
  } else {
    res.writeHead(200);
    res.end('Terrapesca Radio Server running 📻');
  }
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

wss.on('connection', (ws, req) => {
  console.log('Cliente conectado. Total:', wss.clients.size);

  // Enviar estado actual al nuevo cliente
  ws.send(JSON.stringify({ type: 'SYNC', state: radioState }));

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

        case 'BRANCH':
          radioState.branch = msg.branch;
          broadcast({ type: 'BRANCH', branch: msg.branch }, ws);
          break;

        case 'SPOT':
          // Spot de audio en base64 para transmitir a sucursales
          radioState.currentTrack = msg.track;
          radioState.isPlaying = true;
          radioState.position = 0;
          radioState.lastUpdate = Date.now();
          broadcast({ type: 'SPOT', track: msg.track }, ws);
          break;
      }
    } catch (e) {
      console.error('Error procesando mensaje:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('Cliente desconectado. Total:', wss.clients.size);
  });
});

server.listen(PORT, () => {
  console.log(`Terrapesca Radio Server corriendo en puerto ${PORT}`);
});
