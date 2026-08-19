/**
 * Renderer entry: wires a FrameSource (Web Serial or replay) through the shared
 * ProcessingPipeline into the HeatmapRenderer + stats panel.
 *
 * Throughput model (important):
 *   - EVERY incoming frame is processed immediately in onFrame() — calibration,
 *     smoothing and stats run at the full mat input rate (~40 Hz). Nothing is
 *     dropped, so the mat's real Hz is used end-to-end.
 *   - Only the *paint* (the expensive canvas upsample + blur) is throttled by a
 *     rAF loop to render.target_fps. Painting at 30–60 fps a field that is
 *     already up to date does not require dropping input frames.
 *   - Two independent meters are shown: "Input Hz" (true frame-arrival rate from
 *     a sliding-window RateMeter) and "Render FPS" (paint rate).
 */

import { loadConfig } from "../core/config.js";
import { configureSync, isSyncEnabled, resolveApiBase, resolveRoomId, resolveWsUrl } from "../config/sync.js";
import { GRID_COLS, GRID_ROWS, aspectHeight } from "../core/constants.js";
import { framesToCanineGaitCsv } from "../core/csvExport.js";
import {
  analyzeRecordedSession,
  GaitAnalysisError,
  type GaitSummary,
} from "../core/gaitAnalysis.js";
import { LivePawTracker } from "../core/livePawTracker.js";
import { ProcessingPipeline, type ProcessedFrame } from "../core/pipeline.js";
import { buildRecordingPawTrack, type RecordingPawTrack } from "../core/pawTracking.js";
import { serializePlayback } from "../core/playbackParser.js";
import { SessionRecorder } from "../core/recorder.js";
import { FpsMeter, RateMeter, getSerialDisplayHz } from "../core/stats.js";
import type { AppConfig } from "../core/types.js";
import { countLabeled, type PawOverlayFrame } from "../gait/index.js";
import {
  encodeAnnotatedGif,
  renderAnnotatedHeatmap,
  type ExportCtx,
  type MakeCtx,
} from "../export/annotatedExport.js";
import { downloadBlob, downloadBytes, downloadText, fileStamp, rgbaToPngBlob } from "../export/download.js";
import { gaitSummaryToCsv } from "../export/gaitReportCsv.js";
import { gaitSummaryToJson } from "../export/gaitJson.js";
import { gaitReportToPdfBytes } from "../export/gaitReportPdf.js";
import { pawTrackToCsv } from "../export/pawTrackCsv.js";
import { createPressureCsvController } from "../pressure/pressureRecorderUI.js";
import { applyDocumentI18n, getLang, initI18n, onLangChange, setLang, t } from "../i18n/index.js";
import type { LocaleKey } from "../i18n/locales.js";
import {
  loadUserSettings,
  patchUserSettings,
  saveUserSettings,
  scheduleSaveSettings,
  type UserSettings,
} from "../settings/persist.js";
import { drawPawOverlay } from "../render/pawOverlayRenderer.js";
import { HeatmapRenderer } from "../render/heatmapRenderer.js";
import { IpcSource } from "../transport/ipcSource.js";
import { ReplaySource } from "../transport/replaySource.js";
import type { FrameSource } from "../transport/source.js";
import { WebSerialSource } from "../transport/webSerialSource.js";
import {
  GaitSyncSocket,
  waitUntilRecordAt,
  absolutizeResultUrl,
  pollJobUntilDone,
  confirmAnalyzeJob,
  cancelAnalyzeJob,
  type SyncPeers,
} from "../transport/gaitSocket.js";
import { hasDogInfo, type ManualAnalyzeJob, type ManualDogInfo } from "../api/analyzeApi.js";
import { showToast, updateQueueToast } from "../ui/toast.js";
import { ResultsPanel } from "../ui/resultsPanel.js";
import { ReportPage } from "../ui/reportPage.js";
import { UploadPage } from "../ui/uploadPage.js";
import { FilesPage } from "../ui/filesPage.js";
import { openDogInfoModal } from "../ui/dogInfoModal.js";
import {
  clearReviewPanes,
  setAnalysisVideo,
  setMaxMinVideo,
  setOriginVideo,
  setPressureGif,
  setPressureMedia,
} from "../ui/reviewPanes.js";
import { loadAngleDiffPane } from "../ui/angleDiffPane.js";
import { SyncPlaybackDock } from "../ui/syncPlaybackDock.js";
import { MEASURE_PANES, ReviewSyncController } from "../player/reviewSync.js";
import { wireWorkspaceVideoControls } from "../ui/workspaceVideoControls.js";

/** Promo filming cases. Open with `?promo=ami` (local dashboard_analysis) or `?promo=165529`. */
type PromoDogInfo = {
  name: { ko: string; en: string };
  breed: { ko: string; en: string };
  weightKg: number;
  /** Leave blank in the UI when null. */
  heightCm: number | null;
};

type PromoCase = {
  date: string;
  time: string;
  stem: string;
  originUpload: string;
  /** Pane 1 pressure media (gif or mp4). When set, overrides pad-session GIF. */
  pressureUrl?: string;
  /**
   * Artifact folder base. Defaults to `/api/ai-results/{date}/{time}`.
   * Local promo uses `/dashboard_analysis/<dog>_analysis/<time>`.
   */
  resultsBase?: string;
  dog: PromoDogInfo;
};

/** Fallback pane 1 when a promo case has no result_pressure file — `gait_project/foot2.gif`. */
const PROMO_PRESSURE_GIF = "/promo-assets/foot2.gif";

const PROMO_CASES: Record<string, PromoCase> = {
  ami: {
    date: "260807",
    time: "175433",
    stem: "analyzed-1366x768-18s-29p92fps-260807-175433",
    originUpload: "/dashboard_analysis/ami_analysis/ami_origin.mp4",
    resultsBase: "/dashboard_analysis/ami_analysis/175433",
    dog: {
      name: { ko: "아미", en: "Ami" },
      breed: { ko: "저먼 셰퍼드", en: "German Shepherd" },
      weightKg: 23,
      heightCm: null,
    },
  },
  "165529": {
    date: "260807",
    time: "165529",
    stem: "analyzed-1366x768-18s-29p92fps-260807-165529",
    originUpload: "/uploads/165529_origin.mp4",
    dog: {
      name: { ko: "아미", en: "Ami" },
      breed: { ko: "저먼 셰퍼드", en: "German Shepherd" },
      weightKg: 23,
      heightCm: null,
    },
  },
  "165613": {
    date: "260807",
    time: "165613",
    stem: "analyzed-1366x768-8s-29p83fps-260807-165613",
    originUpload: "/uploads/165613_origin.mp4",
    dog: {
      name: { ko: "제니", en: "Jenny" },
      breed: { ko: "래브라도 리트리버", en: "Labrador Retriever" },
      weightKg: 19,
      heightCm: null,
    },
  },
};

function readPromoCaseId(): string | null {
  try {
    const id = new URLSearchParams(window.location.search).get("promo");
    return id && PROMO_CASES[id] ? id : null;
  } catch {
    return null;
  }
}

/** Same-origin URL so Vite `/api`·`/uploads` proxy is used (avoids localhost↔IPv6 issues). */
function promoAssetUrl(path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `${window.location.origin}${clean}`;
}

function promoArtifactUrls(c: PromoCase): SessionArtifacts {
  const base = c.resultsBase ?? `/api/ai-results/${c.date}/${c.time}`;
  /** Pane 1 always from ai-server `results/<date>/<time>/result_pressure/`. */
  const pressureBase = `/api/ai-results/${c.date}/${c.time}`;
  const videoPath = `${base}/result_video/${c.stem}.mp4`;
  return {
    video: {
      kind: "video",
      available: true,
      url: promoAssetUrl(videoPath),
      filename: `${c.stem}.mp4`,
    },
    pressure: {
      kind: "pressure",
      available: true,
      url: promoAssetUrl(`${pressureBase}/result_pressure/${c.stem}_pressure.mp4`),
      filename: `${c.stem}_pressure.mp4`,
    },
    angle_pawy: {
      kind: "angle_pawy",
      available: true,
      url: promoAssetUrl(`${base}/result_angle_pawy/${c.stem}_angle_pawy.mp4`),
      filename: `${c.stem}_angle_pawy.mp4`,
    },
    stride: {
      kind: "stride",
      available: true,
      url: promoAssetUrl(`${base}/result_stride/${c.stem}_stride.png`),
      filename: `${c.stem}_stride.png`,
    },
    angle_diff: {
      kind: "angle_diff",
      available: true,
      url: promoAssetUrl(`${base}/result_angle_diff/${c.stem}_angle_diff.json`),
      filename: `${c.stem}_angle_diff.json`,
    },
    cyclogram: {
      kind: "cyclogram",
      available: true,
      url: promoAssetUrl(`${base}/result_cyclogram/${c.stem}_cyclogram.mp4`),
      filename: `${c.stem}_cyclogram.mp4`,
    },
    derived: {
      kind: "derived",
      available: true,
      url: promoAssetUrl(`${base}/result_derived/${c.stem}_derived.json`),
      filename: `${c.stem}_derived.json`,
    },
    keypoints: {
      kind: "keypoints",
      available: true,
      url: promoAssetUrl(`${base}/result_keypoints/${c.stem}_keypoints.json`),
      filename: `${c.stem}_keypoints.json`,
    },
  };
}

function applyPromoDogInfo(dog: PromoDogInfo): void {
  const lang = getLang() === "en" ? "en" : "ko";
  const nameEl = $opt("dogName") as HTMLInputElement | null;
  const heightEl = $opt("dogHeight") as HTMLInputElement | null;
  const weightEl = $opt("dogWeightInfo") as HTMLInputElement | null;
  const breedEl = $opt("dogBreed") as HTMLInputElement | null;
  if (nameEl) nameEl.value = dog.name[lang];
  if (heightEl) heightEl.value = dog.heightCm == null ? "" : String(dog.heightCm);
  if (weightEl) weightEl.value = dog.weightKg > 0 ? String(dog.weightKg) : "";
  if (breedEl) breedEl.value = dog.breed[lang];

  const form = $opt("dogInfoForm");
  const btn = $opt("btnDogInfoToggle") as HTMLButtonElement | null;
  if (form) {
    form.classList.remove("is-collapsed");
    if (btn) {
      btn.textContent = t("btn_dog_info_collapse");
      btn.setAttribute("aria-expanded", "true");
    }
  }
}

