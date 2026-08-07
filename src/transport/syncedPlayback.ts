/**
 * AI 결과 영상(currentTime)과 매트 녹화 프레임(t ms)을 같은 타임라인으로 재생.
 */

import type { Matrix } from "../core/types.js";
import type { RecordedFrame } from "../core/recorder.js";

export type FrameSink = (raw: Matrix, tMs: number) => void;

export class SyncedMatVideoPlayback {
  private frames: readonly RecordedFrame[] = [];
  private video: HTMLVideoElement | null = null;
  private onFrame: FrameSink = () => {};
  private onEnded: (() => void) | null = null;
  private raf = 0;
  private lastIdx = -1;
  private running = false;
  private loop = true;

  start(
    frames: readonly RecordedFrame[],
    video: HTMLVideoElement,
    onFrame: FrameSink,
    opts?: { loop?: boolean; onEnded?: () => void },
  ): void {
    this.stop();
    this.frames = frames;
    this.video = video;
    this.onFrame = onFrame;
    this.onEnded = opts?.onEnded ?? null;
    this.loop = opts?.loop ?? true;
    this.lastIdx = -1;
    this.running = true;

    if (frames.length > 0) {
      this.lastIdx = 0;
      onFrame(frames[0].raw, frames[0].t);
    }

    video.loop = this.loop;
    video.currentTime = 0;
    if (video.paused) {
      void video.play().catch((error: unknown) => {
        if (
          typeof DOMException !== "undefined" &&
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          return;
        }
        /* autoplay may require user gesture */
      });
    }

    const tick = (): void => {
      if (!this.running || !this.video) return;
      if (this.video.paused && !this.video.ended) {
        this.raf = requestAnimationFrame(tick);
        return;
      }
      const tMs = this.video.currentTime * 1000;
      const idx = findFrameIndex(this.frames, tMs);
      if (idx >= 0 && idx !== this.lastIdx) {
        this.lastIdx = idx;
        this.onFrame(this.frames[idx].raw, this.frames[idx].t);
      }
      if (this.video.ended && !this.loop) {
        this.running = false;
        this.onEnded?.();
        return;
      }
      if (this.video.ended && this.loop) {
        this.lastIdx = -1;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Force the next tick to re-emit the mat frame (after scrub/seek). */
  invalidateCache(): void {
    this.lastIdx = -1;
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.video) {
      try {
        this.video.pause();
      } catch {
        /* ignore */
      }
    }
    this.video = null;
    this.lastIdx = -1;
  }

  get isRunning(): boolean {
    return this.running;
  }
}

/** Largest index with frame.t <= tMs (binary search). */
function findFrameIndex(frames: readonly RecordedFrame[], tMs: number): number {
  if (frames.length === 0) return -1;
  let lo = 0;
  let hi = frames.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].t <= tMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
