# 🎧 Auditoría y Plan — Radio Terrapesca "tipo Spotify"

**Fecha:** Julio 2026
**Objetivo:** convertir la experiencia de la radio (cabina + oyentes) en algo con la usabilidad y estética de Spotify — biblioteca, búsqueda, playlists, cola visible, now-playing con carátula — **sin perder** lo que hace única a la radio: crossfade automático, DJ Rodo con IA y transmisión a sucursales.

---

## PARTE 1 — Auditoría (estado actual)

### 1.1 Qué existe y en qué estado

| Archivo | Rol | Estado |
|---|---|---|
| `studio.html` | Cabina DJ (dual-deck YouTube, crossfade real, DJ Rodo, spots) | ✅ **El motor bueno.** Base del plan. |
| `panel.html` | Panel viejo (Los Mochis) | ⚠️ 207KB de legado. Duplica DJ Rodo, spots, clima, scheduling y mic de studio, pero con motor inferior (un solo player, crossfade solo para MP3). |
| `sucursal.html` | Receptor de tiendas | ⚠️ Funciona, pero el oyente no ve carátula; VU meter y perillas de EQ son decorativos. |
| `listen.html` | Oyente público | ✅ **Ya tiene la estética Spotify prototipada**: carátula grande, fondo blur, MediaSession. Pero shuffle/repeat/corazón son botones falsos. |
| `tienda.html` | Rodo autónomo en tienda | ⚠️ Tercera copia del DJ Rodo, con campaña y fechas hardcodeadas. |
| `server.js` | HTTP + WS + relay de audio + proxies | ✅ Sólido para su tamaño. Motores FFmpeg de stream continuo (fase C) listos tras `RADIO_ENGINE_TEST=1`. |

### 1.2 Qué tiene la radio HOY vs Spotify

| Función Spotify | Estado actual |
|---|---|
| Crossfade / auto-mix | ✅ Sí — dual-deck en studio (la joya del sistema) |
| Cover art | ✅ En studio y listen (thumbnail YouTube); ❌ falta en sucursal |
| Cola visible | ✅ En studio (`renderQueue`), con ↑/↓/✕ | 
| Seek / progreso | ✅ En studio por deck; en listen es indicador "EN VIVO" |
| **Búsqueda de canciones** | ❌ **No existe.** Solo pegar URL/ID de YouTube |
| **Biblioteca navegable** | ❌ No existe. Solo una cola única (`playlist/main` en IndexedDB) |
| **Playlists múltiples** | ❌ Una sola cola compartida studio↔panel |
| **Favoritos / likes** | ❌ El corazón en listen.html no hace nada |
| Shuffle / repeat como modos | ❌ Shuffle removido en panel; no existe en studio (repeat-all implícito) |
| **Historial persistente** | ❌ Solo en memoria (40 items, se pierde al recargar) |
| Metadatos ricos (duración, álbum) | ❌ Track = `{ytId, name, artist}` nada más |
| Drag & drop en cola | ❌ En studio solo botones; panel sí tiene drag&drop (código rescatable) |
| Recomendaciones | 🟡 Parcial: Rodo elige por mood/hora vía Claude, pero solo dentro de la cola |
| Cuentas / multi-dispositivo | 🟡 Modelo propio: broadcast WS a sucursales (suficiente para el caso de uso) |

### 1.3 Bugs y deuda técnica encontrados

