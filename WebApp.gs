const PROCID_CONFIG = {
  VERSION: 4,
  // El token compartido con la extensión NO vive en el código: se guarda en
  // ScriptProperties con la clave PROCID_SECURITY_TOKEN. Ver mostrarUrlWebApp().
  TOKEN_PROP: 'PROCID_SECURITY_TOKEN',
  RESPONSABLE_PROP: 'RESPONSABLE_OBJETIVO',
  RESPONSABLE_DEFAULT: 'RESPONSABLE DEMO',
  API_BASE: 'https://conexpbe.justucuman.gov.ar/api',
  JURISDICTION_ID: 18,
  ORIGIN: 'https://consultaexpedientes.justucuman.gov.ar',
  HOJA_NOMBRE: 'Notificaciones',
  COL_PROCID: 1,
  COL_EXPTE: 4,
  FILA_INICIO: 6,
  TOTAL_COLS: 9,
};

/**
 * Token compartido con la extensión. Vive en ScriptProperties, nunca en el código:
 * la Web App se publica con acceso "cualquier usuario", así que este token es la
 * única barrera entre internet y la planilla.
 */
function getSecurityToken() {
  return PropertiesService.getScriptProperties().getProperty(PROCID_CONFIG.TOKEN_PROP) || '';
}

function getResponsableObjetivoWebApp() {
  const guardado = PropertiesService.getScriptProperties().getProperty(PROCID_CONFIG.RESPONSABLE_PROP);
  return (guardado || PROCID_CONFIG.RESPONSABLE_DEFAULT).toString().trim().toUpperCase();
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResp({ success: false, error: 'sin payload' });
    }
    const esperado = getSecurityToken();
    if (!esperado) {
      return jsonResp({ success: false, error: 'Web App sin token configurado (ScriptProperties.' + PROCID_CONFIG.TOKEN_PROP + ')' });
    }
    const params = JSON.parse(e.postData.contents);
    if (params.token !== esperado) {
      return jsonResp({ success: false, error: 'token inválido' });
    }

    const action = params.action || 'getExpedientes';

    if (action === 'getExpedientes') {
      return jsonResp(obtenerExpedientesSinProcid());
    }

    if (action === 'saveProcids') {
      if (!Array.isArray(params.results) || params.results.length === 0) {
        return jsonResp({ success: false, error: 'results vacío o inválido' });
      }
      const lock = LockService.getScriptLock();
      if (!lock.tryLock(5000)) {
        return jsonResp({ success: false, error: 'lock ocupado, otro proceso corriendo' });
      }
      try {
        return jsonResp(guardarProcids(params.results));
      } finally {
        lock.releaseLock();
      }
    }

    return jsonResp({ success: false, error: 'action desconocida: ' + action });
  } catch (err) {
    return jsonResp({ success: false, error: err.message });
  }
}

function doGet(_e) {
  return jsonResp({
    success: true,
    version: PROCID_CONFIG.VERSION,
    message: 'SAE Procid Web App activa (v' + PROCID_CONFIG.VERSION + ')',
    timestamp: new Date().toISOString(),
  });
}

