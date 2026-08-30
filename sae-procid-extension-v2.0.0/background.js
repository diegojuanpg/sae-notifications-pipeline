const TARGET_URL_PATTERN = '*://conexpbe.justucuman.gov.ar/*';
const DEBOUNCE_MS = 3000;
const SAE_API_BASE = 'https://conexpbe.justucuman.gov.ar/api';
const SAE_ORIGIN = 'https://consultaexpedientes.justucuman.gov.ar';
const REQUEST_DELAY_MS = 7000;
const TOKEN_RETRY_DELAY_MS = 1000;
const MAX_TOKEN_RETRIES = 3;
const BATCH_LIMIT = 25;

// ── Expedientes e incidentes ───────────────────────────────────
// El buscador de SAE sólo indexa el número madre: pedir "3831/26-Q1" no devuelve
// nada, pero pedir "3831/26" devuelve el principal Y sus incidentes. Por eso se
// consulta siempre por la madre y después se elige por número exacto.

// "3831/26-Q1" -> "3831/26" | "3831/26" -> "3831/26" | basura -> ''
function expteBase(expte) {
  if (!expte) return '';
  const m = expte.toString().trim().match(/^\s*(\d+\s*\/\s*\d+)/);
  return m ? m[1].replace(/\s+/g, '') : '';
}

function normalizarExpte(expte) {
  if (!expte) return '';
  return expte.toString().trim().toUpperCase().replace(/\s+/g, '');
}

let lastDispatch = { captcha: null, ts: 0 };
let isProcessing = false;
let executeReady = false;

console.log('[SAE Procid] background.js cargado @ ' + new Date().toISOString());

// ── Listeners de red (detección de actividad) ──────────────────

try {
  chrome.webRequest.onBeforeRequest.addListener(
    handleRequest,
    { urls: [TARGET_URL_PATTERN] }
  );
  console.log('[SAE Procid] onBeforeRequest registrado: ' + TARGET_URL_PATTERN);

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      console.log('[SAE Procid] onCompleted:', details.url, 'status', details.statusCode);
    },
    { urls: [TARGET_URL_PATTERN] }
  );
  console.log('[SAE Procid] onCompleted registrado: ' + TARGET_URL_PATTERN);

  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      console.warn('[SAE Procid] onErrorOccurred:', details.url, details.error);
    },
    { urls: [TARGET_URL_PATTERN] }
  );
} catch (err) {
  console.error('[SAE Procid] error registrando listener:', err);
}

chrome.runtime.onInstalled.addListener((details) => {
  console.log('[SAE Procid] onInstalled:', details.reason);
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[SAE Procid] onStartup');
});

