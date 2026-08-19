/**
 * Loads session artifacts into player tracks.
 *
 * Tracks are emitted as each one lands. The caller starts the video immediately
 * and switches panels on as their data arrives; nothing waits for the whole set.
 * A track that fails to load reports why and leaves the rest running.
 */

import { SENSOR_COUNT } from "../core/constants.js";
import { parseKeypointsJson, parsePressureCsv, regularGapThresholdNs } from "./parse.js";
import type { KeypointDoc } from "./parse.js";
import type { ParseRequest, ParseResponse, PosePayload, PressurePayload } from "./parseWorker.js";
import { ANGLE_STRIDE } from "./skeletonSchema.js";
import { SampleTrack } from "./track.js";

export interface MatTracks {
  /** RAW ADC counts, stride 1600. Unloaded is high; the renderer inverts. */
  raw: SampleTrack;
  /** Total load per frame, stride 1. Drives the timeline curve. */
  total: SampleTrack;
  /** Per-cell unloaded reference, RAW counts. */
  baseline: Float32Array;
  /** Largest single-cell load in the session; fixes the colour scale. */
  loadMax: number;
  rows: number;
  cols: number;
}

export interface PoseTracks {
  /** `[x, y, conf]` per slot, original-resolution pixels. */
  pose: SampleTrack;
  /** 16 joint angles then 16 confidence floors. */
  angles: SampleTrack;
  slots: number;
  /** Frame size the coordinates are expressed in. */
  width: number;
  height: number;
  limbChains: Record<string, number[]> | null;
  totalFrames: number;
  detectedFrames: number;
  periodNs: number;
}

export type TrackKey = "mat" | "pose";

export interface PlayerSources {
  pressureCsvUrl?: string | null;
  keypointsUrl?: string | null;
  /**
   * Mat clock -> video clock offset, ns. Positive means the mat recording
   * started after the video. Comes from the clapper/calibration marker.
   */
  matOffsetNs?: bigint;
}

export interface TrackLoaderEvents {
  onMat?(tracks: MatTracks): void;
  onPose?(tracks: PoseTracks): void;
  /**
   * Called with a message that says what failed and what to do about it.
   * Never a bare "an error occurred".
   */
  onFailed?(key: TrackKey, message: string): void;
  /** Fired once every requested track has either landed or failed. */
  onSettled?(): void;
}

export class TrackLoader {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, TrackKey>();
  private disposed = false;
  private outstanding = 0;
  private settled = false;

  constructor(private readonly events: TrackLoaderEvents = {}) {}