function jsonResp(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function obtenerExpedientesSinProcid() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(PROCID_CONFIG.HOJA_NOMBRE);
  if (!hoja) return { success: false, error: 'hoja Notificaciones no encontrada' };

  const lastRow = hoja.getLastRow();
  if (lastRow < PROCID_CONFIG.FILA_INICIO) {
    return { success: true, version: PROCID_CONFIG.VERSION, expedientes: [], total: 0, message: 'sin filas de datos' };
  }

  const numFilas = lastRow - PROCID_CONFIG.FILA_INICIO + 1;
  const datos = hoja.getRange(PROCID_CONFIG.FILA_INICIO, 1, numFilas, PROCID_CONFIG.TOTAL_COLS).getValues();

  const pendientes = [];
  const objetivo = getResponsableObjetivoWebApp();
  let yaTienen = 0;

  for (let i = 0; i < datos.length; i++) {
    const procidActual = datos[i][PROCID_CONFIG.COL_PROCID - 1];
    if (procidActual && procidActual.toString().trim()) {
      yaTienen++;
      continue;
    }

    const responsable = datos[i][1];
    const responsableStr = responsable ? responsable.toString().toUpperCase() : '';
    if (!responsableStr.includes(objetivo)) {
      continue;
    }

    const expte = datos[i][PROCID_CONFIG.COL_EXPTE - 1];
    const expteStr = expte ? expte.toString().trim() : '';
    if (!expteStr) continue;

    pendientes.push({
      fila: PROCID_CONFIG.FILA_INICIO + i,
      expte: expteStr,
    });
  }

  Logger.log('[v' + PROCID_CONFIG.VERSION + '] getExpedientes: ' + pendientes.length + ' pendientes, ' + yaTienen + ' ya tienen procid');

  return {
    success: true,
    version: PROCID_CONFIG.VERSION,
    expedientes: pendientes,
    total: pendientes.length,
    yaTienen: yaTienen,
    jurisdiccion: PROCID_CONFIG.JURISDICTION_ID,
    apiBase: PROCID_CONFIG.API_BASE,
  };
}

function guardarProcids(results) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(PROCID_CONFIG.HOJA_NOMBRE);
  if (!hoja) return { success: false, error: 'hoja Notificaciones no encontrada' };

  let guardados = 0;
  let errores = 0;

  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    if (!item.fila || !item.procid) {
      errores++;
      continue;
    }
    try {
      hoja.getRange(item.fila, PROCID_CONFIG.COL_PROCID).setValue(item.procid);
      guardados++;
      Logger.log('[v' + PROCID_CONFIG.VERSION + '] ✅ fila ' + item.fila + ' → procid ' + item.procid);
    } catch (err) {
      Logger.log('[v' + PROCID_CONFIG.VERSION + '] ❌ fila ' + item.fila + ': ' + err.message);
      errores++;
    }
  }

  if (guardados > 0) {
    SpreadsheetApp.flush();
  }

  Logger.log('[v' + PROCID_CONFIG.VERSION + '] saveProcids: guardados=' + guardados + ' errores=' + errores);

  return {
    success: true,
    version: PROCID_CONFIG.VERSION,
    saved: guardados,
    errors: errores,
  };
}

function mostrarUrlWebApp() {
  const ui = SpreadsheetApp.getUi();
  let url = '';
  try {
    url = ScriptApp.getService().getUrl();
  } catch (err) {
    url = '';
  }
  if (!url) {
    ui.alert(
      '🌐 Web App URL\n\n' +
      'Aún no publicada. Para publicar:\n' +
      '1. Apps Script Editor\n' +
      '2. Implementar → Nueva implementación\n' +
      '3. Tipo: Aplicación web\n' +
      '4. Ejecutar como: Yo\n' +
      '5. Quién tiene acceso: Cualquier usuario\n' +
      '6. Implementar y copiar URL'
    );
    return;
  }
  const token = getSecurityToken();
  ui.alert(
    '🌐 Web App URL\n\n' + url + '\n\n' +
    '🔑 Token (configurar en la extensión):\n' +
    (token || '⚠️ sin configurar — usá "Generar token de la Web App"')
  );
}

/**
 * Genera un token aleatorio, lo guarda en ScriptProperties y lo muestra una vez
 * para pegarlo en el popup de la extensión. Rotar el token = volver a correr esto.
 */
function generarTokenWebApp() {
  const ui = SpreadsheetApp.getUi();
  const anterior = getSecurityToken();
  if (anterior) {
    const conf = ui.alert(
      '🔑 Rotar token',
      'Ya hay un token configurado. Si generás uno nuevo, la extensión dejará de ' +
      'funcionar hasta que pegues el nuevo valor en su popup.\n\n¿Continuar?',
      ui.ButtonSet.YES_NO
    );
    if (conf !== ui.Button.YES) return;
  }
  const bytes = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  const token = 'sae_' + bytes.substring(0, 40);
  PropertiesService.getScriptProperties().setProperty(PROCID_CONFIG.TOKEN_PROP, token);
  ui.alert('🔑 Token nuevo (pegalo en la extensión):\n\n' + token);
}
