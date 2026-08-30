const CONFIG = {
  URL_BASE: 'https://portaldelsae.justucuman.gov.ar',
  URL_LOGIN: 'https://login.justucuman.gov.ar/login',
  URL_TABLA: 'https://portaldelsae.justucuman.gov.ar/casillero/fuero/apremios',
  CAMPO_USER: 'username',
  CAMPO_PASS: 'password',
  HOJA_NOMBRE: 'Notificaciones',
  // procID API (consultaexpedientes)
  API_BASE_PROCID: 'https://conexpbe.justucuman.gov.ar/api',
  JURISDICTION_ID: 18,
  ORIGIN_PROCID: 'https://consultaexpedientes.justucuman.gov.ar',
  // Resume / continuación
  MAX_EXEC_MS: 4 * 60 * 1000,
  CONTINUACION_DELAY_MS: 60 * 1000,
  CONTINUACION_HANDLER: 'continuarApremios',
  RESUME_KEY: 'RESUME_STATE',
};

function ejecucionManual() {
  clearResumeState();
  eliminarTriggersContinuacion();
  actualizarApremios('manual');
}

function ejecucionAutomatica() {
  clearResumeState();
  eliminarTriggersContinuacion();
  actualizarApremios('automática');
}

function ejecutarAsignacionDeEstadosManual() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(CONFIG.HOJA_NOMBRE);
  if (!hoja) {
    SpreadsheetApp.getUi().alert('⚠️ Hoja ' + CONFIG.HOJA_NOMBRE + ' no encontrada.');
    return;
  }
  asignarEstadosFinal(hoja);
  SpreadsheetApp.getUi().alert('✅ Asignación de estados finalizada. Revisá el registro de ejecución para ver detalles.');
}

function continuarApremios() {
  eliminarTriggersContinuacion();
  const state = getResumeState();
  if (!state) {
    Logger.log('⏭️ continuarApremios: sin state activo, abortando');
    return;
  }
  Logger.log('🔁 continuarApremios disparado por trigger');
  actualizarApremios(state.tipoEjecucion);
}

function actualizarApremios(tipoEjecucion = 'manual') {
  const inicioTs = Date.now();
  Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  Logger.log('🚀 actualizarApremios: INICIO (' + tipoEjecucion + ')');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let hoja = ss.getSheetByName(CONFIG.HOJA_NOMBRE);
  if (!hoja) {
    Logger.log('   Creando hoja "' + CONFIG.HOJA_NOMBRE + '"');
    hoja = ss.insertSheet(CONFIG.HOJA_NOMBRE);
  }

  let state = getResumeState();

  try {
    if (!state) {
      Logger.log('🧠 SETUP: actualizando Autoaprendizaje y procID_database');
      actualizarAutoaprendizaje();
      actualizarProcIDDatabase();

      state = {
        stage: 'scrape',
        tipoEjecucion: tipoEjecucion,
        fechaObjetivo: null,
        paginaSiguiente: 1,
        filaInsertion: 6,
        historialFilaActual: 0,
      };
      setResumeState(state);
    } else {
      Logger.log('🔁 Reanudando: stage=' + state.stage +
        ' página=' + state.paginaSiguiente +
        ' filaInsertion=' + state.filaInsertion +
        ' historialFila=' + state.historialFilaActual);
    }

    if (state.stage === 'scrape') {
      const completado = etapaScrape(state, inicioTs, hoja);
      if (!completado) {
        programarContinuacion();
        Logger.log('⏸️ Pausa scrape — continuación en ' + (CONFIG.CONTINUACION_DELAY_MS / 1000) + 's');
        return;
      }
      state.stage = 'historial';
      state.historialFilaActual = 6;
      setResumeState(state);
    }

    if (state.stage === 'historial') {
      const completado = etapaHistorial(state, inicioTs, hoja);
      if (!completado) {
        programarContinuacion();
        Logger.log('⏸️ Pausa historial — continuación en ' + (CONFIG.CONTINUACION_DELAY_MS / 1000) + 's');
        return;
      }
    }

    clearResumeState();
    eliminarTriggersContinuacion();
    asignarEstadosFinal(hoja);
    actualizarTimestamp(hoja, state.tipoEjecucion, true);
    Logger.log('✅ actualizarApremios: COMPLETADO');
    Logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  } catch (error) {
    Logger.log('❌ Error: ' + error.message);
    if (hoja) {
      hoja.getRange('A1').setValue('  Última ejecución: ' + new Date().toLocaleString('es-AR'));
      hoja.getRange('A2').setValue('  Logs: Extracción ' + (state ? state.tipoEjecucion : tipoEjecucion) + ' fallida ❌ - Motivo: ' + error.message);
    }
    clearResumeState();
    eliminarTriggersContinuacion();
  }
}

function etapaScrape(state, inicioTs, hoja) {
  Logger.log('🌐 Stage SCRAPE — desde página ' + state.paginaSiguiente);
  const cookies = loginConCredenciales();
  if (!cookies) throw new Error('Login fallido en etapaScrape');

  if (!state.fechaObjetivo) {
    Logger.log('📅 Obteniendo fecha más reciente');
    state.fechaObjetivo = obtenerFechaMasReciente(cookies);
    if (!state.fechaObjetivo) throw new Error('No se detectaron notificaciones en la página');
    Logger.log('📅 Fecha objetivo: ' + state.fechaObjetivo);
    setResumeState(state);
  }

  const mapaResponsables = cargarResponsables();
  const mapaProcID = cargarProcIDDatabase();
  const encabezado = ['ID', 'Resp.', 'Fecha', 'Expte.', 'Estado a transferir', 'Escrito a generar', 'Observaciones', 'Tipo Escrito / Descripción', 'Ultima entrada del historial', 'Archivo adjunto'];

  quitarFiltrosNotificaciones(hoja);

  let pagina = state.paginaSiguiente;
  let detener = false;

  while (!detener) {
    if (tiempoAgotado(inicioTs)) {
      state.paginaSiguiente = pagina;
      setResumeState(state);
      Logger.log('⏱️ Timeout pre-página, próxima: ' + pagina);
      return false;
    }

    Logger.log('  📄 Página ' + pagina);
    const url = CONFIG.URL_TABLA + '?page=' + pagina;
    const resp = UrlFetchApp.fetch(url, {
      headers: { 'Cookie': cookies },
      muteHttpExceptions: true,
      followRedirects: true,
    });
    const html = resp.getContentText('UTF-8');
    const parsed = parsearTabla(html);

    if (parsed.filas.length === 0) {
      Logger.log('  ⚠️ Sin filas — fin de paginación');
      break;
    }

    const existentes = cargarExpedientesExistentes();
    const filasParciales = [];

    for (const fila of parsed.filas) {
      const fechaFila = fila[0];
      if (fechaFila !== state.fechaObjetivo) {
        Logger.log('  🛑 Fecha ' + fechaFila + ' distinta a ' + state.fechaObjetivo + ' — deteniendo');
        detener = true;
        break;
      }
      const expte = fila[1] ? fila[1].toString().trim() : '';
      const tipoEscrito = fila[2] ? fila[2].toString().trim() : '';
      const claveUnica = expte + '||' + tipoEscrito + '||' + fechaFila;
      if (existentes.has(claveUnica)) continue;

      const responsable = buscarResponsable(expte, mapaResponsables);
      const procID = (mapaProcID && mapaProcID[expte]) ? mapaProcID[expte] : '';
      filasParciales.push([procID, responsable, fechaFila, expte, '', '', '', tipoEscrito, '', '']);
    }

    if (filasParciales.length > 0) {
      insertarEnSheet(encabezado, filasParciales, hoja, state.filaInsertion);
      state.filaInsertion += filasParciales.length;
      Logger.log('  ✅ Página ' + pagina + ': ' + filasParciales.length + ' filas insertadas (filaInsertion ahora=' + state.filaInsertion + ')');
    }

    if (detener) break;
    if (!html.includes('Siguiente')) {
      Logger.log('  ✅ Sin enlace "Siguiente" — fin');
      break;
    }

    pagina++;
    state.paginaSiguiente = pagina;
    setResumeState(state);

    if (tiempoAgotado(inicioTs)) {
      Logger.log('⏱️ Timeout post-página, próxima: ' + pagina);
      return false;
    }

    Utilities.sleep(pagina % 3 === 0 ? 8000 : 3000);
  }

  Logger.log('✅ Stage SCRAPE completado');
  return true;
}

