/**
 * 서버 조회 — back 디스크에 얼마나 남았는지 보는 화면.
 *
 * 현장에 나가서 촬영하다가 용량이 차서 영상이 안 올라가면 그 촬영은 되돌릴 수 없다.
 * 그래서 나가기 전에 여유 공간과 uploads/main·sub 사용량만 빠르게 확인한다.
 */

import { getStorageUsage, type StorageUsage } from "../api/storageApi.js";
import { t } from "../i18n/index.js";
import { formatSize } from "./filesPage.js";

/** 이 아래로 떨어지면 촬영 나가기 전에 정리하라고 경고한다. */
const LOW_PERCENT = 90;

export class StoragePage {
  private readonly root: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly totalEl: HTMLElement;
  private readonly usedEl: HTMLElement;
  private readonly freeEl: HTMLElement;
  private readonly barEl: HTMLElement;
  private readonly percentEl: HTMLElement;
  private readonly foldersEl: HTMLElement;
  private readonly refreshBtn: HTMLButtonElement;

  private apiBase = "";
  private loading = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.statusEl = root.querySelector("#stStatus") as HTMLElement;
    this.totalEl = root.querySelector("#stTotal") as HTMLElement;
    this.usedEl = root.querySelector("#stUsed") as HTMLElement;
    this.freeEl = root.querySelector("#stFree") as HTMLElement;
    this.barEl = root.querySelector("#stBarFill") as HTMLElement;
    this.percentEl = root.querySelector("#stPercent") as HTMLElement;
    this.foldersEl = root.querySelector("#stFolders") as HTMLElement;
    this.refreshBtn = root.querySelector("#stRefresh") as HTMLButtonElement;
    this.refreshBtn.addEventListener("click", () => void this.reload());
  }

  setApiBase(base: string): void {
    this.apiBase = base;
  }

  show(): void {
    this.root.hidden = false;
    void this.reload();
  }

  hide(): void {
    this.root.hidden = true;
  }

  private async reload(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.refreshBtn.disabled = true;
    this.statusEl.textContent = t("storage_loading");
    try {
      this.render(await getStorageUsage(this.apiBase));
      this.statusEl.textContent = "";
    } catch (error) {
      this.statusEl.textContent = t("storage_error", { msg: String((error as Error)?.message || error) });
    } finally {
      this.loading = false;
      this.refreshBtn.disabled = false;
    }
  }

  private render(usage: StorageUsage): void {
    const { total, used, available, percent } = usage.disk;
    this.totalEl.textContent = formatSize(total);
    this.usedEl.textContent = formatSize(used);
    this.freeEl.textContent = formatSize(available);

    const low = percent >= LOW_PERCENT;
    this.barEl.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    this.barEl.classList.toggle("is-low", low);
    this.percentEl.textContent = low
      ? `${t("storage_percent", { p: String(percent) })} — ${t("storage_low")}`
      : t("storage_percent", { p: String(percent) });
    this.percentEl.classList.toggle("is-low", low);

    this.foldersEl.replaceChildren(
      ...usage.folders.map((f) => {
        const li = document.createElement("li");
        li.className = "st-folder";
        const name = document.createElement("span");
        name.className = "st-folder-name";
        name.textContent = f.name;
        const count = document.createElement("span");
        count.className = "st-folder-count";
        count.textContent = t("storage_files", { n: String(f.files) });
        const size = document.createElement("span");
        size.className = "st-folder-size";
        size.textContent = formatSize(f.bytes);
        li.append(name, count, size);
        return li;
      }),
    );
  }
}
