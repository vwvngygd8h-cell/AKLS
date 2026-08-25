(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    video: $('video'), canvas: $('captureCanvas'), vehicleCanvas: $('vehicleCanvas'), roiPreview: $('roiPreview'), stage: $('cameraStage'), start: $('startBtn'), stop: $('stopBtn'),
    targets: $('targetPlates'), targetCount: $('targetCount'), activeTargets: $('activeTargets'), closestTarget: $('closestTarget'), ocrTime: $('ocrTime'), effectiveRate: $('effectiveRate'), tolerant: $('tolerantMode'), wake: $('wakeLockToggle'),
    interval: $('scanInterval'), roiMode: $('roiMode'), vehicleThreshold: $('vehicleThreshold'), status: $('statusPill'),
    placeholder: $('placeholder'), scanFrame: $('scanFrame'), vehicleBoxes: $('vehicleBoxes'),
    lastOcr: $('lastOcr'), similarity: $('similarity'), scanCount: $('scanCount'), hitCount: $('hitCount'), hintCount: $('hintCount'), vehicleScore: $('vehicleScore'),
    hitLog: $('hitLog'), clearLog: $('clearLogBtn'), testAlarm: $('testAlarmBtn'), errorBox: $('errorBox'), focusRing: $('focusRing'),
    zoom: $('zoomSlider'), zoomValue: $('zoomValue'), zoomSupport: $('zoomSupport'), autoFocus: $('autoFocusBtn'), focusStatus: $('focusStatus'), manualFocusGroup: $('manualFocusGroup'),
    focus: $('focusSlider'), focusValue: $('focusValue'), cameraHud: $('cameraHud'), cameraResolution: $('cameraResolution'), cameraZoomMode: $('cameraZoomMode'),
    alertBanner: $('alertBanner'), alertType: $('alertType'), alertText: $('alertText'),
    photoTargetSelect: $('photoTargetSelect'), vehiclePhotoInput: $('vehiclePhotoInput'), vehicleAssistToggle: $('vehicleAssistToggle'), vehicleRefsGrid: $('vehicleRefsGrid'), vehicleRefsSummary: $('vehicleRefsSummary'),
    clearTargetRefsBtn: $('clearTargetRefsBtn'), clearAllRefsBtn: $('clearAllRefsBtn'), vehicleAiStatus: $('vehicleAiStatus'), vehicleAiMetric: $('vehicleAiMetric')
  };

  const DB_NAME = 'kennzeichen-waechter-v5';
  const DB_VERSION = 1;
  const REF_STORE = 'vehicleRefs';

  let dbPromise = null;
  let stream = null;
  let track = null;
  let worker = null;
  let running = false;
  let busy = false;
  let scanTimer = null;
  let videoFrameRequest = null;
  let lastScanStartedAt = 0;
  let scanRateEma = 0;
  let wakeLock = null;
  let scans = 0;
  let hits = 0;
  let hints = 0;
  let lastHitAt = new Map();
  let lastHintAt = new Map();
  let audioCtx = null;
  let capabilities = {};
  let supportedConstraints = {};
  let hardwareZoom = false;
  let digitalZoom = 1;
  let zoomApplyTimer = null;
  let focusRingTimer = null;
  let alertTimer = null;
  let vehicleRefs = [];
  let processingPhotoUpload = false;
  let mobilenetModel = null;
  let detectorModel = null;
  let vehicleAiPromise = null;
  let vehicleAiBusy = false;
  let vehicleAiTimer = null;
  let lastOcrEvidence = null;
  let photoEvidence = new Map();
  const VEHICLE_CLASSES = new Set(['car', 'truck', 'bus', 'motorcycle']);
  const AI_EMBEDDING_VERSION = 'mobilenet-v2-a050-v1';
  const VEHICLE_AI_INTERVAL = 900;

  const normalize = (s) => (s || '')
    .toUpperCase()
    .replace(/Ä/g, 'A').replace(/Ö/g, 'O').replace(/Ü/g, 'U')
    .replace(/[^A-Z0-9]/g, '');

  const prettyPlate = (s) => {
    const raw = String(s || '').trim().toUpperCase();
    if (/[-\s]/.test(raw)) return raw.replace(/\s+/g, ' ').replace(/\s*-\s*/g, '-');
    return raw || normalize(s);
  };

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const fmt = (n, digits = 1) => Number(n).toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(REF_STORE)) {
          const store = db.createObjectStore(REF_STORE, { keyPath: 'id' });
          store.createIndex('targetNormalized', 'targetNormalized', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  }

  async function dbGetAllRefs() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(REF_STORE, 'readonly');
      const req = tx.objectStore(REF_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbPutRef(ref) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(REF_STORE, 'readwrite');
      tx.objectStore(REF_STORE).put(ref);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbDeleteRef(id) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(REF_STORE, 'readwrite');
      tx.objectStore(REF_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbClearTargetRefs(targetNormalized) {
    const refs = await dbGetAllRefs();
    await Promise.all(refs.filter((r) => r.targetNormalized === targetNormalized).map((r) => dbDeleteRef(r.id)));
  }

  async function dbClearAllRefs() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(REF_STORE, 'readwrite');
      tx.objectStore(REF_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function getTargets() {
    const seen = new Set();
    return (els.targets.value || '')
      .split(/\n|,|;/)
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => ({ raw: prettyPlate(v), normalized: normalize(v) }))
      .filter((v) => v.normalized.length >= 3)
      .filter((v) => {
        if (seen.has(v.normalized)) return false;
        seen.add(v.normalized);
        return true;
      });
  }

  function updatePhotoTargetOptions() {
    const targets = getTargets();
    const current = els.photoTargetSelect.value;
    els.photoTargetSelect.innerHTML = targets.length
      ? targets.map((t) => `<option value="${escapeHtml(t.normalized)}">${escapeHtml(t.raw)}</option>`).join('')
      : '<option value="">Erst Zielkennzeichen eintragen</option>';
    if (targets.some((t) => t.normalized === current)) els.photoTargetSelect.value = current;
  }

  function updateTargetCount() {
    const count = getTargets().length;
    els.targetCount.textContent = `${count} Zielkennzeichen`;
    els.activeTargets.textContent = String(count);
    localStorage.setItem('plateTargets', els.targets.value);
    updatePhotoTargetOptions();
    renderVehicleRefs();
  }

  function bestTargetMatch(raw, targets) {
    let bestOverall = null;
    for (const target of targets) {
      const candidate = bestCandidate(raw, target.normalized);
      const denom = Math.max(target.normalized.length, candidate.value.length || 1);
      const similarity = Math.max(0, Math.round((1 - candidate.distance / denom) * 100));
      const item = { ...candidate, target, similarity };
      if (!bestOverall || item.distance < bestOverall.distance ||
          (item.distance === bestOverall.distance && item.similarity > bestOverall.similarity)) {
        bestOverall = item;
      }
      if (candidate.distance === 0) break;
    }
    return bestOverall;
  }

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

  function showBanner(kind, type, text, duration = 2200) {
    clearTimeout(alertTimer);
    els.alertBanner.hidden = false;
    els.alertBanner.className = `alert-banner ${kind}`;
    els.alertType.textContent = type;
    els.alertText.textContent = text;
    alertTimer = setTimeout(() => {
      els.alertBanner.hidden = true;
      if (running) setStatus('Scan aktiv', 'active');
    }, duration);
  }

  async function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
  }

  async function playBeeps(type = 'hit') {
    await ensureAudio();
    const now = audioCtx.currentTime;
    const scheme = type === 'hint'
      ? { times: [0, 0.28], frequency: 780, length: 0.16, gain: 0.22 }
      : { times: [0, 0.34, 0.68], frequency: 1050, length: 0.22, gain: 0.45 };
    scheme.times.forEach((offset) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type === 'hint' ? 'triangle' : 'square';
      osc.frequency.setValueAtTime(scheme.frequency, now + offset);
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(scheme.gain, now + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + scheme.length);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + offset); osc.stop(now + offset + scheme.length + 0.02);
    });
    if (navigator.vibrate) navigator.vibrate(type === 'hint' ? [150, 80, 150] : [220, 100, 220, 100, 400]);
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
        if (m.status === 'recognizing text' && typeof m.progress === 'number') setStatus(`OCR ${Math.round(m.progress * 100)} %`, 'busy');
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
      if (!silent) els.focusStatus.textContent = 'Kamera-Autofokus aktiv.';
    }
  }

  function configureCameraControls() {
    supportedConstraints = navigator.mediaDevices.getSupportedConstraints ? navigator.mediaDevices.getSupportedConstraints() : {};
    capabilities = {};
    try { capabilities = track && track.getCapabilities ? track.getCapabilities() : {}; } catch (_) { capabilities = {}; }
    const settings = track && track.getSettings ? track.getSettings() : {};
    if (settings.frameRate) els.cameraResolution.textContent = `${els.video.videoWidth || settings.width || '—'} × ${els.video.videoHeight || settings.height || '—'} · ${Math.round(settings.frameRate)} fps`;

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
    els.autoFocus.disabled = !track;
    els.focusStatus.textContent = modes.includes('continuous')
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
        frameRate: { ideal: 60, max: 60 }
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

  function drawCanvasPreview(sourceCanvas) {
    const ctx = els.roiPreview.getContext('2d');
    ctx.clearRect(0, 0, els.roiPreview.width, els.roiPreview.height);
    ctx.drawImage(sourceCanvas, 0, 0, els.roiPreview.width, els.roiPreview.height);
  }

  function cropFrame() {
    const view = getVisibleSourceRect();
    if (!view) return null;
    const r = roiFractions();
    const x = view.x + view.w * r.x;
    const y = view.y + view.h * r.y;
    const w = view.w * r.w;
    const h = view.h * r.h;

    const maxW = 960;
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
    drawCanvasPreview(c);
    return c;
  }

  function setAiStatus(text, kind = '') {
    els.vehicleAiStatus.textContent = text;
    els.vehicleAiStatus.className = `ai-status ${kind}`.trim();
    els.vehicleAiMetric.textContent = text;
  }

  async function ensureVehicleAi() {
    if (mobilenetModel && detectorModel) return;
    if (vehicleAiPromise) return vehicleAiPromise;
    vehicleAiPromise = (async () => {
      if (!window.tf || !window.mobilenet || !window.cocoSsd) {
        throw new Error('KI-Bibliotheken konnten nicht geladen werden. Internetverbindung prüfen.');
      }
      setAiStatus('KI lädt …', 'loading');
      try {
        if (tf.getBackend() !== 'webgl') {
          try { await tf.setBackend('webgl'); } catch (_) {}
        }
        await tf.ready();
        const [mobile, detector] = await Promise.all([
          mobilenet.load({ version: 2, alpha: 0.50 }),
          cocoSsd.load({ base: 'lite_mobilenet_v2' })
        ]);
        mobilenetModel = mobile;
        detectorModel = detector;
        setAiStatus(`Bereit · ${tf.getBackend()}`, 'ready');
        await ensureReferenceEmbeddings();
      } catch (err) {
        console.error('vehicle ai init failed', err);
        setAiStatus('KI konnte nicht geladen werden', 'error');
        vehicleAiPromise = null;
        throw err;
      }
    })();
    return vehicleAiPromise;
  }

  function normalizeEmbedding(values) {
    const arr = Array.from(values || []);
    let norm = 0;
    for (const v of arr) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    return arr.map((v) => v / norm);
  }

  async function getEmbedding(canvasOrImage) {
    if (!mobilenetModel) await ensureVehicleAi();
    const tensor = mobilenetModel.infer(canvasOrImage, true);
    try {
      const values = await tensor.data();
      return normalizeEmbedding(values);
    } finally {
      tensor.dispose();
    }
  }

  function similarityFromEmbeddings(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return Math.round(clamp(dot, 0, 1) * 100);
  }

  function canvasToThumb(canvas) {
    const thumb = document.createElement('canvas');
    thumb.width = 160; thumb.height = 120;
    const ctx = thumb.getContext('2d');
    ctx.fillStyle = '#050607';
    ctx.fillRect(0, 0, thumb.width, thumb.height);
    drawImageCover(ctx, canvas, thumb.width, thumb.height);
    return thumb.toDataURL('image/jpeg', 0.84);
  }

  function drawImageCover(ctx, img, dw, dh) {
    const sw = img.naturalWidth || img.videoWidth || img.width;
    const sh = img.naturalHeight || img.videoHeight || img.height;
    const sourceRatio = sw / sh;
    const destRatio = dw / dh;
    let sx = 0, sy = 0, sWidth = sw, sHeight = sh;
    if (sourceRatio > destRatio) {
      sWidth = sh * destRatio;
      sx = (sw - sWidth) / 2;
    } else {
      sHeight = sw / destRatio;
      sy = (sh - sHeight) / 2;
    }
    ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, dw, dh);
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = (err) => { URL.revokeObjectURL(url); reject(err); };
      img.src = url;
    });
  }

  function loadImageFromDataUrl(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  function predictionArea(pred) {
    return pred.bbox[2] * pred.bbox[3];
  }

  async function cropDetectedVehicle(source, predictions = null) {
    const preds = predictions || await detectorModel.detect(source, 8, 0.42);
    const vehicles = preds
      .filter((p) => VEHICLE_CLASSES.has(p.class) && p.score >= 0.42)
      .sort((a, b) => (predictionArea(b) * b.score) - (predictionArea(a) * a.score));
    const pred = vehicles[0] || null;
    const c = document.createElement('canvas');
    c.width = 320; c.height = 224;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#050607';
    ctx.fillRect(0, 0, c.width, c.height);
    if (!pred) {
      drawImageCover(ctx, source, c.width, c.height);
      return { canvas: c, prediction: null };
    }
    const sw = source.videoWidth || source.naturalWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.height;
    let [x, y, w, h] = pred.bbox;
    const padX = w * 0.09;
    const padY = h * 0.09;
    x = clamp(x - padX, 0, sw - 1);
    y = clamp(y - padY, 0, sh - 1);
    w = clamp(w + padX * 2, 1, sw - x);
    h = clamp(h + padY * 2, 1, sh - y);
    const temp = document.createElement('canvas');
    temp.width = Math.max(2, Math.round(w));
    temp.height = Math.max(2, Math.round(h));
    temp.getContext('2d').drawImage(source, x, y, w, h, 0, 0, temp.width, temp.height);
    drawImageCover(ctx, temp, c.width, c.height);
    return { canvas: c, prediction: pred };
  }

  async function ensureReferenceEmbeddings() {
    if (!mobilenetModel) return;
    let changed = false;
    for (const ref of vehicleRefs) {
      if (ref.embeddingVersion === AI_EMBEDDING_VERSION && Array.isArray(ref.embedding) && ref.embedding.length) continue;
      try {
        const img = await loadImageFromDataUrl(ref.thumb);
        ref.embedding = await getEmbedding(img);
        ref.embeddingVersion = AI_EMBEDDING_VERSION;
        delete ref.feature;
        await dbPutRef(ref);
        changed = true;
      } catch (err) {
        console.warn('reference migration failed', err);
      }
    }
    if (changed) vehicleRefs = await dbGetAllRefs();
  }

  async function addVehiclePhotos(files) {
    const targetNormalized = els.photoTargetSelect.value;
    const targets = getTargets();
    const target = targets.find((t) => t.normalized === targetNormalized);
    if (!target) {
      showError('Bitte zuerst ein Zielkennzeichen auswählen, dem die Fotos zugeordnet werden sollen.');
      return;
    }
    processingPhotoUpload = true;
    clearError();
    setAiStatus('KI lädt für Referenzfotos …', 'loading');
    try {
      await ensureVehicleAi();
      let index = 0;
      for (const file of files) {
        index += 1;
        setAiStatus(`Referenz ${index}/${files.length} wird analysiert …`, 'loading');
        const img = await loadImageFromFile(file);
        const detected = await cropDetectedVehicle(img);
        const embedding = await getEmbedding(detected.canvas);
        const ref = {
          id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          targetNormalized: target.normalized,
          targetRaw: target.raw,
          fileName: file.name,
          thumb: canvasToThumb(detected.canvas),
          embedding,
          embeddingVersion: AI_EMBEDDING_VERSION,
          detectedClass: detected.prediction?.class || null,
          detectedScore: detected.prediction?.score || null
        };
        await dbPutRef(ref);
      }
      vehicleRefs = await dbGetAllRefs();
      setAiStatus(`Bereit · ${tf.getBackend()}`, 'ready');
      renderVehicleRefs();
      if (running && els.vehicleAssistToggle.checked) scheduleVehicleAi(100);
    } catch (err) {
      console.error(err);
      showError('Die Referenzfotos konnten nicht vollständig analysiert werden. ' + (err.message || String(err)));
      setAiStatus('Fotoanalyse fehlgeschlagen', 'error');
    } finally {
      processingPhotoUpload = false;
      els.vehiclePhotoInput.value = '';
    }
  }

  async function renderVehicleRefs() {
    if (processingPhotoUpload) return;
    if (!vehicleRefs.length) vehicleRefs = await dbGetAllRefs();
    const targets = getTargets();
    const targetSet = new Set(targets.map((t) => t.normalized));
    const visibleRefs = vehicleRefs.filter((r) => targetSet.size === 0 || targetSet.has(r.targetNormalized));
    if (!visibleRefs.length) {
      els.vehicleRefsSummary.textContent = 'Noch keine Referenzfotos.';
      els.vehicleRefsGrid.innerHTML = '<div class="empty-log">Noch keine Referenzfotos.</div>';
      return;
    }
    const aiCount = visibleRefs.filter((r) => r.embeddingVersion === AI_EMBEDDING_VERSION && Array.isArray(r.embedding)).length;
    els.vehicleRefsSummary.textContent = `${visibleRefs.length} Referenzfoto(s) · ${aiCount} KI-bereit.`;
    els.vehicleRefsGrid.innerHTML = visibleRefs.map((ref) => `
      <div class="ref-card">
        <img src="${ref.thumb}" alt="${escapeHtml(ref.targetRaw)}" />
        <div class="ref-meta">
          <strong>${escapeHtml(ref.targetRaw)}</strong>
          <span>${escapeHtml(ref.fileName || 'Referenzfoto')}</span>
        </div>
      </div>`).join('');
  }

  function captureAiFrame() {
    const view = getVisibleSourceRect();
    if (!view) return null;
    const maxW = 640;
    const scale = Math.min(1, maxW / view.w);
    const c = els.vehicleCanvas;
    c.width = Math.max(320, Math.round(view.w * scale));
    c.height = Math.max(180, Math.round(view.h * scale));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(els.video, view.x, view.y, view.w, view.h, 0, 0, c.width, c.height);
    return c;
  }

  function cropPrediction(source, pred) {
    const [bx, by, bw, bh] = pred.bbox;
    const padX = bw * 0.08;
    const padY = bh * 0.08;
    const x = clamp(bx - padX, 0, source.width - 1);
    const y = clamp(by - padY, 0, source.height - 1);
    const w = clamp(bw + padX * 2, 1, source.width - x);
    const h = clamp(bh + padY * 2, 1, source.height - y);
    const out = document.createElement('canvas');
    out.width = 320; out.height = 224;
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#050607';
    ctx.fillRect(0, 0, out.width, out.height);
    const temp = document.createElement('canvas');
    temp.width = Math.max(2, Math.round(w));
    temp.height = Math.max(2, Math.round(h));
    temp.getContext('2d').drawImage(source, x, y, w, h, 0, 0, temp.width, temp.height);
    drawImageCover(ctx, temp, out.width, out.height);
    return out;
  }

  function bestReferenceForEmbedding(embedding) {
    let best = null;
    for (const ref of vehicleRefs) {
      if (!Array.isArray(ref.embedding) || ref.embeddingVersion !== AI_EMBEDDING_VERSION) continue;
      const score = similarityFromEmbeddings(embedding, ref.embedding);
      if (!best || score > best.score) best = { score, ref };
    }
    return best;
  }

  function renderVehicleBoxes(predictions, bestIndex = -1) {
    if (!predictions.length) {
      els.vehicleBoxes.innerHTML = '';
      return;
    }
    const sourceW = els.vehicleCanvas.width || 1;
    const sourceH = els.vehicleCanvas.height || 1;
    els.vehicleBoxes.innerHTML = predictions.map((pred, index) => {
      const [x, y, w, h] = pred.bbox;
      const left = clamp(x / sourceW * 100, 0, 100);
      const top = clamp(y / sourceH * 100, 0, 100);
      const width = clamp(w / sourceW * 100, 0, 100 - left);
      const height = clamp(h / sourceH * 100, 0, 100 - top);
      const label = pred.match ? `${pred.class} · ${pred.match.score}% ${prettyPlate(pred.match.ref.targetRaw)}` : `${pred.class} ${Math.round(pred.score * 100)}%`;
      return `<div class="vehicle-box ${index === bestIndex ? 'best' : ''}" style="left:${left}%;top:${top}%;width:${width}%;height:${height}%"><span>${escapeHtml(label)}</span></div>`;
    }).join('');
  }

  function scheduleVehicleAi(delay = VEHICLE_AI_INTERVAL) {
    clearTimeout(vehicleAiTimer);
    if (!running || !els.vehicleAssistToggle.checked || !vehicleRefs.length) return;
    vehicleAiTimer = setTimeout(runVehicleAiOnce, delay);
  }

  async function runVehicleAiOnce() {
    if (!running || !els.vehicleAssistToggle.checked || !vehicleRefs.length || vehicleAiBusy) {
      scheduleVehicleAi();
      return;
    }
    vehicleAiBusy = true;
    try {
      await ensureVehicleAi();
      const frame = captureAiFrame();
      if (!frame) return;
      const detections = (await detectorModel.detect(frame, 8, 0.42))
        .filter((p) => VEHICLE_CLASSES.has(p.class) && p.score >= 0.42)
        .sort((a, b) => (predictionArea(b) * b.score) - (predictionArea(a) * a.score))
        .slice(0, 3);

      let bestLive = null;
      let bestIndex = -1;
      for (let i = 0; i < detections.length; i++) {
        const crop = cropPrediction(frame, detections[i]);
        const embedding = await getEmbedding(crop);
        const match = bestReferenceForEmbedding(embedding);
        detections[i].match = match;
        if (match && (!bestLive || match.score > bestLive.score)) {
          bestLive = { ...match, prediction: detections[i], index: i };
          bestIndex = i;
        }
      }

      renderVehicleBoxes(detections, bestIndex);
      els.vehicleAiMetric.textContent = detections.length ? `${detections.length} Fahrzeug(e)` : 'kein Fahrzeug';
      els.vehicleScore.textContent = bestLive ? `${bestLive.score} % · ${prettyPlate(bestLive.ref.targetRaw)}` : '—';
      if (bestLive) await evaluatePhotoEvidence(bestLive);
    } catch (err) {
      console.warn('vehicle ai iteration failed', err);
      setAiStatus('KI-Scan pausiert', 'error');
    } finally {
      vehicleAiBusy = false;
      if (running) scheduleVehicleAi();
    }
  }

  async function evaluatePhotoEvidence(bestLive) {
    const threshold = Number(els.vehicleThreshold.value || 78);
    if (bestLive.score < threshold) return;
    const target = bestLive.ref.targetNormalized;
    const now = Date.now();
    const previous = photoEvidence.get(target);
    const count = previous && now - previous.time < 2600 ? previous.count + 1 : 1;
    photoEvidence.set(target, { count, time: now, score: bestLive.score });

    const ocrSupport = lastOcrEvidence &&
      now - lastOcrEvidence.time < 3200 &&
      lastOcrEvidence.targetNormalized === target &&
      lastOcrEvidence.similarity >= 45;

    const stablePhoto = count >= 2 && bestLive.score >= threshold;
    const strongPhoto = count >= 2 && bestLive.score >= threshold + 6;
    if (!(ocrSupport && stablePhoto) && !strongPhoto) return;

    if (now - (lastHintAt.get(target) || 0) <= 6500) return;
    lastHintAt.set(target, now);
    photoEvidence.set(target, { count: 0, time: now, score: bestLive.score });
    await registerEvent('hint', bestLive.ref.targetRaw, {
      recognized: ocrSupport ? lastOcrEvidence.value : '',
      score: bestLive.score,
      message: ocrSupport ? 'KI-Foto + OCR stimmen überein' : 'KI-Foto wiederholt sehr ähnlich'
    });
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
    if (!running || !track || event.target.closest('.alert-banner')) return;
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
      els.focusStatus.textContent = 'Manueller Fokus wurde von Safari nicht übernommen.';
    }
  }

  function scheduleNextScan(previousDuration = 0) {
    if (!running) return;
    const minInterval = Math.max(0, Number(els.interval.value) || 0);
    const wait = Math.max(0, minInterval - previousDuration);
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      if (!running) return;
      const run = () => scanOnce();
      if ('requestVideoFrameCallback' in HTMLVideoElement.prototype && els.video.requestVideoFrameCallback) {
        videoFrameRequest = els.video.requestVideoFrameCallback(() => run());
      } else {
        run();
      }
    }, wait);
  }

  async function scanOnce() {
    if (!running || busy || !worker) return;
    busy = true;
    const started = performance.now();
    const previousScanStartedAt = lastScanStartedAt;
    lastScanStartedAt = started;
    try {
      const frame = cropFrame();
      if (!frame) return;

      const result = await worker.recognize(frame);
      const duration = performance.now() - started;
      scans += 1;
      els.scanCount.textContent = String(scans);
      els.ocrTime.textContent = `${Math.round(duration)} ms`;
      const cycleMs = previousScanStartedAt > 0 ? started - previousScanStartedAt : duration;
      const instRate = cycleMs > 0 ? 1000 / cycleMs : 0;
      scanRateEma = scanRateEma ? scanRateEma * 0.75 + instRate * 0.25 : instRate;
      els.effectiveRate.textContent = `${scanRateEma.toFixed(1).replace('.', ',')} /s`;

      const targets = getTargets();
      els.activeTargets.textContent = String(targets.length);
      if (!targets.length) {
        els.lastOcr.textContent = '—';
        els.closestTarget.textContent = 'Keine Ziele';
        els.similarity.textContent = '—';
        lastOcrEvidence = null;
        return;
      }

      const best = bestTargetMatch(result.data.text, targets);
      els.lastOcr.textContent = best?.value || '—';
      els.closestTarget.textContent = best ? prettyPlate(best.target.raw) : '—';
      els.similarity.textContent = best ? `${best.similarity} %` : '—';
      lastOcrEvidence = best ? {
        targetNormalized: best.target.normalized,
        targetRaw: best.target.raw,
        similarity: best.similarity,
        value: best.value || '',
        distance: best.distance,
        time: Date.now()
      } : null;

      const allowed = els.tolerant.checked ? 1 : 0;
      if (best && best.value && best.distance <= allowed) {
        const key = best.target.normalized;
        const now = Date.now();
        if (now - (lastHitAt.get(key) || 0) > 5000) {
          lastHitAt.set(key, now);
          const livePhoto = vehicleRefs.length && els.vehicleAssistToggle.checked
            ? photoEvidence.get(key)?.score ?? null
            : null;
          await registerEvent('hit', best.target.raw, { recognized: best.value, score: livePhoto });
        }
      }
      if (running) setStatus('Scan aktiv', 'active');
    } catch (err) {
      console.error(err);
      setStatus('OCR-Fehler', 'idle');
    } finally {
      const elapsed = performance.now() - started;
      busy = false;
      if (running && worker) scheduleNextScan(elapsed);
    }
  }

  async function registerEvent(kind, targetRaw, meta = {}) {
    const plate = prettyPlate(targetRaw);
    if (kind === 'hit') {
      hits += 1;
      els.hitCount.textContent = String(hits);
      setStatus('TREFFER', 'hit');
      showBanner('hit', 'TREFFER', plate, 2600);
      await playBeeps('hit');
    } else {
      hints += 1;
      els.hintCount.textContent = String(hints);
      setStatus('Hinweis', 'warn');
      const hintText = meta.message ? `${plate} · ${meta.message}` : plate;
      showBanner('warn', 'HINWEIS', hintText, 2200);
      await playBeeps('hint');
    }

    const entry = {
      kind,
      plate,
      recognized: meta.recognized || '',
      score: meta.score ?? null,
      message: meta.message || '',
      time: new Date().toISOString()
    };
    const log = JSON.parse(localStorage.getItem('plateEventLog') || '[]');
    log.unshift(entry);
    localStorage.setItem('plateEventLog', JSON.stringify(log.slice(0, 40)));
    renderLog();
  }

  function renderLog() {
    const log = JSON.parse(localStorage.getItem('plateEventLog') || '[]');
    if (!log.length) {
      els.hitLog.innerHTML = '<div class="empty-log">Noch keine Treffer oder Hinweise.</div>';
      return;
    }
    els.hitLog.innerHTML = log.map((e) => {
      const d = new Date(e.time);
      const secondary = [
        e.recognized ? `OCR: ${escapeHtml(e.recognized)}` : '',
        Number.isFinite(e.score) ? `Foto: ${e.score} %` : '',
        e.message ? escapeHtml(e.message) : ''
      ].filter(Boolean).join(' · ');
      return `<div class="log-entry">
        <div class="log-head">
          <div><span class="kind ${e.kind === 'hit' ? 'hit' : 'hint'}">${e.kind === 'hit' ? 'TREFFER' : 'HINWEIS'}</span></div>
          <strong>${escapeHtml(e.plate)}</strong>
          ${secondary ? `<span>${secondary}</span>` : ''}
        </div>
        <span>${d.toLocaleDateString('de-DE')} · ${d.toLocaleTimeString('de-DE', {hour:'2-digit', minute:'2-digit', second:'2-digit'})}</span>
      </div>`;
    }).join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  }

  async function start() {
    if (running) return;
    clearError();
    lastScanStartedAt = 0;
    scanRateEma = 0;
    els.effectiveRate.textContent = '—';
    els.ocrTime.textContent = '—';
    els.start.disabled = true;
    setStatus('Kamera startet …', 'busy');

    try {
      if (!window.isSecureContext) throw new Error('Die Seite läuft nicht in einem sicheren HTTPS-Kontext. Öffne die GitHub-Pages-Adresse direkt in Safari.');
      await ensureAudio();
      await startCamera();

      running = true;
      els.stop.disabled = false;
      els.targets.disabled = true;
      els.photoTargetSelect.disabled = true;
      els.vehiclePhotoInput.disabled = true;
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
      scheduleNextScan(0);
      if (els.vehicleAssistToggle.checked && vehicleRefs.length) {
        ensureVehicleAi().then(() => scheduleVehicleAi(100)).catch((err) => console.warn(err));
      }
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
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    if (videoFrameRequest !== null && els.video.cancelVideoFrameCallback) { try { els.video.cancelVideoFrameCallback(videoFrameRequest); } catch (_) {} }
    videoFrameRequest = null;
    clearTimeout(zoomApplyTimer);
    clearTimeout(focusRingTimer);
    clearTimeout(alertTimer);
    clearTimeout(vehicleAiTimer);
    vehicleAiTimer = null;
    vehicleAiBusy = false;
    photoEvidence.clear();
    lastOcrEvidence = null;
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
    els.alertBanner.hidden = true;
    els.vehicleBoxes.innerHTML = '';
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
    els.targets.disabled = false;
    els.photoTargetSelect.disabled = false;
    els.vehiclePhotoInput.disabled = false;
    await releaseWakeLock();
    setStatus('Bereit', 'idle');
  }

  els.start.addEventListener('click', start);
  els.stop.addEventListener('click', stop);
  els.testAlarm.addEventListener('click', async () => {
    const target = getTargets()[0]?.raw || 'TEST';
    showBanner('hit', 'TREFFER', prettyPlate(target), 1800);
    await playBeeps('hit');
  });
  els.clearLog.addEventListener('click', () => {
    localStorage.removeItem('plateEventLog');
    renderLog();
  });
  els.targets.addEventListener('input', updateTargetCount);
  els.interval.addEventListener('change', () => { if (running && !busy) scheduleNextScan(0); });
  els.roiMode.addEventListener('change', updateRoiFrame);
  els.vehicleAssistToggle.addEventListener('change', () => {
    if (!running) return;
    if (els.vehicleAssistToggle.checked && vehicleRefs.length) {
      ensureVehicleAi().then(() => scheduleVehicleAi(100)).catch((err) => console.warn(err));
    } else {
      clearTimeout(vehicleAiTimer);
      els.vehicleBoxes.innerHTML = '';
      els.vehicleScore.textContent = '—';
      els.vehicleAiMetric.textContent = 'pausiert';
    }
  });
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
  els.focus.addEventListener('input', () => { els.focusValue.textContent = fmt(Number(els.focus.value), 2); });
  els.focus.addEventListener('change', () => setManualFocus(els.focus.value));
  els.video.addEventListener('loadedmetadata', updateStageRatio);
  els.video.addEventListener('resize', updateStageRatio);
  els.vehiclePhotoInput.addEventListener('change', async (event) => {
    const files = [...(event.target.files || [])];
    if (files.length) await addVehiclePhotos(files);
  });
  els.clearTargetRefsBtn.addEventListener('click', async () => {
    const target = els.photoTargetSelect.value;
    if (!target) return;
    await dbClearTargetRefs(target);
    vehicleRefs = await dbGetAllRefs();
    renderVehicleRefs();
  });
  els.clearAllRefsBtn.addEventListener('click', async () => {
    await dbClearAllRefs();
    vehicleRefs = [];
    renderVehicleRefs();
  });

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && running && els.wake.checked) await requestWakeLock();
  });
  window.addEventListener('pagehide', stop);

  async function init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('service worker', err));
    }
    const savedTargets = localStorage.getItem('plateTargets');
    if (savedTargets && savedTargets.trim()) els.targets.value = savedTargets;
    vehicleRefs = await dbGetAllRefs().catch(() => []);
    if (vehicleRefs.length && els.vehicleAssistToggle.checked) setAiStatus('KI wird beim Scanstart geladen.');
    else setAiStatus('KI-Fahrzeugerkennung wird bei Bedarf geladen.');
    updateTargetCount();
    updateRoiFrame();
    renderLog();
    renderVehicleRefs();
  }

  init();
})();
