/* ============================================================================
   Núcleo compartido de DJ Rodo — Fase A (ver AUDITORIA-SPOTIFY-2026-10.md)
   Cargado con <script src="/core/rodo.js"> por studio.html y tienda.html.
   Objetivo: tener UNA sola copia de las piezas mecánicas de Rodo (saneado de
   headers, sellos de sección, helpers) en vez de duplicarlas por página.
   Las páginas usan TPRodo con respaldo inline, así que si este archivo no
   cargara, la página sigue funcionando.
   ========================================================================== */
window.TPRodo = (function () {
  // Sanea un valor para header HTTP: solo ASCII imprimible (evita el error
  // "non ISO-8859-1" por caracteres invisibles al copiar/pegar llaves).
  function hv(s) { return String(s || '').replace(/[^\x21-\x7E]/g, ''); }

  // Elige un elemento al azar de un arreglo.
  function pick(a) { return (a && a.length) ? a[Math.floor(Math.random() * a.length)] : ''; }

  // Sello de sección del CLIMA ("el tiempo al momento") — rotativo para que sea
  // reconocible sin sonar siempre igual.
  function sellosClima(city) {
    const c = city || 'la región';
    return [
      `El tiempo al momento en ${c}`,
      `El tiempo al momento, con Terrapesca`,
      `Tu reporte del tiempo al instante`,
      `Así está el tiempo ahora mismo en ${c}`,
      `El tiempo al momento para los pescadores de ${c}`,
    ];
  }

  // Patrocinio de la HORA por Costa Kayaks — rotativo.
  function sellosHora() {
    return [
      `Costa Kayaks te da la hora`,
      `La hora, cortesía de Costa Kayaks`,
      `Costa Kayaks te pone en hora`,
      `Con Costa Kayaks, esta es la hora`,
    ];
  }

  return {
    version: '1',
    hv, pick, sellosClima, sellosHora,
  };
})();
