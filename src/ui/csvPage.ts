/**
 * 압력 CSV **파일 단위** 다운로드 페이지.
 *
 * "파일 다운"(filesPage)은 촬영 한 건을 CSV+영상 폴더로 묶어 준다. 여기는 그 반대로,
 * 기간만 잘라 CSV 파일만 평면 목록으로 늘어놓고 전체 혹은 골라서 한 번에 ZIP 으로 받는다.
 * 분석용 로우데이터만 필요할 때 영상 수 GB 를 같이 받지 않게 하려는 것.
 *
 * 목록·ZIP·다운로드 방식은 filesPage 와 같은 API 를 쓴다(`kind: "csv"`).
 */

import { onLangChange, t } from "../i18n/index.js";
import {
  createZipTicket,
  listStoredFiles,
  storedFileUrl,
  zipDownloadUrl,
  type StoredCsvFile,
} from "../api/storedFilesApi.js";
import { csvDog, csvStamp, parseStamp } from "../core/sessionNaming.js";
import { formatSize, formatWhen, localDay } from "./filesPage.js";

/** 파일명 도장의 촬영일(`YYYY-MM-DD`). 도장이 없으면 저장 시각으로 물러선다. */
export function fileDay(row: StoredCsvFile): string {
  const stamp = csvStamp(row.name);
  const when = stamp ? parseStamp(stamp) : null;
  if (!when) return localDay(row.mtime);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())}`;
}

/** 목록에 보여줄 한 줄 요약 — 촬영 시각 · 반려견 · 용량. */
function fileSub(row: StoredCsvFile): string {
  const stamp = csvStamp(row.name);
  const when = stamp ? parseStamp(stamp) : null;
  const dog = stamp ? csvDog(row.name, stamp) : "";
  return [when ? formatWhen(when.toISOString()) : formatWhen(row.mtime), dog, formatSize(row.size)]
    .filter(Boolean)
    .join(" · ");
}

export class CsvPage {
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

  private apiBase = "";
  private files: StoredCsvFile[] = [];
  private query = "";
  /** `<input type="date">` 값(`YYYY-MM-DD`), 비어 있으면 그 방향 제한 없음. */
  private from = "";
  private to = "";
  /** 선택된 파일명. 검색·새로고침에도 유지된다. */
  private readonly selected = new Set<string>();
  private loading = false;
  private busy = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.subEl = root.querySelector("#cdSub") as HTMLElement;
    this.statusEl = root.querySelector("#cdStatus") as HTMLElement;
    this.searchEl = root.querySelector("#cdSearch") as HTMLInputElement;
    this.fromEl = root.querySelector("#cdFrom") as HTMLInputElement;
    this.toEl = root.querySelector("#cdTo") as HTMLInputElement;
    this.refreshBtn = root.querySelector("#cdRefresh") as HTMLButtonElement;
    this.allEl = root.querySelector("#cdAll") as HTMLInputElement;
    this.allLabelEl = root.querySelector("#cdAllLabel") as HTMLElement;
    this.selEl = root.querySelector("#cdSel") as HTMLElement;
    this.zipBtn = root.querySelector("#cdZip") as HTMLButtonElement;
    this.countEl = root.querySelector("#cdCount") as HTMLElement;
    this.listEl = root.querySelector("#cdList") as HTMLElement;
    this.emptyEl = root.querySelector("#cdEmpty") as HTMLElement;

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
    this.zipBtn.addEventListener("click", () => void this.downloadZip());
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
    this.subEl.textContent = t("csv_page_sub");
    this.searchEl.placeholder = t("files_search_placeholder");
    this.refreshBtn.textContent = t("btn_results_refresh");
    this.allLabelEl.textContent = t("files_select_all");
    this.zipBtn.textContent = t("csv_zip_button");
    this.emptyEl.textContent = t("csv_empty");
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
      // 최신 촬영이 위로. 도장이 없는 파일은 저장 시각으로 줄을 선다.
      this.files = [...list.csv].sort((a, b) => fileTime(b) - fileTime(a));
      // 사라진 파일은 선택도 푼다 — ZIP 요청에 유령 이름이 남지 않게.
      const alive = new Set(this.files.map((row) => row.name));
      for (const name of [...this.selected]) {
        if (!alive.has(name)) this.selected.delete(name);
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

  private visibleFiles(): StoredCsvFile[] {
    const filter = { query: this.query, from: this.from, to: this.to };
    return this.files.filter((row) => matchesCsv(row, filter));
  }

  private selectedFiles(): StoredCsvFile[] {
    return this.files.filter((row) => this.selected.has(row.name));
  }

  private render(): void {
    const rows = this.visibleFiles();
    this.countEl.textContent = t("csv_file_count", { n: rows.length });
    this.listEl.replaceChildren();
    this.emptyEl.hidden = rows.length > 0;
    for (const row of rows) this.listEl.appendChild(this.fileRow(row));
    this.syncSelectionUi();
  }

  private fileRow(row: StoredCsvFile): HTMLElement {
    const li = document.createElement("li");
    li.className = "fd-file";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "fd-check";
    check.checked = this.selected.has(row.name);
    check.disabled = this.busy;
    check.setAttribute("aria-label", row.name);
    check.addEventListener("change", () => {
      if (check.checked) this.selected.add(row.name);
      else this.selected.delete(row.name);
      this.syncSelectionUi();
    });

    const tag = document.createElement("span");
    tag.className = "fd-tag";
    tag.textContent = "CSV";

    const meta = document.createElement("div");
    meta.className = "fd-row-meta";
    const name = document.createElement("div");
    name.className = "fd-row-name";
    name.textContent = row.name;
    name.title = row.name;
    const sub = document.createElement("div");
    sub.className = "fd-row-sub";
    sub.textContent = fileSub(row);
    meta.append(name, sub);

    const link = document.createElement("a");
    link.className = "fd-icon-btn";
    link.textContent = "⬇";
    link.title = t("files_download");
    link.setAttribute("aria-label", `${t("files_download")} ${row.name}`);
    link.href = storedFileUrl(this.apiBase, row.url, true);
    link.setAttribute("download", row.name);
    link.rel = "noopener";

    li.append(check, tag, meta, link);
    return li;
  }

  /** "모두 선택" — 지금 기간·검색에 걸려 보이는 파일만 대상으로 한다. */
  private toggleAll(checked: boolean): void {
    for (const row of this.visibleFiles()) {
      if (checked) this.selected.add(row.name);
      else this.selected.delete(row.name);
    }
    this.listEl.querySelectorAll<HTMLInputElement>("input.fd-check").forEach((el) => {
      el.checked = checked;
    });
    this.syncSelectionUi();
  }

  private syncSelectionUi(): void {
    const visible = this.visibleFiles();
    const visibleSelected = visible.filter((row) => this.selected.has(row.name)).length;
    this.allEl.disabled = visible.length === 0 || this.busy;
    this.allEl.checked = visible.length > 0 && visibleSelected === visible.length;
    this.allEl.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;

    const picked = this.selectedFiles();
    const total = picked.reduce((sum, row) => sum + (Number(row.size) || 0), 0);
    this.selEl.textContent = picked.length
      ? t("csv_selected", { n: picked.length, size: formatSize(total) })
      : t("csv_selected_none");
    this.zipBtn.disabled = picked.length === 0 || this.busy;
  }

  /** filesPage 와 같은 이유로 숨은 iframe 에 맡긴다 — 큰 zip 을 메모리에 담지 않기 위해서. */
  private startDownload(url: string): void {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.style.display = "none";
    frame.title = "zip download";
    frame.setAttribute("aria-hidden", "true");
    frame.src = url;
    this.root.appendChild(frame);
    window.setTimeout(() => frame.remove(), 120000);
  }

  private async downloadZip(): Promise<void> {
    if (this.busy) return;
    const picked = this.selectedFiles();
    if (picked.length === 0) {
      this.setStatus(t("csv_zip_empty"), true);
      return;
    }
    this.busy = true;
    this.zipBtn.disabled = true;
    this.allEl.disabled = true;
    this.setStatus(t("files_zip_preparing"));
    try {
      const ticket = await createZipTicket(this.apiBase, "csv", picked.map((row) => row.name));
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

/** 검색어·기간 필터. `query` 는 소문자여야 한다(입력에서 이미 내려 둔다). */
export function matchesCsv(
  row: StoredCsvFile,
  filter: { query: string; from: string; to: string },
): boolean {
  if (filter.query && !row.name.toLowerCase().includes(filter.query)) return false;
  if (filter.from || filter.to) {
    const day = fileDay(row);
    if (!day) return false;
    if (filter.from && day < filter.from) return false;
    if (filter.to && day > filter.to) return false;
  }
  return true;
}

/** 정렬 키(ms) — 도장이 있으면 촬영 시각, 없으면 저장 시각. 둘 다 못 읽으면 맨 뒤. */
export function fileTime(row: StoredCsvFile): number {
  const stamp = csvStamp(row.name);
  const when = stamp ? parseStamp(stamp) : null;
  if (when) return when.getTime();
  const mtime = new Date(row.mtime).getTime();
  return Number.isNaN(mtime) ? 0 : mtime;
}
