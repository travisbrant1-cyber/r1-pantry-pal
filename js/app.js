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
  var VIEWS = {
    home: homeView, scan: scanView, lookup: lookupView, itemCard: itemCardView,
    recovery: recoveryView, status: statusView, manual: manualView,
    browse: browseView, detail: detailView
  };

  var camPreview = document.getElementById('camPreview');
  var camFallback = document.getElementById('camFallback');
  var fileInput = document.getElementById('fileInput');
  var scanStatus = document.getElementById('scanStatus');

  var itemHeading = document.getElementById('itemHeading');
  var itemPhoto = document.getElementById('itemPhoto');
  var itemName = document.getElementById('itemName');
  var itemBrand = document.getElementById('itemBrand');
  var qtyValue = document.getElementById('qtyValue');
  var itemLocation = document.getElementById('itemLocation');
  var itemSaveBtn = document.getElementById('itemSaveBtn');
  var itemHint = document.getElementById('itemHint');

  var recoveryPhoto = document.getElementById('recoveryPhoto');
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

  // ---- State ----
  var currentView = 'home';
  var homeIndex = 0;
  var HOME_ACTIONS = ['scan', 'browse'];

  var inventory = [];
  var videoActive = false;
  var codeReader = null;
  var scanningActive = false;
  var lastDecodeAt = 0;

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
  }

  // ---- Camera / scanning ----
  function initCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCamFallback();
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then(function (stream) {
        camPreview.srcObject = stream;
        camPreview.classList.add('active');
        camFallback.style.display = 'none';
        videoActive = true;
        statusDot.classList.add('live');
        // The stream can finish setting up after the user has already
        // navigated into the scan view (permission prompts take real time on
        // a real device) - start the decode loop now if we're sitting there
        // waiting, instead of only starting it at the moment of navigation.
        if (currentView === 'scan') startVideoScanning();
      })
      .catch(function () {
        showCamFallback();
      });
  }

  function showCamFallback() {
    videoActive = false;
    camFallback.style.display = 'block';
    statusDot.classList.add('sim');
  }

  function getZXingHints() {
    var hints = new Map();
    hints.set(window.ZXing.DecodeHintType.POSSIBLE_FORMATS, [
      window.ZXing.BarcodeFormat.EAN_13,
      window.ZXing.BarcodeFormat.EAN_8,
      window.ZXing.BarcodeFormat.UPC_A,
      window.ZXing.BarcodeFormat.UPC_E,
      window.ZXing.BarcodeFormat.CODE_128
    ]);
    return hints;
  }

  function enterScan() {
    showView('scan');
    scanStatus.textContent = videoActive ? 'Point at a barcode…' : 'Starting camera…';
    if (videoActive) startVideoScanning();
  }

  function startVideoScanning() {
    if (scanningActive) return;
    scanningActive = true;
    scanStatus.textContent = 'Point at a barcode…';
    if (!codeReader) codeReader = new window.ZXing.BrowserMultiFormatReader(getZXingHints());
    codeReader.decodeFromVideoElement(camPreview, function (result, err) {
      if (result) handleBarcodeDetected(result.getText());
    });
  }

  function stopVideoScanning() {
    scanningActive = false;
    if (codeReader) {
      try { codeReader.reset(); } catch (e) {}
    }
  }

  function handleBarcodeDetected(barcode) {
    var now = Date.now();
    if (now - lastDecodeAt < 2000) return; // debounce repeat decodes of the same session
    lastDecodeAt = now;
    stopVideoScanning();
    capturePhotoFrame();
    onBarcodeReady(barcode);
  }

  function capturePhotoFrame() {
    try {
      var c = document.createElement('canvas');
      c.width = 160; c.height = 120;
      var ctx = c.getContext('2d');
      ctx.drawImage(camPreview, 0, 0, c.width, c.height);
      capturedPhotoDataUrl = c.toDataURL('image/jpeg', 0.6);
    } catch (e) {
      capturedPhotoDataUrl = null;
    }
  }

  camFallback.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var img = new Image();
    img.onload = function () {
      var c = document.createElement('canvas');
      c.width = 160; c.height = 120;
      var ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0, c.width, c.height);
      capturedPhotoDataUrl = c.toDataURL('image/jpeg', 0.6);

      if (!codeReader) codeReader = new window.ZXing.BrowserMultiFormatReader(getZXingHints());
      codeReader.decodeFromImageElement(img)
        .then(function (result) { onBarcodeReady(result.getText()); })
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
  function enterManual(prefilled) {
    if (!prefilled) {
      manualName.value = '';
      manualHeading.textContent = 'Manual entry';
    }
    manualQtyValue.textContent = String(pendingItem.quantity || 1);
    showView('manual');
    setTimeout(function () { manualName.focus(); }, 50);
  }

  manualSaveBtn.addEventListener('click', saveManual);
  function saveManual() {
    var name = manualName.value.trim();
    if (!name) { manualName.focus(); return; }
    pendingItem.productName = name;
    pendingItem.quantity = clamp(parseInt(manualQtyValue.textContent, 10) || 1, 0, 999);
    upsertItem(pendingItem).then(function () {
      flashSaved();
      showView('home');
    });
  }

  function adjustManualQty(delta) {
    var v = clamp((parseInt(manualQtyValue.textContent, 10) || 0) + delta, 0, 999);
    manualQtyValue.textContent = String(v);
  }

  // ---- Item card (new confirm / existing quantity adjust) ----
  function openItemCard() {
    itemHeading.textContent = itemCardMode === 'existing' ? 'Already in inventory' : 'New item — confirm';
    itemName.textContent = pendingItem.productName || '(unnamed)';
    itemBrand.textContent = pendingItem.brand || '';
    itemLocation.textContent = pendingItem.location || 'Pantry';
    itemPhoto.style.backgroundImage = pendingItem.image ? 'url(' + pendingItem.image + ')' : 'none';
    qtyValue.textContent = String(pendingItem.quantity || (itemCardMode === 'existing' ? itemCardOriginalQty : 1));
    updateItemHint();
    showView('itemCard');
  }

  function updateItemHint() {
    if (itemCardMode === 'existing') {
      var q = parseInt(qtyValue.textContent, 10);
      itemHint.textContent = q === 0
        ? 'Scroll: quantity · Click PTT: keep at 0 · Hold: remove entirely'
        : 'Scroll: quantity · Click PTT: save · Hold: remove entirely';
    } else {
      itemHint.textContent = 'Scroll: quantity · Click PTT: save · Hold: cancel';
    }
  }

  function adjustItemQty(delta) {
    var v = clamp((parseInt(qtyValue.textContent, 10) || 0) + delta, 0, 999);
    qtyValue.textContent = String(v);
    updateItemHint();
  }

  itemSaveBtn.addEventListener('click', saveItemCard);
  function saveItemCard() {
    pendingItem.quantity = parseInt(qtyValue.textContent, 10) || 0;
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
  function openDetail() {
    if (inventory.length === 0) return;
    var item = inventory[browseIndex];
    detailQty = item.quantity;
    renderDetail(item);
    showView('detail');
  }

  function renderDetail(item) {
    detailName.textContent = item.productName || '(unnamed)';
    detailRows.innerHTML =
      row('Quantity', detailQty) +
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
    detailQty = clamp(detailQty + delta, 0, 999);
    var item = inventory[browseIndex];
    item.quantity = detailQty;
    item.lastUpdated = new Date().toISOString().slice(0, 10);
    saveInventoryToDisk();
    renderDetail(item);
  }

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
    else if (currentView === 'recovery') runRecoveryAction();
    else if (currentView === 'itemCard') saveItemCard();
    else if (currentView === 'manual') saveManual();
    else if (currentView === 'browse') openDetail();
  });

  window.addEventListener('longPressStart', function () {
    if (currentView === 'scan') { stopVideoScanning(); showView('home'); }
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
  });

  // ---- Init ----
  loadInventory().then(function () {
    renderHome();
    initCamera();
  });
})();
