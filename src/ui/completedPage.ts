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
/** 접힘 상태는 노트북마다 역할이 고정돼 있어 기억해 두는 편이 일관적이다. */
const COLLAPSE_KEY = "completed.railCollapsed";

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
  toggle: HTMLButtonElement;
  list: HTMLElement;
  more: HTMLButtonElement;
  status: HTMLElement;
  selectedBox: HTMLElement;
  selectedName: HTMLElement;
  selectedWhen: HTMLElement;
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
  /** 더보기를 누를 때마다 5씩 늘어난다. 커서 대신 앞부분을 다시 읽는다. */
  private limit = RECENT_LIMIT;
  private hasMore = false;

  constructor(private readonly opts: CompletedPageOptions) {
    injectStyle();
    this.el = buildRail();
    this.bind();
    this.setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
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
    q(".cp-selected-label").textContent = t("cp_selected_label");
    this.el.historySave.textContent = t("cp_history_save");
    this.el.more.textContent = t("cp_more");
    this.renderToggleLabel();
    this.renderList();
    this.renderSelected();
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
        if (collected.length >= this.limit) break;
        const page = await listResultSessions(this.apiBase, date.date);
        for (const session of page.sessions) {
          collected.push({ date: page.date, displayDate: page.displayDate, session });
          if (collected.length >= this.limit) break;
        }
      }
      this.recent = collected;
      // 요청한 만큼 채웠다면 더 있을 수 있다. 모자라면 끝에 닿은 것이다.
      this.hasMore = collected.length >= this.limit;
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

  /**
   * 완료 토스트를 눌러 들어왔을 때 그 세션을 바로 편다.
   * stem 이 없거나 목록에서 못 찾으면 가장 최근 것을 연다 — 빈 화면으로 두지 않는다.
   */
  async openStem(stem: string | null): Promise<void> {
    await this.refresh();
    const ref = (stem && this.recent.find((r) => r.session.stem === stem)) || this.recent[0];
    if (ref) await this.pick(ref);
  }

  get isEmpty(): boolean {
    return this.recent.length === 0;
  }

  private bind(): void {
    this.el.toggle.addEventListener("click", () => {
      this.setCollapsed(!this.el.root.classList.contains("is-collapsed"));
    });
    this.el.more.addEventListener("click", () => {
      this.limit += RECENT_LIMIT;
      void this.refresh();
    });
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

  private setCollapsed(collapsed: boolean): void {
    this.el.root.classList.toggle("is-collapsed", collapsed);
    this.el.toggle.setAttribute("aria-expanded", String(!collapsed));
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    this.renderToggleLabel();
  }

  private renderToggleLabel(): void {
    const collapsed = this.el.root.classList.contains("is-collapsed");
    this.el.toggle.textContent = collapsed ? "›" : "‹";
    this.el.toggle.title = t(collapsed ? "cp_expand" : "cp_collapse");
  }

  /**
   * 지금 메모가 어디에 저장되는지 보이게 한다. 목록의 이름은 "고르는" 용도,
   * 여기 이름은 "지금 여기에 쓴다"는 확인 용도라 중복이 목적이다.
   */
  private renderSelected(): void {
    const ref = this.selected;
    this.el.selectedBox.hidden = !ref;
    if (!ref) return;
    const label = dogLabel(ref);
    this.el.selectedName.textContent = label.text;
    this.el.selectedName.classList.toggle("is-unnamed", label.unnamed);
    this.el.selectedBox.title = label.unnamed ? ref.session.stem : "";
    this.el.selectedWhen.textContent = `${ref.displayDate} ${ref.session.displayTime}`;
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
      const label = dogLabel(ref);
      const title = document.createElement("span");
      title.className = "cp-item-title";
      title.textContent = label.text;
      if (label.unnamed) {
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
    this.el.more.hidden = !this.hasMore;
  }

  private async pick(ref: CompletedSessionRef): Promise<void> {
    this.selected = ref;
    this.renderList();
    this.renderSelected();
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
      <button type="button" class="cp-toggle" aria-expanded="true"></button>
    </div>
    <p class="cp-sub"></p>
    <p class="cp-status" hidden></p>
    <div class="cp-list"></div>
    <button type="button" class="cp-more" hidden></button>
    <div class="cp-selected" hidden>
      <span class="cp-selected-label"></span>
      <span class="cp-selected-name"></span>
      <span class="cp-selected-when"></span>
    </div>
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
    toggle: q<HTMLButtonElement>(".cp-toggle"),
    list: q(".cp-list"),
    more: q<HTMLButtonElement>(".cp-more"),
    status: q(".cp-status"),
    selectedBox: q(".cp-selected"),
    selectedName: q(".cp-selected-name"),
    selectedWhen: q(".cp-selected-when"),
    historyBox: q(".cp-history"),
    historyInput: q<HTMLTextAreaElement>(".cp-history-input"),
    historySave: q<HTMLButtonElement>(".cp-history-save"),
    historyStatus: q(".cp-history-status"),
  };
}

/** 목록과 선택 요약이 같은 이름을 쓰도록 한 곳에서 만든다. */
function dogLabel(ref: CompletedSessionRef): { text: string; unnamed: boolean } {
  const name = ref.session.dog?.name?.trim();
  if (!name) return { text: t("cp_unnamed"), unnamed: true };
  const weight = ref.session.dog?.weightKg;
  return { text: weight != null ? `${name} · ${weight}kg` : name, unnamed: false };
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

.cp-more{align-self:stretch;padding:6px 10px;border-radius:8px;cursor:pointer;
  border:1px dashed var(--border-strong,#e9e5e3);background:transparent;
  color:var(--muted,#7c7977);font:600 12px/1.3 var(--font-ui,system-ui,sans-serif)}
.cp-more:hover{background:var(--surface-hover,#fef4f0);color:var(--fg,#1f2329)}
.cp-more:focus-visible{outline:2px solid var(--primary,#f0663f);outline-offset:2px}

/* 선택된 카드 요약 — 목록의 하이라이트와 같은 강조색으로 한 덩어리처럼 읽히게 한다. */
.cp-selected{display:flex;flex-direction:column;gap:2px;padding:8px 10px;
  border-radius:8px;border:1px solid var(--primary,#f0663f);
  background:var(--surface-hover,#fef4f0)}
.cp-selected-label{font:600 10px/1.4 var(--font-ui,system-ui,sans-serif);
  letter-spacing:.04em;color:var(--primary,#f0663f)}
.cp-selected-name{font:700 13px/1.3 var(--font-ui,system-ui,sans-serif);color:var(--fg,#1f2329)}
.cp-selected-name.is-unnamed{font-weight:500;color:var(--muted,#7c7977)}
.cp-selected-when{font:400 11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:var(--muted,#7c7977);font-variant-numeric:tabular-nums}

/* 접힘 — 헤더의 토글만 남긴다. #side 폭은 index.html 이 정하므로 여기서 덮어쓴다. */
.cp-toggle{margin-left:auto;width:22px;height:22px;flex:0 0 auto;cursor:pointer;
  border:1px solid var(--border-strong,#e9e5e3);border-radius:6px;
  background:var(--surface,#fff);color:var(--muted,#7c7977);
  font:600 13px/1 var(--font-ui,system-ui,sans-serif);padding:0}
.cp-toggle:hover{background:var(--surface-hover,#fef4f0);color:var(--fg,#1f2329)}
.cp-toggle:focus-visible{outline:2px solid var(--primary,#f0663f);outline-offset:2px}
#completedRail.is-collapsed > *:not(.cp-head){display:none}
#completedRail.is-collapsed .cp-title,
#completedRail.is-collapsed .cp-badge{display:none}
body[data-module="review"] #side:has(#completedRail.is-collapsed){
  width:44px;flex:0 0 44px;padding:12px 6px}

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