export type SessionArtifacts = Record<
  string,
  { kind?: string; filename?: string; url?: string | null; available?: boolean }
>;

/** Last clinic-session report payload (cyclogram + derived) for the Report tab later. */
let lastReportBundle: {
  originalUrl: string | null;
  artifacts: SessionArtifacts | null;
  date: string | null;
  time: string | null;
  stem: string | null;
  sessionPath: string | null;
} | null = null;

export function getLastReportBundle() {
  return lastReportBundle;
}

/** Live overlay canvas backing resolution — portrait 1 : 2.3014 (height derived
 *  from the true mat aspect), higher-res than the heatmap canvas so burned-in
 *  paw labels stay crisp when CSS-scaled up. */
const LIVE_OVERLAY_W = 300;
const LIVE_OVERLAY_H = aspectHeight(LIVE_OVERLAY_W); // 690

/** Browser canvas-2d factory for the annotated GIF/PNG exporters. */
const makeExportCtx: MakeCtx = (w, h) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable for export");
  return ctx as unknown as ExportCtx;
};

async function fetchConfig(): Promise<AppConfig> {
  try {
    const res = await fetch("./config.json");
    return loadConfig(await res.json());
  } catch {
    return loadConfig({});
  }
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

function $opt(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function onClick(id: string, handler: (ev: MouseEvent) => void): void {
  $opt(id)?.addEventListener("click", handler as EventListener);
}

function setSyncStatus(text: string, className?: string): void {
  const el = $opt("syncStatus");
  if (!el) return;
  el.textContent = text;
  if (className !== undefined) el.className = className;
}

/** Local UI simulation when ai-server is unavailable. `.env`: VITE_SIMULATE_AI=1 */
function isSimulateAi(): boolean {
  const v = String(import.meta.env.VITE_SIMULATE_AI ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function placeholderUrl(file: string): string {
  return `${window.location.origin}/placeholders/${file}`;
}

function wireSideToggle(): void {
  const btn = $("btnSideToggle") as HTMLButtonElement;
  const sync = (): void => {
    const collapsed = document.body.classList.contains("side-collapsed");
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    /* Rail is on the right: collapsed → open with ‹, open → close with › */
    btn.textContent = collapsed ? "‹" : "›";
    btn.title = collapsed ? t("side_toggle_open") : t("side_toggle_close");
  };
  btn.addEventListener("click", () => {
    document.body.classList.toggle("side-collapsed");
    sync();
  });
  onLangChange(sync);
  sync();
}

function wireDogInfoToggle(): void {
  const form = $opt("dogInfoForm");
  const btn = $opt("btnDogInfoToggle") as HTMLButtonElement | null;
  if (!form || !btn) return;
  const sync = (): void => {
    const collapsed = form.classList.contains("is-collapsed");
    btn.textContent = collapsed ? t("btn_dog_info_expand") : t("btn_dog_info_collapse");
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };
  btn.addEventListener("click", () => {
    form.classList.toggle("is-collapsed");
    sync();
  });
  sync();
}

type AppModule = "measure" | "report" | "upload" | "files";

const APP_MODULES: readonly AppModule[] = ["measure", "report", "upload", "files"];

/** 헤더 nav 를 연결하고, 코드에서 모듈을 바꿀 수 있는 함수를 돌려준다. */
function wireAppHeader(opts: { onModuleChange: (mod: AppModule) => void }): (mod: AppModule) => void {
  const setActive = (mod: AppModule): void => {
    document.body.dataset.module = mod;
    document.querySelectorAll<HTMLButtonElement>("#appHeader .ah-nav button[data-module]").forEach((btn) => {
      const active = btn.dataset.module === mod;
      btn.classList.toggle("active", active);
      if (active) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
    opts.onModuleChange(mod);
  };

  document.querySelectorAll<HTMLElement>("#appHeader [data-module], #appHeader [data-nav]").forEach((el) => {
    el.addEventListener("click", (ev) => {
      const target = ev.currentTarget as HTMLElement;
      const mod = (target.dataset.module || target.dataset.nav) as AppModule | undefined;
      if (!mod || !APP_MODULES.includes(mod)) return;
      if (target.tagName === "A") ev.preventDefault();
      setActive(mod);
    });
  });

  return setActive;
}

async function boot(): Promise<void> {
  const userSettings = loadUserSettings();
  const langParam = new URLSearchParams(window.location.search).get("lang");
  if (langParam === "en" || langParam === "ko") {
    userSettings.lang = langParam;
  }
  initI18n(userSettings.lang);
  wireSideToggle();
  wireDogInfoToggle();
  wireWorkspaceVideoControls();

  const config = await fetchConfig();
  configureSync(config.sync);
  const apiBase = resolveApiBase();
  const canvas = $("heatmap") as HTMLCanvasElement;
  // Derive the backing-store height from the width so it always matches the true
  // physical aspect (1 : 2.3014); the renderer reads this back from config.
  config.render.upsample_height = aspectHeight(config.render.upsample_width);
  canvas.width = config.render.upsample_width;
  canvas.height = config.render.upsample_height;

  config.render.show_grid = userSettings.showGrid;
  /** 체중 UI 제거 — 저장된 설정값(또는 기본값)만 사용 */
  const dogWeightKg = userSettings.dogWeight;

  const pipeline = new ProcessingPipeline(config);
  const renderer = new HeatmapRenderer(canvas, config);
  const renderFps = new FpsMeter();
  const inputHz = new RateMeter(1000);
  const recorder = new SessionRecorder();
  // One transport for the five review panes; the per-pane bars are hidden.
  const stageEl = document.getElementById("stage");
  const reviewSync = stageEl ? new ReviewSyncController(stageEl, MEASURE_PANES) : null;
  const syncDock = new SyncPlaybackDock();
  const cameraPlayer = syncDock.getPlayer();
  let syncSessionId: string | null = null;
  let syncRecordPending = false;
  let syncPlaybackActive = false;
  let lastAiVideoUrl: string | null = null;
  let pendingAnalyzeJob: string | null = null;
  /** Clinic session driven from the right-rail Start/Stop (web-led). */
  type SessionPhase = "idle" | "recording" | "saving" | "confirm" | "analyzing" | "review";
  let sessionPhase: SessionPhase = "idle";
  let pressureGifObjectUrl: string | null = null;
  let clinicSessionActive = false;
  let simulateTimer: number | null = null;
  let confirmBusy = false;
  /** 재촬영한 job 의 analyze_done 은 웹 리뷰 칸을 채우지 않는다. */
  let ignoreDoneJobId: string | null = null;
  /** 업로드보다 재촬영을 먼저 누른 경우, job 이 생기면 그때 AI 를 건너뛴다. */
  let retakeRequested = false;

  const clearSimulateTimer = (): void => {
    if (simulateTimer != null) {
      window.clearTimeout(simulateTimer);
      simulateTimer = null;
    }
  };

  const resultsPanelEl = $opt("resultsPanel");
  const resultsPanel = resultsPanelEl ? new ResultsPanel(resultsPanelEl) : null;
  resultsPanel?.setApiBase(apiBase);
  const reportPageEl = $opt("reportPage");
  const reportPage = reportPageEl ? new ReportPage(reportPageEl) : null;
  reportPage?.setApiBase(apiBase);
  const filesPageEl = $opt("filesPage");
  const filesPage = filesPageEl ? new FilesPage(filesPageEl) : null;
  filesPage?.setApiBase(apiBase);
  clearReviewPanes();

  const sessionBtn = $("btnSession") as HTMLButtonElement;
  /** 레일이 접혀 있을 때 측정 화면에 뜨는 시작/종료 미러 버튼 — 상태는 sessionBtn 을 따라간다. */
  const sessionFloatBtn = $opt("btnSessionFloat") as HTMLButtonElement | null;
  const sessionOverlay = $("sessionOverlay");
  const confirmModal = $("confirmAnalyzeModal");
  const confirmAnalyzeBtn = $("confirmAnalyzeBtn") as HTMLButtonElement;
  const confirmCancelBtn = $("confirmCancelBtn") as HTMLButtonElement;

  /**
   * 화면에 떠 있는 결과의 반려견 정보. 촬영 세션은 우측 레일 입력에서, 직접 분석은
   * 업로드 폼에서 온다 — 결과 섹션의 "정보" 버튼이 이 값을 보여 준다.
   */
  let lastDogInfo: ManualDogInfo | null = null;
  const stageInfoBtn = $opt("btnStageInfo") as HTMLButtonElement | null;

  /** 결과를 보고 있고 보여 줄 정보가 있을 때만 "정보" 버튼을 띄운다. */
  const syncStageInfoBtn = (): void => {
    const show = sessionPhase === "review" && hasDogInfo(lastDogInfo);
    stageInfoBtn?.classList.toggle("hidden", !show);
  };
  stageInfoBtn?.addEventListener("click", () => openDogInfoModal(lastDogInfo));

  /** 우측 레일 "반려견" 입력값 — 촬영 세션의 결과에 붙일 정보. */
  const readSideDogInfo = (): ManualDogInfo => {
    const text = (id: string): string | null =>
      ($opt(id) as HTMLInputElement | null)?.value.trim() || null;
    const num = (id: string): number | null => {
      const raw = text(id);
      if (!raw) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    return {
      name: text("dogName"),
      breed: text("dogBreed"),
      weightKg: num("dogWeightInfo"),
      heightCm: num("dogHeight"),
    };
  };

  const revokePressureGif = (): void => {
    if (pressureGifObjectUrl) {
      URL.revokeObjectURL(pressureGifObjectUrl);
      pressureGifObjectUrl = null;
    }
  };

  const hideConfirmModal = (): void => {
    confirmModal.classList.remove("open");
    document.body.classList.remove("modal-open");
  };

  const syncConfirmModal = (): void => {
    $("confirmAnalyzeTitle").textContent = t("confirm_analyze_title");
    confirmAnalyzeBtn.textContent = t("confirm_analyze_yes");
    confirmCancelBtn.textContent = t("confirm_analyze_no");
    const uploaded = Boolean(pendingAnalyzeJob);
    $("confirmAnalyzeHint").textContent = uploaded
      ? t("confirm_analyze_hint")
      : t("confirm_analyze_waiting_upload");
    confirmAnalyzeBtn.disabled = confirmBusy || !uploaded;
    confirmCancelBtn.disabled = confirmBusy;
  };

  const showConfirmModal = (): void => {
    syncConfirmModal();
    confirmModal.classList.add("open");
    document.body.classList.add("modal-open");
  };

  const setSessionPhase = (phase: SessionPhase): void => {
    sessionPhase = phase;
    document.body.classList.toggle("session-recording", phase === "recording");
    document.body.classList.toggle(
      "session-analyzing",
      phase === "analyzing" || phase === "saving" || phase === "confirm",
    );
    const showOverlay =
      phase === "recording" || phase === "analyzing" || phase === "saving";
    sessionOverlay.classList.toggle("show", showOverlay);
    if (phase !== "confirm") hideConfirmModal();

    if (phase === "recording") {
      $("sessionOverlayTitle").textContent = t("session_recording_title");
      $("sessionOverlaySub").textContent = t("session_recording_sub");
      sessionBtn.textContent = t("btn_session_stop");
      sessionBtn.classList.add("is-stop");
      sessionBtn.classList.remove("primary");
      sessionBtn.disabled = false;
    } else if (phase === "saving") {
      $("sessionOverlayTitle").textContent = t("session_saving_title");
      $("sessionOverlaySub").textContent = t("session_saving_sub");
      sessionBtn.textContent = t("btn_session_stop");
      sessionBtn.classList.add("is-stop");
      sessionBtn.disabled = true;
    } else if (phase === "confirm") {
      sessionBtn.textContent = t("btn_session_stop");
      sessionBtn.classList.add("is-stop");
      sessionBtn.disabled = true;
      showConfirmModal();
    } else if (phase === "analyzing") {
      $("sessionOverlayTitle").textContent = t("session_analyzing_title");
      $("sessionOverlaySub").textContent = t("session_analyzing_sub");
      sessionBtn.textContent = t("btn_session_stop");
      sessionBtn.classList.add("is-stop");
      sessionBtn.disabled = true;
    } else {
      sessionBtn.textContent = t("btn_session_start");
      sessionBtn.classList.remove("is-stop");
      sessionBtn.classList.add("primary");
      sessionBtn.disabled = false;
    }
    if (sessionFloatBtn) {
      sessionFloatBtn.textContent = sessionBtn.textContent;
      sessionFloatBtn.disabled = sessionBtn.disabled;
      sessionFloatBtn.classList.toggle("is-stop", sessionBtn.classList.contains("is-stop"));
    }
    syncStageInfoBtn();
  };

  /** 완료를 기다리는 분석 잡들 — WS `analyze_done` 을 놓쳤을 때의 백그라운드 폴링 폴백. */
  const watchedJobs = new Set<string>();

  type DoneBundle = {
    jobId: string | null;
    resultUrl: string;
    originalUrl?: string | null;
    artifacts?: SessionArtifacts | null;
    date?: string | null;
    time?: string | null;
    stem?: string | null;
    sessionPath?: string | null;
  };

  /**
   * 분석 완료 공통 처리 — 화면이 한가하면 바로 결과를 펼치고,
   * 다음 촬영/확인이 진행 중이면 화면을 뺏지 않고 토스트로만 알린다(클릭 시 열람).
   */
  const handleAnalyzeDone = (done: DoneBundle): void => {
    if (done.jobId) watchedJobs.delete(done.jobId);
    const review = {
      analysisUrl: absolutizeResultUrl(apiBase, done.resultUrl),
      originalUrl: done.originalUrl ?? null,
      artifacts: done.artifacts ?? null,
      date: done.date ?? null,
      time: done.time ?? null,
      stem: done.stem ?? null,
      sessionPath: done.sessionPath ?? null,
    };
    const openWhenSafe = (): void => {
      if (sessionPhase === "recording" || sessionPhase === "saving" || sessionPhase === "confirm") {
        // 촬영 흐름을 끊지 않는다 — 토스트를 다시 걸어 두고 나중에 연다.
        showToast({
          kind: "ok",
          title: t("toast_done_title"),
          message: t("toast_done_view"),
          durationMs: 12000,
          onClick: openWhenSafe,
        });
        return;
      }
      enterReview(review);
    };
    if (sessionPhase === "idle" || sessionPhase === "review") {
      enterReview(review);
      showToast({ kind: "ok", title: t("toast_done_title") });
    } else {
      showToast({
        kind: "ok",
        title: t("toast_done_title"),
        message: t("toast_done_view"),
        durationMs: 12000,
        onClick: openWhenSafe,
      });
    }
  };

  /** UI 를 막지 않는 잡 완료 감시. WS 가 먼저 처리하면 이 폴링은 조용히 물러난다. */
  const watchJob = (jobId: string): void => {
    if (watchedJobs.has(jobId)) return;
    watchedJobs.add(jobId);
    void pollJobUntilDone(apiBase, jobId, 5000, 60 * 60 * 1000)
      .then((job) => {
        if (!watchedJobs.has(jobId)) return;
        watchedJobs.delete(jobId);
        if (job.status === "completed" && job.resultUrl) {
          handleAnalyzeDone({
            jobId,
            resultUrl: job.resultUrl,
            originalUrl: job.originalUrl ?? null,
            artifacts: job.artifacts ?? null,
            date: job.date ?? null,
            time: job.time ?? null,
            stem: job.stem ?? null,
            sessionPath: job.sessionPath ?? null,
          });
        } else if (job.status === "failed") {
          showToast({ kind: "bad", title: t("toast_failed_title"), message: job.error ?? undefined });
          setSyncStatus(`${t("sync_analyze_failed")}: ${job.error ?? "unknown"}`, "bad");
        }
        // cancelled 등 다른 종결 상태는 취소 흐름이 이미 안내했다.
      })
      .catch(() => {
        watchedJobs.delete(jobId);
      });
  };

  const onConfirmAnalyze = (): void => {
    if (confirmBusy) return;
    const jobId = pendingAnalyzeJob;
    if (!jobId) {
      setSyncStatus(t("confirm_analyze_waiting_upload"), "warn");
      syncConfirmModal();
      return;
    }
    confirmBusy = true;
    retakeRequested = false;
    syncConfirmModal();
    void confirmAnalyzeJob(apiBase, jobId)
      .then((resp) => {
        // 분석은 큐에서 돌아간다 — 웹은 기다리지 않고 곧장 다음 촬영을 받을 수 있다.
        hideConfirmModal();
        pendingAnalyzeJob = null;
        clinicSessionActive = false;
        setSessionPhase("idle");
        setSyncStatus(t("sync_analyzing"), "wait");
        const behind = (resp?.queuePosition ?? 0) > 0;
        showToast({
          kind: "info",
          title: t("toast_enqueued_title"),
          message: behind ? t("toast_enqueued_next") : t("toast_enqueued_now"),
        });
        watchJob(jobId);
      })
      .catch((err) => {
        setSyncStatus(err instanceof Error ? err.message : String(err), "bad");
        setSessionPhase("confirm");
      })
      .finally(() => {
        confirmBusy = false;
        if (sessionPhase === "confirm") syncConfirmModal();
      });
  };

  const finishRetakeUi = (): void => {
    pendingAnalyzeJob = null;
    clinicSessionActive = false;
    cameraPlayer.setLoading(false);
    hideConfirmModal();
    clearReviewPanes();
    revokePressureGif();
    setSessionPhase("idle");
    setSyncStatus(t("confirm_analyze_cancelled"), "ok");
    updateSyncUi(gaitSync.peers, gaitSync.connected);
  };

  const skipAiForJob = (jobId: string): Promise<void> => {
    ignoreDoneJobId = jobId;
    return cancelAnalyzeJob(apiBase, jobId).then(() => undefined);
  };

  const onCancelAnalyze = (): void => {
    if (confirmBusy) return;
    const jobId = pendingAnalyzeJob;
    confirmBusy = true;
    retakeRequested = true;
    syncConfirmModal();
    if (!jobId) {
      finishRetakeUi();
      confirmBusy = false;
      return;
    }
    void skipAiForJob(jobId)
      .catch((err) => {
        setSyncStatus(err instanceof Error ? err.message : String(err), "bad");
      })
      .finally(() => {
        finishRetakeUi();
        confirmBusy = false;
      });
  };

  confirmAnalyzeBtn.addEventListener("click", () => onConfirmAnalyze());
  confirmCancelBtn.addEventListener("click", () => onCancelAnalyze());


  const buildPressureGifUrl = (): string | null => {
    if (recorder.frameCount < 2) return null;
    try {
      const track = getRecordingTrack();
      const po = config.paw_overlay;
      const delayMs = track.fps > 1 ? 1000 / track.fps : 33;
      const bytes = encodeAnnotatedGif({
        displayFields: track.displayFields,
        overlayFrames: track.overlayFrames,
        rows: GRID_ROWS,
        cols: GRID_COLS,
        width: po.gif_width,
        height: aspectHeight(po.gif_width),
        direction: track.direction,
        delayMs,
        config,
        unit: liveUnit(),
        timestampsSec: track.timestampsSec,
        maxFrames: po.gif_max_frames,
        makeCtx: makeExportCtx,
      });
      revokePressureGif();
      const copy = Uint8Array.from(bytes);
      pressureGifObjectUrl = URL.createObjectURL(new Blob([copy], { type: "image/gif" }));
      return pressureGifObjectUrl;
    } catch (err) {
      console.warn("[session] pressure gif failed", err);
      return null;
    }
  };

  const enterReview = (opts: {
    analysisUrl: string;
    originalUrl?: string | null;
    /** Pane 1 override (promo pressboard mp4 / gif). */
    pressureUrl?: string | null;
    artifacts?: SessionArtifacts | null;
    date?: string | null;
    time?: string | null;
    stem?: string | null;
    sessionPath?: string | null;
  }): void => {
    const { analysisUrl, originalUrl, artifacts } = opts;
    clearSimulateTimer();
    lastAiVideoUrl = analysisUrl;
    clinicSessionActive = false;
    setSessionPhase("review");
    sessionOverlay.classList.remove("show");

    // 2-1 원본 (back/uploads), 2-2 스켈레톤 영상
    if (originalUrl) {
      const abs =
        originalUrl.startsWith("http://") || originalUrl.startsWith("https://")
          ? originalUrl
          : absolutizeResultUrl(apiBase, originalUrl);
      setOriginVideo(abs);
    }
    setAnalysisVideo(analysisUrl);

    // 3-1 angle_pawy 영상, 3-2 angle_diff JSON (result_angle_diff)
    const angle = artifacts?.angle_pawy;
    if (angle?.available && angle.url) {
      const abs =
        angle.url.startsWith("http://") || angle.url.startsWith("https://")
          ? angle.url
          : absolutizeResultUrl(apiBase, angle.url);
      setMaxMinVideo(abs);
    }
    const angleDiff = artifacts?.angle_diff;
    if (angleDiff?.available && angleDiff.url) {
      const abs =
        angleDiff.url.startsWith("http://") || angleDiff.url.startsWith("https://")
          ? angleDiff.url
          : absolutizeResultUrl(apiBase, angleDiff.url);
      void loadAngleDiffPane(abs).catch((err) => {
        console.warn("[angle_diff] pane load failed", err);
      });
    } else {
      void loadAngleDiffPane(null);
    }

    // 1번 압력: result_pressure → explicit pressureUrl → pad-session GIF → placeholder
    const pressureArt = artifacts?.pressure;
    const pressureFromArtifacts =
      pressureArt && pressureArt.available !== false && pressureArt.url ? pressureArt.url : null;
    const pressureSrc = pressureFromArtifacts || opts.pressureUrl || null;
    if (pressureSrc) {
      const abs =
        pressureSrc.startsWith("http://") || pressureSrc.startsWith("https://")
          ? pressureSrc
          : absolutizeResultUrl(apiBase, pressureSrc);
      setPressureMedia(abs);
    } else {
      const gifUrl = buildPressureGifUrl() ?? (isSimulateAi() ? placeholderUrl("foot.gif") : null);
      if (gifUrl) setPressureGif(gifUrl);
    }

    // Sources are assigned; pick the master and drive all panes as one.
    reviewSync?.refresh();

    lastReportBundle = {
      originalUrl: originalUrl ?? null,
      artifacts: artifacts ?? null,
      date: opts.date ?? null,
      time: opts.time ?? null,
      stem: opts.stem ?? null,
      sessionPath: opts.sessionPath ?? null,
    };

    setSyncStatus(t("sync_analyze_done"), "ok");
    syncStageInfoBtn();
    void resultsPanel?.refresh();
  };

  /**
   * 직접 분석 — 업로드가 접수되면 측정 화면으로 옮기고 **큐 토스트로** 진행을 알린다.
   * 화면을 막지 않으므로 분석이 도는 동안에도 촬영 세션을 시작할 수 있다.
   * 이 잡은 WS 방에 속하지 않으므로(촬영 세션이 아니다) 완료는 백그라운드 잡 폴링으로 받는다.
   */
  const startManualAnalysis = (job: ManualAnalyzeJob, dog: ManualDogInfo): void => {
    lastDogInfo = dog;
    clinicSessionActive = false;
    syncSessionId = null;
    syncRecordPending = false;
    syncPlaybackActive = false;
    syncDock.stop();
    syncDock.hide();
    clearReviewPanes();
    revokePressureGif();
    setModule("measure");
    setSyncStatus(t("sync_analyzing"), "wait");
    const behind = (job.queuePosition ?? 0) > 0;
    showToast({
      kind: "info",
      title: t("toast_enqueued_title"),
      message: behind ? t("toast_enqueued_next") : t("toast_enqueued_now"),
    });
    watchJob(job.jobId);
  };

  const uploadPageEl = $opt("uploadPage");
  const uploadPage = uploadPageEl
    ? new UploadPage(uploadPageEl, {
        apiBase,
        onSubmitted: (job, dog) => startManualAnalysis(job, dog),
      })
    : null;

  const setModule = wireAppHeader({
    onModuleChange: (mod) => {
      if (mod === "report") reportPage?.show();
      else reportPage?.hide();
      if (mod === "upload") uploadPage?.show();
      else uploadPage?.hide();
      if (mod === "files") filesPage?.show();
      else filesPage?.hide();
    },
  });

  const updateSyncUi = (peers?: SyncPeers, hubConnected?: boolean): void => {
    const mobileEl = $opt("syncStatus");
    const hubEl = $opt("syncHub");
    if (hubConnected === false) {
      if (hubEl) {
        hubEl.textContent = t("sync_hub_disconnected");
        hubEl.className = "off";
      }
      if (mobileEl) {
        mobileEl.textContent = "–";
        mobileEl.className = "off";
      }
      if (!syncPlaybackActive) cameraPlayer.clearPreview();
      return;
    }
    if (hubEl) {
      hubEl.textContent = t("sync_hub_connected");
      hubEl.className = "ok";
    }
    const mobile = peers?.mobile ?? false;
    const camCount = peers?.mobileCount ?? (mobile ? 1 : 0);
    const hasMain = peers?.main;
    if (mobileEl) {
      if (!mobile) {
        mobileEl.textContent = t("sync_mobile_waiting");
        mobileEl.className = "wait";
      } else if (hasMain === false) {
        // 카메라는 있으나 Main 없음 → 분석 대상 없음 경고.
        mobileEl.textContent = t("sync_no_main", { n: camCount });
        mobileEl.className = "wait";
      } else {
        mobileEl.textContent =
          camCount > 1 ? t("sync_mobile_connected_n", { n: camCount }) : t("sync_mobile_connected");
        mobileEl.className = "ok";
      }
    }
    if (mobile && !syncPlaybackActive && cameraPlayer.getMode() === "idle") {
      cameraPlayer.showIdle(t("camera_preview_receiving"));
    }
    if (!mobile && !syncPlaybackActive) cameraPlayer.clearPreview();
  };

  const renderSyncedMatFrame = (raw: import("../core/types.js").Matrix): void => {
    const processed = pipeline.process(raw);
    renderer.render(processed.pressure, processed.rows, processed.cols);
    clearOverlay();
  };

  const beginSyncedPlayback = async (videoUrl: string): Promise<void> => {
    const frames = recorder.getFrames();
    if (frames.length === 0) return;
    lastAiVideoUrl = videoUrl;
    syncPlaybackActive = true;
    displayMode = "live";
    peakHold = null;
    clearOverlay();
    setSyncStatus(t("sync_analyze_done"), "ok");
    try {
      await syncDock.play(frames, videoUrl, (raw) => renderSyncedMatFrame(raw));
    } catch (err) {
      syncPlaybackActive = false;
      syncDock.hide();
      setSyncStatus(err instanceof Error ? err.message : String(err), "bad");
    }
  };

  // --- Paw-label overlay (live) -------------------------------------------
  // A transparent canvas layered over the heatmap; the gait engine runs on the
  // live stream and we draw LF/RF/LH/RH boxes on top, in real time.
  const overlayCanvas = $("overlay") as HTMLCanvasElement;
  overlayCanvas.width = LIVE_OVERLAY_W;
  overlayCanvas.height = LIVE_OVERLAY_H;
  const overlayCtx = overlayCanvas.getContext("2d");
  if (!overlayCtx) throw new Error("2D overlay context unavailable");
  const clearOverlay = (): void =>
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

  const weightOf = (): number => dogWeightKg || config.gait.default_weight_kg;

  const liveTracker = new LivePawTracker(config, weightOf());
  let overlayEnabled = userSettings.overlayEnabled;
  let latestOverlay: PawOverlayFrame | null = null;
  let liveBaseline: ReturnType<ProcessingPipeline["snapshotBaseline"]>["baseline"] | null = null;
  /** Cached recording analysis so GIF/PNG/CSV don't re-run the engine each click. */
  let cachedTrack: { weight: number; n: number; data: RecordingPawTrack } | null = null;

  // --- Recording display: persist footprints, then 5s hold -> back to live ---
  // "live"      : normal real-time view (instantaneous, fades out on lift).
  // "recording" : peak-HOLD — every contact the sensor sees stays on screen,
  //               accumulating the full footprint of the walk (no fade).
  // "hold"      : after Stop, the accumulated footprint is frozen for 5 s, then
  //               the view automatically returns to "live".
  const RECORD_CELLS = GRID_ROWS * GRID_COLS;
  const HOLD_MS = 5000;
  let displayMode: "live" | "recording" | "hold" = "live";
  let peakHold: Float64Array | null = null; // per-cell max of processed pressure
  let holdToken = 0; // cancels a pending hold->live timer when state changes

  // Processing runs at full input rate; the render loop only paints the latest
  // processed frame. `frameSeq` marks a new frame so the paint loop knows when
  // there is something fresh to draw (and when to fall back to fade-out).
  let latestProcessed: ProcessedFrame | null = null;
  let frameSeq = 0;
  let paintedSeq = 0;
  let lastFrameAt = 0;
  let measuredHz = 0;
  let source: FrameSource | null = null;
  let lastStatus: { connected: boolean; detail?: string } = { connected: false };
  let lastStatsFrame: ProcessedFrame | null = null;
  let lastStatsFps = 0;
  let lastStatsHz = 0;

  const sharpModes: Array<{
    labelKey: LocaleKey;
    interpolation: "nearest" | "bilinear";
    sigmaMin: number;
    sigmaMax: number;
  }> = [
    { labelKey: "btn_sharp_soft", interpolation: "bilinear", sigmaMin: 0.4, sigmaMax: 1.6 },
    { labelKey: "btn_sharp_crisp", interpolation: "bilinear", sigmaMin: 0, sigmaMax: 0 },
    { labelKey: "btn_sharp_pixel", interpolation: "nearest", sigmaMin: 0, sigmaMax: 0 },
  ];
  let sharpIdx = userSettings.sharpIdx;

  const applySharpMode = (idx: number): void => {
    sharpIdx = idx % sharpModes.length;
    const m = sharpModes[sharpIdx];
    config.render.interpolation = m.interpolation;
    config.render.gaussian_sigma_min = m.sigmaMin;
    config.render.gaussian_sigma_max = m.sigmaMax;
    renderer.setConfig(config);
    const sharpBtn = $opt("btnSharp");
    if (sharpBtn) sharpBtn.textContent = t(m.labelKey);
  };
  applySharpMode(sharpIdx);

  const collectSettings = (): UserSettings => ({
    version: 1,
    lang: getLang(),
    dogWeight: weightOf(),
    overlayEnabled,
    showGrid: config.render.show_grid,
    sharpIdx,
  });

  const persistSettings = (): void => scheduleSaveSettings(collectSettings);

  const localizeStatusDetail = (detail?: string): string | undefined => {
    if (!detail) return undefined;
    const known: Record<string, LocaleKey> = {
      connected: "status_connected",
      disconnected: "status_disconnected",
      idle: "status_idle",
      "no COM port found": "status_no_port",
      "waiting for STM USB": "status_waiting_stm",
      "serial module load failed": "status_serial_load_failed",
      "port busy": "status_port_busy",
      "calibrating baseline…": "status_calibrating",
      "Web Serial API unavailable (use Chrome/Edge).": "status_web_serial_unavailable",
    };
    if (known[detail]) return t(known[detail]);
    if (detail.startsWith("connected ")) return `${t("status_connected")} · ${detail.slice(10)}`;
    return detail;
  };

  const setStatus = (connected: boolean, detail?: string): void => {
    lastStatus = { connected, detail };
    const text = localizeStatusDetail(detail) ?? (connected ? t("status_connected") : t("status_idle"));
    $("status").textContent = connected ? `● ${text}` : `○ ${text}`;
    const waiting =
      !connected &&
      !!detail &&
      detail !== "idle" &&
      detail !== "disconnected";
    $("status").className = connected ? "ok" : waiting ? "warn" : "off";

    const panel = $opt("padConnectPanel");
    panel?.classList.toggle("is-connected", connected);
    panel?.classList.toggle("is-waiting", waiting);

    const connectBtn = $opt("btnConnect") as HTMLButtonElement | null;
    if (connectBtn) {
      connectBtn.textContent = connected ? t("btn_reconnect") : t("btn_connect_pad");
      connectBtn.classList.toggle("primary", !connected);
    }

    const calBtn = $opt("btnCalibrate") as HTMLButtonElement | null;
    if (calBtn) calBtn.disabled = !connected;
  };
  // 패드를 연결하기 전에는 소스가 없어 onStatus 가 한 번도 안 온다 — 그 사이 index.html 의
  // 한국어 초기값("○ 대기")이 그대로 보이므로, 처음부터 현재 언어로 그려 둔다.
  setStatus(false);

  const attach = (src: FrameSource): void => {
    source?.stop();
    pipeline.reset();
    inputHz.reset();
    latestProcessed = null;
    frameSeq = 0;
    paintedSeq = 0;
    lastFrameAt = 0;
    // New source -> drop any live paw-track state + cached recording analysis.
    liveTracker.reset();
    latestOverlay = null;
    liveBaseline = null;
    cachedTrack = null;
    // New source -> always return to the live view (cancel any record/hold state).
    displayMode = "live";
    peakHold = null;
    holdToken++;
    clearOverlay();
    source = src;
    src.onStatus(setStatus);
    src.onFrame((raw) => {
      // Full-rate path: process EVERY frame as it arrives. This is the cheap
      // part (a few passes over 1600 cells); the expensive paint is throttled
      // separately in the rAF loop below.
      const now = performance.now();
      measuredHz = inputHz.tick(now);
      recorder.add(raw, now); // captures raw frames while recording (no-op otherwise)
      latestProcessed = pipeline.process(raw);
      // While recording, accumulate a peak-HOLD footprint so every contact the
      // sensor detects stays on screen (per-cell max; untouched cells stay NaN).
      if (displayMode === "recording") {
        if (!peakHold) peakHold = new Float64Array(RECORD_CELLS).fill(NaN);
        const p = latestProcessed.pressure;
        for (let i = 0; i < RECORD_CELLS; i++) {
          const v = p[i];
          if (Number.isFinite(v) && v > 0) {
            peakHold[i] = Number.isFinite(peakHold[i]) ? Math.max(peakHold[i]!, v) : v;
          }
        }
      }
      // Live paw labelling: run the gait engine on the calibrated delta and keep
      // the latest overlay for the paint loop. Needs a baseline (delta polarity).
      if (overlayEnabled && pipeline.isCalibrated) {
        if (!liveBaseline) liveBaseline = pipeline.snapshotBaseline().baseline;
        latestOverlay = liveTracker.process(raw, liveBaseline, now);
      } else {
        latestOverlay = null;
      }
      frameSeq++;
      lastFrameAt = now;
      if (recorder.isRecording) updateRecordingStatus();
    });
    void src.start();
  };

  // --- Recording + export -------------------------------------------------
  const setExportsEnabled = (on: boolean): void => {
    for (const id of ["btnCsv", "btnTrackCsv", "btnGif", "btnPng", "btnReplay", "btnGait"]) {
      const btn = $opt(id) as HTMLButtonElement | null;
      if (btn) btn.disabled = !on;
    }
  };

  // Run (or reuse) the authoritative recording analysis used by all annotated
  // exports. Keyed by frame count + weight so repeated clicks are instant.
  const getRecordingTrack = (): RecordingPawTrack => {
    const weight = weightOf();
    const n = recorder.frameCount;
    if (cachedTrack && cachedTrack.weight === weight && cachedTrack.n === n) {
      return cachedTrack.data;
    }
    const snap = pipeline.snapshotBaseline();
    const displayFields = pipeline.exportPressures(recorder.getRawFrames()).map((f) => f.pressure);
    const data = buildRecordingPawTrack(recorder.getFrames(), snap.baseline, config, weight, displayFields);
    cachedTrack = { weight, n, data };
    return data;
  };

  const liveUnit = (): string => latestProcessed?.unit ?? "rel";

  // --- Gait analysis ------------------------------------------------------
  let lastGait: GaitSummary | null = null;
  const setGaitReportsEnabled = (on: boolean): void => {
    for (const id of ["btnGaitCsv", "btnGaitPdf", "btnGaitJson"]) {
      const btn = $opt(id) as HTMLButtonElement | null;
      if (btn) btn.disabled = !on;
    }
  };

  onClick("btnGait", () => {
    const btn = $opt("btnGait") as HTMLButtonElement | null;
    if (!btn) return;
    const weight = weightOf();
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = t("analyzing");
    // Defer so the button state repaints before the (synchronous) analysis runs.
    setTimeout(() => {
      try {
        const snap = pipeline.snapshotBaseline();
        lastGait = analyzeRecordedSession(recorder.getFrames(), snap.baseline, config, weight);
        renderGaitPanel(lastGait);
        setGaitReportsEnabled(true);
      } catch (err) {
        const msg =
          err instanceof GaitAnalysisError
            ? err.message
            : `${t("gait_error_prefix")}: ${String(err)}`;
        showGaitError(msg);
        setGaitReportsEnabled(false);
      } finally {
        btn.disabled = false;
        btn.textContent = prev;
      }
    }, 0);
  });

  onClick("btnGaitCsv", () => {
    if (!lastGait) return;
    downloadText(`gait-report-${fileStamp()}.csv`, gaitSummaryToCsv(lastGait));
  });

  onClick("btnGaitPdf", async () => {
    if (!lastGait) return;
    const btn = $opt("btnGaitPdf") as HTMLButtonElement | null;
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = t("pdf_generating");
    try {
      const bytes = await gaitReportToPdfBytes(lastGait);
      downloadBytes(`gait-report-${fileStamp()}.pdf`, bytes, "application/pdf");
    } finally {
      btn.disabled = false;
      btn.textContent = t("btn_report_pdf");
    }
  });

  onClick("btnGaitJson", () => {
    if (!lastGait) return;
    downloadText(`gait-report-${fileStamp()}.json`, gaitSummaryToJson(lastGait), "application/json");
  });
  const updateRecordingStatus = (): void => {
    const n = recorder.frameCount;
    const d = recorder.durationSec.toFixed(1);
    $("statRec").textContent = recorder.isRecording
      ? t("rec_recording", { n, d })
      : n > 0
        ? t("rec_frames", { n, d, hz: recorder.fps.toFixed(0) })
        : "–";
    $("statRec").className = recorder.isRecording ? "warn" : "ok";
    const recBtn = $opt("btnRecord");
    if (recBtn) {
      recBtn.textContent = recorder.isRecording ? t("btn_stop") : t("btn_record");
    }
  };

  // 세션 종료 시 압력판 CSV 업로드 + 저장 CSV 목록. 강아지 정보는 "반려견" 입력란에서 읽는다.
  const pressureCsv = createPressureCsvController({
    apiBase,
    frameCount: () => recorder.frameCount,
    durationSec: () => recorder.durationSec,
    fps: () => recorder.fps,
    buildCsv: () => framesToCanineGaitCsv(recorder.getFrames(), GRID_ROWS, GRID_COLS),
    rows: GRID_ROWS,
    cols: GRID_COLS,
    // 동기 촬영 세션과 같은 sessionId 로 묶어 back 이 영상+CSV 를 한 세션으로 연결하게 한다.
    sessionId: () => syncSessionId,
  });

  const startLocalRecording = (wallAnchorMs?: number): void => {
    syncDock.stop();
    syncDock.hide();
    syncPlaybackActive = false;
    // 이번 세션 결과에 붙일 반려견 정보 — CSV 업로드와 같은 입력란에서 읽는다.
    lastDogInfo = readSideDogInfo();
    const t0 =
      wallAnchorMs != null ? performance.now() + (wallAnchorMs - Date.now()) : performance.now();
    recorder.start(t0);
    setExportsEnabled(false);
    cachedTrack = null;
    displayMode = "recording";
    peakHold = null;
    holdToken++;
    updateRecordingStatus();
    persistSettings();
  };

  const stopLocalRecording = (): void => {
    recorder.stop();
    // 세션 종료 → 캡처된 압력 프레임을 CSV 로 서버에 저장(프레임 없으면 내부에서 무시).
    void pressureCsv.uploadRecorded();
    setExportsEnabled(recorder.frameCount > 0);
    displayMode = "hold";
    const myToken = ++holdToken;
    window.setTimeout(() => {
      if (holdToken === myToken && displayMode === "hold") {
        displayMode = "live";
        peakHold = null;
        clearOverlay();
      }
    }, HOLD_MS);
    updateRecordingStatus();
    persistSettings();
  };

  const gaitSync = new GaitSyncSocket({ wsUrl: resolveWsUrl(), roomId: resolveRoomId() });
  gaitSync.onConnectionChange((connected) => {
    updateSyncUi(gaitSync.peers, connected);
  });
  gaitSync.onMessage((msg) => {
    if (msg.type === "joined" || msg.type === "peer_update") {
      updateSyncUi(msg.peers, true);
    }
    if (msg.type === "preview_frame") {
      if (!syncPlaybackActive && !syncDock.isVisible) {
        const mime = msg.mime || "image/jpeg";
        cameraPlayer.showPreviewFrame(`data:${mime};base64,${msg.data}`);
      }
    }
    if (msg.type === "sync_start") {
      syncRecordPending = false;
      syncSessionId = msg.sessionId;
      syncDock.hide();
      syncPlaybackActive = false;
      clearReviewPanes();
      revokePressureGif();
      setSessionPhase("recording");
      setSyncStatus(t("sync_pending"));
      void waitUntilRecordAt(msg.recordAt).then(() => {
        if (!recorder.isRecording) startLocalRecording(msg.recordAt);
      });
    }
    if (msg.type === "record_stop") {
      syncRecordPending = false;
      if (recorder.isRecording) stopLocalRecording();
      syncSessionId = null;
      if (clinicSessionActive || sessionPhase === "recording") {
        setSessionPhase("confirm");
        setSyncStatus(t("confirm_analyze_waiting_upload"), "wait");
      }
    }
    if (msg.type === "upload_started") {
      pendingAnalyzeJob = msg.jobId;
      cameraPlayer.setLoading(false);
      if (retakeRequested) {
        retakeRequested = false;
        void skipAiForJob(msg.jobId)
          .catch((err) => {
            setSyncStatus(err instanceof Error ? err.message : String(err), "bad");
          })
          .finally(() => {
            finishRetakeUi();
          });
        return;
      }
      setSyncStatus(t("confirm_analyze_hint"), "wait");
      setSessionPhase("confirm");
      syncConfirmModal();
    }
    if (msg.type === "analyze_done") {
      if (msg.jobId && msg.jobId === ignoreDoneJobId) {
        ignoreDoneJobId = null;
        return;
      }
      // 큐 도입 후에는 이전 잡의 완료가 **다음 촬영 도중** 도착할 수 있다.
      // 지금 확인을 기다리는 잡(pendingAnalyzeJob)이 아니면 건드리지 않는다.
      if (msg.jobId && msg.jobId === pendingAnalyzeJob) pendingAnalyzeJob = null;
      cameraPlayer.setLoading(false);
      handleAnalyzeDone({
        jobId: msg.jobId ?? null,
        resultUrl: msg.resultUrl,
        originalUrl: msg.originalUrl ?? null,
        artifacts: msg.artifacts ?? null,
        date: msg.date ?? null,
        time: msg.time ?? null,
        stem: msg.stem ?? null,
        sessionPath: msg.sessionPath ?? null,
      });
    }
    if (msg.type === "analyze_failed") {
      if (msg.jobId) watchedJobs.delete(msg.jobId);
      cameraPlayer.setLoading(false);
      showToast({ kind: "bad", title: t("toast_failed_title"), message: msg.error });
      setSyncStatus(`${t("sync_analyze_failed")}: ${msg.error}`, "bad");
      if (msg.jobId && msg.jobId === pendingAnalyzeJob) pendingAnalyzeJob = null;
      // 진행 중인 촬영/확인 UI 는 유지한다 — 이전 잡의 실패가 다음 촬영을 끊지 않게.
      if (sessionPhase === "analyzing") {
        clinicSessionActive = false;
        setSessionPhase("idle");
      }
    }
    if (msg.type === "analyze_cancelled") {
      watchedJobs.delete(msg.jobId);
      if (pendingAnalyzeJob && msg.jobId === pendingAnalyzeJob) {
        // 다른 곳(또는 경합)에서 취소됨 — 확인 모달을 접고 대기 상태로.
        finishRetakeUi();
      }
      showToast({ kind: "warn", title: t("toast_cancelled_title"), message: t("toast_cancelled_msg") });
    }
    if (msg.type === "analysis_queue") {
      updateQueueToast(msg);
    }
    if (msg.type === "error") {
      syncRecordPending = false;
      setSyncStatus(msg.message, "bad");
    }
  });
  if (isSyncEnabled()) {
    gaitSync.connect();
  } else {
    updateSyncUi(undefined, false);
  }
  syncDock.setOnBack(() => {
    syncPlaybackActive = false;
    syncDock.stop();
    displayMode = "live";
    peakHold = null;
    clearOverlay();
    if (gaitSync.peers.mobile) cameraPlayer.showIdle(t("camera_preview_receiving"));
  });
  void resultsPanel?.refresh();
  setSessionPhase("idle");

  const startClinicSession = (): void => {
    if (
      sessionPhase === "recording" ||
      sessionPhase === "analyzing" ||
      sessionPhase === "saving" ||
      sessionPhase === "confirm"
    ) {
      return;
    }
    // Simulate mode: web-only Start/Stop to verify review panes without app/AI.
    if (isSimulateAi()) {
      clinicSessionActive = true;
      revokePressureGif();
      clearReviewPanes();
      syncRecordPending = false;
      setSyncStatus(t("sim_recording"), "wait");
      setSessionPhase("recording");
      if (gaitSync.connected && gaitSync.peers.mobile) {
        syncRecordPending = true;
        gaitSync.requestRecord();
      }
      return;
    }
    if (!gaitSync.connected) {
      setSyncStatus(t("session_need_hub"), "bad");
      return;
    }
    if (!gaitSync.peers.mobile) {
      setSyncStatus(t("session_need_mobile"), "warn");
      return;
    }
    clinicSessionActive = true;
    retakeRequested = false;
    ignoreDoneJobId = null;
    pendingAnalyzeJob = null;
    revokePressureGif();
    clearReviewPanes();
    syncRecordPending = true;
    setSyncStatus(t("sync_pending"), "wait");
    setSessionPhase("recording");
    gaitSync.requestRecord();
  };

  const stopClinicSession = (): void => {
    if (sessionPhase !== "recording" && !recorder.isRecording) return;
    if (recorder.isRecording) stopLocalRecording();
    if (gaitSync.connected && gaitSync.peers.mobile) {
      gaitSync.stopRecord(syncSessionId);
    }
    syncSessionId = null;
    syncRecordPending = false;
    pendingAnalyzeJob = null;
    retakeRequested = false;
    setSessionPhase("confirm");
    setSyncStatus(t("confirm_analyze_waiting_upload"), "wait");
    updateSyncUi(gaitSync.peers, gaitSync.connected);
  };

  /**
   * 측정 시작 전 ~1초 빈-매트 Zero/Baseline 보정.
   * 무하중 RAW 로 센서별 median baseline 을 만들어 이후 측정에서 (baseline − raw)
   * 신호가 정확히 잡히게 한다. 그동안 "매트에서 내려주세요" 안내를 띄운다.
   */
  const runZeroCalibration = async (): Promise<void> => {
    const hz = measuredHz > 1 ? measuredHz : 43;
    const seconds = Math.max(0.5, config.baseline.collect_seconds >= 1 ? 1 : config.baseline.collect_seconds);
    pipeline.beginBaseline(hz, seconds);
    liveBaseline = null;
    liveTracker.reset();
    latestOverlay = null;
    clearOverlay();

    const startAt = performance.now();
    sessionOverlay.classList.add("show");
    const titleEl = $("sessionOverlayTitle");
    const subEl = $("sessionOverlaySub");
    titleEl.textContent = t("zero_cal_title");
    // 타이머로 진행률/완료를 구동한다(백그라운드 탭에서 rAF 가 멈춰도 항상 종료됨).
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        window.clearInterval(iv);
        subEl.textContent = t("zero_cal_sub", { pct: 100 });
        resolve();
      };
      const iv = window.setInterval(() => {
        const elapsed = (performance.now() - startAt) / 1000;
        const pct = Math.min(100, Math.round((elapsed / seconds) * 100));
        subEl.textContent = t("zero_cal_sub", { pct });
        if (elapsed >= seconds) finish();
      }, 100);
      window.setTimeout(finish, seconds * 1000 + 60);
    });
    // 창이 끝나면 수집을 마감(빈 매트 프레임이 없었으면 fallback baseline 유지).
    pipeline.finishBaseline();
  };

  const onSessionButtonClick = (): void => {
    if (sessionPhase === "recording") {
      stopClinicSession();
      return;
    }
    if (
      sessionPhase === "analyzing" ||
      sessionPhase === "saving" ||
      sessionPhase === "confirm"
    ) {
      return;
    }
    // 시작 → 1초 영점 보정 후 기존 세션 시작 흐름 진행.
    sessionBtn.disabled = true;
    if (sessionFloatBtn) sessionFloatBtn.disabled = true;
    void runZeroCalibration().finally(() => {
      sessionBtn.disabled = false;
      if (sessionFloatBtn) sessionFloatBtn.disabled = false;
      startClinicSession();
    });
  };
  sessionBtn.addEventListener("click", onSessionButtonClick);
  sessionFloatBtn?.addEventListener("click", onSessionButtonClick);

  onClick("btnRecord", () => {
    /* Pad-only / legacy control — clinic flow prefers #btnSession (Start/Stop). */
    if (recorder.isRecording) {
      stopLocalRecording();
      if (gaitSync.connected && gaitSync.peers.mobile) {
        gaitSync.stopRecord(syncSessionId);
        setSyncStatus(t("session_saving_sub"), "wait");
        setSessionPhase("saving");
      }
      syncSessionId = null;
      syncRecordPending = false;
      updateSyncUi(gaitSync.peers, gaitSync.connected);
      return;
    }

    if (gaitSync.connected && gaitSync.peers.mobile) {
      clinicSessionActive = true;
      clearReviewPanes();
      revokePressureGif();
      syncRecordPending = true;
      setSyncStatus(t("sync_pending"));
      setSessionPhase("recording");
      gaitSync.requestRecord();
      return;
    }

    if (gaitSync.connected) {
      setSyncStatus(t("sync_need_mobile"), "warn");
      return;
    }

    startLocalRecording();
  });

  onClick("btnCsv", () => {
    const csv = framesToCanineGaitCsv(recorder.getFrames(), GRID_ROWS, GRID_COLS);
    downloadText(`gait-${fileStamp()}.csv`, csv);
  });

  // Paw-tracking CSV: per-frame, per-paw label + position + pressure.
  onClick("btnTrackCsv", () => {
    const btn = $opt("btnTrackCsv") as HTMLButtonElement | null;
    if (!btn) return;
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = t("csv_generating");
    try {
      const track = getRecordingTrack();
      const csv = pawTrackToCsv(track.overlayFrames, track.displayFields, track.timestampsSec, GRID_COLS);
      downloadText(`gait-pawtrack-${fileStamp()}.csv`, csv);
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });

  onClick("btnGif", async () => {
    const btn = $opt("btnGif") as HTMLButtonElement | null;
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = t("gif_generating");
    try {
      const track = getRecordingTrack();
      const po = config.paw_overlay;
      const delayMs = track.fps > 1 ? 1000 / track.fps : 33;
      const bytes = encodeAnnotatedGif({
        displayFields: track.displayFields,
        overlayFrames: track.overlayFrames,
        rows: GRID_ROWS,
        cols: GRID_COLS,
        width: po.gif_width,
        height: aspectHeight(po.gif_width), // true 1:2.3014 aspect
        direction: track.direction,
        delayMs,
        config,
        unit: liveUnit(),
        timestampsSec: track.timestampsSec,
        maxFrames: po.gif_max_frames,
        makeCtx: makeExportCtx,
      });
      downloadBytes(`gait-tracked-${fileStamp()}.gif`, bytes);
    } finally {
      btn.disabled = false;
      btn.textContent = t("btn_gif");
    }
  });

  onClick("btnPng", async () => {
    const btn = $opt("btnPng") as HTMLButtonElement | null;
    if (!btn) return;
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = t("png_generating");
    try {
      const track = getRecordingTrack();
      const po = config.paw_overlay;
      const arrow = track.direction === "left_to_right" ? " →" : track.direction === "right_to_left" ? " ←" : "";
      const header = `PEAK  paws:${track.summaryFrame.items.length}${arrow}`;
      const img = renderAnnotatedHeatmap({
        peakField: track.peakField,
        summaryFrame: track.summaryFrame,
        rows: GRID_ROWS,
        cols: GRID_COLS,
        width: po.png_width,
        height: aspectHeight(po.png_width), // true 1:2.3014 aspect
        config,
        unit: liveUnit(),
        makeCtx: makeExportCtx,
        header,
      });
      const blob = await rgbaToPngBlob(img.rgba, img.width, img.height);
      downloadBlob(`gait-peak-${fileStamp()}.png`, blob);
    } finally {
      btn.disabled = false;
      btn.textContent = prev;
    }
  });

  onClick("btnReplay", () => {
    if (lastAiVideoUrl && recorder.frameCount > 0) {
      void beginSyncedPlayback(lastAiVideoUrl);
      return;
    }
    syncDock.hide();
    syncPlaybackActive = false;
    // Replay the captured raw frames through the normal pipeline at capture rate.
    const text = serializePlayback(
      recorder.getFrames().map((f) => ({ timestamp: f.t.toFixed(0), raw: f.raw })),
      GRID_ROWS,
      GRID_COLS,
    );
    const fps = recorder.fps > 1 ? recorder.fps : config.render.target_fps;
    attach(new ReplaySource(text, fps, false));
  });
  setExportsEnabled(false);

  onClick("btnCalibrate", () => {
    // Size the baseline window from the MEASURED input rate so the requested
    // collect_seconds holds regardless of the mat's actual Hz (fallback 40).
    const hz = measuredHz > 1 ? measuredHz : 40;
    pipeline.beginBaseline(hz);
    // New baseline incoming -> refresh the live tracker's delta reference.
    liveBaseline = null;
    liveTracker.reset();
    latestOverlay = null;
    clearOverlay();
    setStatus(true, "calibrating baseline…");
    persistSettings();
  });

  const btnLabels = $opt("btnLabels") as HTMLButtonElement | null;
  const refreshLabelsBtn = (): void => {
    if (!btnLabels) return;
    btnLabels.textContent = overlayEnabled ? t("btn_labels_on") : t("btn_labels_off");
    btnLabels.classList.toggle("active", overlayEnabled);
  };
  btnLabels?.addEventListener("click", () => {
    overlayEnabled = !overlayEnabled;
    if (!overlayEnabled) {
      latestOverlay = null;
      clearOverlay();
    }
    refreshLabelsBtn();
    persistSettings();
  });
  refreshLabelsBtn();
  onClick("btnGrid", () => {
    config.render.show_grid = !config.render.show_grid;
    renderer.setConfig(config);
    persistSettings();
  });
  onClick("btnSharp", () => {
    applySharpMode(sharpIdx + 1);
    persistSettings();
  });
  ($opt("file") as HTMLInputElement | null)?.addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    attach(new ReplaySource(await file.text(), config.render.target_fps));
  });

  const minFrameMs = 1000 / config.render.target_fps;
  let lastRenderAt = 0;

  const loop = (now: number): void => {
    requestAnimationFrame(loop);
    if (syncPlaybackActive) return;
    // Throttle only the PAINT; processing already happened at full input rate.
    if (now - lastRenderAt < minFrameMs) return;
    const dt = now - lastRenderAt;
    lastRenderAt = now;

    // Recording / post-record hold -> show the persistent peak-HOLD footprint
    // (every contact the sensor saw stays on screen). The live two-branch path
    // below only runs in "live" mode.
    if (displayMode !== "live") {
      if (peakHold) renderer.render(peakHold, GRID_ROWS, GRID_COLS);
      if (displayMode === "recording") {
        const rf = latestProcessed;
        if (rf && frameSeq !== paintedSeq) {
          paintedSeq = frameSeq;
          const hzNow = getSerialDisplayHz(inputHz, now);
          const fpsNow = renderFps.tick(now);
          updateStats(rf, fpsNow, hzNow, config);
          lastStatsFrame = rf;
          lastStatsFps = fpsNow;
          lastStatsHz = hzNow;
        }
        // Live paw labels still draw on top of the accumulating footprint.
        clearOverlay();
        if (overlayEnabled && latestOverlay && latestOverlay.items.length > 0) {
          const st = liveTracker.getStatus();
          const header = st.tracking
            ? t("overlay_tracking", { n: countLabeled(latestOverlay) })
            : t("overlay_warming", { n: latestOverlay.items.length });
          drawPawOverlay(overlayCtx as unknown as ExportCtx, latestOverlay, {
            canvasW: overlayCanvas.width,
            canvasH: overlayCanvas.height,
            gridRows: GRID_ROWS,
            gridCols: GRID_COLS,
            field: latestProcessed ? latestProcessed.pressure : undefined,
            unit: latestProcessed?.unit ?? "rel",
            header,
          });
        }
      } else {
        clearOverlay(); // hold: frozen footprint, no live labels
      }
      return;
    }

    const frame = latestProcessed;
    if (frame && frameSeq !== paintedSeq) {
      // Fresh processed frame available -> draw it.
      paintedSeq = frameSeq;
      renderer.render(frame.pressure, frame.rows, frame.cols);
      const hzNow = getSerialDisplayHz(inputHz, now);
      const fpsNow = renderFps.tick(now);
      updateStats(frame, fpsNow, hzNow, config);
      lastStatsFrame = frame;
      lastStatsFps = fpsNow;
      lastStatsHz = hzNow;
      clearOverlay();
      if (overlayEnabled && latestOverlay && latestOverlay.items.length > 0) {
        const st = liveTracker.getStatus();
        const header = st.tracking
          ? t("overlay_tracking", { n: countLabeled(latestOverlay) })
          : t("overlay_warming", { n: latestOverlay.items.length });
        drawPawOverlay(overlayCtx as unknown as ExportCtx, latestOverlay, {
          canvasW: overlayCanvas.width,
          canvasH: overlayCanvas.height,
          gridRows: frame.rows,
          gridCols: frame.cols,
          field: frame.pressure,
          unit: frame.unit,
          header,
        });
      }
    } else if (lastFrameAt > 0 && now - lastFrameAt > 50) {
      // Input stalled -> fade out toward zero and let the Input Hz readout decay.
      const faded = pipeline.fade(dt);
      renderer.render(faded, 40, 40);
      clearOverlay();
      measuredHz = inputHz.hz(now);
      $("statHz").textContent = `${measuredHz.toFixed(0)} Hz`;
    }
  };
  requestAnimationFrame(loop);

  ($("langSelect") as HTMLSelectElement).value = userSettings.lang;
  ($("langSelect") as HTMLSelectElement).addEventListener("change", (e) => {
    const v = (e.target as HTMLSelectElement).value;
    setLang(v === "en" ? "en" : "ko");
    patchUserSettings({ lang: getLang() });
  });

  const promoCaseId = readPromoCaseId();
  const promoCase = promoCaseId ? PROMO_CASES[promoCaseId] : null;
  if (promoCase) applyPromoDogInfo(promoCase.dog);

  onLangChange(() => {
    applyDocumentI18n();
    refreshLabelsBtn();
    applySharpMode(sharpIdx);
    const dogForm = $opt("dogInfoForm");
    const dogBtn = $opt("btnDogInfoToggle") as HTMLButtonElement | null;
    if (dogForm && dogBtn) {
      const collapsed = dogForm.classList.contains("is-collapsed");
      dogBtn.textContent = collapsed ? t("btn_dog_info_expand") : t("btn_dog_info_collapse");
    }
    if (promoCase) applyPromoDogInfo(promoCase.dog);
    const { connected, detail } = lastStatus;
    setStatus(connected, detail);
    updateRecordingStatus();
    updateSyncUi(gaitSync.peers, gaitSync.connected);
    if (lastStatsFrame) updateStats(lastStatsFrame, lastStatsFps, lastStatsHz, config);
    if (lastGait) renderGaitPanel(lastGait);
  });

  // Electron: node-serialport + port picker modal. Browser: Web Serial picker.
  if (IpcSource.available()) {
    attach(new IpcSource());

    const modal = $("portModal");
    const portListEl = $("portList");
    const portEmpty = $("portEmpty");
    const portConfirm = $("portConfirm") as HTMLButtonElement;
    let selectedPath = "";

    const closePortModal = (): void => {
      modal.classList.remove("open");
      selectedPath = "";
      portConfirm.disabled = true;
    };

    const renderPorts = async (): Promise<void> => {
      portListEl.innerHTML = "";
      selectedPath = "";
      portConfirm.disabled = true;
      portEmpty.classList.add("show");
      portEmpty.textContent = t("port_modal_loading");
      try {
        const result = await window.matApi?.listPorts();
        const ports = Array.isArray(result) ? result : (result?.ports ?? []);
        const error = Array.isArray(result) ? undefined : result?.error;
        if (error) {
          portEmpty.textContent = t("port_modal_error", { msg: error });
          portEmpty.classList.add("show");
          return;
        }
        if (!ports.length) {
          portEmpty.textContent = t("port_modal_empty");
          portEmpty.classList.add("show");
          return;
        }
        portEmpty.classList.remove("show");
        let idx = 0;
        for (const p of ports) {
          const li = document.createElement("li");
          const id = `port-opt-${idx++}`;
          const label = document.createElement("label");
          label.className = "port-item";
          label.htmlFor = id;
          const radio = document.createElement("input");
          radio.type = "radio";
          radio.name = "serialPort";
          radio.id = id;
          radio.value = p.path;
          if (p.recommended && !selectedPath) {
            radio.checked = true;
            label.classList.add("selected");
            selectedPath = p.path;
            portConfirm.disabled = false;
          }
          radio.addEventListener("change", () => {
            if (!radio.checked) return;
            selectedPath = p.path;
            portConfirm.disabled = false;
            portListEl.querySelectorAll("label.port-item").forEach((el) => {
              el.classList.remove("selected");
            });
            label.classList.add("selected");
          });
          const text = document.createElement("span");
          text.className = "port-label";
          text.textContent = p.label;
          label.appendChild(radio);
          label.appendChild(text);
          if (p.recommended) {
            const badge = document.createElement("span");
            badge.className = "badge-rec";
            badge.textContent = t("port_modal_recommended");
            label.appendChild(badge);
          }
          li.appendChild(label);
          portListEl.appendChild(li);
        }
      } catch (err) {
        portEmpty.textContent = t("port_modal_error", {
          msg: err instanceof Error ? err.message : String(err),
        });
        portEmpty.classList.add("show");
      }
    };

    const openPortModal = (): void => {
      modal.classList.add("open");
      void renderPorts();
    };

    onClick("btnConnect", () => openPortModal());
    $("portCancel").addEventListener("click", () => closePortModal());
    $("portRefresh").addEventListener("click", () => void renderPorts());
    modal.addEventListener("click", (ev) => {
      if (ev.target === modal) closePortModal();
    });
    $("portConfirm").addEventListener("click", () => {
      if (!selectedPath) return;
      const path = selectedPath;
      closePortModal();
      setStatus(false, "waiting for STM USB");
      void window.matApi?.start(path);
    });
    window.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && modal.classList.contains("open")) closePortModal();
    });
  } else {
    onClick("btnConnect", () => attach(new WebSerialSource()));
    setStatus(false);
  }

  window.addEventListener("beforeunload", () => {
    saveUserSettings(collectSettings());
    syncDock.stop();
    gaitSync.disconnect();
    void source?.stop();
  });

  if (promoCase) {
    setSyncStatus(t("promo_loading", { id: promoCaseId }), "wait");
    void (async () => {
      try {
        const artifacts = promoArtifactUrls(promoCase);
        const analysisUrl = artifacts.video?.url;
        if (!analysisUrl) throw new Error("promo video url missing");

        enterReview({
          analysisUrl,
          originalUrl: promoAssetUrl(promoCase.originUpload),
          // Pane 1: artifacts.pressure → ai-server result_pressure; else optional promo override / GIF.
          pressureUrl: promoCase.pressureUrl
            ? promoAssetUrl(promoCase.pressureUrl)
            : undefined,
          artifacts,
          date: promoCase.date,
          time: promoCase.time,
          stem: promoCase.stem,
          sessionPath: `${promoCase.date}/${promoCase.time}`,
        });
        if (!$opt("wsBody1")?.classList.contains("has-media")) {
          setPressureGif(promoAssetUrl(PROMO_PRESSURE_GIF));
        }

        // Warm the results sidebar list (API may use localhost; failure is non-fatal).
        void resultsPanel?.refresh();
        setSyncStatus(t("promo_ready", { id: promoCaseId }), "ok");
      } catch (err) {
        console.error("[promo] load failed", err);
        setSyncStatus(
          t("promo_failed", { msg: err instanceof Error ? err.message : String(err) }),
          "bad",
        );
      }
    })();
  }
}

