import { invoke } from "@tauri-apps/api/core";
import type { LaunchAppResult, LauncherState, UpdateAppPayload } from "./types";

export const launcherApi = {
  listApps: (force: boolean): Promise<LauncherState> => invoke("list_apps", { force }),
  launchApp: (id: string): Promise<LaunchAppResult> => invoke("launch_app", { id }),
  openAppLocation: (id: string): Promise<void> => invoke("open_app_location", { id }),
  addCustomApp: (payload: { name: string; path: string; args: string; group: string; note: string; pinned: boolean }): Promise<string> =>
    invoke("add_custom_app", { payload }),
  updateApp: (payload: UpdateAppPayload): Promise<void> => invoke("update_app", { payload }),
  deleteApp: (id: string): Promise<void> => invoke("delete_app", { id }),
  saveGroups: (groups: readonly string[]): Promise<string[]> => invoke("save_groups", { groups }),
  migrateGroup: (from: string, to: string): Promise<number> => invoke("migrate_group", { from, to }),
};
