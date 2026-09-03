/**
 * 다중 분석 페이지 — 한 마리를 여러 번 찍은 결과를 묶어 종합 리포트(PDF)를 만든다.
 *
 * 목록의 출처가 데이터 검증 화면과 다르다. 저기는 back 디스크의 영상·CSV 파일이고,
 * 여기는 **ai-server 에서 분석이 끝난 태스크**다(back 이 `analysis_results` 로 준다).
 *
 * 뎁스는 `개 → 날짜 → 시각` 이다. 반대로 `날짜 → 개` 로 두면 한 날짜 안에서만 고를 수
 * 있는데, 종합할 촬영은 대개 여러 날에 흩어져 있다(경과 관찰).
 *
 * 화면 하나에 탭 둘 — 요청과 결과가 이어져야 흐름이 끊기지 않는다.
 */

import { onLangChange, t } from "../i18n/index.js";
import {
  listMultiDogs,
  listMultiJobs,
  listMultiSessions,
  multiPdfUrl,
  requestMultiAnalysis,
  type MultiDog,
  type MultiJob,
  type MultiSession,
} from "../api/multiApi.js";
import { MultiResultModal } from "./multiResultModal.js";

/** 진행 중 항목이 있을 때 목록을 다시 받는 주기. */
const POLL_MS = 4000;

/** 상태 → 문구 키. 템플릿 문자열로 만들면 키 오타를 타입이 못 잡는다. */
const STATE_KEY = {
  pending: "ma_state_pending",
  done: "ma_state_done",
  failed: "ma_state_failed",
} as const;

/** `대박이 · 5.2kg` — 몸무게를 모르면 이름만. */
function dogLabel(dog: { name: string; weightKg: number | null }): string {
  return dog.weightKg != null ? `${dog.name} · ${dog.weightKg}kg` : dog.name;
}

type Tab = "new" | "jobs";

export class MultiPage {
  private readonly root: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly refreshBtn: HTMLButtonElement;
  private readonly tabNewBtn: HTMLButtonElement;
  private readonly tabJobsBtn: HTMLButtonElement;
  private readonly newPane: HTMLElement;
  private readonly jobsPane: HTMLElement;

  private readonly dogWrap: HTMLElement;
  private readonly dogListEl: HTMLElement;
  private readonly dogEmptyEl: HTMLElement;

  private readonly pickPane: HTMLElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly pickDogEl: HTMLElement;
  private readonly selEl: HTMLElement;
  private readonly runBtn: HTMLButtonElement;
  private readonly sessListEl: HTMLElement;

  private readonly jobListEl: HTMLElement;
  private readonly jobEmptyEl: HTMLElement;
  private readonly resultModal: MultiResultModal;

  private apiBase = "";
  private tab: Tab = "new";
  private dogs: MultiDog[] = [];
  private picked: MultiDog | null = null;
  private sessions: MultiSession[] = [];
  /** 선택된 태스크명. 개를 바꾸면 비운다 — 다른 개의 촬영이 섞이면 안 된다. */
  private readonly selected = new Set<string>();
  private jobs: MultiJob[] = [];
  private loaded = false;
  private busy = false;
  private visible = false;
  private pollTimer: number | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    const $ = <T extends HTMLElement>(id: string): T => root.querySelector(`#${id}`) as T;
    this.subEl = $("maSub");
    this.statusEl = $("maStatus");
    this.refreshBtn = $<HTMLButtonElement>("maRefresh");
    this.tabNewBtn = $<HTMLButtonElement>("maTabNew");
    this.tabJobsBtn = $<HTMLButtonElement>("maTabJobs");
    this.newPane = $("maNew");
    this.jobsPane = $("maJobs");
    this.dogWrap = $("maDogWrap");
    this.dogListEl = $("maDogList");
    this.dogEmptyEl = $("maDogEmpty");
    this.pickPane = $("maPick");
    this.backBtn = $<HTMLButtonElement>("maBack");
    this.pickDogEl = $("maPickDog");
    this.selEl = $("maSel");
    this.runBtn = $<HTMLButtonElement>("maRun");
    this.sessListEl = $("maSessList");
    this.jobListEl = $("maJobList");
    this.jobEmptyEl = $("maJobEmpty");
    // 모달은 페이지 밖(body 직속)에 있다 — 목록의 overflow 안에 두면 잘린다.
    this.resultModal = new MultiResultModal(
      document.getElementById("maResultModal") as HTMLElement,
    );

