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
  type SyncPeers,
} from "../transport/gaitSocket.js";
import { ResultsPanel } from "../ui/resultsPanel.js";
import { SyncPlaybackDock } from "../ui/syncPlaybackDock.js";

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

async function boot(): Promise<void> {
  const userSettings = loadUserSettings();
  initI18n(userSettings.lang);

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
  ($("dogWeight") as HTMLInputElement).value = String(userSettings.dogWeight);

  const pipeline = new ProcessingPipeline(config);
  const renderer = new HeatmapRenderer(canvas, config);
  const renderFps = new FpsMeter();
  const inputHz = new RateMeter(1000);
  const recorder = new SessionRecorder();
  const syncDock = new SyncPlaybackDock();
  const cameraPlayer = syncDock.getPlayer();
  let syncSessionId: string | null = null;
  let syncRecordPending = false;
  let syncPlaybackActive = false;
  let lastAiVideoUrl: string | null = null;
  let pendingAnalyzeJob: string | null = null;

  const resultsPanel = new ResultsPanel($("resultsPanel"));
  resultsPanel.setApiBase(apiBase);

  const updateSyncUi = (peers?: SyncPeers, hubConnected?: boolean): void => {
    const mobileEl = $("syncStatus");
    const hubEl = $("syncHub");
    if (hubConnected === false) {
      hubEl.textContent = t("sync_hub_disconnected");
      hubEl.className = "off";
      mobileEl.textContent = "–";
      mobileEl.className = "off";
      if (!syncPlaybackActive) cameraPlayer.clearPreview();
      return;
    }
    hubEl.textContent = t("sync_hub_connected");
    hubEl.className = "ok";
    const mobile = peers?.mobile ?? false;
    mobileEl.textContent = mobile ? t("sync_mobile_connected") : t("sync_mobile_waiting");
    mobileEl.className = mobile ? "ok" : "wait";
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
    $("syncStatus").textContent = t("sync_analyze_done");
    $("syncStatus").className = "ok";
    try {
      await syncDock.play(frames, videoUrl, (raw) => renderSyncedMatFrame(raw));
    } catch (err) {
      syncPlaybackActive = false;
      syncDock.hide();
      $("syncStatus").textContent = err instanceof Error ? err.message : String(err);
      $("syncStatus").className = "bad";
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

  const weightOf = (): number =>
    Number(($("dogWeight") as HTMLInputElement).value) || config.gait.default_weight_kg;

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
    ($("btnSharp") as HTMLButtonElement).textContent = t(m.labelKey);
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
    $("status").className = connected ? "ok" : "off";
  };

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
      ($(id) as HTMLButtonElement).disabled = !on;
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
    ($("btnGaitCsv") as HTMLButtonElement).disabled = !on;
    ($("btnGaitPdf") as HTMLButtonElement).disabled = !on;
    ($("btnGaitJson") as HTMLButtonElement).disabled = !on;
  };

  $("btnGait").addEventListener("click", () => {
    const btn = $("btnGait") as HTMLButtonElement;
    const weight = Number(($("dogWeight") as HTMLInputElement).value) || config.gait.default_weight_kg;
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

  $("btnGaitCsv").addEventListener("click", () => {
    if (!lastGait) return;
    downloadText(`gait-report-${fileStamp()}.csv`, gaitSummaryToCsv(lastGait));
  });

  $("btnGaitPdf").addEventListener("click", async () => {
    if (!lastGait) return;
    const btn = $("btnGaitPdf") as HTMLButtonElement;
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

  $("btnGaitJson").addEventListener("click", () => {
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
    ($("btnRecord") as HTMLButtonElement).textContent = recorder.isRecording
      ? t("btn_stop")
      : t("btn_record");
  };

  const startLocalRecording = (wallAnchorMs?: number): void => {
    syncDock.stop();
    syncDock.hide();
    syncPlaybackActive = false;
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
      $("syncStatus").textContent = t("sync_pending");
      void waitUntilRecordAt(msg.recordAt).then(() => {
        if (!recorder.isRecording) startLocalRecording(msg.recordAt);
      });
    }
    if (msg.type === "record_stop") {
      syncRecordPending = false;
      if (recorder.isRecording) stopLocalRecording();
      syncSessionId = null;
    }
    if (msg.type === "upload_started") {
      pendingAnalyzeJob = msg.jobId;
      $("syncStatus").textContent = t("sync_uploading");
      $("syncStatus").className = "wait";
      cameraPlayer.setLoading(true, t("sync_uploading"));
      void pollJobUntilDone(apiBase, msg.jobId)
        .then((job) => {
          if (pendingAnalyzeJob !== msg.jobId) return;
          pendingAnalyzeJob = null;
          if (job.status === "completed" && job.resultUrl) {
            void beginSyncedPlayback(absolutizeResultUrl(apiBase, job.resultUrl));
            void resultsPanel.refresh();
          } else {
            cameraPlayer.setLoading(false);
            $("syncStatus").textContent = `${t("sync_analyze_failed")}: ${job.error ?? "unknown"}`;
            $("syncStatus").className = "bad";
          }
        })
        .catch((err) => {
          pendingAnalyzeJob = null;
          cameraPlayer.setLoading(false);
          $("syncStatus").textContent = err instanceof Error ? err.message : String(err);
          $("syncStatus").className = "bad";
        });
    }
    if (msg.type === "analyze_done") {
      pendingAnalyzeJob = null;
      void beginSyncedPlayback(absolutizeResultUrl(apiBase, msg.resultUrl));
      void resultsPanel.refresh();
    }
    if (msg.type === "analyze_failed") {
      cameraPlayer.setLoading(false);
      $("syncStatus").textContent = `${t("sync_analyze_failed")}: ${msg.error}`;
      $("syncStatus").className = "bad";
    }
    if (msg.type === "error") {
      syncRecordPending = false;
      $("syncStatus").textContent = msg.message;
      $("syncStatus").className = "bad";
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
  void resultsPanel.refresh();

  $("btnRecord").addEventListener("click", () => {
    if (recorder.isRecording) {
      stopLocalRecording();
      if (gaitSync.connected && gaitSync.peers.mobile) {
        gaitSync.stopRecord(syncSessionId);
        $("syncStatus").textContent = t("sync_analyzing");
        $("syncStatus").className = "wait";
      }
      syncSessionId = null;
      syncRecordPending = false;
      updateSyncUi(gaitSync.peers, gaitSync.connected);
      return;
    }

    if (gaitSync.connected && gaitSync.peers.mobile) {
      syncRecordPending = true;
      $("syncStatus").textContent = t("sync_pending");
      gaitSync.requestRecord();
      return;
    }

    if (gaitSync.connected) {
      $("syncStatus").textContent = t("sync_need_mobile");
      $("syncStatus").className = "warn";
      return;
    }

    startLocalRecording();
  });

  $("btnCsv").addEventListener("click", () => {
    const csv = framesToCanineGaitCsv(recorder.getFrames(), GRID_ROWS, GRID_COLS);
    downloadText(`gait-${fileStamp()}.csv`, csv);
  });

  // Paw-tracking CSV: per-frame, per-paw label + position + pressure.
  $("btnTrackCsv").addEventListener("click", () => {
    const btn = $("btnTrackCsv") as HTMLButtonElement;
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

  $("btnGif").addEventListener("click", async () => {
    const btn = $("btnGif") as HTMLButtonElement;
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

  $("btnPng").addEventListener("click", async () => {
    const btn = $("btnPng") as HTMLButtonElement;
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

  $("btnReplay").addEventListener("click", () => {
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

  $("btnCalibrate").addEventListener("click", () => {
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

  ($("dogWeight") as HTMLInputElement).addEventListener("change", () => {
    liveTracker.setWeight(weightOf());
    cachedTrack = null;
    persistSettings();
  });
  ($("dogWeight") as HTMLInputElement).addEventListener("input", () => persistSettings());

  const btnLabels = $("btnLabels") as HTMLButtonElement;
  const refreshLabelsBtn = (): void => {
    btnLabels.textContent = overlayEnabled ? t("btn_labels_on") : t("btn_labels_off");
    btnLabels.classList.toggle("active", overlayEnabled);
  };
  btnLabels.addEventListener("click", () => {
    overlayEnabled = !overlayEnabled;
    if (!overlayEnabled) {
      latestOverlay = null;
      clearOverlay();
    }
    refreshLabelsBtn();
    persistSettings();
  });
  refreshLabelsBtn();
  $("btnGrid").addEventListener("click", () => {
    config.render.show_grid = !config.render.show_grid;
    renderer.setConfig(config);
    persistSettings();
  });
  $("btnSharp").addEventListener("click", () => {
    applySharpMode(sharpIdx + 1);
    persistSettings();
  });
  ($("file") as HTMLInputElement).addEventListener("change", async (e) => {
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

  onLangChange(() => {
    applyDocumentI18n();
    refreshLabelsBtn();
    applySharpMode(sharpIdx);
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

    $("btnConnect").addEventListener("click", () => openPortModal());
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
    $("btnConnect").addEventListener("click", () => attach(new WebSerialSource()));
    setStatus(false);
  }

  window.addEventListener("beforeunload", () => {
    saveUserSettings(collectSettings());
    syncDock.stop();
    gaitSync.disconnect();
    void source?.stop();
  });
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
