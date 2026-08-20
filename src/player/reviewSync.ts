/**
 * One control for the five review panes.
 *
 * Each pane used to own a play button, a speed selector and a `loop` attribute,
 * so four videos ran on four independent clocks and drifted apart within
 * seconds. This replaces all of that with a single transport driving one master
 * video; the rest follow it.
 *
 * The master's `requestVideoFrameCallback` is the clock, for the same reason the
 * result player uses it: it reports the presentation time of the frame actually
 * on screen, which `timeupdate` and `performance.now()` do not.
 *
 * Followers are kept playing at a matched rate and only seeked when they drift
 * past about a frame. Seeking every frame would stutter; never seeking would let
 * rounding accumulate.
 */

import { t } from "../i18n/index.js";
import { MasterClock } from "./masterClock.js";
import type { Renderer } from "./masterClock.js";
import {
  durationsMatch,
  followerRate,
  followerTarget,
  shouldCorrect,
  toleranceFor,
  worstDrift,
} from "./reviewSyncModel.js";
import type { DriftReading, PaneMapping } from "./reviewSyncModel.js";

export interface PaneSpec {
  key: string;
  /** Element id of the pane's video. */
  videoId: string;
  mapping: PaneMapping;
  /** Preferred master. The first ready one wins. */
  masterPriority?: number;
}

/** Report review overlay. */
export const REPORT_PANES: readonly PaneSpec[] = [
  { key: "pressure", videoId: "rpPressureVideo", mapping: "proportional" },
  { key: "origin", videoId: "rpOriginVideo", mapping: "shared", masterPriority: 1 },
  { key: "analysis", videoId: "rpAnalysisVideo", mapping: "shared", masterPriority: 2 },
  { key: "angle", videoId: "rpAngleVideo", mapping: "shared", masterPriority: 3 },
];

/** Measure screen. */
export const MEASURE_PANES: readonly PaneSpec[] = [
  { key: "pressure", videoId: "wsPressureVideo", mapping: "proportional" },
  { key: "origin", videoId: "wsOriginVideo", mapping: "shared", masterPriority: 1 },
  { key: "analysis", videoId: "wsAnalysisVideo", mapping: "shared", masterPriority: 2 },
  { key: "angle", videoId: "wsMaxMinVideo", mapping: "shared", masterPriority: 3 },
];

const STYLE_ID = "review-sync-style";
const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4] as const;

interface Pane {
  spec: PaneSpec;
  video: HTMLVideoElement;
  offsetSec: number;
}

interface Bar {
  root: HTMLElement;
  play: HTMLButtonElement;
  scrub: HTMLInputElement;
  time: HTMLElement;
  speed: HTMLSelectElement;
  status: HTMLElement;
}

export class ReviewSyncController implements Renderer {
  readonly name = "review-sync";
  lastDrawnNs?: bigint;

