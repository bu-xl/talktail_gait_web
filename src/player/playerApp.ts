/**
 * Result player assembly.
 *
 * Builds its own DOM into a container, so mounting it costs the host page one
 * empty element rather than a new block of markup and CSS.
 *
 * Load order matters: the video is playable as soon as its metadata arrives and
 * each panel switches on when its track lands. Nothing waits for the full set,
 * because the mat CSV is the slowest artifact and the footage is what the user
 * came to see.
 */

import { MAT_ASPECT } from "../core/constants.js";
import { findContactSpans, suggestThreshold } from "./contactEvents.js";
import { calibrationToHomography } from "./homography.js";
import type { MatCalibration } from "./homography.js";
import { MasterClock } from "./masterClock.js";
import type { ClockMode } from "./masterClock.js";
import { PlaybackController } from "./playbackController.js";
import type { PlaybackLabels } from "./playbackController.js";
import { AngleChartRenderer, romSeries, symmetrySeries } from "./renderers/angleChartRenderer.js";
import type { ColormapName } from "./renderers/colormap.js";
import { MatHeatmapRenderer } from "./renderers/matHeatmapRenderer.js";
import { SkeletonRenderer } from "./renderers/skeletonRenderer.js";
import { TIMELINE_HEIGHT, TimelineRenderer } from "./renderers/timelineRenderer.js";
import { assessSession } from "./sessionQuality.js";
import type { QualityReport, TimestampSource } from "./sessionQuality.js";
import { TrackLoader } from "./trackLoader.js";
import type { MatTracks, PlayerSources, PoseTracks, TrackKey } from "./trackLoader.js";

export type LayoutPreset = "quad" | "split" | "focus";

export interface PlayerLabels extends PlaybackLabels {
  noData: string;
  noMatData: string;
  rate: string;
  registration: string;
  registrationUnavailable: string;
  fallbackClock: string;
  panelVideo: string;
  panelMat: string;
  panelRom: string;
  panelSymmetry: string;
}

export interface PlayerAppOptions {
  videoUrl: string;
  sources: PlayerSources;
  labels: PlayerLabels;
  /** Mat quad in normalised video coordinates. Without it the overlay is off. */
  calibration?: MatCalibration | null;
  /**
   * How the mat's timestamps were produced. This pipeline stamps on host
   * arrival, so the default is honest rather than flattering.
   */
  timestampSource?: TimestampSource;
  /** Per-sample timestamp quantisation; the CSV export rounds to 1 ms. */
  timestampQuantumNs?: number;
  colormap?: ColormapName;
  developerMode?: boolean;
  storageKey?: string;
  onQuality?(report: QualityReport): void;
  onTrackFailed?(key: TrackKey, message: string): void;
}

const STYLE_ID = "gait-player-app-style";
const DEFAULT_STORAGE_KEY = "gait-player-layout";
const PANEL_IDS = ["video", "mat", "rom", "symmetry"] as const;
type PanelId = (typeof PANEL_IDS)[number];

interface Panel {
  id: PanelId;
  root: HTMLElement;
  body: HTMLElement;
}

export class PlayerApp {
  private readonly root: HTMLElement;
  private readonly grid: HTMLElement;
  private readonly video: HTMLVideoElement;
  private readonly timelineCanvas: HTMLCanvasElement;
  private readonly badges: HTMLElement;
  private readonly clockBadge: HTMLElement;
  private readonly registrationBtn: HTMLButtonElement;
  private readonly panels = new Map<PanelId, Panel>();

  private readonly clock: MasterClock;
  private readonly loader: TrackLoader;
  private transport: PlaybackController | null = null;
  private timeline: TimelineRenderer | null = null;
  private matRenderer: MatHeatmapRenderer | null = null;
  private overlayRenderer: MatHeatmapRenderer | null = null;
  private skeleton: SkeletonRenderer | null = null;
  private readonly disposers: Array<() => void> = [];

