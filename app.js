(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    video: $('video'), canvas: $('captureCanvas'), stage: $('cameraStage'), start: $('startBtn'), stop: $('stopBtn'),
    target: $('targetPlate'), tolerant: $('tolerantMode'), wake: $('wakeLockToggle'),
    interval: $('scanInterval'), roiMode: $('roiMode'), status: $('statusPill'),
    placeholder: $('placeholder'), overlay: $('hitOverlay'), hitPlate: $('hitPlate'), scanFrame: $('scanFrame'),
    lastOcr: $('lastOcr'), similarity: $('similarity'), scanCount: $('scanCount'),
    hitCount: $('hitCount'), hitLog: $('hitLog'), clearLog: $('clearLogBtn'),
    testAlarm: $('testAlarmBtn'), errorBox: $('errorBox'), focusRing: $('focusRing'),
    zoom: $('zoomSlider'), zoomValue: $('zoomValue'), zoomSupport: $('zoomSupport'),
    autoFocus: $('autoFocusBtn'), focusStatus: $('focusStatus'), manualFocusGroup: $('manualFocusGroup'),
    focus: $('focusSlider'), focusValue: $('focusValue'), cameraHud: $('cameraHud'),
    cameraResolution: $('cameraResolution'), cameraZoomMode: $('cameraZoomMode')
  };

  let stream = null;
  let track = null;
  let worker = null;
  let running = false;
  let busy = false;
  let scanTimer = null;
  let wakeLock = null;
  let scans = 0;
  let hits = 0;
  let lastHitAt = 0;
  let audioCtx = null;
  let capabilities = {};
  let supportedConstraints = {};
  let hardwareZoom = false;
  let digitalZoom = 1;
  let zoomApplyTimer = null;
  let focusRingTimer = null;

  const normalize = (s) => (s || '')
    .toUpperCase()
    .replace(/Ä/g, 'A').replace(/Ö/g, 'O').replace(/Ü/g, 'U')
    .replace(/[^A-Z0-9]/g, '');

  const prettyPlate = (s) => {
    const n = normalize(s);
    const m = n.match(/^([A-Z]{1,3})([A-Z]{1,2})(\d{1,4})$/);
    return m ? `${m[1]}-${m[2]} ${m[3]}` : (s || n);
  };

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const fmt = (n, digits = 1) => Number(n).toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });

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
    els.errorBox.hidden = false;
    els.errorBox.textContent = message;
  }

  function clearError() {
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

  function updateStageRatio() {
    const w = els.video.videoWidth;
    const h = els.video.videoHeight;
    if (!w || !h) return;
    els.stage.style.aspectRatio = `${w} / ${h}`;
    els.cameraResolution.textContent = `${w} × ${h}`;
  }

  function getFocusModes() {
    return Array.isArray(capabilities.focusMode) ? capabilities.focusMode : [];
  }

  function getZoomConstraint(value) {
    return hardwareZoom ? { zoom: value } : {};
  }

  async function applyAdvanced(values) {
    if (!track) return;
    await track.applyConstraints({ advanced: [values] });
  }

  async function enableContinuousFocus(silent = false) {
    if (!track) return;
    const modes = getFocusModes();
    if (!modes.includes('continuous')) {
      if (!silent) els.focusStatus.textContent = 'Safari verwendet den Kamera-Autofokus.';
      return;
    }
    try {
      const values = { focusMode: 'continuous', ...getZoomConstraint(Number(els.zoom.value)) };
      await applyAdvanced(values);
      els.focusStatus.textContent = 'Auto-Fokus aktiv · ins Bild tippen für Fokuspunkt.';
    } catch (err) {
      console.warn('continuous focus not available', err);
      if (!silent) els.focusStatus.textContent = 'Kamera-Autofokus aktiv.';
    }
  }

  function configureCameraControls() {
    supportedConstraints = navigator.mediaDevices.getSupportedConstraints ? navigator.mediaDevices.getSupportedConstraints() : {};
    capabilities = {};
    try { capabilities = track && track.getCapabilities ? track.getCapabilities() : {}; } catch (_) { capabilities = {}; }
    const settings = track && track.getSettings ? track.getSettings() : {};

    const zoomCap = capabilities.zoom;
    hardwareZoom = !!(zoomCap && Number.isFinite(zoomCap.min) && Number.isFinite(zoomCap.max) && zoomCap.max > zoomCap.min);

    if (hardwareZoom) {
      const min = zoomCap.min;
      const max = zoomCap.max;
      const step = zoomCap.step || 0.1;
      const current = clamp(Number(settings.zoom) || min, min, max);
      els.zoom.min = String(min);
      els.zoom.max = String(max);
      els.zoom.step = String(step);
      els.zoom.value = String(current);
      els.zoomValue.textContent = `${fmt(current)}×`;
      els.zoomSupport.textContent = `Hardware-Zoom der Kamera · ${fmt(min)}× bis ${fmt(max)}×`;
      els.cameraZoomMode.textContent = 'Hardware-Zoom';
      digitalZoom = 1;
      els.video.style.transform = '';
    } else {
      els.zoom.min = '1';
      els.zoom.max = '4';
      els.zoom.step = '0.1';
      els.zoom.value = '1';
      els.zoomValue.textContent = '1,0×';
      els.zoomSupport.textContent = 'Safari gibt keinen Hardware-Zoom frei · digitaler Zoom aktiv.';
      els.cameraZoomMode.textContent = 'Digital-Zoom';
      digitalZoom = 1;
      els.video.style.transform = 'scale(1)';
    }
    els.zoom.disabled = false;

    const modes = getFocusModes();
    const canContinuous = modes.includes('continuous');
    els.autoFocus.disabled = !track;
    els.focusStatus.textContent = canContinuous
      ? 'Auto-Fokus aktiv · ins Bild tippen für Fokuspunkt.'
      : 'Kamera-Autofokus aktiv · Fokuspunkt wird beim Tippen versucht.';

    const focusCap = capabilities.focusDistance;
    const manualCapable = modes.includes('manual') && focusCap && Number.isFinite(focusCap.min) && Number.isFinite(focusCap.max) && focusCap.max > focusCap.min;
    if (manualCapable) {
      els.manualFocusGroup.hidden = false;
      els.focus.min = String(focusCap.min);
      els.focus.max = String(focusCap.max);
      els.focus.step = String(focusCap.step || (focusCap.max - focusCap.min) / 100 || 0.01);
      const currentFocus = clamp(Number(settings.focusDistance) || focusCap.min, focusCap.min, focusCap.max);
      els.focus.value = String(currentFocus);
      els.focusValue.textContent = fmt(currentFocus, 2);
    } else {
      els.manualFocusGroup.hidden = true;
    }
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
    track = stream.getVideoTracks()[0];
    els.video.srcObject = stream;
    await els.video.play();
    updateStageRatio();
    els.placeholder.style.display = 'none';
    els.cameraHud.hidden = false;
    configureCameraControls();
    await enableContinuousFocus(true);
  }

  function getVisibleSourceRect() {
    const vw = els.video.videoWidth;
    const vh = els.video.videoHeight;
    if (!vw || !vh) return null;
    if (hardwareZoom || digitalZoom <= 1) return { x: 0, y: 0, w: vw, h: vh };
    const w = vw / digitalZoom;
    const h = vh / digitalZoom;
    return { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
  }

  function roiFractions() {
    switch (els.roiMode.value) {
      case 'wide': return { x: 0.02, y: 0.28, w: 0.96, h: 0.45 };
      case 'full': return { x: 0, y: 0, w: 1, h: 1 };
      default: return { x: 0.08, y: 0.37, w: 0.84, h: 0.28 };
    }
  }

  function updateRoiFrame() {
    const r = roiFractions();
    els.scanFrame.style.left = `${r.x * 100}%`;
    els.scanFrame.style.top = `${r.y * 100}%`;
    els.scanFrame.style.width = `${r.w * 100}%`;
    els.scanFrame.style.height = `${r.h * 100}%`;
    els.scanFrame.classList.toggle('full-frame', els.roiMode.value === 'full');
  }

  function cropFrame() {
    const view = getVisibleSourceRect();
    if (!view) return null;
    const r = roiFractions();
    const x = view.x + view.w * r.x;
    const y = view.y + view.h * r.y;
    const w = view.w * r.w;
    const h = view.h * r.h;

    const maxW = 1280;
    const scale = Math.min(1, maxW / w);
    const outW = Math.max(320, Math.round(w * scale));
    const outH = Math.max(100, Math.round(h * scale));
    const c = els.canvas;
    c.width = outW; c.height = outH;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(els.video, x, y, w, h, 0, 0, outW, outH);

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

  async function setZoom(value) {
    if (!track) return;
    const z = Number(value);
    els.zoomValue.textContent = `${fmt(z)}×`;
    if (!hardwareZoom) {
      digitalZoom = z;
      els.video.style.transform = `scale(${z})`;
      return;
    }
    try {
      const modes = getFocusModes();
      const values = { zoom: z };
      if (modes.includes('continuous')) values.focusMode = 'continuous';
      await applyAdvanced(values);
    } catch (err) {
      console.warn('hardware zoom failed; switching to digital zoom', err);
      hardwareZoom = false;
      digitalZoom = 1;
      els.zoom.min = '1';
      els.zoom.max = '4';
      els.zoom.step = '0.1';
      els.zoom.value = '1';
      els.zoomValue.textContent = '1,0×';
      els.zoomSupport.textContent = 'Hardware-Zoom wurde von Safari abgelehnt · digitaler Zoom aktiv.';
      els.cameraZoomMode.textContent = 'Digital-Zoom';
      els.video.style.transform = 'scale(1)';
    }
  }

  function showFocusRing(clientX, clientY) {
    const rect = els.stage.getBoundingClientRect();
    const x = clamp(clientX - rect.left, 0, rect.width);
    const y = clamp(clientY - rect.top, 0, rect.height);
    els.focusRing.style.left = `${x}px`;
    els.focusRing.style.top = `${y}px`;
    els.focusRing.hidden = false;
    els.focusRing.classList.remove('focus-pulse');
    void els.focusRing.offsetWidth;
    els.focusRing.classList.add('focus-pulse');
    clearTimeout(focusRingTimer);
    focusRingTimer = setTimeout(() => { els.focusRing.hidden = true; }, 1500);
  }

  async function focusAtPoint(event) {
    if (!running || !track || event.target.closest('.hit-overlay')) return;
    const rect = els.stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const rx = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    const ry = clamp((event.clientY - rect.top) / rect.height, 0, 1);
    showFocusRing(event.clientX, event.clientY);

    const view = getVisibleSourceRect();
    const sourceX = view ? Math.round(view.x + rx * view.w) : 0;
    const sourceY = view ? Math.round(view.y + ry * view.h) : 0;
    const modes = getFocusModes();
    const canPoint = supportedConstraints.pointsOfInterest === true;
    const canSingle = modes.includes('single-shot');

    try {
      if (canPoint || canSingle) {
        const values = { ...getZoomConstraint(Number(els.zoom.value)) };
        if (canSingle) values.focusMode = 'single-shot';
        if (canPoint) values.pointsOfInterest = [{ x: sourceX, y: sourceY }];
        await applyAdvanced(values);
        els.focusStatus.textContent = 'Fokuspunkt gesetzt.';
        if (modes.includes('continuous')) setTimeout(() => enableContinuousFocus(true), 900);
      } else {
        await enableContinuousFocus(true);
        els.focusStatus.textContent = 'Safari gibt keinen Fokuspunkt frei · Autofokus bleibt aktiv.';
      }
    } catch (err) {
      console.warn('tap focus not available', err);
      await enableContinuousFocus(true);
      els.focusStatus.textContent = 'Fokuspunkt von Safari nicht steuerbar · Autofokus aktiv.';
    }
  }

  async function setManualFocus(value) {
    if (!track) return;
    const v = Number(value);
    els.focusValue.textContent = fmt(v, 2);
    try {
      await applyAdvanced({ focusMode: 'manual', focusDistance: v, ...getZoomConstraint(Number(els.zoom.value)) });
      els.focusStatus.textContent = `Manueller Fokus ${fmt(v, 2)}`;
    } catch (err) {
      console.warn('manual focus not available', err);
      els.focusStatus.textContent = 'Manueller Fokus wurde von Safari nicht übernommen.';
    }
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
    const entry = { plate, recognized, time: new Date().toISOString() };
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
  }

  async function start() {
    if (running) return;
    clearError();
    els.start.disabled = true;
    setStatus('Kamera startet …', 'busy');

    try {
      if (!window.isSecureContext) throw new Error('Die Seite läuft nicht in einem sicheren HTTPS-Kontext. Öffne die GitHub-Pages-Adresse direkt in Safari.');
      await ensureAudio();
      await startCamera();

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
    clearTimeout(zoomApplyTimer);
    clearTimeout(focusRingTimer);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    track = null;
    capabilities = {};
    hardwareZoom = false;
    digitalZoom = 1;
    els.video.srcObject = null;
    els.video.style.transform = '';
    els.placeholder.style.display = '';
    els.cameraHud.hidden = true;
    els.overlay.hidden = true;
    els.focusRing.hidden = true;
    els.zoom.disabled = true;
    els.zoom.value = '1';
    els.zoomValue.textContent = '1,0×';
    els.zoomSupport.textContent = 'Wird nach Kamerastart geprüft.';
    els.autoFocus.disabled = true;
    els.manualFocusGroup.hidden = true;
    els.focusStatus.textContent = 'Nach dem Start ins Kamerabild tippen.';
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
  els.roiMode.addEventListener('change', updateRoiFrame);
  els.wake.addEventListener('change', async () => { if (running) els.wake.checked ? requestWakeLock() : releaseWakeLock(); });
  els.zoom.addEventListener('input', () => {
    els.zoomValue.textContent = `${fmt(Number(els.zoom.value))}×`;
    if (!hardwareZoom) {
      digitalZoom = Number(els.zoom.value);
      els.video.style.transform = `scale(${digitalZoom})`;
      return;
    }
    clearTimeout(zoomApplyTimer);
    zoomApplyTimer = setTimeout(() => setZoom(els.zoom.value), 90);
  });
  els.zoom.addEventListener('change', () => setZoom(els.zoom.value));
  els.stage.addEventListener('click', focusAtPoint);
  els.autoFocus.addEventListener('click', () => enableContinuousFocus(false));
  els.focus.addEventListener('input', () => {
    els.focusValue.textContent = fmt(Number(els.focus.value), 2);
  });
  els.focus.addEventListener('change', () => setManualFocus(els.focus.value));
  els.video.addEventListener('loadedmetadata', updateStageRatio);
  els.video.addEventListener('resize', updateStageRatio);

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && running && els.wake.checked) await requestWakeLock();
  });
  window.addEventListener('pagehide', stop);

  updateRoiFrame();
  renderLog();
})();