  private readonly panes: Pane[] = [];
  private master: Pane | null = null;
  private clock: MasterClock | null = null;
  private bar: Bar | null = null;
  private detachClock: (() => void) | null = null;
  private scrubbing = false;
  /** True while the user wants playback; gates the group loop. */
  private wantsPlayback = false;
  private lastReadings: DriftReading[] = [];
  private readonly cleanups: Array<() => void> = [];

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.bar || !this.master) return;
    const el = event.target instanceof HTMLElement ? event.target : null;
    const tag = el?.tagName;
    if (el?.isContentEditable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!this.root.isConnected || this.root.offsetParent === null) return;

    if (event.key === " ") {
      event.preventDefault();
      this.togglePlay();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      this.seekBy(event.shiftKey ? -1 : -1 / 30);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      this.seekBy(event.shiftKey ? 1 : 1 / 30);
    }
  };

  constructor(
    private readonly root: HTMLElement,
    specs: readonly PaneSpec[],
    /** Where the transport bar goes. Defaults to the pane root. */
    private readonly barHost: HTMLElement = root,
  ) {
    injectStyle();
    for (const spec of specs) {
      const video = document.getElementById(spec.videoId);
      if (video instanceof HTMLVideoElement) {
        this.panes.push({ spec, video, offsetSec: 0 });
      }
    }
    this.hidePerPaneControls();
    this.bar = this.buildBar();
    document.addEventListener("keydown", this.onKeyDown);
    this.cleanups.push(() => document.removeEventListener("keydown", this.onKeyDown));
    this.watchReadiness();
  }

  destroy(): void {
    for (const off of this.cleanups) off();
    this.cleanups.length = 0;
    this.detachClock?.();
    this.detachClock = null;
    this.clock?.stop();
    this.clock = null;
    this.bar?.root.remove();
    this.bar = null;
  }

  /** Re-pick the master and restart the clock. Call after loading new sources. */
  refresh(): void {
    this.detachClock?.();
    this.detachClock = null;
    this.clock?.stop();
    this.clock = null;

    const ready = this.panes.filter((p) => hasSource(p.video));
    for (const pane of this.panes) {
      // Individual looping is what let the panes wander apart; the group loops
      // together off the master instead.
      pane.video.loop = false;
      pane.video.muted = true;
      if (pane !== this.master) pane.video.controls = false;
    }

    this.master =
      ready
        .filter((p) => p.spec.masterPriority !== undefined)
        .sort((a, b) => (a.spec.masterPriority ?? 99) - (b.spec.masterPriority ?? 99))[0] ??
      ready[0] ??
      null;

    if (!this.master) {
      this.setEnabled(false);
      this.setStatus(t("rs_no_media"));
      return;
    }

    this.setEnabled(true);
    this.clock = new MasterClock(this.master.video, {});
    this.detachClock = this.clock.add(this);
    this.clock.start();
    this.applySpeed(Number(this.bar?.speed.value) || 1);
    this.updateStatus();
  }

  /**
   * Mapping to actually use for a pane.
   *
   * A pane declared `shared` is only shared if it really is the same clip. When
   * its duration disagrees with the master's by more than a frame it is a
   * different render, and the identity mapping would run it off the end, so it
   * degrades to proportional and is reported as estimated.
   */
  private effectiveMapping(pane: Pane, masterDuration: number): PaneMapping {
    if (pane.spec.mapping === "proportional") return "proportional";
    return durationsMatch(masterDuration, durationOf(pane.video)) ? "shared" : "proportional";
  }

  /** Panes that are being aligned by estimate rather than by a shared clip. */
  private estimatedPanes(masterDuration: number): Pane[] {
    return this.panes.filter(
      (p) =>
        p !== this.master &&
        hasSource(p.video) &&
        durationOf(p.video) > 0 &&
        this.effectiveMapping(p, masterDuration) === "proportional",
    );
  }

  /** Called by the clock once per presented master frame. */
  draw(tMasterNs: bigint): void {
    this.lastDrawnNs = tMasterNs;
    const master = this.master;
    if (!master) return;

    const masterTime = master.video.currentTime;
    const masterDuration = durationOf(master.video);
    const readings: DriftReading[] = [];

    for (const pane of this.panes) {
      if (pane === master || !hasSource(pane.video)) continue;
      const followerDuration = durationOf(pane.video);
      if (followerDuration <= 0) continue;

      const target = followerTarget({
        masterTime,
        masterDuration,
        followerDuration,
        mapping: this.effectiveMapping(pane, masterDuration),
        offsetSec: pane.offsetSec,
      });
      const drift = pane.video.currentTime - target;
      const tolerance = toleranceFor(30);
      const correct = shouldCorrect(drift, tolerance);
      if (correct && !pane.video.seeking) pane.video.currentTime = target;
      readings.push({ key: pane.spec.key, driftSec: drift, corrected: correct });
    }

    this.lastReadings = readings;

    if (!this.scrubbing && this.bar) {
      this.bar.scrub.value = String(
        masterDuration > 0 ? Math.round((masterTime / masterDuration) * 1000) : 0,
      );
      this.bar.time.textContent = `${formatTime(masterTime)} / ${formatTime(masterDuration)}`;
    }
    this.updateStatus();

    // Group loop, but only while playing: scrubbing to the end should park on
    // the last frame rather than snapping back to the start.
    if (master.video.ended && this.wantsPlayback) this.seekTo(0);
  }

  togglePlay(): void {
    const master = this.master;
    if (!master) return;
    if (master.video.paused) void this.playAll();
    else this.pauseAll();
  }

  private async playAll(): Promise<void> {
    const master = this.master;
    if (!master) return;
    this.wantsPlayback = true;
    // Restart from the top when play is pressed on a finished session.
    if (master.video.ended) this.seekTo(0);
    for (const pane of this.panes) {
      if (pane === master || !hasSource(pane.video)) continue;
      void pane.video.play().catch(() => undefined);
    }
    await master.video.play().catch(() => undefined);
    this.updatePlayButton();
  }

  private pauseAll(): void {
    this.wantsPlayback = false;
    for (const pane of this.panes) {
      if (hasSource(pane.video)) pane.video.pause();
    }
    this.updatePlayButton();
  }

  /** Stop the group when the panes are torn down or the overlay closes. */
  stop(): void {
    this.pauseAll();
  }

  private seekBy(deltaSec: number): void {
    if (!this.master) return;
    this.seekTo(this.master.video.currentTime + deltaSec);
  }

  /** Seek every pane at once; followers land exactly rather than converging. */
  private seekTo(masterTime: number): void {
    const master = this.master;
    if (!master) return;
    const masterDuration = durationOf(master.video);
    const clamped = Math.min(masterDuration || Number.MAX_SAFE_INTEGER, Math.max(0, masterTime));
    master.video.currentTime = clamped;

    for (const pane of this.panes) {
      if (pane === master || !hasSource(pane.video)) continue;
      const followerDuration = durationOf(pane.video);
      if (followerDuration <= 0) continue;
      pane.video.currentTime = followerTarget({
        masterTime: clamped,
        masterDuration,
        followerDuration,
        mapping: this.effectiveMapping(pane, masterDuration),
        offsetSec: pane.offsetSec,
      });
    }
  }

  private applySpeed(rate: number): void {
    const master = this.master;
    if (!master) return;
    const masterDuration = durationOf(master.video);
    master.video.playbackRate = rate;
    for (const pane of this.panes) {
      if (pane === master || !hasSource(pane.video)) continue;
      pane.video.playbackRate = followerRate(
        rate,
        masterDuration,
        durationOf(pane.video),
        this.effectiveMapping(pane, masterDuration),
      );
    }
  }

  /**
   * Sync quality, stated rather than assumed.
   *
   * A pane whose duration does not match the master's is not the same clip, so
   * it is aligned by proportion and the reading says so.
   */
  private updateStatus(): void {
    if (!this.bar || !this.master) return;
    const masterDuration = durationOf(this.master.video);
    const mismatched = this.estimatedPanes(masterDuration);

    const worstMs = Math.round(worstDrift(this.lastReadings) * 1000);
    const parts = [t("rs_drift", { ms: String(worstMs) })];
    if (mismatched.length > 0) parts.push(t("rs_estimated", { n: String(mismatched.length) }));
    this.setStatus(parts.join(" · "));
    this.bar.status.classList.toggle("is-warn", worstMs > 80 || mismatched.length > 0);
  }

  private setStatus(text: string): void {
    if (this.bar) this.bar.status.textContent = text;
  }

  private setEnabled(on: boolean): void {
    if (!this.bar) return;
    this.bar.play.disabled = !on;
    this.bar.scrub.disabled = !on;
    this.bar.speed.disabled = !on;
  }

  private updatePlayButton(): void {
    if (!this.bar || !this.master) return;
    const playing = !this.master.video.paused && !this.master.video.ended;
    this.bar.play.textContent = playing ? "⏸" : "▶";
    this.bar.play.title = playing ? t("btn_pause") : t("btn_play");
  }

  /** The per-pane bars are what caused the drift; they go away. */
  private hidePerPaneControls(): void {
    for (const bar of this.root.querySelectorAll<HTMLElement>(".ws-media-controls")) {
      bar.hidden = true;
    }
  }

  private watchReadiness(): void {
    for (const pane of this.panes) {
      const onMeta = (): void => {
        if (!this.master) {
          this.refresh();
          return;
        }
        this.applySpeed(Number(this.bar?.speed.value) || 1);
        // Durations are only known now, so redraw the readout and re-align.
        this.clock?.resync();
      };
      pane.video.addEventListener("loadedmetadata", onMeta);
      this.cleanups.push(() => pane.video.removeEventListener("loadedmetadata", onMeta));
    }
  }

  private buildBar(): Bar {
    const root = document.createElement("div");
    root.className = "rs-transport";
    root.innerHTML = `
      <button type="button" class="rs-play" disabled>▶</button>
      <input class="rs-scrub" type="range" min="0" max="1000" value="0" step="1" disabled>
      <span class="rs-time">0:00.0 / 0:00.0</span>
      <select class="rs-speed" disabled>
        ${SPEEDS.map((s) => `<option value="${s}"${s === 1 ? " selected" : ""}>${s}×</option>`).join("")}
      </select>
      <span class="rs-status"></span>
    `;
    this.barHost.appendChild(root);

    const pick = <T extends HTMLElement>(sel: string): T => {
      const el = root.querySelector(sel);
      if (!el) throw new Error(`review transport: missing ${sel}`);
      return el as T;
    };
    const bar: Bar = {
      root,
      play: pick<HTMLButtonElement>(".rs-play"),
      scrub: pick<HTMLInputElement>(".rs-scrub"),
      time: pick(".rs-time"),
      speed: pick<HTMLSelectElement>(".rs-speed"),
      status: pick(".rs-status"),
    };

    bar.play.addEventListener("click", () => this.togglePlay());
    bar.speed.addEventListener("change", () => this.applySpeed(Number(bar.speed.value) || 1));
    bar.scrub.addEventListener("pointerdown", () => {
      this.scrubbing = true;
    });
    const end = (): void => {
      this.scrubbing = false;
    };
    bar.scrub.addEventListener("pointerup", end);
    bar.scrub.addEventListener("pointercancel", end);
    bar.scrub.addEventListener("input", () => {
      const master = this.master;
      if (!master) return;
      this.seekTo((Number(bar.scrub.value) / 1000) * durationOf(master.video));
    });

    return bar;
  }
}

