/**
 * 예약 현황 — 측정 화면에서 체험 신청자를 눌러 **그 개체로 측정을 시작한다**.
 *
 * 빠른 입력(`dogsCard`)과 하는 일이 같고 출처만 다르다. 그쪽은 기관이 직접 등록해 둔
 * 단골이고, 이쪽은 현장 QR 로 방금 들어온 신청자다. 여기에만 **상태**가 붙는다.
 *
 * ## 예약은 아직 개체가 아니다 (§3-3-A)
 *
 * 접수만으로 `dogs` 행을 만들지 않는다 — 방문하지 않을 수 있고, 자동 생성하면 등록부에
 * 유령 개체가 쌓인다(삭제도 참조 무결성에 걸려 번거롭다). 카드를 눌러 확인한 그 순간이
 * "실제로 왔다" 는 신호이고, 그때 개체를 발급한다.
 *
 * 재방문이면 이름·견종·생년월이 같은 **기존 개체 후보**를 먼저 보여 준다. 그러지 않으면
 * 같은 개의 촬영이 두 개체로 갈린다. 다만 몸무게가 다르면 §3-2-A 대로 새 개체가 맞다.
 *
 * ## 잠그지 않는다
 *
 * 이미 "측정중" 인 예약도 다른 계정이 누를 수 있다. 현장 두세 곳이 같은 목록을
 * 보는데 잠가 두면 꼬였을 때 풀 방법이 없다. 대신 누가 잡았는지 배지로 보여 준다.
 *
 * ## 카드 한 줄에 이름·시간만 크게
 *
 * 현장에서 먼저 읽는 것은 "누구를 부르는가"(이름)와 "언제 왔는가"(시간)다. 몸무게·
 * 견종·나이는 그 다음이라 작게 두고, 이메일·신청 사유는 줄을 더 쓰지 않고 확인
 * 모달로 넘겼다. 목록이 세 줄씩 쓰면 한 화면에 몇 명 안 들어온다.
 *
 * ## 자동 갱신하지 않는다
 *
 * 다른 자리의 변경은 새로고침을 눌러야 보인다. 폴링을 넣으면 현장 한 곳당 초당
 * 요청이 붙는데, 하루 수십 건 규모에서 그 값을 치를 이유가 없다.
 */

import {
  ageLabel,
  deleteReservation,
  linkReservationDog,
  listDogCandidates,
  listReservationDates,
  listReservations,
  sexLabel,
  setReservationStatus,
  type Reservation,
  type ReservationStatus,
} from "../api/reservationsApi.js";
import type { Dog } from "../api/dogsApi.js";
import { showToast } from "./toast.js";

export interface ReservationsCardOptions {
  /** 개체가 확정됐을 때 — 이 개체로 측정한다. */
  onPick(dog: Dog): void;
}

type Filter = ReservationStatus | "all";

const STATUS_LABEL: Record<ReservationStatus, string> = {
  waiting: "대기",
  measuring: "측정중",
  hold: "보류",
};

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "waiting", label: "대기" },
  { key: "measuring", label: "측정중" },
  { key: "hold", label: "보류" },
];

const COLLAPSE_KEY = "gait.reserveCollapsed";