function etapaHistorial(state, inicioTs, hoja) {
  Logger.log('📜 Stage HISTORIAL — desde fila ' + state.historialFilaActual);
  quitarFiltrosNotificaciones(hoja);
  const lastRow = hoja.getLastRow();
  if (lastRow < 6) {
    Logger.log('ℹ️ Sin filas para historial');
    return true;
  }

  const datos = hoja.getRange(6, 1, lastRow - 5, 9).getValues();
  const filaInicial = state.historialFilaActual || 6;
  const cache = {};
  let procesados = 0;
  let saltados = 0;

  for (let i = 0; i < datos.length; i++) {
    const filaSheet = 6 + i;
    if (filaSheet < filaInicial) continue;

    if (tiempoAgotado(inicioTs)) {
      state.historialFilaActual = filaSheet;
      setResumeState(state);
      Logger.log('⏱️ Timeout historial, próxima fila: ' + filaSheet);
      return false;
    }

    const responsable = datos[i][1] ? datos[i][1].toString().trim() : '';
    if (responsable !== 'RESP. A') { saltados++; continue; }

    const procID = datos[i][0] ? datos[i][0].toString().trim() : '';
    const histActual = datos[i][8] ? datos[i][8].toString().trim() : '';
    const tipoEscrito = datos[i][7] ? datos[i][7].toString().trim() : '';
    const rawFecha = datos[i][2];
    const fechaFila = rawFecha instanceof Date
      ? Utilities.formatDate(rawFecha, Session.getScriptTimeZone(), 'dd/MM/yyyy')
      : (rawFecha ? rawFecha.toString().trim() : '');

    if (fechaFila !== state.fechaObjetivo) { saltados++; continue; }
    if (!procID) { saltados++; continue; }
    if (histActual) { saltados++; continue; }

    let top = cache[procID];
    if (top === undefined) {
      Logger.log('  📜 Fila ' + filaSheet + ' procID ' + procID);
      top = obtenerHistorialYAdjuntoCercanoHoyPorProcID(procID);
      cache[procID] = top;
      Utilities.sleep(300);
    }
    const historial = top.historial;
    if (historial) {
      setRichTextHistorial(hoja.getRange(filaSheet, 9), historial);
      if (top.topHistId) {
        const expte = datos[i][3] ? datos[i][3].toString().trim() : ('ProcID_' + procID);
        const textoPdfUrl = obtenerTextoYGenerarPDF(procID, top.topHistId, expte);
        if (textoPdfUrl) {
          hoja.getRange(filaSheet, 10).setFormula('=HYPERLINK("' + textoPdfUrl.replace(/"/g, '""') + '";"Ver Texto")');
        }
      }
      if (top.adjuntoUrl) {
        const expte = datos[i][3] ? datos[i][3].toString().trim() : ('ProcID_' + procID);
        const driveUrl = descargarPDFADrive(top.adjuntoUrl, expte, top.histid);
        const safeUrl = driveUrl.replace(/"/g, '""');
        hoja.getRange(filaSheet, 11).setFormula('=HYPERLINK("' + safeUrl + '";"Ver PDF")');
      }
      procesados++;
    }
  }

  Logger.log('✅ Stage HISTORIAL completado — procesados=' + procesados + ' saltados=' + saltados);
  return true;
}

function asignarEstadosFinal(hoja) {
  Logger.log('⚙️ Asignando estados fila por fila...');
  const lastRow = hoja.getLastRow();
  if (lastRow < 6) return;

  const datos = hoja.getRange(6, 1, lastRow - 5, 9).getValues();
  const mapaEstados = cargarSettingsEstados();
  let asignados = 0;

  for (let i = 0; i < datos.length; i++) {
    const filaSheet = 6 + i;
    const responsable = datos[i][1] ? datos[i][1].toString().trim() : '';
    if (responsable !== 'RESP. A') continue;
    const estadoActual = datos[i][4] ? datos[i][4].toString().trim() : '';
    const tipoEscrito = datos[i][7] ? datos[i][7].toString().trim() : '';
    const historial = datos[i][8] ? datos[i][8].toString().trim() : '';

    // Skip if there's no data
    if (!tipoEscrito && !historial) continue;

    let estadoAsignado = '';
    Logger.log('----------------------------------------');
    Logger.log('🔍 Fila ' + filaSheet + ' | Estado Actual: "' + estadoActual + '"');
    Logger.log('   Tipo Escrito: "' + tipoEscrito + '"');
    Logger.log('   Historial:    "' + historial.replace(/\n/g, '\\n') + '"');

    // Lógica 1: Match por historial exacto (lo que antes hacía etapaHistorial)
    if (historial) {
      const histTrim = historial.toString().trim();
      // Remover la fecha del historial (ej: "28/04/2026\nTexto" -> "Texto")
      const histSinFecha = histTrim.replace(/^\d{2}\/\d{2}\/\d{2,4}\s*\n/, '').trim();

      for (const m of mapaEstados) {
        const mUltSinFecha = m.ultEntrada.toString().replace(/^\d{2}\/\d{2}\/\d{2,4}\s*\n/, '').trim();

        if (m.desc === tipoEscrito && mUltSinFecha === histSinFecha) {
          estadoAsignado = m.estado;
          Logger.log('   ✅ Match EXACTO encontrado: ' + m.estado);
          break;
        }
      }
    }

    // Lógica 2: Match fallback por tipo de escrito (ignorando mayúsculas)
    if (!estadoAsignado && tipoEscrito) {
      Logger.log('   ⚠️ Sin match exacto. Probando Lógica 2 (Fallback incluye)...');
      const tipoEscritoLower = tipoEscrito.toLowerCase();
      for (const map of mapaEstados) {
        if (tipoEscritoLower.includes(map.desc.toLowerCase())) {
          estadoAsignado = map.estado;
          Logger.log('   ✅ Match FALLBACK encontrado: ' + map.estado + ' (usando "' + map.desc + '")');
          break;
        }
      }
    }

    if (!estadoAsignado) {
      Logger.log('   ❌ No se encontró ningún match para asignar estado.');
    }

    // Si encontramos un estado y es diferente al que ya está en la hoja
    if (estadoAsignado && estadoActual !== estadoAsignado) {
      hoja.getRange(filaSheet, 5).setValue(estadoAsignado);
      asignados++;
      Logger.log('   ✍️ Escribiendo estado en celda: ' + estadoAsignado);
    } else if (estadoAsignado && estadoActual === estadoAsignado) {
      Logger.log('   ⏭️ El estado asignado es igual al actual, se omite escritura.');
    }
  }
  Logger.log('----------------------------------------');
  Logger.log('✅ Asignación final completada: ' + asignados + ' filas actualizadas.');
}

function actualizarTimestamp(hoja, tipoEjecucion, exito) {
  if (!hoja) return;
  hoja.getRange('A1').setValue('  Última ejecución: ' + new Date().toLocaleString('es-AR'));
  if (exito) {
    hoja.getRange('A2').setValue(`  Logs: Extracción ${tipoEjecucion} exitosa ✅`);
  }
  Logger.log('📌 Timestamp y estado actualizados');
}

function cargarSettingsEstados() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName('Autoaprendizaje');
  if (!hoja) return [];

  const lastRow = hoja.getLastRow();
  if (lastRow < 1) return [];

  const datos = hoja.getRange(1, 1, lastRow, Math.max(hoja.getLastColumn(), 5)).getValues();

  const estadosPermitidos = new Set();
  for (let i = 0; i < datos.length; i++) {
    const val = datos[i][4] ? datos[i][4].toString().trim() : '';
    if (val) estadosPermitidos.add(val);
  }
  Logger.log('⚙️ cargarSettingsEstados: estados permitidos (col E) = ' + estadosPermitidos.size);

  const estados = [];
  for (let i = 0; i < datos.length; i++) {
    const desc = datos[i][0] ? datos[i][0].toString().trim() : '';
    const ultEntrada = datos[i][1] ? datos[i][1].toString().trim() : '';
    const estado = datos[i][2] ? datos[i][2].toString().trim() : '';
    if (desc && ultEntrada && estado && estadosPermitidos.has(estado)) {
      estados.push({ desc: desc, ultEntrada: ultEntrada, estado: estado });
    }
  }
  Logger.log('⚙️ cargarSettingsEstados: mapeos cargados = ' + estados.length);
  return estados;
}

function actualizarAutoaprendizaje() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hojaNotif = ss.getSheetByName(CONFIG.HOJA_NOMBRE);
  if (!hojaNotif) {
    Logger.log('⚠️ actualizarAutoaprendizaje: hoja Notificaciones no encontrada');
    return;
  }
  const lastRow = hojaNotif.getLastRow();
  if (lastRow < 6) {
    Logger.log('ℹ️ actualizarAutoaprendizaje: sin datos en Notificaciones');
    return;
  }
  const datos = hojaNotif.getRange(6, 1, lastRow - 5, hojaNotif.getLastColumn()).getValues();

  Logger.log('📅 actualizarAutoaprendizaje: procesando todo el histórico...');

  const vistos = new Set();
  const candidatas = [];
  for (let i = 0; i < datos.length; i++) {
    const estado = datos[i][4] ? datos[i][4].toString().trim() : '';
    if (!estado) continue;
    const tipoEscrito = datos[i][7] ? datos[i][7].toString().trim() : '';
    if (!tipoEscrito) continue;
    const rawUltEntrada = datos[i][8] ? datos[i][8].toString().trim() : '';
    const ultEntrada = rawUltEntrada.replace(/^\d{2}\/\d{2}\/\d{2,4}\s*\n/, '').trim();
    if (!ultEntrada) continue;
    const clave = tipoEscrito + '||' + ultEntrada;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    candidatas.push([tipoEscrito, ultEntrada, estado]);
  }
  Logger.log('📋 actualizarAutoaprendizaje: candidatas = ' + candidatas.length);
  if (candidatas.length === 0) return;

  const hojaAp = ss.getSheetByName('Autoaprendizaje');
  if (!hojaAp) {
    Logger.log('⚠️ actualizarAutoaprendizaje: hoja Autoaprendizaje no encontrada');
    return;
  }
  const lastRowAp = hojaAp.getLastRow();

  const estadosPermitidos = new Set();
  if (lastRowAp >= 2) {
    const colE = hojaAp.getRange(2, 5, lastRowAp - 1, 1).getValues();
    for (let i = 0; i < colE.length; i++) {
      const val = colE[i][0] ? colE[i][0].toString().trim() : '';
      if (val) estadosPermitidos.add(val);
    }
  }
  Logger.log('📋 actualizarAutoaprendizaje: estados permitidos = ' + estadosPermitidos.size);

  const candidatasFiltradas = candidatas.filter(e => estadosPermitidos.has(e[2]));
  Logger.log('📋 actualizarAutoaprendizaje: candidatas tras filtro = ' + candidatasFiltradas.length);
  if (candidatasFiltradas.length === 0) return;

  const existentes = new Set();
  let ultimaFila = 0;
  if (lastRowAp >= 1) {
    const datosAp = hojaAp.getRange(1, 1, lastRowAp, 2).getValues();
    for (let i = 0; i < datosAp.length; i++) {
      const a = datosAp[i][0] ? datosAp[i][0].toString().trim() : '';
      const b = datosAp[i][1] ? datosAp[i][1].toString().trim() : '';
      if (a) {
        existentes.add(a + '||' + b);
        ultimaFila = i + 1;
      }
    }
  }

  const aInsertar = candidatasFiltradas.filter(e => !existentes.has(e[0] + '||' + e[1]));
  Logger.log('📋 actualizarAutoaprendizaje: nuevas = ' + aInsertar.length);
  if (aInsertar.length === 0) return;

  const filaDestino = ultimaFila + 1;
  hojaAp.getRange(filaDestino, 1, aInsertar.length, 3).setValues(aInsertar);
  Logger.log('✅ actualizarAutoaprendizaje: ' + aInsertar.length + ' entradas escritas desde fila ' + filaDestino);
}

function obtenerFechaMasReciente(cookies) {
  const resp = UrlFetchApp.fetch(CONFIG.URL_TABLA + '?page=1', {
    headers: { 'Cookie': cookies },
    muteHttpExceptions: true,
    followRedirects: true,
  });
  const { filas } = parsearTabla(resp.getContentText('UTF-8'));
  if (filas.length === 0) return null;
  return filas[0][0];
}

