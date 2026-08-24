/**
 * 서버에 저장된 원본을 **촬영 한 건(태스크) 단위**로 내려받는 페이지.
 * 목록은 DB 가 아니라 back 디스크(`pressure_data`, `uploads`)다.
 *
 * 파일을 CSV 열·영상 열로 늘어놓으면 sub 카메라 수가 촬영마다 달라서 어떤 파일이
 * 어느 촬영의 것인지 사람이 맞춰야 한다. 그래서 파일명 도장으로 되묶어
 * (`sessionNaming.groupSessions` — "데이터 검증" 화면과 같은 규칙) 태스크 한 줄로 보여주고,
 * ZIP 도 태스크 폴더 안에 그 촬영의 CSV + 영상이 함께 들어가게 받는다.
 *
 * 체크박스는 태스크에만 있다. "여러 개 골라 묶기"는 체크박스, "이거 하나만"은 ⬇ 로
 * 역할이 갈린다 — 파일 단위 체크박스까지 두면 부분 선택된 태스크의 폴더 구조가 애매해진다.
 */

import { onLangChange, t } from "../i18n/index.js";
import {
  createZipTicket,
  listStoredFiles,
  storedFileUrl,
  zipDownloadUrl,
  type StoredCsvFile,
  type StoredVideoFile,
} from "../api/storedFilesApi.js";
import {
  groupSessions,
  parseCaptureName,
  taskName,
  ungroupedFiles,
  type CaptureSession,
} from "../core/sessionNaming.js";

type StoredFile = StoredCsvFile | StoredVideoFile;

/** 태스크 한 건의 파일들. 목록·용량 계산이 전부 이걸 쓴다. */
function taskFiles(task: CaptureSession): StoredFile[] {
  return task.csv ? [task.csv, ...task.videos] : [...task.videos];
}

function taskSize(task: CaptureSession): number {
  return taskFiles(task).reduce((sum, row) => sum + (Number(row.size) || 0), 0);
}

/** 이 촬영에 빠진 게 있으면 사유. 없으면 null. */
function taskWarning(task: CaptureSession): string | null {
  if (!task.csv) return t("files_tag_no_csv");
  if (task.videos.length === 0) return t("files_tag_no_video");
  return null;
}

function roleLabel(name: string): string {
  const parsed = parseCaptureName(name);
  if (!parsed) return "";
  if (parsed.role === "main") return t("files_role_main");
  return `${t("files_role_sub")}${parsed.subIndex ?? 1}`;
}

const VIDEO_EXT_RE = /\.(mp4|mov|m4v|avi|webm)$/i;

export class FilesPage {
  private readonly root: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly searchEl: HTMLInputElement;
  private readonly fromEl: HTMLInputElement;
  private readonly toEl: HTMLInputElement;
  private readonly refreshBtn: HTMLButtonElement;
  private readonly allEl: HTMLInputElement;
  private readonly allLabelEl: HTMLElement;
  private readonly selEl: HTMLElement;
  private readonly zipBtn: HTMLButtonElement;
  private readonly countEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly looseEl: HTMLElement;
  private readonly looseHeadEl: HTMLElement;
  private readonly looseHintEl: HTMLElement;
  private readonly looseListEl: HTMLElement;

  private apiBase = "";
  private tasks: CaptureSession[] = [];
  /** 도장이 없어 묶이지 않은 파일 — 개별 다운로드만 된다. */
  private loose: StoredFile[] = [];
  private query = "";
  /** `<input type="date">` 값(`YYYY-MM-DD`), 비어 있으면 그 방향 제한 없음. */
  private from = "";
  private to = "";
  /** 선택된 태스크의 도장. 검색·새로고침에도 유지된다. */
  private readonly selected = new Set<string>();
  private readonly expanded = new Set<string>();
  private loading = false;
  private busy = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.subEl = root.querySelector("#fdSub") as HTMLElement;
    this.statusEl = root.querySelector("#fdStatus") as HTMLElement;
    this.searchEl = root.querySelector("#fdSearch") as HTMLInputElement;
    this.fromEl = root.querySelector("#fdFrom") as HTMLInputElement;
    this.toEl = root.querySelector("#fdTo") as HTMLInputElement;
    this.refreshBtn = root.querySelector("#fdRefresh") as HTMLButtonElement;
    this.allEl = root.querySelector("#fdAll") as HTMLInputElement;
    this.allLabelEl = root.querySelector("#fdAllLabel") as HTMLElement;
    this.selEl = root.querySelector("#fdSel") as HTMLElement;
    this.zipBtn = root.querySelector("#fdZip") as HTMLButtonElement;
    this.countEl = root.querySelector("#fdCount") as HTMLElement;
    this.listEl = root.querySelector("#fdList") as HTMLElement;
    this.emptyEl = root.querySelector("#fdEmpty") as HTMLElement;
    this.looseEl = root.querySelector("#fdLoose") as HTMLElement;
    this.looseHeadEl = root.querySelector("#fdLooseHeading") as HTMLElement;
    this.looseHintEl = root.querySelector("#fdLooseHint") as HTMLElement;
    this.looseListEl = root.querySelector("#fdLooseList") as HTMLElement;

