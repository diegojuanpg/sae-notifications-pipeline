# SAE Procid Capturador — Setup

Sistema completo: extension Chrome captura captcha del buscador de SAE → manda a Apps Script Web App → Web App extrae procIDs y los escribe en columna A de Notificaciones automáticamente.

---

## Arquitectura

```
[Browser]                          [Apps Script]
consultaexpedientes.justucuman.gov.ar
   │
   │ 1. user busca expte → resuelve captcha
   │
   ▼
[Extension Chrome]
  background.js intercepta request a
  conexpbe.justucuman.gov.ar/api/proceedings
  extrae el captcha del query param
   │
   │ 2. POST captcha + token
   ▼
[Web App doPost]
  3. Lee Notificaciones, filas con col A vacía
  4. Loop expedientes:
     GET /api/proceedings?...&captcha=TOKEN
     Parse procid del response
     setValue(col A) inmediato (transaccional)
  5. Si captcha expira (404/419) → corta loop
   │
   ▼
[Notificaciones]
  Col A poblada con procIDs
```

Después, manualmente desde el menú **🔎 SAE Consulta Expedientes → 📋 Extraer última entrada**, el script lee col A (procIDs), llama el endpoint history, escribe la última entrada concatenada en col H.

---

## Setup paso a paso

### 1. Apps Script — publicar Web App

1. Abrir el proyecto Apps Script vinculado al Sheet
2. Asegurarse de tener `SAE_Procid_WebApp.js` como archivo en el proyecto
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
3. Pegar **Token de seguridad** — exactamente igual al `SECURITY_TOKEN` que está en `SAE_Procid_WebApp.js`:
   ```
   ***TOKEN-ROTADO***
   ```
4. Click **💾 Guardar config**
5. Verificar que el toggle **"Capturar captcha automáticamente"** esté activo

### 4. Uso

1. Asegurarse que el Sheet tenga filas con expedientes en col D y col A vacía
2. Ir a `https://consultaexpedientes.justucuman.gov.ar/`
3. Buscar **cualquier expediente** (uno solo) y resolver el captcha
4. La extension intercepta el captcha y dispara el Web App
5. Ver la notificación de Chrome con el resultado (procesados / saltados / cortado)
6. Refrescar el Sheet — col A debería tener procIDs cargados
7. Si quedaron expedientes sin procesar (captcha expiró), repetir desde el paso 2

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

- El token en el popup de la extension debe ser **idéntico** al `SECURITY_TOKEN` en `SAE_Procid_WebApp.js`
- Si lo cambiaste en el script, hay que **reimplementar** el Web App (Implementar → Administrar implementaciones → editar versión)

### Web App responde "captcha inválido/expirado"

- El captcha tiene TTL ~2 min. Si tardó mucho en disparar, reintentar haciendo otra búsqueda
- Si pasa siempre, puede ser que la API esté validando el token contra Google (en cuyo caso necesitamos otro approach)

### Sheet no se actualiza

- Verificar permisos del Web App (debe ejecutar como vos)
- Refrescar manualmente el Sheet (Apps Script Web App escribe en background)
- Mirar Apps Script Editor → Ejecuciones para ver logs

### Cambiar token de seguridad

1. Editar `SECURITY_TOKEN` en `SAE_Procid_WebApp.js`
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

../SAE_Procid_WebApp.js  — código Apps Script (copiar al proyecto)
../SAE_Apremios_Script.js — script existente, ya actualizado para col A = procID
```

---

## Notas técnicas

- **Single token, multiple lookups:** confirmado por test, el captcha reCAPTCHA es reusable dentro de su TTL para distintos `number` params
- **TTL configurable:** `CAPTCHA_TTL_MS` en `SAE_Procid_WebApp.js` (default 110s, deja margen sobre los ~120s reales)
- **Rate limit:** servidor permite 1000 req/h por IP, sobra para 30 expedientes
- **Lock:** `LockService` evita que dos POSTs simultáneos pisen filas
- **Escritura inmediata:** cada procid encontrado se escribe + flush ANTES de la siguiente request, para no perder progreso si el script muere