  private matTracks: MatTracks | null = null;
  private poseTracks: PoseTracks | null = null;
  private order: PanelId[] = [...PANEL_IDS];
  private preset: LayoutPreset = "quad";
  private registrationOn = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly opts: PlayerAppOptions,
  ) {
    injectStyle();
    const built = buildDom(container, opts.labels);
    this.root = built.root;
    this.grid = built.grid;
    this.video = built.video;
    this.timelineCanvas = built.timeline;
    this.badges = built.badges;
    this.clockBadge = built.clockBadge;
    this.registrationBtn = built.registration;
    for (const panel of built.panels) this.panels.set(panel.id, panel);

    this.clock = new MasterClock(this.video, {
      debug: opts.developerMode ?? false,
      onModeChange: (mode) => this.showClockMode(mode),
      onRendererError: (name, error) => this.showPanelError(name, error),
    });

    this.loader = new TrackLoader({
      onMat: (tracks) => this.attachMat(tracks),
      onPose: (tracks) => this.attachPose(tracks),
      onFailed: (key, message) => this.handleTrackFailure(key, message),
      onSettled: () => this.publishQuality(),
    });

    this.restoreLayout();
    this.bindChrome();
    this.setupRegistrationButton();
    this.start();
  }

  destroy(): void {
    for (const off of this.disposers) off();
    this.disposers.length = 0;
    this.transport?.destroy();
    this.timeline?.destroy();
    this.clock.stop();
    this.loader.dispose();
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.root.remove();
  }

  /** Diagnostics for the debug overlay: tMaster agreement across renderers. */
  clockStats(): ReturnType<MasterClock["debugStats"]> {
    return this.clock.debugStats();
  }

  private start(): void {
    this.video.src = this.opts.videoUrl;
    this.video.load();

    const onMeta = (): void => {
      // The footage is the master clock, so its panel is live the moment the
      // metadata lands, regardless of whether any track has arrived yet.
      this.setPanelState("video", "ready");
      this.transport = new PlaybackController(this.root, this.video, this.clock, {
        t0Ns: 0n,
        framePeriodNs: this.poseTracks?.periodNs ?? 1e9 / 30,
        labels: this.opts.labels,
        developerMode: this.opts.developerMode,
      });
      this.buildTimeline();
      this.clock.start();
    };
    this.video.addEventListener("loadedmetadata", onMeta, { once: true });
    this.video.addEventListener("error", () => {
      this.setPanelState("video", "failed");
      this.showBanner(
        `영상을 불러오지 못했습니다: ${this.opts.videoUrl}. 분석 서버가 켜져 있는지 확인하세요.`,
      );
    });

    // Tracks load in parallel with the video; panels light up as they arrive.
    this.loader.start(this.opts.sources);
  }

  private attachMat(tracks: MatTracks): void {
    this.matTracks = tracks;
    const canvas = this.panelCanvas("mat");
    this.matRenderer = new MatHeatmapRenderer(canvas, {
      track: tracks.raw,
      baseline: tracks.baseline,
      loadMax: tracks.loadMax,
      rows: tracks.rows,
      cols: tracks.cols,
      labels: { noData: this.opts.labels.noData },
      colormap: this.opts.colormap,
    });
    this.matRenderer.setShowTiming(this.opts.developerMode ?? false);
    this.disposers.push(this.clock.add(this.matRenderer));
    this.setPanelState("mat", "ready");

    this.buildTimeline();
    this.setupRegistrationButton();
    this.clock.resync();
  }

  private attachPose(tracks: PoseTracks): void {
    this.poseTracks = tracks;

    this.skeleton = new SkeletonRenderer(this.panelOverlayCanvas("video"), {
      track: tracks.pose,
      slots: tracks.slots,
      sourceWidth: tracks.width || this.video.videoWidth,
      sourceHeight: tracks.height || this.video.videoHeight,
    });
    this.disposers.push(this.clock.add(this.skeleton));

    this.disposers.push(
      this.clock.add(
        new AngleChartRenderer(this.panelCanvas("rom"), {
          track: tracks.angles,
          series: romSeries(),
          title: this.opts.labels.panelRom,
        }),
      ),
    );
    this.disposers.push(
      this.clock.add(
        new AngleChartRenderer(this.panelCanvas("symmetry"), {
          track: tracks.angles,
          series: symmetrySeries(),
          title: this.opts.labels.panelSymmetry,
        }),
      ),
    );

    this.setPanelState("rom", "ready");
    this.setPanelState("symmetry", "ready");
    this.clock.resync();
  }

  private buildTimeline(): void {
    this.timeline?.destroy();
    const total = this.matTracks?.total ?? null;
    const contacts = total ? findContactSpans(total, suggestThreshold(total)) : [];

    this.timeline = new TimelineRenderer(this.timelineCanvas, {
      totalTrack: total,
      startNs: 0n,
      endNs: BigInt(Math.round((this.video.duration || 0) * 1e9)),
      contacts,
      labels: { noMatData: this.opts.labels.noMatData, rate: this.opts.labels.rate },
      onSeek: (tNs) => this.transport?.seekTo(tNs),
      onRangeSelect: (aNs, bNs) => {
        this.transport?.markA(aNs);
        this.transport?.markB(bNs);
        this.timeline?.setRange(aNs, bNs);
      },
    });
    this.disposers.push(this.clock.add(this.timeline));
  }

  /**
   * The registration view: mat heatmap projected onto the footage.
   *
   * Without a calibration there is no transform, so the toggle is disabled and
   * says why rather than being quietly absent.
   */
  private setupRegistrationButton(): void {
    const homography = this.opts.calibration
      ? calibrationToHomography(this.opts.calibration)
      : null;
    const available = homography !== null && this.matTracks !== null;

    this.registrationBtn.disabled = !available;
    this.registrationBtn.textContent = this.opts.labels.registration;
    const reason = !this.opts.calibration
      ? this.opts.labels.registrationUnavailable
      : homography === null
        ? "캘리브레이션 4점이 한 직선에 가깝습니다. 매트 모서리를 다시 지정하세요."
        : "";
    this.registrationBtn.title = available ? "" : reason;
    const note = this.root.querySelector(".gp-registration-note");
    if (note instanceof HTMLElement) {
      note.textContent = available ? "" : reason;
      note.hidden = available;
    }
  }

  private setPanelState(id: PanelId, state: "loading" | "ready" | "failed", message?: string): void {
    const panel = this.panels.get(id);
    if (!panel) return;
    panel.root.dataset.state = state;
    const note = panel.root.querySelector(".gp-panel-note");
    if (note instanceof HTMLElement) {
      note.textContent = message ?? "";
      note.hidden = !message;
    }
  }

  private handleTrackFailure(key: TrackKey, message: string): void {
    // One broken artifact must not take the player down: mark its panels and
    // leave everything else playing.
    if (key === "mat") {
      this.setPanelState("mat", "failed", message);
    } else {
      this.setPanelState("rom", "failed", message);
      this.setPanelState("symmetry", "failed", message);
    }
    this.opts.onTrackFailed?.(key, message);
  }

  private publishQuality(): void {
    const report = assessSession({
      matTotal: this.matTracks?.total ?? null,
      pose: this.poseTracks,
      timestampSource: this.opts.timestampSource ?? "host_arrival",
      timestampQuantumNs: this.opts.timestampQuantumNs ?? 1e6,
    });
    this.renderBadges(report);
    this.opts.onQuality?.(report);
  }

  private renderBadges(report: QualityReport): void {
    this.badges.textContent = "";
    for (const metric of report.metrics) {
      const chip = document.createElement("span");
      chip.className = `gp-badge gp-badge-${metric.status}`;
      chip.textContent = `${metric.label} ${metric.value ?? "측정 불가"}`;
      if (metric.note) chip.title = metric.note;
      this.badges.appendChild(chip);
    }
    for (const warning of report.warnings) {
      const line = document.createElement("div");
      line.className = "gp-warning";
      line.textContent = warning;
      this.badges.appendChild(line);
    }
  }

  private showClockMode(mode: ClockMode): void {
    const fallback = mode === "raf-fallback";
    this.clockBadge.hidden = !fallback;
    this.clockBadge.textContent = fallback ? this.opts.labels.fallbackClock : "";
  }

  private showPanelError(name: string, error: unknown): void {
    const id: PanelId | null =
      name === "mat" ? "mat" : name === "skeleton" ? "video" : name.startsWith("chart:") ? "rom" : null;
    if (id) {
      this.setPanelState(id, "failed", error instanceof Error ? error.message : String(error));
    }
  }

  private showBanner(message: string): void {
    const banner = this.root.querySelector(".gp-banner");
    if (banner instanceof HTMLElement) {
      banner.textContent = message;
      banner.hidden = false;
    }
  }

  private panelCanvas(id: PanelId): HTMLCanvasElement {
    const panel = this.panels.get(id);
    if (!panel) throw new Error(`no panel ${id}`);
    const canvas = panel.body.querySelector("canvas.gp-canvas");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error(`panel ${id} has no canvas`);
    return canvas;
  }

  private panelOverlayCanvas(id: PanelId): HTMLCanvasElement {
    const panel = this.panels.get(id);
    if (!panel) throw new Error(`no panel ${id}`);
    const canvas = panel.body.querySelector("canvas.gp-overlay");
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error(`panel ${id} has no overlay`);
    return canvas;
  }

  private bindChrome(): void {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>("[data-preset]")) {
      const handler = (): void => this.applyPreset(button.dataset.preset as LayoutPreset);
      button.addEventListener("click", handler);
      this.disposers.push(() => button.removeEventListener("click", handler));
    }

    this.registrationBtn.addEventListener("click", () => {
      this.registrationOn = !this.registrationOn;
      this.registrationBtn.classList.toggle("is-on", this.registrationOn);
      const overlay = this.panels.get("video")?.root.querySelector(".gp-mat-projection");
      if (overlay instanceof HTMLElement) overlay.hidden = !this.registrationOn;
    });

    for (const panel of this.panels.values()) {
      const onDouble = (): void => this.toggleExpanded(panel.id);
      panel.root.addEventListener("dblclick", onDouble);
      this.disposers.push(() => panel.root.removeEventListener("dblclick", onDouble));
      this.makeReorderable(panel);
    }
  }

  private makeReorderable(panel: Panel): void {
    panel.root.draggable = true;
    const onDragStart = (event: DragEvent): void => {
      event.dataTransfer?.setData("text/plain", panel.id);
    };
    const onDragOver = (event: DragEvent): void => event.preventDefault();
    const onDrop = (event: DragEvent): void => {
      event.preventDefault();
      const dragged = event.dataTransfer?.getData("text/plain") as PanelId | undefined;
      if (!dragged || dragged === panel.id) return;
      const next = this.order.filter((id) => id !== dragged);
      next.splice(this.order.indexOf(panel.id), 0, dragged);
      this.order = next;
      this.applyOrder();
      this.saveLayout();
    };
    panel.root.addEventListener("dragstart", onDragStart);
    panel.root.addEventListener("dragover", onDragOver);
    panel.root.addEventListener("drop", onDrop);
    this.disposers.push(
      () => panel.root.removeEventListener("dragstart", onDragStart),
      () => panel.root.removeEventListener("dragover", onDragOver),
      () => panel.root.removeEventListener("drop", onDrop),
    );
  }

  private toggleExpanded(id: PanelId): void {
    const panel = this.panels.get(id);
    if (!panel) return;
    const wasExpanded = panel.root.classList.contains("is-expanded");
    for (const p of this.panels.values()) p.root.classList.remove("is-expanded");
    this.grid.classList.toggle("has-expanded", !wasExpanded);
    if (!wasExpanded) panel.root.classList.add("is-expanded");
    this.saveLayout();
  }

  applyPreset(preset: LayoutPreset): void {
    this.preset = preset;
    this.grid.dataset.preset = preset;
    this.saveLayout();
    this.clock.resync();
  }

  private applyOrder(): void {
    for (const id of this.order) {
      const panel = this.panels.get(id);
      if (panel) this.grid.appendChild(panel.root);
    }
  }

  private storageKey(): string {
    return this.opts.storageKey ?? DEFAULT_STORAGE_KEY;
  }

  /** Layout is a per-user habit, so it outlives the session. */
  private saveLayout(): void {
    try {
      const expanded = [...this.panels.values()].find((p) => p.root.classList.contains("is-expanded"));
      localStorage.setItem(
        this.storageKey(),
        JSON.stringify({ preset: this.preset, order: this.order, expanded: expanded?.id ?? null }),
      );
    } catch {
      // Private browsing or a full quota; the layout just will not persist.
    }
  }

  private restoreLayout(): void {
    let saved: { preset?: LayoutPreset; order?: PanelId[]; expanded?: PanelId | null } | null = null;
    try {
      const raw = localStorage.getItem(this.storageKey());
      saved = raw ? JSON.parse(raw) : null;
    } catch {
      saved = null;
    }
    if (!saved) return;

    if (saved.order && saved.order.length === PANEL_IDS.length) {
      const valid = saved.order.every((id) => PANEL_IDS.includes(id));
      if (valid) {
        this.order = saved.order;
        this.applyOrder();
      }
    }
    if (saved.preset) this.applyPreset(saved.preset);
    if (saved.expanded) this.toggleExpanded(saved.expanded);
  }
}

