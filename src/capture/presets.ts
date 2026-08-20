/**
 * Phone camera capture presets chosen on the web so every connected phone
 * records at the same resolution and frame rate.
 *
 * expo-camera only exposes 720p / 1080p / 2160p (4K). 2K is listed so clinics
 * can pick it; phones that cannot do 1440p fall back to 1080p together.
 */

export type CaptureVideoQuality = "720p" | "1080p" | "2160p";

export interface CapturePreset {
  id: string;
  label: string;
  videoQuality: CaptureVideoQuality;
  width: number;
  height: number;
  fps: number;
  /** bits per second — expo-camera `videoBitrate`. */
  bitrate: number;
}

export const CAPTURE_PRESETS: readonly CapturePreset[] = [
  { id: "720p30", label: "720p 30fps", videoQuality: "720p", width: 1280, height: 720, fps: 30, bitrate: 4_000_000 },
  { id: "720p60", label: "720p 60fps", videoQuality: "720p", width: 1280, height: 720, fps: 60, bitrate: 8_000_000 },
  { id: "1080p30", label: "1080p 30fps", videoQuality: "1080p", width: 1920, height: 1080, fps: 30, bitrate: 8_000_000 },
  { id: "1080p60", label: "1080p 60fps", videoQuality: "1080p", width: 1920, height: 1080, fps: 60, bitrate: 16_000_000 },
  { id: "2k30", label: "2K 30fps", videoQuality: "1080p", width: 2560, height: 1440, fps: 30, bitrate: 12_000_000 },
  { id: "4k24", label: "4K 24fps", videoQuality: "2160p", width: 3840, height: 2160, fps: 24, bitrate: 35_000_000 },
  { id: "4k30", label: "4K 30fps", videoQuality: "2160p", width: 3840, height: 2160, fps: 30, bitrate: 40_000_000 },
  { id: "4k60", label: "4K 60fps", videoQuality: "2160p", width: 3840, height: 2160, fps: 60, bitrate: 55_000_000 },
];

export const DEFAULT_CAPTURE_PRESET_ID = "1080p30";

export function presetById(id: string | null | undefined): CapturePreset {
  return CAPTURE_PRESETS.find((p) => p.id === id) ?? CAPTURE_PRESETS.find((p) => p.id === DEFAULT_CAPTURE_PRESET_ID)!;
}

/** Wire payload shared by the hub, web control panel, and phones. */
export function captureSettingsPayload(preset: CapturePreset): {
  presetId: string;
  videoQuality: CaptureVideoQuality;
  fps: number;
  width: number;
  height: number;
  bitrate: number;
} {
  return {
    presetId: preset.id,
    videoQuality: preset.videoQuality,
    fps: preset.fps,
    width: preset.width,
    height: preset.height,
    bitrate: preset.bitrate,
  };
}

export function presetFromSettings(raw: unknown): CapturePreset {
  const msg = (raw ?? {}) as { presetId?: string; videoQuality?: string; fps?: number };
  if (msg.presetId) return presetById(msg.presetId);
  const fps = Number(msg.fps);
  const q = msg.videoQuality;
  const match = CAPTURE_PRESETS.find(
    (p) => p.videoQuality === q && p.fps === fps,
  );
  return match ?? presetById(DEFAULT_CAPTURE_PRESET_ID);
}
