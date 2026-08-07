import { LOCALES, type Lang, type LocaleKey } from "./locales.js";

const LANG_KEY = "gait-pressure-mat.lang";

type Vars = Record<string, string | number | null | undefined>;

let lang: Lang = detectLang();
const listeners = new Set<() => void>();

function detectLang(): Lang {
  try {
    const raw = localStorage.getItem(LANG_KEY);
    if (raw === "ko" || raw === "en") return raw;
    const settings = localStorage.getItem("gait-pressure-mat.settings.v1");
    if (settings) {
      const o = JSON.parse(settings) as { lang?: string };
      if (o.lang === "ko" || o.lang === "en") return o.lang;
    }
  } catch {
    /* ignore */
  }
  const nav = (navigator.language || "en").toLowerCase();
  return nav.startsWith("ko") ? "ko" : "en";
}

function tpl(str: string, vars?: Vars): string {
  if (!vars) return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = vars[k];
    return v !== undefined && v !== null ? String(v) : "";
  });
}

export function getLang(): Lang {
  return lang;
}

export function t(key: LocaleKey, vars?: Vars): string {
  const table = LOCALES[lang] ?? LOCALES.en;
  const s = table[key] ?? LOCALES.en[key] ?? key;
  return tpl(s, vars);
}

export function setLang(next: Lang): void {
  lang = next === "en" ? "en" : "ko";
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* ignore */
  }
  document.documentElement.lang = lang;
  applyDocumentI18n();
  for (const fn of listeners) fn();
}

export function onLangChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Apply `data-i18n` / `data-i18n-title` attributes in index.html. */
export function applyDocumentI18n(): void {
  document.title = t("docTitle");
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n as LocaleKey | undefined;
    if (key) el.textContent = t(key);
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const key = el.dataset.i18nTitle as LocaleKey | undefined;
    if (key) el.title = t(key);
  });
  const langSelect = document.getElementById("langSelect") as HTMLSelectElement | null;
  if (langSelect) langSelect.value = lang;
}

export function initI18n(initialLang?: Lang): void {
  if (initialLang) lang = initialLang;
  document.documentElement.lang = lang;
  applyDocumentI18n();
}
