const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// Load .env.local for local development
const envLocalPath = path.join(__dirname, '.env.local');
if (fs.existsSync(envLocalPath)) {
  fs.readFileSync(envLocalPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  });
}

const PORT = process.env.PORT || 3000;

// === GOOGLE TTS CLIENT (lazy init) ===
let _googleTTSClient = null;
function getGoogleTTSClient() {
  if (_googleTTSClient) return _googleTTSClient;
  const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
  // Opción 1: archivo JSON local (dev)
  const credFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credFile) {
    const absPath = path.isAbsolute(credFile) ? credFile : path.join(__dirname, credFile);
    if (fs.existsSync(absPath)) {
      _googleTTSClient = new TextToSpeechClient({ keyFilename: absPath });
      console.log('[Google TTS] Usando credenciales desde archivo:', absPath);
      return _googleTTSClient;
    }
  }
  // Opción 2: variables de entorno (Railway producción)
  const clientEmail = process.env.GOOGLE_TTS_CLIENT_EMAIL;
  const privateKey  = (process.env.GOOGLE_TTS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const projectId   = process.env.GOOGLE_TTS_PROJECT_ID;
  if (clientEmail && privateKey && projectId) {
    _googleTTSClient = new TextToSpeechClient({
      projectId,
      credentials: { client_email: clientEmail, private_key: privateKey }
    });
    console.log('[Google TTS] Usando credenciales desde env vars');
    return _googleTTSClient;
  }
  throw new Error('Google TTS: no se encontraron credenciales. Agrega credentials/google-tts.json o las variables GOOGLE_TTS_* en Railway.');
}

// Read POST body
function readBody(req){
  return new Promise((resolve,reject)=>{
    let body='';
    req.on('data',c=>body+=c.toString());
    req.on('end',()=>{try{resolve(JSON.parse(body))}catch(e){resolve({})}});
    req.on('error',reject);
  });
}

// Strip HTML tags
function stripHtml(h){
  return h.replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(n)).replace(/\s+/g,' ').trim();
}

// Parse product data from HTML
function parseProduct(html,url){
  // 1. Try JSON-LD
  const ldBlocks=html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)||[];
  for(const block of ldBlocks){
    try{
      const jsonStr=block.replace(/<script[^>]*>/i,'').replace(/<\/script>/i,'').trim();
      let data=JSON.parse(jsonStr);
      if(Array.isArray(data))data=data.find(d=>d['@type']==='Product')||data[0];
      if(data&&(data['@type']==='Product'||data.name)){
        const offer=Array.isArray(data.offers)?data.offers[0]:data.offers;
        const features=[];
        if(Array.isArray(data.additionalProperty))data.additionalProperty.slice(0,5).forEach(p=>features.push(p.name+': '+p.value));
        return{
          name:data.name||null,
          description:data.description?stripHtml(data.description).slice(0,400):null,
          price:offer?.price?`$${offer.price} ${offer.priceCurrency||'MXN'}`:null,
          brand:data.brand?.name||data.brand||null,
          category:data.category||null,
          availability:offer?.availability?.includes('InStock')?'Disponible':null,
          features,source:'json-ld'
        };
      }
    }catch(e){}
  }
  // 2. Shopify product JSON
  const shopifyM=html.match(/var\s+meta\s*=\s*(\{[\s\S]*?"product"[\s\S]*?\});/);
  if(shopifyM){
    try{
      const d=JSON.parse(shopifyM[1]);
      if(d.product){const p=d.product;return{name:p.title||null,description:p.description?stripHtml(p.description).slice(0,400):null,price:p.price_min?`$${(p.price_min/100).toFixed(2)} MXN`:null,brand:p.vendor||null,category:p.type||null,availability:null,features:[],source:'shopify'};}
    }catch(e){}
  }
  // 3. Meta tags fallback
  const getMeta=(attr,val)=>{
    const m=html.match(new RegExp(`<meta[^>]+${attr}="[^"]*${val}[^"]*"[^>]+content="([^"]*)"[^>]*>`,'i'))||
            html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+${attr}="[^"]*${val}[^"]*"[^>]*>`,'i'));
    return m?m[1].trim():null;
  };
  const title=getMeta('property','og:title')||(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]?.replace(/\s+/g,' ').trim()||null;
  const desc=getMeta('property','og:description')||getMeta('name','description')||null;
  const price=getMeta('property','product:price:amount')||getMeta('property','og:price:amount')||null;
  const brand=getMeta('property','og:brand')||getMeta('property','product:brand')||null;
  return{name:title,description:desc?desc.slice(0,400):null,price:price?`$${price} MXN`:null,brand,category:null,availability:null,features:[],source:'meta'};
}

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

  // Google TTS — listar voces es-MX
  if (req.url === '/api/google-tts/voices') {
    try {
      const client = getGoogleTTSClient();
      const [result] = await client.listVoices({ languageCode: 'es-MX' });
      const voices = (result.voices || [])
        .filter(v => v.languageCodes?.some(c => c.startsWith('es-MX')))
        .map(v => ({ name: v.name, ssmlGender: v.ssmlGender, naturalSampleRateHertz: v.naturalSampleRateHertz }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8' });
      res.end(JSON.stringify({ ok: true, voices }));
    } catch(e) {
      res.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Google TTS — sintetizar voz
  if (req.url === '/api/google-tts/synthesize' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const text = (body.text || '').trim();
      if (text.length < 3) throw new Error('Texto demasiado corto');
      const voiceName   = body.voiceName || process.env.GOOGLE_TTS_DEFAULT_VOICE || 'es-MX-Wavenet-B';
      const speakingRate = Math.min(Math.max(parseFloat(body.speakingRate) || 1.0, 0.5), 2.0);
      const pitch       = Math.min(Math.max(parseFloat(body.pitch) || 0, -10), 10);
      const volumeGainDb= parseFloat(body.volumeGainDb) || 0;
      const client = getGoogleTTSClient();
      const [response] = await client.synthesizeSpeech({
        input: { text },
        voice: { languageCode: 'es-MX', name: voiceName },
        audioConfig: { audioEncoding: 'MP3', speakingRate, pitch, volumeGainDb }
      });
      if (!response.audioContent) throw new Error('Google TTS no devolvió audio');
      const audioBase64 = Buffer.from(response.audioContent).toString('base64');
      res.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8' });
      res.end(JSON.stringify({ ok: true, audioBase64, mimeType: 'audio/mpeg', voiceName, settings: { speakingRate, pitch, volumeGainDb } }));
    } catch(e) {
      console.error('[Google TTS synthesize]', e.message);
      res.writeHead(200, { 'Content-Type': 'application/json;charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (req.url === '/api/scrape-product' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const url = body.url||'';
      if(!url.startsWith('http')){res.writeHead(200,{'Content-Type':'application/json;charset=utf-8'});res.end(JSON.stringify({ok:false,error:'URL inválida'}));return;}
      const html = await httpGet(url);
      const product = parseProduct(html, url);
      if(!product.name){res.writeHead(200,{'Content-Type':'application/json;charset=utf-8'});res.end(JSON.stringify({ok:false,error:'No se pudo extraer el producto. Verifica el enlace o pega la descripción manualmente.'}));return;}
      res.writeHead(200,{'Content-Type':'application/json;charset=utf-8'});
      res.end(JSON.stringify({ok:true,product}));
    }catch(e){
      res.writeHead(200,{'Content-Type':'application/json;charset=utf-8'});
      res.end(JSON.stringify({ok:false,error:e.message}));
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
