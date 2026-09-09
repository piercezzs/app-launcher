import { describe, expect, it, vi } from "vitest";
import { AUTO_CHECK_INTERVAL_MS, createUpdateController, downloadPercent, readUpdatePreferences, type NativeUpdateStatus, type UpdateTransport } from "./model";

const idle: NativeUpdateStatus = { configured: true, currentVersion: "0.4.0", phase: "idle", update: null, downloadedBytes: 0, totalBytes: null };
const available: NativeUpdateStatus = { ...idle, phase: "available", update: { version: "0.4.1", currentVersion: "0.4.0", notes: "Update", date: null } };
const ready: NativeUpdateStatus = { ...available, phase: "ready" };
function setup(overrides: Partial<UpdateTransport> = {}) {
  const transport = { status: vi.fn(async () => idle), check: vi.fn(async () => available), download: vi.fn(async () => ready), install: vi.fn(async () => {}), ...overrides };
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  return { transport, storage, controller: createUpdateController(transport, storage, () => AUTO_CHECK_INTERVAL_MS * 10) };
}
describe("application updater lifecycle", () => {
  it("single-flights reconnect polls and reattaches to the native offer", async () => {
    let finish!: (value: NativeUpdateStatus) => void;
    const status = vi.fn().mockResolvedValueOnce({ ...available, phase: "downloading" }).mockImplementation(() => new Promise<NativeUpdateStatus>((resolve) => { finish = resolve; }));
    const { controller, transport } = setup({ status });
    await controller.initialize();
    const first = controller.refreshStatus();
    await controller.refreshStatus();
    expect(status).toHaveBeenCalledTimes(2);
    finish(available); await first;
    await controller.download();
    expect(transport.download).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().native.phase).toBe("ready");
  });
  it("reattaches after a WebView reload during native download, even with automatic checks disabled", async () => {
    const status = vi.fn().mockResolvedValueOnce({ ...available, phase: "downloading" }).mockResolvedValue(ready);
    const { controller, transport } = setup({ status });
    controller.setPreferences({ automatic: false });
    await controller.initialize();
    expect(controller.getSnapshot().busy).toBe(true);
    await controller.check(); expect(transport.check).not.toHaveBeenCalled();
    await controller.refreshStatus();
    expect(controller.getSnapshot().native.phase).toBe("ready");
    expect(controller.getSnapshot().busy).toBe(false);
  });
  it("does not make network checks without a configured public key", async () => {
    const { controller, transport } = setup({ status: async () => ({ ...idle, configured: false }) });
    await controller.check(); await controller.check(true);
    expect(transport.check).not.toHaveBeenCalled();
    expect(controller.getSnapshot().native.configured).toBe(false);
  });
  it("deduplicates overlapping checks", async () => {
    let finish!: (value: NativeUpdateStatus) => void;
    const check = vi.fn(() => new Promise<NativeUpdateStatus>((resolve) => { finish = resolve; }));
    const { controller } = setup({ check });
    await controller.initialize();
    const first = controller.check();
    await Promise.resolve();
    await controller.check();
    expect(check).toHaveBeenCalledTimes(1);
    finish(available); await first;
    expect(controller.getSnapshot().native.phase).toBe("available");
  });
  it("does not download or install when automatic checking finds an update", async () => {
    const { controller, transport } = setup();
    await controller.check(true); await controller.check(true);
    expect(transport.check).toHaveBeenCalledTimes(1);
    expect(transport.download).not.toHaveBeenCalled();
    expect(transport.install).not.toHaveBeenCalled();
  });
  it("honors disabled automatic checks while preserving manual check", async () => {
    const { controller, transport } = setup();
    controller.setPreferences({ automatic: false });
    await controller.check(true); expect(transport.check).not.toHaveBeenCalled();
    await controller.check(); expect(transport.check).toHaveBeenCalledOnce();
  });
  it("recovers after network and signature/download failures without claiming ready", async () => {
    const check = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(available);
    const download = vi.fn().mockRejectedValueOnce(new Error("signature invalid")).mockResolvedValue(ready);
    const { controller } = setup({ check, download });
    await controller.check(); expect(controller.getSnapshot().failure).toBe("check");
    await controller.check(); await controller.download();
    expect(controller.getSnapshot().native.phase).toBe("available");
    expect(controller.getSnapshot().failure).toBe("download");
    await controller.download(); expect(controller.getSnapshot().native.phase).toBe("ready");
  });
  it("blocks installation with unsaved work, retries installation failures", async () => {
    const install = vi.fn().mockRejectedValueOnce(new Error("permission denied")).mockResolvedValue(undefined);
    const { controller } = setup({ install, status: async () => available });
    await controller.install(false); expect(install).not.toHaveBeenCalled();
    await controller.check(); await controller.download(); await controller.install(true);
    expect(install).not.toHaveBeenCalled();
    await controller.install(false); expect(controller.getSnapshot().native.phase).toBe("available");
    expect(controller.getSnapshot().failure).toBe("install");
    await controller.download(); await controller.install(false); expect(install).toHaveBeenCalledTimes(2);
  });
  it("ignores legacy channel preferences while preserving the automatic-check choice", () => {
    const preferences = readUpdatePreferences({ getItem: () => JSON.stringify({ channel: "preview", automatic: false, lastAttempt: 123 }), setItem: () => {} });
    expect(preferences).toEqual({ automatic: false, lastAttempt: 123 });
  });
  it("continues with in-session choices when preference writes fail", () => {
    const { transport } = setup();
    const controller = createUpdateController(transport, { getItem: () => null, setItem: () => { throw Error("denied"); } });
    controller.setPreferences({ automatic: false });
    expect(controller.getSnapshot().preferences.automatic).toBe(false);
    expect(controller.getSnapshot().preferenceSaveFailed).toBe(true);
    expect(readUpdatePreferences({ getItem: () => "broken", setItem: () => {} }).automatic).toBe(true);
  });
  it("handles unknown, zero, and over-reported content lengths", () => {
    expect(downloadPercent({ downloadedBytes: 200, totalBytes: null })).toBeUndefined();
    expect(downloadPercent({ downloadedBytes: 0, totalBytes: 0 })).toBeUndefined();
    expect(downloadPercent({ downloadedBytes: 200, totalBytes: 100 })).toBe(100);
  });
});
