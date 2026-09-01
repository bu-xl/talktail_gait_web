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

import {
  CAPTURE_PRESETS,
  captureSettingsPayload,
  presetById,
  type CapturePreset,
} from "../capture/presets.js";
import { configureSync, isSyncEnabled, resolveApiBase, resolveRoomId, resolveWsUrl } from "../config/sync.js";
import { clockSync } from "../transport/clockSync.js";
import { loadConfig } from "../core/config.js";
import { GRID_COLS, GRID_ROWS, aspectHeight } from "../core/constants.js";
import { checkDogIdentity } from "../core/dogIdentity.js";
import { camKey, countCamsInState } from "../core/camState.js";
import { framesToCanineGaitCsv } from "../core/csvExport.js";
import { dogPrefix, pressureCsvName, stampFrom } from "../core/sessionNaming.js";
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
  clampRecordSec,
  MIN_RECORD_SEC,
  MAX_RECORD_SEC,
  RECORD_SEC_STEP,
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
  type CamState,
} from "../transport/gaitSocket.js";
import type { ManualAnalyzeJob, ManualDogInfo } from "../api/analyzeApi.js";
import {
  dismissTopToast,
  showToast,
  showTopToast,
  updateQueueToast,
} from "../ui/toast.js";
import { CompletedPage } from "../ui/completedPage.js";
import { DogPresetsCard } from "../ui/dogPresetsCard.js";
import type { CompletedSessionRef } from "../ui/completedPage.js";
import { getResultDetail, listResultDates, listResultSessions } from "../api/resultsApi.js";
import { getSessionNotes, saveSessionNotes } from "../api/sessionNotesApi.js";
import { discardSession } from "../api/storedFilesApi.js";
import { ResultsPage } from "../ui/resultsPage.js";
import { ReportsPage } from "../ui/reportsPage.js";
import { UploadPage } from "../ui/uploadPage.js";
import { FilesPage } from "../ui/filesPage.js";
import { CsvPage } from "../ui/csvPage.js";
import { VerifyPage } from "../ui/verifyPage.js";
import { StoragePage } from "../ui/storagePage.js";
import { AccountsPage } from "../ui/accountsPage.js";
import { wireMyPage } from "../ui/myPage.js";
import { fetchMe, listUsers, logout, type AuthUser } from "../api/authApi.js";
import { getViewScope, setViewScope } from "../api/http.js";
import { requireLogin, watchSessionExpiry } from "../auth/loginGate.js";
import { APP_VERSION } from "../version.js";
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

}

export type SessionArtifacts = Record<
  string,
  { kind?: string; filename?: string; url?: string | null; available?: boolean }
>;

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

/**
 * 촬영 흐름 안내문 — **문제가 있을 때만 보인다.**
 *
 * 정상 대기 상태의 "연결됨 / 대기중" 같은 줄은 읽히지 않으면서 카드 자리만 먹는다.
 * 경고(warn) · 오류(bad) · 대기(wait)일 때만 나타나게 해서, 이 줄이 보이면 곧
 * "지금 뭔가 확인해야 한다" 는 뜻이 되게 한다.
 */
function setSyncStatus(text: string, className?: string): void {
  const el = $opt("syncStatus");
  if (!el) return;
  el.textContent = text;
  if (className !== undefined) el.className = className;
  const cls = className ?? el.className;
  el.hidden = !text || cls === "ok" || cls === "off" || cls === "";
}