function scrapearFecha(cookies, fechaObjetivo, mapaResponsables, existentes, mapaEstados, mapaProcID) {
  const filas = [];
  let encabezado = [];
  let pagina = 1;
  let detener = false;
  let encabezadoGuardado = false;

  while (!detener) {
    const url = CONFIG.URL_TABLA + '?page=' + pagina;
    Logger.log('  📄 Página ' + pagina);
    const resp = UrlFetchApp.fetch(url, {
      headers: { 'Cookie': cookies },
      muteHttpExceptions: true,
      followRedirects: true,
    });
    const html = resp.getContentText('UTF-8');
    const parsed = parsearTabla(html);
    if (parsed.filas.length === 0) {
      Logger.log('  ⚠️ Sin filas — fin de paginación');
      break;
    }
    if (!encabezadoGuardado) {
      encabezado = ['ID', 'Resp.', 'Fecha', 'Expte.', 'Estado a transferir', 'Escrito a generar', 'Observaciones', 'Tipo Escrito / Descripción', 'Ultima entrada del historial', 'Archivo adjunto'];
      encabezadoGuardado = true;
    }
    for (const fila of parsed.filas) {
      const fechaFila = fila[0];
      if (fechaFila !== fechaObjetivo) {
        Logger.log('  🛑 Fecha ' + fechaFila + ' distinta a ' + fechaObjetivo + ' — deteniendo');
        detener = true;
        break;
      }
      const expte = fila[1] ? fila[1].toString().trim() : '';
      const tipoEscrito = fila[2] ? fila[2].toString().trim() : '';
      const claveUnica = expte + '||' + tipoEscrito + '||' + fechaFila;
      if (existentes.has(claveUnica)) {
        Logger.log('  ⏭️ Duplicado salteado: ' + claveUnica);
        continue;
      }
      const responsable = buscarResponsable(expte, mapaResponsables);
      Logger.log('  👤 Expte ' + expte + ' → "' + (responsable || 'ninguno') + '"');

      const procID = (mapaProcID && mapaProcID[expte]) ? mapaProcID[expte] : '';
      filas.push([procID, responsable, fechaFila, expte, '', '', '', tipoEscrito, '', '']);
    }
    if (!detener) {
      if (!html.includes('Siguiente')) break;
      pagina++;
      Utilities.sleep(pagina % 3 === 0 ? 8000 : 3000);
    }
  }
  return { encabezado, filas };
}

function cargarExpedientesExistentes() {
  const claves = new Set();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(CONFIG.HOJA_NOMBRE);
  if (!hoja) return claves;
  const lastRow = hoja.getLastRow();
  // Los datos ahora se insertan a partir de la fila 6
  if (lastRow < 6) return claves;
  const datos = hoja.getRange(6, 1, lastRow - 5, hoja.getLastColumn()).getValues();
  for (let i = 0; i < datos.length; i++) {
    const rawFecha = datos[i][2];
    const fecha = rawFecha instanceof Date
      ? Utilities.formatDate(rawFecha, Session.getScriptTimeZone(), 'dd/MM/yyyy')
      : (rawFecha ? rawFecha.toString().trim() : '');
    const expte = datos[i][3] ? datos[i][3].toString().trim() : '';
    const tipo = datos[i][7] ? datos[i][7].toString().trim() : '';
    if (expte) claves.add(expte + '||' + tipo + '||' + fecha);
  }
  Logger.log('🔍 Expedientes existentes cargados: ' + claves.size);
  return claves;
}

function insertarEnSheet(encabezado, filas, hoja, filaInsertion) {
  if (!filaInsertion) filaInsertion = 6;
  const maxCols = encabezado.length;
  const filasNorm = filas.map(f => {
    const r = f.slice();
    while (r.length < maxCols) r.push('');
    return r.slice(0, maxCols);
  });

  const numFilas = filasNorm.length;
  const lastRowAntes = hoja.getLastRow();
  const filaTemplate = lastRowAntes >= 6 ? lastRowAntes : null;
  const totalColsTemplate = filaTemplate ? hoja.getLastColumn() : 0;

  hoja.insertRowsAfter(filaInsertion - 1, numFilas);
  hoja.getRange(filaInsertion, 1, numFilas, maxCols).setValues(filasNorm);

  if (filaTemplate && totalColsTemplate > 0) {
    const filaTemplateDesplazada = filaTemplate + numFilas;
    const rangoOrigen = hoja.getRange(filaTemplateDesplazada, 1, 1, totalColsTemplate);
    const rangoDestino = hoja.getRange(filaInsertion, 1, numFilas, totalColsTemplate);
    rangoOrigen.copyTo(rangoDestino, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    rangoOrigen.copyTo(rangoDestino, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
  }

  const estiloTitulo = SpreadsheetApp.newTextStyle().setBold(true).setFontSize(11).build();
  const estiloSub = SpreadsheetApp.newTextStyle().setBold(false).setFontSize(10).build();
  for (let i = 0; i < numFilas; i++) {
    const val = filasNorm[i][7];
    if (!val || !val.toString().includes('\n')) continue;
    const texto = val.toString();
    const nl = texto.indexOf('\n');
    const richText = SpreadsheetApp.newRichTextValue()
      .setText(texto)
      .setTextStyle(0, nl, estiloTitulo)
      .setTextStyle(nl + 1, texto.length, estiloSub)
      .build();
    hoja.getRange(filaInsertion + i, 8).setRichTextValue(richText);
  }

  Logger.log('   ✅ ' + numFilas + ' filas insertadas desde la fila ' + filaInsertion);
}

function actualizarProcIDDatabase() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hojaNotif = ss.getSheetByName(CONFIG.HOJA_NOMBRE);
  if (!hojaNotif) return;
  const lastRow = hojaNotif.getLastRow();
  if (lastRow < 6) return;
  const datos = hojaNotif.getRange(6, 1, lastRow - 5, hojaNotif.getLastColumn()).getValues();

  const candidatos = [];
  const vistos = new Set();
  for (let i = 0; i < datos.length; i++) {
    const procID = datos[i][0] ? datos[i][0].toString().trim() : '';
    const expte = datos[i][3] ? datos[i][3].toString().trim() : '';
    if (!procID || !expte) continue;
    if (vistos.has(expte)) continue;
    vistos.add(expte);
    candidatos.push([expte, procID]);
  }
  if (candidatos.length === 0) return;

  let hojaDB = ss.getSheetByName('procID_database');
  if (!hojaDB) {
    hojaDB = ss.insertSheet('procID_database');
    Logger.log('   Creando hoja "procID_database"');
  }
  const lastRowDB = hojaDB.getLastRow();
  const existentes = new Set();
  if (lastRowDB >= 1) {
    const datosDB = hojaDB.getRange(1, 1, lastRowDB, 1).getValues();
    for (let i = 0; i < datosDB.length; i++) {
      const val = datosDB[i][0] ? datosDB[i][0].toString().trim() : '';
      if (val) existentes.add(val);
    }
  }
  const aInsertar = candidatos.filter(e => !existentes.has(e[0]));
  if (aInsertar.length === 0) {
    Logger.log('🗂️ procID_database: sin entradas nuevas');
    return;
  }
  const filaDestino = lastRowDB + 1;
  hojaDB.getRange(filaDestino, 1, aInsertar.length, 2).setValues(aInsertar);
  Logger.log('✅ procID_database: ' + aInsertar.length + ' entradas nuevas escritas');
}

function cargarProcIDDatabase() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName('procID_database');
  if (!hoja) return {};
  const lastRow = hoja.getLastRow();
  if (lastRow < 1) return {};
  const datos = hoja.getRange(1, 1, lastRow, 2).getValues();
  const mapa = {};
  for (let i = 0; i < datos.length; i++) {
    const expte = datos[i][0] ? datos[i][0].toString().trim() : '';
    const procID = datos[i][1] ? datos[i][1].toString().trim() : '';
    if (expte && procID) mapa[expte] = procID;
  }
  Logger.log('🗂️ procID_database cargado: ' + Object.keys(mapa).length + ' entradas');
  return mapa;
}

function cargarResponsables() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName('Responsables');
  if (!hoja) {
    Logger.log('⚠️ Hoja "Responsables" no encontrada');
    return {};
  }
  const datos = hoja.getDataRange().getValues();
  if (datos.length === 0) return {};
  const mapa = {};
  const nombresRow = datos[0];
  for (let col = 0; col < nombresRow.length; col++) {
    const nombre = nombresRow[col] ? nombresRow[col].toString().trim() : '';
    if (!nombre) continue;
    for (let fila = 1; fila < datos.length; fila++) {
      const expte = datos[fila][col] ? datos[fila][col].toString().trim() : '';
      if (!expte) continue;
      if (!mapa[expte]) mapa[expte] = [];
      mapa[expte].push(nombre);
    }
  }
  Logger.log('📋 Expedientes mapeados: ' + Object.keys(mapa).length);
  return mapa;
}

function buscarResponsable(expte, mapa) {
  if (!expte) return '';
  const clave = expte.toString().trim();
  if (mapa[clave]) return mapa[clave].join(' / ');

  // Incidentes: "3831/26-Q1" es un expediente anexo al principal "3831/26".
  // No figura en Responsables (que sólo lista principales), pero hereda su responsable.
  const base = expteBase(clave);
  if (base && base !== clave && mapa[base]) return mapa[base].join(' / ');

  return '';
}

// "3831/26-Q1" -> "3831/26" | "3831/26" -> "3831/26" | basura -> ''
function expteBase(expte) {
  if (!expte) return '';
  const m = expte.toString().trim().match(/^\s*(\d+\s*\/\s*\d+)/);
  return m ? m[1].replace(/\s+/g, '') : '';
}

