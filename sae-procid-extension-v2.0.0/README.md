# SAE Procid Capturador — Setup

Extension MV3 que resuelve los `procID` de los expedientes pendientes en la planilla.
Genera un token de reCAPTCHA fresco por consulta desde la propia pagina del
buscador, en la sesion del usuario. Explicacion completa del mecanismo en el
[README raiz](../README.md#cómo-se-resuelve-el-recaptcha).

---

## Arquitectura

```
consultaexpedientes.justucuman.gov.ar
   │
   │ el usuario busca UN expediente y el sitio llama a grecaptcha.execute()
   ▼
[content_main.js — world MAIN]
   hookea grecaptcha.execute y guarda los args exactos (siteKey + action)
   │  ▲
   │  │ CustomEvent + requestId
   ▼  │
[content_iso.js — world ISOLATED]
   puente: traduce CustomEvent ↔ chrome.runtime
   │  ▲
   │  │ chrome.runtime.sendMessage
   ▼  │
[background.js — service worker]
   1. POST getExpedientes  → Web App devuelve filas con col A vacia
   2. por cada expediente (max 25, delay 7s):
        pide token fresco al MAIN world
        GET conexpbe /api/proceedings?number=<numero madre>&captcha=<token>
        indexa la respuesta por nro_expediente y elige por coincidencia exacta
        cachea la busqueda: el principal y sus incidentes salen de un solo token
      ante 401/403/419/422 o 404-de-captcha → corta el lote (preserva el score)
   3. POST saveProcids → el Web App escribe los procID en la columna A
   │
   ▼
[Notificaciones] col A poblada + notificacion de Chrome con el resumen
```

Despues, desde el menu **Notificaciones → 🔍 Extraer ultima entrada y asignar estados
faltantes**, el script lee la columna A, llama al endpoint de historial (que no pide
captcha) y completa historial, PDF y estado.

---

## Setup paso a paso

### 1. Apps Script — publicar Web App

1. Abrir el proyecto Apps Script vinculado al Sheet
2. Asegurarse de tener `WebApp.gs` como archivo en el proyecto
3. Editor → **Implementar → Nueva implementación**
4. Tipo: **Aplicación web**
5. Configuración:
   - **Descripción:** `SAE Procid Capturador v1`
   - **Ejecutar como:** `Yo (tu cuenta)`
   - **Quién tiene acceso:** `Cualquier usuario` (necesario porque la extension hace POST sin auth de Google)
6. Click **Implementar**
7. Copiar la URL que termina en `/exec`

### 2. Chrome Extension — instalar

1. Abrir `chrome://extensions`
2. Activar **Modo de desarrollador** (toggle arriba a la derecha)
3. Click **Cargar descomprimida**
4. Seleccionar la carpeta `sae-procid-extension`
5. La extension aparece en la barra de extensions

### 3. Configurar la extension

1. Click en el icono de la extension (puede estar en el menú de extensions)
2. Pegar **Web App URL** (la del paso 1.7)
3. Pegar **Token de seguridad** — el que devuelve el menú
   **Notificaciones → 🔑 Generar token de la Web App**. El token vive en
   ScriptProperties (`PROCID_SECURITY_TOKEN`), nunca en el código.
4. Click **💾 Guardar config**
5. Verificar que el toggle **"Capturar captcha automáticamente"** esté activo

### 4. Uso

1. Asegurarse que el Sheet tenga filas con expedientes en col D y col A vacía
2. Ir a `https://consultaexpedientes.justucuman.gov.ar/`
3. Buscar **cualquier expediente** (uno solo). Esa búsqueda hace que el sitio llame a
   `grecaptcha.execute`, que es lo que la extension necesita para generar tokens propios
4. El lote arranca solo: un token fresco por consulta, 7s entre consultas, máximo 25
5. Ver la notificación de Chrome con el resultado (guardados / sin match / faltantes)
6. Refrescar el Sheet — col A debería tener procIDs cargados
7. Si quedaron expedientes sin procesar, repetir desde el paso 2

### 5. Extraer última entrada

1. En el Sheet, menú **🔎 SAE Consulta Expedientes → 📋 Extraer última entrada**
2. Para cada fila con procid en col A y col H vacía, hace fetch al history endpoint
3. Concatena `Fecha: dd/mm/yyyy descripción` en col H
4. Notifica al final con stats

---

## Troubleshooting

### Extension no captura

- Verificar que `chrome://extensions` muestre la extension activa sin errores
- Click en "service worker" debajo de la extension para ver consola del background.js
- Asegurarse que el toggle del popup esté en "Capturar captcha automáticamente"
- El captcha debe venir del dominio `conexpbe.justucuman.gov.ar` (no funcionará si el dominio cambia)

### Web App responde "token inválido"

- El token en el popup de la extension debe ser **idéntico** al guardado en ScriptProperties (`PROCID_SECURITY_TOKEN`)
- Si lo cambiaste en el script, hay que **reimplementar** el Web App (Implementar → Administrar implementaciones → editar versión)

### El lote se corta con "faltan N expedientes"

- Es el comportamiento esperado ante un rechazo de captcha: se corta para no seguir
  quemando score. Lo ya resuelto quedó guardado en la columna A
- Volver a buscar un expediente en el sitio: el lote retoma con los que faltan
- Si pasa siempre en el primer item, revisar la consola del service worker: puede ser
  que el sitio haya cambiado la forma de llamar a `grecaptcha.execute`

### "execute aún no fue llamado por el sitio"

- La extension necesita ver **una** llamada real a `grecaptcha.execute` antes de poder
  generar tokens. Buscar un expediente a mano en el sitio y reintentar

### Sheet no se actualiza

- Verificar permisos del Web App (debe ejecutar como vos)
- Refrescar manualmente el Sheet (Apps Script Web App escribe en background)
- Mirar Apps Script Editor → Ejecuciones para ver logs

### Cambiar token de seguridad

1. Menú **Notificaciones → 🔑 Generar token de la Web App**
2. Reimplementar el Web App (nueva versión)
3. Actualizar token en popup de la extension

---

## Archivos

```
sae-procid-extension/
  manifest.json          — config Manifest V3
  background.js          — service worker (intercepta captcha)
  popup.html             — UI de config
  popup.js               — lógica del popup
  README.md              — este archivo

../WebApp.gs  — código Apps Script (copiar al proyecto)
../Codigo.gs — script existente, ya actualizado para col A = procID
```

---

## Notas técnicas

- **Token fresco por consulta:** la v1 interceptaba el token del request saliente y lo
  reusaba dentro de su TTL (~110s). La v2 llama a `grecaptcha.execute` con los argumentos
  capturados del propio sitio y obtiene uno nuevo por consulta: sin ventana de expiración
- **MAIN vs ISOLATED:** `grecaptcha` vive en el contexto de la página, invisible para un
  content script normal. De ahí `"world": "MAIN"` en el manifest y el puente por `CustomEvent`
- **Re-inyección:** si se actualiza la extension con la pestaña abierta, el content script
  queda huérfano (`Receiving end does not exist`). El background lo re-inyecta con
  `chrome.scripting.executeScript` y reintenta. La inyección es idempotente
  (`grecaptcha.__sae_hooked`)
- **Dos MAIN worlds:** tras una re-inyección pueden convivir el closure viejo y el nuevo.
  El listener de ISOLATED prefiere token sobre error y espera hasta el timeout de 10s
- **Número madre:** se consulta siempre por `nnnn/aa` y se elige por coincidencia exacta
  de `nro_expediente`, nunca `data[0]`. Un solo token resuelve el principal y sus incidentes
- **Rate limit:** 7s entre consultas, tope de 25 por lote. El servidor tolera 1000 req/h
  por IP; el límite real es el score de reCAPTCHA, no la API
- **Lock:** `LockService` evita que dos POST simultáneos pisen filas
- **Escritura inmediata:** cada procid se escribe + flush antes de la siguiente request,
  para no perder progreso si el script muere
