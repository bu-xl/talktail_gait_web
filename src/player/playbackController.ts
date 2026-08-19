/**
 * The player's only transport control.
 *
 * There is one `<video>` and one clock, so this drives the video and everything
 * else follows. Nothing here owns a timer: the controller registers itself as a
 * renderer on the master clock, which is what keeps the A-B loop and the time
 * readout on the same frame as the panels.
 */

import type { MasterClock, Renderer } from "./masterClock.js";
import {
  RepeatRange,
  clampToSession,
  formatMasterTime,
  fractionOf,
  isTextEntryTag,
  keyToAction,
  masterAtFraction,
} from "./transportModel.js";

export const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
export type Speed = (typeof SPEEDS)[number];

export interface PlaybackLabels {
  play: string;
  pause: string;
  speed: string;
  loopOff: string;
  loopOn: string;
  markA: string;
  markB: string;
  clearRange: string;
}

export interface PlaybackOptions {
  /** Session start on the master timeline. */
  t0Ns: bigint;
  /** Video frame period, ns. Drives single-frame stepping. */
  framePeriodNs: number;
  labels: PlaybackLabels;
  /** Show the raw master timestamp next to the clock readout. */
  developerMode?: boolean;
}

interface Elements {
  root: HTMLElement;
  play: HTMLButtonElement;
  scrub: HTMLInputElement;
  time: HTMLElement;
  speed: HTMLSelectElement;
  markA: HTMLButtonElement;
  markB: HTMLButtonElement;
  loop: HTMLButtonElement;
  clear: HTMLButtonElement;
  range: HTMLElement;
}

const STYLE_ID = "gait-player-controls-style";

export class PlaybackController implements Renderer {
  readonly name = "transport";
  lastDrawnNs?: bigint;

  private readonly el: Elements;
  private readonly range = new RepeatRange();
  private scrubbing = false;
  private detachClock: (() => void) | null = null;
  private developerMode: boolean;

  private readonly onKeyDown = (event: KeyboardEvent): void => this.handleKey(event);

  constructor(
    container: HTMLElement,
    private readonly video: HTMLVideoElement,
    private readonly clock: MasterClock,
    private readonly opts: PlaybackOptions,
  ) {
    this.developerMode = opts.developerMode ?? false;
    injectStyle();
    this.el = buildDom(container, opts.labels);
    this.bindEvents();
    this.detachClock = clock.add(this);
    document.addEventListener("keydown", this.onKeyDown);
    this.refreshRangeUi();
  }

  destroy(): void {
    document.removeEventListener("keydown", this.onKeyDown);
    this.detachClock?.();
    this.detachClock = null;
    this.el.root.remove();
  }

  /** Session duration on the master timeline. */
  private get durationNs(): number {
    const d = this.video.duration;
    return Number.isFinite(d) && d > 0 ? d * 1e9 : 0;
  }

  private toMaster(fraction: number): bigint {
    return masterAtFraction(fraction, this.opts.t0Ns, this.durationNs);
  }

  private toFraction(tMasterNs: bigint): number {
    return fractionOf(tMasterNs, this.opts.t0Ns, this.durationNs);
  }

  /**
   * Called by the clock every frame. Enforces the A-B loop and updates the
   * readout, so both stay on exactly the frame the panels drew.
   */
  draw(tMasterNs: bigint): void {
    this.lastDrawnNs = tMasterNs;

    const wrap = this.range.wrapTarget(tMasterNs, !this.video.paused);
    if (wrap !== null) {
      this.seekTo(wrap);
      return;
    }
    this.el.time.textContent = formatMasterTime(tMasterNs, this.opts.t0Ns, this.developerMode);
    if (!this.scrubbing) {
      this.el.scrub.value = String(Math.round(this.toFraction(tMasterNs) * 1000));
    }
  }

  togglePlay(): void {
    if (this.video.paused) void this.video.play().catch(() => undefined);
    else this.video.pause();
    this.updatePlayButton();
  }

  /** Move by a number of video frames; negative steps back. */
  stepFrames(frames: number): void {
    this.seekTo(this.clock.currentMasterNs + BigInt(Math.round(frames * this.opts.framePeriodNs)));
  }

