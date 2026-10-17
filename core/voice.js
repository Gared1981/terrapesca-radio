/* ============================================================================
   Núcleo compartido de VOZ / TTS — Fase A.4 (ver AUDITORIA-SPOTIFY-2026-10.md)
   Cargado con <script src="/core/voice.js"> por studio.html y tienda.html.
   Única copia de la llamada al motor de voz: OpenAI (gpt-4o-mini-tts) o
   VoiceKiller (con reintentos en 502/503/504). Devuelve un ArrayBuffer (mp3).
   La construcción del texto/instrucciones queda en cada página; aquí solo la
   llamada al motor, para no duplicar reintentos ni manejo de errores.
   ========================================================================== */
window.TPVoice = (function () {
  const hv0 = (window.TPRodo && TPRodo.hv) ? TPRodo.hv : function (s) { return String(s || '').replace(/[^\x21-\x7E]/g, ''); };

  // o = { input, instructions, engine, voice, vkVoice, oaiKey, vkKey, vkUser, hv? }
  async function synth(o) {
    o = o || {};
    const input = o.input;
    const instructions = o.instructions || '';
    const engine = o.engine || 'openai';
    const hv = o.hv || hv0;
    if (!input) throw new Error('Texto vacío');

    if (engine === 'voicekiller') {
      if (!o.vkKey || !o.vkUser) throw new Error('Faltan credenciales de VoiceKiller (config)');
      const vkBody = JSON.stringify({ script: String(input).slice(0, 6000), voice_name: (o.vkVoice || 'Jett'), instructions: String(instructions).slice(0, 2000) });
      // Reintenta en errores de gateway (502/503/504): VoiceKiller a veces se satura.
      let last = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise(res => setTimeout(res, 800 * attempt));
        let r;
        try {
          r = await fetch('/api/voicekiller/tts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': hv(o.vkKey), 'userid': hv(o.vkUser) }, body: vkBody });
        } catch (e) { last = 'VoiceKiller sin respuesta (' + ((e && e.message) || 'red') + ')'; continue; }
        if (r.ok) return await r.arrayBuffer();
        if (r.status === 502 || r.status === 503 || r.status === 504) { last = 'VoiceKiller ' + r.status + ' (servidor lento)'; continue; }
        let m = ''; try { m = await r.text(); const j = JSON.parse(m); m = (j && (j.error || j.message)) || m; } catch (_) {}
        throw new Error('VoiceKiller ' + r.status + (m ? ': ' + m.slice(0, 180) : ''));
      }
      throw new Error(last + ' — VoiceKiller no respondió a tiempo. Intenta otra vez o cambia a OpenAI.');
    }

    // OpenAI (por defecto)
    if (!o.oaiKey) throw new Error('Falta la clave de OpenAI (config)');
    const r = await fetch('/api/openai/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-openai-key': hv(o.oaiKey) },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: o.voice || 'ash', input, instructions, response_format: 'mp3' })
    });
    if (!r.ok) {
      let msg = ''; try { const j = await r.json(); msg = (j && j.error && (j.error.message || j.error)) || ''; } catch (_) {}
      throw new Error('OpenAI ' + r.status + (msg ? ': ' + msg : ''));
    }
    return await r.arrayBuffer();
  }

  return { version: '1', synth };
})();
