/**
 * Phone JPEG preview + AI video player (scrub, speed, zoom, play/pause).
 * Preview paints to canvas via offscreen decode to avoid img flicker.
 *
 * Playback rules (AbortError-safe):
 * - Never re-assign video.src for the same URL
 * - load() only when src actually changes
 * - play() only when paused; never stack concurrent play() promises
 * - AbortError from play() is ignored (benign race)
 */

import { onLangChange, t } from "../i18n/index.js";

export type VideoPlayerMode = "idle" | "preview" | "video";

export class VideoPlayerController {
  private readonly viewport: HTMLElement;
  private readonly mediaWrap: HTMLElement;
  private readonly previewCanvas: HTMLCanvasElement;
  private readonly previewCtx: CanvasRenderingContext2D;
  private readonly preview: HTMLImageElement;
  private readonly video: HTMLVideoElement;
  private readonly placeholder: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly scrub: HTMLInputElement;
  private readonly timeLabel: HTMLElement;
  private readonly speedSelect: HTMLSelectElement;
  private readonly zoomRange: HTMLInputElement;
  private readonly rotateBtn: HTMLButtonElement | null;

  private readonly decodeImg = new Image();
  private previewPending: string | null = null;
  private previewRaf = 0;
  private rotationDeg = 0;
  private zoom = 1;
  private scrubbing = false;
  private mode: VideoPlayerMode = "idle";
  private onTimeListeners = new Set<() => void>();
  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer = 0;
  /** Last URL we intentionally assigned (absolute). */
  private loadedUrl = "";
  /** In-flight play() so callers do not stack concurrent requests. */
  private playPromise: Promise<void> | null = null;
  private loadGeneration = 0;

  constructor(root: HTMLElement) {
    this.viewport = q(root, ".video-viewport");
    this.mediaWrap = q(root, ".video-media-wrap");
    this.previewCanvas = q(root, ".camera-preview-canvas") as HTMLCanvasElement;
    const ctx = this.previewCanvas.getContext("2d");
    if (!ctx) throw new Error("2D preview canvas context unavailable");
    this.previewCtx = ctx;
    this.preview = q(root, ".camera-preview") as HTMLImageElement;
    this.video = q(root, ".ai-video") as HTMLVideoElement;
    this.placeholder = q(root, ".camera-placeholder");
    this.loading = q(root, ".camera-loading");
    this.playBtn = q(root, ".btn-video-play") as HTMLButtonElement;
    this.scrub = q(root, ".video-scrub") as HTMLInputElement;
    this.timeLabel = q(root, ".video-time");
    this.speedSelect = q(root, ".video-speed") as HTMLSelectElement;
    this.zoomRange = q(root, ".video-zoom") as HTMLInputElement;
    this.rotateBtn = root.querySelector(".btn-video-rotate") as HTMLButtonElement | null;

    this.preview.hidden = true;
    this.previewCanvas.classList.remove("show");
    this.decodeImg.decoding = "async";
    this.video.playsInline = true;
    this.bindEvents();
    onLangChange(() => this.refreshLabels());
    this.refreshLabels();
    this.showIdle();
  }

  getVideoElement(): HTMLVideoElement {
    return this.video;
  }

  getMode(): VideoPlayerMode {
    return this.mode;
  }

  /** Absolute URL currently loaded, or empty. */
  getLoadedUrl(): string {
    return this.loadedUrl;
  }

  onTimeUpdate(fn: () => void): () => void {
    this.onTimeListeners.add(fn);
    return () => this.onTimeListeners.delete(fn);
  }

  showIdle(message?: string): void {
    this.mode = "idle";
    this.previewPending = null;
    if (this.previewRaf) cancelAnimationFrame(this.previewRaf);
    this.previewRaf = 0;
    this.previewCanvas.classList.remove("show");
    this.preview.classList.remove("show");
    this.video.classList.remove("show");
    this.placeholder.classList.remove("hidden");
    if (message) this.placeholder.textContent = message;
    else this.placeholder.textContent = t("camera_placeholder");
    this.setLoading(false);
    this.clearVideoSizing();
    this.updatePlayButton();
    this.updateTimeLabel();
  }

  /** Live JPEG frame from the phone (data URL or base64 with mime). */
  showPreviewFrame(dataUrl: string): void {
    if (this.mode === "video") return;
    this.previewPending = dataUrl;
    if (!this.previewRaf) {
      this.previewRaf = requestAnimationFrame(() => void this.flushPreview());
    }
  }

  clearPreview(): void {
    if (this.mode === "video") return;
    this.showIdle();
  }