    this.refreshBtn.addEventListener("click", () => void this.reload());
    this.tabNewBtn.addEventListener("click", () => this.setTab("new"));
    this.tabJobsBtn.addEventListener("click", () => this.setTab("jobs"));
    this.backBtn.addEventListener("click", () => this.pickDog(null));
    this.runBtn.addEventListener("click", () => void this.run());
    onLangChange(() => this.syncCopy());
  }

  setApiBase(url: string): void {
    this.apiBase = url.replace(/\/$/, "");
    this.resultModal.setApiBase(this.apiBase);
  }

  show(): void {
    this.root.hidden = false;
    this.visible = true;
    this.syncCopy();
    if (!this.loaded) void this.reload();
    else this.syncPolling();
  }

  hide(): void {
    this.root.hidden = true;
    this.visible = false;
    // 모달은 페이지 밖에 있어서 같이 숨지 않는다 — 화면을 옮겼는데 리포트만 떠 있게 된다.
    this.resultModal.close();
    this.syncPolling();
  }

  private syncCopy(): void {
    this.subEl.textContent = t("ma_sub");
    this.refreshBtn.textContent = t("btn_results_refresh");
    this.tabNewBtn.textContent = t("ma_tab_new");
    this.tabJobsBtn.textContent = t("ma_tab_jobs");
    this.backBtn.textContent = t("ma_back_to_dogs");
    this.dogEmptyEl.textContent = t("ma_dogs_empty");
    this.jobEmptyEl.textContent = t("ma_jobs_empty");
    this.render();
  }

  private setStatus(text: string, bad = false): void {
    this.statusEl.textContent = text;
    this.statusEl.className = bad ? "fd-status is-bad" : "fd-status";
  }

  private setTab(tab: Tab): void {
    this.tab = tab;
    this.tabNewBtn.classList.toggle("is-active", tab === "new");
    this.tabJobsBtn.classList.toggle("is-active", tab === "jobs");
    this.newPane.hidden = tab !== "new";
    this.jobsPane.hidden = tab !== "jobs";
  }

  private async reload(): Promise<void> {
    if (!this.apiBase) return;
    this.refreshBtn.disabled = true;
    this.setStatus(t("ma_loading"));
    try {
      const [dogs, jobs] = await Promise.all([
        listMultiDogs(this.apiBase),
        listMultiJobs(this.apiBase),
      ]);
      this.dogs = dogs;
      this.jobs = jobs;
      this.loaded = true;
      this.setStatus("");
      // 목록을 다시 받으면 고른 개가 사라졌을 수 있다(계정 전환·삭제).
      if (this.picked && !dogs.some((d) => d.key === this.picked?.key)) this.pickDog(null);
      else this.render();
      this.syncPolling();
    } catch (err) {
      this.setStatus(`${t("ma_load_failed")}: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      this.refreshBtn.disabled = false;
    }
  }

  /** 진행 중인 항목이 없으면 폴링을 멈춘다 — 빈 화면에서 4초마다 두드리지 않게. */
  private syncPolling(): void {
    const want = this.visible && this.jobs.some((j) => j.status === "pending");
    if (want && this.pollTimer == null) {
      this.pollTimer = window.setInterval(() => void this.reloadJobs(), POLL_MS);
    } else if (!want && this.pollTimer != null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async reloadJobs(): Promise<void> {
    if (!this.apiBase) return;
    try {
      this.jobs = await listMultiJobs(this.apiBase);
      this.renderJobs();
      this.syncPolling();
    } catch {
      // 폴링 실패는 조용히 넘긴다 — 다음 주기에 다시 시도한다. 화면의 목록은 그대로 둔다.
    }
  }

  // ── 개 목록 ─────────────────────────────────────────────────────────────
  private pickDog(dog: MultiDog | null): void {
    this.picked = dog;
    this.selected.clear();
    this.sessions = [];
    this.render();
    if (dog) void this.loadSessions(dog);
  }

  private async loadSessions(dog: MultiDog): Promise<void> {
    this.setStatus(t("ma_loading"));
    try {
      const sessions = await listMultiSessions(this.apiBase, dog);
      // 응답이 늦게 온 사이 다른 개를 골랐으면 버린다.
      if (this.picked?.key !== dog.key) return;
      this.sessions = sessions;
      this.setStatus("");
      this.render();
    } catch (err) {
      this.setStatus(`${t("ma_load_failed")}: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  private render(): void {
    this.setTab(this.tab);
    this.dogWrap.hidden = this.picked != null;
    this.pickPane.hidden = this.picked == null;
    this.renderDogs();
    this.renderSessions();
    this.renderJobs();
  }

  private renderDogs(): void {
    this.dogListEl.replaceChildren();
    this.dogEmptyEl.hidden = this.dogs.length > 0;
    for (const dog of this.dogs) {
      const li = document.createElement("li");
      li.className = "fd-file ma-dog";

      const meta = document.createElement("div");
      meta.className = "fd-row-meta";
      const name = document.createElement("div");
      name.className = "fd-row-name";
      name.textContent = dogLabel(dog);
      const sub = document.createElement("div");
      sub.className = "fd-row-sub";
      sub.textContent = t("ma_dog_sub", { n: dog.sessionCount, date: dog.latestDate });
      meta.append(name, sub);

      const open = document.createElement("button");
      open.type = "button";
      open.className = "fd-icon-btn";
      open.textContent = "›";
      open.setAttribute("aria-label", dogLabel(dog));

      li.append(meta, open);
      // 줄 어디를 눌러도 들어간다 — 화살표만 누르게 하면 손이 자꾸 빗나간다.
      li.addEventListener("click", () => this.pickDog(dog));
      this.dogListEl.appendChild(li);
    }
  }

  private renderSessions(): void {
    this.sessListEl.replaceChildren();
    if (!this.picked) return;
    this.pickDogEl.textContent = dogLabel(this.picked);

    let lastDate = "";
    for (const s of this.sessions) {
      if (s.date !== lastDate) {
        lastDate = s.date;
        const head = document.createElement("li");
        head.className = "ma-date";
        head.textContent = s.displayDate;
        this.sessListEl.appendChild(head);
      }

      const li = document.createElement("li");
      li.className = "fd-file";

      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "fd-check";
      check.checked = this.selected.has(s.taskName);
      check.disabled = this.busy;
      check.setAttribute("aria-label", s.taskName);
      check.addEventListener("change", () => {
        if (check.checked) this.selected.add(s.taskName);
        else this.selected.delete(s.taskName);
        this.syncSelectionUi();
      });

      const meta = document.createElement("div");
      meta.className = "fd-row-meta";
      const name = document.createElement("div");
      name.className = "fd-row-name";
      name.textContent = s.displayTime;
      const sub = document.createElement("div");
      sub.className = "fd-row-sub";
      sub.textContent = s.taskName;
      sub.title = s.taskName;
      meta.append(name, sub);

      li.append(check, meta);
      this.sessListEl.appendChild(li);
    }
    this.syncSelectionUi();
  }

  private syncSelectionUi(): void {
    const n = this.selected.size;
    this.selEl.textContent = n ? t("ma_selected", { n }) : "";
    // 종합은 2건부터 의미가 있다. 서버도 같은 값으로 막지만 버튼에서 먼저 알린다.
    this.runBtn.disabled = this.busy || n < 2;
    this.runBtn.textContent = t("ma_run");
  }

  private async run(): Promise<void> {
    if (!this.picked || this.selected.size < 2 || this.busy) return;
    this.busy = true;
    this.syncSelectionUi();
    this.setStatus(t("ma_requesting"));
    try {
      const { position } = await requestMultiAnalysis(this.apiBase, {
        name: this.picked.name,
        weightKg: this.picked.weightKg,
        taskNames: [...this.selected],
      });
      this.selected.clear();
      this.setStatus(position > 0 ? t("ma_queued", { n: position }) : t("ma_started"));
      // 요청하면 결과 탭으로 넘어간다 — 진행 중 항목이 곧바로 보여야 한다.
      this.setTab("jobs");
      await this.reload();
    } catch (err) {
      this.setStatus(`${t("ma_request_failed")}: ${err instanceof Error ? err.message : String(err)}`, true);
    } finally {
      this.busy = false;
      this.syncSelectionUi();
    }
  }

  // ── 결과 목록 ───────────────────────────────────────────────────────────
  private renderJobs(): void {
    this.jobListEl.replaceChildren();
    this.jobEmptyEl.hidden = this.jobs.length > 0;
    for (const job of this.jobs) {
      const li = document.createElement("li");
      li.className = "fd-file";

      const tag = document.createElement("span");
      tag.className = `fd-tag ma-state is-${job.status}`;
      tag.textContent = t(STATE_KEY[job.status]);

      const meta = document.createElement("div");
      meta.className = "fd-row-meta";
      const name = document.createElement("div");
      name.className = "fd-row-name";
      name.textContent = dogLabel({ name: job.dogName || "-", weightKg: job.dogWeightKg });
      const sub = document.createElement("div");
      sub.className = "fd-row-sub";
      sub.textContent =
        job.status === "failed" && job.error
          ? job.error
          : t("ma_job_sub", {
              n: job.taskNames.length,
              when: new Date(job.createdAt).toLocaleString(),
            });
      sub.title = job.taskNames.join("\n");
      meta.append(name, sub);

      li.append(tag, meta);

      const href = multiPdfUrl(this.apiBase, job);
      if (href) {
        const open = document.createElement("button");
        open.type = "button";
        open.className = "fd-icon-btn";
        open.textContent = t("ma_job_open");
        open.addEventListener("click", () => this.resultModal.open(job, href));
        li.append(open);
      }
      this.jobListEl.appendChild(li);
    }
  }
}