// Rellena Resp. en filas ya escritas que quedaron sin responsable
// (típicamente incidentes "-Q1" cargados antes del fix de buscarResponsable).
function repararResponsables() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(CONFIG.HOJA_NOMBRE);
  if (!hoja) {
    SpreadsheetApp.getUi().alert('⚠️ Hoja ' + CONFIG.HOJA_NOMBRE + ' no encontrada.');
    return;
  }
  const lastRow = hoja.getLastRow();
  if (lastRow < 6) {
    SpreadsheetApp.getUi().alert('ℹ️ Sin filas de datos.');
    return;
  }

  const mapa = cargarResponsables();
  const datos = hoja.getRange(6, 2, lastRow - 5, 3).getValues(); // B=Resp, C=Fecha, D=Expte
  const colResp = [];
  let reparados = 0;
  const sinMatch = [];

  for (let i = 0; i < datos.length; i++) {
    const actual = datos[i][0] ? datos[i][0].toString().trim() : '';
    const expte = datos[i][2] ? datos[i][2].toString().trim() : '';

    if (actual || !expte) {
      colResp.push([datos[i][0]]);
      continue;
    }

    const resp = buscarResponsable(expte, mapa);
    if (resp) {
      colResp.push([resp]);
      reparados++;
      Logger.log('🔧 Fila ' + (6 + i) + ' ' + expte + ' → ' + resp);
    } else {
      colResp.push([datos[i][0]]);
      sinMatch.push(expte);
    }
  }

  if (reparados > 0) {
    hoja.getRange(6, 2, colResp.length, 1).setValues(colResp);
  }
  Logger.log('✅ repararResponsables: ' + reparados + ' filas reparadas, ' + sinMatch.length + ' sin match');

  SpreadsheetApp.getUi().alert(
    '🔧 Responsables reparados: ' + reparados + '\n' +
    'Sin match: ' + sinMatch.length +
    (sinMatch.length > 0 ? '\n\n' + sinMatch.slice(0, 15).join(', ') : '') +
    '\n\nSi reparó filas: hacé una búsqueda en Consulta Expedientes para que la extensión\n' +
    'complete los procID, y después corré "Extraer última entrada y asignar estados faltantes".'
  );
}

function parsearTabla(html) {
  const encabezado = [];
  const filas = [];
  const tablaMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tablaMatch) {
    Logger.log('  ❌ parsearTabla: no se encontró <table>');
    return { encabezado, filas };
  }
  const tabla = tablaMatch[0];
  const theadMatch = tabla.match(/<thead[\s\S]*?<\/thead>/i);
  if (theadMatch) {
    const ths = theadMatch[0].match(/<th[^>]*>([\s\S]*?)<\/th>/gi) || [];
    ths.forEach(th => encabezado.push(limpiarHtml(th.replace(/<\/?th[^>]*>/gi, ''))));
    encabezado.pop();
    encabezado.shift();
  }
  const tbodyMatch = tabla.match(/<tbody[\s\S]*?<\/tbody>/i);
  if (!tbodyMatch) {
    Logger.log('  ❌ parsearTabla: no se encontró <tbody>');
    return { encabezado, filas };
  }
  const trs = tbodyMatch[0].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
  trs.forEach(tr => {
    const tds = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
    if (tds.length < 3) return;
    const celdas = tds.map(td => limpiarHtml(td.replace(/<\/?td[^>]*>/gi, '')));
    celdas.pop();
    celdas.shift();
    filas.push(celdas);
  });
  return { encabezado, filas };
}

function limpiarHtml(str) {
  return str
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&ntilde;/g, 'ñ')
    .replace(/&Ntilde;/g, 'Ñ')
    .replace(/&aacute;/g, 'á')
    .replace(/&eacute;/g, 'é')
    .replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó')
    .replace(/&uacute;/g, 'ú')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function hacerLogin(usuario, clave) {
  Logger.log('  🔐 hacerLogin: GET al form de login...');
  const respGet = UrlFetchApp.fetch(CONFIG.URL_LOGIN, {
    muteHttpExceptions: true,
    followRedirects: false,
  });
  Logger.log('  📶 GET login status: ' + respGet.getResponseCode());
  const htmlLogin = respGet.getContentText();
  const cookiesAuth = parsearCookies(respGet.getHeaders()['Set-Cookie']);
  const csrfMatch = htmlLogin.match(/name=["']_token["']\s+value=["']([^"']+)["']/i)
    || htmlLogin.match(/value=["']([^"']{40,})["']\s+name=["']_token["']/i);
  const csrf = csrfMatch ? csrfMatch[1] : '';
  Logger.log('  🛡️ CSRF: ' + (csrf ? '✅' : '❌'));
  const payload = '_token=' + encodeURIComponent(csrf) + '&' + CONFIG.CAMPO_USER + '=' + encodeURIComponent(usuario) + '&' + CONFIG.CAMPO_PASS + '=' + encodeURIComponent(clave);
  const respPost = UrlFetchApp.fetch(CONFIG.URL_LOGIN, {
    method: 'post',
    payload: payload,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookiesAuth,
      'Referer': CONFIG.URL_LOGIN,
      'Origin': 'https://login.justucuman.gov.ar',
    },
    followRedirects: false,
    muteHttpExceptions: true,
  });
  Logger.log('  📶 POST login status: ' + respPost.getResponseCode());
  const cookiesPost = parsearCookies(respPost.getHeaders()['Set-Cookie']);
  const cookiesLogin = mergerCookies(cookiesAuth, cookiesPost);
  const location = respPost.getHeaders()['Location'];
  Logger.log('  📍 Redirect: ' + (location || '❌ ninguna'));
  if (!location) return null;
  let urlActual = location;
  let cookiesAcumuladas = cookiesLogin;
  for (let i = 0; i < 5; i++) {
    Logger.log('  ↪️ Redirect ' + (i + 1) + ': ' + urlActual);
    const respRedir = UrlFetchApp.fetch(urlActual, {
      headers: { 'Cookie': cookiesAcumuladas },
      followRedirects: false,
      muteHttpExceptions: true,
    });
    const status = respRedir.getResponseCode();
    const nuevasCookies = parsearCookies(respRedir.getHeaders()['Set-Cookie']);
    cookiesAcumuladas = mergerCookies(cookiesAcumuladas, nuevasCookies);
    const nextLocation = respRedir.getHeaders()['Location'];
    Logger.log('     Status: ' + status + ' | Next: ' + (nextLocation || 'ninguno'));
    if (!nextLocation || status === 200) {
      Logger.log('  ✅ Redirects completados');
      break;
    }
    urlActual = nextLocation.startsWith('http') ? nextLocation : CONFIG.URL_BASE + nextLocation;
  }
  return cookiesAcumuladas;
}

function parsearCookies(setCookieHeader) {
  if (!setCookieHeader) return '';
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  return headers.map(h => h.split(';')[0]).join('; ');
}

function mergerCookies(base, nuevas) {
  const map = {};
  [base, nuevas].forEach(str => {
    if (!str) return;
    str.split(';').forEach(par => {
      const [k, v] = par.trim().split('=');
      if (k) map[k.trim()] = v || '';
    });
  });
  return Object.entries(map).map(([k, v]) => k + '=' + v).join('; ');
}

function guardarCredenciales() {
  const ui = SpreadsheetApp.getUi();
  const resUser = ui.prompt('🔑 Actualizar credenciales', 'Ingrese su usuario (CUIL):', ui.ButtonSet.OK_CANCEL);
  if (resUser.getSelectedButton() !== ui.Button.OK) return;

  const resPass = ui.prompt('🔑 Actualizar credenciales', 'Ingrese su contraseña:', ui.ButtonSet.OK_CANCEL);
  if (resPass.getSelectedButton() !== ui.Button.OK) return;

  const props = PropertiesService.getScriptProperties();
  props.setProperty('SAE_USER', resUser.getResponseText());
  props.setProperty('SAE_PASS', resPass.getResponseText());

  ui.alert('✅ Credenciales guardadas exitosamente.');
  Logger.log('✅ Credenciales actualizadas desde el menú');
}

function crearTriggerDiario() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'actualizarApremios' || t.getHandlerFunction() === 'ejecucionAutomatica') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('ejecucionAutomatica')
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .nearMinute(0)
    .create();

  Logger.log('✅ Trigger diario a las 3am creado');
  SpreadsheetApp.getUi().alert('⏰ Automatización programada: El script extraerá las notificaciones todos los días a las 3:00 AM.');
}

function eliminarTriggerDiario() {
  const triggers = ScriptApp.getProjectTriggers();
  let eliminados = 0;
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'actualizarApremios' || t.getHandlerFunction() === 'ejecucionAutomatica') {
      ScriptApp.deleteTrigger(t);
      eliminados++;
    }
  });

  if (eliminados > 0) {
    Logger.log('🗑️ Trigger eliminado');
    SpreadsheetApp.getUi().alert('🗑️ Programación eliminada: El script ya no se ejecutará automáticamente.');
  } else {
    SpreadsheetApp.getUi().alert('ℹ️ No había ninguna programación activa.');
  }
}

// ─────────────────────────────────────────────────────────────
// Limpieza diaria — conservar últimas 5 fechas únicas
// ─────────────────────────────────────────────────────────────

function limpiarNotificacionesAntiguas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(CONFIG.HOJA_NOMBRE);
  if (!hoja) {
    Logger.log('⚠️ limpiarNotificacionesAntiguas: hoja no encontrada');
    return;
  }

  quitarFiltrosNotificaciones(hoja);

  const lastRow = hoja.getLastRow();
  if (lastRow < 6) {
    Logger.log('ℹ️ limpiarNotificacionesAntiguas: sin filas de datos');
    return;
  }

  const tz = Session.getScriptTimeZone();
  const hoyVal = parseInt(Utilities.formatDate(new Date(), tz, 'yyyyMMdd'), 10);

  const datos = hoja.getRange(6, 3, lastRow - 5, 1).getValues(); // col C = Fecha

  // Normalizar fechas a entero yyyyMMdd
  const fechasPorFila = datos.map(r => {
    const raw = r[0];
    if (!raw) return null;
    if (raw instanceof Date) {
      return parseInt(Utilities.formatDate(raw, tz, 'yyyyMMdd'), 10);
    }
    const s = raw.toString().trim();
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
    if (!m) return null;
    const yyyy = m[3].length === 2 ? '20' + m[3] : m[3];
    return parseInt(yyyy + m[2] + m[1], 10);
  });

  // Set de fechas únicas ≤ hoy
  const unicasMap = {};
  fechasPorFila.forEach(v => {
    if (v != null && v <= hoyVal) unicasMap[v] = true;
  });
  const unicas = Object.keys(unicasMap).map(Number).sort((a, b) => b - a);
  const conservar = new Set(unicas.slice(0, 5));

  Logger.log('🧹 limpiarNotificacionesAntiguas: ' + unicas.length + ' fechas únicas ≤ hoy, conservando ' + conservar.size);
  Logger.log('   Fechas conservadas: ' + Array.from(conservar).join(', '));

  // Identificar filas a borrar (índice de sheet)
  const filasABorrar = [];
  for (let i = 0; i < fechasPorFila.length; i++) {
    const v = fechasPorFila[i];
    if (v == null || !conservar.has(v)) {
      filasABorrar.push(6 + i);
    }
  }

  if (filasABorrar.length === 0) {
    Logger.log('✅ Nada que borrar');
    return;
  }

  // Agrupar filas contiguas y borrar de abajo hacia arriba
  filasABorrar.sort((a, b) => b - a);
  const grupos = [];
  let actual = { fin: filasABorrar[0], inicio: filasABorrar[0] };
  for (let i = 1; i < filasABorrar.length; i++) {
    const f = filasABorrar[i];
    if (f === actual.inicio - 1) {
      actual.inicio = f;
    } else {
      grupos.push(actual);
      actual = { fin: f, inicio: f };
    }
  }
  grupos.push(actual);

  let totalBorradas = 0;
  for (const g of grupos) {
    const cant = g.fin - g.inicio + 1;
    hoja.deleteRows(g.inicio, cant);
    totalBorradas += cant;
  }

  Logger.log('✅ limpiarNotificacionesAntiguas: ' + totalBorradas + ' filas borradas en ' + grupos.length + ' grupos');
}

