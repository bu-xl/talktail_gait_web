/**
 * The player's single clock.
 *
 * Every panel is driven from the ORIGINAL video's `requestVideoFrameCallback`
 * `mediaTime`, which is the presentation time of the frame the compositor is
 * about to show. `performance.now()`, `setInterval` and the `timeupdate` event
 * all drift away from what is actually on screen, so none of them is used as a
 * clock here.
 *
 * There is exactly one `<video>` in the player. Skeleton, angles and mat are
 * canvas renderers fed the same `tMaster`, which is what makes seeking and rate
 * changes cost nothing to keep in sync: there is no second timeline to correct.
 */

export interface Renderer {
  readonly name: string;
  /**
   * Draw the state at `tMasterNs`. Must be a pure function of the argument:
   * no internal timers, no `requestAnimationFrame`, no reading `video.currentTime`.
   */
  draw(tMasterNs: bigint): void;
  /**
   * Set by the renderer to the timestamp it actually drew. The clock compares it
   * against the value it handed out, which is how a renderer that grew its own
   * clock gets caught. Purely diagnostic.
   */
  lastDrawnNs?: bigint;
}

export type ClockMode = "rvfc" | "raf-fallback";

export interface MasterClockOptions {
  /** Session start on the master timeline. */
  t0Ns?: bigint;
  /** Video clock -> master clock offset. */
  videoOffsetNs?: bigint;
  onModeChange?(mode: ClockMode): void;
  /** A renderer threw. Show the failure on that panel only. */
  onRendererError?(name: string, error: unknown): void;
  /** Collect the tMaster agreement stats. Off in production. */
  debug?: boolean;
}

export interface ClockDebugStats {
  samples: number;
  /** Absolute |renderer tMaster - frame tMaster|, ns. Must be 0. */
  p50: number;
  p95: number;
  max: number;
  /** Renderers that ever reported a timestamp other than the one handed out. */
  disagreeing: string[];
}

interface VideoFrameMeta {
  mediaTime: number;
  presentedFrames: number;
}

type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback(cb: (now: number, meta: VideoFrameMeta) => void): number;
  cancelVideoFrameCallback(handle: number): void;
};

const MAX_CONSECUTIVE_FAILURES = 5;
const DEBUG_RING = 600;

export class MasterClock {
  private readonly renderers: Renderer[] = [];
  private readonly failures = new Map<string, number>();
  private readonly disabled = new Set<string>();
  private readonly disagreeing = new Set<string>();

  private readonly t0Ns: bigint;
  private videoOffsetNs: bigint;
  private readonly opts: MasterClockOptions;

  private handle = 0;
  private running = false;
  private readonly supportsRvfc: boolean;
  private lastMaster = 0n;

  private readonly deltas = new Float64Array(DEBUG_RING);
  private deltaCount = 0;

  private readonly onVisibility = (): void => {
    // rVFC stops firing in a background tab. On return, redraw from the real
    // mediaTime rather than trusting whatever the panels last painted.
    if (document.visibilityState === "visible") this.resync();
  };
  private readonly onSeeked = (): void => this.resync();

  constructor(
    private readonly video: HTMLVideoElement,
    options: MasterClockOptions = {},
  ) {
    this.opts = options;
    this.t0Ns = options.t0Ns ?? 0n;
    this.videoOffsetNs = options.videoOffsetNs ?? 0n;
    this.supportsRvfc =
      typeof (video as Partial<RvfcVideo>).requestVideoFrameCallback === "function";
  }

  get mode(): ClockMode {
    return this.supportsRvfc ? "rvfc" : "raf-fallback";
  }

  get lastMasterNs(): bigint {
    return this.lastMaster;
  }

  /** Master timestamp for the frame currently presented. */
  get currentMasterNs(): bigint {
    return this.toMaster(this.video.currentTime);
  }

  setVideoOffsetNs(offsetNs: bigint): void {
    this.videoOffsetNs = offsetNs;
    this.resync();
  }

