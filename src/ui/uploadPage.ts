/**
 * "직접 분석" 페이지 — 압력 CSV + 촬영 영상을 직접 올려 분석한다.
 *
 * 매트/폰 없이 이미 수집해 둔 파일로 같은 파이프라인(back → ai-server)을 타는 경로다.
 * 두 파일 + **등록된 반려견 선택**이 모두 있어야 "분석하기" 가 열린다.
 *
 * 이름을 손으로 치지 않는다(§3-3). 저장 경로가 `uploads/<userId>/<dogId>/<도장>/` 이라
 * 개체 없이는 파일을 둘 자리가 없고, 이름을 받아 봐야 그 값이 파일명이 되지도 않는다.
 * 업로드가 접수되면(202) 잡 id 를 넘겨 주고, 진행 표시와 결과 표시는 측정 화면의
 * 기존 "분석 중" 오버레이가 그대로 맡는다.
 */

import { uploadManualAnalysis, type ManualAnalyzeJob, type ManualDogInfo } from "../api/analyzeApi.js";
import { listDogs, type Dog } from "../api/dogsApi.js";
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
  /** 지금 상태줄에 떠 있는 것이 게이트 안내인지 — 다른 메시지를 덮어쓰지 않으려고 둔다. */
  private statusIsGate = false;
  /** 고를 수 있는 개체. 목록이 비면 먼저 등록해야 한다. */
  private dogs: Dog[] = [];
  private readonly dogSelect: HTMLSelectElement | null;

  constructor(root: HTMLElement, opts: UploadPageOptions) {
    this.root = root;
    this.opts = opts;
    this.statusEl = root.querySelector("#upStatus") as HTMLElement;
    this.analyzeBtn = root.querySelector("#upAnalyze") as HTMLButtonElement;

    this.dogSelect = root.querySelector("#upDogSelect") as HTMLSelectElement | null;
    this.wireSlot("csv", "upCsvInput", "upCsvBox", "upCsvName");
    this.wireSlot("video", "upVideoInput", "upVideoBox", "upVideoName");
    this.analyzeBtn.addEventListener("click", () => void this.submit());
    // 개체를 고르는 즉시 버튼이 풀려야 한다 — 안 그러면 왜 막혔는지 못 찾는다.
    this.dogSelect?.addEventListener("change", () => this.syncUi());
    onLangChange(() => this.syncUi());
    this.syncUi();
  }

  show(): void {
    this.root.hidden = false;
    void this.loadDogs();
    this.syncUi();
  }

  /** 개체 목록을 채운다. 비어 있으면 "빠른 입력 등록" 으로 먼저 만들어야 한다. */
  private async loadDogs(): Promise<void> {
    if (!this.dogSelect) return;
    try {
      this.dogs = await listDogs(this.opts.apiBase);
    } catch {
      this.dogs = [];
    }
    const keep = this.dogSelect.value;
    this.dogSelect.textContent = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = t("session_need_dog");
    this.dogSelect.appendChild(blank);
    for (const dog of this.dogs) {
      const o = document.createElement("option");
      o.value = String(dog.id);
      // 같은 이름이 여럿일 수 있다 — id 와 몸무게까지 보여야 고를 수 있다.
      o.textContent = `#${dog.id} ${dog.name} · ${dog.weightKg}kg`;
      this.dogSelect.appendChild(o);
    }
    this.dogSelect.value = keep;
    this.syncUi();
  }

  /** 고른 개체. 안 골랐으면 null. */
  private selectedDog(): Dog | null {
    const id = Number(this.dogSelect?.value || "");
    if (!Number.isInteger(id) || id <= 0) return null;
    return this.dogs.find((d) => d.id === id) ?? null;
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

  /** 표시용 정보. 서버로 가는 값은 `dogId` 하나다. */
  private readDog(): ManualDogInfo {
    const dog = this.selectedDog();
    return {
      name: dog?.name ?? null,
      breed: dog?.breed ?? null,
      weightKg: dog?.weightKg ?? null,
      heightCm: dog?.heightCm ?? null,
    };
  }

  private setStatus(text: string, tone?: "ok" | "wait" | "bad"): void {
    this.statusIsGate = false;
    this.statusEl.textContent = text;
    this.statusEl.className = `up-status${tone ? ` ${tone}` : ""}`;
  }

  private syncUi(): void {
    const hasFiles = Boolean(this.files.csv && this.files.video);
    const dogId = this.selectedDog()?.id ?? null;
    this.analyzeBtn.disabled = !hasFiles || dogId == null || this.busy;

    // 파일까지 고른 뒤에도 막혀 있으면 이유를 보여 준다. 파일이 아직이면 그쪽이
    // 먼저 눈에 보이는 문제이므로 개체 안내로 덮지 않는다.
    if (hasFiles && dogId == null && !this.busy) {
      this.setStatus(t("session_need_dog"), "bad");
      this.statusIsGate = true;
    } else if (this.statusIsGate) {
      this.setStatus("");
      this.statusIsGate = false;
    }

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

    const dogId = this.selectedDog()?.id ?? null;
    const dog = this.readDog();
    if (dogId == null) {
      this.setStatus(t("session_need_dog"), "bad");
      return;
    }

    this.busy = true;
    this.syncUi();
    this.setStatus(t("upload_sending"), "wait");

    try {
      const job = await uploadManualAnalysis(this.opts.apiBase, { csv, video, dogId });
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
