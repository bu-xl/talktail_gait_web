/**
 * 서버에 저장된 원본을 **촬영 한 건(태스크) 단위**로 내려받는 페이지.
 * 목록은 DB 가 아니라 back 디스크(`pressure_data`, `uploads`)다.
 *
 * 파일을 CSV 열·영상 열로 늘어놓으면 sub 카메라 수가 촬영마다 달라서 어떤 파일이
 * 어느 촬영의 것인지 사람이 맞춰야 한다. 그래서 파일명 도장으로 되묶어
 * (서버가 폴더로 묶어 준다 — `/api/files` 의 `tasks`) 태스크 한 줄로 보여주고,
 * ZIP 도 태스크 폴더 안에 그 촬영의 CSV + 영상이 함께 들어가게 받는다.
 *
 * 체크박스는 태스크에만 있다. "여러 개 골라 묶기"는 체크박스, "이거 하나만"은 ⬇ 로
 * 역할이 갈린다 — 파일 단위 체크박스까지 두면 부분 선택된 태스크의 폴더 구조가 애매해진다.
 *
 * ★ 이 클래스가 화면 **둘**을 굴린다 — `mode: "download"` 는 "파일 다운",
 *   `mode: "delete"` 는 마스터 전용 "파일 삭제". 목록·검색·묶기가 완전히 같아서
 *   복제하면 한쪽만 고치는 사고가 난다. 갈리는 것은 행의 동작뿐이다:
 *   받기 화면에는 ⬇ 와 ZIP 만, 지우기 화면에는 🗑 만 둔다.
 */

import { onLangChange, t } from "../i18n/index.js";
import { listUsers } from "../api/authApi.js";
import {
  createZipTicket,
  deleteStoredFiles,
  listStoredFiles,
  storedFileUrl,
  zipDownloadUrl,
  type StoredCsvFile,
  type StoredVideoFile,
} from "../api/storedFilesApi.js";
import type { StoredTask } from "../api/storedFilesApi.js";
import { parseStamp, roleOrder } from "../core/sessionNaming.js";

/** 받는 화면이냐 지우는 화면이냐. 목록은 같고 행의 동작만 갈린다. */
export type FilesMode = "download" | "delete";

/** 전 계정 보기. 서버는 이 값을 조회에서만 받는다(지우기는 계정 하나씩). */
const ALL_ACCOUNTS = "*";

type StoredFile = StoredCsvFile | StoredVideoFile;

/**
 * 화면이 다루는 태스크 한 건 — **서버가 묶어 준 폴더**에 그 안의 파일을 붙인 것.
 *
 * 예전에는 화면이 파일명을 파싱해 도장으로 되묶었다(`groupSessions`). 이름이 규칙에서
 * 벗어난 파일은 조용히 빠졌고, 같은 초에 찍은 남의 파일이 한 줄로 합쳐지기도 했다.
 * 폴더가 곧 촬영이 되면서 그 파싱이 통째로 사라졌다.
 */
type TaskView = StoredTask & {
  csv: StoredCsvFile | null;
  videos: StoredVideoFile[];
  when: Date | null;
};

/** 태스크 한 건의 파일들. 목록·용량 계산이 전부 이걸 쓴다. */
function taskFiles(task: TaskView): StoredFile[] {
  return task.csv ? [task.csv, ...task.videos] : [...task.videos];
}

function taskSize(task: TaskView): number {
  return taskFiles(task).reduce((sum, row) => sum + (Number(row.size) || 0), 0);
}

/** 이 촬영에 빠진 게 있으면 사유. 없으면 null. */
function taskWarning(task: TaskView): string | null {
  if (!task.csv) return t("files_tag_no_csv");
  if (task.videos.length === 0) return t("files_tag_no_video");
  return null;
}

