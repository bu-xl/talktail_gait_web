#!/usr/bin/env python3
"""
Turn a pressure-mat CSV (the format exported by the viewer, canine_gait style)
into a CORRECT gait heatmap GIF + a peak-pressure summary PNG.

Why this script exists
----------------------
The CSV stores RAW sensor counts (0..4095) and this mat is INVERTED:
**lower raw = higher pressure, unloaded ~= 4095.** If you plot the raw values
directly (e.g. matplotlib imshow with 'viridis'), the unpressed floor becomes the
brightest colour and the whole frame looks like yellow noise with specks - which
is useless for gait analysis. This script applies the same processing the live
viewer does:

    baseline (per-cell unloaded level)  ->  delta = baseline - raw  (inversion)
    -> noise dead-band + visible threshold  -> fixed colormap  -> upscale

so contact shows up hot on a dark background, and per-cell offsets / row banding
are removed by the baseline.

Usage
-----
    python3 csv_to_gait_gif.py recording.csv
    python3 csv_to_gait_gif.py recording.csv --out mydog --fps 20 --upscale 8

Outputs  <out>.gif  (animation)  and  <out>_peak.png  (max-pressure footprint).

Dependencies: numpy, Pillow.
"""
from __future__ import annotations

import argparse
import csv
import os
import re
import sys

import numpy as np
from PIL import Image

# Colormap stops (pressure fraction 0..1 -> RGB), matching the viewer.
_STOPS = [
    (0.00, (40, 60, 200)),   # blue   (light)
    (0.20, (0, 170, 220)),   # cyan
    (0.40, (40, 200, 90)),   # green
    (0.60, (240, 220, 40)),  # yellow
    (0.80, (245, 150, 30)),  # orange
    (1.00, (220, 30, 30)),   # red    (hard)
]
BACKGROUND = (10, 14, 20)


def _build_lut(n: int = 256) -> np.ndarray:
    """256x3 uint8 colormap LUT interpolated across the stops."""
    xs = [s[0] for s in _STOPS]
    cols = np.array([s[1] for s in _STOPS], dtype=float)
    out = np.zeros((n, 3), dtype=np.uint8)
    for i in range(n):
        t = i / (n - 1)
        j = np.searchsorted(xs, t, side="right") - 1
        j = max(0, min(len(_STOPS) - 2, j))
        span = xs[j + 1] - xs[j] or 1.0
        f = (t - xs[j]) / span
        out[i] = np.clip(cols[j] + (cols[j + 1] - cols[j]) * f, 0, 255).astype(np.uint8)
    return out


def load_csv(path: str) -> tuple[np.ndarray, np.ndarray, int, int]:
    """Return (raw[T,R,C], time[T], rows, cols) from a p_R_C CSV."""
    with open(path, newline="") as fh:
        reader = csv.reader(fh)
        header = next(reader)
        # Map p_{r}_{c} columns -> (index, r, c); auto-detect grid size.
        pcols: list[tuple[int, int, int]] = []
        time_idx = None
        for idx, name in enumerate(header):
            name = name.strip()
            if name == "time":
                time_idx = idx
            m = re.fullmatch(r"p_(\d+)_(\d+)", name)
            if m:
                pcols.append((idx, int(m.group(1)), int(m.group(2))))
        if not pcols:
            sys.exit("No p_R_C pressure columns found in the CSV header.")
        rows = max(r for _, r, _ in pcols) + 1
        cols = max(c for _, _, c in pcols) + 1

        raw_frames: list[np.ndarray] = []
        times: list[float] = []
        for line in reader:
            if not line or all(s.strip() == "" for s in line):
                continue
            grid = np.full((rows, cols), np.nan, dtype=float)
            for idx, r, c in pcols:
                try:
                    grid[r, c] = float(line[idx])
                except (ValueError, IndexError):
                    pass
            raw_frames.append(grid)
            if time_idx is not None and time_idx < len(line):
                try:
                    times.append(float(line[time_idx]))
                except ValueError:
                    times.append(len(times))
            else:
                times.append(len(times))

    raw = np.array(raw_frames, dtype=float)
    # Fill any missing cells with the unloaded ceiling so they read as no-contact.
    raw = np.where(np.isnan(raw), 4095.0, raw)
    return raw, np.array(times, dtype=float), rows, cols


