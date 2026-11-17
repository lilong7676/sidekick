// The interface language: Chinese or English. Every string a person sees is written in both, side by
// side, where it is used: t("中文", "English"). Two languages need no key catalogue, and neither half
// can go missing without the other sitting right next to it.
//
// The setting (settings.ts `language`) is auto, zh or en; auto follows the Mac's system language. Only
// the interface follows it: what the agent writes (conclusions, reasons, summaries) and the workspace
// templates stay Chinese for now (decided 2026-11-17, session 1a8b63ea). The daemon resolves it and the
// panel and the menu bar app take it from /api/state.
//
// No Node imports here: the web panel bundles this file too.

export type Lang = "zh" | "en";
export type LangSetting = "auto" | Lang;
export const LANG_SETTINGS = ["auto", "zh", "en"] as const;

let current: Lang = "zh";

export function setLang(lang: Lang): void {
  current = lang;
}

export function lang(): Lang {
  return current;
}

/** The string for the interface language. */
export function t(zh: string, en: string): string {
  return current === "en" ? en : zh;
}

/** zh or en pinned in settings wins; auto follows the system. */
export function resolveLang(setting: LangSetting | undefined, system: () => Lang): Lang {
  return setting === "zh" || setting === "en" ? setting : system();
}

/** Chinese for a system whose first preferred language is Chinese, English otherwise. */
export function langFromPreferred(tags: readonly string[]): Lang {
  return tags[0]?.trim().toLowerCase().startsWith("zh") ? "zh" : "en";
}