/** 표시용 개 이름. 파일명이 아니라 **`dogs` 조인**에서 온다(§3-9). */
function taskDogLabel(task: TaskView): string {
  const name = task.dog?.name;
  if (!name) return `#${task.dogId}`;
  const weight = task.dog?.weightKg;
  return weight != null ? `${name} · ${weight}kg` : name;
}

function roleLabel(name: string): string {
  const order = roleOrder(name);
  if (order === 999) return "";
  return order === 0 ? t("files_role_main") : `${t("files_role_sub")}${order}`;
}

const VIDEO_EXT_RE = /\.(mp4|mov|m4v|avi|webm)$/i;

/** 영상이면 `role` 이 있다. 확장자는 목록이 role 을 안 준 옛 파일용 보루. */
function isVideoRow(row: StoredFile): row is StoredVideoFile {
  return "role" in row || VIDEO_EXT_RE.test(row.name);
}

export class FilesPage {
  private readonly mode: FilesMode;
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
  /** 마스터 전용 계정 필터. 일반 계정 화면에는 아예 없다. */
  private readonly acctEl: HTMLSelectElement | null;

  private apiBase = "";
  /** 지금 보고 있는 계정. `"*"` 는 전 계정, `""` 는 내 계정(헤더 스코프를 따름). */
  private acct = "";
  private acctLoaded = false;
  private tasks: TaskView[] = [];
  /**
   * 폴더 밖에 남은 파일 — **구조적으로 생길 수 없다.**
   *
   * 예전에는 도장을 못 읽어 안 묶인 파일이 있었고, 안 보여 주면 없는 파일이 되어 버렸다.
   * 지금은 모든 파일이 회차 폴더 안에 있다. 화면은 남겨 두되 항상 비어 있다.
   */
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

  constructor(root: HTMLElement, mode: FilesMode = "download") {
    this.root = root;
    this.mode = mode;
    // 화면이 둘이라 id 로는 못 고른다. 같은 마크업을 두 벌 두고 `data-fd` 로 찾는다.
    const pick = <T extends HTMLElement>(key: string): T =>
      root.querySelector(`[data-fd="${key}"]`) as T;
    this.subEl = pick("sub");
    this.statusEl = pick("status");
    this.searchEl = pick<HTMLInputElement>("search");
    this.fromEl = pick<HTMLInputElement>("from");
    this.toEl = pick<HTMLInputElement>("to");
    this.refreshBtn = pick<HTMLButtonElement>("refresh");
    this.allEl = pick<HTMLInputElement>("all");
    this.allLabelEl = pick("allLabel");
    this.selEl = pick("sel");
    this.zipBtn = pick<HTMLButtonElement>("zip");
    this.countEl = pick("count");
    this.listEl = pick("list");
    this.emptyEl = pick("empty");
    this.looseEl = pick("loose");
    this.looseHeadEl = pick("looseHeading");
    this.looseHintEl = pick("looseHint");
    this.looseListEl = pick("looseList");
    this.acctEl = root.querySelector('[data-fd="acct"]');
    this.acctEl?.addEventListener("change", () => {
      this.acct = this.acctEl?.value || "";
      // 계정이 바뀌면 목록이 통째로 갈린다 — 남은 선택은 유령이 된다.
      this.selected.clear();
      void this.reload();
    });

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
    this.zipBtn.addEventListener("click", () => {
      if (this.mode === "delete") void this.deleteTasks(this.selectedTasks());
      else void this.downloadZip(this.selectedTasks());
    });
    onLangChange(() => this.syncCopy());
  }

  setApiBase(base: string): void {
    this.apiBase = base;
  }

  show(): void {
    this.root.hidden = false;
    this.syncCopy();
    void this.loadAccounts();
    void this.reload();
  }

