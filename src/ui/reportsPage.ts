/**
 * 리포트 목록 페이지 — 저장된 모든 세션의 리포트를 한 화면에서 찾아 보고 내려받는다.
 *
 * 구조는 `파일 다운`(`filesPage`)과 같다. 검색 · 날짜 범위 · 체크박스 · 일괄 받기라는
 * 요구가 같으므로 클래스(`fd-*`)까지 그대로 쓴다.
 *
 * 다만 받는 것이 파일이 아니라 **화면에서 그린 리포트**라서 ZIP 티켓 대신
 * `printReports()`(브라우저 인쇄 → PDF)로 간다. 서버는 리포트 아티팩트를 갖고 있지 않다.
 */

import { onLangChange, t } from "../i18n/index.js";
import {
  getResultDetail,
  listResultDates,
  listResultSessions,
  type ResultSession,
} from "../api/resultsApi.js";
import { dogPrefix } from "../core/sessionNaming.js";
import { openReportModal } from "./reportModal.js";
import { printReports, type PrintableReport } from "./reportRender.js";

export interface Row {
  /** `${date}/${stem}` — 목록에서 한 리포트를 가리키는 키. */
  id: string;
  date: string;
  displayDate: string;
  session: ResultSession;
}

export function rowTitle(row: Row): string {
  const prefix = dogPrefix({
    name: row.session.dog?.name,
    weightKg: row.session.dog?.weightKg,
  });
  return prefix ? `${prefix}-${row.session.displayTime}` : row.session.displayTime;
}

export interface ReportFilter {
  /** 이미 소문자로 정규화된 검색어. 비어 있으면 이름 필터 없음. */
  query: string;
  /** `<input type="date">` 값(`YYYY-MM-DD`). 비어 있으면 그 방향 제한 없음. */
  from: string;
  to: string;
}

/**
 * 검색어와 날짜 범위를 한 줄에 적용한다. 필터는 전부 프런트에서 돈다 — 목록 응답에
 * 이미 날짜·시간·반려견 이름이 다 들어 있어서 새 API 가 필요 없다.
 */
export function matchesReport(row: Row, filter: ReportFilter): boolean {
  if (filter.query) {
    const hay = [row.session.dog?.name ?? "", rowTitle(row), row.displayDate, row.date]
      .join("\n")
      .toLowerCase();
    if (!hay.includes(filter.query)) return false;
  }
  // `date` 는 이미 `YYYY-MM-DD` 라 `<input type="date">` 값과 그대로 비교된다.
  if (filter.from && row.date < filter.from) return false;
  if (filter.to && row.date > filter.to) return false;
  return true;
}

export class ReportsPage {
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
  private readonly countEl: HTMLElement;
  private readonly printBtn: HTMLButtonElement;
  private readonly listEl: HTMLElement;
  private readonly emptyEl: HTMLElement;

