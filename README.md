# Pressure Mat Viewer (gait-pressure-viewer)

Real-time heatmap viewer for a **40×40 USB-Serial pressure mat**. The cells are
**non-square** — measured pitch **1.825 cm (col) × 4.2 cm (row)** — so the active
area is **73 × 168 cm**, a portrait **1 : 2.3014** aspect (not 1:2; never square).
Every render path derives its output height from the width via `MAT_ASPECT`, so
footprints keep their true shape. It re-implements the original Qt6/C++
acquisition app as a modular TypeScript pipeline that runs in the browser (Web
Serial) or in Electron (node-serialport in the main process).

## Protocol (confirmed)

| Field | Value |
|---|---|
| Transport | USB Serial / COM |
| Baud | **3,000,000**, 8-N-1 |
| Frame header | `5A 01 95 6C 00 02` |
| Frame size | **3206 bytes** (6 header + 3200 payload) |
| Payload | 1600 × little-endian `uint16` |
| Grid | **40 × 40** (row-major) |
| Raw range | 0–4095 (12-bit) — **lower raw = higher pressure**; unloaded ≈ 4095 |

The pasted sample confirms this: `ff 0f` → LE `0x0FFF` = **4095** (unloaded),
`c6 0f` = 4038, `a8 0f` = 4008 (slightly loaded).

## Pipeline

```
serial bytes ──▶ SerialFrameParser ──▶ raw 40×40 ──▶ orientation
   ──▶ PressureCalibrator (baseline → delta → mmHg/relative → threshold)
   ──▶ TemporalSmoother (EMA) ──▶ stats + HeatmapRenderer (upsample → blur → colormap)
```

Live serial **and** file playback run this *identical* pipeline.

## Modules (deliverables)

| File | Responsibility |
|---|---|
| `src/core/serialParser.ts` | `appendChunk`, header find, **resync** (drop garbage, keep partial header), `extractFrames`, `parseFrameToRawMatrix` — never assumes chunk == frame |
| `src/core/pressureCalibrator.ts` | `buildBaseline` (per-cell median), `rawToDelta` (`max(0, baseline−raw)`), `deltaToMmHg` (piecewise/linear/relative), `applyThreshold` |
| `src/core/stats.ts` | max / avg / contact / 30–50 / >50 areas (× 10.125 cm²) + FPS meter |
| `src/core/playbackParser.ts` | parse/serialize the `timestamp:` + 40×40 saved format |
| `src/core/smoothing.ts` | EMA (α 0.45, →0.6 on rising), 300 ms fade-out |
| `src/render/heatmapRenderer.ts` | 1:2.3014 canvas, NaN-aware upsample + Gaussian blur, **fixed** colorbar `[10,80]`, transparent `<10` |
| `src/render/colormap.ts` `interpolation.ts` | fixed blue→cyan→green→yellow→orange→red LUT; bilinear + separable Gaussian |
| `src/transport/*` | `webSerialSource` (browser), `ipcSource` + `electron/main.ts` (Electron), `replaySource` (playback) |
| `config.json` | formula, coefficients, ranges, thresholds, orientation, smoothing, render |

## Calibration & safety

* Baseline = per-cell **median** of 1–3 s of unloaded frames. Until built, a
  fallback of 4095 is used and the UI shows **“uncalibrated”**.
* `formula: "relative"` (default) and `"linear_scale"` (test) report a *relative*
  unit labelled **`rel`** — never `mmHg`. Only `formula: "piecewise_linear"` with
  real coefficients + a baseline reports **`mmHg`** (`calibrated`).
* `< visible_min_mmhg` (10) cells are set to NaN → excluded from stats and fully
  transparent. Thresholding happens **before** smoothing/blur, so soft edges
  never reintroduce sub-threshold bleed.

## Gait analysis (canine)

The viewer also runs a full **canine gait analysis** on a recorded session — a
direct port of the standalone `paw-gait-engine` (Preprocessing → Contact →
Tracking → Direction → Labeling → ValidTrial → Features), tuned for this 40×40
mat. The engine itself is unchanged and lives in `src/gait/`.

Flow in the UI: **Calibrate** (dog off mat) → **● Record** the walk → **■ Stop**
→ enter the **dog weight (kg)** → **🐾 Analyze gait**. Results show inline
(validity, walking direction, per-paw load %, fore/hind balance, left/right
symmetry, per-paw peak/impulse/area/steps) and export as **Report CSV** and a
one-page **Report PDF**.

### Paw-label overlay (LF / RF / LH / RH)

The same engine drives a **paw-identification overlay** so you can see *which*
paw is which while you work:

* **Live** — once calibrated, the engine runs on every incoming frame (online,
  no future frames) and the heatmap shows a coloured box + centre cross + label +
  peak pressure per paw (LF blue · RF red · LH cyan · RH orange). The label
  encodes confidence: the **L/R letter is solid (reliable)**, the **F/H letter is
  faint and separated by `~`** (e.g. `R~F`) because fore/hind is a real-time
  *guess* on this small mat. **Cold-start:** a real contact shows grey **`?`**
  until the walk direction is established, then snaps to its paw label (locked, so
  it never flickers). A small header shows **WARMING UP… / TRACKING →**. Toggle
  with **🐾 Labels**; a transparent `#overlay` canvas keeps labels crisp.
