import { describe, expect, it } from "vitest";
import { filterLauncherApps, hasLaunchTime, sortLauncherApps, standardCatalogFilter } from "./catalog";
import type { CatalogFilter } from "./catalog";
import type { LauncherApp } from "./types";

const app = (id: string, overrides: Partial<LauncherApp> = {}): LauncherApp => ({
  id, name: id, path: `/Applications/${id}.app`, args: "", bundleId: "", aumid: "",
  source: "mac_app", group: "", note: "", pinned: false, hidden: false,
  launchCount: 0, lastLaunchedAt: null, order: 0, exists: true, icon: "", ...overrides,
});
const ids = (apps: readonly LauncherApp[]) => apps.map(({ id }) => id);
const catalog = [
  app("work-pinned", { group: "Work", pinned: true, lastLaunchedAt: 100 }),
  app("work-recent", { group: "Work", lastLaunchedAt: 200 }),
  app("work-unused", { group: "Work" }),
  app("ungrouped-pinned", { pinned: true, lastLaunchedAt: 300 }),
  app("ungrouped-unused"),
  app("hidden-pinned", { group: "Work", pinned: true, hidden: true, lastLaunchedAt: 400 }),
] as const;

describe("catalog filtering", () => {
  it("intersects pinned and recent views with custom groups", () => {
    expect(ids(filterLauncherApps(catalog, { view: "pinned", group: "Work", query: "" }))).toEqual(["work-pinned"]);
    expect(ids(filterLauncherApps(catalog, { view: "recent", group: "Work", query: "" }))).toEqual(["work-pinned", "work-recent"]);
  });

  it("distinguishes all groups from ungrouped in every visible view", () => {
    expect(ids(filterLauncherApps(catalog, { view: "pinned", group: null, query: "" }))).toEqual(["work-pinned", "ungrouped-pinned"]);
    expect(ids(filterLauncherApps(catalog, { view: "pinned", group: "", query: "" }))).toEqual(["ungrouped-pinned"]);
    expect(ids(filterLauncherApps(catalog, { view: "recent", group: "", query: "" }))).toEqual(["ungrouped-pinned"]);
    expect(ids(filterLauncherApps(catalog, { view: "all", group: "", query: "" }))).toEqual(["ungrouped-pinned", "ungrouped-unused"]);
  });

  it("excludes hidden apps even when pinned or recent, and allows explicit recovery browsing", () => {
    for (const view of ["all", "pinned", "recent"] as const) {
      expect(ids(filterLauncherApps(catalog, { view, group: null, query: "" }))).not.toContain("hidden-pinned");
    }
    expect(ids(filterLauncherApps(catalog, { view: "hidden", group: null, query: "" }))).toEqual(["hidden-pinned"]);
  });

  it("searches names, notes and paths without case sensitivity and trims the query", () => {
    const apps = [
      app("name", { name: "Sketchbook" }),
      app("note", { note: "Design a SKETCH" }),
      app("path", { path: "/Applications/sketch.app" }),
      app("other", { name: "Notes" }),
    ];
    expect(ids(filterLauncherApps(apps, { view: "all", group: null, query: "  sKeTcH  " }))).toEqual(["name", "note", "path"]);
    expect(ids(filterLauncherApps(catalog, { view: "recent", group: "Work", query: "unused" }))).toEqual([]);
  });

  it("excludes missing, non-finite and non-positive timestamps from recent", () => {
    const timestamps = [null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 123];
    const apps = timestamps.map((lastLaunchedAt, index) => app(String(index), { lastLaunchedAt }));
    expect(apps.map(hasLaunchTime)).toEqual([false, false, false, false, false, false, true]);
    expect(ids(filterLauncherApps(apps, { view: "recent", group: null, query: "" }))).toEqual(["6"]);
  });

  it("maps each standard sidebar selection to the corresponding catalog view and group", () => {
    const cases: readonly (readonly [string, CatalogFilter, readonly string[]])[] = [
      ["all", { view: "all", group: null, query: "" }, ["work-pinned", "work-recent", "work-unused", "ungrouped-pinned", "ungrouped-unused"]],
      ["pinned", { view: "pinned", group: null, query: "" }, ["work-pinned", "ungrouped-pinned"]],
      ["recent", { view: "recent", group: null, query: "" }, ["work-pinned", "work-recent", "ungrouped-pinned"]],
      ["hidden", { view: "hidden", group: null, query: "" }, ["hidden-pinned"]],
      ["ungrouped", { view: "all", group: "", query: "" }, ["ungrouped-pinned", "ungrouped-unused"]],
      ["Work", { view: "all", group: "Work", query: "" }, ["work-pinned", "work-recent", "work-unused"]],
    ];
    for (const [selection, expectedFilter, expectedIds] of cases) {
      expect(standardCatalogFilter(selection, "")).toEqual(expectedFilter);
      expect(ids(filterLauncherApps(catalog, standardCatalogFilter(selection, "")))).toEqual(expectedIds);
    }
    expect(ids(filterLauncherApps(catalog, standardCatalogFilter("Work", "recent")))).toEqual(["work-recent"]);
  });
});

describe("catalog sorting", () => {
  it("sorts default by pinned status, explicit order, then localized name", () => {
    const apps = [
      app("later", { order: 4 }),
      app("zulu", { order: 1 }),
      app("alpha", { order: 1 }),
      app("pinned-later", { pinned: true, order: 9 }),
      app("pinned-first", { pinned: true, order: 2 }),
    ];
    expect(ids(sortLauncherApps(apps, "default", "en"))).toEqual(["pinned-first", "pinned-later", "alpha", "zulu", "later"]);
  });

  it("keeps pinned apps first and applies recent/frequent tie breakers without mutating input", () => {
    const apps = Object.freeze([
      Object.freeze(app("popular-old", { launchCount: 8, lastLaunchedAt: 100 })),
      Object.freeze(app("fresh-low", { launchCount: 1, lastLaunchedAt: 400 })),
      Object.freeze(app("fresh-high", { launchCount: 2, lastLaunchedAt: 400 })),
      Object.freeze(app("popular-new", { launchCount: 8, lastLaunchedAt: 200 })),
      Object.freeze(app("zulu", { launchCount: 0 })),
      Object.freeze(app("alpha", { launchCount: 0, lastLaunchedAt: Number.NaN })),
      Object.freeze(app("pinned", { pinned: true, lastLaunchedAt: null })),
    ]);
    const before = [...apps];
    expect(ids(sortLauncherApps(apps, "recent", "en"))).toEqual(["pinned", "fresh-high", "fresh-low", "popular-new", "popular-old", "alpha", "zulu"]);
    expect(ids(sortLauncherApps(apps, "frequent", "en"))).toEqual(["pinned", "popular-new", "popular-old", "fresh-high", "fresh-low", "alpha", "zulu"]);
    const defaultResult = sortLauncherApps(apps, "default", "en");
    expect(defaultResult).not.toBe(apps);
    expect(apps).toEqual(before);
  });
});