  /**
   * Load (or keep) a video URL. Same URL → no-op (no src/load/play).
   * Different URL → pause → src → load → wait metadata → optional play.
   */
  loadVideo(url: string, opts?: { autoplay?: boolean; loop?: boolean; orientation?: string }): void {
    const nextUrl = resolveMediaUrl(url);
    if (!nextUrl) return;

    const autoplay = opts?.autoplay !== false;
    const loop = opts?.loop ?? false;

    if (opts?.orientation === "portrait") {
      this.rotationDeg = 90;
    } else if (opts?.orientation === "landscape") {
      this.rotationDeg = 0;
    }

    // Identical URL: never touch src / load / play again.
    if (this.isSameLoadedUrl(nextUrl)) {
      this.enterVideoUi();
      this.video.loop = loop;
      this.video.playbackRate = Number(this.speedSelect.value) || 1;
      this.applyTransform();
      this.updateScrubMax();
      this.updatePlayButton();
      this.updateTimeLabel();
      return;
    }

    this.enterVideoUi();
    this.video.loop = loop;
    this.video.playbackRate = Number(this.speedSelect.value) || 1;
    this.applyTransform();

    void this.replaceSourceAndMaybePlay(nextUrl, autoplay);
  }

  setLoading(on: boolean, label?: string): void {
    this.loading.classList.toggle("show", on);
    if (label) {
      const span = this.loading.querySelector("span");
      if (span) span.textContent = label;
    }
  }

  play(): void {
    if (this.mode !== "video") return;
    void this.safePlay();
    this.updatePlayButton();
  }

  pause(): void {
    if (this.mode === "video") this.video.pause();
    this.updatePlayButton();
  }

  togglePlay(): void {
    if (this.mode !== "video") return;
    if (this.video.paused) void this.safePlay();
    else this.video.pause();
    this.updatePlayButton();
  }

  stopVideo(): void {
    this.loadGeneration += 1;
    this.playPromise = null;
    this.video.pause();
    this.video.removeAttribute("src");
    this.video.load();
    this.loadedUrl = "";
    this.video.classList.remove("show");
    this.showIdle();
    this.updatePlayButton();
  }

  private enterVideoUi(): void {
    this.mode = "video";
    this.previewPending = null;
    if (this.previewRaf) cancelAnimationFrame(this.previewRaf);
    this.previewRaf = 0;
    this.placeholder.classList.add("hidden");
    this.previewCanvas.classList.remove("show");
    this.preview.classList.remove("show");
    this.video.classList.add("show");
  }

  private isSameLoadedUrl(nextUrl: string): boolean {
    if (!nextUrl) return false;
    if (this.loadedUrl && urlsLooselyEqual(this.loadedUrl, nextUrl)) return true;
    const current = this.video.currentSrc || this.video.src || "";
    if (current && urlsLooselyEqual(current, nextUrl)) return true;
    const attr = this.video.getAttribute("src");
    if (attr && urlsLooselyEqual(resolveMediaUrl(attr), nextUrl)) return true;
    return false;
  }

  private async replaceSourceAndMaybePlay(nextUrl: string, autoplay: boolean): Promise<void> {
    const gen = ++this.loadGeneration;
    try {
      this.video.pause();
    } catch {
      /* ignore */
    }

    // Only assign + load when the element does not already point at nextUrl.
    if (!urlsLooselyEqual(this.video.src || "", nextUrl) && !urlsLooselyEqual(this.video.currentSrc || "", nextUrl)) {
      this.video.src = nextUrl;
      this.video.load();
    }
    this.loadedUrl = nextUrl;

    try {
      await waitForLoadedMetadata(this.video);
    } catch {
      if (gen !== this.loadGeneration) return;
      return;
    }
    if (gen !== this.loadGeneration) return;
    if (!this.isSameLoadedUrl(nextUrl)) return;

    this.updateScrubMax();
    this.applyVideoLayout();
    if (autoplay) await this.safePlay();
    this.updatePlayButton();
    this.updateTimeLabel();
  }