    this.refreshBtn.addEventListener("click", () => void this.reload());
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value.trim().toLowerCase();
      this.render();
    });
    for (const el of [this.fromEl, this.toEl]) {
      el.addEventListener("change", () => {
        this.from = this.fromEl.value;
        this.to = this.toEl.value;
        this.render();
      });
    }
    this.allEl.addEventListener("change", () => this.toggleAll(this.allEl.checked));
    this.zipBtn.addEventListener("click", () => void this.downloadZip(this.selectedTasks()));
    onLangChange(() => this.syncCopy());
  }

  setApiBase(base: string): void {
    this.apiBase = base;
  }

  show(): void {
    this.root.hidden = false;
    this.syncCopy();
    void this.reload();
  }

  hide(): void {
    this.root.hidden = true;
  }

  private syncCopy(): void {
    this.subEl.textContent = t("files_page_sub");
    this.searchEl.placeholder = t("files_search_placeholder");
    this.refreshBtn.textContent = t("btn_results_refresh");
    this.allLabelEl.textContent = t("files_select_all");
    this.zipBtn.textContent = t("files_zip_button");
    this.emptyEl.textContent = t("files_empty_tasks");
    this.looseHeadEl.textContent = t("files_ungrouped_heading");
    this.looseHintEl.textContent = t("files_ungrouped_hint");
    this.render();
  }

  private setStatus(text: string, bad = false): void {
    this.statusEl.textContent = text;
    this.statusEl.className = bad ? "fd-status is-bad" : "fd-status";
  }

  private async reload(): Promise<void> {
    if (!this.apiBase || this.loading) return;
    this.loading = true;
    this.refreshBtn.disabled = true;
    this.emptyEl.hidden = true;
    this.setStatus(t("files_loading"));
    try {
      const list = await listStoredFiles(this.apiBase);
      this.tasks = groupSessions(list.csv, list.videos);
      this.loose = ungroupedFiles(list.csv, list.videos);
      // 목록에서 사라진 촬영은 선택도 풀어야 ZIP 요청에 유령 이름이 남지 않는다.
      const alive = new Set(this.tasks.map((task) => task.stamp));
      for (const stamp of [...this.selected]) {
        if (!alive.has(stamp)) this.selected.delete(stamp);
      }
      this.setStatus("");
      this.render();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.setStatus(`${t("files_load_failed")}: ${detail}`, true);
    } finally {
      this.loading = false;
      this.refreshBtn.disabled = false;
    }
  }

  /** 검색은 태스크 이름과 그 안의 파일명 모두에 걸린다. */
  private matches(task: CaptureSession): boolean {
    if (this.query) {
      const hay = [taskName(task), ...taskFiles(task).map((row) => row.name)]
        .join("\n")
        .toLowerCase();
      if (!hay.includes(this.query)) return false;
    }
    if (this.from || this.to) {
      const day = this.taskDay(task);
      if (!day) return false;
      if (this.from && day < this.from) return false;
      if (this.to && day > this.to) return false;
    }
    return true;
  }

  /**
   * 촬영 날짜(`YYYY-MM-DD`). 도장은 촬영 시각이라 업로드가 끝난 mtime 보다 정확하다.
   * 도장을 못 읽으면 파일 저장 시각으로 물러선다.
   */
  private taskDay(task: CaptureSession): string {
    if (task.when) {
      const p = (n: number): string => String(n).padStart(2, "0");
      return `${task.when.getFullYear()}-${p(task.when.getMonth() + 1)}-${p(task.when.getDate())}`;
    }
    const first = taskFiles(task)[0];
    return first ? localDay(first.mtime) : "";
  }

  /** 검색어·날짜에 걸린, 지금 화면에 보이는 촬영들. */
  private visibleTasks(): CaptureSession[] {
    return this.tasks.filter((task) => this.matches(task));
  }

  private selectedTasks(): CaptureSession[] {
    return this.tasks.filter((task) => this.selected.has(task.stamp));
  }

  private render(): void {
    const tasks = this.visibleTasks();
    this.countEl.textContent = t("files_task_count", { n: tasks.length });
    this.listEl.replaceChildren();
    this.emptyEl.hidden = tasks.length > 0;
    for (const task of tasks) {
      this.listEl.appendChild(this.taskRow(task));
    }

    this.looseEl.hidden = this.loose.length === 0;
    this.looseListEl.replaceChildren();
    for (const row of this.loose) {
      this.looseListEl.appendChild(this.fileRow(row));
    }

    this.syncSelectionUi();
  }

  private taskRow(task: CaptureSession): HTMLElement {
    const li = document.createElement("li");
    li.className = "fd-task";
    const open = this.expanded.has(task.stamp);

    const head = document.createElement("div");
    head.className = "fd-task-head";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "fd-check";
    check.checked = this.selected.has(task.stamp);
    check.disabled = this.busy;
    check.setAttribute("aria-label", taskName(task));
    check.addEventListener("change", () => {
      if (check.checked) this.selected.add(task.stamp);
      else this.selected.delete(task.stamp);
      this.syncSelectionUi();
    });

    const caret = document.createElement("button");
    caret.type = "button";
    caret.className = "fd-caret";
    caret.textContent = open ? "▾" : "▸";
    caret.setAttribute("aria-expanded", open ? "true" : "false");
    caret.setAttribute("aria-label", t(open ? "files_collapse" : "files_expand"));
    caret.addEventListener("click", () => {
      if (this.expanded.has(task.stamp)) this.expanded.delete(task.stamp);
      else this.expanded.add(task.stamp);
      this.render();
    });

    const meta = document.createElement("div");
    meta.className = "fd-task-meta";

    const name = document.createElement("div");
    name.className = "fd-task-name";
    name.textContent = task.dog || t("files_unnamed");
    name.title = taskName(task);

    const sub = document.createElement("div");
    sub.className = "fd-task-sub";
    sub.textContent = [
      task.when ? formatWhen(task.when.toISOString()) : task.stamp,
      task.csv ? t("files_tag_csv") : t("files_tag_no_csv"),
      t("files_tag_videos", { n: task.videos.length }),
    ].join(" · ");
    meta.append(name, sub);

    const warn = taskWarning(task);
    if (warn) {
      li.classList.add("is-warn");
      const mark = document.createElement("span");
      mark.className = "fd-warn";
      mark.textContent = "!";
      mark.title = warn;
      meta.appendChild(mark);
    }

    const size = document.createElement("span");
    size.className = "fd-task-size";
    size.textContent = formatSize(taskSize(task));

    const zip = document.createElement("button");
    zip.type = "button";
    zip.className = "fd-icon-btn";
    zip.textContent = "⬇";
    zip.title = t("files_task_zip");
    zip.setAttribute("aria-label", `${t("files_task_zip")} ${taskName(task)}`);
    zip.disabled = this.busy;
    zip.addEventListener("click", () => void this.downloadZip([task]));

    // 행 아무 데나 눌러도 펼쳐진다. 체크박스·버튼은 각자 처리한다.
    head.addEventListener("click", (ev) => {
      const target = ev.target as Node;
      if (target === head || target === size || meta.contains(target)) caret.click();
    });

    head.append(check, caret, meta, size, zip);
    li.appendChild(head);
    if (open) {
      const files = document.createElement("ul");
      files.className = "fd-files";
      for (const row of taskFiles(task)) files.appendChild(this.fileRow(row));
      li.appendChild(files);
    }
    return li;
  }

  private fileRow(row: StoredFile): HTMLElement {
    const li = document.createElement("li");
    li.className = "fd-file";
    const isVideo = "role" in row || VIDEO_EXT_RE.test(row.name);

    const tag = document.createElement("span");
    tag.className = "fd-tag";
    tag.textContent = isVideo ? roleLabel(row.name) || t("files_role_main") : "CSV";

    const meta = document.createElement("div");
    meta.className = "fd-row-meta";
    const name = document.createElement("div");
    name.className = "fd-row-name";
    name.textContent = row.name;
    name.title = row.name;
    const sub = document.createElement("div");
    sub.className = "fd-row-sub";
    sub.textContent = [formatWhen(row.mtime), formatSize(row.size)].join(" · ");
    meta.append(name, sub);

    const link = document.createElement("a");
    link.className = "fd-icon-btn";
    link.textContent = "⬇";
    link.title = t("files_download");
    link.setAttribute("aria-label", `${t("files_download")} ${row.name}`);
    link.href = storedFileUrl(this.apiBase, row.url, true);
    link.setAttribute("download", row.name);
    link.rel = "noopener";

    li.append(tag, meta);

    if (isVideo) {
      const play = document.createElement("button");
      play.type = "button";
      play.className = "fd-icon-btn";
      play.textContent = "▶";
      play.title = t("files_play");
      play.setAttribute("aria-label", `${t("files_play")} ${row.name}`);
      // 목록에서 확인만 하면 되므로 그 자리에 붙였다 뗀다. 미리 받지는 않는다.
      play.addEventListener("click", () => {
        const playing = li.querySelector("video");
        if (playing) {
          playing.remove();
          return;
        }
        const video = document.createElement("video");
        video.className = "fd-video";
        video.controls = true;
        video.preload = "metadata";
        video.src = storedFileUrl(this.apiBase, row.url, false);
        li.appendChild(video);
        void video.play().catch(() => undefined);
      });
      li.appendChild(play);
    }
    li.appendChild(link);
    return li;
  }

  /** "모두 선택" — 지금 검색 결과로 보이는 촬영만 대상으로 한다. */
  private toggleAll(checked: boolean): void {
    for (const task of this.visibleTasks()) {
      if (checked) this.selected.add(task.stamp);
      else this.selected.delete(task.stamp);
    }
    // 다시 그리지 않고 체크 상태만 맞춘다(펼침·스크롤 유지).
    this.listEl.querySelectorAll<HTMLInputElement>("input.fd-check").forEach((el) => {
      el.checked = checked;
    });
    this.syncSelectionUi();
  }

  /** 선택 개수·용량 표시와 버튼/전체선택 체크박스 상태를 현재 선택에 맞춘다. */
  private syncSelectionUi(): void {
    const visible = this.visibleTasks();
    const visibleSelected = visible.filter((task) => this.selected.has(task.stamp)).length;
    this.allEl.disabled = visible.length === 0 || this.busy;
    this.allEl.checked = visible.length > 0 && visibleSelected === visible.length;
    this.allEl.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;

    // 검색으로 가려진 선택도 ZIP 에는 들어가므로 전체 선택 기준으로 센다.
    const picked = this.selectedTasks();
    const total = picked.reduce((sum, task) => sum + taskSize(task), 0);
    this.selEl.textContent = picked.length
      ? t("files_selected_tasks", { n: picked.length, size: formatSize(total) })
      : t("files_selected_none");
    this.zipBtn.disabled = picked.length === 0 || this.busy;
  }

  /**
   * zip 내려받기를 브라우저 기본 다운로드에 맡긴다 — 큰 zip 을 메모리에 담지 않기 위해서다.
   * 숨은 iframe 을 쓰는 이유는 서버가 오류 JSON 을 주더라도 SPA 화면이 그리로 이동하지 않게 하려는 것.
   * 매번 새로 만드는 이유는, 하나를 재사용하면 두 번째 요청이 프레임을 덮어써 먼저 시작한
   * 다운로드가 취소되기 때문이다.
   */
  private startDownload(url: string): void {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.style.display = "none";
    frame.title = "zip download";
    frame.setAttribute("aria-hidden", "true");
    frame.src = url;
    this.root.appendChild(frame);
    // 다운로드는 시작되고 나면 프레임과 무관하게 진행된다. 넉넉히 두고 치운다.
    window.setTimeout(() => frame.remove(), 120000);
  }

  /** 태스크 이름만 보낸다 — 어느 파일이 그 촬영의 것인지는 서버가 도장으로 찾는다. */
  private async downloadZip(tasks: CaptureSession[]): Promise<void> {
    if (this.busy) return;
    if (tasks.length === 0) {
      this.setStatus(t("files_zip_empty"), true);
      return;
    }
    this.busy = true;
    this.zipBtn.disabled = true;
    this.allEl.disabled = true;
    this.setStatus(t("files_zip_preparing"));
    try {
      const ticket = await createZipTicket(this.apiBase, "task", tasks.map(taskName));
      this.startDownload(zipDownloadUrl(this.apiBase, ticket.url));
      let msg = t("files_zip_started", {
        name: ticket.filename,
        n: ticket.count,
        size: formatSize(ticket.totalSize),
      });
      if (ticket.missingCount > 0) msg += ` ${t("files_zip_missing", { n: ticket.missingCount })}`;
      this.setStatus(msg);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.setStatus(`${t("files_zip_failed")}: ${detail}`, true);
    } finally {
      this.busy = false;
      this.render();
    }
  }
}

/** ISO(UTC) 시각 → 로컬 기준 `YYYY-MM-DD`. 잘못된 값은 빈 문자열. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
