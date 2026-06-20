#!/usr/bin/env node
'use strict';

/*
 * prepare-audio-live.js — normalizes real music for the live radio carril.
 *
 * Reads audio-sources-live.json, fetches/copies each authorized source and
 * normalizes it with FFmpeg into audio-live/<role>.mp3 at a fixed format
 * (MP3 / 44100 Hz / stereo / 128 kbps CBR / no metadata or cover art).
 *
 * Roles: rodo (required) + track1, track2, … trackN (at least one required).
 * Named tracks must be sequential starting at track1 (no gaps).
 *
 * Run: npm run prepare-audio-live
 *
 * This script runs ONLY locally. server.js reads the already-normalized
 * files from audio-live/ and needs no internet to stream music.
 * Sources accepted: local MP3/WAV files, or direct http(s) URLs to MP3/WAV.
 * YouTube-style sources are rejected on purpose.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const ROOT       = path.resolve(__dirname, '..');
const CONFIG     = path.join(ROOT, 'audio-sources-live.json');
const SOURCE_DIR = path.join(ROOT, 'audio-source');
const OUT_DIR    = path.join(ROOT, 'audio-live');

const TARGET = { rate: 44100, channels: 2, bitrate: '128k' };

const BLOCKED_HOSTS = ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com', 'ytimg.com'];
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 3;

function die(msg) { console.error('\n✖ ERROR: ' + msg + '\n'); process.exit(1); }
function isUrl(s) { return /^https?:\/\//i.test(s); }

function assertNotBlocked(urlStr) {
  let host;
  try { host = new URL(urlStr).hostname.toLowerCase(); } catch (_) { die('URL inválida: ' + urlStr); }
  if (BLOCKED_HOSTS.some(b => host === b || host.endsWith('.' + b)))
    die('Fuente rechazada por política (YouTube no permitido): ' + urlStr);
}

function download(urlStr, dest, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    assertNotBlocked(urlStr);
    const lib = urlStr.toLowerCase().startsWith('https:') ? https : http;
    const req = lib.get(urlStr, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Demasiados redirects: ' + urlStr));
        return resolve(download(new URL(res.headers.location, urlStr).toString(), dest, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' al descargar ' + urlStr));
      }
      let bytes = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_DOWNLOAD_BYTES) {
          req.destroy(); out.destroy();
          try { fs.unlinkSync(dest); } catch (_) {}
          reject(new Error('Archivo excede ' + (MAX_DOWNLOAD_BYTES / 1048576) + 'MB: ' + urlStr));
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => req.destroy(new Error('Timeout descargando ' + urlStr)));
  });
}

function runFfmpeg(args) {
  const r = spawnSync(ffmpegPath, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.error) die('No se pudo ejecutar ffmpeg-static: ' + r.error.message);
  return r;
}

function parseDuration(stderr) {
  const m = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(stderr || '');
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

function fmtSecs(s) {
  if (s == null) return '¿?';
  const m = Math.floor(s / 60), sec = (s % 60).toFixed(1).padStart(4, '0');
  return m + ':' + sec;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG)) die('No existe audio-sources-live.json en ' + CONFIG);
  let data;
  try { data = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { die('audio-sources-live.json no es JSON válido: ' + e.message); }
  if (!Array.isArray(data)) die('audio-sources-live.json debe ser un arreglo de { role, source }.');

  const byRole = {};
  for (const entry of data) {
    if (!entry || typeof entry.role !== 'string' || typeof entry.source !== 'string' || !entry.source.trim())
      die('Cada entrada debe tener "role" y "source" como strings. Entrada inválida: ' + JSON.stringify(entry));
    if (!/^(rodo|track\d+)$/.test(entry.role))
      die('Rol inválido "' + entry.role + '". Permitidos: rodo, track1, track2, … trackN');
    if (byRole[entry.role]) die('Rol duplicado: ' + entry.role);
    byRole[entry.role] = entry.source.trim();
  }
  if (!byRole.rodo) die('Falta el rol requerido: rodo');
  // Validate tracks are sequential from 1
  let i = 1;
  while (byRole['track' + i]) i++;
  const trackCount = i - 1;
  if (trackCount === 0) die('Se necesita al menos track1 en audio-sources-live.json');
  // Check for gaps
  for (let j = 1; j <= trackCount; j++) {
    if (!byRole['track' + j]) die('Falta track' + j + ' — los tracks deben ser secuenciales sin huecos');
  }
  console.log('  → ' + trackCount + ' tracks + rodo configurados');
  return byRole;
}

async function resolveInput(role, source) {
  if (isUrl(source)) {
    assertNotBlocked(source);
    const ext = (path.extname(new URL(source).pathname) || '.bin').toLowerCase();
    if (!['.mp3', '.wav'].includes(ext))
      console.warn('  ⚠ ' + role + ': la URL no termina en .mp3/.wav; ffmpeg validará al decodificar.');
    if (!fs.existsSync(SOURCE_DIR)) fs.mkdirSync(SOURCE_DIR, { recursive: true });
    const tmp = path.join(SOURCE_DIR, '_dl_' + role + ext);
    console.log('  ↓ descargando ' + source);
    await download(source, tmp);
    return tmp;
  }
  const abs = path.isAbsolute(source) ? source : path.join(ROOT, source);
  if (!fs.existsSync(abs)) die(role + ': archivo local no encontrado: ' + abs);
  const ext = path.extname(abs).toLowerCase();
  if (!['.mp3', '.wav'].includes(ext)) die(role + ': solo se aceptan .mp3 o .wav (recibido ' + ext + ')');
  return abs;
}

function normalize(role, inputPath) {
  const out = path.join(OUT_DIR, role + '.mp3');
  const args = [
    '-y', '-i', inputPath,
    '-map_metadata', '-1', '-vn',
    '-ac', String(TARGET.channels),
    '-ar', String(TARGET.rate),
    '-codec:a', 'libmp3lame',
    '-b:a', TARGET.bitrate,
    out
  ];
  const r = runFfmpeg(args);
  if (r.status !== 0) die(role + ': ffmpeg falló al normalizar ' + inputPath + '\n' + (r.stderr || '').slice(-1500));
  if (!fs.existsSync(out) || fs.statSync(out).size === 0) die(role + ': la salida ' + out + ' no se generó o está vacía.');
  const probe = runFfmpeg(['-i', out]);
  return { out, duration: parseDuration(probe.stderr) };
}

async function main() {
  console.log('Preparando audios para el carril LIVE de radio…\n');
  if (!ffmpegPath) die('ffmpeg-static no devolvió ruta de binario. ¿Está instalado?');
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const byRole = loadConfig();
  const roles = ['rodo', ...Object.keys(byRole).filter(r => r !== 'rodo').sort()];
  const results = [];

  for (const role of roles) {
    console.log('• ' + role + '  ←  ' + byRole[role]);
    const input = await resolveInput(role, byRole[role]);
    const { out, duration } = normalize(role, input);
    results.push({ role, out: path.relative(ROOT, out), duration });
  }

  console.log('\n✔ Listo. Archivos normalizados (MP3 / ' + TARGET.rate + ' Hz / estéreo / ' + TARGET.bitrate + ' CBR):\n');
  for (const r of results)
    console.log('  ' + r.role.padEnd(8) + r.out.padEnd(30) + 'duración ' + fmtSecs(r.duration));
  console.log('');
}

main().catch(e => die(e && e.message ? e.message : String(e)));
