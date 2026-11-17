import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lang, langFromPreferred, resolveLang, setLang, t } from "../src/i18n.ts";
import { loadSettings, parseAppleLanguages, updateSettings, uiLang } from "../src/settings.ts";

describe("interface language", () => {
  afterEach(() => setLang("zh"));

  test("t picks the half for the current language; Chinese until told otherwise", () => {
    expect(lang()).toBe("zh");
    expect(t("设置", "Settings")).toBe("设置");
    setLang("en");
    expect(t("设置", "Settings")).toBe("Settings");
  });

  test("auto follows the system; zh or en pinned in settings wins", () => {
    const en = () => "en" as const;
    const zh = () => "zh" as const;
    expect(resolveLang("auto", en)).toBe("en");
    expect(resolveLang(undefined, zh)).toBe("zh");
    expect(resolveLang("zh", en)).toBe("zh");
    expect(resolveLang("en", zh)).toBe("en");
  });

  test("a Chinese first preference means Chinese, anything else English", () => {
    expect(langFromPreferred(["zh-Hans-CN", "en-US"])).toBe("zh");
    expect(langFromPreferred(["zh-Hant-TW"])).toBe("zh");
    expect(langFromPreferred(["en-SG", "zh-Hans-CN"])).toBe("en");
    expect(langFromPreferred(["ja-JP"])).toBe("en");
    expect(langFromPreferred([])).toBe("en");
  });

  test("reads the tags out of `defaults read -g AppleLanguages`", () => {
    expect(parseAppleLanguages('(\n    "zh-Hans-CN",\n    "en-US"\n)\n')).toEqual(["zh-Hans-CN", "en-US"]);
    expect(parseAppleLanguages("(\n    en\n)\n")).toEqual(["en"]);
    expect(parseAppleLanguages("")).toEqual([]);
  });

  test("the setting is saved, and only auto, zh or en are accepted", () => {
    const file = join(mkdtempSync(join(tmpdir(), "sidekick-lang-")), "settings.json");
    expect(loadSettings(file).language).toBe("auto");
    updateSettings({ language: "en" }, file);
    expect(loadSettings(file).language).toBe("en");
    expect(uiLang(loadSettings(file))).toBe("en");
    expect(() => updateSettings({ language: "fr" }, file)).toThrow();
    expect(loadSettings(file).language).toBe("en");
  });

  test("validation messages follow the language even though the schema is built at load", () => {
    const file = join(mkdtempSync(join(tmpdir(), "sidekick-lang-")), "settings.json");
    const bad = { workHours: { start: 18, end: 9, weekends: false } };
    expect(() => updateSettings(bad, file)).toThrow(/设置不合法：[\s\S]*上班时间要早于下班时间/);
    setLang("en");
    expect(() => updateSettings(bad, file)).toThrow(/Invalid settings: [\s\S]*Working hours must start before they end/);
  });
});
