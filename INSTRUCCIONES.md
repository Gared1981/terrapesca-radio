# 📻 Terrapesca Radio — Guía de uso

## Archivos del sistema

| Archivo | Quién lo usa | Descripción |
|---|---|---|
| `index.html` | Todos | 🏠 Portada en `/`: elige tu rol (Cabina / Sucursal / Escuchar / Tienda) y muestra qué está al aire |
| `server.js` | Railway | Servidor: WebSocket, proxies de API y stream de audio |
| `studio.html` | **Cabina (Los Mochis)** | ⭐ El control principal: decks con crossfade, DJ Rodo, biblioteca, playlists y búsqueda. Con asistente de bienvenida la primera vez |
| `panel.html` | Los Mochis (legado) | Panel viejo — **congelado**, usar studio.html (disponible en `/panel`) |
| `sucursal.html` | Culiacán y Mazatlán | Reproductor receptor con carátula (no controla nada) |
| `listen.html` | Público | Oyente web: carátula, próximas canciones, favoritos |
| `tienda.html` | Tiendas | DJ Rodo autónomo hablando a clientes (sin música) |

Abre `https://terrapescaradio.com/` y elige tu rol — o directo: `/studio`, `/sucursal`, `/listen`, `/tienda`.

---

## PASO 1 — Servidor en Railway + dominio propio

1. Ve a **https://railway.app** e inicia sesión con GitHub
2. **New Project → Deploy from GitHub repo** y elige este repositorio
3. Railway detecta Node.js y despliega solo
4. **Dominio propio (para que la URL NO cambie nunca):** en **Settings → Networking → Custom Domain** agrega `terrapescaradio.com`. Railway te dará dos registros DNS (un CNAME y un TXT) que debes pegar **donde compraste el dominio** (GoDaddy, Namecheap, etc.). Una vez propaguen (minutos a un par de horas), tu radio vive para siempre en `https://terrapescaradio.com`, sin importar redespliegues.
5. No necesitas configurar ninguna URL en la app: cada página se conecta sola al servidor desde donde se abre.

---

## PASO 2 — Configurar la cabina (studio.html)

1. Abre `https://terrapescaradio.com/studio` en Chrome
2. Clic en **⚙️ CONFIG** y llena:
   - **URL del servidor**: `(automático — deja vacío el campo)`
   - **API Key de OpenAI** (`sk-…`) — voz de DJ Rodo, spots y tienda
   - **API Key de Anthropic** (`sk-ant-…`) — guiones de Rodo y sugerencias
   - **YouTube API Key** — búsqueda de canciones e import de playlists
3. **Guardar y conectar** — el indicador debe ponerse en EN VIVO al reproducir

### Las claves API (dónde se consiguen)
- **OpenAI**: platform.openai.com → API keys → Create new secret key
- **Anthropic**: console.anthropic.com → API Keys
- **YouTube**: console.cloud.google.com → crear proyecto → habilitar *YouTube Data API v3* → Credentials → API Key

> 🔐 Las claves se guardan **solo en el navegador de la cabina** (localStorage). El servidor nunca las almacena.

---

## PASO 3 — Sucursales y oyentes

- **Sucursales**: abrir `https://terrapescaradio.com/sucursal` en cada tienda, elegir la sucursal y conectar. La configuración se guarda sola.
- **Oyentes**: compartir `https://terrapescaradio.com/listen` — ven carátula, qué suena y qué sigue; pueden marcar favoritos y (si la cabina lo permite) pedir siguiente canción.

---

## PASO 4 — Usar la cabina (studio)

### Pestañas
- **🎚 Cabina** — decks A/B con crossfade automático, mixer, DJ Rodo, spots y cola.
- **📚 Biblioteca** — todas las canciones que han pasado por la radio, con filtro y orden (Recientes / 🔥 Top / A-Z), ♥, reproducir, a la cola, a playlist.
- **♥ Me gusta** — tus favoritas.
- **🗂 Playlists** — crear, guardar la cola actual, reproducir o anexar.
- **🕒 Historial** — todo lo que ha sonado (sobrevive recargas).

### Música
- **🔍 Buscar**: escribe el nombre de la canción → ▶ ya / ➕ a la cola / 🗂 a playlist.
- **Pegar link**: video o playlist completa de YouTube.
- **✨ Radio infinita**: Rodo sugiere 5 canciones nuevas según la hora y lo que ha sonado.
- **Barra inferior**: play/pausa, siguiente, 🔀 aleatorio, 🔁/🔂 repetir, seek, volumen y ♥.
- La cola se reordena **arrastrando** las canciones.

### DJ Rodo y spots
- Activa **DJ RODO** en el mixer: habla entre canciones (hora, clima, tips de pesca, spots) con la música baja de fondo — sin silencios.
- Genera spots con IA: escribe el guión o impórtalo de una URL de producto, la voz de OpenAI lo narra y se transmite a todas las sucursales.

---

## ¿Cuánto cuesta?

| Servicio | Costo |
|---|---|
| Railway (servidor) | Gratis hasta $5/mes de uso (Hobby $5/mes evita que se duerma) |
| OpenAI (voz `gpt-4o-mini-tts`) | Pago por uso: ~$0.015 por 1,000 caracteres (unos centavos por spot) |
| Anthropic | Centavos por guión (Claude Sonnet) |
| YouTube API | Gratis (cuota diaria amplia) |

---

## Solución de problemas

**"Sin conexión" en la cabina:**
- Deja **vacío** el campo "URL del servidor" en CONFIG — se conecta solo al mismo servidor donde abriste la página (funciona con cualquier dominio)
- Verifica que Railway esté desplegado y activo

**La búsqueda no funciona:**
- Falta la YouTube API Key en CONFIG, o la key no tiene habilitada *YouTube Data API v3*

**Las sucursales no reciben la música:**
- YouTube requiere internet en todas las computadoras
- El servidor Railway se "duerme" a los 30 min sin actividad en plan gratis — la primera conexión puede tardar ~30 s

**El spot no suena en las sucursales:**
- Los spots viajan en base64 (hasta ~2MB) — se necesita internet estable

**OpenAI o Anthropic dan error:**
- Verifica la API Key y que la cuenta tenga créditos/saldo
- La generación de IA solo está permitida de 9:00 a 18:00 (hora Mazatlán)

---

## Notas

- `PLAN-SPOTIFY.md` documenta la auditoría técnica y el plan de evolución del sistema.
- `panel.html` sigue funcionando pero está congelado: toda mejora nueva vive en `studio.html`.
