document.addEventListener('DOMContentLoaded', () => {
  const $url = document.getElementById('webAppUrl');
  const $token = document.getElementById('token');
  const $enabled = document.getElementById('enabled');
  const $save = document.getElementById('save');
  const $saved = document.getElementById('saved');
  const $status = document.getElementById('status');

  chrome.storage.local.get(
    ['webAppUrl', 'token', 'enabled', 'lastResult', 'lastTimeIso', 'lastTookMs'],
    (cfg) => {
      $url.value = cfg.webAppUrl || '';
      $token.value = cfg.token || '';
      $enabled.checked = cfg.enabled !== false;
      renderStatus(cfg);
    }
  );

  $save.addEventListener('click', () => {
    const webAppUrl = $url.value.trim();
    const token = $token.value.trim();
    chrome.storage.local.set({ webAppUrl, token }, () => {
      $saved.classList.add('show');
      setTimeout(() => $saved.classList.remove('show'), 1500);
    });
  });

  $enabled.addEventListener('change', () => {
    chrome.storage.local.set({ enabled: $enabled.checked });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.lastResult || changes.lastTimeIso) {
      chrome.storage.local.get(['lastResult', 'lastTimeIso', 'lastTookMs'], renderStatus);
    }
  });

  function renderStatus(cfg) {
    if (!cfg.lastResult || !cfg.lastTimeIso) {
      $status.className = 'status empty';
      $status.textContent = '— sin actividad —';
      return;
    }
    const r = cfg.lastResult;
    const fecha = new Date(cfg.lastTimeIso).toLocaleString();
    const ok = r.success;
    let body = '[' + fecha + ']  (' + (cfg.lastTookMs || '?') + ' ms)\n';
    if (ok) {
      body += '✅ guardados: ' + (r.saved || r.processed || 0) + '\n';
      if (r.sinMatch !== undefined) body += '🔍 sin match: ' + r.sinMatch + '\n';
      if (r.skipped) body += '⏭️  saltados: ' + r.skipped + '\n';
      if (r.errores) body += '⚠️ errores: ' + r.errores + '\n';
      if (r.captchaExpirado) body += '🛑 captcha expiró antes de terminar\n';
      if (r.stopped) body += '🛑 cortado: ' + (r.stopReason || 'sí') + '\n';
      if (r.message) body += 'ℹ️ ' + r.message + '\n';
    } else {
      body += '❌ error: ' + (r.error || 'desconocido');
    }
    $status.className = 'status ' + (ok ? 'ok' : 'err');
    $status.textContent = body;
  }
});
