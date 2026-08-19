import assert from "node:assert/strict";
import { test } from "node:test";

import { MasterClock } from "../src/player/masterClock.js";
import type { Renderer } from "../src/player/masterClock.js";

type Listener = () => void;

/** Minimal stand-ins so the clock can be exercised without a browser. */
class FakeVideo {
  currentTime = 0;
  private frameCb: ((now: number, meta: { mediaTime: number; presentedFrames: number }) => void) | null = null;
  private nextHandle = 1;
  private readonly listeners = new Map<string, Set<Listener>>();
  presentedFrames = 0;

  constructor(private readonly supportsRvfc = true) {
    if (!supportsRvfc) {
      (this as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback = undefined;
    }
  }

  requestVideoFrameCallback(
    cb: (now: number, meta: { mediaTime: number; presentedFrames: number }) => void,
  ): number {
    if (!this.supportsRvfc) throw new Error("unsupported");
    this.frameCb = cb;
    return this.nextHandle++;
  }

  cancelVideoFrameCallback(): void {
    this.frameCb = null;
  }

  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  emit(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }

  /** Present one frame at `mediaTime` seconds. */
  presentFrame(mediaTime: number): void {
    this.currentTime = mediaTime;
    this.presentedFrames += 1;
    const cb = this.frameCb;
    this.frameCb = null;
    cb?.(0, { mediaTime, presentedFrames: this.presentedFrames });
  }

  get hasPendingFrameCallback(): boolean {
    return this.frameCb !== null;
  }
}

function withFakeDom<T>(fn: (raf: { flush(): void }) => T): T {
  const g = globalThis as Record<string, unknown>;
  const saved = {
    document: g.document,
    requestAnimationFrame: g.requestAnimationFrame,
    cancelAnimationFrame: g.cancelAnimationFrame,
  };
  const docListeners = new Map<string, Set<Listener>>();
  let pending: Listener | null = null;

  g.document = {
    visibilityState: "visible",
    addEventListener(type: string, l: Listener) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type)!.add(l);
    },
    removeEventListener(type: string, l: Listener) {
      docListeners.get(type)?.delete(l);
    },
    emit(type: string) {
      for (const l of docListeners.get(type) ?? []) l();
    },
  };
  g.requestAnimationFrame = (cb: Listener): number => {
    pending = cb;
    return 1;
  };
  g.cancelAnimationFrame = (): void => {
    pending = null;
  };

  try {
    return fn({
      flush() {
        const cb = pending;
        pending = null;
        cb?.();
      },
    });
  } finally {
    g.document = saved.document;
    g.requestAnimationFrame = saved.requestAnimationFrame;
    g.cancelAnimationFrame = saved.cancelAnimationFrame;
  }
}

/** Renderer that records what it was told and echoes it back for the audit. */
function recorder(name: string, log: Array<[string, bigint]>): Renderer {
  return {
    name,
    lastDrawnNs: undefined,
    draw(t) {
      log.push([name, t]);
      this.lastDrawnNs = t;
    },
  };
}

test("every renderer in a frame is handed the identical tMaster", () => {
  withFakeDom(() => {
    const video = new FakeVideo();
    const log: Array<[string, bigint]> = [];
    const clock = new MasterClock(video as unknown as HTMLVideoElement, { debug: true });
    clock.add(recorder("mat", log));
    clock.add(recorder("skeleton", log));
    clock.add(recorder("angles", log));
    clock.start();
    log.length = 0;

    video.presentFrame(1.5);
    assert.equal(log.length, 3);
    const times = new Set(log.map(([, t]) => t));
    assert.equal(times.size, 1, "renderers disagreed on tMaster");
    assert.equal(log[0][1], BigInt(1.5e9));

    clock.stop();
  });
});

test("tMaster is t0 plus mediaTime plus the video offset", () => {
  withFakeDom(() => {
    const video = new FakeVideo();
    const log: Array<[string, bigint]> = [];
    const clock = new MasterClock(video as unknown as HTMLVideoElement, {
      t0Ns: 1_000_000_000_000n,
      videoOffsetNs: 250_000_000n,
    });
    clock.add(recorder("mat", log));
    clock.start();
    log.length = 0;

    video.presentFrame(2);
    assert.equal(log[0][1], 1_000_000_000_000n + 2_000_000_000n + 250_000_000n);
    clock.stop();
  });
});

test("debug stats stay at zero because there is only one clock", () => {
  withFakeDom(() => {
    const video = new FakeVideo();
    const log: Array<[string, bigint]> = [];
    const clock = new MasterClock(video as unknown as HTMLVideoElement, { debug: true });
    clock.add(recorder("mat", log));
    clock.add(recorder("angles", log));
    clock.start();

    for (let i = 1; i <= 60; i++) video.presentFrame(i / 30);

    const stats = clock.debugStats();
    assert.ok(stats.samples > 0);
    assert.equal(stats.p50, 0);
    assert.equal(stats.p95, 0);
    assert.equal(stats.max, 0);
    assert.deepEqual(stats.disagreeing, []);
    clock.stop();
  });
});