/** Local UI simulation when ai-server is unavailable. `.env`: VITE_SIMULATE_AI=1 */
function isSimulateAi(): boolean {
  const v = String(import.meta.env.VITE_SIMULATE_AI ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function placeholderUrl(file: string): string {
  return `${window.location.origin}/placeholders/${file}`;
}

type AppModule =
  | "accounts"
  | "measure"
  | "results"
  | "report"
  | "upload"
  | "files"
  | "csv"
  | "verify"
  | "review"
  | "storage"
  | "mypage";

const APP_MODULES: readonly AppModule[] = [
  "accounts",
  "measure",
  "results",
  "report",
  "upload",
  "files",
  "csv",
  "verify",
  "review",
  "storage",
  "mypage",
];

/** 헤더 nav 를 연결하고, 코드에서 모듈을 바꿀 수 있는 함수를 돌려준다. */
const MODULE_STORAGE_KEY = "gait.activeModule";

/**
 * 새로고침해도 보던 화면에 머문다.
 *
 * 노트북 두 대를 역할별로 고정해 쓰기 때문이다. 열람용 노트북이 새로고침마다
 * 측정 화면으로 돌아가면 매번 탭을 다시 눌러야 하고, 그 사이 측정용 제어가 붙는다.
 */
function loadActiveModule(): AppModule | null {
  try {
    const saved = localStorage.getItem(MODULE_STORAGE_KEY) as AppModule | null;
    return saved && APP_MODULES.includes(saved) ? saved : null;
  } catch {
    return null;
  }
}

function wireAppHeader(opts: { onModuleChange: (mod: AppModule) => void }): (mod: AppModule) => void {
  const menu = document.querySelector<HTMLDetailsElement>("#appHeader .ah-menu");
  const setActive = (mod: AppModule): void => {
    document.body.dataset.module = mod;
    try {
      localStorage.setItem(MODULE_STORAGE_KEY, mod);
    } catch {
      // 시크릿 모드 등 저장이 막힌 환경 — 이번 세션에서만 유지된다.
    }
    document.querySelectorAll<HTMLElement>("#appHeader .ah-nav [data-module]").forEach((btn) => {
      const active = btn.dataset.module === mod;
      btn.classList.toggle("active", active);
      if (active) btn.setAttribute("aria-current", "page");
      else btn.removeAttribute("aria-current");
    });
    if (menu) {
      // 메뉴 안의 화면을 보고 있으면 ≡ 자체를 활성으로 — 헤더가 통째로 비어 보이지 않게.
      menu.open = false;
      menu.querySelector("summary")?.classList.toggle("active", !!menu.querySelector(`[data-module="${mod}"]`));
    }
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

/** 푸터 버전 + 헤더 우측 계정/로그아웃. 재배포가 반영됐는지 화면으로 가린다. */
function wireAccountBar(apiBase: string, user: AuthUser): void {
  const verEl = document.getElementById("appVersion");
  if (verEl) verEl.textContent = APP_VERSION;

  const nameEl = document.getElementById("acctName");
  if (nameEl) nameEl.textContent = user.isMaster ? `${user.id} (마스터)` : user.id;

  const logoutBtn = document.getElementById("acctLogout");
  logoutBtn?.addEventListener("click", () => {
    void logout(apiBase).then(() => window.location.reload());
  });

  // 마스터만 조회 계정을 바꾼다. 일반 계정에는 이 셀렉트가 아예 안 보이고,
  // 보이더라도 서버가 무엇을 받든 자기 계정으로 되돌린다.
  const scopeSel = document.getElementById("acctScope") as HTMLSelectElement | null;
  if (!user.isMaster) {
    // 일반 계정으로 로그인하면 남아 있던 스코프를 반드시 지운다 —
    // 마스터로 쓰던 브라우저에서 그대로 이어지면 조회가 조용히 어긋난다.
    setViewScope(null);
    return;
  }
  if (!scopeSel) return;
  const saved = getViewScope();
  void listUsers(apiBase).then((users) => {
    scopeSel.textContent = "";
    for (const u of users) {
      const opt = document.createElement("option");
      opt.value = u.id;
      opt.textContent = u.id === user.id ? `${u.id} (내 것)` : u.id;
      scopeSel.append(opt);
    }
    // 새로고침을 건너온 선택을 복원한다. 없어졌거나 처음이면 **자기 것**이 기본이다.
    const initial = saved && users.some((u) => u.id === saved) ? saved : user.id;
    scopeSel.value = initial;
    setViewScope(initial);
  });
  scopeSel.addEventListener("change", () => {
    setViewScope(scopeSel.value || null);
    // 목록·상세가 이미 그려져 있어 부분 갱신은 곳곳을 건드려야 한다.
    // 계정 전환은 드문 동작이라 다시 그리는 쪽이 확실하고 싸다.
    window.location.reload();
  });
}

async function boot(): Promise<void> {
  const userSettings = loadUserSettings();
  const langParam = new URLSearchParams(window.location.search).get("lang");
  if (langParam === "en" || langParam === "ko") {
    userSettings.lang = langParam;
  }
  initI18n(userSettings.lang);
  wireWorkspaceVideoControls();

  const config = await fetchConfig();
  configureSync(config.sync);
  const apiBase = resolveApiBase();

  /**
   * ★ 로그인이 본체보다 앞이다.
   *
   * 서버 미들웨어가 이미 모든 API 를 막고 있어 화면만 띄워도 데이터는 안 샌다.
   * 그런데 로그인 전에 본체를 띄우면 **모든 패널이 401 을 받아 "데이터가 없다" 처럼
   * 보인다** — 사용자는 그걸 로그인 문제로 읽지 못한다. 그래서 여기서 붙잡는다.
   */
  const me = await fetchMe(apiBase);
  const { user: currentUser } = await requireLogin(apiBase, me);
  // 세션이 도중에 끊기면 같은 화면을 다시 띄운다.
  watchSessionExpiry(apiBase);
  // 마스터냐 아니냐로 메뉴가 갈린다. CSS 가 이 속성을 보고 촬영 메뉴를 감춘다.
  document.body.dataset.role = currentUser.isMaster ? "master" : "user";
  document.body.dataset.account = currentUser.id;

  /**
   * 이번 녹화의 첫 프레임(time=0)에 해당하는 서버 시각(ns).
   * 이 값이 있어야 CSV 를 영상 프레임과 짝지을 수 있다. 동기화 전이면 null.
   */
  let recordingStartServerNs: bigint | null = null;
  /** 녹화 시작 시각 — CSV·영상 파일명 도장(업로드 시각 아님). */
  let recordingStartedAt: Date | null = null;

  // 서버와 시계를 맞춘다 — 매트를 카메라와 같은 시간축에 올리는 유일한 방법이다.
  // 실패해도 앱은 계속 동작한다(그 세션의 CSV 만 영상과 매칭이 안 될 뿐).
  void clockSync
    .sync(apiBase)
    .then((r) => {
      const ms = (v: bigint): string => (Number(v) / 1e6).toFixed(2);
      if (!r.ok) {
        console.warn(
          `[clock] 네트워크 지연이 큽니다 (왕복 p50 ${ms(r.rttP50Ns)}ms). ` +
            "이 상태로 촬영하면 영상과의 정합이 어긋납니다.",
        );
      } else {
        console.info(`[clock] 동기화 완료 · 왕복 p50 ${ms(r.rttP50Ns)}ms`);
      }
      clockSync.startAutoResync({
        onDrift: (delta) =>
          console.warn(`[clock] offset 드리프트 ${(Number(delta) / 1e6).toFixed(2)}ms`),
        onError: (err) => console.warn("[clock] 재동기화 실패", err),
      });
    })
    .catch((err) => {
      console.warn(
        "[clock] 시계 동기화 실패 — 이 세션의 CSV 는 영상과 매칭되지 않습니다.",
        err,
      );
    });
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
  type SessionPhase = "idle" | "recording" | "saving" | "confirm";
  let sessionPhase: SessionPhase = "idle";
  let clinicSessionActive = false;
  let confirmBusy = false;
  /** 재촬영한 job 의 analyze_done 은 웹 리뷰 칸을 채우지 않는다. */
  let ignoreDoneJobId: string | null = null;
  /** 업로드보다 재촬영을 먼저 누른 경우, job 이 생기면 그때 AI 를 건너뛴다. */
  /**
   * 재촬영을 누른 세션.
   *
   * 예전엔 불리언 하나였다. 재촬영 뒤 다음 테이크를 찍었는데 이전 테이크의
   * `upload_started` 가 늦게 오면 플래그를 **새 테이크가 소비**해, 방금 찍은 것이
   * 취소되는 일이 생길 수 있었다(폰이 여러 대면 도착 순서가 뒤바뀐다).
   * 세션으로 들고 있으면 취소는 언제나 원래 그 테이크에만 걸린다.
   */
  let retakeSessionId: string | null = null;
  /** 직전 테이크의 세션 — `record_stop` 이 syncSessionId 를 비운 뒤에도 남아야 한다. */
  let lastTakeSessionId: string | null = null;

  const resultsPageEl = $opt("resultsPage");
  const resultsPage = resultsPageEl ? new ResultsPage(resultsPageEl) : null;
  resultsPage?.setApiBase(apiBase);
  const reportsPageEl = $opt("reportPage");
  const reportsPage = reportsPageEl ? new ReportsPage(reportsPageEl) : null;
  reportsPage?.setApiBase(apiBase);
  const filesPageEl = $opt("filesPage");
  const filesPage = filesPageEl ? new FilesPage(filesPageEl) : null;
  filesPage?.setApiBase(apiBase);
  const csvPageEl = $opt("csvPage");
  const csvPage = csvPageEl ? new CsvPage(csvPageEl) : null;
  csvPage?.setApiBase(apiBase);
  const verifyPageEl = $opt("verifyPage");
  const verifyPage = verifyPageEl ? new VerifyPage(verifyPageEl) : null;
  verifyPage?.setApiBase(apiBase);
  /**
   * 빠른 입력 — 등록해 둔 반려견을 눌러 아래 입력란을 채운다.
   * 채운 뒤 게이트를 다시 평가해야 시작 버튼이 그 자리에서 풀린다.
   */
  const dogPresets = new DogPresetsCard({
    onPick: (preset) => {
      const set = (id: string, value: string): void => {
        const el = $opt(id) as HTMLInputElement | null;
        if (el) el.value = value;
      };
      set("dogName", preset.name);
      set("dogWeightInfo", String(preset.weightKg));
      set("dogHeight", preset.heightCm == null ? "" : String(preset.heightCm));
      set("dogBreed", preset.breed ?? "");
      applyDogIdentityGate();
    },
  });
  dogPresets.setApiBase(apiBase);
  void dogPresets.refresh();
  onLangChange(() => dogPresets.renderLabels());

  const storagePageEl = $opt("storagePage");
  const storagePage = storagePageEl ? new StoragePage(storagePageEl) : null;
  storagePage?.setApiBase(apiBase);

  // 마스터 전용. 일반 계정에서는 메뉴가 없고, URL 을 알아도 서버가 403 을 준다.
  const accountsPageEl = $opt("accountsPage");
  const accountsPage = accountsPageEl ? new AccountsPage(accountsPageEl) : null;
  accountsPage?.setApiBase(apiBase);
  accountsPage?.hide();
  wireAccountBar(apiBase, currentUser);
  wireMyPage(apiBase, currentUser);
  clearReviewPanes();

  const sessionBtn = $("btnSession") as HTMLButtonElement;
  const sessionOverlay = $("sessionOverlay");
  const confirmModal = $("confirmAnalyzeModal");
  const confirmAnalyzeBtn = $("confirmAnalyzeBtn") as HTMLButtonElement;
  const confirmCancelBtn = $("confirmCancelBtn") as HTMLButtonElement;
  const confirmDiscardBtn = $("confirmDiscardBtn") as HTMLButtonElement;

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

  const hideConfirmModal = (): void => {
    confirmModal.classList.remove("open");
    document.body.classList.remove("modal-open");
  };

  const syncConfirmModal = (): void => {
    $("confirmAnalyzeTitle").textContent = t("confirm_analyze_title");
    confirmAnalyzeBtn.textContent = t("confirm_analyze_yes");
    confirmCancelBtn.textContent = t("confirm_analyze_no");
    confirmDiscardBtn.textContent = t("confirm_discard");
    const uploaded = Boolean(pendingAnalyzeJob);
    $("confirmAnalyzeHint").textContent = uploaded
      ? t("confirm_analyze_hint")
      : t("confirm_analyze_waiting_upload");
    confirmAnalyzeBtn.disabled = confirmBusy || !uploaded;
    confirmCancelBtn.disabled = confirmBusy;
    // 버리기는 업로드가 끝나기를 기다리지 않는다 — 도장에 표시해 두면 늦게 도착한
    // 파일도 같은 취급을 받는다. 기다리게 하는 순간 7번을 만든 이유가 사라진다.
    confirmDiscardBtn.disabled = confirmBusy;
  };

  const showConfirmModal = (): void => {
    syncConfirmModal();
    // 열리는 순간의 상태로 채운다. 이후 갱신은 cam_state 가 renderCamList 로 밀어 넣는다.
    renderCamList(gaitSync.peers);
    confirmModal.classList.add("open");
    document.body.classList.add("modal-open");
  };

  const setSessionPhase = (phase: SessionPhase, cause = "-"): void => {
    // ★ 페이즈 전환은 전부 서버에 남긴다.
    //
    //   "안 눌렀는데 종료됐다" 의 정체는 결국 누가 이 함수를 불렀느냐다. 부르는 곳이
    //   여러 곳(버튼 · record_stop 수신 · upload_started 수신 · 분석 확정)인데 화면만
    //   보면 구분이 안 된다. 호출자가 `cause` 를 대도록 해서 서버 로그에서 갈리게 한다.
    if (phase !== sessionPhase) {
      gaitSync.log("phase", { from: sessionPhase, to: phase, cause, session: syncSessionId, lastTake: lastTakeSessionId });
    }
    sessionPhase = phase;
    document.body.classList.toggle("session-recording", phase === "recording");
    document.body.classList.toggle("session-analyzing", phase === "saving" || phase === "confirm");
    const showOverlay = phase === "recording" || phase === "saving";
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
    } else {
      sessionBtn.textContent = t("btn_session_start");
      sessionBtn.classList.remove("is-stop");
      sessionBtn.classList.add("primary");
      sessionBtn.disabled = false;
    }
    // 마지막에 한 번 더: 대기 상태의 활성화는 신원 입력이 결정한다.
    applyDogIdentityGate();
  };


  /** 판정은 직접 분석과 공유한다 — 규칙이 갈라지지 않게. [core/dogIdentity.ts] */
  const dogIdentityGate = (): { ok: boolean; reason: string } => {
    const gate = checkDogIdentity(readSideDogInfo());
    return { ok: gate.ok, reason: gate.reasonKey ? t(gate.reasonKey) : "" };
  };

  const applyDogIdentityGate = (): void => {
    const gate = dogIdentityGate();
    // 촬영 중이거나 분석 중이면 그 상태의 버튼 규칙이 우선한다.
    const idle = sessionPhase === "idle";
    if (idle) {
      sessionBtn.disabled = !gate.ok;
    }
    // 상단 토스트는 띄우지 않는다 — 시작 버튼 비활성화로 충분하다.
    dismissTopToast("dog-identity");
  };

  /** 완료를 기다리는 분석 잡들 — WS `analyze_done` 을 놓쳤을 때의 백그라운드 폴링 폴백. */
  const watchedJobs = new Set<string>();

  type DoneBundle = { jobId: string | null; stem?: string | null };

  /**
   * 분석 완료 공통 처리 — 측정 화면은 결과를 띄우지 않는다.
   *
   * 측정은 시작/종료만 담당하므로 완료는 토스트로만 알리고, 누르면 "완료된 분석"
   * 화면으로 옮겨 그 세션을 연다. 촬영 중에 결과가 화면을 뺏는 일이 없어진다.
   */
  const handleAnalyzeDone = (done: DoneBundle): void => {
    if (done.jobId) watchedJobs.delete(done.jobId);
    showToast({
      kind: "ok",
      title: t("toast_done_title"),
      message: t("toast_done_view"),
      durationMs: 12000,
      onClick: () => {
        setModule("review");
        void completedPage.openStem(done.stem ?? null);
      },
    });
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
          handleAnalyzeDone({ jobId, stem: job.stem ?? null });
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
    retakeSessionId = null;
    syncConfirmModal();
    void confirmAnalyzeJob(apiBase, jobId)
      .then((resp) => {
        // 분석은 큐에서 돌아간다 — 웹은 기다리지 않고 곧장 다음 촬영을 받을 수 있다.
        hideConfirmModal();
        pendingAnalyzeJob = null;
        clinicSessionActive = false;
        setSessionPhase("idle", "분석확정");
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
        setSessionPhase("confirm", "분석확정 실패");
      })
      .finally(() => {
        confirmBusy = false;
        if (sessionPhase === "confirm") syncConfirmModal();
      });
  };

  const finishRetakeUi = (): void => {
    pendingAnalyzeJob = null;
    clinicSessionActive = false;
    retakeSessionId = null;
    cameraPlayer.setLoading(false);
    hideConfirmModal();
    clearReviewPanes();
    setSessionPhase("idle", "재촬영/취소 완료");
    setSyncStatus(t("confirm_analyze_cancelled"), "ok");
    updateSyncUi(gaitSync.peers, gaitSync.connected);
  };

  const skipAiForJob = (jobId: string): Promise<void> => {
    ignoreDoneJobId = jobId;
    return cancelAnalyzeJob(apiBase, jobId).then(() => undefined);
  };

  /**
   * "저장하기" — 파일은 남기고 AI 분석만 건너뛴다.
   *
   * ai-server 의 분석이 아직 못 미더워서, 현장에서는 결과를 보는 것보다 **로우데이터를
   * 모으는 것**이 목적이다. 분석으로 보내면 서버·큐에서 생길 수 있는 오류가 반복 시행을
   * 끊는다. 그래서 업로드는 끝까지 두고(폰에 `retake` 를 보내지 않는다) 잡만 취소한다.
   * 파일까지 버리는 것은 "버리기"(`onDiscardTake`)다.
   */
  const onCancelAnalyze = (): void => {
    if (confirmBusy) return;
    const jobId = pendingAnalyzeJob;
    confirmBusy = true;
    retakeSessionId = null;
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

  /**
   * 재촬영 클릭 — 카메라 상태에 따라 한 번 되묻는다.
   *
   * 재촬영 자체를 **막지는 않는다.** 이건 "이번 판을 버린다"는 탈출구라, 폰 하나가
   * 응답을 잃었을 때 잠가 버리면 분석하기(업로드 대기로 이미 잠김)와 함께 모달에
   * 갇힌다. 대신 지금 무슨 일이 벌어지는지 알리고 사용자가 정하게 한다.
   */
  const onRetakeClick = (): void => {
    if (confirmBusy) return;
    const peers = gaitSync.peers;

    // 아직 찍고 있는 폰 — 종료가 씹힌 경우다. 재촬영보다 종료 재전송이 먼저다.
    const recording = camsInState("recording", peers);
    if (recording > 0) {
      if (!window.confirm(t("retake_confirm_recording", { n: recording }))) return;
      if (gaitSync.connected) {
        gaitSync.log("stop_send", { sessionId: lastTakeSessionId, nullSession: lastTakeSessionId == null, from: "재촬영" });
        gaitSync.stopRecord(lastTakeSessionId);
      }
      setSyncStatus(t("retake_stop_sent"), "wait");
      // 모달은 그대로 둔다 — 상태 줄이 대기/업로드로 바뀌는 것을 보고 다시 누르면 된다.
      return;
    }

    // 업로드 중이어도 되묻지 않는다 — "저장하기" 는 업로드를 끊지 않고 끝까지 둔다.
    onCancelAnalyze();
  };

  /**
   * "버리기" — 이번 촬영을 통째로 버린다(소프트 삭제).
   *
   * 개가 안 뛰거나 딴 데로 새면 그 회차는 쓸모가 없다. 나중에 파일 목록에서 찾아
   * 지우려면 반복 시행이 끊기므로 그 자리에서 버린다. 파일은 지우지 않고 도장에
   * 표시만 하며, 되살리기·영구 삭제는 데이터 검증 화면에서 한다.
   *
   * ★ 업로드가 진행 중이어도 막지 않는다. 폰에는 `retake` 로 업로드를 끊으라고 알리고,
   *   그래도 늦게 도착하는 파일은 서버가 도장을 보고 같은 취급을 한다.
   */
  const onDiscardTake = (): void => {
    if (confirmBusy) return;
    const sessionId = lastTakeSessionId;
    if (!window.confirm(t("confirm_discard_ask"))) return;
    const jobId = pendingAnalyzeJob;
    confirmBusy = true;
    retakeSessionId = lastTakeSessionId;
    if (gaitSync.connected) {
      // 종료가 씹혀 아직 찍고 있는 폰이 있으면 먼저 멈춘다. 버릴 회차를 계속 찍고 있으면
      // 그 시간이 그대로 다음 촬영의 지연이 된다.
      if (camsInState("recording", gaitSync.peers) > 0) {
        gaitSync.log("stop_send", { sessionId: lastTakeSessionId, nullSession: lastTakeSessionId == null, from: "버리기" });
        gaitSync.stopRecord(lastTakeSessionId);
      }
      gaitSync.requestRetake(lastTakeSessionId);
    }
    syncConfirmModal();
    void (async () => {
      try {
        if (jobId) await skipAiForJob(jobId);
      } catch {
        /* 잡 취소 실패는 버리기를 막지 않는다 — 도장 표시가 본체다 */
      }
      try {
        if (sessionId) await discardSession(apiBase, sessionId);
        setSyncStatus(t("confirm_discard_done"), "ok");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showToast({ kind: "bad", title: t("confirm_discard"), message: t("confirm_discard_failed", { msg }) });
      } finally {
        finishRetakeUi();
        confirmBusy = false;
      }
    })();
  };

  confirmAnalyzeBtn.addEventListener("click", () => onConfirmAnalyze());
  confirmCancelBtn.addEventListener("click", () => onRetakeClick());
  confirmDiscardBtn.addEventListener("click", () => onDiscardTake());


  /**
   * 5패널에 결과를 싣는다 — 촬영 흐름이 아니라 **프로모 시연 경로 전용**이다.
   * 촬영 결과 열람은 "완료된 분석"(completedPage.onPick)이 같은 패널을 직접 채운다.
   */
  const showPromoResult = (opts: {
    analysisUrl: string;
    originalUrl?: string | null;
    /** Pane 1 override (promo pressboard mp4 / gif). */
    pressureUrl?: string | null;
    artifacts?: SessionArtifacts | null;
  }): void => {
    const { analysisUrl, originalUrl, artifacts } = opts;
    lastAiVideoUrl = analysisUrl;
    clinicSessionActive = false;
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

    // 1번 압력: result_pressure → explicit pressureUrl → placeholder
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
    } else if (isSimulateAi()) {
      setPressureGif(placeholderUrl("foot.gif"));
    }

    // Sources are assigned; pick the master and drive all panes as one.
    reviewSync?.refresh();
    setSyncStatus(t("sync_analyze_done"), "ok");
  };

  /**
   * 직접 분석 — 업로드가 접수되면 측정 화면으로 옮기고 **큐 토스트로** 진행을 알린다.
   * 화면을 막지 않으므로 분석이 도는 동안에도 촬영 세션을 시작할 수 있다.
   * 이 잡은 WS 방에 속하지 않으므로(촬영 세션이 아니다) 완료는 백그라운드 잡 폴링으로 받는다.
   */
  const startManualAnalysis = (job: ManualAnalyzeJob): void => {
    clinicSessionActive = false;
    syncSessionId = null;
    syncRecordPending = false;
    syncPlaybackActive = false;
    syncDock.stop();
    syncDock.hide();
    clearReviewPanes();
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
        onSubmitted: (job) => startManualAnalysis(job),
      })
    : null;


  // --- 완료된 분석 (열람 전용 노트북) -------------------------------------
  //
  // 측정용 소켓과 뷰어용 소켓을 하나만 살려 둔다. 이 화면에 들어오면 제어용
  // 연결을 끊고 뷰어로 갈아탄다 — 허브가 뷰어의 제어 메시지를 거부하므로,
  // 설명하는 사람이 옆 노트북의 촬영을 건드릴 수 없다.
  let viewerSync: GaitSyncSocket | null = null;

  const completedPage = new CompletedPage({
    onPick: async (ref) => {
      const detail = await getResultDetail(apiBase, ref.date, ref.session.stem);
      clearReviewPanes();
      if (detail.original?.url || detail.backOriginal?.url) {
        setOriginVideo(detail.original?.url || detail.backOriginal?.url || null);
      }
      setAnalysisVideo(detail.video?.url ?? null);
      setMaxMinVideo(detail.report?.angle_pawy?.url ?? null);
      setPressureMedia(detail.report?.pressure?.url ?? null);
      await loadAngleDiffPane(detail.report?.angle_diff?.url ?? null).catch(() => undefined);
      reviewSync?.refresh();
    },
    loadHistory: (ref) => getSessionNotes(apiBase, ref.date, ref.session.stem),
    saveHistory: (ref, text) => saveSessionNotes(apiBase, ref.date, ref.session.stem, text),
  });
  completedPage.setApiBase(apiBase);
  onLangChange(() => completedPage.renderLabels());

  /** 분석 완료 알림 — 관객이 있는 화면이라 위에서 크게 내려오게 띄운다. */
  const announceAnalysisDone = (dogName: string | null | undefined): void => {
    showTopToast({
      message: dogName
        ? t("cp_analysis_done", { name: dogName })
        : t("cp_analysis_done_plain"),
    });
    completedPage.onAnalysisDone();
  };

  /**
   * 완료 알림에 실을 이름 찾기.
   *
   * `analyze_done` 은 stem 만 준다. 서버 목록을 다시 읽어 그 stem 의 강아지 이름을
   * 찾고, 못 찾으면 이름 없이 알린다 — 알림 자체를 삼키지는 않는다.
   */
  const announceFromLatest = async (stem: string | null): Promise<void> => {
    let name: string | null = null;
    try {
      const dates = await listResultDates(apiBase);
      for (const d of dates.slice(0, 2)) {
        const page = await listResultSessions(apiBase, d.date);
        const hit = stem
          ? page.sessions.find((x) => x.stem === stem)
          : page.sessions[0];
        if (hit) {
          name = hit.dog?.name?.trim() || null;
          break;
        }
      }
    } catch {
      /* 이름을 못 찾아도 완료 사실은 알린다 */
    }
    announceAnalysisDone(name);
  };

  const enterViewerMode = (): void => {
    gaitSync.disconnect();
    if (!viewerSync) {
      viewerSync = new GaitSyncSocket({
        wsUrl: resolveWsUrl(),
        role: "viewer",
      });
      viewerSync.onMessage((msg) => {
        if (msg.type === "analyze_done") {
          // 뷰어에는 잡 장부가 없다. 이름은 방금 끝난 세션에서 읽는 게 정확하므로
          // 목록을 새로 받은 뒤 그 첫 항목의 강아지 이름으로 알린다.
          void announceFromLatest(msg.stem ?? null);
        } else if (msg.type === "analysis_queue") {
          updateQueueToast(msg);
        }
      });
    }
    viewerSync.connect();
    void completedPage.refresh();
  };

  const leaveViewerMode = (): void => {
    viewerSync?.disconnect();
    if (isSyncEnabled()) gaitSync.connect();
  };

  const setModule = wireAppHeader({
    onModuleChange: (mod) => {
      if (mod === "results") resultsPage?.show();
      else resultsPage?.hide();
      if (mod === "report") reportsPage?.show();
      else reportsPage?.hide();
      if (mod === "upload") uploadPage?.show();
      else uploadPage?.hide();
      if (mod === "files") filesPage?.show();
      else filesPage?.hide();
      if (mod === "csv") csvPage?.show();
      else csvPage?.hide();
      if (mod === "verify") verifyPage?.show();
      else verifyPage?.hide();
      if (mod === "storage") storagePage?.show();
      else storagePage?.hide();
      if (mod === "accounts") accountsPage?.show();
      else accountsPage?.hide();
      if (mod === "review") enterViewerMode();
      else leaveViewerMode();
      // 측정 화면의 1·압력패드는 라이브 히트맵이다 — 열람이 덮어 둔 결과 미디어를 걷어낸다.
      if (mod === "measure") clearReviewPanes();
      // 탭을 옮기면 안내 토스트를 다시 평가한다. 측정으로 돌아왔을 때 시작 버튼만
      // 잠겨 있고 이유가 없으면 사용자는 무엇을 고쳐야 할지 알 수 없다.
      applyDogIdentityGate();
    },
  });


  const updateSyncUi = (peers?: SyncPeers, hubConnected?: boolean): void => {
    if (hubConnected === false) {
      // 허브가 끊긴 것은 문제다 — 이때는 반드시 보여야 한다.
      setSyncStatus(t("sync_hub_disconnected"), "bad");
      if (!syncPlaybackActive) cameraPlayer.clearPreview();
      return;
    }
    const mobile = peers?.mobile ?? false;
    const camCount = peers?.mobileCount ?? (mobile ? 1 : 0);
    const hasMain = peers?.main;
    // 자리 번호를 안 고른 Sub 카메라 수. 그대로 찍으면 파일명이 도착 순서로 매겨져
    // 현장에서 맞춰 둔 자리와 어긋난다 — 촬영 버튼을 누르기 전에 알려야 한다.
    const unnumbered =
      peers?.subIndexes === undefined ? 0 : (peers.subCount ?? 0) - peers.subIndexes.length;
    if (!mobile) {
      setSyncStatus(t("sync_mobile_waiting"), "wait");
    } else if (hasMain === false) {
      // 카메라는 있으나 Main 없음 → 분석 대상 없음 경고.
      setSyncStatus(t("sync_no_main", { n: camCount }), "wait");
    } else if (unnumbered > 0) {
      setSyncStatus(t("sync_sub_unnumbered", { n: camCount, u: unnumbered }), "wait");
    } else {
      // 정상 — 카메라 카드가 이미 몇 대인지 보여준다. 문구는 숨는다.
      setSyncStatus(camCount > 1 ? t("sync_mobile_connected_n", { n: camCount }) : t("sync_mobile_connected"), "ok");
    }
    if (mobile && !syncPlaybackActive && cameraPlayer.getMode() === "idle") {
      cameraPlayer.showIdle(t("camera_preview_receiving"));
    }
    if (!mobile && !syncPlaybackActive) cameraPlayer.clearPreview();
    renderCamList(peers);
  };

  /**
   * 자리별 카메라 상태 — 폰이 `cam_state` 로 알려 온 것을 그대로 담는다.
   *
   * 키는 **자리**다. 목록의 줄도 자리로 그리므로(`renderCamList`) 여기서 deviceId 를
   * 쓰면 조회가 영원히 빗나간다 — 실제로 "촬영 중" 이 안 뜨던 원인이 이거였다.
   * 비우지 않는다: 폰이 전이마다 다시 알려주므로 스스로 맞춰진다.
   */
  const camStates = new Map<string, CamState>();

  /**
   * 자리별 **실제** 촬영 시작 시각 — `record_started` 가 도착한 순간의 `performance.now()`.
   *
   * `cam_state:'recording'` 은 폰의 화면 단계가 바뀔 때 나가므로 녹화 API 가 뜨기 **전**에
   * 온다. 경과시간의 기준으로 쓰면 실제보다 길게 나온다. 그래서 시작 사실은 폰이 녹화를
   * 올린 뒤에 보내는 `record_started` 만 믿는다.
   *
   * 서버의 `serverNow` 로 시계를 맞추지 않는다 — 소켓 지연은 수십 ms 인데 여기서 보려는
   * 것은 폰 사이의 초 단위 편차라 보정이 값을 바꾸지 못한다. 필요해지면 `serverNow` 가
   * 이미 페이로드에 있으므로 그때 갈아탄다.
   */
  const camRecStartedAt = new Map<string, number>();

  /** 자리 한 칸을 가리키는 키. 목록의 줄과 같은 규칙이어야 한다. */

  const fmtElapsed = (ms: number): string => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  /**
   * 경과시간 갱신 틱 — **폰마다 하나씩 두지 않는다.**
   *
   * 폰이 몇 대든 틱은 초당 2회로 고정이고, 시작 시점이 제각각인 것은 줄마다 기준 시각이
   * 다를 뿐 틱과 무관하다. 찍는 폰이 없으면 아예 돌지 않는다.
   */
  let camTickTimer: ReturnType<typeof setInterval> | null = null;
  const syncCamTick = (): void => {
    const needed = camRecStartedAt.size > 0;
    if (needed && camTickTimer == null) {
      camTickTimer = setInterval(() => renderCamList(gaitSync.peers), 500);
    } else if (!needed && camTickTimer != null) {
      clearInterval(camTickTimer);
      camTickTimer = null;
    }
  };

  /**
   * 연결된 카메라 목록을 그린다.
   *
   * 서버가 주는 것은 **개수와 번호 집합**뿐이라(`peersOf`) 기기를 낱개로 식별할 수 없다.
   * 그래서 자리 기준으로 줄을 세운다 — Main 1줄 + 번호를 가진 Sub + 번호 미지정 Sub 묶음.
   * 자리 번호가 곧 현장의 카메라 위치라 사람이 찾아가기에는 이게 더 낫다.
   */
  const renderCamList = (peers?: SyncPeers): void => {
    const listEl = $opt("camList") as HTMLUListElement | null;
    if (!listEl) return;
    listEl.innerHTML = "";

    const hasMain = peers?.main ?? false;
    const subIndexes = peers?.subIndexes ?? [];
    const unnumbered = Math.max(0, (peers?.subCount ?? 0) - subIndexes.length);

    const row = (slot: string, key: string | null, warn?: string): void => {
      const li = document.createElement("li");
      const state: CamState = (key != null && camStates.get(key)) || "idle";
      const startedAt = key != null ? camRecStartedAt.get(key) : undefined;
      const mod = warn ? "is-warn" : state === "recording" ? "is-recording" : state === "uploading" ? "is-uploading" : "is-idle";
      li.className = `cam-row ${mod}`;
      const slotEl = document.createElement("span");
      slotEl.className = "cam-slot";
      slotEl.textContent = slot;
      const stateEl = document.createElement("span");
      stateEl.className = "cam-state";
      // 경과시간은 `record_started` 를 받은 줄에만 붙는다. 아직 못 받았으면 초 없이
      // "촬영 중" 만 — 신호를 놓쳤을 때 대기로 잘못 보이는 것보다 낫다.
      const base = t(state === "recording" ? "cam_recording" : state === "uploading" ? "cam_uploading" : "cam_idle");
      stateEl.textContent =
        warn ?? (startedAt != null ? `${base} ${fmtElapsed(performance.now() - startedAt)}` : base);
      li.append(slotEl, stateEl);
      listEl.appendChild(li);
    };

    if (hasMain) row("MAIN", "main");
    for (const n of subIndexes) row(`SUB${n}`, `sub${n}`);
    // 방을 떠난 폰의 타이머는 줄이 사라져도 계속 돈다 — 여기서 같이 걷는다.
    const live = new Set<string>([...(hasMain ? ["main"] : []), ...subIndexes.map((n) => `sub${n}`)]);
    for (const key of camRecStartedAt.keys()) if (!live.has(key)) camRecStartedAt.delete(key);
    syncCamTick();
    // 번호 미지정 폰은 촬영을 하지 않는다(앱이 막는다) — 경고로 표시한다.
    for (let i = 0; i < unnumbered; i += 1) row("SUB ?", null, t("cam_no_slot"));

    if (!listEl.children.length) {
      const li = document.createElement("li");
      li.className = "cam-empty";
      li.textContent = t("cams_empty");
      listEl.appendChild(li);
    }

    // 확인 모달에도 같은 줄을 띄운다. 모달 딤 뒤의 사이드바는 읽히지 않는데,
    // 재촬영을 누를지 판단하려면 바로 이 상태가 필요하다. 두 번 그리지 않고 복제한다.
    const modalListEl = $opt("confirmCamList");
    if (modalListEl) {
      modalListEl.replaceChildren(...[...listEl.children].map((node) => node.cloneNode(true)));
    }
  };

  const camsInState = (state: CamState, peers?: SyncPeers): number =>
    countCamsInState(camStates, peers, state);

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

  /**
   * 좌측 시각화를 실시간 보기로 되돌린다.
   *
   * 종료를 눌렀는데 매트 녹화가 (여러 이유로) 시작되지 않았던 회차에서는
   * `stopLocalRecording` 이 안 불려 `displayMode` 가 "recording" 에 갇히고, 그러면
   * peakHold 가 계속 쌓여 화면이 영영 초기화되지 않았다. 종료 경로는 녹화 여부와
   * 무관하게 반드시 여기를 지난다.
   */
  const resetLiveView = (): void => {
    displayMode = "live";
    peakHold = null;
    holdToken++;
    latestOverlay = null;
    liveTracker.reset();
    clearOverlay();
  };

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
  let selectedCapturePreset: CapturePreset = presetById(userSettings.capturePresetId);

  const capturePresetSelect = $opt("capturePreset") as HTMLSelectElement | null;
  let syncCapturePresetToPhones: () => void = () => {};
  const wireCapturePresetSelect = (): void => {
    if (!capturePresetSelect) return;
    capturePresetSelect.innerHTML = "";
    for (const preset of CAPTURE_PRESETS) {
      const opt = document.createElement("option");
      opt.value = preset.id;
      opt.textContent = preset.label;
      capturePresetSelect.appendChild(opt);
    }
    capturePresetSelect.value = selectedCapturePreset.id;
    capturePresetSelect.onchange = () => {
      selectedCapturePreset = presetById(capturePresetSelect.value);
      persistSettings();
      syncCapturePresetToPhones();
    };
  };
  wireCapturePresetSelect();

  /**
   * 최대 촬영시간 — 폰이 종료 신호를 못 받았을 때 스스로 멈추는 상한이다.
   * 실제 값은 서버가 다시 clamp 해서 `sync_start` 로 폰에 내려보낸다.
   */
  let maxRecordSec = clampRecordSec(userSettings.maxRecordSec);
  const maxRecordSelect = $opt("maxRecordSec") as HTMLSelectElement | null;
  const wireMaxRecordSelect = (): void => {
    if (!maxRecordSelect) return;
    maxRecordSelect.innerHTML = "";
    for (let sec = MIN_RECORD_SEC; sec <= MAX_RECORD_SEC; sec += RECORD_SEC_STEP) {
      const opt = document.createElement("option");
      opt.value = String(sec);
      opt.textContent = t("capture_max_duration_unit", { n: sec });
      maxRecordSelect.appendChild(opt);
    }
    maxRecordSelect.value = String(maxRecordSec);
    maxRecordSelect.onchange = () => {
      maxRecordSec = clampRecordSec(maxRecordSelect.value);
      maxRecordSelect.value = String(maxRecordSec);
      persistSettings();
    };
  };
  wireMaxRecordSelect();
  onLangChange(wireMaxRecordSelect);

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
    capturePresetId: selectedCapturePreset.id,
    maxRecordSec,
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
    // 동기 촬영 세션과 같은 sessionId 로 묶어 back 이 영상+CSV 를 한 세션으로 연결하게 한다.
    sessionId: () => syncSessionId,
    startedAt: () => recordingStartedAt,
    // CSV 첫 행(time=0)의 절대 시각 — 영상 프레임과 매칭하는 기준점.
    startAtServerNs: () => recordingStartServerNs,
    clockOffsetNs: () => clockSync.offset,
    clockRttP50Ns: () => clockSync.result?.rttP50Ns ?? null,
  });

  /** 매트 녹화의 하드 상한 타이머. 폰의 자체 상한과 같은 값을 쓴다. */
  let matCapTimer: number | null = null;
  /** 서버가 확정해 `sync_start` 로 내려준 상한. 없으면 화면에서 고른 값. */
  let syncMaxRecordMs: number | null = null;
  const activeMaxRecordMs = (): number => syncMaxRecordMs ?? maxRecordSec * 1000;

  const startLocalRecording = (wallAnchorMs?: number): void => {
    syncDock.stop();
    syncDock.hide();
    syncPlaybackActive = false;
    /**
     * ★ 녹화 시작점(performance.now 축).
     *
     * 예전에는 `performance.now() + (wallAnchorMs - Date.now())` 로 서버가 준
     * recordAt 을 **로컬 벽시계**로 환산했다. 이 PC 의 벽시계가 서버와 얼마나
     * 어긋나 있는지는 아무도 모르고, 세션 중 NTP 보정이 들어오면 그 자리에서 점프한다.
     * 그래서 압력 샘플이 영상 프레임과 짝지어지지 않았다.
     *
     * 이제는 클럭 오프셋(= /api/time/sync 로 실측한 값)으로 환산한다.
     * 동기화 전이면 예전 방식으로 물러서되, 그 사실을 기록해 둔다 —
     * 그 세션의 CSV 는 영상과 매칭할 수 없기 때문이다.
     */
    let t0: number;
    if (wallAnchorMs == null) {
      t0 = performance.now();
    } else if (clockSync.synced) {
      // recordAt 은 서버 벽시계 ms → 서버 ns → 기기(performance.now) ns → ms
      const deviceNs = clockSync.toDeviceNs(BigInt(Math.round(wallAnchorMs)) * 1_000_000n);
      t0 = Number(deviceNs) / 1e6;
    } else {
      t0 = performance.now() + (wallAnchorMs - Date.now());
      console.warn(
        "[clock] 시계 동기화 전이라 벽시계로 녹화 시작점을 잡았습니다 — " +
          "이 세션의 CSV 는 영상과 정확히 매칭되지 않습니다.",
      );
    }

    // CSV 업로드에 실을 절대 시각. 첫 프레임(time=0)에 해당하는 t_server_ns.
    recordingStartServerNs = clockSync.perfMsToServerNs(t0);
    recordingStartedAt = new Date();
    recorder.start(t0);
    // ★ 매트에도 폰과 같은 상한을 건다. 안 걸면 종료가 씹혔을 때 폰만 멈추고 매트는
    //   계속 쌓여, 영상보다 훨씬 긴 CSV 가 남는다.
    if (matCapTimer != null) window.clearTimeout(matCapTimer);
    matCapTimer = window.setTimeout(() => {
      matCapTimer = null;
      if (recorder.isRecording) {
        gaitSync.log("mat_cap_reached", { capMs: activeMaxRecordMs(), session: syncSessionId });
        stopLocalRecording();
      }
    }, activeMaxRecordMs());
    setExportsEnabled(false);
    cachedTrack = null;
    displayMode = "recording";
    peakHold = null;
    holdToken++;
    updateRecordingStatus();
    persistSettings();
  };

  const stopLocalRecording = (): void => {
    if (matCapTimer != null) {
      window.clearTimeout(matCapTimer);
      matCapTimer = null;
    }
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

  const gaitSync = new GaitSyncSocket({ wsUrl: resolveWsUrl() });
  syncCapturePresetToPhones = (): void => {
    if (!isSyncEnabled() || !gaitSync.connected || gaitSync.isViewer) return;
    gaitSync.sendCaptureSettings(captureSettingsPayload(selectedCapturePreset));
  };
  gaitSync.onConnectionChange((connected) => {
    updateSyncUi(gaitSync.peers, connected);
    if (connected) syncCapturePresetToPhones();
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
    if (msg.type === "cam_state") {
      // 폰이 말하는 상태를 그대로 쓴다 — 사건을 모아 추측하지 않는다.
      const key = camKey(msg.captureRole, msg.subIndex);
      if (camStates.get(key) !== msg.state) gaitSync.log("cam_state", { cam: key, state: msg.state });
      camStates.set(key, msg.state);
      // 촬영에서 벗어나면 경과시간도 같이 끝난다. `record_stopped` 를 못 받아도
      // 업로드/대기 전이는 반드시 오므로 타이머가 남지 않는다.
      if (msg.state !== "recording") camRecStartedAt.delete(key);
      syncCamTick();
      renderCamList(gaitSync.peers);
    }
    if (msg.type === "record_started") {
      // "찍고 있다" 의 근거는 이 신호다 — 폰이 녹화를 올린 뒤에 보낸다.
      const key = camKey(msg.captureRole, msg.subIndex);
      camStates.set(key, "recording");
      if (!camRecStartedAt.has(key)) camRecStartedAt.set(key, performance.now());
      syncCamTick();
      renderCamList(gaitSync.peers);
    }
    if (msg.type === "record_stopped") {
      camRecStartedAt.delete(camKey(msg.captureRole, msg.subIndex));
      syncCamTick();
      renderCamList(gaitSync.peers);
    }
    if (msg.type === "sync_start") {
      gaitSync.log("rx_sync_start", { sessionId: msg.sessionId, recordAt: msg.recordAt, maxDurationMs: msg.maxDurationMs ?? null });
      syncRecordPending = false;
      syncSessionId = msg.sessionId;
      lastTakeSessionId = msg.sessionId;
      syncDock.hide();
      syncPlaybackActive = false;
      clearReviewPanes();
      setSessionPhase("recording", "sync_start 수신");
      setSyncStatus(t("sync_pending"));
      // ★ 걸어 둔 회차가 아직 유효할 때만 시작한다. 대기 중에 종료가 지나갔는데도
      //   그대로 시작하면 그 녹화는 아무도 멈추지 않는다 — CSV 가 안 올라가고(4번)
      //   좌측 시각화도 "recording" 에 갇힌다(5번).
      syncMaxRecordMs = msg.maxDurationMs && msg.maxDurationMs > 0 ? msg.maxDurationMs : null;
      const armedSession = msg.sessionId;
      void waitUntilRecordAt(msg.recordAt).then(() => {
        if (syncSessionId !== armedSession) return;
        if (!recorder.isRecording) startLocalRecording(msg.recordAt);
      });
    }
    if (msg.type === "record_stop") {
      // 다른 제어판이 눌렀거나 지난 회차의 재전송일 수 있다. 회차 일치 여부를 남긴다.
      gaitSync.log("rx_record_stop", {
        sessionId: msg.sessionId,
        current: syncSessionId,
        mine: msg.sessionId != null && msg.sessionId === syncSessionId,
        retry: Boolean(msg.retry),
        phase: sessionPhase,
      });
      syncRecordPending = false;
      if (recorder.isRecording) stopLocalRecording();
      else resetLiveView();
      lastTakeSessionId = msg.sessionId ?? syncSessionId ?? lastTakeSessionId;
      syncSessionId = null;
      if (clinicSessionActive || sessionPhase === "recording") {
        setSessionPhase("confirm", "record_stop 수신");
        setSyncStatus(t("confirm_analyze_waiting_upload"), "wait");
      }
    }
    if (msg.type === "upload_started") {
      // ★ 지금 찍고 있는 회차가 아닌데 이걸로 세션이 끝나면, 그게 바로 "안 눌렀는데 종료"다.
      //   판단은 아직 바꾸지 않는다(수정은 별건) — 일어나는지부터 기록으로 확인한다.
      if (sessionPhase === "recording" && msg.sessionId && msg.sessionId !== syncSessionId) {
        gaitSync.log("upload_started_stale", { got: msg.sessionId, current: syncSessionId, jobId: msg.jobId });
      }
      gaitSync.log("rx_upload_started", { jobId: msg.jobId, sessionId: msg.sessionId, phase: sessionPhase });
      pendingAnalyzeJob = msg.jobId;
      cameraPlayer.setLoading(false);
      // 취소는 **재촬영을 누른 그 테이크**에만 건다. 세션이 다르면 새로 찍은 것이다.
      if (retakeSessionId && (!msg.sessionId || msg.sessionId === retakeSessionId)) {
        retakeSessionId = null;
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
      setSessionPhase("confirm", "upload_started 수신");
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
      handleAnalyzeDone({ jobId: msg.jobId ?? null, stem: msg.stem ?? null });
    }
    if (msg.type === "analyze_failed") {
      if (msg.jobId) watchedJobs.delete(msg.jobId);
      cameraPlayer.setLoading(false);
      showToast({ kind: "bad", title: t("toast_failed_title"), message: msg.error });
      setSyncStatus(`${t("sync_analyze_failed")}: ${msg.error}`, "bad");
      // 진행 중인 촬영/확인 UI(촬영·확인 페이즈)는 유지한다 — 이전 잡의 실패가 다음 촬영을 끊지 않는다.
      if (msg.jobId && msg.jobId === pendingAnalyzeJob) pendingAnalyzeJob = null;
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

  // 새로고침해도 보던 탭에 머문다. 노트북을 역할별로 고정해 쓰기 때문에, 열람용
  // 화면이 매번 측정 화면으로 돌아가면 그때마다 측정 제어가 다시 붙는다.
  //
  // gaitSync 가 만들어진 뒤에 불러야 한다 — 뷰어 전환이 이 소켓을 끊고 갈아타므로,
  // 선언 전에 부르면 TDZ 에 걸려 부팅이 통째로 멈춘다.
  setModule(loadActiveModule() ?? "measure");
  syncDock.setOnBack(() => {
    syncPlaybackActive = false;
    syncDock.stop();
    displayMode = "live";
    peakHold = null;
    clearOverlay();
    if (gaitSync.peers.mobile) cameraPlayer.showIdle(t("camera_preview_receiving"));
  });
  setSessionPhase("idle");

  const startClinicSession = (): void => {
    if (sessionPhase === "recording" || sessionPhase === "saving" || sessionPhase === "confirm") {
      return;
    }
    // Simulate mode: web-only Start/Stop to verify review panes without app/AI.
    if (isSimulateAi()) {
      clinicSessionActive = true;
      clearReviewPanes();
      syncRecordPending = false;
      setSyncStatus(t("sim_recording"), "wait");
      setSessionPhase("recording", "시작버튼(시뮬)");
      if (gaitSync.connected && gaitSync.peers.mobile) {
        syncRecordPending = true;
        gaitSync.requestRecord(readSideDogInfo(), captureSettingsPayload(selectedCapturePreset), maxRecordSec * 1000);
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
    retakeSessionId = null;
    ignoreDoneJobId = null;
    pendingAnalyzeJob = null;
    clearReviewPanes();
    syncRecordPending = true;
    setSyncStatus(t("sync_pending"), "wait");
    setSessionPhase("recording", "시작버튼");
    gaitSync.log("record_request", { maxRecordSec, preset: selectedCapturePreset?.id ?? null });
    gaitSync.requestRecord(readSideDogInfo(), captureSettingsPayload(selectedCapturePreset), maxRecordSec * 1000);
  };

  const stopClinicSession = (): void => {
    if (sessionPhase !== "recording" && !recorder.isRecording) {
      gaitSync.log("stop_ignored", { phase: sessionPhase, matRecording: recorder.isRecording });
      return;
    }
    if (recorder.isRecording) stopLocalRecording();
    if (gaitSync.connected && gaitSync.peers.mobile) {
      // ★ sessionId 가 null 이면 서버가 회차 없는 종료를 뿌리고, 폰의 stale 검사가
      //   통째로 무력화된다. 그 자체가 사고 신호이므로 반드시 남긴다.
      gaitSync.log("stop_send", { sessionId: syncSessionId, nullSession: syncSessionId == null });
      gaitSync.stopRecord(syncSessionId);
    } else {
      gaitSync.log("stop_not_sent", { connected: gaitSync.connected, mobile: gaitSync.peers.mobile });
    }
    lastTakeSessionId = syncSessionId ?? lastTakeSessionId;
    syncSessionId = null;
    syncRecordPending = false;
    pendingAnalyzeJob = null;
    retakeSessionId = null;
    setSessionPhase("confirm", "종료버튼");
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
    // 사용자가 "시작"을 눌렀는지 "종료"를 눌렀는지는 이 순간의 페이즈가 결정한다.
    // 현장 증언("시작을 눌렀는데 종료됐다")과 대조할 수 있어야 한다.
    gaitSync.log("btn_session", {
      phase: sessionPhase,
      label: sessionPhase === "recording" ? "종료" : "시작",
      cams: gaitSync.peers.mobileCount ?? null,
      camStates: [...camStates.entries()].map(([k, v]) => `${k}:${v}`),
      connected: gaitSync.connected,
    });
    if (sessionPhase === "recording") {
      stopClinicSession();
      return;
    }
    if (sessionPhase === "saving" || sessionPhase === "confirm") {
      return;
    }
    const gate = dogIdentityGate();
    if (!gate.ok) {
      applyDogIdentityGate();
      setSyncStatus(gate.reason, "bad");
      return;
    }
    // 시작 → 1초 영점 보정 후 기존 세션 시작 흐름 진행.
    sessionBtn.disabled = true;
    void runZeroCalibration().finally(() => {
      sessionBtn.disabled = false;
      startClinicSession();
    });
  };
  for (const id of ["dogName", "dogWeightInfo"]) {
    $opt(id)?.addEventListener("input", () => applyDogIdentityGate());
  }
  applyDogIdentityGate();
  sessionBtn.addEventListener("click", onSessionButtonClick);

  onClick("btnRecord", () => {
    /* Pad-only / legacy control — clinic flow prefers #btnSession (Start/Stop). */
    if (recorder.isRecording) {
      stopLocalRecording();
      if (gaitSync.connected && gaitSync.peers.mobile) {
        gaitSync.stopRecord(syncSessionId);
        setSyncStatus(t("session_saving_sub"), "wait");
        setSessionPhase("saving", "btnRecord(구)");
      }
      syncSessionId = null;
      syncRecordPending = false;
      updateSyncUi(gaitSync.peers, gaitSync.connected);
      return;
    }

    if (gaitSync.connected && gaitSync.peers.mobile) {
      clinicSessionActive = true;
      clearReviewPanes();
      syncRecordPending = true;
      setSyncStatus(t("sync_pending"));
      setSessionPhase("recording", "btnRecord(구)");
      gaitSync.requestRecord(readSideDogInfo(), captureSettingsPayload(selectedCapturePreset), maxRecordSec * 1000);
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
    const dog = readSideDogInfo();
    downloadText(pressureCsvName({ dog: { name: dog.name, weightKg: dog.weightKg } }), csv);
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
      const dog = readSideDogInfo();
      const prefix = dogPrefix({ name: dog.name, weightKg: dog.weightKg });
      downloadText(
        `${prefix ? `${prefix}-` : ""}pawtrack-${stampFrom()}.csv`,
        csv,
      );
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

        showPromoResult({
          analysisUrl,
          originalUrl: promoAssetUrl(promoCase.originUpload),
          // Pane 1: artifacts.pressure → ai-server result_pressure; else optional promo override / GIF.
          pressureUrl: promoCase.pressureUrl
            ? promoAssetUrl(promoCase.pressureUrl)
            : undefined,
          artifacts,
        });
        if (!$opt("wsBody1")?.classList.contains("has-media")) {
          setPressureGif(promoAssetUrl(PROMO_PRESSURE_GIF));
        }

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