/** `Date` → KST `YYYY-MM-DD`. 서버의 날짜 묶기와 같은 기준이어야 한다. */
function todayKst(): string {
  const now = new Date();
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export class ReservationsCard {
  private apiBase = "";
  private rows: Reservation[] = [];
  /** 현장에서 먼저 보는 것은 아직 안 찍은 사람이다 — "전체" 로 열면 끝난 예약이 섞인다. */
  private filter: Filter = "waiting";
  private date: string = todayKst();
  private loading = false;

  private readonly root: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly dateEl: HTMLSelectElement;
  private readonly filtersEl: HTMLElement;
  private readonly modal: HTMLElement;
  /** 확인 모달이 물어보고 있는 예약. 취소하면 아무 일도 없었던 것이 된다. */
  private asking: Reservation | null = null;

  constructor(private readonly opts: ReservationsCardOptions) {
    this.root = document.getElementById("reserveCard") as HTMLElement;
    this.listEl = document.getElementById("rvList") as HTMLElement;
    this.emptyEl = document.getElementById("rvEmpty") as HTMLElement;
    this.dateEl = document.getElementById("rvDate") as HTMLSelectElement;
    this.filtersEl = document.getElementById("rvFilters") as HTMLElement;
    this.modal = document.getElementById("reserveConfirmModal") as HTMLElement;
    this.bind();
  }

  setApiBase(url: string): void {
    this.apiBase = url.replace(/\/$/, "");
  }

  /** 테스터·마스터가 아니면 섹션 자체가 없다 — 서버도 403 을 준다. */
  enable(): void {
    this.root.hidden = false;
    this.setCollapsed(this.loadCollapsed());
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.apiBase || this.loading) return;
    this.loading = true;
    try {
      const dates = await listReservationDates(this.apiBase);
      this.renderDates(dates);
      this.rows = await listReservations(this.apiBase, {
        date: this.date,
        status: this.filter,
      });
    } catch {
      // 목록을 못 읽어도 측정은 막지 않는다 — 손으로 입력하면 된다.
      this.rows = [];
    } finally {
      this.loading = false;
      this.render();
    }
  }

  // ── 접기 ──────────────────────────────────────────────────────────────

  private loadCollapsed(): boolean {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  }

  private setCollapsed(collapsed: boolean): void {
    this.root.classList.toggle("is-collapsed", collapsed);
    const toggle = document.getElementById("rvFold");
    if (toggle) {
      toggle.textContent = collapsed ? "▸" : "▾";
      toggle.setAttribute("aria-expanded", String(!collapsed));
    }
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      /* 저장이 막힌 환경 — 이번 세션에서만 유지된다 */
    }
  }

  private bind(): void {
    document.getElementById("rvFold")?.addEventListener("click", () => {
      this.setCollapsed(!this.root.classList.contains("is-collapsed"));
    });
    document.getElementById("rvRefresh")?.addEventListener("click", () => void this.refresh());
    document.getElementById("rcmCancel")?.addEventListener("click", () => this.closeModal());
    document.getElementById("rcmGo")?.addEventListener("click", () => {
      const row = this.asking;
      this.closeModal();
      if (row) void this.pick(row);
    });
    this.modal.addEventListener("click", (ev) => {
      if (ev.target === this.modal) this.closeModal();
    });
    window.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && this.modal.classList.contains("open")) this.closeModal();
    });
    this.dateEl.addEventListener("change", () => {
      this.date = this.dateEl.value;
      void this.refresh();
    });
    for (const { key, label } of FILTERS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.status = key;
      btn.textContent = label;
      btn.classList.toggle("active", key === this.filter);
      btn.addEventListener("click", () => {
        this.filter = key;
        for (const el of this.filtersEl.children) {
          el.classList.toggle("active", (el as HTMLElement).dataset.status === key);
        }
        void this.refresh();
      });
      this.filtersEl.append(btn);
    }
  }

  // ── 동작 ──────────────────────────────────────────────────────────────

  /**
   * 카드를 누르면 곧바로 채우지 않고 한 번 묻는다. 누르는 순간 상태가 `측정중` 으로
   * 바뀌고 입력란이 덮이는데, 목록을 훑다가 잘못 누르는 일이 현장에서 자주 생긴다.
   */
  private ask(row: Reservation): void {
    this.asking = row;
    const set = (id: string, text: string): void => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    set("rcmName", row.dogName);
    set(
      "rcmMeta",
      [
        `${row.dogWeightKg}kg`,
        row.dogBreed,
        ageLabel(row.dogBirthMonth),
        sexLabel(row.dogSex, row.dogNeutered),
      ]
        .filter(Boolean)
        .join(" · "),
    );
    set("rcmEmail", row.ownerEmail);

    const reason = document.getElementById("rcmReason");
    if (reason) {
      reason.textContent = row.reason || "";
      reason.hidden = !row.reason;
    }
    // 다른 자리가 이미 부른 사람일 수 있다. 막지는 않되 모르고 지나치게 두지 않는다.
    const warn = document.getElementById("rcmWarn");
    if (warn) {
      const taken = Boolean(row.status === "measuring" && row.claimedBy);
      warn.textContent = taken ? `${row.claimedBy} 계정이 이미 측정중으로 표시했습니다.` : "";
      warn.hidden = !taken;
    }

    this.modal.classList.add("open");
    document.body.classList.add("modal-open");
    (document.getElementById("rcmGo") as HTMLButtonElement | null)?.focus();
  }

  private closeModal(): void {
    this.modal.classList.remove("open");
    document.body.classList.remove("modal-open");
    this.asking = null;
  }

  /**
   * 확인을 받은 뒤 **개체를 확정하고** 측정중으로 잡는다.
   *
   * 이미 연결된 예약이면 그 개체를 그대로 쓴다. 아니면 기존 개체 후보를 먼저 물어보고,
   * 사람이 고른 결과로 `dogs` 행을 발급하거나 연결한다(§3-3-A).
   *
   * 상태 갱신(측정중)은 잠금이 아니라 표시라, 실패해도 개체는 이미 확정됐으므로 측정은
   * 그대로 진행할 수 있다.
   */
  private async pick(row: Reservation): Promise<void> {
    let dog: Dog;
    try {
      dog = await this.resolveDog(row);
    } catch (err) {
      showToast({
        kind: "bad",
        title: "반려견을 등록하지 못했습니다",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    this.opts.onPick(dog);
    try {
      const updated = await setReservationStatus(this.apiBase, row.id, "measuring");
      Object.assign(row, updated);
      this.render();
    } catch (err) {
      showToast({
        kind: "bad",
        title: "예약 상태를 바꾸지 못했습니다",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** 이 예약이 가리킬 개체를 정한다 — 기존 것을 쓰거나 새로 발급한다. */
  private async resolveDog(row: Reservation): Promise<Dog> {
    if (row.dogId != null) {
      const linked = await linkReservationDog(this.apiBase, row.id);
      Object.assign(row, linked.reservation);
      return linked.dog;
    }

    const candidates = await listDogCandidates(this.apiBase, row.id).catch(() => []);
    // 몸무게까지 같은 후보만 "같은 개" 로 제안한다. 다르면 §3-2-A 대로 새 개체가 맞다 —
    // 그래도 목록에는 보여 준다(사람이 "살이 쪘구나" 를 알아야 판단할 수 있다).
    let wanted: number | null = null;
    if (candidates.length) {
      const lines = candidates
        .map((c) => `#${c.id} ${c.name} · ${c.weightKg ?? "?"}kg${c.sameWeight ? " (몸무게 같음)" : " (몸무게 다름 → 새 개체 권장)"}`)
        .join("\n");
      const same = candidates.find((c) => c.sameWeight);
      if (same) {
        wanted = window.confirm(
          `이름·견종이 같은 반려견이 이미 있습니다.\n\n${lines}\n\n` +
            `[확인] 기존 개체(#${same.id})로 측정  ·  [취소] 새 개체로 등록`,
        )
          ? same.id
          : null;
      } else {
        window.alert(
          `이름·견종이 같은 반려견이 있지만 몸무게가 다릅니다.\n\n${lines}\n\n` +
            "몸무게가 다르면 다른 개체입니다 — 새로 등록합니다.",
        );
      }
    }

    const created = await linkReservationDog(this.apiBase, row.id, wanted);
    Object.assign(row, created.reservation);
    return created.dog;
  }

  private async changeStatus(row: Reservation, status: ReservationStatus): Promise<void> {
    try {
      const updated = await setReservationStatus(this.apiBase, row.id, status);
      Object.assign(row, updated);
      // 특정 상태만 보고 있으면 방금 바꾼 행이 목록에서 빠져야 한다.
      if (this.filter !== "all" && this.filter !== status) void this.refresh();
      else this.render();
    } catch (err) {
      showToast({
        kind: "bad",
        title: "변경 실패",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async remove(row: Reservation): Promise<void> {
    if (!window.confirm(`${row.dogName} 님의 예약을 삭제할까요? 되돌릴 수 없습니다.`)) return;
    try {
      await deleteReservation(this.apiBase, row.id);
      await this.refresh();
    } catch (err) {
      showToast({
        kind: "bad",
        title: "삭제 실패",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 그리기 ────────────────────────────────────────────────────────────

  /** 날짜 선택. 오늘은 예약이 0건이어도 항상 목록에 둔다 — 기본값이라서다. */
  private renderDates(dates: { date: string; count: number }[]): void {
    const today = todayKst();
    const items = [...dates];
    if (!items.some((d) => d.date === today)) items.unshift({ date: today, count: 0 });
    if (!items.some((d) => d.date === this.date)) items.push({ date: this.date, count: 0 });
    items.sort((a, b) => (a.date < b.date ? 1 : -1));

    this.dateEl.textContent = "";
    for (const item of items) {
      const opt = document.createElement("option");
      opt.value = item.date;
      opt.textContent =
        item.date === today ? `${item.date} (오늘 · ${item.count})` : `${item.date} · ${item.count}`;
      this.dateEl.append(opt);
    }
    this.dateEl.value = this.date;
  }

  private render(): void {
    this.listEl.textContent = "";
    this.emptyEl.textContent = this.loading ? "불러오는 중…" : "이 날짜에는 예약이 없습니다.";
    this.emptyEl.hidden = this.rows.length > 0;
    for (const row of this.rows) this.listEl.append(this.rowEl(row));
  }

  private rowEl(row: Reservation): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = `rv-row is-${row.status}`;

    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "rv-pick";
    pick.addEventListener("click", () => this.ask(row));

    // 이름이 가장 크다 — 현장에서 부르는 것이 이름이다.
    const name = document.createElement("span");
    name.className = "rv-name";
    name.textContent = row.dogName;

    const time = document.createElement("span");
    time.className = "rv-time";
    time.textContent = new Date(row.createdAt).toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
    });

    // 같은 이름이 여럿일 수 있으므로 몸무게까지 붙인다. 넘치면 잘리고, 전체는 모달에서 본다.
    const meta = document.createElement("span");
    meta.className = "rv-meta";
    meta.textContent = [
      `${row.dogWeightKg}kg`,
      row.dogBreed,
      ageLabel(row.dogBirthMonth),
      sexLabel(row.dogSex, row.dogNeutered),
      row.ownerEmail,
    ]
      .filter(Boolean)
      .join(" · ");
    // 잘린 뒷부분과 신청 사유는 마우스를 올리면 보인다.
    pick.title = [meta.textContent, row.reason].filter(Boolean).join(" / ");

    pick.append(name, time, meta);

    const side = document.createElement("div");
    side.className = "rv-side";

    if (row.status === "measuring" && row.claimedBy) {
      // 잠금이 아니라 표시다 — 다른 자리에서 이미 부른 사람인지만 알려 준다.
      const badge = document.createElement("span");
      badge.className = "rv-claim";
      badge.textContent = `${row.claimedBy} 측정중`;
      side.append(badge);
    }

    const select = document.createElement("select");
    select.className = "rv-status";
    select.setAttribute("aria-label", "예약 상태");
    for (const key of ["waiting", "measuring", "hold"] as ReservationStatus[]) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = STATUS_LABEL[key];
      select.append(opt);
    }
    select.value = row.status;
    select.addEventListener("change", () => {
      void this.changeStatus(row, select.value as ReservationStatus);
    });
    side.append(select);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "rv-del";
    del.title = "예약 삭제";
    del.textContent = "✕";
    del.addEventListener("click", () => void this.remove(row));
    side.append(del);

    wrap.append(pick, side);
    return wrap;
  }
}