  /** Single-flight play(); ignores AbortError; no-op if already playing. */
  private async safePlay(): Promise<void> {
    if (this.mode !== "video") return;
    if (!this.video.paused && !this.video.ended) return;
    if (this.playPromise) {
      try {
        await this.playPromise;
      } catch {
        /* prior play aborted / failed */
      }
      if (!this.video.paused && !this.video.ended) return;
    }

    this.playPromise = this.video
      .play()
      .then(() => undefined)
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        // Autoplay policy / transient errors — do not throw out of UI.
        console.warn("[video] play failed", error);
      })
      .finally(() => {
        this.playPromise = null;
        this.updatePlayButton();
      });

    await this.playPromise;
  }

  private async flushPreview(): Promise<void> {
    this.previewRaf = 0;
    const dataUrl = this.previewPending;
    if (!dataUrl || this.mode === "video") return;
    this.previewPending = null;

    try {
      await decodeToImage(this.decodeImg, dataUrl);
      this.paintPreviewFrame(this.decodeImg);
      this.mode = "preview";
      this.placeholder.classList.add("hidden");
      this.previewCanvas.classList.add("show");
      this.preview.classList.remove("show");
      this.video.classList.remove("show");
      this.updatePlayButton();
      this.updateTimeLabel();
    } catch {
      /* drop bad frame */
    }

    if (this.previewPending) {
      this.previewRaf = requestAnimationFrame(() => void this.flushPreview());
    }
  }

  private paintPreviewFrame(img: HTMLImageElement): void {
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    if (vw <= 0 || vh <= 0 || img.naturalWidth <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.previewCanvas.width = Math.round(vw * dpr);
    this.previewCanvas.height = Math.round(vh * dpr);
    this.previewCanvas.style.width = `${vw}px`;
    this.previewCanvas.style.height = `${vh}px`;

    const scale = Math.min(vw / img.naturalWidth, vh / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    const dx = (vw - dw) / 2;
    const dy = (vh - dh) / 2;

    this.previewCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.previewCtx.fillStyle = "#05070a";
    this.previewCtx.fillRect(0, 0, vw, vh);
    this.previewCtx.save();
    this.previewCtx.translate(dx + dw / 2, dy + dh / 2);
    this.previewCtx.scale(-1, -1);
    this.previewCtx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
    this.previewCtx.restore();
  }

  private bindEvents(): void {
    this.playBtn.addEventListener("click", () => this.togglePlay());
    if (this.rotateBtn) {
      this.rotateBtn.hidden = true;
    }

    this.speedSelect.addEventListener("change", () => {
      this.video.playbackRate = Number(this.speedSelect.value) || 1;
    });
    this.zoomRange.addEventListener("input", () => {
      this.zoom = Number(this.zoomRange.value) / 100;
      this.applyTransform();
    });

    this.scrub.addEventListener("pointerdown", () => {
      this.scrubbing = true;
    });
    this.scrub.addEventListener("pointerup", () => {
      this.scrubbing = false;
    });
    this.scrub.addEventListener("input", () => {
      if (this.mode !== "video" || !Number.isFinite(this.video.duration)) return;
      const ratio = Number(this.scrub.value) / 1000;
      this.video.currentTime = ratio * this.video.duration;
      this.updateTimeLabel();
    });

    this.video.addEventListener("timeupdate", () => {
      if (!this.scrubbing) {
        this.updateScrubFromVideo();
        this.updateTimeLabel();
      }
      for (const fn of this.onTimeListeners) fn();
    });
    this.video.addEventListener("loadedmetadata", () => {
      this.updateScrubMax();
      this.applyVideoLayout();
    });
    this.video.addEventListener("play", () => this.updatePlayButton());
    this.video.addEventListener("pause", () => this.updatePlayButton());
    this.video.addEventListener("ended", () => this.updatePlayButton());

    this.resizeObserver = new ResizeObserver(() => {
      if (this.resizeTimer) cancelAnimationFrame(this.resizeTimer);
      this.resizeTimer = requestAnimationFrame(() => {
        this.resizeTimer = 0;
        if (this.mode === "video") this.applyVideoLayout();
      });
    });
    this.resizeObserver.observe(this.viewport);

    this.viewport.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        this.zoom = Math.min(3, Math.max(1, this.zoom + delta));
        this.zoomRange.value = String(Math.round(this.zoom * 100));
        this.applyTransform();
      },
      { passive: false },
    );
  }

  private applyVideoLayout(): void {
    const vw = this.viewport.clientWidth;
    const vh = this.viewport.clientHeight;
    if (vw <= 0 || vh <= 0) return;

    const srcW = this.video.videoWidth;
    const srcH = this.video.videoHeight;
    if (srcW <= 0 || srcH <= 0) return;

    this.clearVideoSizing();
    const portrait = srcH > srcW;
    this.rotationDeg = portrait ? 90 : 0;

    if (portrait) {
      this.video.style.width = `${vh}px`;
      this.video.style.height = `${vw}px`;
      this.video.style.maxWidth = "none";
      this.video.style.maxHeight = "none";
      this.video.style.objectFit = "contain";
    } else {
      this.video.style.width = "100%";
      this.video.style.height = "100%";
      this.video.style.maxWidth = "100%";
      this.video.style.maxHeight = "100%";
      this.video.style.objectFit = "contain";
    }
    this.applyTransform();
    this.refreshLabels();
  }

  private clearVideoSizing(): void {
    this.video.style.width = "";
    this.video.style.height = "";
    this.video.style.maxWidth = "";
    this.video.style.maxHeight = "";
    this.video.style.objectFit = "";
    this.video.style.transform = "";
  }

  private applyTransform(): void {
    const tf = [
      "scale(-1, -1)",
      this.rotationDeg ? `rotate(${this.rotationDeg}deg)` : "",
      this.zoom !== 1 ? `scale(${this.zoom})` : "",
    ]
      .filter(Boolean)
      .join(" ");

    if (this.mode === "video") {
      this.video.style.transform = tf;
    } else {
      this.video.style.transform = "";
    }
  }

  private updateScrubMax(): void {
    if (!Number.isFinite(this.video.duration) || this.video.duration <= 0) {
      this.scrub.value = "0";
      return;
    }
    const ratio = this.video.currentTime / this.video.duration;
    this.scrub.value = String(Math.round(ratio * 1000));
  }

  private updateScrubFromVideo(): void {
    if (!Number.isFinite(this.video.duration) || this.video.duration <= 0) return;
    const ratio = this.video.currentTime / this.video.duration;
    this.scrub.value = String(Math.round(ratio * 1000));
  }

  private updateTimeLabel(): void {
    const cur = this.mode === "video" ? this.video.currentTime : 0;
    const dur = this.mode === "video" && Number.isFinite(this.video.duration) ? this.video.duration : 0;
    this.timeLabel.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
  }

  private updatePlayButton(): void {
    const canPlay = this.mode === "video";
    this.playBtn.disabled = !canPlay;
    const playing = canPlay && !this.video.paused && !this.video.ended;
    this.playBtn.textContent = playing ? "⏸" : "▶";
    this.playBtn.title = playing ? t("video_pause") : t("video_play");
  }

  private refreshLabels(): void {
    if (this.rotateBtn) this.rotateBtn.textContent = t("video_rotate_landscape");
    if (this.mode === "idle") this.placeholder.textContent = t("camera_placeholder");
    this.updatePlayButton();
    this.updateTimeLabel();
  }
}