1. **Bug real** — `_AUTO_WEATHER_CITIES` se usa en `_resolveWeatherCity()` (studio.html ~L1985) pero nunca se declara → `ReferenceError` con ciudad "auto". Además `getWeather()` ignora el selector de ciudad (UI muerta).
2. **`djVoiceId()` definido dos veces** en studio.html (L537 y L1975); la segunda gana.
3. **`DJ_ROTATION_NORMAL` y `DJ_ROTATION_CAMPAIGN` son idénticas** — la lógica de campaña no cambia la rotación (intención incompleta).
4. **DJ Rodo triplicado** (studio, panel, tienda) con prompts divergentes — cada bug hay que arreglarlo 3 veces.
5. **panel.html duplica casi todo studio.html** con un motor inferior. Es el mayor lastre para evolucionar.
6. **UI mentirosa**: VU meters con `Math.random()` (studio y sucursal), perillas EQ decorativas (sucursal), botones shuffle/repeat/corazón falsos (listen).
7. **Historial no persiste**; **audio como base64 char-a-char** en IndexedDB (ineficiente; mejor `Blob`).
8. `listen.html` envía `NEXT_TRACK`/`PREV_TRACK` por WS pero **el servidor no maneja esos mensajes** (no están en el switch de `server.js`).
9. `sw.js` cachea `panel.html` pero **no** `studio.html` ni `sucursal.html`.
10. `INSTRUCCIONES.md` desactualizado (no menciona studio, listen ni tienda).
11. Estado global frágil en studio: ~25 variables sueltas + 5 `setInterval` coordinados con locks manuales. Funciona, pero cualquier feature nueva grande necesita ordenarlo.

---

## PARTE 2 — Plan "tipo Spotify"

**Principio rector:** el motor dual-deck + DJ Rodo de `studio.html` se **conserva intacto** (es el diferenciador y ya pasó por varios bugs resueltos). Lo que se construye alrededor es la **capa de datos** (biblioteca, playlists, favoritos, historial) y la **capa de UI** (búsqueda, sidebar, now-playing bar, cola arrastrable).

### Fase 0 — Limpieza y cimientos ✅ COMPLETADA
*Sin esto, todo lo demás se construye sobre arena.*

- [x] Corregir bugs 1–3: `_resolveWeatherCity()` ahora usa `WKEYS` (el selector de ciudad de clima funciona y `getWeather()` lo respeta); eliminada la definición duplicada de `djVoiceId()`; `DJ_ROTATION_CAMPAIGN` ahora usa `VENTA_NOCTURNA` (fecha/horarios) en lugar de `PROMO_TEASER`.
- [x] `NEXT_TRACK`/`PREV_TRACK` funcionan de punta a punta: server los relaya y studio los maneja en `_onRemoteCmd()` con cooldown de 3s (NEXT → `skipNext()`, PREV → reinicia la pista).
- [x] Quitadas affordances falsas: corazón/shuffle/repeat de listen (se reintroducen funcionando en Fase 3/4). Las perillas EQ de sucursal se reemplazaron por **carátula real** de la canción (adelanto de Fase 4).
- [x] `panel.html` **congelado** (banner en el archivo + nota en CLAUDE.md). Toda feature nueva va a studio.
- [x] `sw.js` v2: cachea también `studio.html` y `sucursal.html`, y el HTML ahora es **network-first** (los deploys ya no quedan atorados en cache; el cache solo se usa offline).

### Fase 1 — Modelo de datos tipo Spotify (1–2 sesiones)
*El cambio estructural más importante.*

- [ ] **Track enriquecido:** `{id, ytId, title, artist, duration, cover, addedAt, playCount, liked}`. La duración se captura del player la primera vez que suena y se persiste.
- [ ] **IndexedDB v3** (`TerrapescaRadio`):
  - `tracks` (ya existe, hoy sin uso) → **biblioteca**: todo track que alguna vez se agregó, keyPath `ytId`.
  - `playlists` (nuevo): `{id, name, cover, trackIds[], createdAt}`. La cola actual `playlist/main` migra a la playlist "Radio Terrapesca" para no romper panel.
  - `history` (nuevo): `{ts, ytId}` — historial persistente, límite 500.
  - Favoritos = flag `liked` en `tracks` + playlist virtual "Tus me gusta".
- [ ] **Migración automática** al abrir studio: v2 → v3 sin perder la cola ni los spots.
- [ ] Enriquecer el mensaje WS `PLAY` con `{cover, duration}` para que sucursal/listen pinten mejor su now-playing sin pedir nada extra.

