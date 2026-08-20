/**
 * 완료된 분석 — 보호자에게 결과를 보여 주는 열람 전용 화면.
 *
 * 두 대의 노트북을 쓰는 것이 전제다. 한 대는 매트와 카메라에 붙어 측정을 하고,
 * 다른 한 대는 이 화면으로 방금 끝난 분석을 설명한다.
 *
 * ## 이 화면은 측정을 제어하지 않는다
 *
 * WebSocket 은 `viewer` 역할로 붙는다. 허브가 viewer 의 `record_request` 와
 * `measure_*` 를 거부하므로, 설명하던 사람이 실수로 옆 노트북의 촬영을 시작하거나
 * 끊을 수 없다. 클라이언트가 안 보내기를 믿는 구조가 아니라 서버가 막는 구조다.
 * 받는 것은 분석 완료·대기열 알림뿐이다.
 *
 * ## 배치는 측정 화면 그대로다
 *
 * 5패널(`#stage`)을 그대로 쓴다. 바뀌는 것은 오른쪽 레일뿐이라, 설명하는 사람이
 * 두 화면 사이에서 눈을 새로 맞출 필요가 없다.
 */

import { listResultDates, listResultSessions } from "../api/resultsApi.js";
import type { ResultDate, ResultSession } from "../api/resultsApi.js";
import { t } from "../i18n/index.js";

const STYLE_ID = "completed-page-style";
const RECENT_LIMIT = 5;

export interface CompletedSessionRef {
  date: string;
  displayDate: string;
  session: ResultSession;
}

export interface CompletedPageOptions {
  /** 세션을 고르면 5패널에 싣는다. */
  onPick(ref: CompletedSessionRef): void | Promise<void>;
  /** 병력 메모를 읽어 온다. */
  loadHistory(ref: CompletedSessionRef): Promise<string>;
  /** 병력 메모를 저장한다. */
  saveHistory(ref: CompletedSessionRef, text: string): Promise<void>;
}

interface Els {
  root: HTMLElement;
  list: HTMLElement;
  status: HTMLElement;
  historyBox: HTMLElement;
  historyInput: HTMLTextAreaElement;
  historySave: HTMLButtonElement;
  historyStatus: HTMLElement;
}

export class CompletedPage {
  private readonly el: Els;
  private apiBase = "";
  private recent: CompletedSessionRef[] = [];
  private selected: CompletedSessionRef | null = null;
  private loading = false;

  constructor(private readonly opts: CompletedPageOptions) {
    injectStyle();
    this.el = buildRail();
    this.bind();
    this.renderLabels();
  }

  setApiBase(url: string): void {
    this.apiBase = url.replace(/\/$/, "");
  }

  /** 언어가 바뀌면 정적 문구를 다시 그린다. */
  renderLabels(): void {
    const q = <T extends HTMLElement>(sel: string): T => this.el.root.querySelector(sel) as T;
    q(".cp-title").textContent = t("cp_title");
    q(".cp-sub").textContent = t("cp_sub");
    q(".cp-badge").textContent = t("cp_viewer_badge");
    q(".cp-history-label").textContent = t("cp_history_label");
    q(".cp-history-hint").textContent = t("cp_history_hint");
    this.el.historySave.textContent = t("cp_history_save");
    this.renderList();
  }

  /**
   * 최근 완료 분석 N건.
   *
   * 서버는 날짜별로 나눠 주므로 최신 날짜부터 거슬러 올라가며 채운다. 하루에 한 건만
   * 찍은 날이 이어져도 5건이 모인다.
   */
  async refresh(): Promise<void> {
    if (!this.apiBase || this.loading) return;
    this.loading = true;
    this.setStatus(t("cp_loading"));
    try {
      const dates = await listResultDates(this.apiBase);
      const collected: CompletedSessionRef[] = [];
      for (const date of dates) {
        if (collected.length >= RECENT_LIMIT) break;
        const page = await listResultSessions(this.apiBase, date.date);
        for (const session of page.sessions) {
          collected.push({ date: page.date, displayDate: page.displayDate, session });
          if (collected.length >= RECENT_LIMIT) break;
        }
      }
      this.recent = collected;
      this.setStatus(collected.length === 0 ? t("cp_empty") : "");
      this.renderList();
    } catch (err) {
      this.setStatus(t("cp_error", { msg: err instanceof Error ? err.message : String(err) }));
    } finally {
      this.loading = false;
    }
  }

