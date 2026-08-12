/**
 * 압력판 녹화 → CSV 업로드 → 저장 기록 열람 UI 컨트롤러.
 *
 * 기존 임상(clinic) 세션/카메라 동기화 흐름과 독립적으로 동작하는 로컬 전용 기능이다.
 * 강아지 이름/견종/체중을 입력받아 로컬 녹화를 시작/종료하고, 종료 시 canine_gait
 * 호환 CSV 를 백엔드(`back/pressure_data`)로 업로드한다. 저장된 CSV 는 목록에서
 * 열람/다운로드할 수 있다.
 *
 * 기존 코드를 건드리지 않기 위해 필요한 의존성(recorder, 로컬 녹화 시작/종료,
 * CSV 빌더)을 주입받는다.
 */

import {
  listPressureRecords,
  pressureCsvUrl,
  uploadPressureCsv,
  type PressureRecord,
} from "../api/pressureApi.js";

export interface PressureRecorderDeps {
  apiBase: string;
  /** 로컬 녹화 시작(카메라 동기화 없이). */
  startLocalRecording: () => void;
  /** 로컬 녹화 종료. */
  stopLocalRecording: () => void;
  /** 현재 녹화 중인지(모든 흐름 공유 recorder 기준). */
  isRecording: () => boolean;
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
}

const $ = (id: string): HTMLElement | null => document.getElementById(id);

export function wirePressureRecorder(deps: PressureRecorderDeps): void {
  const recBtn = $("btnPressureRec") as HTMLButtonElement | null;
  const refreshBtn = $("btnPressureRefresh") as HTMLButtonElement | null;
  const statusEl = $("pressureRecStatus");
  const listEl = $("pressureRecList") as HTMLUListElement | null;
  const nameInput = $("recDogName") as HTMLInputElement | null;
  const breedInput = $("recDogBreed") as HTMLInputElement | null;
  const weightInput = $("recDogWeight") as HTMLInputElement | null;
  const heightInput = $("recDogHeight") as HTMLInputElement | null;

  // 필수 UI 가 없으면(HTML 미포함) 조용히 종료 — 기존 동작에 영향 없음.
  if (!recBtn) return;

  /** 이 UI 가 시작한 녹화인지 표시(다른 흐름의 녹화와 구분). */
  let activeSession = false;
  let busy = false;

  const setStatus = (text: string, kind: "" | "ok" | "warn" | "bad" = ""): void => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = `rec-status ${kind}`.trim();
  };

  const setInputsDisabled = (disabled: boolean): void => {
    for (const el of [nameInput, breedInput, weightInput, heightInput]) {
      if (el) el.disabled = disabled;
    }
  };

  const syncButton = (): void => {
    recBtn.textContent = activeSession ? "■ 녹화 종료 · 저장" : "● 압력판 녹화 시작";
    recBtn.classList.toggle("recording", activeSession);
  };

  const readWeight = (): number | null => {
    const v = weightInput?.value?.trim();
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const readHeight = (): number | null => {
    const v = heightInput?.value?.trim();
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const startSession = (): void => {
    if (busy) return;
    if (deps.isRecording()) {
      setStatus("이미 다른 녹화가 진행 중입니다.", "warn");
      return;
    }
    if (!nameInput?.value?.trim()) {
      setStatus("강아지 이름을 입력해 주세요.", "warn");
      nameInput?.focus();
      return;
    }
    deps.startLocalRecording();
    activeSession = true;
    setInputsDisabled(true);
    setStatus("녹화 중… 종료를 누르면 CSV 로 저장됩니다.", "warn");
    syncButton();
  };

  const stopAndUpload = async (): Promise<void> => {
    if (busy) return;
    deps.stopLocalRecording();
    activeSession = false;
    syncButton();

    const frames = deps.frameCount();
    if (frames < 2) {
      setInputsDisabled(false);
      setStatus("녹화된 프레임이 부족해 저장하지 않았습니다.", "bad");
      return;
    }

    busy = true;
    recBtn.disabled = true;
    setStatus(`업로드 중… (${frames} 프레임)`, "warn");
    try {
      const csv = deps.buildCsv();
      const record = await uploadPressureCsv(deps.apiBase, {
        csv,
        dog: {
          name: nameInput?.value?.trim() || undefined,
          breed: breedInput?.value?.trim() || undefined,
          weightKg: readWeight(),
          heightCm: readHeight(),
        },
        recording: {
          frames,
          durationSec: deps.durationSec(),
          fps: deps.fps(),
          rows: deps.rows,
          cols: deps.cols,
          startedAt: new Date().toISOString(),
        },
      });
      setStatus(`저장 완료: ${record.csv.filename}`, "ok");
      await refreshList();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), "bad");
    } finally {
      busy = false;
      recBtn.disabled = false;
      setInputsDisabled(false);
    }
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
      li.textContent = "저장된 기록이 없습니다.";
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
      const height = r.dog.heightCm != null ? `${r.dog.heightCm}cm` : "–";
      const breed = r.dog.breed || "–";
      const title = document.createElement("div");
      title.className = "pressure-rec-title";
      title.textContent = r.dog.name || "(이름 없음)";
      const sub = document.createElement("div");
      sub.className = "pressure-rec-sub";
      sub.textContent = `${breed} · ${weight} · ${height} · ${dur} · ${fmtDate(r.createdAt)}`;
      meta.appendChild(title);
      meta.appendChild(sub);

      const actions = document.createElement("div");
      actions.className = "pressure-rec-actions";
      const viewLink = document.createElement("a");
      viewLink.textContent = "보기";
      viewLink.href = pressureCsvUrl(deps.apiBase, r, false);
      viewLink.target = "_blank";
      viewLink.rel = "noopener";
      const dlLink = document.createElement("a");
      dlLink.textContent = "다운로드";
      dlLink.href = pressureCsvUrl(deps.apiBase, r, true);
      actions.appendChild(viewLink);
      actions.appendChild(dlLink);

      li.appendChild(meta);
      li.appendChild(actions);
      listEl.appendChild(li);
    }
  };

  const refreshList = async (): Promise<void> => {
    if (!listEl) return;
    try {
      const records = await listPressureRecords(deps.apiBase);
      renderList(records);
    } catch (err) {
      listEl.innerHTML = "";
      const li = document.createElement("li");
      li.className = "pressure-rec-empty";
      li.textContent = err instanceof Error ? err.message : String(err);
      listEl.appendChild(li);
    }
  };

  recBtn.addEventListener("click", () => {
    if (activeSession) void stopAndUpload();
    else startSession();
  });
  refreshBtn?.addEventListener("click", () => void refreshList());

  syncButton();
  void refreshList();
}
