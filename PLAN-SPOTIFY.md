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

### Fase 1 — Modelo de datos tipo Spotify ✅ COMPLETADA
*El cambio estructural más importante.*

- [x] **Track enriquecido:** `{ytId, title, artist, duration, cover, addedAt, playCount, liked, lastPlayedAt}` en la biblioteca (`libUpsert`). La duración se captura del player ~5s después de empezar a sonar y se persiste. Escrituras serializadas (`_libQueue`) para que reproducciones rápidas no se pisen el `playCount`.
- [x] **IndexedDB v3** (`TerrapescaRadio`): `tracks` recreado como **biblioteca** (keyPath `ytId`); `playlists` nuevo (`{id, name, trackIds[], createdAt}`, con playlist default "Radio Terrapesca" sembrada desde la cola); `history` nuevo (persistente, cap 500). Favoritos = flag `liked` (`libSetLiked`) — la UI llega en Fase 3.
- [x] **Migración automática** v2 → v3 verificada en navegador: cola y spots intactos, biblioteca sembrada desde la cola, panel.html también actualizado a v3 (abrir con versión menor lanzaba `VersionError`).
- [x] Mensaje WS `PLAY` enriquecido con `{cover, duration}`; sucursal y listen lo prefieren sobre el thumbnail derivado.
- [x] **Bonus:** el historial ahora también registra las canciones que entran por crossfade automático (antes solo las cargadas a mano) y sobrevive recargas (`loadHistoryIDB`).

### Fase 2 — Búsqueda ✅ COMPLETADA
- [x] Proxy `GET /api/ytsearch?q=...&key=...` en `server.js`: `search.list` (type=video, categoría Música, 12 resultados) + `videos.list` para duraciones en una sola respuesta `{items:[{ytId,title,channel,thumb,duration}]}`. Mismo modelo de secrets (la key `tp_yt` viaja del navegador).
- [x] En studio: caja "🔍 Buscar canciones en YouTube" arriba de la cola, resultados con carátula/título/canal/duración y acciones **▶ Reproducir ya** (inserta después de la actual y la lanza) y **➕ A la cola** (sin duplicados). Todo lo agregado entra a la biblioteca con su duración. La acción "a playlist" llega con la UI de playlists en Fase 3.
- [x] El input de pegar URL/playlist sigue igual, y ahora también alimenta la biblioteca (`libUpsert` en los tres caminos de `addYTLink`).

### Fase 3 — UI tipo Spotify en studio ✅ COMPLETADA
*Reorganización visual sin tocar el motor de audio.*

- [x] **Navegación por vistas** (pestañas bajo el header en lugar de sidebar — misma función, cero riesgo para el layout de la cabina): **Cabina / Biblioteca / Me gusta / Playlists / Historial**. La cabina nunca sale del DOM (se oculta con `offstage`, los decks de YouTube siguen sonando).
- [x] **Now-playing bar inferior fija:** carátula, título/artista, ♥ funcional, controles ⏮ ⏯ ⏭ + 🔀 shuffle + 🔁/🔂 repeat, barra de seek clicable y volumen master sincronizado con el mixer.
- [x] **Shuffle y repeat reales** persistidos (`tp_shuffle`, `tp_repeat`): `nextQueueIndex()` es ahora el selector único de "siguiente canción" para el watcher, crossfade, DJ y cues manuales. Shuffle prefiere lo no reproducido recientemente; repetir-una respeta el salto manual (⏭ avanza, como Spotify).
- [x] **Cola arrastrable** (drag & drop) además de los botones ↑/↓; `queuePos` se reubica correctamente.
- [x] **Biblioteca** con filtro por título/artista, duración, contador de reproducciones, ♥, ▶ ya, ➕ a la cola y 🗂 a playlist. **Me gusta** = vista filtrada. **Historial** persistente navegable con ▶.
- [x] **Playlists funcionales:** crear, guardar la cola actual como playlist, abrir (detalle con quitar canción), ▶ reproducir (reemplaza cola), ➕ anexar a cola, eliminar. Menú flotante 🗂 "agregar a playlist" disponible en biblioteca y resultados de búsqueda.

### Fase 4 — Oyentes (sucursal + listen) ✅ COMPLETADA
- [x] `sucursal.html`: carátula en la consola (desde Fase 0) + **fondo difuminado** con la misma carátula (patrón de listen). Usa `cover` del WS enriquecido. Decoración falsa eliminada en Fase 0.
- [x] `listen.html`: **corazón funcional** (favoritos locales en `tp_listen_likes`), **"Próximas canciones"** de solo lectura vía mensaje `QUEUE_PREVIEW` (studio lo emite con cada `PLAY`, el server lo guarda en `radioState` y lo incluye en el `SYNC` para clientes nuevos), y estado "🎙 DJ Rodo al aire" cuando llega un SPOT sin video.
- [x] La metadata se conecta desde el load: el oyente ve qué suena y qué sigue **antes** de pulsar "Escuchar" (el audio sigue requiriendo el tap por la política de autoplay).
- [x] MediaSession ya usaba carátula real en listen; ahora prefiere el `cover` del WS.

### Fase 5 — Inteligencia y extras ✅ COMPLETADA
- [x] **"✨ Radio infinita":** botón en la cola — Claude sugiere 5 canciones reales según el mood por hora y el historial reciente (evitando lo que ya está en cola), y cada sugerencia se resuelve a un video real con `/api/ytsearch`. Las nuevas entran a la cola y a la biblioteca.
- [x] **Radio infinita automática:** cuando casi toda la cola ya sonó (`_freshQueue()` agotada), `_maybeAutoSuggest()` pide música nueva sola (requiere AI SELECCIÓN + claves; cooldown de 15 min).
- [x] **"✨ Del momento" (playlist por mood):** en la vista Playlists, la IA elige de la biblioteca las canciones que encajan con el mood de la hora y crea la playlist (ej. "Tarde relajada · 05 jul").
- [x] **Estadísticas:** orden "🔥 Top canciones" (por `playCount`) y "A–Z" en la Biblioteca, además de Recientes.
- [x] `INSTRUCCIONES.md` reescrito al flujo real: studio como control principal, sucursal/listen/tienda, claves API y troubleshooting actual.

### Fase 6 — Rediseño visual ✅ COMPLETADA
- [x] **Look moderno** en studio: glassmorphism (paneles translúcidos con `backdrop-filter: blur`), fondo con malla de luces ambiental (rojo/cian/violeta), radios más amplios, pestañas píldora con acento en gradiente rojo, botón de play circular con glow, barra de progreso con gradiente que crece al hover, filas con hover deslizante, scrollbars finos personalizados, toast píldora con blur y micro-transiciones en todos los botones. **Solo CSS** — ni un ID ni una clase que use el JS cambió.

---

## Estado final — PROYECTO COMPLETO ✅

**Las 7 fases (0–6) están implementadas y verificadas.** La radio conserva su motor dual-deck con
crossfade y DJ Rodo intactos, y ahora tiene: biblioteca persistente con favoritos e historial,
playlists múltiples (manuales, desde la cola y por mood con IA), búsqueda de YouTube, shuffle/repeat
reales, barra de now-playing tipo Spotify, cola arrastrable, radio infinita (manual y automática),
oyentes que ven carátula y próximas canciones, y un diseño visual moderno tipo glass.

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
