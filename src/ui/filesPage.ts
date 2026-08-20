/**
 * 서버에 저장된 원본 CSV·영상을 내려받는 페이지.
 * 목록은 DB 가 아니라 back 디스크(`pressure_data`, `uploads`)다.
 *
 * 파일이 많아 하나씩 받기 힘들어서 체크박스 선택 → ZIP 묶음 받기를 지원한다.
 * ZIP 은 CSV 와 영상을 섞지 않고 컬럼별로 따로 만든다.
 */

import { onLangChange, t } from "../i18n/index.js";
import {
  createZipTicket,
  listStoredFiles,
  storedFileUrl,
  zipDownloadUrl,
  type StoredCsvFile,
  type StoredVideoFile,
  type ZipKind,
} from "../api/storedFilesApi.js";

type StoredFile = StoredCsvFile | StoredVideoFile;

/** 컬럼 하나(=CSV 또는 영상)의 DOM 과 선택 상태. */
type Column = {
  kind: ZipKind;
  listEl: HTMLElement;
  countEl: HTMLElement;
  emptyEl: HTMLElement;
  allEl: HTMLInputElement;
  allLabelEl: HTMLElement;
  selEl: HTMLElement;
  zipBtn: HTMLButtonElement;
  /** 선택된 파일 키(csv=파일명, 영상=`role/파일명`). 검색·새로고침에도 유지된다. */
  selected: Set<string>;
  busy: boolean;
};

/** ZIP 요청에 쓰는 키. 영상은 main/sub 에 같은 이름이 있을 수 있어 role 을 붙인다. */
function fileKey(kind: ZipKind, row: StoredFile): string {
  if (kind === "csv") return row.name;
  const role = "role" in row ? String(row.role) : "main";
  return `${role}/${row.name}`;
}

export class FilesPage {
  private readonly root: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly searchEl: HTMLInputElement;
  private readonly refreshBtn: HTMLButtonElement;
  private readonly csvCol: Column;
  private readonly videoCol: Column;

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
    this.refreshBtn = root.querySelector("#fdRefresh") as HTMLButtonElement;

    this.csvCol = {
      kind: "csv",
      listEl: root.querySelector("#fdCsvList") as HTMLElement,
      countEl: root.querySelector("#fdCsvCount") as HTMLElement,
      emptyEl: root.querySelector("#fdCsvEmpty") as HTMLElement,
      allEl: root.querySelector("#fdCsvAll") as HTMLInputElement,
      allLabelEl: root.querySelector("#fdCsvAllLabel") as HTMLElement,
      selEl: root.querySelector("#fdCsvSel") as HTMLElement,
      zipBtn: root.querySelector("#fdCsvZip") as HTMLButtonElement,
      selected: new Set<string>(),
      busy: false,
    };
    this.videoCol = {
      kind: "video",
      listEl: root.querySelector("#fdVideoList") as HTMLElement,
      countEl: root.querySelector("#fdVideoCount") as HTMLElement,
      emptyEl: root.querySelector("#fdVideoEmpty") as HTMLElement,
      allEl: root.querySelector("#fdVideoAll") as HTMLInputElement,
      allLabelEl: root.querySelector("#fdVideoAllLabel") as HTMLElement,
      selEl: root.querySelector("#fdVideoSel") as HTMLElement,
      zipBtn: root.querySelector("#fdVideoZip") as HTMLButtonElement,
      selected: new Set<string>(),
      busy: false,
    };