function resolveMediaUrl(url: string): string {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw, typeof location !== "undefined" ? location.href : undefined).href;
  } catch {
    return raw;
  }
}

function urlsLooselyEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  let left = a;
  let right = b;
  try {
    left = decodeURIComponent(a);
  } catch {
    /* keep */
  }
  try {
    right = decodeURIComponent(b);
  } catch {
    /* keep */
  }
  if (left === right) return true;
  // Compare path+query when hosts match after resolution
  try {
    const ua = new URL(left, typeof location !== "undefined" ? location.href : undefined);
    const ub = new URL(right, typeof location !== "undefined" ? location.href : undefined);
    if (ua.href === ub.href) return true;
    if (ua.pathname + ua.search === ub.pathname + ub.search) {
      if (!ua.host || !ub.host || ua.host === ub.host) return true;
    }
    if (ua.pathname.endsWith(ub.pathname) || ub.pathname.endsWith(ua.pathname)) {
      if (ua.search === ub.search) return true;
    }
  } catch {
    /* fall through */
  }
  return left.endsWith(right) || right.endsWith(left);
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name: string }).name === "AbortError")
  );
}

function waitForLoadedMetadata(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onMeta = (): void => {
      cleanup();
      resolve();
    };
    const onErr = (): void => {
      cleanup();
      reject(new Error("video load failed"));
    };
    const cleanup = (): void => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("error", onErr);
    };
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("error", onErr);
  });
}

function decodeToImage(img: HTMLImageElement, dataUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      img.removeEventListener("load", done);
      img.removeEventListener("error", onErr);
      resolve();
    };
    const onErr = (): void => {
      img.removeEventListener("load", done);
      img.removeEventListener("error", onErr);
      reject(new Error("preview decode failed"));
    };
    img.addEventListener("load", done);
    img.addEventListener("error", onErr);
    img.src = dataUrl;
  });
}

function q(root: HTMLElement, sel: string): HTMLElement {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`Missing ${sel} in video player root`);
  return el as HTMLElement;
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
