import type { LauncherApp } from "./types";

export type CatalogView = "all" | "pinned" | "recent" | "hidden";
export type SortMode = "default" | "recent" | "frequent";

export interface CatalogFilter {
  readonly query: string;
  readonly view: CatalogView;
  /** null means all groups, empty string means ungrouped. */
  readonly group: string | null;
}

export function filterLauncherApps(apps: readonly LauncherApp[], filter: CatalogFilter): LauncherApp[] {
  const term = filter.query.trim().toLowerCase();
  return apps.filter((app) => {
    const matchesTerm = !term || [app.name, app.note, app.path].some((value) => value.toLowerCase().includes(term));
    const matchesVisibility = filter.view === "hidden" ? app.hidden : !app.hidden;
    const matchesView = filter.view === "all" || filter.view === "hidden" ||
      (filter.view === "pinned" && app.pinned) || (filter.view === "recent" && hasLaunchTime(app));
    return matchesTerm && matchesVisibility && matchesView && (filter.group === null || app.group === filter.group);
  });
}

export function standardCatalogFilter(activeGroup: string, query: string): CatalogFilter {
  if (activeGroup === "all" || activeGroup === "pinned" || activeGroup === "recent" || activeGroup === "hidden") {
    return { query, view: activeGroup, group: null };
  }
  return { query, view: "all", group: activeGroup === "ungrouped" ? "" : activeGroup };
}

export function sortLauncherApps(apps: readonly LauncherApp[], sortMode: SortMode, locale: string): LauncherApp[] {
  if (sortMode === "default") {
    return [...apps].sort((left, right) => Number(right.pinned) - Number(left.pinned) || left.order - right.order || left.name.localeCompare(right.name, locale));
  }
  return [...apps].sort((left, right) => {
    const pinned = Number(right.pinned) - Number(left.pinned);
    if (pinned) return pinned;
    if (sortMode === "recent") {
      const recent = timestampValue(right.lastLaunchedAt) - timestampValue(left.lastLaunchedAt);
      if (recent) return recent;
      if (right.launchCount !== left.launchCount) return right.launchCount - left.launchCount;
    }
    if (sortMode === "frequent") {
      if (right.launchCount !== left.launchCount) return right.launchCount - left.launchCount;
      const recent = timestampValue(right.lastLaunchedAt) - timestampValue(left.lastLaunchedAt);
      if (recent) return recent;
    }
    return left.name.localeCompare(right.name, locale);
  });
}

export function hasLaunchTime(app: LauncherApp): boolean { return timestampValue(app.lastLaunchedAt) > 0; }
export function timestampValue(value: number | null): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