  stepSeconds(seconds: number): void {
    this.seekTo(this.clock.currentMasterNs + BigInt(Math.round(seconds * 1e9)));
  }

  setSpeed(speed: Speed): void {
    this.video.playbackRate = speed;
    this.el.speed.value = String(speed);
  }

  markA(tMasterNs = this.clock.currentMasterNs): void {
    this.range.markA(tMasterNs);
    this.refreshRangeUi();
  }

  markB(tMasterNs = this.clock.currentMasterNs): void {
    this.range.markB(tMasterNs);
    this.refreshRangeUi();
  }

  clearRange(): void {
    this.range.clear();
    this.refreshRangeUi();
  }

  toggleLoop(): void {
    this.range.toggleLoop();
    this.refreshRangeUi();
  }

  get repeatRange(): RepeatRange {
    return this.range;
  }

  setDeveloperMode(on: boolean): void {
    this.developerMode = on;
  }

  /**
   * Seek. The canvas panels redraw immediately from the requested time; the
   * video catches up on its own and the clock's `seeked` handler settles the
   * final position. Waiting for the seek before drawing is what makes scrubbing
   * feel laggy.
   */
  seekTo(tMasterNs: bigint): void {
    const clamped = clampToSession(tMasterNs, this.opts.t0Ns, this.durationNs);
    this.clock.renderAt(clamped);
    const seconds = Number(clamped - this.opts.t0Ns) / 1e9;
    if (Number.isFinite(seconds)) this.video.currentTime = Math.max(0, seconds);
  }

  private bindEvents(): void {
    this.el.play.addEventListener("click", () => this.togglePlay());
    this.video.addEventListener("play", () => this.updatePlayButton());
    this.video.addEventListener("pause", () => this.updatePlayButton());
    this.video.addEventListener("ended", () => this.updatePlayButton());
    this.video.addEventListener("loadedmetadata", () => this.refreshRangeUi());

    this.el.scrub.addEventListener("pointerdown", () => {
      this.scrubbing = true;
    });
    const endScrub = (): void => {
      this.scrubbing = false;
    };
    this.el.scrub.addEventListener("pointerup", endScrub);
    this.el.scrub.addEventListener("pointercancel", endScrub);
    this.el.scrub.addEventListener("input", () => {
      this.seekTo(this.toMaster(Number(this.el.scrub.value) / 1000));
    });

    this.el.speed.addEventListener("change", () => {
      const value = Number(this.el.speed.value);
      this.setSpeed((SPEEDS.find((s) => s === value) ?? 1) as Speed);
    });

    this.el.markA.addEventListener("click", () => this.markA());
    this.el.markB.addEventListener("click", () => this.markB());
    this.el.loop.addEventListener("click", () => this.toggleLoop());
    this.el.clear.addEventListener("click", () => this.clearRange());
  }

  private handleKey(event: KeyboardEvent): void {
    const target = event.target;
    const el = target instanceof HTMLElement ? target : null;
    if (isTextEntryTag(el?.tagName, el?.isContentEditable ?? false)) return;

    const action = keyToAction(event);
    if (!action) return;
    event.preventDefault();

    switch (action.kind) {
      case "toggle-play":
        this.togglePlay();
        return;
      case "step-frames":
        this.stepFrames(action.frames);
        return;
      case "step-seconds":
        this.stepSeconds(action.seconds);
        return;
      case "mark-a":
        this.markA();
        return;
      case "mark-b":
        this.markB();
        return;
      case "toggle-loop":
        this.toggleLoop();
        return;
      case "seek-fraction":
        this.seekTo(this.toMaster(action.fraction));
        return;
      default:
        return;
    }
  }

  private updatePlayButton(): void {
    const playing = !this.video.paused && !this.video.ended;
    this.el.play.textContent = playing ? "❚❚" : "▶";
    this.el.play.setAttribute(
      "aria-label",
      playing ? this.opts.labels.pause : this.opts.labels.play,
    );
  }