function updateStats(
  frame: ProcessedFrame,
  fpsValue: number,
  inputHzValue: number,
  _config: AppConfig,
): void {
  const u = frame.unit;
  const f1 = (x: number): string => x.toFixed(1);
  $("statMax").textContent = `${f1(frame.stats.maxPressure)} ${u}`;
  $("statAvg").textContent = `${f1(frame.stats.avgPressure)} ${u}`;
  $("statContact").textContent = `${f1(frame.stats.contactAreaCm2)} cm²`;
  $("statMedium").textContent = `${f1(frame.stats.mediumAreaCm2)} cm²`;
  $("statHigh").textContent = `${f1(frame.stats.highAreaCm2)} cm²`;
  $("statHz").textContent = `${inputHzValue.toFixed(0)} Hz`;
  $("statFps").textContent = `${fpsValue.toFixed(0)} fps`;
  $("statCal").textContent =
    frame.state === "calibrated" ? t("cal_calibrated") : t("cal_uncalibrated");
  $("statCal").className = frame.state === "calibrated" ? "ok" : "warn";

  // 압력패드 섹션 아래 간이 요약(요소가 있을 때만).
  const setOpt = (id: string, text: string): void => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  const calibrated = frame.state === "calibrated";
  setOpt("padSumPeak", `${f1(frame.stats.maxPressure)} ${u}`);
  setOpt("padSumAvg", `${f1(frame.stats.avgPressure)} ${u}`);
  setOpt("padSumContact", `${f1(frame.stats.contactAreaCm2)} cm²`);
  const stateEl = document.getElementById("padSumState");
  if (stateEl) {
    stateEl.textContent = calibrated ? t("pad_state_calibrated") : t("pad_state_relative");
    stateEl.className = calibrated ? "ok" : "warn";
  }
}

