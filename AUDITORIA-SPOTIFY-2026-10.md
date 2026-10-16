# 🎧 Auditoría de estructura — Radio Terrapesca → "tipo Spotify"

**Fecha:** 16 de octubre de 2026
**Alcance:** revisión de la **estructura** de la aplicación (arquitectura, organización del código y de la experiencia) con el objetivo de acercarla al modelo de Spotify, **sin romper** el motor de crossfade ni el modelo sin build.
**Complementa:** `PLAN-SPOTIFY.md` (fases 0–8, ya completadas). Este documento audita el estado **actual** tras las funciones añadidas después de aquel plan (voz OpenAI/VoiceKiller, import de Spotify, Shopify, clima oficial del SMN, mareas de TideCheck, mapa de oyentes, login, audio en segundo plano con yt-dlp, 24/7 por todas las playlists, aleatorio por defecto).

---

## 1. Estado actual (resumen honesto)

La parte **visible** ya es muy "Spotify": el estudio tiene barra lateral (Inicio / Buscar / Cabina / Biblioteca / Me gusta / Historial / Playlists), barra de reproducción inferior, biblioteca con búsqueda, playlists, aleatorio/repetir reales y cola arrastrable. El oyente (`/listen`) tiene carátula grande, fondo difuminado, carrusel de productos y ya **suena en segundo plano**.

**El problema no es la cara: es la estructura por dentro.** La app son **5 páginas HTML monolíticas** que **copian y pegan** la misma lógica, sin una capa compartida.

| Archivo | Líneas | Rol | Estado estructural |
|---|---|---|---|
| `studio.html` | ~4.1k | Cabina DJ (motor bueno) | ✅ El núcleo. Todo lo nuevo vive aquí, inline. |
| `panel.html` | ~4.7k | Panel viejo (Los Mochis) | ⛔ **Congelado y legado.** Duplica casi todo el estudio con motor inferior. Mayor lastre. |
| `tienda.html` | ~0.3k | Rodo autónomo en tienda | ⚠️ Copia #2 de Rodo + clima. |
| `sucursal.html` | ~1.1k | Receptor de sucursal | ✅ Simple, receptor WS. |
| `listen.html` | ~0.7k | Oyente público | ✅ La "cara Spotify" para el público. |
| `server.js` | ~1.4k | HTTP + WS + proxies + stream de audio | ✅ Sólido; ya con yt-dlp/ffmpeg y blindaje anti-caídas. |

### Duplicación medida (hoy)
- **DJ Rodo / `RODO_SYSTEM`** está en **2** archivos (`studio`, `tienda`) con prompts que divergen.
- **Clima (`getWeather`/open-meteo/SMN)** está en **3** archivos (`panel`, `studio`, `tienda`).
- **Motor de voz (`_hv`, `synthTTS`/`genAndPlay`)** está en **2** archivos (`studio`, `tienda`).
- **Código compartido real:** **0** archivos `.js` comunes entre páginas (solo `server.js` y `sw.js`).

> Síntoma vivido esta sesión: cada mejora de Rodo, clima, sellos o seguridad hubo que **escribirla dos o tres veces** (una por archivo). Eso es deuda estructural pura.

---

## 2. Comparación con la estructura de Spotify

| Pilar de Spotify | Terrapesca hoy | Veredicto |
|---|---|---|
| **Home / Buscar / Tu biblioteca** (navegación) | ✅ En el estudio (sidebar + vistas) | Cumple |
| **Barra de reproducción persistente** | ✅ En estudio; en `/listen` simplificada | Cumple |
| **Biblioteca + playlists + favoritos + historial** | ✅ IndexedDB v3 | Cumple |
| **Búsqueda** | 🟡 Solo YouTube, no unificada (biblioteca+playlists+YouTube) | Parcial |
| **Reproducción en segundo plano / multi-dispositivo** | 🟡 Nuevo stream yt-dlp (frágil ante bloqueos de YouTube) | Parcial |
| **Núcleo compartido / componentes reutilizables** | ❌ Todo copiado entre páginas | **No cumple** |
| **Cuentas por usuario** | 🟡 Un login único (EDGAR), sin bibliotecas por usuario | Parcial |
| **Carátulas/metadatos ricos de playlist** | 🟡 Playlists sin portada propia ni descripción | Parcial |
| **Fuente de audio estable (catálogo propio)** | ❌ Depende de YouTube (ToS + bloqueos) | Riesgo |

