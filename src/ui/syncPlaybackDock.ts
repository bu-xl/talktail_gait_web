/**
 * Main stage: recorded mat (top) + AI skeleton video (bottom), one shared timeline.
 */

import type { RecordedFrame } from "../core/recorder.js";
import type { Matrix } from "../core/types.js";
import { SyncedMatVideoPlayback } from "../transport/syncedPlayback.js";
import { onLangChange, t } from "../i18n/index.js";
import { VideoPlayerController } from "./videoPlayerController.js";

export type SyncFrameRenderer = (raw: Matrix, tMs: number) => void;

export class SyncPlaybackDock {
  private readonly stage: HTMLElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly player: VideoPlayerController;
  private readonly synced = new SyncedMatVideoPlayback();
  private onBack: (() => void) | null = null;

  constructor() {
    this.stage = req("stage");
    this.backBtn = req("btnSyncBackLive") as HTMLButtonElement;
    this.player = new VideoPlayerController(req("cameraPanel"));

    this.backBtn.addEventListener("click", () => {
      this.hide();
      this.onBack?.();
    });

    const video = this.player.getVideoElement();
    video.addEventListener("seeked", () => this.synced.invalidateCache());
    video.addEventListener("seeking", () => this.synced.invalidateCache());

    onLangChange(() => {
      this.backBtn.textContent = t("btn_back_live");
    });
  }

  getPlayer(): VideoPlayerController {
    return this.player;
  }

  setOnBack(handler: () => void): void {
    this.onBack = handler;
  }

  get isVisible(): boolean {
    return this.stage.classList.contains("sync-active");
  }

  show(): void {
    this.stage.classList.add("sync-active");
    this.backBtn.classList.remove("hidden");
  }

  hide(): void {
    this.stop();
    this.stage.classList.remove("sync-active");
    this.backBtn.classList.add("hidden");
  }

  stop(): void {
    this.synced.stop();
    this.player.stopVideo();
  }

  async play(
    frames: readonly RecordedFrame[],
    videoUrl: string,
    renderFrame: SyncFrameRenderer,
    opts?: { orientation?: string },
  ): Promise<void> {
    if (frames.length === 0) throw new Error("no recorded frames");
    this.show();
    this.player.loadVideo(videoUrl, { autoplay: false, loop: false, orientation: opts?.orientation });
    await waitForVideoMeta(this.player.getVideoElement());
    this.synced.start(frames, this.player.getVideoElement(), renderFrame, { loop: false });
    this.player.play();
  }
}

function req(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

function waitForVideoMeta(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = (): void => {
      video.removeEventListener("loadedmetadata", done);
      video.removeEventListener("error", onErr);
      resolve();
    };
    const onErr = (): void => {
      video.removeEventListener("loadedmetadata", done);
      video.removeEventListener("error", onErr);
      reject(new Error("video load failed"));
    };
    video.addEventListener("loadedmetadata", done);
    video.addEventListener("error", onErr);
  });
}
