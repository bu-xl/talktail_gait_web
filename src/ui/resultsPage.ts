/**
 * Full-page result browser (dates → sessions → detail).
 * Mirrors front_app Results* screens; uses back `/api/results/*` → ai-server.
 */

import {
  getResultDetail,
  listResultDates,
  listResultSessions,
  type DerivedPreview,
  type ResultDate,
  type ResultDetail,
  type ResultSession,
} from "../api/resultsApi.js";
import { hasDogInfo } from "../api/analyzeApi.js";
import { dogPrefix } from "../core/sessionNaming.js";
import { onLangChange, t } from "../i18n/index.js";
import { type LocaleKey } from "../i18n/locales.js";
import { openDogInfoModal } from "./dogInfoModal.js";
import { REPORT_PANES, ReviewSyncController } from "../player/reviewSync.js";
import { closeReportModal, openReportModal } from "./reportModal.js";
import { escapeHtml } from "./reportRender.js";
import {
  clearAngleDiffPane,
  loadAngleDiffPane,
  REVIEW_ANGLE_DIFF_TARGET,
} from "./angleDiffPane.js";

type Step = "dates" | "sessions" | "detail";

export class ResultsPage {
  private readonly root: HTMLElement;
  private readonly crumbsEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly refreshBtn: HTMLButtonElement;
  private readonly listEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly loadingEl: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly detailLoading: HTMLElement;
  private readonly reviewPanel: HTMLElement;
  private readonly openReportBtn: HTMLButtonElement;
  private readonly reviewInfoBtn: HTMLButtonElement | null;

  private apiBase = "";
  private step: Step = "dates";
  private selectedDate: ResultDate | null = null;
  private selectedSession: ResultSession | null = null;
  private lastPreview: DerivedPreview | null = null;
  private lastDetail: ResultDetail | null = null;
  private reviewSync: ReviewSyncController | null = null;
  private visible = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.crumbsEl = root.querySelector("#rpCrumbs") as HTMLElement;
    this.titleEl = root.querySelector("#rpTitle") as HTMLElement;
    this.subEl = root.querySelector("#rpSub") as HTMLElement;
    this.backBtn = root.querySelector("#rpBack") as HTMLButtonElement;
    this.refreshBtn = root.querySelector("#rpRefresh") as HTMLButtonElement;
    this.listEl = root.querySelector("#rpList") as HTMLElement;
    this.emptyEl = root.querySelector("#rpEmpty") as HTMLElement;
    this.loadingEl = root.querySelector("#rpLoading") as HTMLElement;
    this.detailEl = root.querySelector("#rpDetail") as HTMLElement;
    this.detailLoading = root.querySelector("#rpDetailLoading") as HTMLElement;
    this.reviewPanel = root.querySelector("#rpReviewPanel") as HTMLElement;
    this.openReportBtn = root.querySelector("#rpOpenReport") as HTMLButtonElement;
    this.reviewInfoBtn = root.querySelector("#rpReviewInfo") as HTMLButtonElement | null;

    this.backBtn.addEventListener("click", () => void this.goBack());
    this.refreshBtn.addEventListener("click", () => void this.refresh());
    this.openReportBtn.addEventListener("click", () => this.showReport());
    this.reviewInfoBtn?.addEventListener("click", () => this.showDogInfo());
    // One transport for all five panes. The per-pane play/speed bars are what
    // let the four videos drift apart, so the controller hides them.
    this.reviewSync = new ReviewSyncController(this.reviewPanel, REPORT_PANES, this.reviewPanel);

