(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    video: $('video'), canvas: $('captureCanvas'), start: $('startBtn'), stop: $('stopBtn'),
    target: $('targetPlate'), tolerant: $('tolerantMode'), wake: $('wakeLockToggle'),
    interval: $('scanInterval'), roiMode: $('roiMode'), status: $('statusPill'),
    placeholder: $('placeholder'), overlay: $('hitOverlay'), hitPlate: $('hitPlate'),
    lastOcr: $('lastOcr'), similarity: $('similarity'), scanCount: $('scanCount'),
    hitCount: $('hitCount'), hitLog: $('hitLog'), clearLog: $('clearLogBtn'),
    testAlarm: $('testAlarmBtn'), errorBox: $('errorBox')
  };

  let stream = null;
  let worker = null;
  let running = false;
  let busy = false;
  let scanTimer = null;
  let wakeLock = null;
  let scans = 0;
  let hits = 0;
  let lastHitAt = 0;
  let audioCtx = null;

  const normalize = (s) => (s || '')
    .toUpperCase()
    .replace(/Ä/g, 'A').replace(/Ö/g, 'O').replace(/Ü/g, 'U')
    .replace(/[^A-Z0-9]/g, '');

  const prettyPlate = (s) => {
    const n = normalize(s);
    const m = n.match(/^([A-Z]{1,3})([A-Z]{1,2})(\d{1,4})$/);
    return m ? `${m[1]}-${m[2]} ${m[3]}` : (s || n);
  };

  function levenshtein(a, b) {
    const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = dp[0]; dp[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = dp[j];
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return dp[b.length];
  }

  function bestCandidate(raw, target) {
    const cleanedLines = (raw || '').toUpperCase().split(/\s+/).map(normalize).filter(Boolean);
    const joined = normalize(raw);
    const candidates = new Set(cleanedLines);
    if (joined) candidates.add(joined);

    // Sliding windows help when OCR returns extra characters around a plate.
    for (const source of [...candidates]) {
      if (source.length >= target.length) {
        for (let i = 0; i <= source.length - target.length; i++) candidates.add(source.slice(i, i + target.length));
      }
    }

    let best = { value: '', distance: Infinity };
    for (const c of candidates) {
      const d = levenshtein(c, target);
      if (d < best.distance) best = { value: c, distance: d };
      if (d === 0) break;
    }
    return best;
  }

  function setStatus(text, kind = 'idle') {
    els.status.textContent = text;
    els.status.className = `status-pill ${kind}`;
  }

  async function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
  }

  async function soundAlarm() {
    await ensureAudio();
    const now = audioCtx.currentTime;
    [0, 0.34, 0.68].forEach((offset) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(1050, now + offset);
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.45, now + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.22);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + offset); osc.stop(now + offset + 0.24);
    });
    if (navigator.vibrate) navigator.vibrate([220, 100, 220, 100, 400]);
  }

  async function requestWakeLock() {
    if (!els.wake.checked || !('wakeLock' in navigator)) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) { wakeLock = null; }
  }

  async function releaseWakeLock() {
    try { if (wakeLock) await wakeLock.release(); } catch (_) {}
    wakeLock = null;
  }

  function showError(message) {
    if (!els.errorBox) return;
    els.errorBox.hidden = false;
    els.errorBox.textContent = message;
  }

  function clearError() {
    if (!els.errorBox) return;
    els.errorBox.hidden = true;
    els.errorBox.textContent = '';
  }

  async function initWorker() {
    if (worker) return;
    if (!window.Tesseract) throw new Error('OCR-Bibliothek konnte nicht geladen werden. Internetverbindung prüfen.');
    setStatus('OCR lädt …', 'busy');
    worker = await Tesseract.createWorker('eng', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text' && typeof m.progress === 'number') {
          setStatus(`OCR ${Math.round(m.progress * 100)} %`, 'busy');
        }
      }
    });
    await worker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
      tessedit_pageseg_mode: '7',
      preserve_interword_spaces: '0'
    });
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Kamerazugriff wird hier nicht unterstützt. Öffne die Seite über HTTPS in Safari.');
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 30 }
      }
    });
    els.video.srcObject = stream;
    await els.video.play();
    els.placeholder.style.display = 'none';
  }

  function cropFrame() {
    const vw = els.video.videoWidth, vh = els.video.videoHeight;
    if (!vw || !vh) return null;
    let x = 0, y = 0, w = vw, h = vh;
    const mode = els.roiMode.value;
    if (mode === 'center') { x = vw * 0.08; w = vw * 0.84; y = vh * 0.37; h = vh * 0.28; }
    if (mode === 'wide') { x = vw * 0.02; w = vw * 0.96; y = vh * 0.28; h = vh * 0.45; }

    // Downscale for substantially faster OCR while keeping enough plate detail.
    const maxW = 1280;
    const scale = Math.min(1, maxW / w);
    const outW = Math.max(320, Math.round(w * scale));
    const outH = Math.max(100, Math.round(h * scale));
    const c = els.canvas;
    c.width = outW; c.height = outH;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(els.video, x, y, w, h, 0, 0, outW, outH);

    // Grayscale + contrast + light thresholding to improve plate OCR.
    const img = ctx.getImageData(0, 0, outW, outH);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      g = (g - 128) * 1.45 + 128;
      g = Math.max(0, Math.min(255, g));
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  async function scanOnce() {
    if (!running || busy || !worker) return;
    busy = true;
    try {
      const frame = cropFrame();
      if (!frame) return;
      const result = await worker.recognize(frame);
      scans += 1;
      els.scanCount.textContent = String(scans);

      const target = normalize(els.target.value);
      const best = bestCandidate(result.data.text, target);
      els.lastOcr.textContent = best.value || '—';
      const similarity = target.length ? Math.max(0, Math.round((1 - best.distance / Math.max(target.length, best.value.length || 1)) * 100)) : 0;
      els.similarity.textContent = Number.isFinite(similarity) ? `${similarity} %` : '—';

      const allowed = els.tolerant.checked ? 1 : 0;
      if (target && best.value && best.distance <= allowed) {
        const now = Date.now();
        if (now - lastHitAt > 5000) {
          lastHitAt = now;
          await registerHit(best.value);
        }
      }
      if (running) setStatus('Scan aktiv', 'active');
    } catch (err) {
      console.error(err);
      setStatus('OCR-Fehler', 'idle');
    } finally {
      busy = false;
    }
  }

  async function registerHit(recognized) {
    hits += 1;
    els.hitCount.textContent = String(hits);
    const plate = prettyPlate(els.target.value);
    els.hitPlate.textContent = plate;
    els.overlay.hidden = false;
    setStatus('TREFFER', 'hit');
    await soundAlarm();
    const timestamp = new Date();
    const entry = { plate, recognized, time: timestamp.toISOString() };
    const log = JSON.parse(localStorage.getItem('plateHitLog') || '[]');
    log.unshift(entry);
    localStorage.setItem('plateHitLog', JSON.stringify(log.slice(0, 30)));
    renderLog();
    setTimeout(() => { els.overlay.hidden = true; if (running) setStatus('Scan aktiv', 'active'); }, 2500);
  }

  function renderLog() {
    const log = JSON.parse(localStorage.getItem('plateHitLog') || '[]');
    if (!log.length) { els.hitLog.innerHTML = '<div class="empty-log">Noch keine Treffer.</div>'; return; }
    els.hitLog.innerHTML = log.map((e) => {
      const d = new Date(e.time);
      return `<div class="log-entry"><strong>${escapeHtml(e.plate)}</strong><span>${d.toLocaleDateString('de-DE')} · ${d.toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span></div>`;
    }).join('');
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c])); }

  async function start() {
    if (running) return;
    clearError();
    els.start.disabled = true;
    setStatus('Kamera startet …', 'busy');

    try {
      if (!window.isSecureContext) {
        throw new Error('Die Seite läuft nicht in einem sicheren HTTPS-Kontext. Öffne die GitHub-Pages-Adresse direkt in Safari.');
      }
      await ensureAudio();
      await startCamera();

      // Die Kamera gilt jetzt bereits als erfolgreich gestartet. OCR wird danach geladen,
      // damit ein CDN-/WASM-Problem nicht wie ein Kamerafehler aussieht.
      running = true;
      els.stop.disabled = false;
      els.target.disabled = true;
      await requestWakeLock();
      setStatus('OCR wird geladen …', 'busy');

      try {
        await initWorker();
      } catch (ocrErr) {
        console.error(ocrErr);
        setStatus('OCR nicht geladen', 'idle');
        showError('Kamera läuft, aber die OCR konnte nicht geladen werden.\n\n' + (ocrErr.message || String(ocrErr)) + '\n\nPrüfe die Internetverbindung und lade die Seite in Safari neu.');
        return;
      }

      setStatus('Scan aktiv', 'active');
      scanOnce();
      scanTimer = setInterval(scanOnce, Number(els.interval.value));
    } catch (err) {
      console.error(err);
      const name = err && err.name ? err.name : '';
      let msg = err && err.message ? err.message : String(err);
      if (name === 'NotAllowedError') msg = 'Kamerazugriff wurde nicht erlaubt. In iOS: Einstellungen → Apps → Safari → Kamera → Erlauben, danach die Seite neu laden.';
      if (name === 'NotFoundError') msg = 'Keine nutzbare Kamera gefunden.';
      if (name === 'NotReadableError') msg = 'Die Kamera ist gerade durch eine andere App oder einen anderen Browser-Tab belegt.';
      showError(msg);
      setStatus('Start fehlgeschlagen', 'idle');
      await stop();
      showError(msg);
    } finally {
      if (!running) els.start.disabled = false;
    }
  }

  async function stop() {
    running = false;
    busy = false;
    if (scanTimer) clearInterval(scanTimer);
    scanTimer = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    els.video.srcObject = null;
    els.placeholder.style.display = '';
    els.overlay.hidden = true;
    els.start.disabled = false;
    els.stop.disabled = true;
    els.target.disabled = false;
    await releaseWakeLock();
    setStatus('Bereit', 'idle');
  }

  els.start.addEventListener('click', start);
  els.stop.addEventListener('click', stop);
  els.testAlarm.addEventListener('click', async () => {
    els.hitPlate.textContent = prettyPlate(els.target.value);
    els.overlay.hidden = false;
    await soundAlarm();
    setTimeout(() => { els.overlay.hidden = true; }, 1800);
  });
  els.clearLog.addEventListener('click', () => { localStorage.removeItem('plateHitLog'); renderLog(); });
  els.interval.addEventListener('change', () => {
    if (running) { clearInterval(scanTimer); scanTimer = setInterval(scanOnce, Number(els.interval.value)); }
  });
  els.roiMode.addEventListener('change', () => {
    const frame = document.getElementById('scanFrame');
    frame.style.display = els.roiMode.value === 'full' ? 'none' : '';
    if (els.roiMode.value === 'wide') { frame.style.top='29%'; frame.style.height='43%'; frame.style.left='2%'; frame.style.right='2%'; }
    else { frame.style.top='39%'; frame.style.height='24%'; frame.style.left='8%'; frame.style.right='8%'; }
  });
  els.wake.addEventListener('change', async () => { if (running) els.wake.checked ? requestWakeLock() : releaseWakeLock(); });

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && running && els.wake.checked) await requestWakeLock();
  });
  window.addEventListener('pagehide', stop);

  // Service Worker während der iPhone-Testphase absichtlich deaktiviert, damit keine alte Version gecacht wird.
  renderLog();
})();