    this.refreshBtn.addEventListener("click", () => void this.reload());
    this.searchEl.addEventListener("input", () => {
      this.query = this.searchEl.value.trim().toLowerCase();
      this.render();
    });
    for (const col of [this.csvCol, this.videoCol]) {
      col.allEl.addEventListener("change", () => this.toggleAll(col, col.allEl.checked));
      col.zipBtn.addEventListener("click", () => void this.downloadZip(col));
    }
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
    this.syncEmptyText();
    for (const col of [this.csvCol, this.videoCol]) {
      col.allLabelEl.textContent = t("files_select_all");
      col.zipBtn.textContent = t("files_zip_button");
    }
    this.render();
  }

  private syncEmptyText(): void {
    this.csvCol.emptyEl.textContent = t("files_empty_csv");
    this.videoCol.emptyEl.textContent = t("files_empty_video");
  }

  private setStatus(text: string, bad = false): void {
    this.statusEl.textContent = text;
    this.statusEl.className = bad ? "fd-status is-bad" : "fd-status";
  }

  private async reload(): Promise<void> {
    if (!this.apiBase || this.loading) return;
    this.loading = true;
    this.refreshBtn.disabled = true;
    this.csvCol.emptyEl.hidden = true;
    this.videoCol.emptyEl.hidden = true;
    this.setStatus(t("files_loading"));
    try {
      const list = await listStoredFiles(this.apiBase);
      this.csv = list.csv;
      this.videos = list.videos;
      // 목록에서 사라진 파일은 선택도 풀어야 ZIP 요청에 유령 이름이 남지 않는다.
      this.pruneSelection(this.csvCol);
      this.pruneSelection(this.videoCol);
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

  private rowsOf(col: Column): StoredFile[] {
    return col.kind === "csv" ? this.csv : this.videos;
  }

  private pruneSelection(col: Column): void {
    const alive = new Set(this.rowsOf(col).map((row) => fileKey(col.kind, row)));
    for (const key of [...col.selected]) {
      if (!alive.has(key)) col.selected.delete(key);
    }
  }

  private matches(name: string): boolean {
    if (!this.query) return true;
    return name.toLowerCase().includes(this.query);
  }

  /** 검색어에 걸린, 지금 화면에 보이는 행들. */
  private visibleRows(col: Column): StoredFile[] {
    return this.rowsOf(col).filter((row) => this.matches(row.name));
  }

  private render(): void {
    for (const col of [this.csvCol, this.videoCol]) {
      const rows = this.visibleRows(col);
      col.countEl.textContent = t("files_count", { n: rows.length });
      col.listEl.replaceChildren();
      col.emptyEl.hidden = rows.length > 0;
      for (const row of rows) {
        col.listEl.appendChild(this.fileRow(col, row));
      }
      this.syncSelectionUi(col);
    }
  }

  private fileRow(col: Column, row: StoredFile): HTMLElement {
    const key = fileKey(col.kind, row);
    const li = document.createElement("li");
    li.className = "fd-row";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "fd-check";
    check.checked = col.selected.has(key);
    check.dataset.key = key;
    check.setAttribute("aria-label", row.name);
    check.addEventListener("change", () => {
      if (check.checked) col.selected.add(key);
      else col.selected.delete(key);
      this.syncSelectionUi(col);
    });

    const meta = document.createElement("div");
    meta.className = "fd-row-meta";

    const name = document.createElement("div");
    name.className = "fd-row-name";
    name.textContent = row.name;
    name.title = row.name;

    const sub = document.createElement("div");
    sub.className = "fd-row-sub";
    const role = "role" in row ? String(row.role) : null;
    const bits = [formatWhen(row.mtime), formatSize(row.size)];
    if (role) bits.unshift(role === "sub" ? t("files_role_sub") : t("files_role_main"));
    sub.textContent = bits.join(" · ");

    meta.appendChild(name);
    meta.appendChild(sub);

    const link = document.createElement("a");
    link.className = "fd-download";
    link.textContent = t("files_download");
    link.href = storedFileUrl(this.apiBase, row.url, true);
    link.setAttribute("download", row.name);
    link.rel = "noopener";

    li.appendChild(check);
    li.appendChild(meta);
    li.appendChild(link);
    return li;
  }

  /** "모두 선택" — 지금 검색 결과로 보이는 행만 대상으로 한다. */
  private toggleAll(col: Column, checked: boolean): void {
    for (const row of this.visibleRows(col)) {
      const key = fileKey(col.kind, row);
      if (checked) col.selected.add(key);
      else col.selected.delete(key);
    }
    // 다시 그리지 않고 체크 상태만 맞춘다(스크롤 위치 유지).
    col.listEl.querySelectorAll<HTMLInputElement>("input.fd-check").forEach((el) => {
      el.checked = checked;
    });
    this.syncSelectionUi(col);
  }

  /** 선택 개수·용량 표시와 버튼/전체선택 체크박스 상태를 현재 선택에 맞춘다. */
  private syncSelectionUi(col: Column): void {
    const visible = this.visibleRows(col);
    const visibleSelected = visible.filter((row) => col.selected.has(fileKey(col.kind, row))).length;
    col.allEl.disabled = visible.length === 0 || col.busy;
    col.allEl.checked = visible.length > 0 && visibleSelected === visible.length;
    col.allEl.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;

    // 검색으로 가려진 선택도 ZIP 에는 들어가므로 전체 선택 기준으로 센다.
    const picked = this.selectedRows(col);
    const total = picked.reduce((sum, row) => sum + (Number(row.size) || 0), 0);
    col.selEl.textContent = picked.length
      ? t("files_selected", { n: picked.length, size: formatSize(total) })
      : t("files_selected_none");
    col.zipBtn.disabled = picked.length === 0 || col.busy;
  }

  /** 선택된 행을 목록 순서(최신순)대로. */
  private selectedRows(col: Column): StoredFile[] {
    return this.rowsOf(col).filter((row) => col.selected.has(fileKey(col.kind, row)));
  }

  /**
   * zip 내려받기를 브라우저 기본 다운로드에 맡긴다 — 큰 zip 을 메모리에 담지 않기 위해서다.
   * 숨은 iframe 을 쓰는 이유는 서버가 오류 JSON 을 주더라도 SPA 화면이 그리로 이동하지 않게 하려는 것.
   * 매번 새로 만드는 이유는, 하나를 재사용하면 CSV 를 누르자마자 영상을 누를 때
   * 두 번째 요청이 프레임을 덮어써 먼저 시작한 다운로드가 취소되기 때문이다.
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

  private async downloadZip(col: Column): Promise<void> {
    if (col.busy) return;
    const files = this.selectedRows(col).map((row) => fileKey(col.kind, row));
    if (files.length === 0) {
      this.setStatus(t("files_zip_empty"), true);
      return;
    }
    col.busy = true;
    col.zipBtn.disabled = true;
    col.allEl.disabled = true;
    this.setStatus(t("files_zip_preparing"));
    try {
      const ticket = await createZipTicket(this.apiBase, col.kind, files);
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
      col.busy = false;
      this.syncSelectionUi(col);
    }
  }
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
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
