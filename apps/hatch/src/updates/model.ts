export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "ready" | "installing";
export interface UpdateInfo {
  readonly version: string;
  readonly currentVersion: string;
  readonly notes: string | null;
  readonly date: string | null;
}
export interface UpdateProgress {
  readonly downloadedBytes: number;
  readonly totalBytes: number | null;
}
export interface NativeUpdateStatus extends UpdateProgress {
  readonly configured: boolean;
  readonly currentVersion: string;
  readonly phase: UpdatePhase;
  readonly update: UpdateInfo | null;
}
export interface UpdatePreferences {
  readonly automatic: boolean;
  readonly lastAttempt: number;
}
export type UpdateFailure = "initialize" | "check" | "download" | "install" | "blocked";
export interface UpdateSnapshot {
  readonly native: NativeUpdateStatus;
  readonly preferences: UpdatePreferences;
  readonly initialized: boolean;
  readonly checked: boolean;
  readonly busy: boolean;
  readonly failure: UpdateFailure | null;
  readonly failureDetail: string | null;
  readonly preferenceSaveFailed: boolean;
}
export interface UpdateTransport {
  readonly status: () => Promise<NativeUpdateStatus>;
  readonly check: () => Promise<NativeUpdateStatus>;
  readonly download: (progress: (value: UpdateProgress) => void) => Promise<NativeUpdateStatus>;
  readonly install: () => Promise<void>;
}
export const UPDATE_STORAGE_KEY = "hatch.updates.v1";
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PREFERENCES: UpdatePreferences = { automatic: true, lastAttempt: 0 };
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function readUpdatePreferences(storage: PreferenceStorage): UpdatePreferences {
  try {
    const value: unknown = JSON.parse(storage.getItem(UPDATE_STORAGE_KEY) ?? "null");
    if (!value || typeof value !== "object") return DEFAULT_PREFERENCES;
    const data = value as Record<string, unknown>;
    return {
      automatic: typeof data.automatic === "boolean" ? data.automatic : true,
      lastAttempt: typeof data.lastAttempt === "number" && Number.isFinite(data.lastAttempt) && data.lastAttempt >= 0 ? data.lastAttempt : 0,
    };
  } catch { return DEFAULT_PREFERENCES; }
}

export function downloadPercent(value: UpdateProgress): number | undefined {
  if (!value.totalBytes || value.totalBytes <= 0) return undefined;
  return Math.max(0, Math.min(100, Math.floor(value.downloadedBytes / value.totalBytes * 100)));
}

export function createUpdateController(transport: UpdateTransport, storage: PreferenceStorage, now: () => number = Date.now) {
  let snapshot: UpdateSnapshot = {
    native: { configured: false, currentVersion: "", phase: "idle", update: null, downloadedBytes: 0, totalBytes: null },
    preferences: readUpdatePreferences(storage), initialized: false, checked: false, busy: false, failure: null, failureDetail: null, preferenceSaveFailed: false,
  };
  const listeners = new Set<() => void>();
  let initialization: Promise<void> | undefined;
  let ownsOperation = false;
  let refreshPending = false;
  let revision = 0;
  const nativeBusy = (native: NativeUpdateStatus) => ["checking", "downloading", "installing"].includes(native.phase);

  function change(patch: Partial<UpdateSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  }
  function savePreferences(preferences: UpdatePreferences) {
    let preferenceSaveFailed = false;
    try { storage.setItem(UPDATE_STORAGE_KEY, JSON.stringify(preferences)); }
    catch { preferenceSaveFailed = true; }
    change({ preferences, preferenceSaveFailed });
  }
  async function initialize(): Promise<void> {
    if (snapshot.initialized) return;
    if (initialization) return initialization;
    initialization = (async () => {
      try {
        const native = await transport.status();
        change({ native, initialized: true, failure: null, busy: nativeBusy(native) });
      }
      catch { change({ failure: "initialize" }); }
    })();
    await initialization;
    initialization = undefined;
  }
  async function refreshStatus() {
    if (refreshPending || ownsOperation || !snapshot.initialized || !nativeBusy(snapshot.native)) return;
    refreshPending = true;
    const requestRevision = revision;
    try {
      const native = await transport.status();
      if (!ownsOperation && revision === requestRevision) change({ native, busy: nativeBusy(native) });
    } catch { /* Preserve the last known native operation; the next poll can reconnect. */ }
    finally { refreshPending = false; }
  }
  async function check(automatic = false) {
    await initialize();
    if (!snapshot.initialized || !snapshot.native.configured || snapshot.busy || snapshot.native.phase === "installing") return;
    if (automatic && (!snapshot.preferences.automatic || snapshot.native.phase === "ready" || snapshot.native.phase === "available")) return;
    const elapsed = now() - snapshot.preferences.lastAttempt;
    if (automatic && snapshot.preferences.lastAttempt > 0 && elapsed >= 0 && elapsed < AUTO_CHECK_INTERVAL_MS) return;
    revision++;
    ownsOperation = true;
    change({ busy: true, failure: null, failureDetail: null, native: { ...snapshot.native, phase: "checking", update: null, downloadedBytes: 0, totalBytes: null } });
    savePreferences({ ...snapshot.preferences, lastAttempt: now() });
    try { change({ native: await transport.check(), checked: true }); }
    catch { change({ native: { ...snapshot.native, phase: "idle", update: null }, failure: "check", checked: false }); }
    finally { ownsOperation = false; change({ busy: false }); }
  }
  async function download() {
    if (snapshot.busy || snapshot.native.phase !== "available") return;
    revision++;
    ownsOperation = true;
    change({ busy: true, failure: null, failureDetail: null, native: { ...snapshot.native, phase: "downloading", downloadedBytes: 0, totalBytes: null } });
    try {
      const native = await transport.download((progress) => {
        if (snapshot.native.phase === "downloading") change({ native: { ...snapshot.native, ...progress } });
      });
      change({ native });
    } catch { change({ failure: "download", native: { ...snapshot.native, phase: "available", downloadedBytes: 0, totalBytes: null } }); }
    finally { ownsOperation = false; change({ busy: false }); }
  }
  async function install(hasUnsavedWork: boolean) {
    if (hasUnsavedWork) { change({ failure: "blocked" }); return; }
    if (snapshot.busy || snapshot.native.phase !== "ready") return;
    revision++;
    ownsOperation = true;
    change({ busy: true, failure: null, failureDetail: null, native: { ...snapshot.native, phase: "installing" } });
    try { await transport.install(); }
    catch (error) {
      let native: NativeUpdateStatus = { ...snapshot.native, phase: "available", downloadedBytes: 0, totalBytes: null };
      try { native = await transport.status(); } catch { /* A failed installer must never imply a reusable prepared bundle. */ }
      ownsOperation = false;
      change({ failure: "install", failureDetail: String(error).slice(0, 8192), busy: nativeBusy(native), native });
    }
  }
  function setPreferences(patch: Partial<Pick<UpdatePreferences, "automatic">>) {
    if (snapshot.native.phase === "installing") return;
    savePreferences({ ...snapshot.preferences, ...patch });
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    initialize, refreshStatus, check, download, install, setPreferences,
  };
}
