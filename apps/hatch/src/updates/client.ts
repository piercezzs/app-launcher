import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { createUpdateController, type NativeUpdateStatus, type UpdateProgress } from "./model";

const storage = {
  getItem: (key: string) => window.localStorage.getItem(key),
  setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
};
export const updates = createUpdateController({
  status: () => invoke<NativeUpdateStatus>("update_status"),
  check: () => invoke<NativeUpdateStatus>("check_update"),
  download: (progress) => {
    const onProgress = new Channel<UpdateProgress>();
    onProgress.onmessage = progress;
    return invoke<NativeUpdateStatus>("download_update", { onProgress });
  },
  install: () => invoke<void>("install_update"),
}, storage);

/** Mount at the app root: dialog visibility never owns or cancels a download. */
export function startUpdateChecks(): () => void {
  if (!isTauri()) return () => {};
  void updates.initialize();
  const first = window.setTimeout(() => { void updates.check(true); }, 3000);
  const interval = window.setInterval(() => { void updates.check(true); }, 60 * 60 * 1000);
  const reconnect = window.setInterval(() => { void updates.refreshStatus(); }, 1000);
  return () => { window.clearTimeout(first); window.clearInterval(interval); window.clearInterval(reconnect); };
}
