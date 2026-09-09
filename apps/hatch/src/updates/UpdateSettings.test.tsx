import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { resources, type AppLocale } from "../i18n";
import { createUpdateController, type NativeUpdateStatus, type UpdateTransport } from "./model";
import { UpdateSettings } from "./UpdateSettings";

const native: NativeUpdateStatus = { configured: true, currentVersion: "0.4.1", phase: "idle", update: null, downloadedBytes: 0, totalBytes: null };
const transport: UpdateTransport = { status: async () => native, check: async () => native, download: async () => native, install: async () => {} };
const storage = { getItem: () => null, setItem: () => {} };
let controller = createUpdateController(transport, storage);
vi.mock("./client", () => ({ updates: {
  getSnapshot: () => controller.getSnapshot(),
  subscribe: (listener: () => void) => controller.subscribe(listener),
  check: () => controller.check(),
  setPreferences: () => {},
} }));

async function render(locale: AppLocale) {
  await i18next.changeLanguage(locale);
  return renderToStaticMarkup(<UpdateSettings hasUnsavedWork={false} />);
}

beforeEach(async () => {
  await i18next.use(initReactI18next).init({ resources, lng: "en", fallbackLng: "en", keySeparator: false, interpolation: { escapeValue: false }, react: { useSuspense: false } });
  controller = createUpdateController(transport, storage);
});

describe("update check feedback", () => {
  it.each([
    ["sourceUnavailable", "updates.error.sourceUnavailable"],
    ["network", "updates.error.network"],
    ["invalidMetadata", "updates.error.invalidMetadata"],
    ["unknown", "updates.error.check"],
  ] as const)("renders the localized %s error and a retry action without raw details", async (code, key) => {
    controller = createUpdateController({ ...transport, check: vi.fn().mockRejectedValue({ code, message: "RAW_DIAGNOSTIC_SECRET" }) }, storage);
    await controller.check();
    for (const locale of ["en", "zh-CN"] as const) {
      const markup = await render(locale);
      expect(markup).toContain(resources[locale].translation[key]);
      expect(markup).toContain(resources[locale].translation["updates.recheck"]);
      expect(markup).toContain('role="alert"');
      expect(markup).not.toContain(resources[locale].translation["updates.current"]);
      expect(markup).not.toContain("RAW_DIAGNOSTIC_SECRET");
    }
  });
  it("replaces failed feedback with checking, then current after successful retry", async () => {
    let finish!: (value: NativeUpdateStatus) => void;
    controller = createUpdateController({ ...transport, check: vi.fn().mockRejectedValueOnce({ code: "sourceUnavailable" }).mockImplementation(() => new Promise<NativeUpdateStatus>((resolve) => { finish = resolve; })) }, storage);
    await controller.check();
    const retry = controller.check();
    await Promise.resolve();
    const pending = await render("zh-CN");
    expect(pending).toContain(resources["zh-CN"].translation["updates.checking"]);
    expect(pending).not.toContain('role="alert"');
    expect(pending).not.toContain(resources["zh-CN"].translation["updates.current"]);
    finish(native); await retry;
    const complete = await render("zh-CN");
    expect(complete).toContain(resources["zh-CN"].translation["updates.current"]);
    expect(complete).not.toContain('role="alert"');
  });
});
