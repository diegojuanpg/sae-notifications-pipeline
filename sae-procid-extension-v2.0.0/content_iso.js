console.log('[SAE Procid CS-ISO] cargado en', location.href);

// ── Captcha capturado de request saliente (notificar al background) ──

window.addEventListener('SAE_PROCID_CAPTCHA', (event) => {
  try {
    const captcha = event && event.detail && event.detail.captcha;
    if (!captcha) return;
    console.log('[SAE Procid CS-ISO] recibido CustomEvent CAPTCHA, enviando a background');
    chrome.runtime.sendMessage({ type: 'CAPTCHA_CAPTURED', captcha }, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn('[SAE Procid CS-ISO] warning sendMessage:', chrome.runtime.lastError.message);
      } else {
        console.log('[SAE Procid CS-ISO] background respondió:', resp);
      }
    });
  } catch (e) {
    console.warn('[SAE Procid CS-ISO] warning:', e);
  }
});

// ── Execute ready (args capturados del sitio) ──

let executeIsReady = false;

window.addEventListener('SAE_PROCID_EXECUTE_READY', (event) => {
  try {
    executeIsReady = true;
    const args = event && event.detail && event.detail.args;
    console.log('[SAE Procid CS-ISO] execute ready, args:', JSON.stringify(args));
    chrome.runtime.sendMessage({ type: 'EXECUTE_READY', args }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[SAE Procid CS-ISO] warning sendMessage EXECUTE_READY:', chrome.runtime.lastError.message);
      }
    });
  } catch (e) { /* ignore */ }
});

// ── Generación de tokens frescos bajo demanda ──

const pendingTokenRequests = new Map();

// Listener para respuestas del MAIN world.
// IMPORTANTE: puede haber múltiples MAIN instances respondiendo (viejo + nuevo
// post re-inyección). Preferimos token sobre error: si llega error, lo guardamos
// como "último error" pero seguimos esperando hasta timeout o hasta recibir token.
window.addEventListener('SAE_PROCID_TOKEN_RESPONSE', (event) => {
  try {
    const { requestId, token, error } = event.detail || {};
    if (!requestId) return;
    const pending = pendingTokenRequests.get(requestId);
    if (!pending) return;
    if (token) {
      pendingTokenRequests.delete(requestId);
      pending.resolve(token);
    } else if (error) {
      // Guardar error pero NO resolver todavía — esperar por si otro MAIN responde con token.
      pending.lastError = error;
    }
  } catch (e) {
    console.warn('[SAE Procid CS-ISO] warning en TOKEN_RESPONSE:', e);
  }
});

function requestFreshToken() {
  return new Promise((resolve, reject) => {
    const requestId = 'tok_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const timeout = setTimeout(() => {
      const pending = pendingTokenRequests.get(requestId);
      pendingTokenRequests.delete(requestId);
      const errMsg = (pending && pending.lastError) || 'timeout esperando token (10s)';
      reject(new Error(errMsg));
    }, 10000);

    pendingTokenRequests.set(requestId, {
      resolve: (token) => { clearTimeout(timeout); resolve(token); },
      reject: (err) => { clearTimeout(timeout); reject(err); },
      lastError: null,
    });

    window.dispatchEvent(new CustomEvent('SAE_PROCID_REQUEST_TOKEN', {
      detail: { requestId }
    }));
  });
}

// Listener para mensajes del background pidiendo tokens
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'REQUEST_FRESH_TOKEN') {
    // NOTA: ya no chequeamos executeIsReady localmente — tras re-inyección
    // (post extension-update) el closure nuevo arranca en false aunque el
    // MAIN viejo siga vivo con capturedExecuteArgs válidos. Delegamos al MAIN:
    // si execute no fue llamado, MAIN responde error vía SAE_PROCID_TOKEN_RESPONSE.
    console.log('[SAE Procid CS-ISO] background pidió token fresco, executeReady(local):', executeIsReady);

    requestFreshToken()
      .then((token) => {
        console.log('[SAE Procid CS-ISO] token fresco generado:', token.substring(0, 12) + '...');
        sendResponse({ success: true, token });
      })
      .catch((err) => {
        console.warn('[SAE Procid CS-ISO] warning generando token:', err.message);
        sendResponse({ success: false, error: err.message });
      });

    return true; // keep channel open for async sendResponse
  }
});

console.log('[SAE Procid CS-ISO] listeners ready (captcha + execute + token generator)');
