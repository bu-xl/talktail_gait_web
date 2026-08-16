/**
 * 서버에 저장된 원본 CSV·영상을 내려받는 페이지.
 * 목록은 DB 가 아니라 back 디스크(`pressure_data`, `uploads`)다.
 */

import { onLangChange, t } from "../i18n/index.js";
import {
  listStoredFiles,
  storedFileUrl,
  type StoredCsvFile,
  type StoredVideoFile,
} from "../api/storedFilesApi.js";

export class FilesPage {
  private readonly root: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly searchEl: HTMLInputElement;
  private readonly csvListEl: HTMLElement;
  private readonly videoListEl: HTMLElement;
  private readonly csvCountEl: HTMLElement;
  private readonly videoCountEl: HTMLElement;
  private readonly csvEmptyEl: HTMLElement;
  private readonly videoEmptyEl: HTMLElement;
  private readonly refreshBtn: HTMLButtonElement;

  private apiBase = "";
  private csv: StoredCsvFile[] = [];
  private videos: StoredVideoFile[] = [];
  private query = "";
  private loading = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.subEl = root.querySelector("#fdSub") as HTMLElement;
    this.statusEl = root.querySelector("#fdStatus") as HTMLElement;
    this.searchEl = root.querySelector("#fdSearch") as HTMLInputElement;
    this.csvListEl = root.querySelector("#fdCsvList") as HTMLElement;
    this.videoListEl = root.querySelector("#fdVideoList") as HTMLElement;
    this.csvCountEl = root.querySelector("#fdCsvCount") as HTMLElement;
    this.videoCountEl = root.querySelector("#fdVideoCount") as HTMLElement;
    this.csvEmptyEl = root.querySelector("#fdCsvEmpty") as HTMLElement;
    this.videoEmptyEl = root.querySelector("#fdVideoEmpty") as HTMLElement;
    this.refreshBtn = root.querySelector("#fdRefresh") as HTMLButtonElement;

    this.refreshBtn.addEventListener("click", () => void this.reload());
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value.trim().toLowerCase();
      this.render();
    });
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
    this.csvEmptyEl.textContent = t("files_empty_csv");
    this.videoEmptyEl.textContent = t("files_empty_video");
    this.render();
  }

  private async reload(): Promise<void> {
    if (!this.apiBase || this.loading) return;
    this.loading = true;
    this.refreshBtn.disabled = true;
    this.csvEmptyEl.hidden = true;
    this.videoEmptyEl.hidden = true;
    this.statusEl.textContent = t("files_loading");
    this.statusEl.className = "fd-status";
    try {
      const list = await listStoredFiles(this.apiBase);
      this.csv = list.csv;
      this.videos = list.videos;
      this.statusEl.textContent = "";
      this.render();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.statusEl.textContent = `${t("files_load_failed")}: ${detail}`;
      this.statusEl.className = "fd-status is-bad";
    } finally {
      this.loading = false;
      this.refreshBtn.disabled = false;
    }
  }

  private matches(name: string): boolean {
    if (!this.query) return true;
    return name.toLowerCase().includes(this.query);
  }

  private render(): void {
    const csv = this.csv.filter((row) => this.matches(row.name));
    const videos = this.videos.filter((row) => this.matches(row.name));
    this.csvCountEl.textContent = t("files_count", { n: csv.length });
    this.videoCountEl.textContent = t("files_count", { n: videos.length });
    fillFileList(this.csvListEl, csv, {
      emptyEl: this.csvEmptyEl,
      apiBase: this.apiBase,
      roleOf: () => null,
    });
    fillFileList(this.videoListEl, videos, {
      emptyEl: this.videoEmptyEl,
      apiBase: this.apiBase,
      roleOf: (row) => ("role" in row ? String(row.role) : null),
    });
  }
}

function fillFileList(
  listEl: HTMLElement,
  rows: Array<StoredCsvFile | StoredVideoFile>,
  opts: {
    emptyEl: HTMLElement;
    apiBase: string;
    roleOf: (row: StoredCsvFile | StoredVideoFile) => string | null;
  },
): void {
  listEl.replaceChildren();
  opts.emptyEl.hidden = rows.length > 0;
  for (const row of rows) {
    listEl.appendChild(fileRow(row, opts.apiBase, opts.roleOf(row)));
  }
}

function fileRow(row: StoredCsvFile | StoredVideoFile, apiBase: string, role: string | null): HTMLElement {
  const li = document.createElement("li");
  li.className = "fd-row";

  const meta = document.createElement("div");
  meta.className = "fd-row-meta";

  const name = document.createElement("div");
  name.className = "fd-row-name";
  name.textContent = row.name;
  name.title = row.name;

  const sub = document.createElement("div");
  sub.className = "fd-row-sub";
  const bits = [formatWhen(row.mtime), formatSize(row.size)];
  if (role) bits.unshift(role === "sub" ? t("files_role_sub") : t("files_role_main"));
  sub.textContent = bits.join(" · ");

  meta.appendChild(name);
  meta.appendChild(sub);

  const link = document.createElement("a");
  link.className = "fd-download";
  link.textContent = t("files_download");
  link.href = storedFileUrl(apiBase, row.url, true);
  link.setAttribute("download", row.name);
  link.rel = "noopener";

  li.appendChild(meta);
  li.appendChild(link);
  return li;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