// ── Listener de mensajes del content script ────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === 'CAPTCHA_CAPTURED' && msg.captcha) {
    log('captcha capturado desde content script (' + msg.captcha.substring(0, 12) + '...)');
    // Ya no usamos el captcha directamente, solo lo tomamos como señal
    // de que el usuario hizo una búsqueda → disparar el flujo
    triggerProceso(sender.tab ? sender.tab.id : null, true);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'EXECUTE_READY') {
    executeReady = true;
    log('grecaptcha.execute detectado en la página, args: ' + JSON.stringify(msg.args));
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// ── Procesamiento ──────────────────────────────────────────────

function triggerProceso(tabId, isFromContentScript = false) {
  const now = Date.now();
  // Solo aplicamos debounce si ya pasó poco tiempo.
  // Pero si el mensaje viene del content script y antes fue un fallback, le damos prioridad
  // actualizando el tabId (para no mensajear a la tab incorrecta).
  if (now - lastDispatch.ts < DEBOUNCE_MS) {
    if (isFromContentScript && tabId && lastDispatch.tabId !== tabId) {
       log('actualizando tabId principal a ' + tabId + ' a pesar del debounce');
       lastDispatch.tabId = tabId;
    } else {
       log('debounce activo, ignorando');
    }
    return;
  }
  lastDispatch.ts = now;
  lastDispatch.tabId = tabId;

  chrome.storage.local.get(['webAppUrl', 'token', 'enabled'], (cfg) => {
    if (cfg.enabled === false) {
      log('extension deshabilitada');
      return;
    }
    if (!cfg.webAppUrl || !cfg.token) {
      log('falta config: webAppUrl o token');
      notify('SAE Procid', 'Falta configurar Web App URL o token');
      return;
    }
    log('búsqueda detectada — iniciando proceso');
    ejecutarFlujoCompleto(cfg.webAppUrl, cfg.token);
  });
}

function handleRequest(details) {
  try {
    const url = new URL(details.url);
    if (!url.pathname.endsWith('/api/proceedings')) return;

    const captcha = url.searchParams.get('captcha');
    if (!captcha || captcha.length < 50) return;

    console.log('[SAE Procid] request detectado con captcha (fallback trigger)');
    // Fallback: también dispara desde aquí por si el content script
    // no puede comunicarse (Extension context invalidated tras reload)
    triggerProceso(null);
  } catch (err) {
    log('error en handleRequest: ' + err.message);
  }
}

// ── Re-inyectar content scripts si el contexto está invalidado ──

async function reinyectarContentScripts(tabId) {
  try {
    // MAIN world primero (provee grecaptcha hook). Idempotente: chequea __sae_hooked.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content_main.js'],
      world: 'MAIN',
    });
    // ISOLATED después (tiene el listener chrome.runtime onMessage que estaba muerto).
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content_iso.js'],
      world: 'ISOLATED',
    });
    log('content scripts re-inyectados en tab ' + tabId);
    // Pequeña espera para que listeners se registren
    await sleep(300);
    return true;
  } catch (err) {
    log('error re-inyectando en tab ' + tabId + ': ' + err.message);
    return false;
  }
}

// ── Pedir token fresco al content script ──────────────────────

async function pedirTokenFresco(tabId) {
  let tabsToTry = [];
  if (tabId) {
    tabsToTry.push(tabId);
  }

  // Buscar todas las tabs si no hay tabId o para tener fallback
  const allTabs = await chrome.tabs.query({ url: '*://consultaexpedientes.justucuman.gov.ar/*' });
  if (allTabs.length > 0) {
    // Ordenar priorizando la tab activa
    allTabs.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
    for (const t of allTabs) {
      if (!tabsToTry.includes(t.id)) tabsToTry.push(t.id);
    }
  }

  if (tabsToTry.length === 0) {
    throw new Error('No hay pestañas abiertas de consultaexpedientes.justucuman.gov.ar');
  }

  // Intentar pedir token a cada tab hasta que una responda
  for (const tid of tabsToTry) {
    let yaReinyectado = false;
    for (let attempt = 1; attempt <= MAX_TOKEN_RETRIES; attempt++) {
      try {
        const response = await chrome.tabs.sendMessage(tid, {
          type: 'REQUEST_FRESH_TOKEN',
        });

        if (response && response.success && response.token) {
          return response.token;
        }

        const errorMsg = (response && response.error) || 'sin token en respuesta';
        log('Intento ' + attempt + '/' + MAX_TOKEN_RETRIES + ' en tab ' + tid + ' falló: ' + errorMsg);

        if (attempt < MAX_TOKEN_RETRIES) {
          await sleep(TOKEN_RETRY_DELAY_MS);
        }
      } catch (err) {
        log('Intento ' + attempt + '/' + MAX_TOKEN_RETRIES + ' en tab ' + tid + ' error: ' + err.message);
        // Content script muerto (extension actualizada o tab cargada antes del install).
        // Re-inyectar y reintentar una vez en esta misma tab.
        if (err.message.includes('Receiving end does not exist') ||
            err.message.includes('context invalidated')) {
          if (!yaReinyectado) {
            yaReinyectado = true;
            log('content script muerto en tab ' + tid + ', re-inyectando...');
            const ok = await reinyectarContentScripts(tid);
            if (ok) {
              continue; // reintentar sendMessage en esta misma tab
            }
          }
          break; // re-inyección falló o ya fue intentada → pasar a siguiente tab
        }
        if (attempt < MAX_TOKEN_RETRIES) {
          await sleep(TOKEN_RETRY_DELAY_MS);
        }
      }
    }
  }

  throw new Error('No se pudo obtener token fresco tras intentar en ' + tabsToTry.length + ' pestañas');
}