function programarLimpiezaDiaria() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'limpiarNotificacionesAntiguas') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('limpiarNotificacionesAntiguas')
    .timeBased()
    .everyDays(1)
    .atHour(5)
    .nearMinute(0)
    .create();

  Logger.log('✅ Trigger limpieza diaria 5AM creado');
  SpreadsheetApp.getUi().alert('🧹 Limpieza programada: Todos los días a las 5:00 AM se conservarán solo las últimas 5 fechas.');
}

function eliminarLimpiezaDiaria() {
  const triggers = ScriptApp.getProjectTriggers();
  let eliminados = 0;
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'limpiarNotificacionesAntiguas') {
      ScriptApp.deleteTrigger(t);
      eliminados++;
    }
  });

  if (eliminados > 0) {
    Logger.log('🗑️ Trigger limpieza eliminado');
    SpreadsheetApp.getUi().alert('🗑️ Limpieza diaria desactivada.');
  } else {
    SpreadsheetApp.getUi().alert('ℹ️ No había limpieza diaria programada.');
  }
}

function setRichTextHistorial(celda, texto) {
  if (!texto || !texto.includes('\n')) { celda.setValue(texto); return; }
  const nl = texto.indexOf('\n');
  const richText = SpreadsheetApp.newRichTextValue()
    .setText(texto)
    .setTextStyle(0, nl, SpreadsheetApp.newTextStyle().setBold(true).setFontSize(11).build())
    .setTextStyle(nl + 1, texto.length, SpreadsheetApp.newTextStyle().setBold(false).setFontSize(10).build())
    .build();
  celda.setRichTextValue(richText);
}

function parsearHistorial(html) {
  const tbodyMatch = html.match(/<tbody[\s\S]*?<\/tbody>/i);
  if (!tbodyMatch) return [];
  const trs = tbodyMatch[0].match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
  const entradas = [];
  for (const tr of trs) {
    const tds = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
    if (tds.length < 2) continue;
    const fecha = limpiarHtml(tds[0].replace(/<\/?td[^>]*>/gi, ''));
    const descripcion = limpiarHtml(tds[1].replace(/<\/?td[^>]*>/gi, ''));
    if (fecha && descripcion) entradas.push({ fecha, descripcion });
  }
  return entradas;
}

function obtenerUltimaEntradaExpte(cookies, expte) {
  try {
    const url = CONFIG.URL_BASE + '/apremios/' + expte;
    const resp = UrlFetchApp.fetch(url, {
      headers: { 'Cookie': cookies },
      muteHttpExceptions: true,
      followRedirects: true,
    });
    if (resp.getResponseCode() !== 200) return '';
    const entradas = parsearHistorial(resp.getContentText('UTF-8'));
    if (entradas.length === 0) return '';
    const { fecha, descripcion } = entradas[0];
    const fechaCorta = fecha.replace(/^(\d{2}\/\d{2}\/)\d{2}(\d{2})$/, '$1$2');
    return fechaCorta + '\n' + descripcion;
  } catch (e) {
    Logger.log('  ⚠️ obtenerUltimaEntradaExpte error: ' + e.message);
    return '';
  }
}

function rellenarUltimaEntradaFilasNuevas(cookies, filas, hoja) {
  const cache = {};
  for (let i = 0; i < filas.length; i++) {
    const expte = filas[i][3] ? filas[i][3].toString().trim() : '';
    if (!expte) continue;
    if (!(expte in cache)) {
      Logger.log('  📜 Historial: ' + expte);
      cache[expte] = obtenerUltimaEntradaExpte(cookies, expte);
      Utilities.sleep(1500);
    }
    if (cache[expte]) {
      setRichTextHistorial(hoja.getRange(6 + i, 9), cache[expte]);
    }
  }
  Logger.log('📜 Última entrada rellenada: ' + Object.keys(cache).length + ' expedientes únicos');
}

function extraerUltimaEntradaYAsignarEstados() {
  const INICIO_TS = Date.now();

  // Limpiar posibles triggers anteriores de esta misma función
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'extraerUltimaEntradaYAsignarEstados') {
      ScriptApp.deleteTrigger(t);
    }
  });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(CONFIG.HOJA_NOMBRE);
  if (!hoja) {
    try { SpreadsheetApp.getUi().alert('Hoja Notificaciones no encontrada.'); } catch(e){}
    return; 
  }
  const lastRow = hoja.getLastRow();
  if (lastRow < 6) { 
    try { SpreadsheetApp.getUi().alert('Sin datos en Notificaciones.'); } catch(e){}
    return; 
  }

  const datos = hoja.getRange(6, 1, lastRow - 5, 9).getValues();

  let fechaMasRecienteStr = null;
  let fechaMasRecienteVal = 0;
  for (let i = 0; i < datos.length; i++) {
    const rawFecha = datos[i][2];
    const fecha = rawFecha instanceof Date
      ? Utilities.formatDate(rawFecha, Session.getScriptTimeZone(), 'dd/MM/yyyy')
      : (rawFecha ? rawFecha.toString().trim() : '');
    if (!fecha) continue;
    
    const parts = fecha.split('/');
    if (parts.length === 3) {
      const val = parseInt(parts[2] + parts[1] + parts[0], 10); // YYYYMMDD
      if (val > fechaMasRecienteVal) {
        fechaMasRecienteVal = val;
        fechaMasRecienteStr = fecha;
      }
    }
  }
  const fechaMasReciente = fechaMasRecienteStr;
  if (!fechaMasReciente) return;

  const cache = {};
  let actualizados = 0;
  let sinProcID = 0;

  for (let i = 0; i < datos.length; i++) {
    // Verificación de timeout
    if (tiempoAgotado(INICIO_TS)) {
      Logger.log('⏳ Tiempo máximo alcanzado (4 min). Programando continuación manual...');
      ScriptApp.newTrigger('extraerUltimaEntradaYAsignarEstados')
        .timeBased()
        .after(CONFIG.CONTINUACION_DELAY_MS)
        .create();
      try {
        SpreadsheetApp.getActiveSpreadsheet().toast('⏳ Tiempo agotado. El script continuará automáticamente en 1 minuto.', 'Pausado', -1);
      } catch (e) {} // Falla silenciosamente si se ejecutó desde un trigger
      return;
    }

    const filaSheet = 6 + i;
    const rawFecha = datos[i][2];
    const fecha = rawFecha instanceof Date
      ? Utilities.formatDate(rawFecha, Session.getScriptTimeZone(), 'dd/MM/yyyy')
      : (rawFecha ? rawFecha.toString().trim() : '');
    if (fecha !== fechaMasReciente) continue;

    const responsable = datos[i][1] ? datos[i][1].toString().trim() : '';
    if (responsable !== 'RESP. A') continue;

    const procID = datos[i][0] ? datos[i][0].toString().trim() : '';
    if (!procID) { sinProcID++; continue; }

    const histActual = datos[i][8] ? datos[i][8].toString().trim() : '';
    if (histActual) continue;

    if (!(procID in cache)) {
      Logger.log('  📜 Fila ' + filaSheet + ' procID: ' + procID);
      cache[procID] = obtenerHistorialYAdjuntoCercanoHoyPorProcID(procID);
      Utilities.sleep(300);
    }
    const top = cache[procID];
    if (top && top.historial) {
      setRichTextHistorial(hoja.getRange(filaSheet, 9), top.historial);
      if (top.topHistId) {
        const expte = datos[i][3] ? datos[i][3].toString().trim() : ('ProcID_' + procID);
        const textoPdfUrl = obtenerTextoYGenerarPDF(procID, top.topHistId, expte);
        if (textoPdfUrl) {
          hoja.getRange(filaSheet, 10).setFormula('=HYPERLINK("' + textoPdfUrl.replace(/"/g, '""') + '";"Ver Texto")');
        }
      }
      if (top.adjuntoUrl) {
        const expte = datos[i][3] ? datos[i][3].toString().trim() : ('ProcID_' + procID);
        const driveUrl = descargarPDFADrive(top.adjuntoUrl, expte, top.histid);
        const safeUrl = driveUrl.replace(/"/g, '""');
        hoja.getRange(filaSheet, 11).setFormula('=HYPERLINK("' + safeUrl + '";"Ver PDF")');
      }
      actualizados++;
    }
  }

  // Una vez terminada la extracción, asignamos los estados a toda la hoja
  asignarEstadosFinal(hoja);

  try {
    SpreadsheetApp.getUi().alert('✅ Proceso completado:\n' + 
      '• ' + actualizados + ' historiales extraídos.\n' +
      '• Estados asignados exitosamente.' +
      (sinProcID > 0 ? '\n⚠️ Quedaron ' + sinProcID + ' filas sin procID (saltadas).' : ''));
  } catch (e) {
    Logger.log('✅ Proceso completado: ' + actualizados + ' historiales extraídos. Estados asignados.');
  }
}

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Notificaciones')
    .addItem('📥 Extraer notificaciones manualmente', 'ejecucionManual')
    .addItem('🔍 Extraer última entrada y asignar estados faltantes', 'extraerUltimaEntradaYAsignarEstados')
    .addItem('🔧 Reparar responsables faltantes (incidentes)', 'repararResponsables')
    .addSeparator()
    .addItem('🔗 Actualizar "Espacio SAT ID"', 'actualizarEspacioSatId')
    .addItem('📤 Transferir estados a "Espacio SAT"', 'transferirEstadosEspacioSat')
    .addSeparator()
    .addItem('🔑 Actualizar credenciales de Log In', 'guardarCredenciales')
    .addItem('⏰ Programar extracción diaria a las 3AM', 'crearTriggerDiario')
    .addItem('🗑️ Eliminar programación diaria', 'eliminarTriggerDiario')
    .addSeparator()
    .addItem('🧹 Programar limpieza diaria 5AM (últimas 5 fechas)', 'programarLimpiezaDiaria')
    .addItem('🗑️ Eliminar limpieza diaria', 'eliminarLimpiezaDiaria')
    .addToUi();
}

