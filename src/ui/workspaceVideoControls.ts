/**
 * Compact play/pause + playback-rate controls for workspace review videos.
 */

import { t } from "../i18n/index.js";


export class WorkspaceVideoControls {
  private readonly video: HTMLVideoElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly speedSelect: HTMLSelectElement;

  constructor(bar: HTMLElement) {
    const videoId = bar.getAttribute("data-video");
    if (!videoId) throw new Error("ws-media-controls missing data-video");
    const video = document.getElementById(videoId);
    if (!(video instanceof HTMLVideoElement)) throw new Error(`#${videoId} is not a video`);
    this.video = video;

    this.playBtn = bar.querySelector(".ws-play") as HTMLButtonElement;
    this.speedSelect = bar.querySelector(".ws-speed") as HTMLSelectElement;
    if (!this.playBtn || !this.speedSelect) throw new Error("ws controls missing play/speed");

    this.video.controls = false;
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.loop = true;

    this.playBtn.addEventListener("click", () => this.toggle());
    this.speedSelect.addEventListener("change", () => {
      this.video.playbackRate = Number(this.speedSelect.value) || 1;
    });
    this.video.addEventListener("play", () => this.syncPlayBtn());
    this.video.addEventListener("pause", () => this.syncPlayBtn());
    this.video.addEventListener("ended", () => this.syncPlayBtn());
    this.video.addEventListener("loadeddata", () => {
      this.video.playbackRate = Number(this.speedSelect.value) || 1;
      this.syncPlayBtn();
    });
    this.syncPlayBtn();
  }

  toggle(): void {
    if (!this.video.src) return;
    if (this.video.paused) {
      void this.video.play().catch((error: unknown) => {
        if (
          typeof DOMException !== "undefined" &&
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          return;
        }
      });
    } else {
      this.video.pause();
    }
    this.syncPlayBtn();
  }

  private syncPlayBtn(): void {
    const hasSrc = Boolean(this.video.getAttribute("src") || this.video.src);
    this.playBtn.disabled = !hasSrc;
    const playing = hasSrc && !this.video.paused && !this.video.ended;
    this.playBtn.textContent = playing ? "⏸" : "▶";
    this.playBtn.title = playing ? t("btn_pause") : t("btn_play");
  }
}

export function wireWorkspaceVideoControls(): WorkspaceVideoControls[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".ws-media-controls")).map(
    (bar) => new WorkspaceVideoControls(bar),
  );
}