// ── Flujo completo: getExpedientes → fetch SAE → saveProcids ──

async function ejecutarFlujoCompleto(webAppUrl, token) {
  if (isProcessing) {
    log('ya hay un proceso en curso, ignorando');
    return;
  }
  isProcessing = true;
  const startTs = Date.now();

  try {
    // Paso 1: Pedir lista de expedientes sin procid al Web App
    log('Paso 1: pidiendo expedientes sin procid a Web App...');
    const expResponse = await callWebApp(webAppUrl, {
      token,
      action: 'getExpedientes',
    });

    if (!expResponse.success) {
      log('Error obteniendo expedientes: ' + (expResponse.error || 'desconocido'));
      notify('❌ SAE Procid', 'Error obteniendo expedientes: ' + (expResponse.error || 'desconocido'));
      return;
    }

    const expedientes = expResponse.expedientes || [];
    const jurisdiccion = expResponse.jurisdiccion || 18;
    log('Recibidos ' + expedientes.length + ' expedientes pendientes (v' + (expResponse.version || '?') + ')');

    if (expedientes.length === 0) {
      notify('✅ SAE Procid', 'No hay expedientes pendientes de procid.');
      chrome.storage.local.set({
        lastResult: { success: true, processed: 0, message: 'sin pendientes' },
        lastTimeIso: new Date().toISOString(),
      });
      return;
    }

    // Paso 2: Consultar la API SAE con tokens frescos (máximo BATCH_LIMIT por corrida)
    // Deduplicar expedientes: si un mismo nro aparece en varias filas, solo consultar 1 vez
    const totalPendientes = expedientes.length;
    const procesarHasta = Math.min(totalPendientes, BATCH_LIMIT);
    const procidCache = {};   // cache expte completo → procid | null
    const busquedaCache = {}; // cache número madre → { nro_expediente normalizado: procid }
                              // Una sola consulta (un solo token) sirve para el
                              // principal y todos sus incidentes.
    log('Paso 2: consultando API SAE para ' + procesarHasta + ' de ' + totalPendientes + ' expedientes (batch de ' + BATCH_LIMIT + ', delay ' + (REQUEST_DELAY_MS/1000) + 's)...');
    const results = [];
    let errores = 0;
    let sinMatch = 0;
    let captchaExpirado = false;
    let detenidoAntes = false;
    let iDetener = procesarHasta;
    let consultasReales = 0;

    for (let i = 0; i < procesarHasta; i++) {
      const item = expedientes[i];

      // Deduplicación: si ya consultamos este expediente, reutilizar el procid
      if (procidCache[item.expte] !== undefined) {
        const cachedProcid = procidCache[item.expte];
        if (cachedProcid) {
          results.push({ fila: item.fila, procid: cachedProcid });
          log('♻️ [' + (i + 1) + '/' + expedientes.length + '] ' + item.expte + ' → ' + cachedProcid + ' (cache)');
        } else {
          log('♻️ [' + (i + 1) + '/' + expedientes.length + '] ' + item.expte + ' sin match (cache)');
          sinMatch++;
        }
        continue; // No consume token ni delay
      }

      // Si ya buscamos el número madre, resolvemos de ahí sin gastar otro token
      // (caso típico: el principal y su incidente en la misma corrida)
      const base = expteBase(item.expte);
      if (base && busquedaCache[base] !== undefined) {
        const encontrados = busquedaCache[base];
        const procidCacheado = encontrados ? encontrados[normalizarExpte(item.expte)] : null;
        if (procidCacheado) {
          procidCache[item.expte] = procidCacheado;
          results.push({ fila: item.fila, procid: procidCacheado });
          log('♻️ [' + (i + 1) + '/' + expedientes.length + '] ' + item.expte + ' → ' + procidCacheado + ' (búsqueda de ' + base + ')');
        } else {
          procidCache[item.expte] = null;
          sinMatch++;
          log('♻️ [' + (i + 1) + '/' + expedientes.length + '] ' + item.expte + ' sin match en búsqueda de ' + base);
        }
        continue; // No consume token ni delay
      }

      if (!base) {
        log('⚠️ [' + (i + 1) + '/' + expedientes.length + '] "' + item.expte + '" no tiene formato nro/año — salteado');
        procidCache[item.expte] = null;
        sinMatch++;
        continue;
      }

      // Obtener un token fresco para CADA consulta
      let freshToken;
      try {
        freshToken = await pedirTokenFresco(lastDispatch.tabId);
        log('[' + (i + 1) + '/' + expedientes.length + '] token fresco para ' + item.expte);
      } catch (tokenErr) {
        log('Error obteniendo token fresco en item ' + (i + 1) + ': ' + tokenErr.message);
        captchaExpirado = true;
        detenidoAntes = true;
        iDetener = i;
        break;
      }

      const apiUrl = SAE_API_BASE + '/proceedings'
        + '?jurisdiction=' + jurisdiccion
        + '&page=1&unit=&number=' + encodeURIComponent(base)
        + '&actor=&accused=&captcha=' + encodeURIComponent(freshToken);

      try {
        const resp = await fetch(apiUrl, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'Origin': SAE_ORIGIN,
            'Referer': SAE_ORIGIN + '/',
          },
        });

        const code = resp.status;

        // Detectar captcha inválido por cualquier status code
        let isCaptchaFail = false;

        if (code === 401 || code === 403 || code === 419 || code === 422) {
          log('Captcha rechazado en item ' + (i + 1) + ', status ' + code);
          isCaptchaFail = true;
        }

        if (code === 404) {
          let body404 = null;
          try { body404 = await resp.json(); } catch (e) { /* ignore */ }

          if (body404 && body404.message && body404.message.toLowerCase().includes('captcha')) {
            log('404 captcha fail para ' + item.expte + ': ' + body404.message);
            isCaptchaFail = true;
          } else {
            // 404 real = expediente no existe en SAE
            log('404 real para ' + base + ' (no encontrado en SAE)');
            busquedaCache[base] = null;
            procidCache[item.expte] = null; // cachear "sin match"
            sinMatch++;
            consultasReales++;
            continue;
          }
        }

        if (isCaptchaFail) {
          // No reintentar — detenerse inmediatamente para no quemar más score
          log('❌ Captcha fail en item ' + (i + 1) + ', deteniendo lote para preservar score');
          captchaExpirado = true;
          detenidoAntes = true;
          iDetener = i;
          errores++;
          break;
        }

        // Si llegamos acá, el request fue exitoso

        if (code !== 200) {
          log('Status ' + code + ' para ' + item.expte);
          errores++;
          consultasReales++;
          continue;
        }

        const json = await resp.json();
        consultasReales++;

        // La búsqueda por número madre devuelve el principal Y sus incidentes.
        // Se indexa por nro_expediente y se elige por coincidencia exacta:
        // NUNCA data[0] — el incidente suele venir primero que el principal.
        const encontrados = {};
        if (json.success && Array.isArray(json.data)) {
          for (const reg of json.data) {
            const nro = normalizarExpte(reg.nro_expediente);
            if (nro && reg.procid) encontrados[nro] = reg.procid;
          }
        }
        busquedaCache[base] = encontrados;

        const procid = encontrados[normalizarExpte(item.expte)];
        if (!procid) {
          const devueltos = Object.keys(encontrados);
          log('⚠️ ' + item.expte + ' no está entre los ' + devueltos.length +
            ' resultados de ' + base + (devueltos.length ? ' [' + devueltos.join(', ') + ']' : ''));
          procidCache[item.expte] = null;
          sinMatch++;
          continue;
        }

        procidCache[item.expte] = procid; // cachear para duplicados
        results.push({ fila: item.fila, procid: procid });
        log('✅ [' + (i + 1) + '/' + expedientes.length + '] ' + item.expte + ' → ' + procid);
      } catch (err) {
        log('Error fetch ' + item.expte + ': ' + err.message);
        errores++;
        consultasReales++;
      }

      if (i < procesarHasta - 1) {
        await sleep(REQUEST_DELAY_MS);
      }
    }

    log('Consultas reales a SAE: ' + consultasReales + ', reutilizadas de cache: ' + (procesarHasta - consultasReales - (detenidoAntes ? (procesarHasta - iDetener) : 0)));

    const faltantes = totalPendientes - (detenidoAntes ? iDetener : procesarHasta);
    const faltanPorBatch = !detenidoAntes && procesarHasta < totalPendientes;
    if (faltanPorBatch) {
      detenidoAntes = true;
    }
    log('Paso 2 completado: ' + results.length + ' encontrados, ' + sinMatch + ' sin match, ' + errores + ' errores' +
      (detenidoAntes ? ', detenido en item ' + iDetener + ', faltan ' + faltantes : ''));

    await guardarResultados(webAppUrl, token, results, sinMatch, errores, captchaExpirado, startTs, detenidoAntes, faltantes);
  } catch (err) {
    log('Error en flujo completo: ' + err.message);
    notify('❌ SAE Procid', 'Error: ' + err.message);
    chrome.storage.local.set({
      lastResult: { success: false, error: err.message },
      lastTimeIso: new Date().toISOString(),
    });
  } finally {
    isProcessing = false;
  }
}

