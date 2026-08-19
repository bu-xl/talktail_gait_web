/**
 * 압력판 CSV 저장/열람 컨트롤러.
 *
 * 기존 세션 흐름(시작 버튼 → 영상 + 압력판 동시 녹화)을 그대로 두고, 세션이 종료될 때
 * 캡처된 압력 프레임을 canine_gait 호환 CSV 로 만들어 백엔드(`back/pressure_data`)에
 * 업로드한다. 강아지 이름/견종/몸무게는 "반려견" 입력란(#dogName/#dogBreed/#dogWeightInfo)
 * 에서 읽는다. 저장된 CSV 는 "저장된 CSV" 목록에서 열람/다운로드할 수 있다.
 *
 * 별도의 압력판 전용 녹화 UI 는 없다 — 업로드는 세션 종료 훅에서만 일어난다.
 */

import { onLangChange, t } from "../i18n/index.js";
import {
  listPressureRecords,
  pressureCsvUrl,
  uploadPressureCsv,
  type PressureRecord,
} from "../api/pressureApi.js";

export interface PressureCsvDeps {
  apiBase: string;
  /** 캡처된 프레임 수. */
  frameCount: () => number;
  /** 캡처 길이(초). */
  durationSec: () => number;
  /** 평균 캡처율(Hz). */
  fps: () => number;
  /** 녹화 프레임 → canine_gait 호환 CSV 문자열. */
  buildCsv: () => string;
  /** 그리드 크기(메타데이터용). */
  rows: number;
  cols: number;
  /** 동기 촬영 세션 id (영상과 CSV 를 back 에서 한 세션으로 묶기 위함). */
  sessionId?: () => string | null;
  /**
   * CSV 첫 행(`time=0`)의 절대 시각(t_server_ns). 영상 프레임과 매칭하는 기준점.
   * 시계 동기화 전에 녹화했으면 null — 그 CSV 는 영상과 정확히 맞출 수 없다.
   */
  startAtServerNs?: () => bigint | null;
  clockOffsetNs?: () => bigint | null;
  clockRttP50Ns?: () => bigint | null;
}

export interface PressureCsvController {
  /** 세션 종료 시 호출 — 프레임이 있으면 CSV 를 만들어 업로드하고 목록을 갱신한다. */
  uploadRecorded: () => Promise<void>;
  /** 저장된 CSV 목록 새로고침. */
  refresh: () => Promise<void>;
}

const $ = (id: string): HTMLElement | null => document.getElementById(id);

function readDogInfo(): { name?: string; breed?: string; weightKg?: number | null } {
  const name = ($("dogName") as HTMLInputElement | null)?.value?.trim() || undefined;
  const breed = ($("dogBreed") as HTMLInputElement | null)?.value?.trim() || undefined;
  const weightRaw = ($("dogWeightInfo") as HTMLInputElement | null)?.value?.trim();
  let weightKg: number | null = null;
  if (weightRaw) {
    const n = Number(weightRaw);
    weightKg = Number.isFinite(n) && n > 0 ? n : null;
  }
  return { name, breed, weightKg };
}

