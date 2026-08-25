/**
 * The one report modal (`#rpReportModal`), shared by the result detail and the
 * report list.
 *
 * Two pages open the same thing, so the language toggle, the caveats state and
 * the download button live here rather than being wired twice against the same
 * element ids.
 */

import { onLangChange, t } from "../i18n/index.js";
import {
  hasEnglishLocale,
  printReports,
  renderReportInto,
  type PrintableReport,
  type ReportLang,
} from "./reportRender.js";

interface Els {
  modal: HTMLElement;
  body: HTMLElement;
  langKo: HTMLButtonElement;
  langEn: HTMLButtonElement;
  langHint: HTMLElement;
  close: HTMLButtonElement;
  download: HTMLButtonElement;
}

let els: Els | null = null;
let current: PrintableReport | null = null;
let lang: ReportLang = "ko";
let caveatsOpen = false;

function ensure(): Els | null {
  if (els) return els;
  const modal = document.getElementById("rpReportModal");
  if (!modal) return null;
  const pick = <T extends HTMLElement>(id: string): T => modal.querySelector(`#${id}`) as T;
  els = {
    modal,
    body: pick("rpDetailBody"),
    langKo: pick<HTMLButtonElement>("rpLangKo"),
    langEn: pick<HTMLButtonElement>("rpLangEn"),
    langHint: pick("rpLangHint"),
    close: pick<HTMLButtonElement>("rpReportClose"),
    download: pick<HTMLButtonElement>("rpReportDownload"),
  };

  els.langKo.addEventListener("click", () => setLang("ko"));
  els.langEn.addEventListener("click", () => setLang("en"));
  els.close.addEventListener("click", closeReportModal);
  els.download.addEventListener("click", () => {
    if (current) printReports([current]);
  });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeReportModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("open")) closeReportModal();
  });
  onLangChange(() => {
    if (modal.classList.contains("open")) render();
  });
  return els;
}

function setLang(next: ReportLang): void {
  lang = next;
  render();
}

function render(): void {
  const e = els;
  if (!e || !current) return;

  const hasEn = hasEnglishLocale(current.preview);
  if (lang === "en" && !hasEn) lang = "ko";

  e.langKo.textContent = t("report_lang_ko");
  e.langEn.textContent = t("report_lang_en");
  e.close.textContent = t("report_review_close");
  e.download.textContent = t("report_download");
  e.langEn.disabled = !hasEn;
  e.langKo.classList.toggle("active", lang === "ko");
  e.langEn.classList.toggle("active", lang === "en");
  e.langHint.textContent = hasEn ? "" : t("report_lang_en_unavailable");
  e.langHint.classList.toggle("hidden", hasEn);

  renderReportInto(e.body, current.preview, lang, {
    caveatsOpen,
    onToggleCaveats: () => {
      caveatsOpen = !caveatsOpen;
      render();
    },
  });
}

export function openReportModal(item: PrintableReport): void {
  const e = ensure();
  if (!e) return;
  current = item;
  lang = "ko";
  caveatsOpen = false;
  render();
  e.modal.classList.add("open");
  e.modal.setAttribute("aria-hidden", "false");
}

export function closeReportModal(): void {
  const e = els;
  if (!e) return;
  e.modal.classList.remove("open");
  e.modal.setAttribute("aria-hidden", "true");
  current = null;
}
