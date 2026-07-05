# Pantry Pal — Project Handoff

Last updated: 2026-07-04. Repo: [github.com/travisbrant1-cyber/r1-pantry-pal](https://github.com/travisbrant1-cyber/r1-pantry-pal). Live: [travisbrant1-cyber.github.io/r1-pantry-pal](https://travisbrant1-cyber.github.io/r1-pantry-pal/). Install QR: `r1-creation-qr-codes/pantry-pal-qr.png` on the machine this was built on (not in this repo).

This is a **Rabbit R1 Creation** — a static HTML/CSS/JS app that runs full-screen on the R1 device. If you're picking this up fresh, also read the `r1-creation` skill (`~/.claude/skills/r1-creation/`) for the general R1 platform facts and deploy pipeline this project follows — this doc only covers what's specific to Pantry Pal.

## What this is

A home inventory tracker. Scan a barcode, it looks up the product and lets you log a quantity in a few seconds. Point of the whole exercise, from the original proposal: **"Scan once. Know what you have. Never buy it twice by accident."**

## Status: Phase 1 done, plus two Phase-2 items pulled forward

The original proposal (see "Original spec" below) defines four phases. What's actually built:

**Done:**
- Barcode scanning (tap-to-capture, not continuous — see "Why tap-to-capture" below)
- Real Open Food Facts API lookup, with local cache always overriding external lookup for a barcode already seen once
- Local inventory storage (`window.creationStorage.plain`, JSON blob, no account needed)
- Add / adjust-quantity / remove-entirely flows
- Manual entry (both as the "barcode not found" fallback and as its own direct Home menu item)
- Inventory browser + item detail view
- Fractional quantities (1/4, 1/2, 3/4) for bulk goods, via tap-to-toggle on any quantity field
- Vision AI attempt and Web Speech API voice entry as unknown-product recovery options (pulled forward from Phase 2 — see caveats below, these are real but weak)

**Not started** (still Phase 2–4 per the original roadmap, unchanged):
- OCR fallback, expiration tracking + notifications
- Shopping list, recipes, statistics, multi-location switching UI (the `location` field exists on every item and defaults to "Pantry", but there's no UI yet to create/switch locations)
- Household sync, shared inventories, cloud backup

## Architecture

Vanilla JS, no build step, no framework — one `index.html`, `css/styles.css`, `js/app.js`, plus a vendored barcode library at `js/vendor/zxing.min.js` (self-hosted rather than CDN-loaded, so scanning still works with no internet — see the SDK's offline-first principle).

**State machine**: a single `showView(name)` function toggles `.active` on nine view `<div>`s (home, scan, lookup, itemCard, recovery, status, manual, browse, detail). All navigation is scroll/click/hold/tap driven — see the in-app hint text on each screen for the current control mapping, it's kept in sync with behavior.

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

**Tap-to-capture instead of continuous video scanning.** The first version ran ZXing continuously against the live video feed. On the real device, camera setup (permission grant + stream init) takes real time, and the decode loop was only ever started once, at the exact moment of navigating into the Scan screen — so if the camera wasn't ready yet at that instant (very likely on first open), scanning silently never started. The user saw a live camera preview and assumed it was scanning; it wasn't. Rather than just patch the race (which was fixed once, in commit `cb6f4f9`), the whole approach was replaced: PTT click or a tap now captures one still frame and runs a single decode against it — simpler, more predictable, and matches the already-working Color Picker capture pattern. If barcode reliability is still an issue on real hardware, **this is the first place to look** — it's the one piece of this app that couldn't be fully verified without real camera/barcode hardware.

**Barcode lookup is cache-first, permanently.** Once a barcode has been identified by any method (API, Vision AI, voice, manual), it's saved locally and a future scan of the same barcode never touches the network or the LLM again — `findByBarcode()` runs before any lookup path. Verified live against a real product (Nutella, barcode `3017620422003`).

**Vision AI is real but weak — be honest about this with users.** There is no documented way to attach a captured photo to a `PluginMessageHandler` message. The "Try vision AI" recovery option genuinely sends a request, but it can only ask the LLM to guess a "common grocery product" with zero visual grounding — in practice this means either no response at all, or a generic guess unrelated to the actual photo. Any result routes through the same editable "verify" screen as manual entry, so nothing can silently save a wrong name — but don't expect this to actually work. It's there because it was explicitly requested as an experiment, not because it's expected to deliver value yet. If Rabbit ever documents real image support, this is the one function to revisit: `attemptVisionAI()` in `js/app.js`.

**Voice entry works but breaks "offline-first."** Uses the standard Web Speech API, which needs network access to a cloud STT provider — a deliberate, acknowledged exception to the spec's offline-first principle. Tested that it degrades gracefully (falls back to the recovery menu within ~1.5s on no-mic/no-speech rather than hanging) but real recognition accuracy on-device is unverified.

**Fractional quantities default to whole-number stepping, fractions are opt-in.** Scrolling normally steps by 1 (fast, matches the majority case — cans, boxes, bottles). Tapping the quantity number toggles a per-field mode that steps by 0.25 within [0, 1] instead (0, 1/4, 1/2, 3/4, 1), for bulk goods like flour where "how full is it" matters more than a count. This was a deliberate tradeoff over unifying the stepping into one scale — a single quarter-stepped scale would slow down the common case (0→6 cans would take 9 scroll clicks instead of 6). The tradeoff: you can't currently represent "1 and a quarter bags" — fraction mode tops out at 1 "full unit." Revisit if that turns out to matter in practice.

## Known bugs already found and fixed (for context, don't re-introduce)

- **Camera-ready race condition** (fixed in `cb6f4f9`, then made moot by the tap-to-capture rewrite): starting an async operation's continuation only from the triggering navigation event, not from whichever happens later (navigation vs. the async operation itself completing).
- **Recovery view 3px overflow** on the 240×282 frame: caught via `scrollHeight > clientHeight` checks in preview, not visible in a screenshot that happened to just barely fit. Every view still has `overflow-y: auto` as a safety net regardless — see the `r1-creation` skill's testing methodology for why bare pass/fail isn't enough margin.
- **Barcode capture downsampled to a fixed 160×120 canvas** (fixed in `b4bcb0f`): destroyed the fine bar spacing barcodes need to decode, regardless of distance or focus — would only ever work by luck. Capture now uses the camera's native resolution (`videoWidth`/`videoHeight`); a 160×120 thumbnail is still generated afterward, but only for the stored item photo, from the already-captured full-res frame.
- **GitHub Pages build got stuck in `"building"` for this repo** during real-hardware debugging — real content deployed correctly per `git push`, but the Pages build never advanced, so the live site kept serving stale code well after fixes had been pushed and looked like device-side caching at first. See the `r1-creation` skill's `deployment-pipeline.md` (stuck-build gotcha) — always verify the live URL actually changed before trusting a "fixed" report from real-hardware testing.

## R1 camera hardware facts (confirmed on real device)

- **Fixed-focus lens, sharp only from roughly 1–2 feet away.** Confirmed by holding a real barcode at varying distances while watching the live preview: it never sharpens at typical close scanning range (a few inches), only once backed off to about a foot or more. The scan hint text was updated to say this explicitly (`"Hold ~1-2ft back, click PTT"`) — don't revert that copy to anything implying close-range scanning without re-confirming this.
- A `zoom: 2` and `focusMode: 'continuous'` are requested as best-effort `advanced` getUserMedia constraints to help compensate for the barcode being smaller in-frame at that distance — unverified whether the R1's camera actually honors either; harmless no-op if unsupported.
- A settle delay (~300ms) plus a 3-frame decode burst was added to rule out button-press motion blur as a contributing factor — this shipped before the focus-distance finding, so its own marginal benefit (versus the distance fix alone) is unconfirmed.

## What's unverified on real hardware

This was all built and tested in a browser preview (see the `r1-creation` skill for why: no camera/mic in a headless preview browser). Specifically unconfirmed on the actual R1:
1. **Barcode capture reliability at the correct ~1-2ft distance** — the fixed-160×120-canvas bug and the too-close focus distance are both now identified and addressed; whether decoding is actually reliable once scanning from the right distance, with the current resolution/zoom/burst logic, still needs a fresh real-device retest.
2. **Voice entry accuracy** — does the Web Speech API even produce a `SpeechRecognition` instance in the R1's WebView, and if so, how accurate is it?
3. ~~Whether `getUserMedia` camera access continues to work reliably~~ — confirmed working: real-device testing got a live 1080×1920 stream.

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