interface BuiltDom {
  root: HTMLElement;
  grid: HTMLElement;
  video: HTMLVideoElement;
  timeline: HTMLCanvasElement;
  badges: HTMLElement;
  clockBadge: HTMLElement;
  registration: HTMLButtonElement;
  panels: Panel[];
}

function buildDom(container: HTMLElement, labels: PlayerLabels): BuiltDom {
  const root = document.createElement("div");
  root.className = "gp-player";
  root.innerHTML = `
    <div class="gp-banner" hidden role="alert"></div>
    <div class="gp-toolbar">
      <div class="gp-presets" role="group">
        <button class="gp-btn" type="button" data-preset="quad">4분할</button>
        <button class="gp-btn" type="button" data-preset="split">2분할</button>
        <button class="gp-btn" type="button" data-preset="focus">집중</button>
      </div>
      <button class="gp-btn gp-registration" type="button"></button>
      <span class="gp-registration-note" hidden></span>
      <span class="gp-clock-badge" hidden></span>
    </div>
    <div class="gp-badges"></div>
    <div class="gp-grid" data-preset="quad">
      ${PANEL_IDS.map(
        (id) => `
      <section class="gp-panel" data-panel="${id}" data-state="loading">
        <header class="gp-panel-head">${escapeHtml(panelTitle(id, labels))}</header>
        <div class="gp-panel-body">
          ${
            id === "video"
              ? `<video class="gp-video" playsinline preload="metadata"></video>
                 <canvas class="gp-overlay"></canvas>
                 <div class="gp-mat-projection" hidden></div>`
              : `<canvas class="gp-canvas"></canvas>`
          }
        </div>
        <p class="gp-panel-note" hidden></p>
      </section>`,
      ).join("")}
    </div>
    <canvas class="gp-timeline" height="${TIMELINE_HEIGHT}"></canvas>
  `;
  container.appendChild(root);

  const pick = <T extends HTMLElement>(sel: string): T => {
    const el = root.querySelector(sel);
    if (!el) throw new Error(`player: missing ${sel}`);
    return el as T;
  };

  const panels: Panel[] = PANEL_IDS.map((id) => {
    const el = pick<HTMLElement>(`[data-panel="${id}"]`);
    const body = el.querySelector(".gp-panel-body");
    if (!(body instanceof HTMLElement)) throw new Error(`player: panel ${id} has no body`);
    return { id, root: el, body };
  });

  return {
    root,
    grid: pick(".gp-grid"),
    video: pick<HTMLVideoElement>(".gp-video"),
    timeline: pick<HTMLCanvasElement>(".gp-timeline"),
    badges: pick(".gp-badges"),
    clockBadge: pick(".gp-clock-badge"),
    registration: pick<HTMLButtonElement>(".gp-registration"),
    panels,
  };
}

