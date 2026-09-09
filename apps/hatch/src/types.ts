export interface LauncherApp {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly args: string;
  readonly bundleId: string;
  readonly aumid: string;
  readonly source: "mac_app" | "start_menu" | "uwp" | "custom" | "unsupported";
  readonly group: string;
  readonly note: string;
  readonly pinned: boolean;
  readonly hidden: boolean;
  readonly launchCount: number;
  readonly lastLaunchedAt: number | null;
  readonly order: number;
  readonly exists: boolean;
  readonly icon: string;
}

export interface LauncherState {
  readonly groups: readonly string[];
  readonly apps: readonly LauncherApp[];
}

export interface UpdateAppPayload {
  readonly id: string;
  readonly name?: string;
  readonly group?: string;
  readonly note?: string;
  readonly pinned?: boolean;
  readonly hidden?: boolean;
  readonly path?: string;
  readonly args?: string;
}

export interface LaunchAppResult {
  readonly name: string;
  readonly launchCount: number;
  readonly lastLaunchedAt: number;
}