### Fase 2 — Búsqueda (1 sesión)
- [ ] Nuevo proxy en `server.js`: `GET /api/ytsearch?q=...&key=...` → YouTube Data API v3 `search.list` (type=video, videoCategoryId=10 Música). Mismo modelo de secrets: la key `tp_yt` viaja del navegador como query param, el servidor no guarda nada.
- [ ] En studio: caja de búsqueda con resultados (carátula, título, canal, duración vía `videos.list`) y acciones **▶ Reproducir ya / ➕ A la cola / 💾 A playlist**.
- [ ] Mantener el input de pegar URL/playlist como está (ya funciona).

### Fase 3 — UI tipo Spotify en studio (2–3 sesiones)
*Reorganización visual sin tocar el motor de audio.*

- [ ] **Layout de 3 zonas** estilo Spotify:
  - **Sidebar izquierda:** Inicio / Buscar / Tu biblioteca + lista de playlists.
  - **Centro:** vista activa (playlist abierta, resultados de búsqueda, historial, "Tus me gusta").
  - **Now-playing bar inferior fija:** carátula, título/artista, controles (⏮ ⏯ ⏭, shuffle, repeat), barra de seek, volumen master, botón 🎚️ que abre la **cabina** actual (decks + mixer + Rodo) como vista avanzada.
- [ ] **Cola arrastrable** (drag&drop — portar patrón de panel.html L2529) + "reproducir a continuación".
- [ ] **Shuffle y repeat reales** como modos persistidos (`tp_shuffle`, `tp_repeat`), respetados por el watcher de auto-mix al elegir la siguiente pista.
- [ ] Corazón funcional (persiste `liked`) e historial navegable ("Reproducido recientemente").
- [ ] La cabina DJ (decks A/B, mixer, Rodo, spots) **no se rediseña** — se mueve a una vista/pestaña "Cabina". Cero cambios al motor: mismos IDs de DOM, mismos watchers.

### Fase 4 — Oyentes (sucursal + listen) (1–2 sesiones)
- [ ] `sucursal.html`: carátula grande + fondo blur (portar el patrón de listen.html), usar `cover/duration` del WS enriquecido. Quitar decoración falsa.
- [ ] `listen.html`: corazón funcional (favoritos locales del oyente), cola "próximas canciones" de solo lectura (nuevo mensaje WS `QUEUE_PREVIEW` con las siguientes 3–5 pistas, enviado por studio en cada crossfade), animación/estado "DJ Rodo al aire".
- [ ] MediaSession con carátula real en ambos.

### Fase 5 — Inteligencia y extras (opcional, 1–2 sesiones)
- [ ] **"Radio infinita":** cuando la cola se acaba, Claude sugiere pistas nuevas (títulos/artistas afines al mood/hora) y se resuelven a videos con `/api/ytsearch` — recomendaciones de verdad, no solo dentro de la cola.
- [ ] **Playlists por mood/hora:** materializar los `MOODS` existentes como playlists visibles ("Mañana tranquila", "Tarde de energía") que Rodo puede anunciar.
- [ ] Estadísticas simples: top canciones por `playCount`, para que el equipo sepa qué suena más.
- [ ] Actualizar `INSTRUCCIONES.md` al flujo real (studio + sucursal + listen).

### Qué NO hacer (decisiones explícitas)
- **No** migrar a un framework/bundler: los archivos single-file son la arquitectura del proyecto y funcionan en las tiendas sin build.
- **No** tocar el motor de crossfade ni forzar calidad de video (regresiones conocidas documentadas en CLAUDE.md).
- **No** mover las API keys al servidor (modelo de secrets intencional).
- **No** invertir en panel.html: queda congelado hasta que studio lo reemplace del todo en Los Mochis.

### Orden y dependencias

```
Fase 0 (limpieza) ──► Fase 1 (datos) ──► Fase 2 (búsqueda) ──► Fase 3 (UI studio)
                                   └────────────────────────► Fase 4 (oyentes)
                                                                    └► Fase 5 (extras)
```

Las fases 0–2 son de bajo riesgo (no tocan el motor). La fase 3 es la más grande pero es solo reorganización de DOM/CSS + un store de datos; el motor de decks queda idéntico. Cada fase es un PR independiente y desplegable.
