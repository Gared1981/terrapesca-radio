# 📻 Terrapesca Radio — Guía de Instalación

## Archivos incluidos

| Archivo | Descripción |
|---|---|
| `server.js` | Servidor WebSocket (se sube a Railway) |
| `package.json` | Dependencias del servidor |
| `panel.html` | Panel de control — solo Los Mochis |
| `sucursal.html` | Reproductor — Culiacán y Mazatlán |

---

## PASO 1 — Subir el servidor a Railway

1. Ve a **https://railway.app** e inicia sesión con tu cuenta de GitHub
2. Haz clic en **"New Project"**
3. Elige **"Deploy from GitHub repo"**
   - Si no tienes repositorio, elige **"Empty Project"** → luego **"Add Service"** → **"GitHub Repo"**
4. Sube los archivos `server.js` y `package.json` a un repositorio de GitHub
   - Ve a **github.com**, crea un repositorio nuevo (ej. `terrapesca-radio`)
   - Arrastra ambos archivos al repositorio
5. En Railway, selecciona ese repositorio
6. Railway detectará automáticamente que es Node.js y lo desplegará

## PASO 2 — Obtener la URL del servidor

1. En Railway, abre tu proyecto
2. Ve a la pestaña **"Settings"** del servicio
3. En la sección **"Networking"**, haz clic en **"Generate Domain"**
4. Copia la URL que aparece — se verá así:
   ```
   terrapesca-radio-production.up.railway.app
   ```
5. Tu URL de WebSocket será:
   ```
   wss://terrapesca-radio-production.up.railway.app
   ```

---

## PASO 3 — Configurar el Panel de Los Mochis

1. Abre `panel.html` en Chrome en la computadora de Los Mochis
2. Haz clic en el ícono ⚙️ arriba a la derecha
3. En **"URL del servidor"** pega:
   ```
   wss://TU-URL.railway.app
   ```
4. En **"API Key de ElevenLabs"** pega tu key (`sk_...`)
5. Elige el tipo de voz
6. Haz clic en **"Guardar y conectar"**
7. El indicador arriba debe ponerse verde ✅

---

## PASO 4 — Configurar cada sucursal

1. Copia `sucursal.html` a la computadora de cada sucursal (por USB o correo)
   - También puedes subirlo a Google Drive y que lo descarguen
2. Abre el archivo en Chrome
3. Aparecerá una pantalla de configuración:
   - Selecciona el nombre de la sucursal (Culiacán / Mazatlán)
   - Pega la misma URL del servidor:
     ```
     wss://TU-URL.railway.app
     ```
4. Haz clic en **"Conectar a la señal"**
5. La pantalla mostrará: **"🟢 Señal recibida de Los Mochis"**

> ✅ La configuración se guarda automáticamente. La próxima vez solo abren el archivo y se conecta solo.

---

## PASO 5 — Usar el sistema

### Desde Los Mochis (panel.html):
- Agrega canciones con links de YouTube o archivos MP3
- Sube tu Excel de inventario para generar spots
- Presiona ▶ y todas las sucursales comenzarán a escuchar
- Genera un spot: la IA escribe el guión, ElevenLabs lo narra y se envía automáticamente a todas las sucursales

### En las sucursales (sucursal.html):
- Solo ven el reproductor y el nombre de la canción
- El volumen local lo pueden ajustar ellos mismos
- No pueden controlar nada más

---

## ¿Cuánto cuesta?

| Servicio | Costo |
|---|---|
| Railway (servidor) | Gratis hasta $5/mes de uso |
| ElevenLabs | Gratis: 10,000 caracteres/mes (~25 spots) |
| ElevenLabs Starter | $5/mes para ~100 spots |

---

## Solución de problemas

**"Sin conexión" en el panel:**
- Verifica que la URL del servidor empiece con `wss://` (no `https://`)
- Asegúrate de que Railway esté desplegado y activo

**Las sucursales no reciben la música de YouTube:**
- YouTube solo funciona si ambas computadoras tienen internet
- Para MP3, el audio se transmite directamente por el servidor

**El spot no suena en las sucursales:**
- Verifica que el servidor de Railway esté activo
- Los spots en base64 pueden pesar hasta 2MB — verifica que el internet sea estable

**ElevenLabs da error:**
- Verifica tu API Key en elevenlabs.io → Profile → API Key
- Revisa que tengas créditos disponibles en tu cuenta

---

## Notas importantes

- La playlist de YouTube requiere internet activo en **todas** las computadoras
- Los archivos MP3 que subes en Los Mochis se transmiten como referencia, no como archivo directo (las sucursales necesitan internet para YouTube, los spots de audio sí se transmiten completos)
- El servidor Railway se "duerme" si no hay actividad por 30 minutos en el plan gratuito — la primera conexión del día puede tardar ~30 segundos en despertar
- Para evitar que se duerma, considera el plan Hobby de Railway ($5/mes)
