/**
 * In-memory session recorder for gait analysis.
 *
 * Captures the RAW 40x40 frames (0..4095, exactly as the serial parser produced
 * them, before orientation/calibration) together with a millisecond timestamp.
 * Keeping only raw frames makes raw the single source of truth: the CSV export,
 * the heatmap GIF and the summary PNG are all derived from the same data, so they
 * are guaranteed consistent.
 */

import type { Matrix } from "./types.js";

export interface RecordedFrame {
  /** Milliseconds since recording started. */
  t: number;
  /** Row-major 40x40 raw matrix (copied, so later mutation can't corrupt it). */
  raw: Matrix;
}

export class SessionRecorder {
  private frames: RecordedFrame[] = [];
  private recording = false;
  private startedAt = 0;

  /** Begin a fresh recording (clears any previous buffer). */
  start(nowMs: number = now()): void {
    this.frames = [];
    this.recording = true;
    this.startedAt = nowMs;
  }

  /** Stop recording; the buffer is retained for export/replay. */
  stop(): void {
    this.recording = false;
  }

  get isRecording(): boolean {
    return this.recording;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** Duration of the captured span in seconds (0 if <2 frames). */
  get durationSec(): number {
    if (this.frames.length < 2) return 0;
    return (this.frames[this.frames.length - 1].t - this.frames[0].t) / 1000;
  }

  /** Mean capture rate (Hz) over the recording, or 0 if not measurable. */
  get fps(): number {
    const d = this.durationSec;
    return d > 0 ? (this.frames.length - 1) / d : 0;
  }

  /** Append one raw frame while recording (ignored otherwise). Copies the data. */
  add(raw: Matrix, nowMs: number = now()): void {
    if (!this.recording) return;
    this.frames.push({ t: nowMs - this.startedAt, raw: Float64Array.from(raw) });
  }

  /** Ordered snapshot of recorded frames (not a copy of the matrices). */
  getFrames(): readonly RecordedFrame[] {
    return this.frames;
  }

  /** Just the raw matrices, in order (for re-processing/export). */
  getRawFrames(): Matrix[] {
    return this.frames.map((f) => f.raw);
  }

  clear(): void {
    this.frames = [];
    this.recording = false;
    this.startedAt = 0;
  }
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