// ─────────────────────────────────────────────────────────────
// Helpers de resume / continuación / timeout
// ─────────────────────────────────────────────────────────────

function tiempoAgotado(inicioTs) {
  return (Date.now() - inicioTs) >= CONFIG.MAX_EXEC_MS;
}

function getResumeState() {
  const json = PropertiesService.getScriptProperties().getProperty(CONFIG.RESUME_KEY);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch (e) {
    Logger.log('⚠️ getResumeState: JSON corrupto, limpiando');
    clearResumeState();
    return null;
  }
}

function setResumeState(state) {
  PropertiesService.getScriptProperties().setProperty(CONFIG.RESUME_KEY, JSON.stringify(state));
}

function clearResumeState() {
  PropertiesService.getScriptProperties().deleteProperty(CONFIG.RESUME_KEY);
}

function programarContinuacion() {
  eliminarTriggersContinuacion();
  ScriptApp.newTrigger(CONFIG.CONTINUACION_HANDLER)
    .timeBased()
    .after(CONFIG.CONTINUACION_DELAY_MS)
    .create();
  Logger.log('⏰ Trigger de continuación programado a +' + (CONFIG.CONTINUACION_DELAY_MS / 1000) + 's');
}

function eliminarTriggersContinuacion() {
  const triggers = ScriptApp.getProjectTriggers();
  let eliminados = 0;
  triggers.forEach(t => {
    if (t.getHandlerFunction() === CONFIG.CONTINUACION_HANDLER) {
      ScriptApp.deleteTrigger(t);
      eliminados++;
    }
  });
  if (eliminados > 0) Logger.log('🗑️ Triggers de continuación eliminados: ' + eliminados);
}

function loginConCredenciales() {
  const props = PropertiesService.getScriptProperties();
  const usuario = props.getProperty('SAE_USER');
  const clave = props.getProperty('SAE_PASS');
  return hacerLogin(usuario, clave);
}

function crearmenu() {
  const ESTADOS = [
    '1.INICIADO',
    '2.VISTA AGENTE FISCAL',
    '3.SENTENCIA PENDIENTE',
    '4.VER QUE LIBRE MANDAMIENTO',
    '5.ESPERANDO MANDAMIENTO/CEDULA',
    '6.SIN NOTIFICAR',
    '7.MANDAR MARTILLERO',
    '8.PEDIR EMBARGO',
    '9.EMBARGO',
    '10.EMBARGO PREVENTIVO SIN NOTIFICAR',
    '11.NO EMBARGAR',
    '12.ALLANAMIENTO / DACION EN PAGO',
    '13.EXCEPCIONES',
    '14.PREVIO',
    '15.RECTIFICO',
    '16.DISCORDANCIA IRREPARABLE',
    '17.PLAZOS SUSPENDIDOS',
    '18.LEVANTAMIENTO',
    '19.HACER CARTA DE PAGO',
    '20.PIDO TRANSFERENCIA CAPITAL',
    '21.PRESENTO PLANILLA CAPITAL',
    '22.PIDO TRANSFERENCIA DE PLANILLA CAPITAL',
    '23.TRANSFERENCIA DE HONORARIO',
    '24.DESISTIMIENTO',
    '25.TERMINADO',
    '26.NUBE',
  ];
  const COLORES = [
    '#FFB3BA', '#FFDFBA', '#FFFFBA', '#BAFFC9', '#BAE1FF',
    '#E0BBE4', '#D5AAFF', '#FFDAC1', '#B5EAD7', '#C7CEEA',
    '#FFC8DD', '#BDE0FE', '#A2D2FF', '#CDB4DB', '#FFC9DE',
    '#D4A5A5', '#9FC1CA', '#C5DFAA', '#F4C2C2', '#E6D7B9',
    '#B8E0D2', '#D6CDEA', '#F7D6BF', '#C9E4DE', '#FAEDCB', '#DBE7E4',
  ];

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(CONFIG.HOJA_NOMBRE);
  if (!hoja) {
    SpreadsheetApp.getUi().alert('Hoja Notificaciones no encontrada.');
    return;
  }
  const celda = hoja.getRange('A1');

  const regla = SpreadsheetApp.newDataValidation()
    .requireValueInList(ESTADOS, true)
    .setAllowInvalid(false)
    .build();
  celda.setDataValidation(regla);

  const rangoA1 = celda.getA1Notation();
  const reglasExistentes = hoja.getConditionalFormatRules();
  const reglasFiltradas = reglasExistentes.filter(r =>
    !r.getRanges().some(rg => rg.getA1Notation() === rangoA1)
  );
  const nuevasReglas = ESTADOS.map((estado, idx) =>
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(estado)
      .setBackground(COLORES[idx])
      .setRanges([celda])
      .build()
  );
  hoja.setConditionalFormatRules(reglasFiltradas.concat(nuevasReglas));

  Logger.log('✅ crearmenu: validación + ' + nuevasReglas.length + ' reglas de color aplicadas a A1');
}

function aplicarColorPorEstado() {
  const ESTADOS = [
    '1.INICIADO',
    '2.VISTA AGENTE FISCAL',
    '3.SENTENCIA PENDIENTE',
    '4.VER QUE LIBRE MANDAMIENTO',
    '5.ESPERANDO MANDAMIENTO/CEDULA',
    '6.SIN NOTIFICAR',
    '7.MANDAR MARTILLERO',
    '8.PEDIR EMBARGO',
    '9.EMBARGO',
    '10.EMBARGO PREVENTIVO SIN NOTIFICAR',
    '11.NO EMBARGAR',
    '12.ALLANAMIENTO / DACION EN PAGO',
    '13.EXCEPCIONES',
    '14.PREVIO',
    '15.RECTIFICO',
    '16.DISCORDANCIA IRREPARABLE',
    '17.PLAZOS SUSPENDIDOS',
    '18.LEVANTAMIENTO',
    '19.HACER CARTA DE PAGO',
    '20.PIDO TRANSFERENCIA CAPITAL',
    '21.PRESENTO PLANILLA CAPITAL',
    '22.PIDO TRANSFERENCIA DE PLANILLA CAPITAL',
    '23.TRANSFERENCIA DE HONORARIO',
    '24.DESISTIMIENTO',
    '25.TERMINADO',
    '26.NUBE',
  ];
  const COLORES = [
    '#FFB3BA', '#FFDFBA', '#FFFFBA', '#BAFFC9', '#BAE1FF',
    '#E0BBE4', '#D5AAFF', '#FFDAC1', '#B5EAD7', '#C7CEEA',
    '#FFC8DD', '#BDE0FE', '#A2D2FF', '#CDB4DB', '#FFC9DE',
    '#D4A5A5', '#9FC1CA', '#C5DFAA', '#F4C2C2', '#E6D7B9',
    '#B8E0D2', '#D6CDEA', '#F7D6BF', '#C9E4DE', '#FAEDCB', '#DBE7E4',
  ];

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(CONFIG.HOJA_NOMBRE);
  if (!hoja) {
    SpreadsheetApp.getUi().alert('Hoja Notificaciones no encontrada.');
    return;
  }

  const maxRows = hoja.getMaxRows();
  const rango = hoja.getRange(6, 8, Math.max(maxRows - 5, 1), 3); // H6:J(maxRows)
  const a1Rango = rango.getA1Notation();

  const reglasExistentes = hoja.getConditionalFormatRules();
  const reglasFiltradas = reglasExistentes.filter(r =>
    !r.getRanges().some(rg => rg.getA1Notation() === a1Rango)
  );

  const nuevasReglas = ESTADOS.map((estado, idx) =>
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$E6="' + estado.replace(/"/g, '""') + '"')
      .setBackground(COLORES[idx])
      .setRanges([rango])
      .build()
  );

  hoja.setConditionalFormatRules(reglasFiltradas.concat(nuevasReglas));
  Logger.log('✅ aplicarColorPorEstado: ' + nuevasReglas.length + ' reglas aplicadas a ' + a1Rango);
}

function quitarFiltrosNotificaciones(hoja) {
  try {
    const f = hoja.getFilter();
    if (f) {
      f.remove();
      Logger.log('🧹 Filtro básico removido');
    }
  } catch (e) {
    Logger.log('⚠️ getFilter().remove(): ' + e.message);
  }
  try {
    const ssId = SpreadsheetApp.getActiveSpreadsheet().getId();
    Sheets.Spreadsheets.batchUpdate(
      { requests: [{ clearBasicFilter: { sheetId: hoja.getSheetId() } }] },
      ssId
    );
    Logger.log('🧹 clearBasicFilter API ejecutado');
  } catch (e) {
    Logger.log('⚠️ clearBasicFilter API: ' + e.message);
  }
}

function obtenerHistorialPorProcID(procid) {
  return obtenerTopStoryPorProcID(procid).historial;
}