  /** Register a renderer. Returns a disposer. */
  add(renderer: Renderer): () => void {
    this.renderers.push(renderer);
    return () => {
      const i = this.renderers.indexOf(renderer);
      if (i >= 0) this.renderers.splice(i, 1);
      this.failures.delete(renderer.name);
      this.disabled.delete(renderer.name);
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.opts.onModeChange?.(this.mode);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.video.addEventListener("seeked", this.onSeeked);
    this.schedule();
    // Paint once immediately so a paused player is not blank until the first frame.
    this.resync();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.video.removeEventListener("seeked", this.onSeeked);
    if (this.handle) {
      if (this.supportsRvfc) (this.video as RvfcVideo).cancelVideoFrameCallback(this.handle);
      else cancelAnimationFrame(this.handle);
    }
    this.handle = 0;
  }

  /** Redraw every renderer at the video's current position. */
  resync(): void {
    this.renderAt(this.toMaster(this.video.currentTime));
  }

  /**
   * Drive the renderers at an arbitrary master time.
   *
   * Used while scrubbing: the canvas panels update on the drag, and the video
   * catches up on its own, then `seeked` calls `resync()` to settle.
   */
  renderAt(tMasterNs: bigint): void {
    this.lastMaster = tMasterNs;
    for (const renderer of this.renderers) {
      if (this.disabled.has(renderer.name)) continue;
      try {
        renderer.lastDrawnNs = undefined;
        renderer.draw(tMasterNs);
        this.failures.set(renderer.name, 0);
        if (this.opts.debug) this.recordDelta(renderer, tMasterNs);
      } catch (error) {
        this.noteFailure(renderer, error);
      }
    }
  }

  debugStats(): ClockDebugStats {
    const n = Math.min(this.deltaCount, DEBUG_RING);
    if (n === 0) {
      return { samples: 0, p50: 0, p95: 0, max: 0, disagreeing: [...this.disagreeing] };
    }
    const sorted = Float64Array.from(this.deltas.subarray(0, n)).sort();
    return {
      samples: n,
      p50: sorted[Math.floor(n * 0.5)],
      p95: sorted[Math.min(n - 1, Math.floor(n * 0.95))],
      max: sorted[n - 1],
      disagreeing: [...this.disagreeing],
    };
  }

  private toMaster(mediaTimeSec: number): bigint {
    const safe = Number.isFinite(mediaTimeSec) ? mediaTimeSec : 0;
    return this.t0Ns + BigInt(Math.round(safe * 1e9)) + this.videoOffsetNs;
  }

  private schedule(): void {
    if (!this.running) return;
    if (this.supportsRvfc) {
      const video = this.video as RvfcVideo;
      this.handle = video.requestVideoFrameCallback((_now, meta) => {
        this.handle = 0;
        this.renderAt(this.toMaster(meta.mediaTime));
        this.schedule();
      });
      return;
    }
    // Fallback: `currentTime` lags the presented frame, so the caller shows a
    // badge telling the user this session's overlay alignment is approximate.
    this.handle = requestAnimationFrame(() => {
      this.handle = 0;
      this.renderAt(this.toMaster(this.video.currentTime));
      this.schedule();
    });
  }

  private recordDelta(renderer: Renderer, tMasterNs: bigint): void {
    if (renderer.lastDrawnNs === undefined) return;
    const delta = Number(
      renderer.lastDrawnNs > tMasterNs
        ? renderer.lastDrawnNs - tMasterNs
        : tMasterNs - renderer.lastDrawnNs,
    );
    if (delta !== 0) this.disagreeing.add(renderer.name);
    this.deltas[this.deltaCount % DEBUG_RING] = delta;
    this.deltaCount += 1;
  }

  private noteFailure(renderer: Renderer, error: unknown): void {
    const count = (this.failures.get(renderer.name) ?? 0) + 1;
    this.failures.set(renderer.name, count);
    this.opts.onRendererError?.(renderer.name, error);
    if (count >= MAX_CONSECUTIVE_FAILURES) {
      // Stop calling it, but never stop the other panels.
      this.disabled.add(renderer.name);
    }
  }
}
