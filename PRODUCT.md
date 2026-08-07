# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

<!-- Runs in two shells from one codebase: Chrome/Edge via Web Serial, and a
packaged Electron desktop app (node-serialport in the main process, IPC to the
renderer). The Electron build is a native wrapper around the web app, so the
design language is web, not native desktop. Distributed installers live in
`release/` (GaitPressureMat, Mac + Win64). -->

## Stack

Existing codebase — TypeScript + Vite (renderer), Electron (desktop shell),
dependency-free core (`serialport`, `gifenc` the only runtime deps). No UI
framework: `index.html` + `src/app/main.ts` drive the DOM directly. Reports and
exports (PDF/GIF/PNG/CSV/JSON) are generated in-house with no external libraries.

## Users

Primary: **veterinary clinicians and rehabilitation therapists** assessing a dog
during an appointment — reading per-paw load, symmetry, and balance to judge
lameness and recovery. They operate the mat and the app themselves at the point
of care, alongside the animal, often under time pressure.

## Product Purpose

A real-time canine gait and pressure-mat analysis tool. It turns a short walk
across a 40×40 USB-serial pressure mat into trustworthy, exportable measurement.
Four core jobs, all first-class:

1. **Dog gait analysis** — paw loading, gait cycle, symmetry, and balance during walking.
2. **Real-time pressure mapping** — live paw-pressure heatmap with automatic paw identification (LF/RF/LH/RH).
3. **Gait comparison** — compare multiple sessions to identify changes in gait over time.
4. **Research-grade data export** — accurate, reproducible gait measurement data for clinical and research use.

Success = a clinician trusts the numbers enough to act on them, and can hand a
clean report to a colleague, owner, or study.

## Positioning

Re-implements an original Qt6/C++ acquisition app as a modular, dependency-light
TypeScript pipeline where **live serial and file playback run the identical
pipeline**, so what you measure live is exactly what analysis and exports see.
The paw-identification and gait metrics reuse one real `paw-gait-engine`
(Hungarian tracking, contact hysteresis, footfall labeling, CoP-regression
direction) rather than a naive per-frame split — strictly more robust on this
coarse 40×40 mat. Honesty is part of the position: it never claims `mmHg`
without real calibration, never autoscales color per frame, and marks fore/hind
paw calls as best-estimate on this small grid.

## Operating Context

Point-of-care usage scene, dog present. Canonical flow in the UI:
**Calibrate** (dog off the mat, ~2 s baseline) → **● Record** the walk →
**■ Stop** → enter **dog weight (kg)** → **🐾 Analyze gait** → read inline
results and export. A live paw-label overlay (toggleable) runs on every incoming
frame once calibrated, with a WARMING UP… / TRACKING → header and a `?` cold
start. No device present → **Replay file** loads a saved recording through the
same pipeline. Serial link is USB, 3,000,000 baud, 3206-byte frames.

## Capabilities and Constraints

- **Hardware:** 40×40 mat, non-square cells (1.825 cm × 4.2 cm pitch) → 73×168 cm
  active area, portrait **1 : 2.3014** aspect. Render paths derive height from
  width via `MAT_ASPECT` — **never square**. Raw is 12-bit, inverted (lower raw =
  higher pressure; unloaded ≈ 4095).
- **Units:** reports a relative unit (`rel`) by default; only real
  piecewise-linear coefficients + a baseline yield `mmHg` (`calibrated`). Never
  fabricate `mmHg`.
- **Color:** fixed blue→red LUT, fixed colorbar `[10,80]`; cells `<10` are fully
  transparent and excluded from stats. Thresholding happens before smoothing/blur.
- **Live paw ID:** L/R is reliable (fixed by walk direction); F/H is a real-time
  guess on this small mat, shown faint (e.g. `R~F`). Recorded exports back-apply
  each paw's authoritative final label so outputs don't flicker or disagree.
- **Exports:** Report CSV, one-page Report PDF (Korean-capable), Report JSON,
  annotated looping GIF, peak Heatmap PNG, raw pressure CSV, per-paw Paw CSV.
- **Config-driven:** `config.json` owns formula, coefficients, ranges,
  thresholds, orientation, smoothing, render, gait tuning, and paw-overlay
  quality gates. Gait-engine defaults assume a denser grid, so `min_paw_area` /
  `max_track_distance` are lowered and delta is adaptively normalized for this mat.
- **Terminology:** uncalibrated / calibrated; rel vs mmHg; LF · RF · LH · RH;
  stance, impulse, cadence, symmetry, fore/hind load, double support, COP.

## Brand Commitments

- **Name / author:** TalkTail. App/product name **GaitPressureMat**; window title
  **보행 분석 (Gait Analysis)**. `appId com.talktail.gait-pressure-mat`.
- **Bilingual, equal priority:** Korean and English are both first-class; neither
  leads. Language toggle (한국어 / English) is a permanent UI affordance, and all
  reports/exports must render Korean correctly.

## Evidence on Hand

- **Real, confirmed device protocol** (header `5A 01 95 6C 00 02`, 3206-byte
  frames, verified against a captured sample) — see `README.md`.
- **41 tests** covering the hard parts: serial resync, chunk≠frame buffering,
  little-endian decode, baseline median, unit honesty, stats buckets, playback
  round-trip, a synthetic 4-paw VALID gait trial, and the PDF writer — `tests/`.
- **Shipping installers** in `release/` (Mac arm64, Win64).
- No customer testimonials, benchmarks, pricing, or clinical-validation claims
  are on hand — future work must not fabricate them.

## Product Principles

1. **One pipeline, one truth.** Live and playback run identical code; what you
   see is what analysis and exports compute.
2. **Never overclaim the measurement.** No `mmHg` without calibration, no
   per-frame autoscale, fore/hind marked as estimate — trust is the product.
3. **Respect the real shape.** Non-square cells, portrait 1:2.3014, never square;
   footprints keep their true geometry everywhere.
4. **Clinician-operable at the point of care.** The Calibrate → Record → Weight →
   Analyze flow must stay legible and fast with a dog on the mat.
5. **Reproducible and exportable.** Every result leaves as a clean report a
   colleague or study can rely on.

## Accessibility & Inclusion

Bilingual Korean/English is a hard requirement (UI and all exported reports).
No other product-specific accessibility standard has been established yet.
