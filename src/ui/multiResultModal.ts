/**
 * 종합 리포트 모달 — 리포트를 그 자리에서 보고, 필요하면 QR 로 폰에 내려받는다.
 *
 * 화면 하나에 패널 둘(리포트 / QR)인 이유는 흐름이 하나이기 때문이다. 보다가
 * "폰으로 받자" 가 되는 것이지, 처음부터 QR 을 찾아 들어오지 않는다.
 *
 * ★ **QR 에 넣는 주소는 `job.pdfUrl` 이 아니다.** 그 주소는 로그인 뒤에만 열린다.
 *   폰에는 세션 쿠키가 없으므로 back 에서 토큰 링크를 새로 받아 넣는다
 *   (`createMultiShareLink` → `back/src/multiShare.js`).
 */

import qrcode from "qrcode-generator";

import { onLangChange, t } from "../i18n/index.js";
import { createMultiShareLink, type MultiJob } from "../api/multiApi.js";

/** QR 한 칸의 픽셀. 폰 카메라가 편하게 무는 최소치가 대략 이 언저리다. */
const CELL_PX = 5;

type Pane = "view" | "qr";

export class MultiResultModal {
  private readonly root: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly viewPane: HTMLElement;
  private readonly qrPane: HTMLElement;
  private readonly frame: HTMLIFrameElement;
  private readonly qrBox: HTMLElement;
  private readonly qrName: HTMLElement;
  private readonly qrHint: HTMLElement;
  private readonly qrBtn: HTMLButtonElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly closeBtn: HTMLButtonElement;

  private apiBase = "";
  private job: MultiJob | null = null;
  private pane: Pane = "view";
  /** 발급 중에 버튼을 두 번 눌러 토큰을 두 개 만들지 않게. */
  private issuing = false;

  constructor(root: HTMLElement) {
    this.root = root;
    const $ = <T extends HTMLElement>(id: string): T => root.querySelector(`#${id}`) as T;
    this.titleEl = $("maResultTitle");
    this.viewPane = $("maResultView");
    this.qrPane = $("maResultQr");
    this.frame = $<HTMLIFrameElement>("maResultFrame");
    this.qrBox = $("maQrBox");
    this.qrName = $("maQrName");
    this.qrHint = $("maQrHint");
    this.qrBtn = $<HTMLButtonElement>("maResultQrBtn");
    this.backBtn = $<HTMLButtonElement>("maResultBack");
    this.closeBtn = $<HTMLButtonElement>("maResultClose");

    this.qrBtn.addEventListener("click", () => void this.showQr());
    this.backBtn.addEventListener("click", () => this.setPane("view"));
    this.closeBtn.addEventListener("click", () => this.close());
    // 배경을 눌러도 닫힌다. 리포트를 크게 띄운 뒤 닫기 버튼을 찾는 손이 자꾸 빗나간다.
    root.addEventListener("click", (ev) => {
      if (ev.target === root) this.close();
    });
    onLangChange(() => this.syncCopy());
  }

  setApiBase(url: string): void {
    this.apiBase = url.replace(/\/$/, "");
  }

  open(job: MultiJob, pdfUrl: string): void {
    this.job = job;
    this.root.hidden = false;
    // 열 때마다 리포트부터. QR 은 만료되는 물건이라 이전 것을 남겨 두면 안 된다.
    this.frame.src = pdfUrl;
    this.qrBox.replaceChildren();
    this.setPane("view");
    this.syncCopy();
  }

  close(): void {
    this.root.hidden = true;
    // 파일을 물고 있으면 다음에 열 때 옛 리포트가 잠깐 비친다.
    this.frame.removeAttribute("src");
    this.qrBox.replaceChildren();
    this.job = null;
  }

  private syncCopy(): void {
    if (this.root.hidden) return;
    const job = this.job;
    const weight = job?.dogWeightKg;
    const name = job?.dogName || "-";
    this.titleEl.textContent = weight != null ? `${name} · ${weight}kg` : name;
    this.qrBtn.textContent = t("ma_qr_open");
    this.backBtn.textContent = t("ma_qr_back");
    this.closeBtn.textContent = t("report_modal_close");
  }

  private setPane(pane: Pane): void {
    this.pane = pane;
    this.viewPane.hidden = pane !== "view";
    this.qrPane.hidden = pane !== "qr";
    // 머리의 버튼도 같이 바뀐다 — QR 을 보는 중에 "QR 로 다운받기" 가 남아 있으면
    // 한 번 더 눌러 토큰만 새로 만든다.
    this.qrBtn.hidden = pane !== "view";
    this.backBtn.hidden = pane !== "qr";
  }

  private async showQr(): Promise<void> {
    const job = this.job;
    if (!job || this.issuing) return;
    this.setPane("qr");
    this.qrBox.replaceChildren();
    this.qrName.textContent = "";
    this.qrHint.textContent = t("ma_qr_making");

    this.issuing = true;
    this.qrBtn.disabled = true;
    try {
      const link = await createMultiShareLink(this.apiBase, job.id);
      // 응답이 늦게 온 사이 닫았거나 다른 리포트를 열었으면 버린다.
      if (this.job?.id !== job.id || this.pane !== "qr") return;
      // innerHTML 이지만 들어가는 것은 `<rect>` 뿐이다 — createSvgTag 는 URL 을
      // 그리기만 하고 마크업에 넣지 않는다.
      this.qrBox.innerHTML = renderQrSvg(link.url);
      this.qrName.textContent = link.filename;
      this.qrHint.textContent = t("ma_qr_hint", { min: Math.round(link.ttlSec / 60) });
    } catch (err) {
      if (this.job?.id !== job.id) return;
      this.qrHint.textContent = `${t("ma_qr_failed")}: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.issuing = false;
      this.qrBtn.disabled = false;
    }
  }
}

/**
 * URL 하나를 QR SVG 로. 타입 0 은 데이터 길이에 맞춰 버전을 자동으로 고른다.
 *
 * 오류정정은 M — 화면의 QR 은 종이처럼 더럽혀지지 않으므로 H 까지 올려 칸을
 * 촘촘하게 만들 이유가 없다. 촘촘할수록 폰이 늦게 문다.
 */
function renderQrSvg(url: string): string {
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  return qr.createSvgTag({ cellSize: CELL_PX, margin: CELL_PX * 2, scalable: true });
}