* **Recorded exports** — after a recording the whole walk is analysed once (the
  authoritative pass), and each paw's final L/R + F/H label is back-applied to
  every frame, so all outputs agree and don't flicker:
  * **GIF** — annotated, looping heatmap (boxes + labels + `t/frame/paws` header).
  * **Heatmap PNG** — peak footprint with one label per paw.
  * **Paw CSV** — per-frame, per-paw rows: `frame,time_s,track_id,paw,confidence,
    row,col,peak,force,area,bbox_*` (the raw `p_R_C` pressure CSV is still
    available separately).

**Only real contacts are annotated.** Quality gates (in `config.json` →
`paw_overlay`) keep noise/weak/momentary touches from being boxed: a paw is drawn
only while it is actually in contact (engine hysteresis), with enough area
(`min_contact_area`), enough pressure (`min_contact_peak_frac` of the engine
target), once it has persisted (`min_track_frames`), and — in recordings — only
during a stance that lasts `min_contact_sec`. Loosen them for very light paws,
tighten them to be stricter. Other knobs: GIF/PNG size, frame cap, live
adaptive-scale (`live_min_peak`).

L/R is reliable (fixed by the product's walk direction); F/H is a best estimate
on this small 40×40 mat. The labelling reuses the existing `src/gait` engine
(Hungarian tracking, contact hysteresis, footfall labelling, CoP-regression
direction) — strictly more robust than a per-frame median split.

| File | Responsibility |
|---|---|
| `src/gait/overlayModel.ts` | pure per-frame "what to draw" model (session/live/peak builders, colours, bbox stats) |
| `src/render/pawOverlayRenderer.ts` | canvas-agnostic box/cross/label/header drawing (browser + headless) |
| `src/core/livePawTracker.ts` | live engine wrapper: inverted-delta + online adaptive scale, empty-mat reset |
| `src/core/pawTracking.ts` | recording → final-label overlay frames + peak field + summary |
| `src/export/annotatedExport.ts` | annotated GIF + peak PNG (stable colormap-plus-overlay palette) |
| `src/export/pawTrackCsv.ts` | per-frame paw-tracking CSV |

| File | Responsibility |
|---|---|
| `src/gait/*` | ported, dependency-free paw-gait-engine (72×80→40×40 configurable) |
| `src/core/gaitAnalysis.ts` | adapter: recorded raw → baseline-subtracted **delta** (the engine wants positive-going pressure; this mat is inverted), **adaptive** magnitude normalisation, 40×40 geometry + weight config, panel-ready summary |
| `src/export/gaitReportCsv.ts` | overview + per-paw metrics CSV |
| `src/export/gaitReportPdf.ts` `jpegPdf.ts` | renders the report on a canvas (Korean-capable) → JPEG → minimal one-page PDF, no deps |
| `config.json` → `gait` | grid, `min_paw_area`, `max_track_distance`, morphology, **adaptive normalisation** (`normalize_target_peak`/`_percentile`, or a fixed `pressure_scale`), default weight |

Tuning notes: the engine defaults assume a denser 72×80 grid and ~200-count
loaded cells. On this mat a small-dog paw covers only a few of the large 40×40
cells, so `min_paw_area`/`max_track_distance` are lowered; and because the raw is
inverted with a hardware-specific range, the delta is **adaptively scaled** so
the engine's magnitude thresholds stay meaningful on any sensor. Both are
overridable in `config.json`.

## Run

```bash
npm install

# Browser (Chrome/Edge — Web Serial). Click “Connect”, pick the COM port.
npm run dev            # http://localhost:5173

# Electron (serialport in main process, IPC to renderer):
npm run electron

# No device? Click “Replay file” and load a saved recording.
```

Recommended order in the UI: **Calibrate** (stand off the mat for ~2 s) → step on.

## Tests

```bash
npm test     # node --import tsx --test
```

41 tests cover the hard parts: header resync, multi-frame buffers, chunk
accumulation, partial-header preservation, little-endian decoding, baseline
median, delta/threshold, piecewise vs relative units, stats buckets, playback
round-trip, the smoothed field staying transparent away from contact, plus the
**gait** path — a synthetic 40×40 4-paw walk yielding a VALID trial with all
four paws and the correct direction, adaptive normalisation, empty/short-session
guards, and the one-page PDF writer (valid container + verbatim image embed).

## Hard rules enforced

- ✅ chunk ≠ frame (buffer + resync)
- ✅ fixed color scale (no per-frame autoscale flicker)
- ✅ `<10` never coloured (alpha 0)
- ✅ never claims `mmHg` without calibration
- ✅ raw is never used directly as colour
- ✅ never a square — non-square cells → **73×168 cm = 1:2.3014** (height = width × `MAT_ASPECT`)
