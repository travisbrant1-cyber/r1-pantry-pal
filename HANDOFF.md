# Pantry Pal — Project Handoff

Last updated: 2026-07-04. Repo: [github.com/travisbrant1-cyber/r1-pantry-pal](https://github.com/travisbrant1-cyber/r1-pantry-pal). Live: [travisbrant1-cyber.github.io/r1-pantry-pal](https://travisbrant1-cyber.github.io/r1-pantry-pal/). Install QR: `r1-creation-qr-codes/pantry-pal-qr.png` on the machine this was built on (not in this repo).

This is a **Rabbit R1 Creation** — a static HTML/CSS/JS app that runs full-screen on the R1 device. If you're picking this up fresh, also read the `r1-creation` skill (`~/.claude/skills/r1-creation/`) for the general R1 platform facts and deploy pipeline this project follows — this doc only covers what's specific to Pantry Pal.

## What this is

A home inventory tracker. Scan a barcode, it looks up the product and lets you log a quantity in a few seconds. Point of the whole exercise, from the original proposal: **"Scan once. Know what you have. Never buy it twice by accident."**

## Status: Phase 1 done, plus two Phase-2 items pulled forward

The original proposal (see "Original spec" below) defines four phases. What's actually built:

**Done:**
- Barcode scanning (tap-to-capture, not continuous — see "Why tap-to-capture" below). Reads the printed digit line via OCR, not the bars themselves — see "OCR-only scanning" below for why bar decoding was dropped entirely.
- Real Open Food Facts API lookup, with local cache always overriding external lookup for a barcode already seen once
- Local inventory storage (`window.creationStorage.plain`, JSON blob, no account needed)
- Add / adjust-quantity / remove-entirely flows
- Manual entry (both as the "barcode not found" fallback and as its own direct Home menu item)
- Inventory browser + item detail view
- Fractional quantities (1/4, 1/2, 3/4) for bulk goods, via tap-to-toggle on any quantity field
- Vision AI attempt and Web Speech API voice entry as unknown-product recovery options (pulled forward from Phase 2 — see caveats below, these are real but weak)

**Not started** (still Phase 2–4 per the original roadmap, unchanged):
- Expiration tracking + notifications
- Shopping list, recipes, statistics, multi-location switching UI (the `location` field exists on every item and defaults to "Pantry", but there's no UI yet to create/switch locations)
- Household sync, shared inventories, cloud backup

## Architecture

Vanilla JS, no build step, no framework — one `index.html`, `css/styles.css`, `js/app.js`, plus a vendored OCR library at `js/vendor/tesseract/` (self-hosted rather than CDN-loaded, so scanning still works with no internet — see the SDK's offline-first principle; also see "OCR-only scanning" below for the offline-first exception this actually has in practice on first use). `js/vendor/zxing.min.js` (the bar-decode library) was removed entirely once bar decoding was dropped — see below.

**State machine**: a single `showView(name)` function toggles `.active` on ten view `<div>`s (home, scan, lookup, itemCard, recovery, status, manual, browse, detail, diag). All navigation is scroll/click/hold/tap driven — see the in-app hint text on each screen for the current control mapping, it's kept in sync with behavior.

**Storage**: one JSON blob under the key `pantry_pal_inventory`, an array of items shaped like:
```json
{
  "id": "041196910123",
  "barcode": "041196910123",
  "productName": "Campbell's Tomato Soup",
  "brand": "Campbell's",
  "quantity": 4,
  "location": "Pantry",
  "image": "...",
  "source": "OpenFoodFacts",
  "lastUpdated": "2026-07-04"
}
```
`id` is the barcode when known, or a generated `manual-<timestamp>` id for barcode-less items (manual entries, homemade things). `expiration` isn't populated yet (Phase 2).

## Key design decisions and why

**Tap-to-capture instead of continuous video scanning.** The first version ran ZXing continuously against the live video feed. On the real device, camera setup (permission grant + stream init) takes real time, and the decode loop was only ever started once, at the exact moment of navigating into the Scan screen — so if the camera wasn't ready yet at that instant (very likely on first open), scanning silently never started. The user saw a live camera preview and assumed it was scanning; it wasn't. Rather than just patch the race (which was fixed once, in commit `cb6f4f9`), the whole approach was replaced: PTT click or a tap now captures one still frame and runs a single decode against it — simpler, more predictable, and matches the already-working Color Picker capture pattern.
**As soon as the still is captured, the UI leaves the live camera view** and switches to the existing status screen ("Reading barcode…") rather than staying on the live feed while OCR runs for a few seconds. Staying on live video during that wait made it look like the device still needed to be held steady, when the frame was already locked in — this was reported as confusing on real hardware and fixed by reusing the same status-screen pattern already used for Vision AI/voice. Holding PTT during this "Reading barcode…" state cancels to the recovery menu, same as it already does for the other status states.

**Barcode lookup is cache-first, permanently.** Once a barcode has been identified by any method (API, Vision AI, voice, manual), it's saved locally and a future scan of the same barcode never touches the network or the LLM again — `findByBarcode()` runs before any lookup path. Verified live against a real product (Nutella, barcode `3017620422003`).

**Vision AI is real but weak — be honest about this with users.** There is no documented way to attach a captured photo to a `PluginMessageHandler` message. The "Try vision AI" recovery option genuinely sends a request, but it can only ask the LLM to guess a "common grocery product" with zero visual grounding — in practice this means either no response at all, or a generic guess unrelated to the actual photo. Any result routes through the same editable "verify" screen as manual entry, so nothing can silently save a wrong name — but don't expect this to actually work. It's there because it was explicitly requested as an experiment, not because it's expected to deliver value yet. If Rabbit ever documents real image support, this is the one function to revisit: `attemptVisionAI()` in `js/app.js`.

**Voice entry works but breaks "offline-first."** Uses the standard Web Speech API, which needs network access to a cloud STT provider — a deliberate, acknowledged exception to the spec's offline-first principle. Tested that it degrades gracefully (falls back to the recovery menu within ~1.5s on no-mic/no-speech rather than hanging) but real recognition accuracy on-device is unverified.

**OCR-only scanning: bar decoding was tried and dropped entirely, not kept as a first attempt.** Originally added as a fallback after ZXing bar decoding, tried first every scan. Real-hardware testing (including fixing resolution, capture, and the correct focus distance along the way) never got bar decoding to actually succeed even once — the working theory is the fixed-focus lens plus this camera's limits leave too few pixels-per-bar-module even at the correct distance, while the much larger printed digits underneath stayed readable. Given bars never worked in practice, ZXing was removed from the scan flow entirely (not just deprioritized) — `js/vendor/zxing.min.js` and its plumbing (`decodeFromCanvas()`, `getZXingHints()`, the burst-retry logic) were deleted rather than left dormant, since keeping unused, untested code around under a "might help someday" rationale isn't worth the complexity. Every scan (camera capture and the file-picker fallback) now goes straight to OCR via `attemptOcrFallback()`. If a different camera or a clip-on macro lens is ever tried and bar decoding becomes viable, this would need to be re-added from scratch (`git log` has the removed implementation if useful as a reference). Implementation: `js/vendor/tesseract/` (Tesseract.js + the `eng` fast-trained LSTM model, self-hosted to keep the offline-first principle — see below for why this is an exception in practice), lazy-loaded only on first use (~8MB), not part of initial page load. Any candidate digit string is required to pass the standard GTIN check-digit algorithm (`isValidGTIN()`) before being accepted as a real barcode — this is the safety net against a misread digit silently pulling up the wrong product, on top of the existing confirm-before-save screen.
**Extraction is scoped per row of words we cluster ourselves, not Tesseract's own "lines" and not the whole recognized text.** First real-hardware attempt concatenated tokens across `result.data.text` as one flattened blob - real packages usually have other printed numbers besides the barcode (lot/item codes), and merging tokens across unrelated print produced garbage like `828345035005273` instead of the real `662834503500`. Scoping to `result.data.lines` (Tesseract's own per-physical-line grouping) fixed that case, but a small package (a gum box) exposed a second, harder version of the same problem: its nutrition facts table sits close enough to the barcode that Tesseract's own line segmentation merged both into one recognized line, defeating the scoping again. `clusterWordsIntoRows()` now does this grouping itself from `result.data.words` (each with its own bbox), using a tighter vertical-overlap tolerance than Tesseract's, and tries the largest-average-font-height row first — a barcode's digit line is reliably printed larger than a dense nutrition table's numbers, so this doubles as a "most likely to be the barcode" heuristic, not just a disambiguator. `extractValidBarcodeFromOcrWords()` is the entry point; `extractValidBarcodeFromLineText()` still does the same-line token-concatenation-plus-checksum logic as before, just per computed row instead of per Tesseract line. Verified by reproducing the exact failure in a synthetic image (a dense cluster of small nutrition-fact-style numbers positioned just above a larger-font barcode digit line, matching the real gum box's layout) - correctly isolated and decoded the barcode, which the real Open Food Facts API confirmed is a real registered product (Orbit Spearmint Gum, `022000004840`).
**OCR fallback breaks "offline-first" on first use, same tradeoff as voice entry.** The vendored Tesseract assets (~8MB: JS + wasm + trained-language data) are self-hosted on this repo's own GitHub Pages, not a third-party CDN, but they still have to be fetched over the network the first time OCR fallback actually runs (lazy-loaded, not part of initial page load). After that first fetch, ordinary browser caching should make it available offline — untested whether the R1's WebView actually caches this reliably.
**A note for whoever touches Tesseract worker paths next:** `importScripts` inside the worker requires an *absolute* URL — a path like `js/vendor/tesseract/worker.min.js` that works fine for a normal `<script src>` tag throws `SyntaxError: ... is invalid` inside the worker. Paths are resolved via `absoluteUrl()` (`new URL(path, window.location.href).href`) so it also still works correctly when deployed under the GitHub Pages subpath, not just at a site root — don't revert to bare relative paths here.

**Fractional quantities default to whole-number stepping, fractions are opt-in.** Scrolling normally steps by 1 (fast, matches the majority case — cans, boxes, bottles). Tapping the quantity number toggles a per-field mode that steps by 0.25 within [0, 1] instead (0, 1/4, 1/2, 3/4, 1), for bulk goods like flour where "how full is it" matters more than a count. This was a deliberate tradeoff over unifying the stepping into one scale — a single quarter-stepped scale would slow down the common case (0→6 cans would take 9 scroll clicks instead of 6). The tradeoff: you can't currently represent "1 and a quarter bags" — fraction mode tops out at 1 "full unit." Revisit if that turns out to matter in practice.

## Known bugs already found and fixed (for context, don't re-introduce)

- **Camera-ready race condition** (fixed in `cb6f4f9`, then made moot by the tap-to-capture rewrite): starting an async operation's continuation only from the triggering navigation event, not from whichever happens later (navigation vs. the async operation itself completing).
- **Recovery view 3px overflow** on the 240×282 frame: caught via `scrollHeight > clientHeight` checks in preview, not visible in a screenshot that happened to just barely fit. Every view still has `overflow-y: auto` as a safety net regardless — see the `r1-creation` skill's testing methodology for why bare pass/fail isn't enough margin.
- **Barcode capture downsampled to a fixed 160×120 canvas** (fixed in `b4bcb0f`): destroyed the fine bar spacing barcodes need to decode, regardless of distance or focus — would only ever work by luck. Capture now uses the camera's native resolution (`videoWidth`/`videoHeight`); a 160×120 thumbnail is still generated afterward, but only for the stored item photo, from the already-captured full-res frame.
- **GitHub Pages build got stuck in `"building"` for this repo** during real-hardware debugging — real content deployed correctly per `git push`, but the Pages build never advanced, so the live site kept serving stale code well after fixes had been pushed and looked like device-side caching at first. See the `r1-creation` skill's `deployment-pipeline.md` (stuck-build gotcha) — always verify the live URL actually changed before trusting a "fixed" report from real-hardware testing.

## R1 camera hardware facts (confirmed on real device)

- **Fixed-focus lens, sharp only from roughly 1–2 feet away.** Confirmed by holding a real barcode at varying distances while watching the live preview: it never sharpens at typical close scanning range (a few inches), only once backed off to about a foot or more. The scan hint text was updated to say this explicitly (`"Hold ~1-2ft back, click PTT"`) — don't revert that copy to anything implying close-range scanning without re-confirming this.
- `focusMode: 'continuous'` is requested as a best-effort `advanced` getUserMedia constraint — unverified whether the R1's camera actually honors it; harmless no-op if unsupported. A `zoom: 2` constraint was also tried (added back when bar decoding was still the plan, on the theory that more magnification meant more pixels per bar), but removed after real-device testing on small print (a gum box) got noticeably worse with it than without: `zoom` most likely crops the sensor's field of view rather than upscaling, which risks cutting part of a *small* barcode's digit line out of frame entirely - for OCR, a complete but smaller digit line is far more useful than a partial but larger one, since the whole line is needed to reconstruct a valid checksum.
- A settle delay (~300ms) plus a 3-frame decode burst was added to rule out button-press motion blur as a contributing factor — this shipped before the focus-distance finding, so its own marginal benefit (versus the distance fix alone) is unconfirmed.

## What's unverified on real hardware

This was all built and tested in a browser preview (see the `r1-creation` skill for why: no camera/mic in a headless preview browser). Specifically unconfirmed on the actual R1:
1. ~~Barcode (bar) capture reliability~~ — moot: bar decoding never worked on real hardware even after fixing resolution/capture/focus-distance, and was removed entirely (see "OCR-only scanning" above). Scanning is now OCR-only.
2. **OCR accuracy on small print** — confirmed working end-to-end on real hardware for a flat-labeled item (Zeiss lens wipes, `662834503500`), including recovering the correct value from a real, imperfect camera capture and correctly ignoring an unrelated printed code elsewhere on the package. Failed on a photographed-and-confirmed-real barcode (a 14-piece gum box, UPC-A `022000004840`) — OCR read `119 5 22 484 4 2`, catching fragments of the real digits (`22`, `484`) but garbling the rest. Small packaging like gum has a noticeably smaller printed barcode than something like the lens wipes box, and at the mandatory ~1-2ft scan distance that print becomes quite tiny in the captured frame - the leading theory, not yet confirmed. In response, removed an unnecessary downscale that was throwing away resolution for no real benefit: `OCR_MAX_DIMENSION` was capping every capture at 900px on the assumption `recognize()` needed that to stay fast, but real-device testing (`runDiagOcrRecognizeTest` in Diagnostics) showed `recognize()` only takes ~4s even at the camera's full ~2MP resolution - so it's now just a 2000px safety ceiling, not an active downscale. Removing the downscale alone still garbled the gum's digit line (though with visibly fewer wrong digits: `2 5 4 9 8`, versus `119 5 22 484 4 2` before) - looked more like OCR was only seeing *part* of the barcode than misreading the whole thing, which prompted also removing the `zoom: 2` constraint (see above). That combination still didn't fix it - the user directly diagnosed the real cause: the camera was picking up both the nutrition facts panel and the actual barcode at once, and Tesseract's own line-grouping was merging both into one recognized line. Fixed via `clusterWordsIntoRows()` (see "Extraction is scoped..." above) - verified against a synthetic reproduction of the exact layout, and the real barcode confirmed to actually exist in Open Food Facts (Orbit Spearmint Gum). Still needs a fresh real-device retest on the actual gum box to confirm this holds up outside the synthetic reproduction. The Deer Park water bottle failure mentioned in earlier notes was never root-caused (no debug text was captured that time) and remains open too - if it recurs, capture the recovery screen's debug line before changing anything.
   A curved/cylindrical label (a water bottle) warping the digit line is a separate, still-untested hypothesis from the small-print-size one above - don't conflate the two if both come up again.
3. **Voice entry accuracy** — does the Web Speech API even produce a `SpeechRecognition` instance in the R1's WebView, and if so, how accurate is it?
4. ~~Whether `getUserMedia` camera access continues to work reliably~~ — confirmed working: real-device testing got a live 1080×1920 stream.

## Original spec (condensed)

Core design principles: offline-first whenever possible; barcode scanning is the preferred input; AI only when necessary; every interaction operable with one hand; minimize typing; local storage works with no account; optional cloud sync later. Primary hardware: camera, scroll wheel, side button, microphone, speaker.

**Phase 1** (done): barcode scanner, local inventory, quantity management, Pantry location.
**Phase 2** (partially pulled forward — Vision AI and voice are done, with caveats above; OCR and expiration are not): OCR fallback from package photos, Vision AI fallback, voice entry, expiration tracking with "expiring today / this week / this month" notifications.
**Phase 3** (not started): shopping list (auto-generated from items flagged low/out-of-stock/frequently-purchased), recipes ("what can I cook?" using inventory + LLM, highlighting missing ingredients), statistics (most used, most wasted, average pantry value, monthly waste), multi-location inventory with a UI to create/switch custom locations beyond the default Pantry (Fridge, Freezer, Garage, Medicine Cabinet, Cleaning Supplies, Storage, Workshop, or user-defined).
**Phase 4** (not started): household sync, shared inventories, cloud backup, optional integrations.

Long-term vision: evolve from a pantry tracker into a full home inventory manager — one system for food, medicine, household supplies, tools, and storage bins, all using the same fast scan-first workflow.

Suggested data model from the original proposal (the actual shape in this codebase — see above — is very close, using `id` instead of relying on `barcode` alone since manual entries have no barcode):
```json
{
  "barcode": "041196910123",
  "productName": "Campbell's Tomato Soup",
  "brand": "Campbell's",
  "quantity": 4,
  "location": "Pantry",
  "expiration": "2028-05-01",
  "image": "...",
  "source": "OpenFoodFacts",
  "lastUpdated": "2026-07-03"
}
```