const DIRECTION_LABEL_KEY: Record<GaitSummary["direction"], LocaleKey> = {
  left_to_right: "direction_ltr",
  right_to_left: "direction_rtl",
  unknown: "direction_unknown",
};

function renderGaitPanel(s: GaitSummary): void {
  $("gaitResult").classList.add("show");
  const badge = $("gaitBadge");
  badge.textContent = s.validity;
  badge.className = `badge ${s.validity}`;

  const f1 = (x: number | null, d = 1, u = ""): string =>
    x == null || !Number.isFinite(x) ? "–" : `${x.toFixed(d)}${u}`;

  $("gaitDir").textContent =
    `${t(DIRECTION_LABEL_KEY[s.direction])} (${(s.directionConfidence * 100).toFixed(0)}%)`;
  $("gaitDir").className = s.direction === "unknown" ? "warn" : "ok";
  $("gaitPaws").textContent = s.detectedPaws.length
    ? `${s.detectedPaws.join(", ")}${s.missingPaws.length ? t("gait_miss", { list: s.missingPaws.join(",") }) : ""}`
    : t("gait_none");
  $("gaitDur").textContent = `${f1(s.durationSec, 2, "s")} · ${f1(s.effectiveHz, 0)}Hz`;
  $("gaitCadence").textContent = f1(s.cadenceHz, 2, " Hz");
  $("gaitFH").textContent = `${f1(s.loadDist.forePct, 0, "%")} / ${f1(s.loadDist.hindPct, 0, "%")}`;
  $("gaitSym").textContent = s.symmetry
    ? `${f1(s.symmetry.fore.symmetryIndex, 0, "%")}${s.symmetry.fore.warning ? "⚠" : ""}` +
      ` / ${f1(s.symmetry.hind.symmetryIndex, 0, "%")}${s.symmetry.hind.warning ? "⚠" : ""}`
    : "–";

  // Absolute-unit clinical metrics (enabled by the real cell pitch).
  const c = s.clinical;
  $("gaitSpeed").textContent =
    c.speedMs != null ? `${f1(c.speedMs, 2, " m/s")} · ${f1(c.speedKmh, 1, " km/h")}` : "–";
  $("gaitStride").textContent = `${f1(c.strideLengthCm, 1, " cm")} / ${f1(c.stepLengthCm, 1, " cm")}`;
  $("gaitStepW").textContent = f1(c.stepWidthCm, 1, " cm");
  $("gaitDS").textContent =
    c.doubleSupportPct != null ? `${f1(c.doubleSupportSec, 2, "s")} · ${f1(c.doubleSupportPct, 0, "%")}` : "–";
  $("gaitCop").textContent = c.cop
    ? `${f1(c.cop.pathLengthCm, 0, " cm")} · ${f1(c.cop.areaCm2, 0, " cm²")}`
    : "–";
  $("gaitSeq").textContent = c.pawSequence.length
    ? c.pawSequence.join(" → ") + (c.sequenceRegular === false ? " ⚠" : "")
    : "–";

  const flagsEl = $("gaitFlags");
  flagsEl.innerHTML = "";
  for (const fl of c.flags) {
    const div = document.createElement("div");
    const color =
      fl.severity === "high"
        ? "var(--danger)"
        : fl.severity === "warn"
          ? "var(--warning)"
          : "var(--muted)";
    div.textContent = `⚠ ${fl.detail}`;
    div.style.cssText = `font-size:12px;color:${color};padding:2px 0;line-height:1.35;`;
    flagsEl.appendChild(div);
  }

  const tbody = $("gaitTbody");
  tbody.innerHTML = "";
  for (const p of s.paws) {
    const tr = document.createElement("tr");
    const cells = [
      p.label,
      f1(p.loadPct, 0),
      f1(p.peakPressure, 0),
      f1(p.pressureImpulse, 0),
      f1(p.contactArea, 1),
      String(p.stepCount),
    ];
    for (let i = 0; i < cells.length; i++) {
      const td = document.createElement("td");
      td.textContent = cells[i];
      if (!p.detected) td.className = "dim";
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  $("gaitNote").textContent = s.summaryText;
}

function showGaitError(message: string): void {
  $("gaitResult").classList.add("show");
  const badge = $("gaitBadge");
  badge.textContent = t("error_badge");
  badge.className = "badge INVALID";
  for (const id of [
    "gaitDir", "gaitPaws", "gaitDur", "gaitCadence", "gaitFH", "gaitSym",
    "gaitSpeed", "gaitStride", "gaitStepW", "gaitDS", "gaitCop", "gaitSeq",
  ]) {
    $(id).textContent = "–";
  }
  $("gaitFlags").innerHTML = "";
  $("gaitTbody").innerHTML = "";
  $("gaitNote").textContent = message;
}

void boot();
