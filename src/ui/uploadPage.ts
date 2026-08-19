/**
 * "직접 분석" 페이지 — 압력 CSV + 촬영 영상을 직접 올려 분석한다.
 *
 * 매트/폰 없이 이미 수집해 둔 파일로 같은 파이프라인(back → ai-server)을 타는 경로다.
 * 두 파일이 모두 선택되어야 "분석하기" 가 열리고, 반려견 정보는 선택 입력이다.
 * 업로드가 접수되면(202) 잡 id 를 넘겨 주고, 진행 표시와 결과 표시는 측정 화면의
 * 기존 "분석 중" 오버레이가 그대로 맡는다.
 */

import { uploadManualAnalysis, type ManualAnalyzeJob, type ManualDogInfo } from "../api/analyzeApi.js";
import { onLangChange, t } from "../i18n/index.js";

export type UploadPageOptions = {
  apiBase: string;
  /** 업로드 접수 직후 호출 — 측정 화면으로 넘겨 분석 대기 상태로 만든다. */
  onSubmitted: (job: ManualAnalyzeJob, dog: ManualDogInfo) => void;
};

type Slot = "csv" | "video";

export class UploadPage {
  private readonly root: HTMLElement;
  private readonly opts: UploadPageOptions;
  private readonly statusEl: HTMLElement;
  private readonly analyzeBtn: HTMLButtonElement;
  private readonly files: Record<Slot, File | null> = { csv: null, video: null };
  private busy = false;

  constructor(root: HTMLElement, opts: UploadPageOptions) {
    this.root = root;
    this.opts = opts;
    this.statusEl = root.querySelector("#upStatus") as HTMLElement;
    this.analyzeBtn = root.querySelector("#upAnalyze") as HTMLButtonElement;

    this.wireSlot("csv", "upCsvInput", "upCsvBox", "upCsvName");
    this.wireSlot("video", "upVideoInput", "upVideoBox", "upVideoName");
    this.analyzeBtn.addEventListener("click", () => void this.submit());
    onLangChange(() => this.syncUi());
    this.syncUi();
  }

  show(): void {
    this.root.hidden = false;
    this.syncUi();
  }

  hide(): void {
    this.root.hidden = true;
  }

  private wireSlot(slot: Slot, inputId: string, boxId: string, nameId: string): void {
    const input = this.root.querySelector(`#${inputId}`) as HTMLInputElement | null;
    const box = this.root.querySelector(`#${boxId}`) as HTMLElement | null;
    if (!input || !box) return;

    // 박스 전체가 파일 선택 트리거다. 안의 "파일 선택" 버튼은 여기로 버블링돼 같은
    // 핸들러를 타므로 따로 걸지 않는다 — 따로 걸면 클릭 한 번에 두 번 열린다.
    // 다만 `input.click()` 이 만든 클릭도 여기로 되돌아오므로 그 경우는 걸러 낸다.
    box.addEventListener("click", (ev) => {
      if (this.busy || ev.target === input) return;
      input.click();
    });

    input.addEventListener("change", () => {
      this.setFile(slot, input.files?.[0] ?? null, nameId, boxId);
    });

    box.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      if (!this.busy) box.classList.add("is-drag");
    });
    box.addEventListener("dragleave", () => box.classList.remove("is-drag"));
    box.addEventListener("drop", (ev) => {
      ev.preventDefault();
      box.classList.remove("is-drag");
      if (this.busy) return;
      const file = ev.dataTransfer?.files?.[0];
      if (!file) return;
      // 드롭은 input.files 를 거치지 않으므로 상태만 갱신한다(전송은 File 객체로 한다).
      this.setFile(slot, file, nameId, boxId);
    });
  }

  private setFile(slot: Slot, file: File | null, nameId: string, boxId: string): void {
    this.files[slot] = file;
    const nameEl = this.root.querySelector(`#${nameId}`) as HTMLElement | null;
    const box = this.root.querySelector(`#${boxId}`) as HTMLElement | null;
    if (nameEl) nameEl.textContent = file ? `${file.name} · ${formatSize(file.size)}` : "";
    box?.classList.toggle("has-file", Boolean(file));
    this.setStatus("");
    this.syncUi();
  }

  private readDog(): ManualDogInfo {
    const value = (id: string): string =>
      (this.root.querySelector(`#${id}`) as HTMLInputElement | null)?.value.trim() ?? "";
    const num = (id: string): number | null => {
      const raw = value(id);
      if (!raw) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    };
    return {
      name: value("upDogName") || null,
      breed: value("upDogBreed") || null,
      weightKg: num("upDogWeight"),
      heightCm: num("upDogHeight"),
    };
  }

  private setStatus(text: string, tone?: "ok" | "wait" | "bad"): void {
    this.statusEl.textContent = text;
    this.statusEl.className = `up-status${tone ? ` ${tone}` : ""}`;
  }

  private syncUi(): void {
    const ready = Boolean(this.files.csv && this.files.video);
    this.analyzeBtn.disabled = !ready || this.busy;
    this.analyzeBtn.textContent = this.busy ? t("upload_sending") : t("btn_upload_analyze");
    for (const [slot, pickId] of [
      ["csv", "upCsvPick"],
      ["video", "upVideoPick"],
    ] as Array<[Slot, string]>) {
      const btn = this.root.querySelector(`#${pickId}`) as HTMLButtonElement | null;
      if (btn) {
        btn.textContent = this.files[slot] ? t("upload_change_file") : t("upload_pick_file");
        btn.disabled = this.busy;
      }
    }
  }

  private async submit(): Promise<void> {
    const csv = this.files.csv;
    const video = this.files.video;
    if (!csv || !video) {
      this.setStatus(t("upload_need_files"), "bad");
      return;
    }
    if (this.busy) return;

    this.busy = true;
    this.syncUi();
    this.setStatus(t("upload_sending"), "wait");

    const dog = this.readDog();
    try {
      const job = await uploadManualAnalysis(this.opts.apiBase, { csv, video, dog });
      this.setStatus(t("upload_started"), "ok");
      this.opts.onSubmitted(job, dog);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.setStatus(`${t("upload_failed")}: ${detail}`, "bad");
    } finally {
      this.busy = false;
      this.syncUi();
    }
  }
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}