  /**
   * 분석이 끝났다는 알림을 받았을 때. 목록 맨 위에 새 세션이 오도록 다시 읽는다.
   */
  onAnalysisDone(): void {
    void this.refresh();
  }

  get isEmpty(): boolean {
    return this.recent.length === 0;
  }

  private bind(): void {
    this.el.historySave.addEventListener("click", () => void this.persistHistory());
    // Ctrl/Cmd+Enter 로도 저장 — 설명하면서 타자 치는 흐름을 끊지 않는다.
    this.el.historyInput.addEventListener("keydown", (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter") {
        ev.preventDefault();
        void this.persistHistory();
      }
    });
  }

  private setStatus(text: string): void {
    this.el.status.textContent = text;
    this.el.status.hidden = !text;
  }

  private renderList(): void {
    this.el.list.textContent = "";
    for (const ref of this.recent) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "cp-item";
      item.classList.toggle("is-active", this.selected?.session.stem === ref.session.stem);

      // 읽는 사람 기준으로 이름 · 몸무게 · 날짜 순. 신원을 못 찾은 세션에 분석
      // 산출물 stem 을 그대로 내밀지 않는다 — 보호자에게 아무 뜻이 없다.
      const name = ref.session.dog?.name?.trim();
      const weight = ref.session.dog?.weightKg;
      const title = document.createElement("span");
      title.className = "cp-item-title";
      if (name) {
        title.textContent = weight != null ? `${name} · ${weight}kg` : name;
      } else {
        title.textContent = t("cp_unnamed");
        title.classList.add("is-unnamed");
        // 원본을 찾아야 할 때를 위해 stem 은 툴팁으로만 남긴다.
        item.title = ref.session.stem;
      }

      const when = document.createElement("span");
      when.className = "cp-item-when";
      when.textContent = `${ref.displayDate} ${ref.session.displayTime}`;

      item.append(title, when);
      item.addEventListener("click", () => void this.pick(ref));
      this.el.list.appendChild(item);
    }
  }

  private async pick(ref: CompletedSessionRef): Promise<void> {
    this.selected = ref;
    this.renderList();
    this.el.historyBox.hidden = false;
    this.el.historyStatus.textContent = "";
    this.el.historyInput.value = "";
    this.el.historyInput.disabled = true;

    await this.opts.onPick(ref);

    try {
      this.el.historyInput.value = await this.opts.loadHistory(ref);
    } catch {
      // 메모를 못 읽어도 결과 재생은 막지 않는다.
      this.el.historyInput.value = "";
    } finally {
      this.el.historyInput.disabled = false;
    }
  }

  private async persistHistory(): Promise<void> {
    const ref = this.selected;
    if (!ref) return;
    this.el.historySave.disabled = true;
    try {
      await this.opts.saveHistory(ref, this.el.historyInput.value);
      this.el.historyStatus.textContent = t("cp_history_saved");
      this.el.historyStatus.classList.remove("is-bad");
    } catch (err) {
      this.el.historyStatus.textContent = t("cp_history_failed", {
        msg: err instanceof Error ? err.message : String(err),
      });
      this.el.historyStatus.classList.add("is-bad");
    } finally {
      this.el.historySave.disabled = false;
    }
  }
}