function obtenerTopStoryPorProcID(procid) {
  const vacio = { historial: '', adjuntoUrl: '' };
  const url = CONFIG.API_BASE_PROCID + '/proceedings/history'
    + '?jurisdiction=' + CONFIG.JURISDICTION_ID
    + '&proceeding=' + encodeURIComponent(procid);

  let resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        'Accept': 'application/json',
        'Origin': CONFIG.ORIGIN_PROCID,
        'Referer': CONFIG.ORIGIN_PROCID + '/',
      },
      muteHttpExceptions: true,
    });
  } catch (e) {
    Logger.log('  ⚠️ historial fetch error procid ' + procid + ': ' + e.message);
    return vacio;
  }

  if (resp.getResponseCode() !== 200) {
    Logger.log('  ⚠️ historial status ' + resp.getResponseCode() + ' procid ' + procid);
    return vacio;
  }

  let json;
  try {
    json = JSON.parse(resp.getContentText());
  } catch (e) {
    return vacio;
  }

  if (!json.success || !json.data || !Array.isArray(json.data.stories) || json.data.stories.length === 0) {
    return vacio;
  }

  const stories = json.data.stories.slice().sort(function (a, b) {
    return (b.fech || '').toString().localeCompare((a.fech || '').toString());
  });
  const top = stories[0];
  const fecha = (top.fecha || '').trim();
  const dscr = (top.dscr || '').trim();
  const historial = fecha + '\n' + dscr;

  let adjuntoUrl = '';
  let histid = null;
  if (Array.isArray(top.archivos) && top.archivos.length > 0) {
    const archivo = top.archivos[0];
    adjuntoUrl = obtenerLinkAdjunto(procid, top.histid, archivo.nombre) || '';
    histid = top.histid;
  }
  return { historial: historial, adjuntoUrl: adjuntoUrl, histid: histid, topHistId: top.histid };
}

function obtenerHistorialYAdjuntoCercanoHoyPorProcID(procid) {
  const vacio = { historial: '', adjuntoUrl: '' };
  const url = CONFIG.API_BASE_PROCID + '/proceedings/history'
    + '?jurisdiction=' + CONFIG.JURISDICTION_ID
    + '&proceeding=' + encodeURIComponent(procid);
  let resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        'Accept': 'application/json',
        'Origin': CONFIG.ORIGIN_PROCID,
        'Referer': CONFIG.ORIGIN_PROCID + '/',
      },
      muteHttpExceptions: true,
    });
  } catch (e) {
    Logger.log('  ⚠️ historial fetch error procid ' + procid + ': ' + e.message);
    return vacio;
  }
  if (resp.getResponseCode() !== 200) return vacio;
  let json;
  try { json = JSON.parse(resp.getContentText()); } catch (e) { return vacio; }
  if (!json.success || !json.data || !Array.isArray(json.data.stories) || json.data.stories.length === 0) return vacio;

  const stories = json.data.stories.slice().sort(function (a, b) {
    return (b.fech || '').toString().localeCompare((a.fech || '').toString());
  });
  const top = stories[0];
  const historial = (top.fecha || '').trim() + '\n' + (top.dscr || '').trim();

  const hoyStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd');
  const conAdjunto = stories.filter(s => Array.isArray(s.archivos) && s.archivos.length > 0);

  let elegido = null;
  let mejorDiff = Infinity;
  for (const s of conAdjunto) {
    const fech = (s.fech || '').toString();
    if (!/^\d{8}$/.test(fech)) continue;
    const diff = Math.abs(parseInt(fech, 10) - parseInt(hoyStr, 10));
    if (diff < mejorDiff) { mejorDiff = diff; elegido = s; }
  }

  let adjuntoUrl = '';
  let histid = null;
  if (elegido) {
    adjuntoUrl = obtenerLinkAdjunto(procid, elegido.histid, elegido.archivos[0].nombre) || '';
    histid = elegido.histid;
  }
  return { historial: historial, adjuntoUrl: adjuntoUrl, histid: histid, topHistId: top.histid };
}

function pruebaAdjunto3839() {
  const procid = 265172;
  const fechaObjetivo = '10/04/2026';
  const url = CONFIG.API_BASE_PROCID + '/proceedings/history'
    + '?jurisdiction=' + CONFIG.JURISDICTION_ID
    + '&proceeding=' + encodeURIComponent(procid);
  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'Accept': 'application/json',
      'Origin': CONFIG.ORIGIN_PROCID,
      'Referer': CONFIG.ORIGIN_PROCID + '/',
    },
    muteHttpExceptions: true,
  });
  Logger.log('📡 history status: ' + resp.getResponseCode());
  const json = JSON.parse(resp.getContentText());
  if (!json.success) { Logger.log('❌ history success=false'); return; }

  const story = (json.data.stories || []).find(s => (s.fecha || '').trim() === fechaObjetivo);
  if (!story) { Logger.log('❌ no se encontró story ' + fechaObjetivo); return; }
  Logger.log('📜 story histid=' + story.histid + ' dscr="' + story.dscr + '"');

  if (!Array.isArray(story.archivos) || story.archivos.length === 0) {
    Logger.log('⚠️ story sin archivos'); return;
  }
  const archivo = story.archivos[0];
  Logger.log('📎 archivo nombre=' + archivo.nombre);

  const link = obtenerLinkAdjunto(procid, story.histid, archivo.nombre);
  Logger.log('✅ link adjunto:');
  Logger.log(link);

  if (link) {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const hoja = ss.getSheetByName(CONFIG.HOJA_NOMBRE);
    if (hoja) {
      const safeUrl = link.replace(/"/g, '""');
      hoja.getRange('I34').setFormula('=HYPERLINK("' + safeUrl + '";"Ver PDF")');
      Logger.log('📌 link depositado en I34');
    } else {
      Logger.log('⚠️ Hoja Notificaciones no encontrada');
    }
  }
}

function obtenerLinkAdjunto(procid, histid, nombre) {
  if (!nombre || !histid) return '';
  const url = CONFIG.API_BASE_PROCID + '/proceedings/history/file';
  const body = {
    jurisdiction: String(CONFIG.JURISDICTION_ID),
    proceeding: Number(procid),
    history: Number(histid),
    file: Utilities.base64Encode(nombre),
  };
  let resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      headers: {
        'Accept': 'application/json',
        'Origin': CONFIG.ORIGIN_PROCID,
        'Referer': CONFIG.ORIGIN_PROCID + '/',
      },
      muteHttpExceptions: true,
    });
  } catch (e) {
    Logger.log('  ⚠️ adjunto fetch error procid ' + procid + ' hist ' + histid + ': ' + e.message);
    return '';
  }
  if (resp.getResponseCode() !== 200) {
    Logger.log('  ⚠️ adjunto status ' + resp.getResponseCode() + ' procid ' + procid + ' hist ' + histid);
    return '';
  }
  let json;
  try { json = JSON.parse(resp.getContentText()); } catch (e) { return ''; }
  if (!json.success || !json.data) return '';
  return json.data;
}

// ─────────────────────────────────────────────────────────────
// Integración con Google Drive para PDFs
// ─────────────────────────────────────────────────────────────

let CACHED_DRIVE_FOLDER = null;

function getCarpetaPDFs() {
  if (CACHED_DRIVE_FOLDER) return CACHED_DRIVE_FOLDER;
  const folderName = 'SAE Automatización PDFs';
  const folderIterator = DriveApp.getFoldersByName(folderName);
  if (folderIterator.hasNext()) {
    CACHED_DRIVE_FOLDER = folderIterator.next();
  } else {
    CACHED_DRIVE_FOLDER = DriveApp.createFolder(folderName);
    Logger.log('📁 Carpeta "' + folderName + '" creada en Drive.');
  }
  return CACHED_DRIVE_FOLDER;
}

function descargarPDFADrive(url, expte, histid) {
  if (!url) return '';
  try {
    const folder = getCarpetaPDFs();
    const cleanExpte = expte.replace(/[^a-zA-Z0-9-]/g, '_');
    
    // Si tenemos el ID único del historial, lo usamos en el nombre del archivo. 
    // Si no, caemos en usar un timestamp.
    const fileName = histid ? (cleanExpte + '_hist_' + histid + '.pdf') : (cleanExpte + '_' + new Date().getTime() + '.pdf');

    // Revisar si ya existe un archivo con ese nombre exacto (evita duplicados)
    const archivosExistentes = folder.getFilesByName(fileName);
    if (archivosExistentes.hasNext()) {
      Logger.log('📎 PDF ya existe en Drive (evitando duplicado): ' + fileName);
      return archivosExistentes.next().getUrl();
    }

    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: {
        'Accept': 'application/pdf,application/json',
        'Origin': CONFIG.ORIGIN_PROCID,
        'Referer': CONFIG.ORIGIN_PROCID + '/',
      }
    });
    
    // Si falla devolvemos el link original como fallback
    if (resp.getResponseCode() !== 200 || !resp.getBlob().getContentType().includes('pdf')) {
      Logger.log('⚠️ Error al descargar PDF para ' + expte + ' (status ' + resp.getResponseCode() + '). Usando link original.');
      return url;
    }
    
    const blob = resp.getBlob();
    blob.setName(fileName);

    const file = folder.createFile(blob);
    // Le damos permisos para que cualquiera con el link lo pueda ver
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    
    Logger.log('📎 PDF descargado y subido a Drive: ' + fileName);
    return file.getUrl();
  } catch (e) {
    Logger.log('⚠️ Excepción al guardar PDF de ' + expte + ': ' + e.message);
    return url;
  }
}

// ─────────────────────────────────────────────────────────────
// Extracción de Texto de Lupa a PDF
// ─────────────────────────────────────────────────────────────