// ── Guardar resultados en Web App ─────────────────────────────

async function guardarResultados(webAppUrl, token, results, sinMatch, errores, captchaExpirado, startTs, detenidoAntes, faltantes) {
  faltantes = faltantes || 0;

  if (results.length === 0) {
    const tookMs = Date.now() - startTs;
    let msg;
    if (detenidoAntes && faltantes > 0) {
      msg = 'Sin procids encontrados. Faltan ' + faltantes + ' expedientes por procesar.';
    } else {
      msg = 'Sin procids nuevos. Sin match: ' + sinMatch + ' | Errores: ' + errores;
    }
    log(msg);
    notify('ℹ️ SAE Procid', msg);
    chrome.storage.local.set({
      lastResult: { success: true, saved: 0, sinMatch, errores, captchaExpirado, detenidoAntes, faltantes },
      lastTimeIso: new Date().toISOString(),
      lastTookMs: tookMs,
    });
    return;
  }

  log('Paso 3: guardando ' + results.length + ' procids en la hoja...');
  const BATCH_SIZE = 50;
  let totalGuardados = 0;
  let totalErrores = 0;

  for (let b = 0; b < results.length; b += BATCH_SIZE) {
    const batch = results.slice(b, b + BATCH_SIZE);
    const saveResponse = await callWebApp(webAppUrl, {
      token,
      action: 'saveProcids',
      results: batch,
    });

    if (saveResponse.success) {
      totalGuardados += saveResponse.saved || 0;
      totalErrores += saveResponse.errors || 0;
      log('Lote guardado: ' + (saveResponse.saved || 0) + ' ok, ' + (saveResponse.errors || 0) + ' errores');
    } else {
      log('Error guardando lote: ' + (saveResponse.error || 'desconocido'));
      totalErrores += batch.length;
    }
  }

  const tookMs = Date.now() - startTs;
  let resumen;
  let titulo;

  if (detenidoAntes && faltantes > 0) {
    titulo = '⚠️ SAE Procid';
    resumen = 'Se depositaron ' + totalGuardados + ' expedientes, faltan ' + faltantes + '.';
    if (totalErrores > 0) resumen += ' Errores: ' + totalErrores + '.';
  } else {
    titulo = '✅ SAE Procid';
    resumen = 'Guardados: ' + totalGuardados + ' | Sin match: ' + sinMatch +
      ' | Errores: ' + (errores + totalErrores) +
      ' | ' + Math.round(tookMs / 1000) + 's';
  }

  log(resumen);
  notify(titulo, resumen);

  chrome.storage.local.set({
    lastResult: { success: true, saved: totalGuardados, sinMatch, errores: errores + totalErrores, captchaExpirado, detenidoAntes, faltantes },
    lastTimeIso: new Date().toISOString(),
    lastTookMs: tookMs,
  });
}

// ── Utilidades ────────────────────────────────────────────────

async function callWebApp(webAppUrl, body) {
  const resp = await fetch(webAppUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'follow',
  });
  return resp.json().catch(() => ({ success: false, error: 'response no es JSON' }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function notify(title, message) {
  try {
    chrome.notifications.create('sae-procid-' + Date.now(), {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon128.png'),
      title,
      message,
    });
  } catch (e) { /* notifications opcional */ }
}

function log(msg) {
  console.log('[SAE Procid]', msg);
}
