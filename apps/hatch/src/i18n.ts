import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en";
import zh from "./locales/zh-CN";

export type LanguagePreference = "system" | "zh-CN" | "en";
export type AppLocale = "zh-CN" | "en";
type BaseKey<K> = K extends `${infer Base}_one` | `${infer Base}_other` ? Base : K;
export type TranslationKey = BaseKey<keyof typeof en>;
export type MessageValues = Readonly<Record<string, string | number>>;
export interface LocalizedMessage {
  readonly key: TranslationKey;
  readonly values?: MessageValues;
}

export const LANGUAGE_STORAGE_KEY = "app-launcher.language";
export const resources = { en: { translation: en }, "zh-CN": { translation: zh } };
const subscribers = new Set<() => void>();
let preference: LanguagePreference = "system";
let initialized = false;

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "system" || value === "zh-CN" || value === "en";
}

export function resolveLocale(value: LanguagePreference, languages: readonly string[]): AppLocale {
  if (value !== "system") return value;
  // The primary system preference determines the language. Unsupported languages use English.
  return /^zh(?:-|$)/i.test(languages[0] ?? "") ? "zh-CN" : "en";
}

export function readPreference(storage: Pick<Storage, "getItem">): LanguagePreference {
  try {
    const saved = storage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguagePreference(saved) ? saved : "system";
  } catch { return "system"; }
}

function systemLanguages(): readonly string[] {
  return navigator.languages.length ? navigator.languages : [navigator.language];
}

export function initializeI18n() {
  if (initialized) return;
  initialized = true;
  try { preference = readPreference(window.localStorage); } catch { preference = "system"; }
  void i18next.use(initReactI18next).init({
    resources,
    lng: resolveLocale(preference, systemLanguages()),
    fallbackLng: "en",
    supportedLngs: ["en", "zh-CN"],
    keySeparator: false,
    initAsync: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  const applyLocale = () => {
    document.documentElement.lang = i18next.resolvedLanguage ?? "en";
  };
  i18next.on("languageChanged", applyLocale);
  applyLocale();
  window.addEventListener("languagechange", () => {
    if (preference === "system") void i18next.changeLanguage(resolveLocale(preference, systemLanguages()));
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== LANGUAGE_STORAGE_KEY && event.key !== null) return;
    preference = isLanguagePreference(event.newValue) ? event.newValue : "system";
    void i18next.changeLanguage(resolveLocale(preference, systemLanguages()));
    subscribers.forEach((notify) => notify());
  });
}

export function getLanguagePreference(): LanguagePreference { return preference; }
export function subscribeLanguagePreference(notify: () => void): () => void {
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
}

/** Apply immediately even if device storage is unavailable, and report persistence failure. */
export function setLanguagePreference(value: LanguagePreference): boolean {
  preference = value;
  let saved = true;
  try { window.localStorage.setItem(LANGUAGE_STORAGE_KEY, value); } catch { saved = false; }
  void i18next.changeLanguage(resolveLocale(value, systemLanguages()));
  subscribers.forEach((notify) => notify());
  return saved;
}

export function t(key: TranslationKey, values?: MessageValues): string {
  return i18next.t(key, values);
}
export function message(key: TranslationKey, values?: MessageValues): LocalizedMessage {
  return { key, values };
}
export function formatMessage(value: LocalizedMessage): string {
  const text = t(value.key, value.values);
  if (value.key === "scan.complete" && (value.values?.added || value.values?.removed)) {
    return `${text} (${t("scan.changes", value.values)})`;
  }
  return text;
}