    onLangChange(() => {
      if (!this.visible) return;
      this.updateChrome();
      if (this.step !== "detail") void this.refresh();
    });
  }

  setApiBase(url: string): void {
    this.apiBase = url.replace(/\/$/, "");
  }

  show(): void {
    this.visible = true;
    this.root.hidden = false;
    void this.refresh();
  }

  hide(): void {
    this.visible = false;
    this.root.hidden = true;
    closeReportModal();
    this.clearPanes();
  }

  async refresh(): Promise<void> {
    if (!this.apiBase) {
      this.showEmpty(t("results_no_api"));
      return;
    }
    this.setLoading(true);
    try {
      if (this.step === "dates") await this.loadDates();
      else if (this.step === "sessions" && this.selectedDate) await this.loadSessions(this.selectedDate);
      else if (this.step === "detail" && this.selectedDate && this.selectedSession) {
        await this.openDetail(this.selectedDate, this.selectedSession);
      }
    } catch (err) {
      this.showEmpty(err instanceof Error ? err.message : String(err));
    } finally {
      this.setLoading(false);
    }
  }

  private async goBack(): Promise<void> {
    if (this.step === "detail") {
      closeReportModal();
      this.clearPanes();
      this.detailEl.classList.add("hidden");
      this.listEl.classList.remove("hidden");
      this.lastDetail = null;
      this.lastPreview = null;
      if (this.selectedDate) {
        this.step = "sessions";
        await this.loadSessions(this.selectedDate);
      }
      return;
    }
    if (this.step === "sessions") {
      this.step = "dates";
      this.selectedDate = null;
      this.selectedSession = null;
      await this.loadDates();
    }
  }

  private setLoading(on: boolean): void {
    this.loadingEl.classList.toggle("hidden", !on);
    this.refreshBtn.disabled = on;
    this.backBtn.disabled = on && this.step === "dates";
  }

  private showEmpty(msg?: string): void {
    this.listEl.innerHTML = "";
    this.emptyEl.textContent = msg || t("results_empty");
    this.emptyEl.classList.remove("hidden");
    this.detailEl.classList.add("hidden");
    this.listEl.classList.remove("hidden");
  }

  private updateChrome(): void {
    const onDates = this.step === "dates";
    this.backBtn.classList.toggle("hidden", onDates);
    this.backBtn.textContent = t("btn_results_back");
    this.refreshBtn.textContent = t("btn_results_refresh");

    if (this.step === "dates") {
      this.titleEl.textContent = t("nav_results");
      this.subEl.textContent = t("results_dates_hint");
      this.crumbsEl.textContent = t("results_list");
    } else if (this.step === "sessions" && this.selectedDate) {
      this.titleEl.textContent = this.selectedDate.displayDate;
      this.subEl.textContent = t("report_sessions_hint");
      this.crumbsEl.textContent = `${t("results_list")} › ${this.selectedDate.displayDate}`;
    } else if (this.step === "detail" && this.selectedDate && this.selectedSession) {
      const d = this.lastDetail;
      const orient = d?.session.orientation || this.selectedSession.orientation;
      const orientLabel = orient ? orientationLabel(orient) : "";
      this.titleEl.textContent = sessionLabel(this.selectedSession);
      this.subEl.textContent = orientLabel
        ? `${this.selectedDate.displayDate} · ${orientLabel}`
        : this.selectedDate.displayDate;
      this.crumbsEl.textContent = `${t("results_list")} › ${this.selectedDate.displayDate} › ${sessionLabel(this.selectedSession)}`;
    }
    this.syncActionLabels();
  }

  private syncActionLabels(): void {
    this.openReportBtn.textContent = t("report_open");
  }

  private async loadDates(): Promise<void> {
    this.step = "dates";
    this.selectedSession = null;
    this.detailEl.classList.add("hidden");
    this.listEl.classList.remove("hidden");
    this.updateChrome();

    const dates = await listResultDates(this.apiBase);
    this.emptyEl.classList.toggle("hidden", dates.length > 0);
    if (dates.length === 0) this.emptyEl.textContent = t("results_empty");
    this.listEl.innerHTML = "";
    this.listEl.className = "rp-grid";

    for (const d of dates) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rp-card";
      btn.innerHTML = `<span class="rp-card-title">${escapeHtml(d.displayDate)}</span><span class="rp-card-meta">${escapeHtml(d.date)}</span>`;
      btn.addEventListener("click", () => {
        this.selectedDate = d;
        void this.loadSessions(d);
      });
      this.listEl.appendChild(btn);
    }
  }

  private async loadSessions(date: ResultDate): Promise<void> {
    this.step = "sessions";
    this.selectedDate = date;
    this.selectedSession = null;
    this.detailEl.classList.add("hidden");
    this.listEl.classList.remove("hidden");
    this.updateChrome();

    const data = await listResultSessions(this.apiBase, date.date);
    this.emptyEl.classList.toggle("hidden", data.sessions.length > 0);
    if (data.sessions.length === 0) this.emptyEl.textContent = t("results_empty");
    this.listEl.innerHTML = "";
    this.listEl.className = "rp-grid";

    for (const s of data.sessions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rp-card";
      // 카드에는 개 이름 + 시간만 둔다(해상도/방향은 상세에서 본다).
      const meta = s.displayTime;
      const title = s.dog?.name || s.displayTime;
      btn.innerHTML = `<span class="rp-card-title">${escapeHtml(title)}</span><span class="rp-card-meta">${escapeHtml(meta)}</span>`;
      btn.addEventListener("click", () => void this.openDetail(date, s));
      this.listEl.appendChild(btn);
    }
  }

  private async openDetail(date: ResultDate, session: ResultSession): Promise<void> {
    this.step = "detail";
    this.selectedDate = date;
    this.selectedSession = session;
    this.lastDetail = null;
    this.lastPreview = null;
    this.listEl.classList.add("hidden");
    this.emptyEl.classList.add("hidden");
    this.detailEl.classList.remove("hidden");
    this.detailLoading.classList.remove("hidden");
    this.openReportBtn.disabled = true;
    this.clearPanes();
    this.updateChrome();

    try {
      const detail = await getResultDetail(this.apiBase, date.date, session.stem);
      this.lastDetail = detail;
      this.lastPreview = detail.report.derived.preview ?? null;
      this.updateChrome();
      // The five panes ARE the detail page now; the report is a click away.
      this.mountPanes(detail);
      this.openReportBtn.disabled = false;
    } catch (err) {
      this.clearPanes();
      this.showEmpty(err instanceof Error ? err.message : String(err));
    } finally {
      this.detailLoading.classList.add("hidden");
    }
  }

  /** Opens the shared report modal for the session on screen. */
  private showReport(): void {
    if (!this.lastDetail || !this.selectedSession) return;
    openReportModal({
      title: sessionLabel(this.selectedSession),
      subtitle: this.selectedDate?.displayDate ?? null,
      preview: this.lastPreview,
    });
  }

  /** Fills the five panes from the loaded detail. */
  private mountPanes(detail: ResultDetail): void {
    setReviewEmptyHints();
    // 압력패드: mp4면 video, 그 외(gif 등)면 img.
    const pressureUrl =
      detail.report.pressure?.available && detail.report.pressure.url
        ? detail.report.pressure.url
        : null;
    if (pressureUrl && /\.(mp4|webm|ogg)(\?|#|$)/i.test(pressureUrl)) {
      setReviewMedia("rpBody1", document.getElementById("rpPressureGif") as HTMLImageElement, null);
      setReviewMedia(
        "rpBody1",
        document.getElementById("rpPressureVideo") as HTMLVideoElement,
        pressureUrl,
      );
    } else {
      setReviewMedia(
        "rpBody1",
        document.getElementById("rpPressureVideo") as HTMLVideoElement,
        null,
      );
      setReviewMedia(
        "rpBody1",
        document.getElementById("rpPressureGif") as HTMLImageElement,
        pressureUrl,
      );
    }
    setReviewMedia(
      "rpBody21",
      document.getElementById("rpOriginVideo") as HTMLVideoElement,
      detail.original?.available && detail.original.url
        ? detail.original.url
        : detail.backOriginal?.available
          ? detail.backOriginal.url
          : null,
    );
    setReviewMedia(
      "rpBody22",
      document.getElementById("rpAnalysisVideo") as HTMLVideoElement,
      detail.video?.available !== false ? detail.video.url : null,
    );
    setReviewMedia(
      "rpBody31",
      document.getElementById("rpAngleVideo") as HTMLVideoElement,
      detail.report.angle_pawy?.available ? detail.report.angle_pawy.url : null,
    );
    // 3-2 는 측정 화면과 같은 각도 캐러셀(angle_diff JSON)이다 — 예전 stride PNG 가 아니다.
    const angleDiffUrl =
      detail.report.angle_diff?.available && detail.report.angle_diff.url
        ? detail.report.angle_diff.url
        : null;
    void loadAngleDiffPane(angleDiffUrl, REVIEW_ANGLE_DIFF_TARGET).catch((err) => {
      console.warn("[angle_diff] review pane load failed", err);
      clearAngleDiffPane(REVIEW_ANGLE_DIFF_TARGET);
    });

    // 저장된 반려견 정보가 있을 때만 "정보" 버튼을 띄운다(레이아웃은 그대로 둔다).
    if (this.reviewInfoBtn) {
      this.reviewInfoBtn.textContent = t("btn_dog_info");
      this.reviewInfoBtn.classList.toggle("hidden", !hasDogInfo(this.dogInfoOf(detail)));
    }

    // Sources were just assigned; re-pick the master and drive them as one.
    this.reviewSync?.refresh();
  }

  /** 세션 상세의 반려견 정보(이름·견종·몸무게·신장). */
  private dogInfoOf(detail: ResultDetail | null) {
    const dog = detail?.session?.dog;
    return {
      name: dog?.name ?? null,
      breed: dog?.breed ?? null,
      weightKg: dog?.weightKg ?? null,
      heightCm: dog?.heightCm ?? null,
    };
  }

  private showDogInfo(): void {
    const detail = this.lastDetail;
    const when = [this.selectedDate?.displayDate, this.selectedSession?.displayTime]
      .filter(Boolean)
      .join(" · ");
    openDogInfoModal({ ...this.dogInfoOf(detail), subtitle: when || null });
  }

  /** Tears every pane down: leaving the detail must not leave videos running. */
  private clearPanes(): void {
    for (const id of ["rpOriginVideo", "rpAnalysisVideo", "rpAngleVideo", "rpPressureVideo"]) {
      const v = document.getElementById(id) as HTMLVideoElement | null;
      if (!v) continue;
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
    // 3-2 는 캐러셀이라 자동재생 타이머까지 걷어내야 한다(닫아 두고 계속 돌면 안 된다).
    clearAngleDiffPane(REVIEW_ANGLE_DIFF_TARGET);
    const img = document.getElementById("rpStrideImg") as HTMLImageElement | null;
    img?.removeAttribute("src");
    const gif = document.getElementById("rpPressureGif") as HTMLImageElement | null;
    gif?.removeAttribute("src");
    for (const id of ["rpBody1", "rpBody21", "rpBody22", "rpBody31", "rpBody32"]) {
      const body = document.getElementById(id);
      body?.classList.remove("has-media");
      body?.classList.add("is-empty");
    }
    if (this.reviewInfoBtn) this.reviewInfoBtn.classList.add("hidden");
    this.reviewSync?.refresh();
  }
}

/**
 * `대박이-5.2kg-14:42:04` — the capture filename with a readable clock.
 *
 * Display only. `dogPrefix` is the same builder the filename uses, but the
 * stored `taskName` stays the key for anything that touches disk: renaming a
 * dog would change what this returns while the files keep the old name.
 */
function sessionLabel(s: ResultSession): string {
  const prefix = dogPrefix({ name: s.dog?.name, weightKg: s.dog?.weightKg });
  return prefix ? `${prefix}-${s.displayTime}` : s.displayTime;
}

function orientationLabel(o: string): string {
  if (o === "portrait") return t("orient_portrait");
  if (o === "landscape") return t("orient_landscape");
  if (o === "square") return t("orient_square");
  return t("orient_unknown");
}

function setReviewEmptyHints(): void {
  const map: Record<string, LocaleKey> = {
    rpBody1: "report_review_pressure_empty",
    rpBody21: "report_review_origin_empty",
    rpBody22: "report_review_analysis_empty",
    rpBody31: "report_review_angle_empty",
    rpBody32: "report_review_angle_diff_empty",
  };
  for (const [id, key] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.setAttribute("data-empty", t(key));
  }
}

function syncReviewBar(video: HTMLVideoElement): void {
  const bar = document.querySelector(`.ws-media-controls[data-video="${video.id}"]`);
  if (!bar) return;
  const playBtn = bar.querySelector(".ws-play") as HTMLButtonElement | null;
  const speed = bar.querySelector(".ws-speed") as HTMLSelectElement | null;
  if (playBtn) {
    playBtn.disabled = !video.getAttribute("src");
    const playing = !video.paused && !video.ended;
    playBtn.textContent = playing ? "⏸" : "▶";
  }
  if (speed) {
    speed.disabled = !video.getAttribute("src");
    if (video.getAttribute("src")) video.playbackRate = Number(speed.value) || 1;
  }
}

function setReviewMedia(
  bodyId: string,
  media: HTMLImageElement | HTMLVideoElement,
  url: string | null,
): void {
  const body = document.getElementById(bodyId);
  if (!body) return;
  if (!url) {
    if (media instanceof HTMLVideoElement) {
      media.pause();
      media.removeAttribute("src");
      media.load();
      syncReviewBar(media);
    } else {
      media.removeAttribute("src");
    }
    body.classList.remove("has-media");
    body.classList.add("is-empty");
    return;
  }

  if (media instanceof HTMLImageElement) {
    media.src = url;
    body.classList.add("has-media");
    body.classList.remove("is-empty");
    return;
  }

  media.pause();
  media.src = url;
  media.load();
  body.classList.add("has-media");
  body.classList.remove("is-empty");
  syncReviewBar(media);
  // Deliberately does NOT auto-play. Each pane starting itself is what put the
  // four videos on four clocks; ReviewSyncController starts them together.
}