function hasSource(video: HTMLVideoElement): boolean {
  return Boolean(video.currentSrc || video.getAttribute("src"));
}

function durationOf(video: HTMLVideoElement): number {
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00.0";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const d = Math.floor((sec % 1) * 10);
  return `${m}:${String(s).padStart(2, "0")}.${d}`;
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
/* .ws-media-controls sets display:flex in a class rule, which outranks the UA
   [hidden] rule, so hiding the per-pane bars needs an explicit override. */
.ws-media-controls[hidden]{display:none!important}
/* #stage is a grid; without this the shared transport lands in one cell. */
#stage > .rs-transport{grid-column:1/-1;margin:0 6px 6px}
.rs-transport{display:flex;align-items:center;gap:8px;padding:6px 10px;margin-top:6px;
  border-radius:8px;background:var(--panel,#15171b);border:1px solid var(--border,#22262c);
  font:500 12px/1.2 system-ui,sans-serif;color:var(--fg,#c8ccd2)}
.rs-transport button,.rs-transport select{height:26px;border:1px solid var(--border-strong,#33383f);
  border-radius:6px;background:var(--surface,#1d2026);color:inherit;cursor:pointer;padding:0 8px}
.rs-transport button:disabled,.rs-transport select:disabled{opacity:.45;cursor:not-allowed}
.rs-transport button:focus-visible,.rs-transport select:focus-visible,
.rs-transport input:focus-visible{outline:2px solid var(--primary,#f0663f);outline-offset:2px}
.rs-scrub{flex:1;min-width:100px;margin:0}
.rs-time{font:500 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;
  font-variant-numeric:tabular-nums;min-width:96px;text-align:right}
.rs-status{font-size:11px;color:var(--muted,#7c828b);min-width:120px}
.rs-status.is-warn{color:var(--warning,#e8c76a)}
/* 완료된 분석은 보호자 앞에서 손가락으로 조작한다. 이 화면에서만 조작부를 키워
   터치 목표를 넉넉하게 잡는다(측정 화면은 마우스 위주라 그대로 둔다). */
body[data-module="review"] .rs-transport{gap:12px;padding:10px 14px}
body[data-module="review"] .rs-transport button,
body[data-module="review"] .rs-transport select{height:44px;min-width:52px;
  padding:0 14px;font-size:16px;border-radius:10px}
body[data-module="review"] .rs-play{font-size:18px}
body[data-module="review"] .rs-scrub{height:32px}
body[data-module="review"] .rs-scrub::-webkit-slider-thumb{width:26px;height:26px}
body[data-module="review"] .rs-time{font-size:14px;min-width:112px}
`;
  document.head.appendChild(style);
}