function buildRail(): Els {
  const side = document.getElementById("side");
  if (!side) throw new Error("completed page: #side missing");

  const root = document.createElement("div");
  root.id = "completedRail";
  root.innerHTML = `
    <div class="cp-head">
      <div class="cp-title"></div>
      <span class="cp-badge"></span>
    </div>
    <p class="cp-sub"></p>
    <p class="cp-status" hidden></p>
    <div class="cp-list"></div>
    <div class="cp-history" hidden>
      <div class="cp-history-label"></div>
      <textarea class="cp-history-input" rows="5"></textarea>
      <p class="cp-history-hint"></p>
      <div class="cp-history-actions">
        <button type="button" class="cp-history-save"></button>
        <span class="cp-history-status"></span>
      </div>
    </div>
  `;
  side.appendChild(root);

  const q = <T extends HTMLElement>(sel: string): T => {
    const el = root.querySelector(sel);
    if (!el) throw new Error(`completed page: missing ${sel}`);
    return el as T;
  };
  return {
    root,
    list: q(".cp-list"),
    status: q(".cp-status"),
    historyBox: q(".cp-history"),
    historyInput: q<HTMLTextAreaElement>(".cp-history-input"),
    historySave: q<HTMLButtonElement>(".cp-history-save"),
    historyStatus: q(".cp-history-status"),
  };
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
/* 레일만 갈아 끼운다. 5패널(#stage)은 측정 화면과 같은 배치 그대로 쓴다. */
#completedRail{display:none;flex-direction:column;gap:10px;padding:12px 14px}
body[data-module="review"] #completedRail{display:flex}
body[data-module="review"] #side > *:not(#completedRail){display:none!important}
/* 측정 전용 컨트롤은 이 화면에 없어야 한다. */
body[data-module="review"] #btnSessionFloat,
body[data-module="review"] #sessionGateNoteFloat,
body[data-module="review"] #sessionOverlay{display:none!important}

.cp-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.cp-title{font:600 14px/1.3 var(--font-ui,system-ui,sans-serif);color:var(--fg,#1f2329)}
.cp-badge{font:600 11px/1.4 var(--font-ui,system-ui,sans-serif);color:var(--muted,#7c7977);
  border:1px solid var(--border-strong,#e9e5e3);border-radius:999px;padding:1px 8px}
.cp-sub{margin:0;font-size:12px;line-height:1.5;color:var(--muted,#7c7977)}
.cp-status{margin:0;font-size:12px;color:var(--muted,#7c7977)}

.cp-list{display:flex;flex-direction:column;gap:6px}
.cp-item{display:flex;flex-direction:column;gap:2px;text-align:left;cursor:pointer;
  padding:8px 10px;border:1px solid var(--border,#f3efec);border-radius:8px;
  background:var(--surface,#fff);color:inherit}
.cp-item:hover{background:var(--surface-hover,#fef4f0)}
.cp-item.is-active{border-color:var(--primary,#f0663f);
  box-shadow:inset 0 0 0 1px var(--primary,#f0663f)}
.cp-item:focus-visible{outline:2px solid var(--primary,#f0663f);outline-offset:2px}
.cp-item-title{font:600 13px/1.3 var(--font-ui,system-ui,sans-serif)}
.cp-item-title.is-unnamed{font-weight:500;color:var(--muted,#7c7977)}
.cp-item-when{font:400 11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--muted,#7c7977);font-variant-numeric:tabular-nums}

.cp-history{display:flex;flex-direction:column;gap:6px;padding-top:10px;
  border-top:1px solid var(--divider,#f6f2ef)}
.cp-history-label{font:600 12px/1.3 var(--font-ui,system-ui,sans-serif)}
.cp-history-input{width:100%;resize:vertical;padding:8px;border-radius:6px;
  border:1px solid var(--border-strong,#e9e5e3);background:var(--surface,#fff);
  color:var(--fg,#1f2329);font:400 13px/1.5 var(--font-ui,system-ui,sans-serif)}
.cp-history-input:focus-visible{outline:2px solid var(--primary,#f0663f);outline-offset:1px}
.cp-history-hint{margin:0;font-size:11px;line-height:1.4;color:var(--muted,#7c7977)}
.cp-history-actions{display:flex;align-items:center;gap:8px}
.cp-history-save{padding:5px 12px;border-radius:6px;border:1px solid var(--primary,#f0663f);
  background:var(--primary,#f0663f);color:#fff;cursor:pointer;font:600 12px/1 var(--font-ui,system-ui,sans-serif)}
.cp-history-save:disabled{opacity:.5;cursor:not-allowed}
.cp-history-save:focus-visible{outline:2px solid var(--primary,#f0663f);outline-offset:2px}
.cp-history-status{font-size:11px;color:var(--success,#1a7f37)}
.cp-history-status.is-bad{color:var(--danger,#cf222e)}
`;
  document.head.appendChild(style);
}
