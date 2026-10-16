/* ============================================================================
   Núcleo compartido de CLIMA — Fase A.2 (ver AUDITORIA-SPOTIFY-2026-10.md)
   Cargado con <script src="/core/weather.js"> por studio.html y tienda.html.
   Única fuente de: ciudades, descripción de cielo, clima actual (open-meteo +
   SMN oficial de CONAGUA con probabilidad de lluvia) e índice de lluvia alta.
   Las páginas lo usan con respaldo, así que si no cargara siguen funcionando.
   El shape del objeto es idéntico al que esperaban las páginas:
     { city, temp, wind, code, prob, cielo, tmax, tmin }
   ========================================================================== */
window.TPWeather = (function () {
  const CITIES = {
    culiacan:   { n: 'Culiacán', lat: 24.8092, lng: -107.3938 },
    mazatlan:   { n: 'Mazatlán', lat: 23.2494, lng: -106.4111 },
    los_mochis: { n: 'Los Mochis', lat: 25.7919, lng: -109.0200 },
  };
  const KEYS = ['culiacan', 'mazatlan', 'los_mochis'];

  function desc(code) {
    const m = { 0: 'despejado', 1: 'mayormente despejado', 2: 'parcialmente nublado', 3: 'nublado', 45: 'neblina', 61: 'lluvia ligera', 63: 'lluvia', 80: 'chubascos', 95: 'tormenta' };
    return m[code] || 'estable';
  }
  function resolveCity(key) {
    return (key === 'auto' || !CITIES[key]) ? KEYS[Math.floor(Math.random() * KEYS.length)] : key;
  }

  // Pronóstico oficial del SMN (CONAGUA): probabilidad de lluvia + cielo + máx/mín.
  let _smn = null, _smnTs = 0;
  async function getSMN() {
    if (_smn && Date.now() - _smnTs < 60 * 60000) return _smn;
    try { const r = await fetch('/api/smn'); const d = await r.json(); if (d && d.ok !== false && !d.error) { _smn = d; _smnTs = Date.now(); return d; } } catch (_) {}
    return null;
  }
  // Máxima probabilidad de lluvia entre las ciudades (usa el caché ya bajado).
  function highRainNow(threshold) {
    const t = (threshold == null) ? 50 : threshold;
    try { if (!_smn) return null; let mx = -1; for (const k in _smn) { const p = _smn[k] && _smn[k].prob; if (p != null && p > mx) mx = p; } return mx >= t ? mx : null; } catch (_) { return null; }
  }

  const _wc = {};
  async function getWeather(cityKey) {
    const key = resolveCity(cityKey); const c = CITIES[key];
    if (_wc[key] && Date.now() - _wc[key].ts < 12 * 60000) return _wc[key].d;
    let d = { city: c.n, temp: null, wind: null };
    try {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lng}&current=temperature_2m,weather_code,wind_speed_10m&timezone=America%2FMazatlan`;
      const r = await fetch(u); const j = await r.json();
      d = { city: c.n, temp: Math.round(j.current.temperature_2m), wind: Math.round(j.current.wind_speed_10m), code: j.current.weather_code };
    } catch (e) {}
    // Complementa con el SMN oficial (probabilidad de lluvia, etc.). No bloquea si falla.
    try { const s = await getSMN(); const sc = s && s[key]; if (sc) { if (sc.prob != null) d.prob = sc.prob; if (sc.cielo) d.cielo = sc.cielo; if (sc.tmax != null) d.tmax = sc.tmax; if (sc.tmin != null) d.tmin = sc.tmin; if (d.temp == null && sc.temp != null) d.temp = sc.temp; if (d.wind == null && sc.viento != null) d.wind = sc.viento; } } catch (_) {}
    _wc[key] = { d, ts: Date.now() }; return d;
  }

  // Precalienta el SMN al cargar y cada hora (para la priorización por lluvia).
  try { getSMN(); setInterval(() => { _smnTs = 0; getSMN(); }, 60 * 60000); } catch (_) {}

  return { version: '1', CITIES, KEYS, desc, resolveCity, getSMN, getWeather, highRainNow };
})();
