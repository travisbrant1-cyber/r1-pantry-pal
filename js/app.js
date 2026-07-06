(function () {
  'use strict';

  var STORAGE_KEY = 'pantry_pal_inventory';
  var VISION_TIMEOUT_MS = 12000;

  // ---- Elements ----
  var statusDot = document.getElementById('statusDot');
  var savedToast = document.getElementById('savedToast');

  var homeView = document.getElementById('homeView');
  var scanView = document.getElementById('scanView');
  var lookupView = document.getElementById('lookupView');
  var itemCardView = document.getElementById('itemCardView');
  var recoveryView = document.getElementById('recoveryView');
  var statusView = document.getElementById('statusView');
  var manualView = document.getElementById('manualView');
  var browseView = document.getElementById('browseView');
  var detailView = document.getElementById('detailView');
  var diagView = document.getElementById('diagView');
  var barcodeView = document.getElementById('barcodeView');
  var VIEWS = {
    home: homeView, scan: scanView, lookup: lookupView, itemCard: itemCardView,
    recovery: recoveryView, status: statusView, manual: manualView,
    browse: browseView, detail: detailView, diag: diagView, barcode: barcodeView
  };

  var camPreview = document.getElementById('camPreview');
  var camFallback = document.getElementById('camFallback');
  var viewfinderLine = document.getElementById('viewfinderLine');
  var fileInput = document.getElementById('fileInput');
  var scanStatus = document.getElementById('scanStatus');
  var scanDebug = document.getElementById('scanDebug');

  var itemHeading = document.getElementById('itemHeading');
  var itemPhoto = document.getElementById('itemPhoto');
  var itemName = document.getElementById('itemName');
  var itemBrand = document.getElementById('itemBrand');
  var qtyValue = document.getElementById('qtyValue');
  var itemLocation = document.getElementById('itemLocation');
  var itemSaveBtn = document.getElementById('itemSaveBtn');
  var itemHint = document.getElementById('itemHint');

  var recoveryPhoto = document.getElementById('recoveryPhoto');
  var recoveryDebug = document.getElementById('recoveryDebug');
  var recoveryMenu = document.getElementById('recoveryMenu');

  var statusText = document.getElementById('statusText');
  var statusHint = document.getElementById('statusHint');

  var manualHeading = document.getElementById('manualHeading');
  var manualName = document.getElementById('manualName');
  var manualQtyValue = document.getElementById('manualQtyValue');
  var manualSaveBtn = document.getElementById('manualSaveBtn');

  var barcodeInput = document.getElementById('barcodeInput');
  var barcodeKeypad = document.getElementById('barcodeKeypad');

  var inventoryList = document.getElementById('inventoryList');
  var browseEmptyHint = document.getElementById('browseEmptyHint');

  var detailName = document.getElementById('detailName');
  var detailRows = document.getElementById('detailRows');
  var detailDeleteBtn = document.getElementById('detailDeleteBtn');

  var diagRows = document.getElementById('diagRows');

  // ---- State ----
  var currentView = 'home';
  var homeIndex = 0;
  var HOME_ACTIONS = ['scan', 'browse', 'manual', 'diag'];

  var inventory = [];
  var videoActive = false;
  var cameraUnavailable = false;

  var pendingItem = null;   // item being built/edited
  var itemCardMode = 'new'; // 'new' | 'existing'
  var itemCardOriginalQty = 0;
  var capturedPhotoDataUrl = null;
  var lastCaptureCanvas = null;

  var recoveryIndex = 0;
  var RECOVERY_ACTIONS = ['vision', 'voice', 'barcode', 'manual'];

  var browseIndex = 0;
  var detailQty = 0;

  var usingRealStorage = typeof window.creationStorage !== 'undefined';
  var visionTimeoutHandle = null;
  var speechRecognizer = null;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ---- Quantity helpers: whole-number stepping stays fast (1 click = 1 unit)
  // for the common countable case (cans, boxes); a per-field fraction mode,
  // toggled by tapping the quantity, steps in quarters for bulk/unitless
  // goods (flour, rice) where "how much is left" is the natural unit. ----
  var FRACTION_LABELS = { 0: '0', 0.25: '1/4', 0.5: '1/2', 0.75: '3/4', 1: '1' };
  function formatQty(q, isFraction) {
    if (isFraction && FRACTION_LABELS[q] !== undefined) return FRACTION_LABELS[q];
    return String(q);
  }
  function stepWhole(current, dir) { return clamp(current + dir, 0, 999); }
  function stepFraction(current, dir) { return clamp(Math.round((current + dir * 0.25) * 4) / 4, 0, 1); }

  // ---- Storage ----
  function storageGet(key) {
    if (usingRealStorage) return window.creationStorage.plain.getItem(key);
    return Promise.resolve(localStorage.getItem(key));
  }
  function storageSet(key, value) {
    if (usingRealStorage) return window.creationStorage.plain.setItem(key, value);
    localStorage.setItem(key, value);
    return Promise.resolve();
  }

  function loadInventory() {
    return storageGet(STORAGE_KEY).then(function (raw) {
      if (!raw) { inventory = []; return inventory; }
      try { inventory = JSON.parse(atob(raw)); } catch (e) { inventory = []; }
      return inventory;
    });
  }

  function saveInventoryToDisk() {
    return storageSet(STORAGE_KEY, btoa(JSON.stringify(inventory)));
  }

  function findByBarcode(barcode) {
    if (!barcode) return null;
    for (var i = 0; i < inventory.length; i++) {
      if (inventory[i].barcode === barcode) return inventory[i];
    }
    return null;
  }

  function upsertItem(item) {
    var idx = inventory.findIndex(function (it) { return it.id === item.id; });
    item.lastUpdated = new Date().toISOString().slice(0, 10);
    if (idx === -1) inventory.unshift(item);
    else inventory[idx] = item;
    return saveInventoryToDisk();
  }

  function deleteItemById(id) {
    inventory = inventory.filter(function (it) { return it.id !== id; });
    return saveInventoryToDisk();
  }

  // ---- View switching ----
  function showView(name) {
    currentView = name;
    Object.keys(VIEWS).forEach(function (key) {
      VIEWS[key].classList.toggle('active', key === name);
    });
    if (name === 'scan') startFocusLoop(); else stopFocusLoop();
  }

  // ---- Home menu ----
  function renderHome() {
    var items = homeView.querySelectorAll('.menu-item');
    for (var i = 0; i < items.length; i++) items[i].classList.toggle('selected', i === homeIndex);
  }
  homeView.querySelectorAll('.menu-item').forEach(function (el, i) {
    el.addEventListener('click', function () { homeIndex = i; renderHome(); runHomeAction(); });
  });

  function runHomeAction() {
    var action = HOME_ACTIONS[homeIndex];
    if (action === 'scan') enterScan();
    else if (action === 'browse') enterBrowse();
    else if (action === 'manual') enterManualFromHome();
    else if (action === 'diag') enterDiag();
  }

  function enterManualFromHome() {
    pendingItem = { id: 'manual-' + Date.now(), barcode: null, productName: '', brand: '', quantity: 1, location: 'Pantry', image: null, source: 'manual' };
    manualHeading.textContent = 'Manual entry';
    enterManual(false);
  }

  // ---- Diagnostics ----
  // Isolates whether plain Web Workers and WebAssembly actually work on this
  // device at all, independent of Tesseract's ~8MB payload - added after OCR
  // fallback hung indefinitely on real hardware (never resolved or rejected)
  // to find out which specific primitive (Worker spawn, WASM instantiate,
  // or WASM *inside* a Worker - which is what Tesseract does) is the culprit.
  var DIAG_TEST_TIMEOUT_MS = 6000;
  var EMPTY_WASM_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  var diagLines = [];

  function renderDiag() {
    diagRows.textContent = diagLines.join('\n');
  }

  function setDiagLine(index, text) {
    diagLines[index] = text;
    renderDiag();
  }

  function diagWithTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('timed out after ' + Math.round(ms / 1000) + 's'));
      }, ms);
      promise.then(function (v) {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(v);
      }, function (err) {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(err);
      });
    });
  }

  function testWorkerBasic() {
    return new Promise(function (resolve, reject) {
      var src = 'onmessage = function (e) { postMessage(e.data + 1); };';
      var blobUrl = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
      var w = new Worker(blobUrl);
      w.onmessage = function (e) {
        w.terminate();
        URL.revokeObjectURL(blobUrl);
        if (e.data === 43) resolve('ok'); else reject(new Error('unexpected reply: ' + e.data));
      };
      w.onerror = function (e) {
        w.terminate();
        URL.revokeObjectURL(blobUrl);
        reject(new Error(e.message || 'worker error'));
      };
      w.postMessage(42);
    });
  }

  function testWasmBasic() {
    if (!window.WebAssembly) return Promise.reject(new Error('WebAssembly unsupported'));
    return WebAssembly.instantiate(EMPTY_WASM_MODULE).then(function () { return 'ok'; });
  }

  function testWasmInWorker() {
    return new Promise(function (resolve, reject) {
      if (!window.Worker) { reject(new Error('Worker unsupported')); return; }
      var src = [
        'onmessage = function () {',
        '  if (!self.WebAssembly) { postMessage({ ok: false, error: "no WebAssembly in worker" }); return; }',
        '  WebAssembly.instantiate(new Uint8Array([0,97,115,109,1,0,0,0]))',
        '    .then(function () { postMessage({ ok: true }); })',
        '    .catch(function (err) { postMessage({ ok: false, error: String(err) }); });',
        '};'
      ].join('\n');
      var blobUrl = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
      var w = new Worker(blobUrl);
      w.onmessage = function (e) {
        w.terminate();
        URL.revokeObjectURL(blobUrl);
        if (e.data && e.data.ok) resolve('ok'); else reject(new Error((e.data && e.data.error) || 'unknown failure'));
      };
      w.onerror = function (e) {
        w.terminate();
        URL.revokeObjectURL(blobUrl);
        reject(new Error(e.message || 'worker error'));
      };
      w.postMessage('go');
    });
  }

  function runDiagTest(index, label, fn) {
    setDiagLine(index, label + ': running…');
    return diagWithTimeout(fn(), DIAG_TEST_TIMEOUT_MS).then(function () {
      setDiagLine(index, label + ': ok');
    }, function (err) {
      setDiagLine(index, label + ': FAIL - ' + ((err && err.message) || err));
    });
  }

  // Unlike the synthetic tests above, this exercises the real Tesseract
  // worker and streams its own reported init stage/progress into the same
  // line live - so if it hangs, we see exactly which stage it hung on
  // (fetching the wasm core, fetching/decompressing the language data,
  // initializing the API) instead of just an eventual timeout.
  function runDiagOcrTest(index) {
    var label = 'Tesseract worker init (real)';
    setDiagLine(index, label + ': running…');
    var testPromise = getOcrWorker(function (m) {
      setDiagLine(index, label + ': ' + formatOcrProgress(m));
    });
    return diagWithTimeout(testPromise, 30000).then(function () {
      setDiagLine(index, label + ': ok');
    }, function (err) {
      setDiagLine(index, label + ': FAIL - ' + ((err && err.message) || err));
    });
  }

  // Diagnostics test 4 only proves the worker/wasm/language-data *init* is
  // fast - it never calls recognize(). The real OCR fallback runs recognize()
  // against the camera's full native resolution (e.g. 1080x1920, ~2MP),
  // which is a lot of pixels for a non-SIMD WASM OCR engine on a
  // resource-constrained device CPU - this measures how long recognize()
  // itself actually takes on a same-size synthetic image, to tell "hanging"
  // apart from "just slower than the timeout allows."
  function runDiagOcrRecognizeTest(index) {
    var label = 'Tesseract recognize (2MP)';
    setDiagLine(index, label + ': running…');
    var c = document.createElement('canvas');
    c.width = 1080; c.height = 1920;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#000'; ctx.font = '120px sans-serif';
    ctx.fillText('012345678905', 40, 1000);
    var start = Date.now();
    var testPromise = getOcrWorker(function (m) {
      setDiagLine(index, label + ': ' + formatOcrProgress(m));
    }).then(function (worker) { return worker.recognize(c); });
    return diagWithTimeout(testPromise, 60000).then(function () {
      setDiagLine(index, label + ': ok, ' + (Date.now() - start) + 'ms');
    }, function (err) {
      setDiagLine(index, label + ': FAIL after ' + (Date.now() - start) + 'ms - ' + ((err && err.message) || err));
    });
  }

  function enterDiag() {
    showView('diag');
    diagLines = [];
    renderDiag();
    runDiagTest(0, 'Worker (basic)', testWorkerBasic)
      .then(function () { return runDiagTest(1, 'WebAssembly (main thread)', testWasmBasic); })
      .then(function () { return runDiagTest(2, 'WebAssembly (inside Worker)', testWasmInWorker); })
      .then(function () { return runDiagOcrTest(3); })
      .then(function () { return runDiagOcrRecognizeTest(4); });
  }

  // ---- Camera / scanning ----
  // Scanning is deliberate and one-shot: aim the camera, then click PTT (or
  // tap the frame) to capture a single still and decode that - rather than
  // continuously decoding live video. A continuous background decode loop
  // depends on the WebView's frame-grab timing working a particular way,
  // which is exactly the kind of thing that already broke once; a capture-
  // then-decode model is simpler, more predictable, and mirrors the already-
  // proven Color Picker capture flow.
  function initCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCamFallback();
      return;
    }
    navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        advanced: [{ focusMode: 'continuous' }]
      },
      audio: false
    })
      .then(function (stream) {
        camPreview.srcObject = stream;
        camPreview.classList.add('active');
        camFallback.style.display = 'none';
        videoActive = true;
        cameraUnavailable = false;
        statusDot.classList.add('live');
        if (currentView === 'scan') scanStatus.textContent = 'Hold ~1-2ft back, click PTT';
        camPreview.addEventListener('loadedmetadata', function () {
          scanDebug.textContent = 'cam ' + camPreview.videoWidth + 'x' + camPreview.videoHeight;
        }, { once: true });
      })
      .catch(function () {
        showCamFallback();
      });
  }

  function showCamFallback() {
    videoActive = false;
    cameraUnavailable = true;
    camFallback.style.display = 'block';
    statusDot.classList.add('sim');
    if (currentView === 'scan') scanStatus.textContent = 'Tap the frame to choose a photo';
  }

  function enterScan() {
    showView('scan');
    if (videoActive) scanStatus.textContent = 'Hold ~1-2ft back, click PTT';
    else if (cameraUnavailable) scanStatus.textContent = 'Tap the frame to choose a photo';
    else scanStatus.textContent = 'Starting camera…';
  }

  // Barcode decoding needs the camera's native resolution - a barcode's fine
  // bar spacing is destroyed by downsampling to a small fixed size. A
  // separate small thumbnail (for the item photo shown in the UI) is cropped
  // from the same full-resolution frame afterwards.
  //
  // Fit "contain" (preserve aspect ratio, letterbox) rather than stretching
  // to fill 160x120 - a real captured photo is rarely 4:3, and forcing it
  // into that box distorted every stored/displayed thumbnail app-wide.
  // Confirmed as a real, visible bug from a user-reported screenshot: the
  // recovery-screen preview looked like an oddly squished wide strip.
  function makeThumbnail(source, sw, sh) {
    var t = document.createElement('canvas');
    t.width = 160; t.height = 120;
    var ctx = t.getContext('2d');
    ctx.fillStyle = '#150f0d';
    ctx.fillRect(0, 0, t.width, t.height);
    var scale = Math.min(t.width / sw, t.height / sh);
    var dw = sw * scale, dh = sh * scale;
    var dx = (t.width - dw) / 2, dy = (t.height - dh) / 2;
    ctx.drawImage(source, 0, 0, sw, sh, dx, dy, dw, dh);
    return t.toDataURL('image/jpeg', 0.6);
  }

  function grabFrame() {
    var vw = camPreview.videoWidth || 640;
    var vh = camPreview.videoHeight || 480;
    var c = document.createElement('canvas');
    c.width = vw; c.height = vh;
    c.getContext('2d').drawImage(camPreview, 0, 0, vw, vh);
    return c;
  }

  // A real captured frame confirmed the actual problem behind "OCR barely
  // reads anything" (not garbled digits, just near-empty output): the
  // barcode was only a small strip within a much larger photo of the
  // whole package, so it had little effective resolution relative to the
  // full frame - true regardless of device/camera quality. The on-screen
  // viewfinder line was purely decorative up to now (an aiming hint with
  // no actual effect on capture) - this crops the captured frame to a band
  // around it before barcode OCR, so whatever the user aimed at the line
  // fills much more of what actually gets analyzed. Uses camPreview's own
  // live layout size (not a hardcoded constant) to replicate the same
  // object-fit:cover crop the visible preview already does, so the region
  // analyzed matches what was actually visible on screen.
  function cropToViewfinderBand(canvas) {
    var containerW = camPreview.offsetWidth || canvas.width;
    var containerH = camPreview.offsetHeight || canvas.height;
    var scale = Math.max(containerW / canvas.width, containerH / canvas.height);
    var visibleW = containerW / scale;
    var visibleH = containerH / scale;
    var offsetX = (canvas.width - visibleW) / 2;
    var offsetY = (canvas.height - visibleH) / 2;

    var bandHeightFrac = 0.34;
    var cropX = offsetX + visibleW * 0.08;
    var cropW = visibleW * 0.84;
    var cropY = offsetY + visibleH * (0.5 - bandHeightFrac / 2);
    var cropH = visibleH * bandHeightFrac;

    var out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(cropW));
    out.height = Math.max(1, Math.round(cropH));
    out.getContext('2d').drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, out.width, out.height);
    return out;
  }

  // ---- Live focus/framing indicator ----
  // A real product was correctly identified, but only at one specific
  // distance found by trial and error - each attempt costs a several-
  // second OCR round trip, so blind guess-and-check is slow. This gives
  // continuous feedback on the *live* video, before capture, by scoring
  // edge/detail energy in the same region cropToViewfinderBand() will
  // actually analyze - a small, blurry, or poorly-framed barcode has much
  // less fine detail than a sharp, well-filled one. Colors the viewfinder
  // line red-to-green using a running best-seen-this-session score as the
  // reference, rather than a hardcoded absolute threshold (which nobody
  // could calibrate without real hardware in hand) - so it behaves like a
  // "hot/cold" indicator: green means "as good as it's gotten so far",
  // not "definitely readable."
  function computeSharpnessScore(imageData) {
    var d = imageData.data, w = imageData.width, h = imageData.height;
    var gray = new Float32Array(w * h);
    for (var i = 0, p = 0; i < d.length; i += 4, p++) {
      gray[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    }
    var sum = 0;
    for (var y = 1; y < h; y++) {
      for (var x = 1; x < w; x++) {
        var idx = y * w + x;
        sum += Math.abs(gray[idx] - gray[idx - 1]) + Math.abs(gray[idx] - gray[idx - w]);
      }
    }
    return sum / (w * h);
  }

  function measureLiveFocusScore() {
    var vw = camPreview.videoWidth, vh = camPreview.videoHeight;
    if (!vw || !vh) return null;
    var smallW = 200;
    var small = document.createElement('canvas');
    small.width = smallW;
    small.height = Math.max(1, Math.round(smallW * vh / vw));
    small.getContext('2d').drawImage(camPreview, 0, 0, small.width, small.height);
    var band = cropToViewfinderBand(small);
    var ctx = band.getContext('2d');
    return computeSharpnessScore(ctx.getImageData(0, 0, band.width, band.height));
  }

  var FOCUS_CHECK_MS = 250;
  var focusLoopHandle = null;
  var bestFocusScoreSeen = 0;

  function startFocusLoop() {
    stopFocusLoop();
    bestFocusScoreSeen = 0;
    focusLoopHandle = setInterval(function () {
      if (currentView !== 'scan' || !videoActive) return;
      var score = measureLiveFocusScore();
      if (score === null) return;
      if (score > bestFocusScoreSeen) bestFocusScoreSeen = score;
      var ratio = bestFocusScoreSeen > 0 ? Math.min(1, score / bestFocusScoreSeen) : 0;
      viewfinderLine.style.background = 'hsl(' + Math.round(ratio * 120) + ', 75%, 50%)';
    }, FOCUS_CHECK_MS);
  }

  function stopFocusLoop() {
    clearInterval(focusLoopHandle);
    focusLoopHandle = null;
  }

  // The physical PTT click jostles the device right as the frame is
  // grabbed, so a lone snapshot straight off the click is often
  // motion-blurred - a short settle delay gives that a moment to pass
  // before the still is captured.
  var CAPTURE_SETTLE_MS = 300;

  // Bar decoding needs far more resolution per barcode module than this
  // camera's fixed focus can reliably deliver, even at the correct
  // distance (see HANDOFF.md) - real-hardware testing kept failing to read
  // bars at all, so scanning goes straight to the printed digit line
  // instead of spending time on bar-decode attempts first.
  function attemptCapture() {
    if (cameraUnavailable) { fileInput.click(); return; }
    if (!videoActive) { scanStatus.textContent = 'Camera still starting…'; return; }

    scanStatus.textContent = 'Hold steady…';
    setTimeout(function () {
      var c = grabFrame();
      lastCaptureCanvas = c;
      capturedPhotoDataUrl = makeThumbnail(c, c.width, c.height);

      // Leave the live camera view as soon as the still is captured - OCR
      // takes a few seconds, and staying on the live feed makes it look
      // like the device still needs to be held steady when the frame is
      // already locked in.
      statusText.textContent = 'Reading barcode…';
      statusHint.textContent = 'Hold PTT to cancel';
      showView('status');

      var reportProgress = function (m) {
        var line = formatOcrProgress(m);
        statusHint.textContent = line || 'Hold PTT to cancel';
        scanDebug.textContent = 'ocr: ' + line;
      };

      // Try the viewfinder-cropped band first (usually a much easier read
      // if aimed well), but fall back to the full frame if that misses -
      // aiming isn't always perfect, and this way cropping can only help,
      // never make a previously-working scan fail.
      identifyFromCanvas(cropToViewfinderBand(c), reportProgress)
        .catch(function () { return identifyFromCanvas(c, reportProgress); })
        .then(function (barcode) {
          if (currentView !== 'status') return;
          onBarcodeReady(barcode);
        })
        .catch(function () {
          if (currentView !== 'status') return;
          onBarcodeReady(null);
        });
    }, CAPTURE_SETTLE_MS);
  }

  // Barcode OCR first (fast, deterministic, cache-friendly); if that finds
  // no valid code, fall back to reading the brand/product name text - a
  // barcode misread is common on small print, but the product name is
  // often printed much larger and may still be legible.
  function identifyFromCanvas(canvas, onProgress) {
    lastOcrDebug = '';
    lastNameOcrDebug = '';
    lastOcrAnalyzedCanvas = null;
    return attemptOcrFallback(canvas, onProgress);
  }

  // Product-name OCR used to run automatically the moment barcode OCR
  // failed, and would jump straight to "Verify OCR guess" the instant it
  // found any text with a couple of letters in it - including garbled
  // nonsense misread from elsewhere in the frame. That silently hijacked
  // the flow before the user ever saw the recovery menu (so "Enter
  // barcode" was unreachable whenever a bogus guess happened to match).
  // Now it only runs quietly in the background once the recovery menu is
  // already showing, and only ever affects "Manual entry"'s pre-fill if
  // the user actually picks that option - it can never navigate on its own.
  var pendingNameGuess = null;

  function tryBackgroundNameGuess(canvas) {
    pendingNameGuess = null;
    attemptProductNameOcr(canvas).then(function (query) {
      pendingNameGuess = query;
    }).catch(function () {});
  }

  // ---- OCR fallback: read the printed digit line under the bars ----
  // The bars themselves need enough resolution to resolve narrow modules;
  // the human-readable digits printed under them are much larger and may
  // stay legible even when the bars don't, especially at this camera's
  // longer-than-usual fixed focus distance. Tesseract is loaded lazily
  // (only once bar decoding has already failed) since it's an ~8MB vendored
  // dependency - not something to pay for on every successful scan.
  var TESSERACT_BASE = 'js/vendor/tesseract/';
  var tesseractScriptPromise = null;
  var ocrWorkerPromise = null;

  // importScripts inside the worker requires an absolute URL - a relative
  // one fails there even though it works fine for a normal <script src>,
  // and it must be resolved against this page's own URL (not site root)
  // so it still works when deployed under a GitHub Pages subpath.
  function absoluteUrl(path) {
    return new URL(path, window.location.href).href;
  }

  function loadTesseractScript() {
    if (tesseractScriptPromise) return tesseractScriptPromise;
    tesseractScriptPromise = new Promise(function (resolve, reject) {
      if (window.Tesseract) { resolve(); return; }
      var s = document.createElement('script');
      s.src = TESSERACT_BASE + 'tesseract.min.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('failed to load tesseract.min.js')); };
      document.head.appendChild(s);
    });
    return tesseractScriptPromise;
  }

  // Tesseract reports its own stages (fetching/instantiating the wasm core,
  // fetching/decompressing the language data, initializing the API,
  // recognizing) via this logger - surfacing it is what tells us WHERE a
  // hang actually is. The logger is only ever wired up once, at worker
  // creation, but different callers (a real scan vs. the Diagnostics
  // screen) want their own progress target - so route through a mutable
  // "whoever's listening right now" handler rather than baking in whichever
  // caller happened to create the worker first.
  var currentOcrProgressHandler = null;

  function getOcrWorker(onProgress) {
    if (onProgress) currentOcrProgressHandler = onProgress;
    if (ocrWorkerPromise) return ocrWorkerPromise;
    ocrWorkerPromise = loadTesseractScript().then(function () {
      return window.Tesseract.createWorker('eng', 1, {
        workerPath: absoluteUrl(TESSERACT_BASE + 'worker.min.js'),
        corePath: absoluteUrl(TESSERACT_BASE + 'tesseract-core-lstm.wasm.js'),
        langPath: absoluteUrl(TESSERACT_BASE),
        gzip: true,
        logger: function (m) { if (currentOcrProgressHandler) currentOcrProgressHandler(m); }
      });
    }).then(function (worker) {
      // Tried switching page segmentation mode to SPARSE_TEXT ('11') on
      // the theory that scattered product-label text suits it better than
      // the default whole-page assumption - measured regression instead:
      // it dropped an isolated leading digit that the default PSM read
      // correctly every time in an A/B test. Left at Tesseract's default.
      return worker.setParameters({ tessedit_char_whitelist: '0123456789' }).then(function () { return worker; });
    });
    return ocrWorkerPromise;
  }

  function formatOcrProgress(m) {
    if (!m) return '';
    var pct = (typeof m.progress === 'number') ? ' ' + Math.round(m.progress * 100) + '%' : '';
    return (m.status || '') + pct;
  }

  // Universal GTIN check digit: from the digit left of the check digit,
  // weights alternate 3,1,3,1... - this same rule covers UPC-A (12),
  // EAN-13 (13) and EAN-8 (8) without special-casing each format.
  function isValidGTIN(str) {
    if (!/^\d+$/.test(str)) return false;
    if (str.length !== 8 && str.length !== 12 && str.length !== 13) return false;
    var digits = str.split('').map(function (c) { return c.charCodeAt(0) - 48; });
    var check = digits.pop();
    var sum = 0;
    for (var i = 0; i < digits.length; i++) {
      var weight = ((digits.length - 1 - i) % 2 === 0) ? 3 : 1;
      sum += digits[i] * weight;
    }
    return ((10 - (sum % 10)) % 10) === check;
  }

  // A checksum-valid read can still be wrong: OCR occasionally drops the
  // true final check digit of a longer code, leaving a shorter string that
  // *independently* passes its own checksum at that shorter length by
  // coincidence (observed on real hardware: a 13-digit EAN-13 read as its
  // own first 12 digits, which happened to also be a "valid" UPC-A on its
  // own). Unlike the guard-bar extra-digit case, there's no length-based
  // tell here - the truncated read looks completely normal. This computes
  // the *one* mathematically correct check digit for treating a
  // one-short-of-valid string as the first N-1 digits of the next GTIN
  // length up - not a 1-in-10 guess, since a GTIN's check digit is a
  // deterministic function of the digits before it. Only ever tried as a
  // secondary lookup after the original code's lookup has already failed
  // (see lookupProduct) - never overrides a code that already resolved.
  function computeGTINCheckDigit(digitsStr) {
    var digits = digitsStr.split('').map(function (c) { return c.charCodeAt(0) - 48; });
    var sum = 0;
    for (var i = 0; i < digits.length; i++) {
      var weight = ((digits.length - 1 - i) % 2 === 0) ? 3 : 1;
      sum += digits[i] * weight;
    }
    return (10 - (sum % 10)) % 10;
  }

  function extendedGTINCandidate(str) {
    if (!/^\d+$/.test(str)) return null;
    if ([7, 11, 12].indexOf(str.length) === -1) return null;
    return str + computeGTINCheckDigit(str);
  }

  // A barcode's tall guard bars (start/end/middle) look visually similar to
  // the numeral "1" with a digit-only whitelist, so OCR can insert one
  // stray extra "1" at either edge of an otherwise-correct read. If the
  // combined string is exactly one character longer than a valid GTIN
  // length, try trimming a single character off either edge and re-check
  // the checksum - only the edges, since that's where a guard bar would
  // actually appear, not scattered through the middle.
  function tryValidGTIN(str) {
    if (isValidGTIN(str)) return str;
    if ([9, 13, 14].indexOf(str.length) !== -1) {
      if (isValidGTIN(str.slice(1))) return str.slice(1);
      if (isValidGTIN(str.slice(0, -1))) return str.slice(0, -1);
    }
    return null;
  }

  // OCR with a digit whitelist still only emits digits and whitespace, so
  // "words" are digit groups - the printed line is often grouped with
  // spaces (e.g. "0 12345 67890 5"), so try concatenating a few adjacent
  // groups too, not just each group alone.
  function extractValidBarcodeFromLineText(text) {
    var tokens = text.split(/[^0-9]+/).filter(function (t) { return t.length > 0; });
    var maxSpan = 4;
    for (var i = 0; i < tokens.length; i++) {
      var combined = '';
      for (var j = i; j < Math.min(tokens.length, i + maxSpan); j++) {
        combined += tokens[j];
        var fixed = tryValidGTIN(combined);
        if (fixed) return fixed;
      }
    }
    return null;
  }

  // Tesseract's own "lines" grouping (used previously) is too coarse when
  // two print regions sit close together, e.g. a small package's nutrition
  // facts table crammed right next to its barcode - real-hardware testing
  // showed digits from both getting merged into one recognized line, which
  // defeated per-line scoping entirely. Clustering words ourselves by
  // vertical position, with a tighter overlap tolerance than Tesseract
  // uses, keeps a barcode's own digit row separate from an adjacent block
  // of unrelated small print instead.
  function clusterWordsIntoRows(words) {
    var sorted = words.slice().sort(function (a, b) { return a.bbox.y0 - b.bbox.y0; });
    var rows = [];
    sorted.forEach(function (w) {
      var h = w.bbox.y1 - w.bbox.y0;
      var cy = (w.bbox.y0 + w.bbox.y1) / 2;
      var row = null;
      for (var i = 0; i < rows.length; i++) {
        var tolerance = Math.max(h, rows[i].avgHeight) * 0.6;
        if (Math.abs(cy - rows[i].centerY) <= tolerance) { row = rows[i]; break; }
      }
      if (row) {
        row.words.push(w);
        row.centerY = (row.centerY * (row.words.length - 1) + cy) / row.words.length;
        row.avgHeight = (row.avgHeight * (row.words.length - 1) + h) / row.words.length;
      } else {
        rows.push({ words: [w], centerY: cy, avgHeight: h });
      }
    });
    rows.forEach(function (r) { r.words.sort(function (a, b) { return a.bbox.x0 - b.bbox.x0; }); });
    // A barcode's digit line is printed distinctly larger than a dense
    // nutrition table's numbers - try the largest-font row(s) first, since
    // that's the more likely candidate.
    rows.sort(function (a, b) { return b.avgHeight - a.avgHeight; });
    return rows;
  }

  function extractValidBarcodeFromOcrWords(words) {
    var rows = clusterWordsIntoRows(words);
    for (var i = 0; i < rows.length; i++) {
      var lineText = rows[i].words.map(function (w) { return w.text; }).join(' ');
      var code = extractValidBarcodeFromLineText(lineText);
      if (code) return code;
    }
    return null;
  }

  // Even when nothing passes the checksum, the top-priority (largest-font)
  // row is still the most likely candidate for the actual barcode digits -
  // surfacing that raw, unvalidated guess lets a human quickly correct one
  // or two wrong digits instead of typing a whole UPC from scratch.
  function bestDigitGuessFromWords(words) {
    var rows = clusterWordsIntoRows(words);
    for (var i = 0; i < rows.length; i++) {
      var digits = rows[i].words.map(function (w) { return w.text; }).join('').replace(/[^0-9]/g, '');
      if (digits.length >= 6) return digits;
    }
    return '';
  }

  var lastOcrDigitGuess = '';
  var lastOcrAnalyzedCanvas = null;
  var lastOcrDebug = '';
  var OCR_TIMEOUT_MS = 45000;
  // Originally capped at 900px on the assumption recognize() would be too
  // slow at full native resolution - real-device testing showed recognize()
  // only takes ~4s even at ~2MP, well within budget, so this is now just a
  // safety ceiling for unusually high camera resolutions, not an active
  // downscale. Small print (e.g. a gum box's barcode) needs all the
  // resolution it can get, since the required ~1-2ft scan distance already
  // makes it tiny in the frame - don't lower this without solid evidence
  // recognize() is actually too slow on real hardware.
  var OCR_MAX_DIMENSION = 2000;

  function downscaleForOcr(canvas) {
    var scale = Math.min(1, OCR_MAX_DIMENSION / Math.max(canvas.width, canvas.height));
    if (scale >= 1) return canvas;
    var c = document.createElement('canvas');
    c.width = Math.round(canvas.width * scale);
    c.height = Math.round(canvas.height * scale);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return c;
  }

  // A raw camera photo has real-world lighting variance (shadows, glare,
  // dim indoor light, a colored label background) that a printed page
  // scan never does - Tesseract's own internal binarization assumes
  // reasonably clean, high-contrast input, and reports of "inconsistent"
  // OCR on real photos (even from a good phone camera, not just the R1)
  // pointed at this rather than pure resolution. Converting to grayscale
  // and stretching contrast so the darkest/lightest pixels actually hit
  // black/white gives Tesseract's binarizer a much cleaner starting point.
  function preprocessForOcr(canvas) {
    var c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    var ctx = c.getContext('2d');
    ctx.drawImage(canvas, 0, 0);
    var img = ctx.getImageData(0, 0, c.width, c.height);
    var d = img.data;
    var lo = 255, hi = 0;
    var gray = new Uint8ClampedArray(d.length / 4);
    for (var i = 0, j = 0; i < d.length; i += 4, j++) {
      var g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
      gray[j] = g;
      if (g < lo) lo = g;
      if (g > hi) hi = g;
    }
    // A near-flat image (little real tonal variation) would otherwise get
    // divided by a tiny range and blown out to noise-amplified black/white
    // speckle - floor it so a low-contrast photo just stays low-contrast
    // instead of being destroyed.
    var range = Math.max(hi - lo, 30);
    for (var i2 = 0, j2 = 0; i2 < d.length; i2 += 4, j2++) {
      var v = ((gray[j2] - lo) * 255 / range) | 0;
      d[i2] = d[i2 + 1] = d[i2 + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // Tesseract's worker/WASM setup is the one part of this pipeline that
  // isn't guaranteed to cleanly resolve or reject in every WebView - if it
  // hangs instead, the UI must not go silent forever, so this always
  // produces a visible outcome one way or another within OCR_TIMEOUT_MS.
  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error(label + ' timed out after ' + Math.round(ms / 1000) + 's'));
      }, ms);
      promise.then(function (v) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }, function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function attemptOcrFallback(canvas, onProgress) {
    var report = onProgress || function (m) { scanDebug.textContent = 'ocr: ' + formatOcrProgress(m); };
    var ocrCanvas = preprocessForOcr(downscaleForOcr(canvas));
    lastOcrAnalyzedCanvas = ocrCanvas;
    var ocrPromise = getOcrWorker(report).then(function (worker) {
      return worker.recognize(ocrCanvas);
    }, function (err) {
      lastOcrDebug = 'ocr load failed: ' + ((err && err.message) || err);
      throw err;
    }).then(function (result) {
      var words = (result && result.data && result.data.words) || [];
      lastOcrDigitGuess = bestDigitGuessFromWords(words);
      var code = extractValidBarcodeFromOcrWords(words);
      if (!code) {
        var text = (result && result.data && result.data.text) || '';
        var flat = text.replace(/\s+/g, ' ').trim();
        lastOcrDebug = 'ocr read "' + flat.slice(0, 30) + '" no valid code';
        throw new Error('no valid barcode found in OCR text');
      }
      return code;
    });
    return withTimeout(ocrPromise, OCR_TIMEOUT_MS, 'ocr').catch(function (err) {
      if (/timed out/.test(err.message)) lastOcrDebug = err.message;
      throw err;
    });
  }

  // ---- Product-name identification: last resort before manual entry ----
  // There is no documented way to attach a photo to the R1's PluginMessageHandler
  // bridge (see r1-creation skill sdk-facts.md), confirmed on real hardware -
  // "Vision AI" genuinely cannot see the image, so it's not a fixable path for
  // real product recognition. Reading the brand/product name text directly
  // (rather than the barcode's digits) and searching for it is fully within
  // our own control instead. Reuses the same worker as barcode OCR, but
  // without the digit whitelist - restored afterward so barcode OCR on the
  // next scan isn't affected.
  var lastNameOcrDebug = '';

  function extractProductNameQuery(words) {
    var rows = clusterWordsIntoRows(words);
    for (var i = 0; i < rows.length; i++) {
      var text = rows[i].words.map(function (w) { return w.text; }).join(' ').trim();
      // Skip rows that are just digits/symbols (prices, codes) - want the
      // actual brand/product text, which reliably contains real letters.
      if (/[A-Za-z]{2,}/.test(text)) return text;
    }
    return null;
  }

  function attemptProductNameOcr(canvas, onProgress) {
    var ocrCanvas = preprocessForOcr(downscaleForOcr(canvas));
    var namePromise = getOcrWorker(onProgress).then(function (worker) {
      return worker.setParameters({ tessedit_char_whitelist: '' })
        .then(function () { return worker.recognize(ocrCanvas); })
        .then(function (result) {
          return worker.setParameters({ tessedit_char_whitelist: '0123456789' }).then(function () { return result; });
        }, function (err) {
          return worker.setParameters({ tessedit_char_whitelist: '0123456789' }).then(function () { throw err; });
        });
    }, function (err) {
      lastNameOcrDebug = 'name OCR load failed: ' + ((err && err.message) || err);
      throw err;
    }).then(function (result) {
      var words = (result && result.data && result.data.words) || [];
      var query = extractProductNameQuery(words);
      if (!query) {
        lastNameOcrDebug = 'no product name text found';
        throw new Error('no product name text found');
      }
      return query;
    });
    return withTimeout(namePromise, OCR_TIMEOUT_MS, 'name OCR').catch(function (err) {
      if (/timed out/.test(err.message)) lastNameOcrDebug = err.message;
      throw err;
    });
  }

  // A live text search against Open Food Facts was tried and abandoned:
  // neither of their search endpoints sends the CORS headers needed for a
  // static, backend-less site to call them directly from browser JS (only
  // their single-barcode lookup does) - confirmed by testing an actual
  // browser fetch, not just curl, which doesn't enforce CORS and so
  // misleadingly appeared to work. Pre-filling the manual-entry form with
  // the OCR'd guess instead needs no network call and no CORS support -
  // it just saves typing, with the same edit-before-save safety net as
  // every other recovery path.
  function onProductNameGuess(query) {
    pendingItem = { id: 'manual-' + Date.now(), barcode: null, productName: '', brand: '', quantity: 1, location: 'Pantry', image: capturedPhotoDataUrl, source: 'ocr-name-guess' };
    manualName.value = query;
    manualHeading.textContent = 'Verify OCR guess';
    enterManual(true);
  }

  document.querySelector('#scanView .cam-frame').addEventListener('click', attemptCapture);
  fileInput.addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var img = new Image();
    img.onload = function () {
      var c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      var ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, c.width, c.height);
      lastCaptureCanvas = c;
      capturedPhotoDataUrl = makeThumbnail(c, c.width, c.height);

      identifyFromCanvas(c)
        .then(function (barcode) { onBarcodeReady(barcode); })
        .catch(function () { onBarcodeReady(null); });

      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  });

  function onBarcodeReady(barcode) {
    var existing = findByBarcode(barcode);
    if (existing) {
      itemCardMode = 'existing';
      pendingItem = JSON.parse(JSON.stringify(existing));
      itemCardOriginalQty = existing.quantity;
      openItemCard();
      return;
    }
    if (!barcode) {
      pendingItem = { id: 'manual-' + Date.now(), barcode: null, productName: '', brand: '', quantity: 1, location: 'Pantry', image: capturedPhotoDataUrl, source: 'manual' };
      showView('recovery');
      renderRecoveryPhoto();
      recoveryDebug.textContent = lastOcrDebug ? ('OCR: ' + lastOcrDebug) : '';
      if (lastCaptureCanvas) tryBackgroundNameGuess(lastCaptureCanvas);
      return;
    }
    showView('lookup');
    document.getElementById('lookupStatus').textContent = 'Looking up…';
    lookupProduct(barcode);
  }

  // ---- Open Food Facts lookup ----
  function fetchProduct(barcode) {
    return fetch('https://world.openfoodfacts.org/api/v2/product/' + encodeURIComponent(barcode) + '.json')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.status === 1 && data.product && (data.product.product_name || data.product.generic_name)) return data;
        return null;
      })
      .catch(function () { return null; });
  }

  function useProductMatch(barcode, data, source) {
    pendingItem = {
      id: barcode,
      barcode: barcode,
      productName: data.product.product_name || data.product.generic_name,
      brand: data.product.brands || '',
      quantity: 1,
      location: 'Pantry',
      image: data.product.image_front_small_url || data.product.image_url || capturedPhotoDataUrl,
      source: source
    };
    itemCardMode = 'new';
    openItemCard();
  }

  function lookupProduct(barcode) {
    fetchProduct(barcode).then(function (data) {
      if (data) { useProductMatch(barcode, data, 'OpenFoodFacts'); return; }

      // The scanned code itself wasn't found - only now (never for a code
      // that already resolved) also try the one deterministic "missing
      // trailing check digit" correction, and only accept it if THAT code
      // turns out to be a real registered product too. Tagged as a
      // distinct source rather than silently presented as a clean scan.
      var extended = extendedGTINCandidate(barcode);
      if (!extended) { enterRecovery(barcode); return; }
      fetchProduct(extended).then(function (data2) {
        if (data2) useProductMatch(extended, data2, 'OpenFoodFacts-corrected');
        else enterRecovery(barcode);
      });
    });
  }

  function enterRecovery(barcode) {
    pendingItem = { id: barcode || ('manual-' + Date.now()), barcode: barcode || null, productName: '', brand: '', quantity: 1, location: 'Pantry', image: capturedPhotoDataUrl, source: 'unknown' };
    showView('recovery');
    renderRecoveryPhoto();
    recoveryDebug.textContent = 'Barcode read: ' + barcode + ' — not in product database';
  }

  // makeThumbnail() fits into a fixed 160x120 (4:3) box, but this element's
  // real CSS box is nothing like 4:3 - it's the full card width and only
  // 32px tall (~7:1). Feeding a 4:3 thumbnail to a 7:1 box meant the CSS
  // background-size:cover was doing a *second*, uncontrolled crop on top of
  // an already-fitted image, compounding into exactly the confusing result
  // a user screenshot flagged. This does one direct "cover" fit straight
  // into the element's own live measured box size instead, so there's only
  // ever one crop, matching what's actually about to be displayed.
  function makeCoverFitThumbnail(source, boxW, boxH) {
    var t = document.createElement('canvas');
    t.width = Math.max(1, Math.round(boxW));
    t.height = Math.max(1, Math.round(boxH));
    var ctx = t.getContext('2d');
    ctx.fillStyle = '#150f0d';
    ctx.fillRect(0, 0, t.width, t.height);
    var scale = Math.max(t.width / source.width, t.height / source.height);
    var dw = source.width * scale, dh = source.height * scale;
    var dx = (t.width - dw) / 2, dy = (t.height - dh) / 2;
    ctx.drawImage(source, dx, dy, dw, dh);
    return t.toDataURL('image/jpeg', 0.7);
  }

  // Shows what OCR actually analyzed (post-crop, post-preprocess) when
  // available, rather than the full uncropped photo - a user screenshot
  // showed this preview was previously both distorted (see makeThumbnail)
  // and misleading (it never reflected the cropped region OCR was really
  // working from), making failures impossible to visually diagnose.
  function renderRecoveryPhoto() {
    var debugImg = lastOcrAnalyzedCanvas
      ? makeCoverFitThumbnail(lastOcrAnalyzedCanvas, recoveryPhoto.offsetWidth || 220, recoveryPhoto.offsetHeight || 32)
      : null;
    var img = debugImg || capturedPhotoDataUrl;
    recoveryPhoto.style.backgroundImage = img ? 'url(' + img + ')' : 'none';
  }

  // ---- Recovery menu ----
  function renderRecovery() {
    var items = recoveryMenu.querySelectorAll('.menu-item');
    for (var i = 0; i < items.length; i++) items[i].classList.toggle('selected', i === recoveryIndex);
  }
  recoveryMenu.querySelectorAll('.menu-item').forEach(function (el, i) {
    el.addEventListener('click', function () { recoveryIndex = i; renderRecovery(); runRecoveryAction(); });
  });

  function runRecoveryAction() {
    var action = RECOVERY_ACTIONS[recoveryIndex];
    if (action === 'vision') attemptVisionAI();
    else if (action === 'voice') attemptVoiceEntry();
    else if (action === 'barcode') enterBarcodeEntry();
    else if (action === 'manual') {
      // If the background product-name OCR (started when the recovery
      // menu appeared) found a plausible guess by now, use it - otherwise
      // a completely blank form, same as picking Manual entry always did.
      if (pendingNameGuess) onProductNameGuess(pendingNameGuess);
      else enterManual(false);
    }
  }

  // ---- Vision AI (best-effort; the SDK has no documented way to attach image
  // data to a PluginMessageHandler call, so this can only send a text prompt —
  // treat any result as an unverified guess the user must confirm or edit) ----
  function attemptVisionAI() {
    showView('status');
    statusText.textContent = 'Analyzing photo…';
    statusHint.textContent = 'Hold PTT to cancel';

    if (typeof PluginMessageHandler === 'undefined') {
      statusText.textContent = 'No AI bridge on this device';
      setTimeout(function () { showView('recovery'); }, 1200);
      return;
    }

    clearTimeout(visionTimeoutHandle);
    visionTimeoutHandle = setTimeout(function () {
      window.onPluginMessage = defaultOnPluginMessage;
      statusText.textContent = 'No response — try another option';
      setTimeout(function () { showView('recovery'); }, 1200);
    }, VISION_TIMEOUT_MS);

    window.onPluginMessage = function (data) {
      clearTimeout(visionTimeoutHandle);
      window.onPluginMessage = defaultOnPluginMessage;
      var parsed = extractJsonObject(data && (data.data || data.message));
      if (parsed && parsed.productName) {
        manualName.value = parsed.productName;
        manualHeading.textContent = 'Verify AI guess';
        enterManual(true);
      } else {
        statusText.textContent = 'Could not identify a product';
        setTimeout(function () { showView('recovery'); }, 1200);
      }
    };

    PluginMessageHandler.postMessage(JSON.stringify({
      message: 'A grocery product photo was just captured on a Rabbit R1 pantry-tracking app, but this app has no way to attach the actual image to this message. Without seeing the image, make your single best generic guess at a common grocery product name, or reply with {"productName": null} if you cannot meaningfully guess. Reply with only this JSON: {"productName": "<name or null>"}',
      useLLM: true
    }));
  }

  function extractJsonObject(text) {
    if (!text) return null;
    try { return JSON.parse(text); } catch (e) {}
    var match = text.match(/\{[^{}]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch (e) {} }
    return null;
  }

  function defaultOnPluginMessage() {}
  window.onPluginMessage = defaultOnPluginMessage;

  // ---- Voice entry (Web Speech API — needs network connectivity to a cloud
  // STT service, so this is a deliberate exception to the offline-first goal) ----
  function attemptVoiceEntry() {
    showView('status');
    statusText.textContent = 'Listening…';
    statusHint.textContent = 'Say the product name';

    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      statusText.textContent = 'Voice input not available here';
      setTimeout(function () { showView('recovery'); }, 1200);
      return;
    }

    speechRecognizer = new SpeechRecognition();
    speechRecognizer.continuous = false;
    speechRecognizer.interimResults = false;
    speechRecognizer.maxAlternatives = 1;

    speechRecognizer.onresult = function (event) {
      var transcript = event.results[0][0].transcript;
      manualName.value = transcript;
      manualHeading.textContent = 'Verify what I heard';
      enterManual(true);
    };
    speechRecognizer.onerror = function () {
      statusText.textContent = 'Didn’t catch that';
      setTimeout(function () { showView('recovery'); }, 1200);
    };
    speechRecognizer.onend = function () {
      if (currentView === 'status') {
        statusText.textContent = 'No speech detected';
        setTimeout(function () { showView('recovery'); }, 1200);
      }
    };

    try { speechRecognizer.start(); } catch (e) {
      statusText.textContent = 'Voice input failed to start';
      setTimeout(function () { showView('recovery'); }, 1200);
    }
  }

  function cancelVoiceIfActive() {
    if (speechRecognizer) {
      try { speechRecognizer.abort(); } catch (e) {}
      speechRecognizer = null;
    }
  }

  // ---- Manual entry ----
  var manualQtyNum = 1;
  var manualQtyFraction = false;

  function enterManual(prefilled) {
    if (!prefilled) {
      manualName.value = '';
      manualHeading.textContent = 'Manual entry';
    }
    manualQtyNum = pendingItem.quantity || 1;
    manualQtyFraction = manualQtyNum > 0 && manualQtyNum < 1;
    renderManualQty();
    showView('manual');
    setTimeout(function () { manualName.focus(); }, 50);
  }

  function renderManualQty() {
    manualQtyValue.textContent = formatQty(manualQtyNum, manualQtyFraction);
  }

  function toggleManualQtyFraction() {
    manualQtyFraction = !manualQtyFraction;
    manualQtyNum = 1;
    renderManualQty();
  }
  manualQtyValue.addEventListener('click', toggleManualQtyFraction);
  document.getElementById('manualQtyMinus').addEventListener('click', function () { adjustManualQty(-1); });
  document.getElementById('manualQtyPlus').addEventListener('click', function () { adjustManualQty(1); });

  manualSaveBtn.addEventListener('click', saveManual);
  function saveManual() {
    var name = manualName.value.trim();
    if (!name) { manualName.focus(); return; }
    pendingItem.productName = name;
    pendingItem.quantity = manualQtyNum;
    upsertItem(pendingItem).then(function () {
      flashSaved();
      showView('home');
    });
  }

  function adjustManualQty(delta) {
    manualQtyNum = manualQtyFraction ? stepFraction(manualQtyNum, delta) : stepWhole(manualQtyNum, delta);
    renderManualQty();
  }

  // ---- Barcode entry/correction ----
  // OCR reading the bars themselves was already dropped as unreliable on
  // this camera; digit OCR occasionally still can't recover a checksum-
  // valid code either. Rather than force a full retype, this pre-fills
  // whatever raw (unvalidated) digits OCR's best-guess row contained, so
  // fixing one or two wrong characters is enough. Uses a custom on-screen
  // keypad (not the OS keyboard) - real-device testing showed the R1's
  // native keyboard doesn't honor `inputmode="numeric"`, so `<input>` is
  // just a readonly display here; every digit comes from tapping our own
  // buttons, which works the same regardless of platform keyboard quirks.
  function enterBarcodeEntry() {
    barcodeInput.value = lastOcrDigitGuess || '';
    showView('barcode');
  }

  function saveBarcodeEntry() {
    var digits = barcodeInput.value.replace(/[^0-9]/g, '');
    if (!digits) return;
    onBarcodeReady(digits);
  }

  barcodeKeypad.addEventListener('click', function (e) {
    var btn = e.target.closest('.key');
    if (!btn) return;
    var key = btn.getAttribute('data-key');
    if (key === 'back') barcodeInput.value = barcodeInput.value.slice(0, -1);
    else if (key === 'ok') saveBarcodeEntry();
    else barcodeInput.value += key;
  });

  // ---- Item card (new confirm / existing quantity adjust) ----
  var itemQtyNum = 1;
  var itemQtyFraction = false;

  function openItemCard() {
    itemHeading.textContent = itemCardMode === 'existing' ? 'Already in inventory' : 'New item — confirm';
    itemName.textContent = pendingItem.productName || '(unnamed)';
    itemBrand.textContent = pendingItem.brand || '';
    itemLocation.textContent = pendingItem.location || 'Pantry';
    itemPhoto.style.backgroundImage = pendingItem.image ? 'url(' + pendingItem.image + ')' : 'none';
    itemQtyNum = pendingItem.quantity != null ? pendingItem.quantity : (itemCardMode === 'existing' ? itemCardOriginalQty : 1);
    itemQtyFraction = itemQtyNum > 0 && itemQtyNum < 1;
    renderItemQty();
    showView('itemCard');
  }

  function renderItemQty() {
    qtyValue.textContent = formatQty(itemQtyNum, itemQtyFraction);
    updateItemHint();
  }

  function updateItemHint() {
    if (itemCardMode === 'existing') {
      itemHint.textContent = itemQtyNum === 0
        ? 'Scroll: qty · Tap qty: fractions · Click: keep at 0 · Hold: remove'
        : 'Scroll: qty · Tap qty: fractions · Click: save · Hold: remove';
    } else {
      itemHint.textContent = 'Scroll: qty · Tap qty: fractions · Click: save · Hold: cancel';
    }
  }

  function adjustItemQty(delta) {
    itemQtyNum = itemQtyFraction ? stepFraction(itemQtyNum, delta) : stepWhole(itemQtyNum, delta);
    renderItemQty();
  }

  function toggleItemQtyFraction() {
    itemQtyFraction = !itemQtyFraction;
    itemQtyNum = 1;
    renderItemQty();
  }
  qtyValue.addEventListener('click', toggleItemQtyFraction);
  document.getElementById('itemQtyMinus').addEventListener('click', function () { adjustItemQty(-1); });
  document.getElementById('itemQtyPlus').addEventListener('click', function () { adjustItemQty(1); });

  itemSaveBtn.addEventListener('click', saveItemCard);
  function saveItemCard() {
    pendingItem.quantity = itemQtyNum;
    upsertItem(pendingItem).then(function () {
      flashSaved();
      showView('home');
    });
  }

  var savedToastTimer = null;

  function flashSaved() {
    clearTimeout(savedToastTimer);
    savedToast.classList.add('show');
    savedToastTimer = setTimeout(function () { savedToast.classList.remove('show'); }, 1300);
  }

  // ---- Browse ----
  function enterBrowse() {
    loadInventory().then(function () {
      browseIndex = clamp(browseIndex, 0, Math.max(0, inventory.length - 1));
      renderBrowseList();
      showView('browse');
    });
  }

  function renderBrowseList() {
    inventoryList.innerHTML = '';
    browseEmptyHint.style.display = inventory.length === 0 ? 'flex' : 'none';
    inventoryList.style.display = inventory.length === 0 ? 'none' : 'flex';

    inventory.forEach(function (item, i) {
      var el = document.createElement('div');
      el.className = 'inventory-item' + (i === browseIndex ? ' selected' : '');
      var nameEl = document.createElement('div');
      nameEl.className = 'ii-name';
      nameEl.textContent = item.productName || '(unnamed)';
      var metaEl = document.createElement('div');
      metaEl.className = 'ii-meta';
      metaEl.innerHTML = '<span>Qty ' + item.quantity + '</span><span>' + (item.location || 'Pantry') + '</span>';
      el.appendChild(nameEl);
      el.appendChild(metaEl);
      el.addEventListener('click', function () { browseIndex = i; renderBrowseList(); openDetail(); });
      inventoryList.appendChild(el);
    });

    var selectedEl = inventoryList.children[browseIndex];
    if (selectedEl) selectedEl.scrollIntoView({ block: 'nearest' });
  }

  function moveBrowseSelection(delta) {
    if (inventory.length === 0) return;
    browseIndex = clamp(browseIndex + delta, 0, inventory.length - 1);
    renderBrowseList();
  }

  // ---- Detail ----
  var detailQtyFraction = false;

  function openDetail() {
    if (inventory.length === 0) return;
    var item = inventory[browseIndex];
    detailQty = item.quantity;
    detailQtyFraction = detailQty > 0 && detailQty < 1;
    renderDetail(item);
    showView('detail');
  }

  function renderDetail(item) {
    detailName.textContent = item.productName || '(unnamed)';
    detailRows.innerHTML =
      '<div class="detail-row" id="detailQtyRow"><span class="dr-label">Quantity</span>' +
      '<span><button class="qty-btn" id="detailQtyMinus" aria-label="Decrease quantity">&minus;</button> ' +
      '<span class="dr-value">' + formatQty(detailQty, detailQtyFraction) + '</span> ' +
      '<button class="qty-btn" id="detailQtyPlus" aria-label="Increase quantity">+</button></span></div>' +
      row('Location', item.location || 'Pantry') +
      row('Brand', item.brand || '—') +
      row('Barcode', item.barcode || '—') +
      row('Source', item.source || '—') +
      row('Updated', item.lastUpdated || '—');
  }

  function row(label, value) {
    return '<div class="detail-row"><span class="dr-label">' + label + '</span><span class="dr-value">' + value + '</span></div>';
  }

  function adjustDetailQty(delta) {
    if (inventory.length === 0) return;
    detailQty = detailQtyFraction ? stepFraction(detailQty, delta) : stepWhole(detailQty, delta);
    var item = inventory[browseIndex];
    item.quantity = detailQty;
    item.lastUpdated = new Date().toISOString().slice(0, 10);
    saveInventoryToDisk();
    renderDetail(item);
  }

  function toggleDetailQtyFraction() {
    if (inventory.length === 0) return;
    detailQtyFraction = !detailQtyFraction;
    detailQty = 1;
    var item = inventory[browseIndex];
    item.quantity = detailQty;
    item.lastUpdated = new Date().toISOString().slice(0, 10);
    saveInventoryToDisk();
    renderDetail(item);
  }
  detailRows.addEventListener('click', function (e) {
    if (e.target.closest('#detailQtyMinus')) { adjustDetailQty(-1); return; }
    if (e.target.closest('#detailQtyPlus')) { adjustDetailQty(1); return; }
    if (e.target.closest('#detailQtyRow')) toggleDetailQtyFraction();
  });

  detailDeleteBtn.addEventListener('click', function () {
    if (inventory.length === 0) return;
    var item = inventory[browseIndex];
    deleteItemById(item.id).then(function () {
      browseIndex = clamp(browseIndex, 0, Math.max(0, inventory.length - 1));
      renderBrowseList();
      showView('browse');
    });
  });

  // ---- Hardware events ----
  window.addEventListener('scrollUp', function () {
    if (currentView === 'home') { homeIndex = (homeIndex + HOME_ACTIONS.length - 1) % HOME_ACTIONS.length; renderHome(); }
    else if (currentView === 'recovery') { recoveryIndex = (recoveryIndex + RECOVERY_ACTIONS.length - 1) % RECOVERY_ACTIONS.length; renderRecovery(); }
    else if (currentView === 'itemCard') adjustItemQty(1);
    else if (currentView === 'manual') adjustManualQty(1);
    else if (currentView === 'browse') moveBrowseSelection(-1);
    else if (currentView === 'detail') adjustDetailQty(1);
  });
  window.addEventListener('scrollDown', function () {
    if (currentView === 'home') { homeIndex = (homeIndex + 1) % HOME_ACTIONS.length; renderHome(); }
    else if (currentView === 'recovery') { recoveryIndex = (recoveryIndex + 1) % RECOVERY_ACTIONS.length; renderRecovery(); }
    else if (currentView === 'itemCard') adjustItemQty(-1);
    else if (currentView === 'manual') adjustManualQty(-1);
    else if (currentView === 'browse') moveBrowseSelection(1);
    else if (currentView === 'detail') adjustDetailQty(-1);
  });

  window.addEventListener('sideClick', function () {
    if (currentView === 'home') runHomeAction();
    else if (currentView === 'scan') attemptCapture();
    else if (currentView === 'recovery') runRecoveryAction();
    else if (currentView === 'itemCard') saveItemCard();
    else if (currentView === 'manual') saveManual();
    else if (currentView === 'browse') openDetail();
    else if (currentView === 'barcode') saveBarcodeEntry();
  });

  window.addEventListener('longPressStart', function () {
    if (currentView === 'scan') { showView('home'); }
    else if (currentView === 'recovery') { showView('home'); }
    else if (currentView === 'itemCard') {
      if (itemCardMode === 'existing') {
        deleteItemById(pendingItem.id).then(function () { showView('home'); });
      } else {
        showView('home');
      }
    }
    else if (currentView === 'manual') { cancelVoiceIfActive(); showView('home'); }
    else if (currentView === 'status') { cancelVoiceIfActive(); clearTimeout(visionTimeoutHandle); showView('recovery'); }
    else if (currentView === 'browse') { showView('home'); }
    else if (currentView === 'detail') { showView('browse'); }
    else if (currentView === 'diag') { showView('home'); }
    else if (currentView === 'barcode') { showView('recovery'); }
  });

  // ---- Fit the fixed 240x282 design to whatever browser window it's
  // actually running in. On the real R1 the viewport already is 240x282,
  // so this computes a scale of ~1 and changes nothing. Anywhere else
  // (phone, desktop browser) it scales the same unmodified UI up to fill
  // the available space instead of sitting tiny in a corner. ----
  var appEl = document.getElementById('app');
  function fitStage() {
    var scale = Math.min(window.innerWidth / 240, window.innerHeight / 282);
    appEl.style.transform = 'scale(' + Math.min(scale, 3) + ')';
  }
  window.addEventListener('resize', fitStage);
  window.addEventListener('orientationchange', fitStage);
  window.addEventListener('load', fitStage);
  fitStage();
  setTimeout(fitStage, 200);

  // ---- Touch/mouse support for hardware-only gestures ----
  // Menu items, save buttons, etc. already respond to a direct tap/click
  // (see their own addEventListener('click', ...) calls above), so the
  // R1's scroll wheel + PTT (sideClick) aren't required for those - but
  // "hold PTT to go back/cancel" has no non-R1 equivalent at all. Rather
  // than special-case every view again, a press-and-hold (~500ms) anywhere
  // dispatches the exact same synthetic 'longPressStart' event the R1
  // fires, so all the existing per-view back/cancel logic runs unchanged
  // on any device.
  var HOLD_MS = 500;
  var holdTimer = null;
  function startHoldTimer() {
    clearTimeout(holdTimer);
    holdTimer = setTimeout(function () {
      window.dispatchEvent(new Event('longPressStart'));
    }, HOLD_MS);
  }
  function cancelHoldTimer() {
    clearTimeout(holdTimer);
  }
  appEl.addEventListener('pointerdown', startHoldTimer);
  appEl.addEventListener('pointerup', cancelHoldTimer);
  appEl.addEventListener('pointercancel', cancelHoldTimer);
  appEl.addEventListener('pointerleave', cancelHoldTimer);

  // ---- Init ----
  loadInventory().then(function () {
    renderHome();
    initCamera();
  });
})();
