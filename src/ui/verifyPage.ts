/**
 * 데이터 검증 — 촬영 한 번(=테스트 한 번)에 뭐가 저장됐는지 현장에서 바로 확인하는 화면.
 *
 * "파일 다운" 은 디스크에 있는 파일을 통째로 늘어놓는다. 그런데 실제 단위는 파일이
 * 아니라 **촬영 한 번**이고, 한 번에 CSV 1개 + 영상 N개가 나온다. 업로드는 카메라마다
 * 제각각 도착하므로 목록 순서도 촬영 순서와 어긋난다. 그래서 여기서는 파일을
 * **도장(stamp)** 으로 되묶어 테스트 단위로 보여준다.
 *
 * 도장은 back 의 `captureSessions.js` 가 sync_start 때 한 번만 찍고 그 세션의 모든
 * 파일명 꼬리에 들어간다(`…-main-260820-150920.mp4`, `…-260820-150920.csv`).
 * 즉 **파일명이 이미 세션 키**라서 서버에 세션 표를 따로 두지 않아도 묶인다.
 *
 * CSV 는 로우데이터라 열어봐야 알 수 없으므로 몇 초치가 쌓였는지만 보여주고
 * (`fetchCsvSpan` — 앞뒤 조각만 Range 로 읽는다), 영상은 그 자리에서 재생한다.
 * 영상 길이와 CSV 길이가 크게 어긋나면 그 자리에서 티가 나는 것이 이 화면의 목적이다.
 */

import { onLangChange, t } from "../i18n/index.js";
import {
  deleteStoredFiles,
  fetchCsvSpan,
  listStoredFiles,
  storedFileUrl,
  type CsvSpan,
  type StoredCsvFile,
  type StoredVideoFile,
} from "../api/storedFilesApi.js";
import { parseCaptureName } from "../core/sessionNaming.js";

/** 촬영 한 번 = 도장 하나. */
type Session = {
  stamp: string;
  /** 도장을 로컬 시각으로 되읽은 값. 형식이 깨지면 null. */
  when: Date | null;
  /** `제니-9.8kg` 같은 파일명 앞머리. 없으면 빈 문자열. */
  dog: string;
  csv: StoredCsvFile | null;
  /** main 먼저, 그다음 sub1·sub2… 순. */
  videos: StoredVideoFile[];
};

/**
 * CSV 와 영상 길이가 이만큼 넘게 어긋나면 눈에 띄게 표시한다.
 *
 * 매트가 카메라보다 조금 먼저 켜지고 늦게 꺼지므로 영상이 CSV 보다 1 초쯤 짧은 것은
 * 정상이다(2026-08-20 실측 31개 중앙값 -1.1초, 정상 범위 -1.5 ~ +1.3초).
 * 그 바깥은 영상이 잘린 것으로 본다.
 */
const GAP_WARN_SEC = 2;