test("a renderer that invents its own clock is named in the debug stats", () => {
  withFakeDom(() => {
    const video = new FakeVideo();
    const clock = new MasterClock(video as unknown as HTMLVideoElement, { debug: true });
    clock.add({
      name: "rogue",
      lastDrawnNs: undefined,
      draw(t) {
        // Simulates a renderer that snapped to its own nearest sample instead of
        // drawing the timestamp it was given.
        this.lastDrawnNs = t + 4_000_000n;
      },
    });
    clock.start();
    for (let i = 1; i <= 10; i++) video.presentFrame(i / 30);

    const stats = clock.debugStats();
    assert.deepEqual(stats.disagreeing, ["rogue"]);
    assert.equal(stats.p50, 4_000_000);
    clock.stop();
  });
});

test("one renderer throwing does not stop the others", () => {
  withFakeDom(() => {
    const video = new FakeVideo();
    const log: Array<[string, bigint]> = [];
    const errors: string[] = [];
    const clock = new MasterClock(video as unknown as HTMLVideoElement, {
      onRendererError: (name) => errors.push(name),
    });
    clock.add({
      name: "broken",
      draw() {
        throw new Error("mat track is corrupt");
      },
    });
    clock.add(recorder("angles", log));
    // start() paints once immediately, so that draw counts toward both tallies.
    clock.start();

    for (let i = 1; i <= 8; i++) video.presentFrame(i / 30);

    assert.equal(log.length, 9, "the healthy renderer must keep drawing every frame");
    // Reported once per failed draw until it is given up on, then never again.
    assert.equal(errors.length, 5, `expected 5 reports before disabling, got ${errors.length}`);
    assert.ok(errors.every((n) => n === "broken"));
    clock.stop();
  });
});

test("falls back to rAF and reports the mode when rVFC is unavailable", () => {
  withFakeDom((raf) => {
    const video = new FakeVideo(false);
    const log: Array<[string, bigint]> = [];
    const modes: string[] = [];
    const clock = new MasterClock(video as unknown as HTMLVideoElement, {
      onModeChange: (m) => modes.push(m),
    });
    clock.add(recorder("mat", log));
    clock.start();
    assert.deepEqual(modes, ["raf-fallback"]);
    assert.equal(clock.mode, "raf-fallback");

    log.length = 0;
    video.currentTime = 0.5;
    raf.flush();
    assert.equal(log.length, 1);
    assert.equal(log[0][1], 500_000_000n);
    clock.stop();
  });
});

test("returning to the tab forces a redraw from the real mediaTime", () => {
  withFakeDom(() => {
    const video = new FakeVideo();
    const log: Array<[string, bigint]> = [];
    const clock = new MasterClock(video as unknown as HTMLVideoElement, {});
    clock.add(recorder("mat", log));
    clock.start();

    // The tab was hidden: rVFC stopped, and the video moved on without us.
    video.currentTime = 12.25;
    log.length = 0;
    (globalThis as unknown as { document: { emit(t: string): void } }).document.emit(
      "visibilitychange",
    );

    assert.equal(log.length, 1, "expected a forced resync on return");
    assert.equal(log[0][1], 12_250_000_000n);
    clock.stop();
  });
});

test("seeking settles the panels on the seeked position", () => {
  withFakeDom(() => {
    const video = new FakeVideo();
    const log: Array<[string, bigint]> = [];
    const clock = new MasterClock(video as unknown as HTMLVideoElement, {});
    clock.add(recorder("mat", log));
    clock.start();

    video.currentTime = 4;
    log.length = 0;
    video.emit("seeked");
    assert.equal(log[0][1], 4_000_000_000n);
    clock.stop();
  });
});

test("renderAt drives the panels ahead of the video, for scrubbing", () => {
  withFakeDom(() => {
    const video = new FakeVideo();
    const log: Array<[string, bigint]> = [];
    const clock = new MasterClock(video as unknown as HTMLVideoElement, {});
    clock.add(recorder("mat", log));
    clock.start();
    log.length = 0;

    // The user is dragging: panels update now, the video has not seeked yet.
    clock.renderAt(7_500_000_000n);
    assert.equal(log[0][1], 7_500_000_000n);
    assert.equal(clock.lastMasterNs, 7_500_000_000n);
    assert.equal(video.currentTime, 0, "scrub preview must not touch the video");
    clock.stop();
  });
});

test("stop() detaches listeners and stops scheduling", () => {
  withFakeDom(() => {
    const video = new FakeVideo();
    const log: Array<[string, bigint]> = [];
    const clock = new MasterClock(video as unknown as HTMLVideoElement, {});
    clock.add(recorder("mat", log));
    clock.start();
    clock.stop();

    log.length = 0;
    assert.equal(video.hasPendingFrameCallback, false);
    video.emit("seeked");
    (globalThis as unknown as { document: { emit(t: string): void } }).document.emit(
      "visibilitychange",
    );
    assert.equal(log.length, 0, "a stopped clock must not draw");
  });
});