export function createPressureCsvController(deps: PressureCsvDeps): PressureCsvController {
  const statusEl = $("pressureRecStatus");
  const listEl = $("pressureRecList") as HTMLUListElement | null;
  const refreshBtn = $("btnPressureRefresh") as HTMLButtonElement | null;

  const setStatus = (text: string, kind: "" | "ok" | "warn" | "bad" = ""): void => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = `rec-status ${kind}`.trim();
  };

  const fmtDate = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const renderList = (records: PressureRecord[]): void => {
    if (!listEl) return;
    listEl.innerHTML = "";
    if (!records.length) {
      const li = document.createElement("li");
      li.className = "pressure-rec-empty";
      li.textContent = t("csv_list_empty");
      listEl.appendChild(li);
      return;
    }
    for (const r of records) {
      const li = document.createElement("li");
      li.className = "pressure-rec-item";

      const meta = document.createElement("div");
      meta.className = "pressure-rec-meta";
      const dur = r.recording.durationSec != null ? `${r.recording.durationSec.toFixed(1)}s` : "–";
      const weight = r.dog.weightKg != null ? `${r.dog.weightKg}kg` : "–";
      const breed = r.dog.breed || "–";
      const title = document.createElement("div");
      title.className = "pressure-rec-title";
      title.textContent = r.dog.name || t("csv_no_name");
      const sub = document.createElement("div");
      sub.className = "pressure-rec-sub";
      sub.textContent = `${breed} · ${weight} · ${dur} · ${fmtDate(r.createdAt)}`;
      meta.appendChild(title);
      meta.appendChild(sub);

      const actions = document.createElement("div");
      actions.className = "pressure-rec-actions";
      const viewLink = document.createElement("a");
      viewLink.textContent = t("btn_view");
      viewLink.href = pressureCsvUrl(deps.apiBase, r, false);
      viewLink.target = "_blank";
      viewLink.rel = "noopener";
      const dlLink = document.createElement("a");
      dlLink.textContent = t("btn_download");
      dlLink.href = pressureCsvUrl(deps.apiBase, r, true);
      actions.appendChild(viewLink);
      actions.appendChild(dlLink);

      li.appendChild(meta);
      li.appendChild(actions);
      listEl.appendChild(li);
    }
  };

  /** 언어 전환 시 다시 그리기 위한 캐시 — 서버를 다시 부르지 않는다. */
  let lastRecords: PressureRecord[] | null = null;
  onLangChange(() => {
    if (lastRecords) renderList(lastRecords);
  });

  const refresh = async (): Promise<void> => {
    if (!listEl) return;
    try {
      lastRecords = await listPressureRecords(deps.apiBase);
      renderList(lastRecords);
    } catch (err) {
      listEl.innerHTML = "";
      const li = document.createElement("li");
      li.className = "pressure-rec-empty";
      li.textContent = err instanceof Error ? err.message : String(err);
      listEl.appendChild(li);
    }
  };

  let busy = false;
  const uploadRecorded = async (): Promise<void> => {
    if (busy) return;
    const frames = deps.frameCount();
    if (frames < 2) return; // 데이터가 없으면 조용히 무시(기존 흐름 방해 금지).

    // CSV 문자열/메타데이터는 recorder 가 다음 녹화로 초기화되기 전에 즉시 확보한다.
    let csv: string;
    try {
      csv = deps.buildCsv();
    } catch {
      return;
    }
    const dog = readDogInfo();
    // sessionId 는 record_stop 에서 null 로 지워지기 전에 지금 즉시 확보한다.
    const sessionId = deps.sessionId?.() ?? null;
    const recording = {
      frames,
      durationSec: deps.durationSec(),
      fps: deps.fps(),
      rows: deps.rows,
      cols: deps.cols,
      startedAt: new Date().toISOString(),
    };
    // 나노초는 문자열로만 다룬다 — Number 로 바꾸면 2^53 을 넘어 자릿수가 잘린다.
    const startAtServerNs = deps.startAtServerNs?.() ?? null;
    const timebase = {
      startAtServerNs: startAtServerNs?.toString() ?? null,
      clockOffsetNs: deps.clockOffsetNs?.()?.toString() ?? null,
      clockRttP50Ns: deps.clockRttP50Ns?.()?.toString() ?? null,
    };
    if (startAtServerNs === null) {
      console.warn(
        "[pressure] 시계 동기화 없이 녹화된 CSV 입니다 — 영상과 프레임 단위로 매칭할 수 없습니다.",
      );
    }

    busy = true;
    setStatus(t("csv_uploading", { n: frames }), "warn");
    try {
      const record = await uploadPressureCsv(deps.apiBase, {
        csv,
        dog,
        recording,
        sessionId,
        timebase,
      });
      setStatus(t("csv_upload_done", { name: record.csv.filename }), "ok");
      await refresh();
    } catch (err) {
      setStatus(t("csv_upload_failed", { msg: err instanceof Error ? err.message : String(err) }), "bad");
    } finally {
      busy = false;
    }
  };

  refreshBtn?.addEventListener("click", () => void refresh());
  void refresh();

  return { uploadRecorded, refresh };
}