  /**
   * Kick off every source in parallel. Returns immediately: the caller should
   * start the video rather than await anything here.
   */
  start(sources: PlayerSources): void {
    this.settled = false;
    const requests: ParseRequest[] = [];
    if (sources.pressureCsvUrl) {
      requests.push({ id: this.nextId++, kind: "pressure", url: sources.pressureCsvUrl });
    }
    if (sources.keypointsUrl) {
      requests.push({ id: this.nextId++, kind: "pose", url: sources.keypointsUrl });
    }
    this.outstanding = requests.length;
    if (this.outstanding === 0) {
      this.markSettled();
      return;
    }

    const matOffsetNs = sources.matOffsetNs ?? 0n;
    const worker = this.ensureWorker(matOffsetNs);
    for (const req of requests) {
      this.pending.set(req.id, req.kind === "pressure" ? "mat" : "pose");
      if (worker) worker.postMessage(req);
      else void this.runInline(req, matOffsetNs);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(matOffsetNs: bigint): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined") return null;
    try {
      // Vite's worker plugin resolves this against the real source file, so it
      // must name the .ts entry rather than the .js the other imports use.
      const worker = new Worker(new URL("./parseWorker.ts", import.meta.url), { type: "module" });
      worker.addEventListener("message", (event: MessageEvent<ParseResponse>) => {
        this.handleResponse(event.data, matOffsetNs);
      });
      worker.addEventListener("error", (event) => {
        // The worker itself died; every request it held is lost.
        for (const key of this.pending.values()) {
          this.fail(key, `Track parsing stopped: ${event.message || "the parser worker crashed"}.`);
        }
        this.pending.clear();
      });
      this.worker = worker;
      return worker;
    } catch {
      // No module-worker support (older Electron shells): parse inline instead.
      return null;
    }
  }

  /** Main-thread fallback. Correct, but it will stutter playback on big sessions. */
  private async runInline(req: ParseRequest, matOffsetNs: bigint): Promise<void> {
    const key: TrackKey = req.kind === "pressure" ? "mat" : "pose";
    try {
      const res = await fetch(req.url);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${req.url}`);
      const payload =
        req.kind === "pressure"
          ? ({ kind: "pressure", ...parsePressureCsv(await res.text()) } as PressurePayload)
          : ({ kind: "pose", ...parseKeypointsJson((await res.json()) as KeypointDoc) } as PosePayload);
      this.handleResponse({ id: req.id, ok: true, payload }, matOffsetNs);
    } catch (cause) {
      this.handleResponse(
        { id: req.id, ok: false, error: cause instanceof Error ? cause.message : String(cause) },
        matOffsetNs,
      );
    }
    void key;
  }

  private handleResponse(res: ParseResponse, matOffsetNs: bigint): void {
    if (this.disposed) return;
    const key = this.pending.get(res.id);
    if (!key) return;
    this.pending.delete(res.id);

    if (!res.ok) {
      this.fail(key, res.error);
      return;
    }

    try {
      if (res.payload.kind === "pressure") this.emitMat(res.payload, matOffsetNs);
      else this.emitPose(res.payload);
    } catch (cause) {
      this.fail(key, cause instanceof Error ? cause.message : String(cause));
      return;
    }
    this.countDown();
  }

  private emitMat(payload: PressurePayload, matOffsetNs: bigint): void {
    const cells = payload.rows * payload.cols || SENSOR_COUNT;
    const raw = new SampleTrack({
      name: "mat",
      timestampsNs: payload.timestampsNs,
      values: payload.raw,
      stride: cells,
      offsetNs: matOffsetNs,
      irregular: true,
    });
    // The total curve shares the mat's timestamps, so it inherits the same
    // irregular grid and the same gap spans.
    const total = new SampleTrack({
      name: "mat_total",
      timestampsNs: payload.timestampsNs,
      values: payload.totals,
      stride: 1,
      offsetNs: matOffsetNs,
      irregular: true,
      gapThresholdNs: BigInt(Math.round(raw.gapThresholdNs)),
    });
    this.events.onMat?.({
      raw,
      total,
      baseline: payload.baseline,
      loadMax: payload.loadMax,
      rows: payload.rows,
      cols: payload.cols,
    });
  }

  private emitPose(payload: PosePayload): void {
    // Pose sits on the video's own frame grid, so it is regular and a single
    // missing frame must read as a gap rather than as a healthy interval.
    const gapThresholdNs = regularGapThresholdNs(payload.periodNs);
    const pose = new SampleTrack({
      name: "pose",
      timestampsNs: payload.timestampsNs,
      values: payload.keypoints,
      stride: payload.slots * 3,
      irregular: false,
      gapThresholdNs,
    });
    const angles = new SampleTrack({
      name: "angles",
      // A second view of the same instants; the values differ, the grid does not.
      timestampsNs: payload.timestampsNs.slice(),
      values: payload.angles,
      stride: ANGLE_STRIDE,
      irregular: false,
      gapThresholdNs,
    });
    this.events.onPose?.({
      pose,
      angles,
      slots: payload.slots,
      width: payload.width,
      height: payload.height,
      limbChains: payload.limbChains,
      totalFrames: payload.totalFrames,
      detectedFrames: payload.detectedFrames,
      periodNs: payload.periodNs,
    });
  }

  private fail(key: TrackKey, message: string): void {
    this.events.onFailed?.(key, message);
    this.countDown();
  }

  private countDown(): void {
    this.outstanding -= 1;
    if (this.outstanding <= 0) this.markSettled();
  }

  private markSettled(): void {
    if (this.settled) return;
    this.settled = true;
    this.events.onSettled?.();
  }
}