**Conclusión:** la *experiencia* ya es tipo Spotify; la *arquitectura* todavía es de "prototipo crecido". Para que sea Spotify **en su estructura**, el trabajo pendiente es sobre todo **de ingeniería interna**, no de pantallas nuevas.

---

## 3. Deuda y riesgos estructurales (priorizados)

1. **Triplicación de lógica (crítico).** Rodo, clima y voz viven copiados. Cada bug se arregla N veces; las versiones se desincronizan. **Es el techo real para seguir creciendo.**
2. **`panel.html` legado (alto).** ~4.7k líneas congeladas que confunden y pesan. Mientras exista, hay "dos verdades".
3. **Dependencia de YouTube para el audio (alto).** El segundo plano por yt-dlp funciona pero **roza los ToS** y YouTube puede bloquear el servidor. No es una base estable al estilo Spotify.
4. **Estado global frágil en el estudio (medio).** ~25 variables sueltas + varios `setInterval` con locks manuales. Funciona, pero cada feature grande lo tensa.
5. **Secretos mixtos (medio).** Modelo "claves en el navegador" (intencional) conviviendo ahora con claves **en el servidor** (TideCheck). Está bien, pero hay que documentarlo para no confundir.
6. **Sin pruebas ni verificación automatizada (medio).** Todo se valida a mano en el navegador; los errores salen en producción.

---

## 4. Plan recomendado (respetando "sin bundler" y sin tocar el motor)

> Principio: **no** migrar a framework/bundler (es la arquitectura elegida), **no** tocar el crossfade, **no** mover a la fuerza las claves. El objetivo es **un núcleo compartido por simples `<script src>`**, no un rewrite.

### Fase A — Núcleo compartido (la más importante) 🎯
Extraer la lógica repetida a archivos `.js` planos que **todas** las páginas incluyan con `<script src="/core/...">` (sin build, compatible con el modelo actual):
- `/core/rodo.js` — una sola implementación de DJ Rodo (prompt, tipos, variedad, sellos).
- `/core/weather.js` — clima (open-meteo + SMN + mareas) en un solo lugar.
- `/core/voice.js` — TTS (OpenAI/VoiceKiller), `_hv`, selección de motor.
- `/core/data.js` — capa de datos (IndexedDB, biblioteca, playlists, historial).
- `/core/config.js` — claves y ajustes `tp_*`.

**Resultado:** de "5 monolitos que se copian" a "núcleo + cascarones delgados". Cada mejora se hace **una vez**. Es el cambio que más acerca la app a una estructura tipo Spotify.

### Fase B — Jubilar `panel.html`
Migrar lo que Los Mochis todavía use del panel al estudio y retirar el archivo. Una sola cabina.

### Fase C — Elevar playlists y búsqueda a paridad Spotify
- Portada + descripción por playlist; carpetas/orden.
- Búsqueda **unificada** (biblioteca + playlists + YouTube) en un solo cuadro.

### Fase D — Estabilizar la fuente de audio (estratégico)
Evaluar una fuente propia/licenciada (estación Icecast con música licenciada) para que el segundo plano y la continuidad **no dependan de YouTube**. Es lo único que hace a Spotify "Spotify" de verdad: catálogo propio y estable.

### Fase E — (opcional) Cuentas por usuario
Si se quiere multiusuario real (bibliotecas/playlists por persona), pasar del login único a cuentas.

---

## 5. Recomendación de orden

```
Fase A (núcleo compartido)  ← empezar aquí: máximo impacto, bajo riesgo
      └─► Fase B (jubilar panel)      ← posible una vez que el núcleo existe
      └─► Fase C (playlists/búsqueda) ← mejora de producto
Fase D (audio propio)  ← decisión de negocio (licencias) en paralelo
Fase E (cuentas)       ← solo si se necesita multiusuario
```

**Lo más valioso, hoy, es la Fase A.** No agrega pantallas, pero convierte la app en algo mantenible y de verdad "estructurado". Las fases A–C no tocan el motor de crossfade ni requieren build.

---

### Qué NO hacer (se mantiene de `PLAN-SPOTIFY.md`)
- No migrar a framework/bundler (los single-file son la arquitectura).
- No tocar el crossfade dual-deck ni forzar calidad de video.
- No invertir en `panel.html` salvo jubilarlo.