def to_pressure(raw: np.ndarray, baseline_pct: float, deadband: float) -> np.ndarray:
    """raw[T,R,C] -> delta[T,R,C] (>=0), inverted and baseline-corrected."""
    # Per-cell unloaded level: a high percentile is robust to a few stuck-low
    # readings while still representing the no-load ceiling (~4095).
    baseline = np.percentile(raw, baseline_pct, axis=0)
    delta = baseline[None, :, :] - raw - deadband
    delta = np.clip(delta, 0.0, None)
    return delta


def colorize(
    delta: np.ndarray, lut: np.ndarray, vmax: float, vis_floor: float
) -> np.ndarray:
    """delta[T,R,C] -> rgb[T,R,C,3] uint8, composited over the dark background."""
    t = np.clip(delta / (vmax or 1.0), 0.0, 1.0)
    idx = np.clip((t * 255).round().astype(int), 0, 255)
    rgb = lut[idx]  # [T,R,C,3]
    visible = delta >= vis_floor
    bg = np.array(BACKGROUND, dtype=np.uint8)
    out = np.where(visible[..., None], rgb, bg)
    return out.astype(np.uint8)


def upscale(frame_rgb: np.ndarray, cell_w: int, cell_h: int) -> Image.Image:
    """Nearest-neighbour upscale; cells are 2.25x4.5cm so height doubles -> 1:2."""
    img = Image.fromarray(frame_rgb, mode="RGB")
    return img.resize((img.width * cell_w, img.height * cell_h), Image.NEAREST)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", help="input CSV (frame_id,time,p_0_0..)")
    ap.add_argument("--out", help="output prefix (default: input name)")
    ap.add_argument("--fps", type=float, default=0, help="GIF playback fps (0 = use CSV timing)")
    ap.add_argument("--baseline-pct", type=float, default=95.0, help="per-cell unloaded percentile")
    ap.add_argument("--deadband", type=float, default=30.0, help="raw-count dead-band (kills jitter)")
    ap.add_argument("--visible-frac", type=float, default=0.06, help="visible threshold as fraction of vmax")
    ap.add_argument("--vmax-pct", type=float, default=99.0, help="colour-scale top percentile of delta")
    ap.add_argument("--cell-w", type=int, default=6, help="px per cell horizontally")
    ap.add_argument("--cell-h", type=int, default=12, help="px per cell vertically (1:2 portrait)")
    args = ap.parse_args()

    out = args.out or os.path.splitext(args.csv)[0]
    raw, times, rows, cols = load_csv(args.csv)
    if raw.shape[0] == 0:
        sys.exit("CSV contained no frames.")

    delta = to_pressure(raw, args.baseline_pct, args.deadband)
    vmax = float(np.percentile(delta[delta > 0], args.vmax_pct)) if np.any(delta > 0) else 1.0
    vis_floor = max(1.0, args.visible_frac * vmax)
    lut = _build_lut()

    rgb = colorize(delta, lut, vmax, vis_floor)
    frames = [upscale(rgb[i], args.cell_w, args.cell_h) for i in range(rgb.shape[0])]

    # Frame delay: from CSV timing unless --fps given.
    if args.fps > 0:
        delay_ms = 1000.0 / args.fps
    elif len(times) > 1 and times[-1] > times[0]:
        delay_ms = 1000.0 * (times[-1] - times[0]) / (len(times) - 1)
    else:
        delay_ms = 40.0
    delay_ms = max(20.0, delay_ms)

    gif_path = out + ".gif"
    frames[0].save(
        gif_path, save_all=True, append_images=frames[1:],
        duration=delay_ms, loop=0, optimize=True, disposal=2,
    )

    # Peak (max-pressure) footprint over the whole recording.
    peak = delta.max(axis=0)
    peak_rgb = colorize(peak[None, ...], lut, vmax, vis_floor)[0]
    upscale(peak_rgb, args.cell_w, args.cell_h).save(out + "_peak.png")

    dur = (times[-1] - times[0]) if len(times) > 1 else 0.0
    active = int((peak >= vis_floor).sum())
    print(f"frames      : {rgb.shape[0]}  ({rows}x{cols} grid)")
    print(f"duration    : {dur:.2f} s  ->  delay {delay_ms:.1f} ms/frame")
    print(f"delta vmax  : {vmax:.0f} raw counts (top {args.vmax_pct:.0f}%)")
    print(f"visible thr : {vis_floor:.0f}  ->  peak contact cells: {active}")
    print(f"wrote       : {gif_path}")
    print(f"wrote       : {out}_peak.png")


if __name__ == "__main__":
    main()