function panelTitle(id: PanelId, labels: PlayerLabels): string {
  switch (id) {
    case "video":
      return labels.panelVideo;
    case "mat":
      return labels.panelMat;
    case "rom":
      return labels.panelRom;
    default:
      return labels.panelSymmetry;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
.gp-player{display:flex;flex-direction:column;height:100%;min-height:0;background:#0e1013;color:#c8ccd2;
  font:400 13px/1.4 system-ui,sans-serif}
.gp-banner{padding:8px 12px;background:#4a1f19;color:#ffd9d2;border-bottom:1px solid #6b2b22}
.gp-toolbar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #22262c}
.gp-presets{display:flex;gap:4px}
.gp-btn{height:26px;padding:0 10px;border:1px solid #33383f;border-radius:6px;background:#1d2026;
  color:#c8ccd2;cursor:pointer;font:500 12px/1 system-ui,sans-serif}
.gp-btn:hover:not(:disabled){background:#252931}
.gp-btn:disabled{opacity:.45;cursor:not-allowed}
.gp-btn.is-on{background:#f0663f;border-color:#f0663f;color:#fff}
.gp-btn:focus-visible{outline:2px solid #f0663f;outline-offset:2px}
.gp-registration-note,.gp-clock-badge{font-size:11px;color:#e8b04a}
.gp-badges{display:flex;flex-wrap:wrap;gap:6px;padding:6px 10px;border-bottom:1px solid #22262c}
.gp-badge{padding:2px 7px;border-radius:999px;font:500 11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
  border:1px solid #33383f;background:#191c21;color:#aeb4bd}
.gp-badge-good{border-color:#2c5c46;color:#8fdcb8}
.gp-badge-warn{border-color:#6b5620;color:#e8c76a}
.gp-badge-bad{border-color:#6b2b22;color:#ff9384}
.gp-badge-unavailable{opacity:.6;border-style:dashed}
.gp-warning{flex:1 0 100%;color:#e8c76a;font-size:12px}
.gp-grid{flex:1;min-height:0;display:grid;gap:6px;padding:6px}
.gp-grid[data-preset="quad"]{grid-template-columns:repeat(2,1fr);grid-template-rows:repeat(2,1fr)}
.gp-grid[data-preset="split"]{grid-template-columns:repeat(2,1fr);grid-template-rows:1fr}
.gp-grid[data-preset="split"] .gp-panel:nth-child(n+3){display:none}
.gp-grid[data-preset="focus"]{grid-template-columns:3fr 1fr;grid-template-rows:repeat(3,1fr)}
.gp-grid[data-preset="focus"] .gp-panel:first-child{grid-row:1/-1}
.gp-grid.has-expanded .gp-panel{display:none}
.gp-grid.has-expanded .gp-panel.is-expanded{display:flex;grid-column:1/-1;grid-row:1/-1}
.gp-panel{display:flex;flex-direction:column;min-width:0;min-height:0;background:#15171b;
  border:1px solid #22262c;border-radius:8px;overflow:hidden}
.gp-panel-head{padding:5px 8px;font:600 11px/1.3 system-ui,sans-serif;color:#9aa1ab;
  border-bottom:1px solid #22262c}
.gp-panel-body{position:relative;flex:1;min-height:0;display:flex;align-items:center;
  justify-content:center;background:#0b0d10}
.gp-canvas,.gp-overlay{width:100%;height:100%;display:block}
.gp-overlay,.gp-mat-projection{position:absolute;inset:0;pointer-events:none}
.gp-video{max-width:100%;max-height:100%;display:block}
.gp-panel[data-state="loading"] .gp-panel-body::after{content:"";position:absolute;inset:0;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.05),transparent)}
.gp-panel[data-state="failed"]{border-color:#6b2b22}
.gp-panel-note{margin:0;padding:6px 8px;font-size:11px;color:#ff9384;background:#1d1416}
/* An explicit CSS height is required, not just the height attribute: CanvasSurface
   writes the backing store from the measured box, and without a fixed CSS height
   that write feeds back into layout and the strip grows on every frame. */
.gp-timeline{width:100%;height:${TIMELINE_HEIGHT}px;flex:0 0 auto;display:block;
  background:#111317;border-top:1px solid #22262c}
@media (prefers-reduced-motion:reduce){
  .gp-panel[data-state="loading"] .gp-panel-body::after{background:rgba(255,255,255,.03)}
}
@media (max-width:900px){
  .gp-grid[data-preset="quad"],.gp-grid[data-preset="focus"]{grid-template-columns:1fr;
    grid-template-rows:repeat(4,minmax(160px,1fr))}
  .gp-grid[data-preset="focus"] .gp-panel:first-child{grid-row:auto}
}
`;
  document.head.appendChild(style);
}
