(function () {
  'use strict';

  var STORAGE_KEY = 'pantry_pal_inventory';
  var VISION_TIMEOUT_MS = 12000;

  // ---- Elements ----
  var statusDot = document.getElementById('statusDot');

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
  var VIEWS = {
    home: homeView, scan: scanView, lookup: lookupView, itemCard: itemCardView,
    recovery: recoveryView, status: statusView, manual: manualView,
    browse: browseView, detail: detailView, diag: diagView
  };

  var camPreview = document.getElementById('camPreview');
  var camFallback = document.getElementById('camFallback');
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

  var recoveryIndex = 0;
  var RECOVERY_ACTIONS = ['vision', 'voice', 'manual'];

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
        advanced: [{ focusMode: 'continuous' }, { zoom: 2 }]
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
  function makeThumbnail(source, sw, sh) {
    var t = document.createElement('canvas');
    t.width = 160; t.height = 120;
    t.getContext('2d').drawImage(source, 0, 0, sw, sh, 0, 0, t.width, t.height);
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
      capturedPhotoDataUrl = makeThumbnail(c, c.width, c.height);

      // Leave the live camera view as soon as the still is captured - OCR
      // takes a few seconds, and staying on the live feed makes it look
      // like the device still needs to be held steady when the frame is
      // already locked in.
      statusText.textContent = 'Reading barcode…';
      statusHint.textContent = 'Hold PTT to cancel';
      showView('status');

      attemptOcrFallback(c, function (m) {
        var line = formatOcrProgress(m);
        statusHint.textContent = line || 'Hold PTT to cancel';
        scanDebug.textContent = 'ocr: ' + line;
      })
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
        if (isValidGTIN(combined)) return combined;
      }
    }
    return null;
  }

  // A real-world capture usually has other printed numbers on the package
  // (lot codes, item numbers) besides the actual barcode's digit line -
  // concatenating tokens across the *whole* recognized text merges digits
  // from unrelated lines into one bogus string. Tesseract reports text
  // per physical line (with its own bounding box), so extraction is scoped
  // to one line at a time instead.
  function extractValidBarcodeFromOcrLines(lines) {
    for (var i = 0; i < lines.length; i++) {
      var code = extractValidBarcodeFromLineText(lines[i].text || '');
      if (code) return code;
    }
    return null;
  }

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
    var ocrCanvas = downscaleForOcr(canvas);
    var ocrPromise = getOcrWorker(report).then(function (worker) {
      return worker.recognize(ocrCanvas);
    }, function (err) {
      lastOcrDebug = 'ocr load failed: ' + ((err && err.message) || err);
      throw err;
    }).then(function (result) {
      var lines = (result && result.data && result.data.lines) || [];
      var code = extractValidBarcodeFromOcrLines(lines);
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
      capturedPhotoDataUrl = makeThumbnail(c, c.width, c.height);

      attemptOcrFallback(c)
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
      return;
    }
    showView('lookup');
    document.getElementById('lookupStatus').textContent = 'Looking up…';
    lookupProduct(barcode);
  }

  // ---- Open Food Facts lookup ----
  function lookupProduct(barcode) {
    fetch('https://world.openfoodfacts.org/api/v2/product/' + encodeURIComponent(barcode) + '.json')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.status === 1 && data.product && (data.product.product_name || data.product.generic_name)) {
          pendingItem = {
            id: barcode,
            barcode: barcode,
            productName: data.product.product_name || data.product.generic_name,
            brand: data.product.brands || '',
            quantity: 1,
            location: 'Pantry',
            image: data.product.image_front_small_url || data.product.image_url || capturedPhotoDataUrl,
            source: 'OpenFoodFacts'
          };
          itemCardMode = 'new';
          openItemCard();
        } else {
          enterRecovery(barcode);
        }
      })
      .catch(function () {
        enterRecovery(barcode);
      });
  }

  function enterRecovery(barcode) {
    pendingItem = { id: barcode || ('manual-' + Date.now()), barcode: barcode || null, productName: '', brand: '', quantity: 1, location: 'Pantry', image: capturedPhotoDataUrl, source: 'unknown' };
    showView('recovery');
    renderRecoveryPhoto();
    recoveryDebug.textContent = 'Barcode read: ' + barcode + ' — not in product database';
  }

  function renderRecoveryPhoto() {
    recoveryPhoto.style.backgroundImage = capturedPhotoDataUrl ? 'url(' + capturedPhotoDataUrl + ')' : 'none';
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
    else if (action === 'manual') enterManual(false);
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

  itemSaveBtn.addEventListener('click', saveItemCard);
  function saveItemCard() {
    pendingItem.quantity = itemQtyNum;
    upsertItem(pendingItem).then(function () {
      flashSaved();
      showView('home');
    });
  }

  function flashSaved() {
    statusDot.style.transform = 'scale(1.4)';
    setTimeout(function () { statusDot.style.transform = 'scale(1)'; }, 150);
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
      '<div class="detail-row" id="detailQtyRow"><span class="dr-label">Quantity</span><span class="dr-value">' + formatQty(detailQty, detailQtyFraction) + '</span></div>' +
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
  });

  // ---- Init ----
  loadInventory().then(function () {
    renderHome();
    initCamera();
  });
})();
