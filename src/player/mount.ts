/**
 * Opens the result player as a full-screen overlay.
 *
 * The player builds its own DOM, so mounting it costs the host page nothing: no
 * markup, no reserved container, no CSS. This module owns the overlay shell, the
 * close affordances and the check that the session actually has the artifacts
 * the player needs.
 */

import { t } from "../i18n/index.js";
import { PlayerApp } from "./playerApp.js";
import type { PlayerAppOptions, PlayerLabels } from "./playerApp.js";
import type { MatCalibration } from "./homography.js";
import type { QualityReport } from "./sessionQuality.js";
import type { TrackKey } from "./trackLoader.js";

const STYLE_ID = "gait-player-overlay-style";

export interface ResultPlayerInputs {
  /** Analysed video, the master clock's source. */
  videoUrl: string | null | undefined;
  /** Mat pressure CSV. Without it the mat panel and timeline stay empty. */
  pressureCsvUrl?: string | null;
  /** Pose keypoints JSON. Without it the skeleton and angle panels stay empty. */
  keypointsUrl?: string | null;
  /** Title shown in the overlay header. */
  title?: string;
  subtitle?: string;
  calibration?: MatCalibration | null;
  developerMode?: boolean;
  onQuality?(report: QualityReport): void;
  onTrackFailed?(key: TrackKey, message: string): void;
}

/** Why the player cannot open, or null when it can. */
export function playerBlockedReason(inputs: ResultPlayerInputs): string | null {
  if (!inputs.videoUrl) return t("gp_no_video");
  // The mat CSV is what makes this more than a video player, so its absence is
  // worth stating up front rather than opening onto two empty panels.
  if (!inputs.pressureCsvUrl) return t("gp_no_csv");
  return null;
}

function labels(): PlayerLabels {
  return {
    play: t("gp_play"),
    pause: t("gp_pause"),
    speed: t("gp_speed"),
    loopOff: t("gp_loop_off"),
    loopOn: t("gp_loop_on"),
    markA: t("gp_mark_a"),
    markB: t("gp_mark_b"),
    clearRange: t("gp_clear_range"),
    noData: t("gp_no_data"),
    noMatData: t("gp_no_mat_data"),
    rate: t("gp_rate"),
    registration: t("gp_registration"),
    registrationUnavailable: t("gp_registration_unavailable"),
    fallbackClock: t("gp_fallback_clock"),
    panelVideo: t("gp_panel_video"),
    panelMat: t("gp_panel_mat"),
    panelRom: t("gp_panel_rom"),
    panelSymmetry: t("gp_panel_symmetry"),
  };
}

/**
 * One overlay per page, reused across sessions.
 *
 * Opening a second session tears the first player down completely so its clock,
 * worker and track buffers are released rather than accumulating.
 */
export class ResultPlayerOverlay {
  private host: HTMLElement | null = null;
  private player: PlayerApp | null = null;
  private previousFocus: HTMLElement | null = null;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      this.close();
    }
  };

  get isOpen(): boolean {
    return this.host !== null;
  }

  open(inputs: ResultPlayerInputs): void {
    const blocked = playerBlockedReason(inputs);
    if (blocked) throw new Error(blocked);
    this.close();

    injectStyle();
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const host = document.createElement("div");
    host.className = "gp-overlay-host";
    host.setAttribute("role", "dialog");
    host.setAttribute("aria-modal", "true");
    host.setAttribute("aria-label", inputs.title || t("gp_open"));
    host.innerHTML = `
      <header class="gp-overlay-head">
        <div class="gp-overlay-titles">
          <strong>${escapeHtml(inputs.title ?? t("gp_open"))}</strong>
          ${inputs.subtitle ? `<span>${escapeHtml(inputs.subtitle)}</span>` : ""}
        </div>
        <button class="gp-overlay-close" type="button">${escapeHtml(t("gp_close"))}</button>
      </header>
      <div class="gp-overlay-body"></div>
    `;
    document.body.appendChild(host);
    document.body.classList.add("modal-open");
    this.host = host;

    const close = host.querySelector(".gp-overlay-close");
    if (close instanceof HTMLButtonElement) {
      close.addEventListener("click", () => this.close());
      close.focus();
    }
    document.addEventListener("keydown", this.onKeyDown, true);

    const body = host.querySelector(".gp-overlay-body");
    if (!(body instanceof HTMLElement)) throw new Error("player overlay: body missing");

    const options: PlayerAppOptions = {
      videoUrl: inputs.videoUrl!,
      sources: {
        pressureCsvUrl: inputs.pressureCsvUrl ?? null,
        keypointsUrl: inputs.keypointsUrl ?? null,
      },
      labels: labels(),
      calibration: inputs.calibration ?? null,
      // This pipeline stamps mat samples on host arrival and the CSV rounds them
      // to 1 ms, so the quality strip says so instead of implying firmware time.
      timestampSource: "host_arrival",
      timestampQuantumNs: 1e6,
      developerMode: inputs.developerMode,
      onQuality: inputs.onQuality,
      onTrackFailed: inputs.onTrackFailed,
    };
    this.player = new PlayerApp(body, options);
  }

  close(): void {
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.player?.destroy();
    this.player = null;
    this.host?.remove();
    this.host = null;
    document.body.classList.remove("modal-open");
    this.previousFocus?.focus();
    this.previousFocus = null;
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
.gp-overlay-host{position:fixed;inset:0;z-index:1200;display:flex;flex-direction:column;
  background:#0e1013;color:#c8ccd2}
.gp-overlay-head{display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:10px 14px;border-bottom:1px solid #22262c}
.gp-overlay-titles{display:flex;align-items:baseline;gap:10px;min-width:0}
.gp-overlay-titles strong{font:600 14px/1.3 system-ui,sans-serif;color:#e6e9ee}
.gp-overlay-titles span{font:400 12px/1.3 system-ui,sans-serif;color:#8b929c;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gp-overlay-close{height:28px;padding:0 12px;border:1px solid #33383f;border-radius:6px;
  background:#1d2026;color:#c8ccd2;cursor:pointer;font:500 12px/1 system-ui,sans-serif}
.gp-overlay-close:hover{background:#252931}
.gp-overlay-close:focus-visible{outline:2px solid #f0663f;outline-offset:2px}
.gp-overlay-body{flex:1;min-height:0;display:flex}
.gp-overlay-body>.gp-player{flex:1;min-width:0}
`;
  document.head.appendChild(style);
}
