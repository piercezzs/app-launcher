import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInstance } from "i18next";
import { isLanguagePreference, readPreference, resolveLocale, resources } from "./i18n";

describe("language resolution and resources", () => {
  it("respects an explicit choice and falls back predictably for system languages", () => {
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveLocale("zh-CN", ["en-US"])).toBe("zh-CN");
    expect(resolveLocale("system", ["zh-TW", "en"])).toBe("zh-CN");
    expect(resolveLocale("system", ["fr-FR", "zh-CN"])).toBe("en");
    expect(resolveLocale("system", [])).toBe("en");
    expect(isLanguagePreference("zh-TW")).toBe(false);
  });

  it("recovers from invalid or unavailable saved preferences", () => {
    expect(readPreference({ getItem: () => "en" })).toBe("en");
    expect(readPreference({ getItem: () => "corrupted" })).toBe("system");
    expect(readPreference({ getItem: () => { throw new Error("denied"); } })).toBe("system");
  });

  it("keeps both dictionaries and interpolation arguments complete", () => {
    const en = resources.en.translation;
    const zh = resources["zh-CN"].translation;
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(zh[key].trim().length, key).toBeGreaterThan(0);
      const parameters = (value: string) => [...value.matchAll(/{{(\w+)}}/g)].map((match) => match[1]).sort();
      expect(parameters(zh[key]), key).toEqual(parameters(en[key]));
    }
  });

  it("handles plural counts and names as data rather than translation keys", async () => {
    const i18n = createInstance();
    await i18n.init({ resources, lng: "en", fallbackLng: "en", keySeparator: false, interpolation: { escapeValue: false } });
    expect(i18n.t("scan.localCount", { count: 0 })).toBe("0 local apps");
    expect(i18n.t("scan.localCount", { count: 1 })).toBe("1 local app");
    expect(i18n.t("scan.localCount", { count: 2 })).toBe("2 local apps");
    expect(i18n.t("app.launchNamed", { name: "我的 Notes" })).toBe("Launch 我的 Notes");
    await i18n.changeLanguage("zh-CN");
    expect(i18n.t("scan.localCount", { count: 1 })).toBe("1 个本地应用");
    expect(i18n.t("app.launchNamed", { name: "My Notes" })).toBe("启动 My Notes");
    await i18n.changeLanguage("fr");
    expect(i18n.t("common.save")).toBe("Save");
  });
});

describe("live preference lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    const data = new Map<string, string>();
    const events = new EventTarget();
    vi.stubGlobal("window", Object.assign(events, {
      localStorage: {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => { data.set(key, value); },
      },
    }));
    vi.stubGlobal("navigator", { languages: ["en-GB"], language: "en-GB" });
    vi.stubGlobal("document", { documentElement: { lang: "" } });
  });

  it("updates an existing message and document language, then restores the saved choice", async () => {
    const first = await import("./i18n");
    first.initializeI18n();
    const pending = first.message("feedback.launched", { name: "Notes" });
    expect(first.formatMessage(pending)).toBe("Launched Notes.");
    expect(first.setLanguagePreference("zh-CN")).toBe(true);
    expect(first.formatMessage(pending)).toBe("已启动 Notes");
    expect(document.documentElement.lang).toBe("zh-CN");
    vi.resetModules();
    const restarted = await import("./i18n");
    restarted.initializeI18n();
    expect(restarted.getLanguagePreference()).toBe("zh-CN");
    expect(restarted.t("common.save")).toBe("保存");
  });

  it("still switches language when saving fails, while reporting the failure", async () => {
    const i18n = await import("./i18n");
    i18n.initializeI18n();
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => { throw new Error("full"); });
    expect(i18n.setLanguagePreference("zh-CN")).toBe(false);
    expect(i18n.t("common.save")).toBe("保存");
  });

  it("follows system language changes only while system mode is selected", async () => {
    const i18n = await import("./i18n");
    i18n.initializeI18n();
    vi.stubGlobal("navigator", { languages: ["zh-CN"], language: "zh-CN" });
    window.dispatchEvent(new Event("languagechange"));
    expect(i18n.t("common.save")).toBe("保存");
    i18n.setLanguagePreference("en");
    window.dispatchEvent(new Event("languagechange"));
    expect(i18n.t("common.save")).toBe("Save");
  });
});