/** `260820-150920` → Date. 도장은 촬영 노트북의 로컬 시각으로 찍힌다. */
function parseStamp(stamp: string): Date | null {
  const m = /^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return null;
  const [, yy, mo, dd, hh, mi, ss] = m;
  const d = new Date(
    2000 + Number(yy),
    Number(mo) - 1,
    Number(dd),
    Number(hh),
    Number(mi),
    Number(ss),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 개명 이전 CSV 이름. `pressure-20260818-131402-danbi-7e35bfeb.csv`
 *
 * 서버에 쌓인 CSV 의 대부분(2026-08 기준 272개 중 225개)이 아직 이 모양이다.
 * 안 읽으면 그 촬영들이 이 화면에서 통째로 사라진다.
 */
const LEGACY_CSV_RE = /^pressure-\d{2}(\d{6})-(\d{6})-(.+)-[0-9a-f]{8}\.csv$/i;

/** CSV 파일명의 도장. 현행 `제니-9.8kg-260820-150920.csv` 와 개명 이전 이름 둘 다 읽는다. */
function csvStamp(name: string): string | null {
  const tail = /(?:^|-)(\d{6}-\d{6})\.csv$/i.exec(name);
  if (tail) return tail[1];
  // 개명 이전 이름은 `20260818` 처럼 네 자리 연도라 앞 두 자리를 떼어 `260818` 로 맞춘다.
  const legacy = LEGACY_CSV_RE.exec(name);
  return legacy ? `${legacy[1]}-${legacy[2]}` : null;
}

/** 도장 앞의 개 이름 부분. `제니-9.8kg-260820-150920.csv` → `제니-9.8kg`. */
function csvDog(name: string, stamp: string): string {
  const legacy = LEGACY_CSV_RE.exec(name);
  // 개명 이전 이름의 `dog` 는 이름을 모를 때 넣던 자리표시자다.
  if (legacy) return legacy[3] === "dog" ? "" : legacy[3];
  const head = name.slice(0, name.length - `-${stamp}.csv`.length);
  return head === "pressure" ? "" : head;
}

/** main → sub1 → sub2 … 순서. 못 읽으면 맨 뒤. */
function roleOrder(name: string): number {
  const parsed = parseCaptureName(name);
  if (!parsed) return 999;
  return parsed.role === "main" ? 0 : (parsed.subIndex ?? 1);
}

/** 파일 목록을 도장으로 되묶는다. 최신 촬영이 앞. */
export function groupSessions(csv: StoredCsvFile[], videos: StoredVideoFile[]): Session[] {
  const byStamp = new Map<string, Session>();
  const ensure = (stamp: string): Session => {
    let s = byStamp.get(stamp);
    if (!s) {
      s = { stamp, when: parseStamp(stamp), dog: "", csv: null, videos: [] };
      byStamp.set(stamp, s);
    }
    return s;
  };

  for (const row of csv) {
    const stamp = csvStamp(row.name);
    if (!stamp) continue;
    const s = ensure(stamp);
    s.csv = row;
    if (!s.dog) s.dog = csvDog(row.name, stamp);
  }
  for (const row of videos) {
    const parsed = parseCaptureName(row.name);
    if (!parsed) continue;
    const s = ensure(parsed.stamp);
    s.videos.push(row);
    if (!s.dog && parsed.dog) s.dog = parsed.dog.replace(/-$/, "");
  }

  for (const s of byStamp.values()) {
    s.videos.sort((a, b) => roleOrder(a.name) - roleOrder(b.name) || a.name.localeCompare(b.name));
  }
  // 도장은 `YYMMDD-HHMMSS` 라 문자열 내림차순이 곧 최신순이다.
  return [...byStamp.values()].sort((a, b) => b.stamp.localeCompare(a.stamp));
}

function roleLabel(name: string): string {
  const parsed = parseCaptureName(name);
  if (!parsed) return name;
  if (parsed.role === "main") return t("files_role_main");
  return `${t("files_role_sub")}${parsed.subIndex ?? 1}`;
}

export class VerifyPage {
  private readonly root: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly refreshBtn: HTMLButtonElement;
  private readonly modalEl: HTMLElement;
  private readonly modalHintEl: HTMLElement;
  private readonly modalListEl: HTMLElement;
  private readonly modalCancelBtn: HTMLButtonElement;
  private readonly modalConfirmBtn: HTMLButtonElement;
  /** 확인 모달이 겨냥하고 있는 촬영. 닫히면 null. */
  private pendingDelete: Session | null = null;
  private deleting = false;

  private apiBase = "";
  private sessions: Session[] = [];
  private selected: string | null = null;
  private loading = false;
  /** 도장 → CSV 길이. 한 번 읽으면 새로고침 전까지 다시 읽지 않는다. */
  private readonly spans = new Map<string, CsvSpan | null>();

  constructor(root: HTMLElement) {
    this.root = root;
    this.subEl = root.querySelector("#dvSub") as HTMLElement;
    this.statusEl = root.querySelector("#dvStatus") as HTMLElement;
    this.countEl = root.querySelector("#dvCount") as HTMLElement;
    this.listEl = root.querySelector("#dvList") as HTMLElement;
    this.emptyEl = root.querySelector("#dvEmpty") as HTMLElement;
    this.detailEl = root.querySelector("#dvDetail") as HTMLElement;
    this.refreshBtn = root.querySelector("#dvRefresh") as HTMLButtonElement;

    this.modalEl = root.querySelector("#dvDelModal") as HTMLElement;
    this.modalHintEl = root.querySelector("#dvDelHint") as HTMLElement;
    this.modalListEl = root.querySelector("#dvDelList") as HTMLElement;
    this.modalCancelBtn = root.querySelector("#dvDelCancel") as HTMLButtonElement;
    this.modalConfirmBtn = root.querySelector("#dvDelConfirm") as HTMLButtonElement;

    this.refreshBtn.addEventListener("click", () => void this.reload());
    this.modalCancelBtn.addEventListener("click", () => this.closeDeleteModal());
    this.modalConfirmBtn.addEventListener("click", () => void this.runDelete());
    // 바깥을 눌러도 닫힌다. 지우는 중에는 닫지 않는다.
    this.modalEl.addEventListener("click", (ev) => {
      if (ev.target === this.modalEl) this.closeDeleteModal();
    });
    this.modalEl.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") this.closeDeleteModal();
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
    this.closeDeleteModal();
    // 화면을 떠날 때 재생을 멈춘다. 안 그러면 다른 탭에서 소리가 계속 난다.
    this.detailEl.querySelectorAll("video").forEach((v) => v.pause());
  }

  private syncCopy(): void {
    this.subEl.textContent = t("verify_page_sub");
    this.refreshBtn.textContent = t("btn_results_refresh");
    this.emptyEl.textContent = t("verify_empty");
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
    this.setStatus(t("files_loading"));
    try {
      const list = await listStoredFiles(this.apiBase);
      this.sessions = groupSessions(list.csv, list.videos);
      this.spans.clear();
      if (this.selected && !this.sessions.some((s) => s.stamp === this.selected)) this.selected = null;
      if (!this.selected && this.sessions.length > 0) this.selected = this.sessions[0].stamp;
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

  private render(): void {
    this.countEl.textContent = t("verify_count", { n: this.sessions.length });
    this.emptyEl.hidden = this.sessions.length > 0;
    this.listEl.replaceChildren();

    let lastDay = "";
    for (const s of this.sessions) {
      const day = s.when ? formatDay(s.when) : s.stamp.slice(0, 6);
      if (day !== lastDay) {
        lastDay = day;
        const head = document.createElement("li");
        head.className = "dv-day";
        head.textContent = day;
        this.listEl.appendChild(head);
      }
      this.listEl.appendChild(this.sessionRow(s));
    }
    this.renderDetail();
  }

  private sessionRow(s: Session): HTMLElement {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dv-item";
    if (s.stamp === this.selected) btn.classList.add("is-active");

    const time = document.createElement("span");
    time.className = "dv-item-time";
    time.textContent = s.when ? formatClock(s.when) : s.stamp;

    const dog = document.createElement("span");
    dog.className = "dv-item-dog";
    dog.textContent = s.dog || "—";

    const tags = document.createElement("span");
    tags.className = "dv-item-tags";
    // CSV 가 없는 촬영은 여기서 바로 보여야 한다 — 그게 이 화면을 만든 이유다.
    const csvTag = document.createElement("b");
    csvTag.className = s.csv ? "dv-tag" : "dv-tag is-bad";
    csvTag.textContent = s.csv ? "CSV" : t("verify_no_csv_tag");
    const vidTag = document.createElement("b");
    vidTag.className = s.videos.length > 0 ? "dv-tag" : "dv-tag is-bad";
    vidTag.textContent = t("verify_video_tag", { n: s.videos.length });
    tags.append(csvTag, vidTag);

    btn.append(time, dog, tags);
    btn.addEventListener("click", () => {
      this.selected = s.stamp;
      this.render();
    });
    li.appendChild(btn);
    return li;
  }

  private renderDetail(): void {
    const s = this.sessions.find((x) => x.stamp === this.selected) || null;
    this.detailEl.replaceChildren();
    if (!s) {
      const p = document.createElement("p");
      p.className = "fd-empty";
      p.textContent = t("verify_pick");
      this.detailEl.appendChild(p);
      return;
    }

    const head = document.createElement("div");
    const title = document.createElement("div");
    title.className = "dv-detail-title";
    title.textContent = s.when ? `${formatDay(s.when)} ${formatClock(s.when)}` : s.stamp;
    const who = document.createElement("div");
    who.className = "dv-detail-sub";
    who.textContent = s.dog ? `${s.dog} · ${s.stamp}` : s.stamp;
    head.append(title, who);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "dv-del-btn";
    delBtn.textContent = t("verify_del_button");
    delBtn.addEventListener("click", () => this.openDeleteModal(s));
    const headRow = document.createElement("div");
    headRow.className = "dv-detail-head";
    headRow.append(head, delBtn);
    this.detailEl.appendChild(headRow);

    this.detailEl.appendChild(this.csvBlock(s));
    this.detailEl.appendChild(this.videoBlock(s));
  }

  private csvBlock(s: Session): HTMLElement {
    const box = document.createElement("section");
    box.className = "dv-block";
    const h = document.createElement("div");
    h.className = "section";
    h.textContent = t("files_csv_heading");
    box.appendChild(h);

    if (!s.csv) {
      const p = document.createElement("p");
      p.className = "dv-warn";
      p.textContent = t("verify_csv_missing");
      box.appendChild(p);
      return box;
    }

    const name = document.createElement("div");
    name.className = "dv-file-name";
    name.textContent = s.csv.name;
    name.title = s.csv.name;

    const span = document.createElement("div");
    span.className = "dv-span";
    span.textContent = t("verify_span_loading");

    const link = document.createElement("a");
    link.className = "fd-download";
    link.textContent = t("files_download");
    link.href = storedFileUrl(this.apiBase, s.csv.url, true);
    link.setAttribute("download", s.csv.name);
    link.rel = "noopener";

    const row = document.createElement("div");
    row.className = "dv-file-row";
    const meta = document.createElement("div");
    meta.className = "dv-file-meta";
    meta.append(name, span);
    row.append(meta, link);
    box.appendChild(row);

    void this.loadSpan(s, span);
    return box;
  }

  /** CSV 길이를 채운다. 이미 읽어둔 도장이면 다시 받지 않는다. */
  private async loadSpan(s: Session, target: HTMLElement): Promise<void> {
    if (!s.csv) return;
    if (this.spans.has(s.stamp)) {
      this.paintSpan(target, this.spans.get(s.stamp) ?? null, s.csv.size);
      return;
    }
    try {
      const span = await fetchCsvSpan(this.apiBase, s.csv.url);
      this.spans.set(s.stamp, span);
      // 읽는 사이에 다른 테스트를 눌렀으면 이 노드는 이미 화면에 없다.
      if (target.isConnected) this.paintSpan(target, span, s.csv.size);
    } catch {
      this.spans.set(s.stamp, null);
      if (target.isConnected) this.paintSpan(target, null, s.csv.size);
    }
  }

  private paintSpan(target: HTMLElement, span: CsvSpan | null, size: number): void {
    if (!span) {
      target.textContent = `${t("verify_span_failed")} · ${formatSize(size)}`;
      target.className = "dv-span is-bad";
      return;
    }
    target.className = "dv-span";
    target.textContent = `${t("verify_span", {
      sec: span.seconds.toFixed(1),
      frames: String(span.frames),
      fps: span.fps.toFixed(1),
    })} · ${formatSize(size)}`;
    // CSV 길이를 알아야 영상과의 차이를 표시할 수 있다.
    this.paintGaps(span.seconds);
  }

  /** 이미 그려진 영상 카드에 "CSV 와 몇 초 차이" 를 채운다. */
  private paintGaps(csvSeconds: number): void {
    this.detailEl.querySelectorAll<HTMLElement>(".dv-video-gap").forEach((el) => {
      const secs = Number(el.dataset.sec);
      if (!Number.isFinite(secs) || secs <= 0 || csvSeconds <= 0) return;
      const gap = secs - csvSeconds;
      // "+0.3초" 같은 부호는 어느 쪽이 긴지 헷갈린다. 말로 적는다.
      el.textContent = t(gap < 0 ? "verify_gap_short" : "verify_gap_long", {
        gap: Math.abs(gap).toFixed(1),
      });
      el.classList.toggle("is-bad", Math.abs(gap) > GAP_WARN_SEC);
    });
  }

  /* ─────────────── 삭제 ─────────────── */

  /** 무엇이 지워지는지 전부 보여주고 확인을 받는다. 되돌릴 수 없기 때문이다. */
  private openDeleteModal(s: Session): void {
    this.pendingDelete = s;
    const files = [...(s.csv ? [s.csv] : []), ...s.videos];
    const total = files.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
    this.modalHintEl.textContent = t("verify_del_hint", {
      when: s.when ? `${formatDay(s.when)} ${formatClock(s.when)}` : s.stamp,
      dog: s.dog || "—",
      n: String(files.length),
      size: formatSize(total),
    });
    this.modalListEl.replaceChildren();
    for (const f of files) {
      const li = document.createElement("li");
      li.textContent = f.name;
      li.title = f.name;
      this.modalListEl.appendChild(li);
    }
    this.modalConfirmBtn.disabled = files.length === 0;
    this.modalConfirmBtn.textContent = t("verify_del_confirm");
    this.modalEl.hidden = false;
    // 위험한 버튼에 처음부터 포커스가 가지 않게 취소에 둔다.
    this.modalCancelBtn.focus();
  }

  private closeDeleteModal(): void {
    if (this.deleting) return;
    this.pendingDelete = null;
    this.modalEl.hidden = true;
  }

  private async runDelete(): Promise<void> {
    const s = this.pendingDelete;
    if (!s || this.deleting) return;
    this.deleting = true;
    this.modalConfirmBtn.disabled = true;
    this.modalCancelBtn.disabled = true;
    this.modalConfirmBtn.textContent = t("verify_del_running");
    try {
      const result = await deleteStoredFiles(this.apiBase, {
        csv: s.csv ? [s.csv.name] : [],
        videos: s.videos.map((v) => `${"role" in v ? v.role : "main"}/${v.name}`),
      });
      this.deleting = false;
      this.closeDeleteModal();
      // 지운 촬영은 목록에서 사라지므로 선택을 비우고 새로 읽는다.
      this.selected = null;
      await this.reload();
      const failed = result.failed.length;
      this.setStatus(
        t("verify_del_done", { n: String(result.deleted.length) }) +
          (failed ? ` ${t("verify_del_failed_n", { n: String(failed) })}` : ""),
        failed > 0,
      );
    } catch (err) {
      this.deleting = false;
      const detail = err instanceof Error ? err.message : String(err);
      this.closeDeleteModal();
      this.setStatus(`${t("verify_del_failed")}: ${detail}`, true);
    } finally {
      this.deleting = false;
      this.modalCancelBtn.disabled = false;
      this.modalConfirmBtn.disabled = false;
      this.modalConfirmBtn.textContent = t("verify_del_confirm");
    }
  }

  private videoBlock(s: Session): HTMLElement {
    const box = document.createElement("section");
    box.className = "dv-block";
    const h = document.createElement("div");
    h.className = "section";
    h.textContent = t("verify_video_heading", { n: s.videos.length });
    box.appendChild(h);

    if (s.videos.length === 0) {
      const p = document.createElement("p");
      p.className = "dv-warn";
      p.textContent = t("verify_video_missing");
      box.appendChild(p);
      return box;
    }

    const grid = document.createElement("div");
    grid.className = "dv-videos";
    for (const row of s.videos) grid.appendChild(this.videoCard(row));
    box.appendChild(grid);
    return box;
  }

  private videoCard(row: StoredVideoFile): HTMLElement {
    const card = document.createElement("div");
    card.className = "dv-video";

    const label = document.createElement("div");
    label.className = "dv-video-head";
    const role = document.createElement("b");
    role.textContent = roleLabel(row.name);
    const gap = document.createElement("span");
    gap.className = "dv-video-gap";
    label.append(role, gap);

    const video = document.createElement("video");
    video.controls = true;
    // 목록을 열자마자 N 개를 통째로 받으면 안 된다. 길이만 먼저 읽고 재생은 누를 때.
    video.preload = "metadata";
    video.playsInline = true;
    video.src = storedFileUrl(this.apiBase, row.url, false);

    const meta = document.createElement("div");
    meta.className = "dv-video-meta";
    meta.textContent = formatSize(row.size);
    video.addEventListener("loadedmetadata", () => {
      const secs = video.duration;
      if (!Number.isFinite(secs)) return;
      meta.textContent = `${t("verify_video_len", { sec: secs.toFixed(1) })} · ${formatSize(row.size)}`;
      gap.dataset.sec = String(secs);
      const span = this.spans.get(this.selected || "");
      if (span) this.paintGaps(span.seconds);
    });
    video.addEventListener("error", () => {
      meta.textContent = `${t("verify_video_failed")} · ${formatSize(row.size)}`;
      meta.classList.add("is-bad");
    });

    const name = document.createElement("div");
    name.className = "dv-video-name";
    name.textContent = row.name;
    name.title = row.name;

    const link = document.createElement("a");
    link.className = "fd-download";
    link.textContent = t("files_download");
    link.href = storedFileUrl(this.apiBase, row.url, true);
    link.setAttribute("download", row.name);
    link.rel = "noopener";

    card.append(label, video, meta, name, link);
    return card;
  }
}

function formatDay(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function formatClock(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
