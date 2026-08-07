/**
 * Replay transport: emits raw matrices from a parsed recording at a chosen rate,
 * driving the exact same downstream pipeline as the live serial source.
 */

import { parsePlayback, type PlaybackFrame } from "../core/playbackParser.js";
import type { FrameHandler, FrameSource, StatusHandler } from "./source.js";

export class ReplaySource implements FrameSource {
  private frames: PlaybackFrame[] = [];
  private idx = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameHandler: FrameHandler = () => {};
  private statusHandler: StatusHandler = () => {};

  constructor(
    text: string,
    private readonly fps = 40,
    private readonly loop = true,
  ) {
    this.frames = parsePlayback(text);
  }

  get frameCount(): number {
    return this.frames.length;
  }

  onFrame(handler: FrameHandler): void {
    this.frameHandler = handler;
  }
  onStatus(handler: StatusHandler): void {
    this.statusHandler = handler;
  }

  start(): void {
    if (this.frames.length === 0) {
      this.statusHandler(false, "no frames in recording");
      return;
    }
    this.statusHandler(true, `replaying ${this.frames.length} frames`);
    const intervalMs = 1000 / this.fps;
    this.timer = setInterval(() => {
      if (this.idx >= this.frames.length) {
        if (this.loop) this.idx = 0;
        else {
          this.stop();
          return;
        }
      }
      this.frameHandler(this.frames[this.idx].raw);
      this.idx += 1;
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.statusHandler(false, "replay stopped");
  }
}
