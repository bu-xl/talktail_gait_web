import type { Lang } from "../i18n/locales.js";
import { DEFAULT_CAPTURE_PRESET_ID, presetById } from "../capture/presets.js";

export const SETTINGS_STORAGE_KEY = "gait-pressure-mat.settings.v1";

export interface UserSettings {
  version: 1;
  lang: Lang;
  dogWeight: number;
  overlayEnabled: boolean;
  showGrid: boolean;
  /** 0 = Soft, 1 = Crisp, 2 = Pixel */
  sharpIdx: number;
  capturePresetId: string;
  /** 촬영 하드 상한(초). 서버가 10~180 초 · 10초 단위로 다시 clamp 한다. */
  maxRecordSec: number;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  version: 1,
  lang: "ko",
  dogWeight: 3.5,
  overlayEnabled: true,
  showGrid: false,
  sharpIdx: 0,
  capturePresetId: DEFAULT_CAPTURE_PRESET_ID,
  maxRecordSec: 30,
};

/** 웹에서 고를 수 있는 촬영 상한 — 서버(`ws-hub.js`)의 범위와 같아야 한다. */
export const MIN_RECORD_SEC = 10;
export const MAX_RECORD_SEC = 180;
export const RECORD_SEC_STEP = 10;

export function clampRecordSec(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_USER_SETTINGS.maxRecordSec;
  const stepped = Math.round(v / RECORD_SEC_STEP) * RECORD_SEC_STEP;
  return Math.min(MAX_RECORD_SEC, Math.max(MIN_RECORD_SEC, stepped));
}

function clampSharpIdx(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(2, Math.round(n)));
}

function normalize(partial: unknown): UserSettings {
  const p = (partial ?? {}) as Partial<UserSettings>;
  const lang = p.lang === "en" ? "en" : p.lang === "ko" ? "ko" : DEFAULT_USER_SETTINGS.lang;
  const dogWeight =
    typeof p.dogWeight === "number" && p.dogWeight > 0 ? p.dogWeight : DEFAULT_USER_SETTINGS.dogWeight;
  return {
    version: 1,
    lang,
    dogWeight,
    overlayEnabled: p.overlayEnabled ?? DEFAULT_USER_SETTINGS.overlayEnabled,
    showGrid: p.showGrid ?? DEFAULT_USER_SETTINGS.showGrid,
    sharpIdx: clampSharpIdx(p.sharpIdx ?? DEFAULT_USER_SETTINGS.sharpIdx),
    capturePresetId: presetById(p.capturePresetId).id,
    maxRecordSec: clampRecordSec(p.maxRecordSec),
  };
}

export function loadUserSettings(): UserSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  try {
    const lang = localStorage.getItem("gait-pressure-mat.lang");
    if (lang === "ko" || lang === "en") {
      return { ...DEFAULT_USER_SETTINGS, lang };
    }
  } catch {
    /* ignore */
  }
  const nav = (navigator.language || "en").toLowerCase();
  return { ...DEFAULT_USER_SETTINGS, lang: nav.startsWith("ko") ? "ko" : "en" };
}

export function saveUserSettings(settings: UserSettings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    localStorage.setItem("gait-pressure-mat.lang", settings.lang);
  } catch {
    /* ignore */
  }
}

export function patchUserSettings(patch: Partial<UserSettings>): UserSettings {
  const next = normalize({ ...loadUserSettings(), ...patch });
  saveUserSettings(next);
  return next;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced save — batches rapid UI toggles. */
export function scheduleSaveSettings(getSettings: () => UserSettings, ms = 200): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveUserSettings(getSettings());
  }, ms);
}