function obtenerTextoYGenerarPDF(procid, histid, expte) {
  if (!histid || !procid) return '';
  const url = CONFIG.API_BASE_PROCID + '/proceedings/history/text?jurisdiction=' + CONFIG.JURISDICTION_ID + '&proceeding=' + encodeURIComponent(procid) + '&history=' + encodeURIComponent(histid);
  
  const folder = getCarpetaPDFs();
  const cleanExpte = expte.replace(/[^a-zA-Z0-9-]/g, '_');
  const fileName = cleanExpte + '_texto_' + histid + '.pdf';

  // Evitar duplicados
  const archivosExistentes = folder.getFilesByName(fileName);
  if (archivosExistentes.hasNext()) {
    Logger.log('📎 PDF de Texto ya existe en Drive: ' + fileName);
    return archivosExistentes.next().getUrl();
  }

  try {
    const resp = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: {
        'Accept': 'application/json',
        'Origin': CONFIG.ORIGIN_PROCID,
        'Referer': CONFIG.ORIGIN_PROCID + '/',
      }
    });
    
    if (resp.getResponseCode() !== 200) return '';
    let json;
    try { json = JSON.parse(resp.getContentText()); } catch (e) { return ''; }
    
    // Validar si realmente hay texto
    if (!json.success || !json.data || !json.data.history || !json.data.history.texto) return '';

    // Crear HTML enriquecido imitando la vista web del Poder Judicial
    const h = json.data.history;
    const certText = (h.certificado && h.certificado.dscr) ? h.certificado.dscr : '';
    const depositadoText = h.fechaDeposito ? ('<div class="deposito">Depositado en casillero virtual el: ' + h.fechaDeposito + '</div>') : '';
    const firmadoText = h.fechaFirma ? ('<div class="firma-box">Actuación firmada en fecha: <strong>' + h.fechaFirma + '</strong></div>') : '';
    const certificadoBox = certText ? ('<div class="cert-box">Certificado digital:<br>' + certText + '</div>') : '';

    const htmlContent = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
      'body{font-family: Arial, sans-serif; padding: 30px; color: #333; line-height: 1.5;}' +
      '.header{border-bottom: 2px solid #ddd; padding-bottom: 15px; margin-bottom: 20px;}' +
      '.title{font-size: 18px; font-weight: bold; margin-bottom: 5px;}' +
      '.subtitle{font-size: 14px; color: #555; margin-bottom: 8px;}' +
      '.deposito{font-size: 14px; font-style: italic; font-weight: bold;}' +
      '.texto-body{margin-bottom: 40px; font-size: 14px;}' +
      '.firma-box{background: #fff8e1; border: 1px solid #ffe082; padding: 12px; border-radius: 4px; margin-bottom: 15px; font-size: 14px;}' +
      '.cert-box{background: #e8f5e9; border: 1px solid #a5d6a7; padding: 12px; border-radius: 4px; font-size: 14px; font-weight: bold; color: #2e7d32; word-break: break-all;}' +
      '</style></head><body>' +
      '<div class="header">' +
        '<div class="title">' + (h.fecha || '') + ' | ' + (h.dscr || '') + '</div>' +
        '<div class="subtitle">' + expte + '</div>' +
        depositadoText +
      '</div>' +
      '<div class="texto-body">' + h.texto + '</div>' +
      firmadoText +
      certificadoBox +
      '</body></html>';

    const htmlBlob = Utilities.newBlob(htmlContent, 'text/html', fileName + '.html');
    const pdfBlob = htmlBlob.getAs('application/pdf');
    pdfBlob.setName(fileName);
    
    const file = folder.createFile(pdfBlob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    
    Logger.log('📎 PDF de Texto generado y subido a Drive: ' + fileName);
    return file.getUrl();
  } catch (e) {
    Logger.log('⚠️ Error generando PDF de texto para ' + expte + ': ' + e.message);
    return '';
  }
}

// ─────────────────────────────────────────────────────────────
// Integración con "Espacio SAT"
// ─────────────────────────────────────────────────────────────

function actualizarEspacioSatId() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Configurar Espacio SAT', 'Pegá el ID de la planilla Espacio SAT:\n(Es la cadena larga de letras y números que aparece en la URL del navegador)', ui.ButtonSet.OK_CANCEL);
  
  if (response.getSelectedButton() === ui.Button.OK) {
    const id = response.getResponseText().trim();
    if (id) {
      PropertiesService.getScriptProperties().setProperty('ESPACIO_SAT_ID', id);
      ui.alert('✅ ID guardado correctamente.');
    } else {
      ui.alert('⚠️ No ingresaste ningún ID válido.');
    }
  }
}

function transferirEstadosEspacioSat() {
  const ui = SpreadsheetApp.getUi();
  const id = PropertiesService.getScriptProperties().getProperty('ESPACIO_SAT_ID');
  if (!id) {
    ui.alert('⚠️ Primero debes configurar el ID de Espacio SAT desde el menú: "Actualizar Espacio SAT ID".');
    return;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hojaNotif = ss.getSheetByName(CONFIG.HOJA_NOMBRE);
  const lastRowN = hojaNotif.getLastRow();
  if (lastRowN < 6) { ui.alert('No hay datos en Notificaciones para transferir.'); return; }

  // Cols Notificaciones: A=ID, B=Resp, C=Fecha, D=Expte, E=Estado, F=Escrito a generar (marcador "Test"), G=Observaciones
  const datosNotif = hojaNotif.getRange(6, 1, lastRowN - 5, 7).getValues();

  // 1. Filtrar filas con F === "Test" y juntar fechas únicas
  const fechasSet = {};
  const filasTest = [];
  for (let i = 0; i < datosNotif.length; i++) {
    const marcador = datosNotif[i][5] ? datosNotif[i][5].toString().trim() : '';
    if (marcador !== 'Test') continue;
    const rawFecha = datosNotif[i][2];
    const fecha = rawFecha instanceof Date
      ? Utilities.formatDate(rawFecha, Session.getScriptTimeZone(), 'dd/MM/yyyy')
      : (rawFecha ? rawFecha.toString().trim() : '');
    if (!fecha) continue;
    fechasSet[fecha] = true;
    filasTest.push({ idx: i, fecha: fecha });
  }

  if (filasTest.length === 0) {
    ui.alert('No se encontraron filas con "Test" en la columna F.');
    return;
  }

  // Ordenar fechas dd/MM/yyyy descendente
  const fechasDisponibles = Object.keys(fechasSet).sort(function(a, b) {
    const pa = a.split('/'); const pb = b.split('/');
    return parseInt(pb[2] + pb[1] + pb[0], 10) - parseInt(pa[2] + pa[1] + pa[0], 10);
  });

  // 2. Popup pidiendo fechas a transferir
  const promptText = 'Fechas disponibles con "Test":\n\n' + fechasDisponibles.join('\n') +
    '\n\nIngresá las fechas a transferir separadas por coma (formato dd/MM/yyyy)\no escribí "todas" para transferir todas.';
  const resp = ui.prompt('Transferir estados', promptText, ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const input = resp.getResponseText().trim();
  if (!input) return;

  let fechasSeleccionadas;
  if (input.toLowerCase() === 'todas') {
    fechasSeleccionadas = new Set(fechasDisponibles);
  } else {
    fechasSeleccionadas = new Set(input.split(',').map(s => s.trim()).filter(s => s));
    const invalidas = [];
    fechasSeleccionadas.forEach(f => { if (!fechasSet[f]) invalidas.push(f); });
    if (invalidas.length > 0) {
      ui.alert('⚠️ Fechas no encontradas en filas marcadas "Test": ' + invalidas.join(', '));
      return;
    }
  }

  // 3. Armar map Expte -> {estado, fecha, observaciones, idxFila}
  const mapNotif = {};
  const filasParaLimpiar = [];
  for (const ft of filasTest) {
    if (!fechasSeleccionadas.has(ft.fecha)) continue;
    const i = ft.idx;
    const expte = datosNotif[i][3] ? datosNotif[i][3].toString().trim() : '';
    const estado = datosNotif[i][4] ? datosNotif[i][4].toString().trim() : '';
    const observ = datosNotif[i][6] != null ? datosNotif[i][6].toString() : '';
    if (!expte) continue;
    mapNotif[expte] = { estado: estado, fecha: ft.fecha, observaciones: observ };
    filasParaLimpiar.push(6 + i);
  }

  if (Object.keys(mapNotif).length === 0) {
    ui.alert('No hay expedientes válidos para transferir con las fechas seleccionadas.');
    return;
  }

  // 4. Abrir Hoja 2 SAT
  let ssSat, hojaSat;
  try {
    ssSat = SpreadsheetApp.openById(id);
    hojaSat = ssSat.getSheetByName('Hoja 2');
    if (!hojaSat) throw new Error('No se encontró la pestaña "Hoja 2".');
  } catch (e) {
    ui.alert('⚠️ Error al conectar con Espacio SAT: ' + e.message);
    return;
  }

  const lastRowS = hojaSat.getLastRow();
  const lastColS = hojaSat.getLastColumn();
  if (lastRowS < 2) { ui.alert('No hay datos en "Hoja 2" de Espacio SAT.'); return; }

  // 5. Mapeo dinámico: leer fila 1 y buscar headers
  const headers = hojaSat.getRange(1, 1, 1, lastColS).getValues()[0];
  const idxHeader = {};
  for (let c = 0; c < headers.length; c++) {
    const h = headers[c] ? headers[c].toString().trim().toUpperCase() : '';
    const hSinEspacios = h.replace(/\s+/g, '');
    if (h === 'ESTADO') idxHeader.estado = c;
    else if (h === 'FECHA ESTADO') idxHeader.fecha = c;
    else if (h === 'OBSERVACIONES') idxHeader.observaciones = c;
    else if (['N°', 'Nº', 'F', 'F.', 'F°', 'Fº'].includes(hSinEspacios)) idxHeader.numero = c;
  }

  const faltantes = [];
  if (idxHeader.estado === undefined) faltantes.push('ESTADO');
  if (idxHeader.fecha === undefined) faltantes.push('FECHA ESTADO');
  if (idxHeader.observaciones === undefined) faltantes.push('OBSERVACIONES');
  if (idxHeader.numero === undefined) faltantes.push('N° (o F)');
  if (faltantes.length > 0) {
    ui.alert('⚠️ Encabezados no encontrados en fila 1 de "Hoja 2": ' + faltantes.join(', '));
    return;
  }

  // 6. Traer solo col N° de Hoja 2 para matchear y escribir solo celdas necesarias
  const colNumeros = hojaSat.getRange(2, idxHeader.numero + 1, lastRowS - 1, 1).getValues();
  let actualizados = 0;
  for (let i = 0; i < colNumeros.length; i++) {
    const expteSat = colNumeros[i][0] ? colNumeros[i][0].toString().trim() : '';
    if (!mapNotif[expteSat]) continue;
    const filaSat = i + 2;
    const m = mapNotif[expteSat];
    try {
      hojaSat.getRange(filaSat, idxHeader.estado + 1).setValue(m.estado);
      hojaSat.getRange(filaSat, idxHeader.fecha + 1).setValue(m.fecha);
      if (m.observaciones) hojaSat.getRange(filaSat, idxHeader.observaciones + 1).setValue(m.observaciones);
      actualizados++;
    } catch (e) {
      Logger.log('⚠️ Error escribiendo fila ' + filaSat + ' (expte ' + expteSat + '): ' + e.message);
    }
  }

  if (actualizados === 0) {
    ui.alert('⚠️ No se encontró ningún N° coincidente en "Hoja 2" o todas las escrituras fallaron por permisos.');
    return;
  }

  // 7. Borrar "Test" de col F en filas transferidas (preserva validación)
  for (const fila of filasParaLimpiar) {
    hojaNotif.getRange(fila, 6).setValue('');
  }

  // Sin alert final
}