  private apiBase = "";
  private rows: Row[] = [];
  private query = "";
  private from = "";
  private to = "";
  private readonly selected = new Set<string>();
  /** 한 번 받아 온 리포트 본문. 목록 로드 때는 받지 않는다. */
  private readonly previews = new Map<string, PrintableReport>();
  private loading = false;
  private busy = false;
  private loaded = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.subEl = root.querySelector("#rlSub") as HTMLElement;
    this.statusEl = root.querySelector("#rlStatus") as HTMLElement;
    this.searchEl = root.querySelector("#rlSearch") as HTMLInputElement;
    this.fromEl = root.querySelector("#rlFrom") as HTMLInputElement;
    this.toEl = root.querySelector("#rlTo") as HTMLInputElement;
    this.refreshBtn = root.querySelector("#rlRefresh") as HTMLButtonElement;
    this.allEl = root.querySelector("#rlAll") as HTMLInputElement;
    this.allLabelEl = root.querySelector("#rlAllLabel") as HTMLElement;
    this.selEl = root.querySelector("#rlSel") as HTMLElement;
    this.countEl = root.querySelector("#rlCount") as HTMLElement;
    this.printBtn = root.querySelector("#rlPrint") as HTMLButtonElement;
    this.listEl = root.querySelector("#rlList") as HTMLElement;
    this.emptyEl = root.querySelector("#rlEmpty") as HTMLElement;

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
    this.printBtn.addEventListener("click", () => void this.printSelected());
    onLangChange(() => this.syncCopy());
  }

  setApiBase(url: string): void {
    this.apiBase = url.replace(/\/$/, "");
  }

  show(): void {
    this.root.hidden = false;
    this.syncCopy();
    if (!this.loaded) void this.reload();
  }

  hide(): void {
    this.root.hidden = true;
  }

  private syncCopy(): void {
    this.subEl.textContent = t("reports_page_sub");
    this.searchEl.placeholder = t("reports_search_placeholder");
    this.refreshBtn.textContent = t("btn_results_refresh");
    this.allLabelEl.textContent = t("files_select_all");
    this.printBtn.textContent = t("reports_print_button");
    this.emptyEl.textContent = t("results_empty");
    this.render();
  }

  private setStatus(text: string, bad = false): void {
    this.statusEl.textContent = text;
    this.statusEl.className = bad ? "fd-status is-bad" : "fd-status";
  }

  /**
   * 날짜 목록을 받고 날짜마다 세션 목록을 받아 한 줄로 편다.
   *
   * ponytail: 날짜 수만큼 요청이 나간다(N+1). 날짜가 쌓여 느려지면 back 에
   * "전 기간 세션 목록" 라우트를 하나 만들고 여기만 바꾼다.
   */
  private async reload(): Promise<void> {
    if (!this.apiBase || this.loading) return;
    this.loading = true;
    this.refreshBtn.disabled = true;
    this.setStatus(t("reports_loading"));
    try {
      const dates = await listResultDates(this.apiBase);
      const perDate = await Promise.all(
        dates.map(async (d) => {
          const data = await listResultSessions(this.apiBase, d.date);
          return data.sessions.map((session) => ({
            id: `${d.date}/${session.stem}`,
            date: d.date,
            displayDate: d.displayDate,
            session,
          }));
        }),
      );
      this.rows = perDate.flat();
      const alive = new Set(this.rows.map((r) => r.id));
      for (const id of [...this.selected]) if (!alive.has(id)) this.selected.delete(id);
      this.loaded = true;
      this.setStatus("");
      this.render();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.setStatus(`${t("reports_load_failed")}: ${detail}`, true);
    } finally {
      this.loading = false;
      this.refreshBtn.disabled = false;
    }
  }

  private visibleRows(): Row[] {
    const filter: ReportFilter = { query: this.query, from: this.from, to: this.to };
    return this.rows.filter((row) => matchesReport(row, filter));
  }

  private selectedRows(): Row[] {
    return this.rows.filter((row) => this.selected.has(row.id));
  }

  private render(): void {
    const rows = this.visibleRows();
    this.countEl.textContent = t("reports_count", { n: rows.length });
    this.listEl.replaceChildren();
    this.emptyEl.hidden = rows.length > 0;
    for (const row of rows) this.listEl.appendChild(this.rowEl(row));
    this.syncSelectionUi();
  }

  private rowEl(row: Row): HTMLElement {
    const li = document.createElement("li");
    li.className = "fd-file";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "fd-check";
    check.checked = this.selected.has(row.id);
    check.disabled = this.busy;
    check.setAttribute("aria-label", rowTitle(row));
    check.addEventListener("change", () => {
      if (check.checked) this.selected.add(row.id);
      else this.selected.delete(row.id);
      this.syncSelectionUi();
    });

    const meta = document.createElement("div");
    meta.className = "fd-row-meta";
    const name = document.createElement("div");
    name.className = "fd-row-name";
    name.textContent = row.session.dog?.name || t("files_unnamed");
    const sub = document.createElement("div");
    sub.className = "fd-row-sub";
    sub.textContent = `${row.displayDate} · ${row.session.displayTime}`;
    meta.append(name, sub);

    const view = document.createElement("button");
    view.type = "button";
    view.className = "fd-icon-btn";
    view.textContent = "👁";
    view.title = t("report_open");
    view.setAttribute("aria-label", `${t("report_open")} ${rowTitle(row)}`);
    view.addEventListener("click", () => void this.viewOne(row, view));

    const down = document.createElement("button");
    down.type = "button";
    down.className = "fd-icon-btn";
    down.textContent = "⬇";
    down.title = t("reports_download_one");
    down.setAttribute("aria-label", `${t("reports_download_one")} ${rowTitle(row)}`);
    down.addEventListener("click", () => void this.printRows([row], down));

    li.append(check, meta, view, down);
    return li;
  }

  private toggleAll(checked: boolean): void {
    for (const row of this.visibleRows()) {
      if (checked) this.selected.add(row.id);
      else this.selected.delete(row.id);
    }
    this.listEl.querySelectorAll<HTMLInputElement>("input.fd-check").forEach((el) => {
      el.checked = checked;
    });
    this.syncSelectionUi();
  }

  private syncSelectionUi(): void {
    const visible = this.visibleRows();
    const visibleSelected = visible.filter((row) => this.selected.has(row.id)).length;
    this.allEl.disabled = visible.length === 0 || this.busy;
    this.allEl.checked = visible.length > 0 && visibleSelected === visible.length;
    this.allEl.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;

    const picked = this.selectedRows().length;
    this.selEl.textContent = picked
      ? t("reports_selected", { n: picked })
      : t("files_selected_none");
    this.printBtn.disabled = picked === 0 || this.busy;
  }

  /** 본문은 조회/다운로드 시점에 한 건씩 가져온다. 목록 로드 때는 받지 않는다. */
  private async loadPreview(row: Row): Promise<PrintableReport> {
    const cached = this.previews.get(row.id);
    if (cached) return cached;
    const detail = await getResultDetail(this.apiBase, row.date, row.session.stem);
    const item: PrintableReport = {
      title: rowTitle(row),
      subtitle: row.displayDate,
      preview: detail.report.derived.preview ?? null,
    };
    this.previews.set(row.id, item);
    return item;
  }

  private async viewOne(row: Row, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      openReportModal(await this.loadPreview(row));
      this.setStatus("");
    } catch (err) {
      this.setStatus(`${t("reports_load_failed")}: ${errText(err)}`, true);
    } finally {
      btn.disabled = false;
    }
  }

  private async printSelected(): Promise<void> {
    await this.printRows(this.selectedRows(), this.printBtn);
  }

  /** 여러 건이어도 인쇄는 한 번 — 리포트마다 페이지가 나뉜 PDF 한 권이 된다. */
  private async printRows(rows: Row[], btn: HTMLButtonElement): Promise<void> {
    if (this.busy || rows.length === 0) return;
    this.busy = true;
    btn.disabled = true;
    this.setStatus(t("reports_preparing", { n: rows.length }));
    try {
      const items: PrintableReport[] = [];
      for (const row of rows) items.push(await this.loadPreview(row));
      printReports(items);
      this.setStatus("");
    } catch (err) {
      this.setStatus(`${t("reports_load_failed")}: ${errText(err)}`, true);
    } finally {
      this.busy = false;
      this.render();
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