  /**
   * 계정 목록을 한 번만 채운다. 마스터가 아니면 셀렉트가 화면에 없고(`master-only`),
   * 그때는 계정을 안 붙여 헤더의 조회 스코프를 그대로 따른다.
   */
  private async loadAccounts(): Promise<void> {
    if (!this.acctEl || this.acctLoaded || !this.apiBase) return;
    if (document.body.dataset.role !== "master") return;
    this.acctLoaded = true;
    try {
      const users = await listUsers(this.apiBase);
      this.acctEl.replaceChildren();
      const all = document.createElement("option");
      all.value = ALL_ACCOUNTS;
      all.textContent = t("files_acct_all");
      this.acctEl.append(all);
      for (const u of users) {
        const opt = document.createElement("option");
        opt.value = u.id;
        opt.textContent = u.id;
        this.acctEl.append(opt);
      }
      this.acctEl.value = this.acct || ALL_ACCOUNTS;
      this.acct = this.acctEl.value;
      void this.reload();
    } catch {
      // 계정 목록을 못 받아도 화면은 산다 — 내 계정 것만 보인다.
      this.acctLoaded = false;
    }
  }

  hide(): void {
    this.root.hidden = true;
  }

  private syncCopy(): void {
    const del = this.mode === "delete";
    this.subEl.textContent = t(del ? "purge_page_sub" : "files_page_sub");
    this.searchEl.placeholder = t("files_search_placeholder");
    this.refreshBtn.textContent = t("btn_results_refresh");
    this.allLabelEl.textContent = t("files_select_all");
    this.zipBtn.textContent = t(del ? "purge_button" : "files_zip_button");
    this.emptyEl.textContent = t("files_empty_tasks");
    this.looseHeadEl.textContent = t("files_ungrouped_heading");
    this.looseHintEl.textContent = t(
      this.mode === "delete" ? "purge_ungrouped_hint" : "files_ungrouped_hint",
    );
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
      const list = await listStoredFiles(this.apiBase, this.acct || undefined);
      // 폴더 키로 파일을 태스크에 꽂는다. 묶는 규칙은 서버에 있고 여기는 배치만 한다.
      const byKey = new Map<string, TaskView>();
      for (const task of list.tasks) {
        byKey.set(task.key, {
          ...task,
          csv: null,
          videos: [],
          when: parseStamp(task.stamp),
        });
      }
      for (const row of list.csv) {
        const task = byKey.get(`${row.dogId}/${row.stamp}`);
        if (task && !task.csv) task.csv = row;
      }
      for (const row of list.videos) {
        byKey.get(`${row.dogId}/${row.stamp}`)?.videos.push(row);
      }
      for (const task of byKey.values()) {
        task.videos.sort((a, b) => roleOrder(a.name) - roleOrder(b.name));
      }
      this.tasks = [...byKey.values()];
      this.loose = [];
      // 목록에서 사라진 촬영은 선택도 풀어야 ZIP·삭제 요청에 유령 이름이 남지 않는다.
      const alive = new Set(this.tasks.map((task) => task.key));
      for (const key of [...this.selected]) {
        if (!alive.has(key)) this.selected.delete(key);
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
  private matches(task: TaskView): boolean {
    if (this.query) {
      const hay = [task.userId ?? "", task.taskName, taskDogLabel(task), ...taskFiles(task).map((row) => row.name)]
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
  private taskDay(task: TaskView): string {
    if (task.when) {
      const p = (n: number): string => String(n).padStart(2, "0");
      return `${task.when.getFullYear()}-${p(task.when.getMonth() + 1)}-${p(task.when.getDate())}`;
    }
    const first = taskFiles(task)[0];
    return first ? localDay(first.mtime) : "";
  }

  /** 검색어·날짜에 걸린, 지금 화면에 보이는 촬영들. */
  private visibleTasks(): TaskView[] {
    return this.tasks.filter((task) => this.matches(task));
  }

  private selectedTasks(): TaskView[] {
    return this.tasks.filter((task) => this.selected.has(task.key));
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
      this.looseListEl.appendChild(this.fileRow(row, true));
    }

    this.syncSelectionUi();
  }

  private taskRow(task: TaskView): HTMLElement {
    const key = task.key;
    const li = document.createElement("li");
    li.className = "fd-task";
    const open = this.expanded.has(key);

    const head = document.createElement("div");
    head.className = "fd-task-head";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "fd-check";
    check.checked = this.selected.has(key);
    check.disabled = this.busy;
    check.setAttribute("aria-label", task.taskName);
    check.addEventListener("change", () => {
      if (check.checked) this.selected.add(key);
      else this.selected.delete(key);
      this.syncSelectionUi();
    });

    const caret = document.createElement("button");
    caret.type = "button";
    caret.className = "fd-caret";
    caret.textContent = open ? "▾" : "▸";
    caret.setAttribute("aria-expanded", open ? "true" : "false");
    caret.setAttribute("aria-label", t(open ? "files_collapse" : "files_expand"));
    caret.addEventListener("click", () => {
      if (this.expanded.has(key)) this.expanded.delete(key);
      else this.expanded.add(key);
      this.render();
    });

    const meta = document.createElement("div");
    meta.className = "fd-task-meta";

    const name = document.createElement("div");
    name.className = "fd-task-name";
    name.textContent = taskDogLabel(task);
    name.title = task.taskName;

    const sub = document.createElement("div");
    sub.className = "fd-task-sub";
    sub.textContent = [
      // 어느 계정에서 찍은 촬영인지. 전 계정 목록에서만 값이 있다.
      task.userId ? t("files_tag_account", { id: task.userId }) : "",
      task.when ? formatWhen(task.when.toISOString()) : task.stamp,
      task.csv ? t("files_tag_csv") : t("files_tag_no_csv"),
      t("files_tag_videos", { n: task.videos.length }),
    ]
      .filter(Boolean)
      .join(" · ");
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

    const del = this.mode === "delete";
    const zip = document.createElement("button");
    zip.type = "button";
    zip.className = del ? "fd-icon-btn is-danger" : "fd-icon-btn";
    zip.textContent = del ? "🗑" : "⬇";
    zip.title = t(del ? "purge_task" : "files_task_zip");
    zip.setAttribute("aria-label", `${zip.title} ${task.taskName}`);
    zip.disabled = this.busy;
    zip.addEventListener("click", () => {
      if (del) void this.deleteTasks([task]);
      else void this.downloadZip([task]);
    });

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

  private fileRow(row: StoredFile, loose = false): HTMLElement {
    const li = document.createElement("li");
    li.className = "fd-file";
    const isVideo = isVideoRow(row);

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
    // 촬영으로 묶이지 않은 파일은 태스크 체크박스가 못 잡는다. 용량을 비우려면
    // 이것들이야말로 지워야 하므로 여기서만 파일 단위 🗑 을 둔다.
    if (loose && this.mode === "delete") {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "fd-icon-btn is-danger";
      del.textContent = "🗑";
      del.title = t("purge_task");
      del.setAttribute("aria-label", `${t("purge_task")} ${row.name}`);
      del.disabled = this.busy;
      del.addEventListener("click", () => void this.deleteLoose(row));
      li.appendChild(del);
    }
    // 지우기 화면에는 받기가 없다. 지우기 전에 확인할 수 있게 ▶ 재생만 남긴다.
    if (this.mode !== "delete") {
      const link = document.createElement("a");
      link.className = "fd-icon-btn";
      link.textContent = "⬇";
      link.title = t("files_download");
      link.setAttribute("aria-label", `${t("files_download")} ${row.name}`);
      link.href = storedFileUrl(this.apiBase, row.url, true);
      link.setAttribute("download", row.name);
      link.rel = "noopener";
      li.appendChild(link);
    }
    return li;
  }

  /** "모두 선택" — 지금 검색 결과로 보이는 촬영만 대상으로 한다. */
  private toggleAll(checked: boolean): void {
    for (const task of this.visibleTasks()) {
      if (checked) this.selected.add(task.key);
      else this.selected.delete(task.key);
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
    const visibleSelected = visible.filter((task) => this.selected.has(task.key)).length;
    this.allEl.disabled = visible.length === 0 || this.busy;
    this.allEl.checked = visible.length > 0 && visibleSelected === visible.length;
    this.allEl.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;

    // 검색으로 가려진 선택도 ZIP 에는 들어가므로 전체 선택 기준으로 센다.
    const picked = this.selectedTasks();
    const total = picked.reduce((sum, task) => sum + taskSize(task), 0);
    this.selEl.textContent = picked.length
      ? t("files_selected_tasks", { n: picked.length, size: formatSize(total) })
      : t("files_selected_none");
    this.zipBtn.classList.toggle("is-danger", this.mode === "delete");
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

  /**
   * 고른 촬영의 원본을 서버에서 지운다. **되돌릴 수 없다.**
   *
   * 계정별로 갈라서 보낸다 — 서버의 삭제 경로는 한 번에 계정 하나만 받는다
   * (`targetAccount`). 같은 도장을 가진 남의 파일이 딸려가는 사고를 그 구조가 막는다.
   * 분석 산출물과 DB 행은 남는다. 여기서 지우는 것은 back 디스크의 원본뿐이다.
   */
  private async deleteTasks(tasks: TaskView[]): Promise<void> {
    if (this.busy) return;
    if (tasks.length === 0) {
      this.setStatus(t("purge_empty"), true);
      return;
    }
    const total = tasks.reduce((sum, task) => sum + taskSize(task), 0);
    if (!window.confirm(t("purge_confirm", { n: tasks.length, size: formatSize(total) }))) return;
    await this.sendDelete(tasks.flatMap(taskFiles), total);
  }

  /** 도장이 없어 촬영으로 묶이지 않은 파일 하나. 여기서만 파일 단위로 지운다. */
  private async deleteLoose(row: StoredFile): Promise<void> {
    if (this.busy) return;
    if (!window.confirm(t("purge_confirm_files", { n: 1, size: formatSize(row.size) }))) return;
    await this.sendDelete([row], row.size);
  }

  /**
   * 실제 삭제 요청. **계정별로 갈라서 보낸다** — 서버의 삭제 경로는 한 번에 계정
   * 하나만 받는다(`targetAccount`). 같은 도장을 가진 남의 파일이 딸려가는 사고를
   * 그 구조가 막는다.
   */
  private async sendDelete(rows: StoredFile[], totalSize: number): Promise<void> {
    if (this.busy || rows.length === 0) return;
    this.busy = true;
    this.zipBtn.disabled = true;
    this.allEl.disabled = true;
    this.setStatus(t("purge_running"));
    try {
      const byAccount = new Map<string, StoredFile[]>();
      for (const row of rows) {
        const key = row.userId || "";
        const list = byAccount.get(key) ?? [];
        list.push(row);
        byAccount.set(key, list);
      }
      let deleted = 0;
      let failed = 0;
      for (const [userId, group] of byAccount) {
        // 키가 곧 서버의 폴더 경로다 — 화면이 경로를 조립하지 않는다.
        const keys = group.map((row) => row.key);
        if (keys.length === 0) continue;
        const result = await deleteStoredFiles(this.apiBase, keys, userId || undefined);
        deleted += result.deleted.length;
        failed += result.failed.length;
      }
      this.selected.clear();
      const done = t("purge_done", { n: deleted, size: formatSize(totalSize) });
      this.setStatus(failed > 0 ? `${done} ${t("purge_failed_n", { n: failed })}` : done, failed > 0);
      await this.reload();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.setStatus(`${t("purge_failed")}: ${detail}`, true);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  /** 태스크 이름만 보낸다 — 어느 파일이 그 촬영의 것인지는 서버가 도장으로 찾는다. */
  private async downloadZip(tasks: TaskView[]): Promise<void> {
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
      const ticket = await createZipTicket(this.apiBase, "task", tasks.map((task) => task.key));
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

export function formatWhen(iso: string): string {
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
