const PROCID_CONFIG = {
  VERSION: 4,
  SECURITY_TOKEN: '***TOKEN-ROTADO***',
  API_BASE: 'https://conexpbe.justucuman.gov.ar/api',
  JURISDICTION_ID: 18,
  ORIGIN: 'https://consultaexpedientes.justucuman.gov.ar',
  HOJA_NOMBRE: 'Notificaciones',
  COL_PROCID: 1,
  COL_EXPTE: 4,
  COL_HISTORIAL: 8,
  FILA_INICIO: 6,
  TOTAL_COLS: 9,
  REQUEST_DELAY_MS: 250,
  CAPTCHA_TTL_MS: 110000,
};

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResp({ success: false, error: 'sin payload' });
    }
    const params = JSON.parse(e.postData.contents);
    if (params.token !== PROCID_CONFIG.SECURITY_TOKEN) {
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
  let yaTienen = 0;

  for (let i = 0; i < datos.length; i++) {
    const procidActual = datos[i][PROCID_CONFIG.COL_PROCID - 1];
    if (procidActual && procidActual.toString().trim()) {
      yaTienen++;
      continue;
    }

    const responsable = datos[i][1];
    const responsableStr = responsable ? responsable.toString().toUpperCase() : '';
    if (!responsableStr.includes('RESP. A')) {
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

// ─────────────────────────────────────────────────────────────
// Helpers historial
// ─────────────────────────────────────────────────────────────

function obtenerHistorialProcid(procid) {
  const url = PROCID_CONFIG.API_BASE + '/proceedings/history'
    + '?jurisdiction=' + PROCID_CONFIG.JURISDICTION_ID
    + '&proceeding=' + encodeURIComponent(procid);

  let resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        'Accept': 'application/json',
        'Origin': PROCID_CONFIG.ORIGIN,
        'Referer': PROCID_CONFIG.ORIGIN + '/',
      },
      muteHttpExceptions: true,
    });
  } catch (err) {
    Logger.log('Fetch historial error procid ' + procid + ': ' + err.message);
    return null;
  }

  if (resp.getResponseCode() !== 200) {
    Logger.log('Historial status ' + resp.getResponseCode() + ' para procid ' + procid);
    return null;
  }

  let json;
  try {
    json = JSON.parse(resp.getContentText());
  } catch (e) {
    return null;
  }

  if (!json.success || !json.data || !Array.isArray(json.data.stories) || json.data.stories.length === 0) {
    return null;
  }

  const stories = json.data.stories.slice().sort(function (a, b) {
    return (b.fech || '').toString().localeCompare((a.fech || '').toString());
  });
  const top = stories[0];
  const fecha = (top.fecha || '').trim();
  const dscr = (top.dscr || '').trim();
  return fecha + '\n' + dscr;
}

function setRichTextHistorial(celda, texto) {
  const idx = texto.indexOf('\n');
  const linea1 = idx >= 0 ? texto.substring(0, idx) : texto;
  const linea2 = idx >= 0 ? texto.substring(idx + 1) : '';

  const boldStyle = SpreadsheetApp.newTextStyle().setBold(true).setFontSize(11).build();
  const normalStyle = SpreadsheetApp.newTextStyle().setBold(false).setFontSize(10).build();

  const rt = SpreadsheetApp.newRichTextValue().setText(texto);
  rt.setTextStyle(0, linea1.length, boldStyle);
  if (linea2) {
    rt.setTextStyle(linea1.length + 1, texto.length, normalStyle);
  }
  celda.setRichTextValue(rt.build());
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
  ui.alert(
    '🌐 Web App URL\n\n' + url + '\n\n' +
    '🔑 Token (configurar en extension):\n' + PROCID_CONFIG.SECURITY_TOKEN
  );
}
