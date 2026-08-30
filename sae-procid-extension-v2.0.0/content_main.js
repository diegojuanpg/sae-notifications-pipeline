(function () {
  // Guard: si ya hay una instancia activa en este MAIN world (re-inyección post-update),
  // no registrar listeners duplicados — el closure viejo sigue teniendo capturedExecuteArgs.
  // Detectamos el MAIN viejo (pre-guard) via grecaptcha.__sae_hooked.
  const yaHayMainPrevio = window.__SAE_PROCID_MAIN_LOADED ||
    (window.grecaptcha && window.grecaptcha.__sae_hooked);
  if (yaHayMainPrevio) {
    console.log('[SAE Procid CS-MAIN] ya cargado en este MAIN world (flag o grecaptcha hook detectado), skip');
    return;
  }
  window.__SAE_PROCID_MAIN_LOADED = true;

  console.log('[SAE Procid CS-MAIN] injectado en', location.href);

  // ── Captura de captcha desde requests salientes ─────────────
  function detectarCaptcha(url) {
    try {
      if (!url) return null;
      const urlStr = url.toString();
      if (!urlStr.includes('/api/proceedings')) return null;
      const u = new URL(urlStr, location.origin);
      const captcha = u.searchParams.get('captcha');
      if (captcha && captcha.length > 50) return captcha;
    } catch (e) { /* ignore */ }
    return null;
  }

  function dispatch(captcha) {
    try {
      window.dispatchEvent(new CustomEvent('SAE_PROCID_CAPTCHA', { detail: { captcha } }));
      console.log('[SAE Procid CS-MAIN] captcha capturado y despachado:', captcha.substring(0, 12) + '...');
    } catch (e) {
      console.warn('[SAE Procid CS-MAIN] error dispatch:', e);
    }
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url);
      const cap = detectarCaptcha(url);
      if (cap) dispatch(cap);
    } catch (e) { /* ignore */ }
    return origFetch.apply(this, arguments);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      const cap = detectarCaptcha(url);
      if (cap) dispatch(cap);
    } catch (e) { /* ignore */ }
    return origOpen.apply(this, arguments);
  };

  // ── Detectar cómo llama el sitio a grecaptcha.execute ───────

  // Guardamos los argumentos exactos que usa el sitio
  let capturedExecuteArgs = null;
  let executeReady = false;

  function hookGrecaptcha() {
    if (!window.grecaptcha || !window.grecaptcha.execute) return false;
    if (window.grecaptcha.__sae_hooked) return true;

    const origExecute = window.grecaptcha.execute;
    window.grecaptcha.execute = function () {
      // Capturar los argumentos exactos que usa el sitio
      // Puede ser: execute(siteKey, {action}) o execute(widgetId, {action}) o execute({action})
      const args = Array.from(arguments);
      console.log('[SAE Procid CS-MAIN] grecaptcha.execute llamado con args:', JSON.stringify(args));

      if (!capturedExecuteArgs) {
        capturedExecuteArgs = args;
        executeReady = true;
        console.log('[SAE Procid CS-MAIN] args de execute capturados:', JSON.stringify(args));
        window.dispatchEvent(new CustomEvent('SAE_PROCID_EXECUTE_READY', {
          detail: { args: args }
        }));
      }

      return origExecute.apply(this, arguments);
    };

    // También hookear grecaptcha.render para capturar el siteKey si se usa
    if (window.grecaptcha.render && !window.grecaptcha.__sae_render_hooked) {
      const origRender = window.grecaptcha.render;
      window.grecaptcha.render = function () {
        const renderArgs = Array.from(arguments);
        console.log('[SAE Procid CS-MAIN] grecaptcha.render llamado con args:', JSON.stringify(renderArgs));
        return origRender.apply(this, arguments);
      };
      window.grecaptcha.__sae_render_hooked = true;
    }

    window.grecaptcha.__sae_hooked = true;
    console.log('[SAE Procid CS-MAIN] grecaptcha.execute hookeado');
    return true;
  }

  // Intentar hookear inmediatamente y con retry
  if (!hookGrecaptcha()) {
    const intv = setInterval(() => {
      if (hookGrecaptcha()) clearInterval(intv);
    }, 500);
    setTimeout(() => clearInterval(intv), 30000);
  }

  // ── Generación de tokens frescos bajo demanda ───────────────

  window.addEventListener('SAE_PROCID_REQUEST_TOKEN', async (event) => {
    const requestId = event.detail && event.detail.requestId;
    try {
      if (!window.grecaptcha || !window.grecaptcha.execute) {
        window.dispatchEvent(new CustomEvent('SAE_PROCID_TOKEN_RESPONSE', {
          detail: { requestId, error: 'grecaptcha no disponible en la página' }
        }));
        return;
      }

      if (!executeReady || !capturedExecuteArgs) {
        window.dispatchEvent(new CustomEvent('SAE_PROCID_TOKEN_RESPONSE', {
          detail: { requestId, error: 'execute aún no fue llamado por el sitio, buscá un expediente primero' }
        }));
        return;
      }

      console.log('[SAE Procid CS-MAIN] generando token fresco con args:', JSON.stringify(capturedExecuteArgs));

      // Llamar a grecaptcha.execute con los MISMOS argumentos que usa el sitio
      // Pero necesitamos llamar al ORIGINAL, no al wrapper
      // El wrapper ya guarda origExecute en su closure
      const token = await window.grecaptcha.execute.apply(window.grecaptcha, capturedExecuteArgs);
      console.log('[SAE Procid CS-MAIN] token generado:', token.substring(0, 12) + '...');

      window.dispatchEvent(new CustomEvent('SAE_PROCID_TOKEN_RESPONSE', {
        detail: { requestId, token }
      }));
    } catch (e) {
      console.warn('[SAE Procid CS-MAIN] error generando token:', e);
      window.dispatchEvent(new CustomEvent('SAE_PROCID_TOKEN_RESPONSE', {
        detail: { requestId, error: e.message }
      }));
    }
  });

  console.log('[SAE Procid CS-MAIN] fetch + XHR wrapped, token generator ready');
})();