  private refreshRangeUi(): void {
    const hasBoth = this.range.isComplete;
    this.el.loop.disabled = !hasBoth;
    this.el.loop.textContent = this.range.enabled
      ? this.opts.labels.loopOn
      : this.opts.labels.loopOff;
    this.el.loop.classList.toggle("is-on", this.range.enabled);
    this.el.clear.disabled = this.range.aNs === null && this.range.bNs === null;

    if (!hasBoth || this.durationNs <= 0) {
      this.el.range.style.display = "none";
      return;
    }
    const a = this.toFraction(this.range.aNs!);
    const b = this.toFraction(this.range.bNs!);
    this.el.range.style.display = "block";
    this.el.range.style.left = `${a * 100}%`;
    this.el.range.style.width = `${Math.max(0, b - a) * 100}%`;
  }
}

function buildDom(container: HTMLElement, labels: PlaybackLabels): Elements {
  const root = document.createElement("div");
  root.className = "gp-transport";
  root.innerHTML = `
    <button class="gp-btn gp-play" type="button" aria-label="${escapeAttr(labels.play)}">▶</button>
    <div class="gp-scrub-wrap">
      <div class="gp-range" role="presentation"></div>
      <input class="gp-scrub" type="range" min="0" max="1000" value="0" step="1"
             aria-label="${escapeAttr(labels.play)}">
    </div>
    <span class="gp-time" role="timer">0:00.000</span>
    <label class="gp-speed-wrap">
      <span class="gp-visually-hidden">${escapeHtml(labels.speed)}</span>
      <select class="gp-speed">
        ${SPEEDS.map((s) => `<option value="${s}"${s === 1 ? " selected" : ""}>${s}x</option>`).join("")}
      </select>
    </label>
    <button class="gp-btn gp-a" type="button">${escapeHtml(labels.markA)}</button>
    <button class="gp-btn gp-b" type="button">${escapeHtml(labels.markB)}</button>
    <button class="gp-btn gp-loop" type="button" disabled>${escapeHtml(labels.loopOff)}</button>
    <button class="gp-btn gp-clear" type="button" disabled>${escapeHtml(labels.clearRange)}</button>
  `;
  container.appendChild(root);

  const pick = <T extends HTMLElement>(sel: string): T => {
    const el = root.querySelector(sel);
    if (!el) throw new Error(`transport: missing ${sel}`);
    return el as T;
  };

  return {
    root,
    play: pick<HTMLButtonElement>(".gp-play"),
    scrub: pick<HTMLInputElement>(".gp-scrub"),
    time: pick(".gp-time"),
    speed: pick<HTMLSelectElement>(".gp-speed"),
    markA: pick<HTMLButtonElement>(".gp-a"),
    markB: pick<HTMLButtonElement>(".gp-b"),
    loop: pick<HTMLButtonElement>(".gp-loop"),
    clear: pick<HTMLButtonElement>(".gp-clear"),
    range: pick(".gp-range"),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.gp-transport{display:flex;align-items:center;gap:8px;padding:8px 10px;
  background:#15171b;border-top:1px solid #262a30;color:#c8ccd2;
  font:500 12px/1.2 system-ui,sans-serif}
.gp-btn{min-width:32px;height:26px;padding:0 8px;border:1px solid #33383f;border-radius:6px;
  background:#1d2026;color:#c8ccd2;cursor:pointer}
.gp-btn:hover:not(:disabled){background:#252931}
.gp-btn:disabled{opacity:.45;cursor:not-allowed}
.gp-btn.is-on{background:#f0663f;border-color:#f0663f;color:#fff}
.gp-btn:focus-visible,.gp-scrub:focus-visible,.gp-speed:focus-visible{
  outline:2px solid #f0663f;outline-offset:2px}
.gp-scrub-wrap{position:relative;flex:1;display:flex;align-items:center;min-width:120px}
.gp-scrub{width:100%;margin:0;position:relative;z-index:1;background:transparent}
.gp-range{position:absolute;top:50%;height:6px;transform:translateY(-50%);
  background:rgba(240,102,63,.35);border-radius:3px;pointer-events:none;display:none}
.gp-time{font:500 12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;
  min-width:76px;text-align:right;font-variant-numeric:tabular-nums}
.gp-speed{height:26px;border:1px solid #33383f;border-radius:6px;background:#1d2026;
  color:#c8ccd2;padding:0 4px}
.gp-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);
  clip-path:inset(50%);white-space:nowrap}
@media (prefers-reduced-motion:reduce){.gp-btn{transition:none}}
`;
  document.head.appendChild(style);
}
