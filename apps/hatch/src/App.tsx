import { startUpdateChecks } from "./updates/client";
import { useTranslation } from "react-i18next";
import { t, message, formatMessage, type LocalizedMessage, type TranslationKey } from "./i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  EyeOff,
  Field,
  FolderOpen,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Settings,
  TextInput,
} from "@tessera/ui";
import { launcherApi } from "./api";
import { AppActionsMenu } from "./components/AppActionsMenu";
import { AppIcon } from "./components/AppIcon";
import { PaperSelect } from "./components/PaperSelect";
import { WindowTitleBar } from "./components/WindowTitleBar";
import type { LauncherApp, LauncherState } from "./types";

const EMPTY_STATE: LauncherState = { groups: [], apps: [] };
const MIN_REFRESHING_MS = 700;
type SortMode = "default" | "recent" | "frequent";

const SORT_OPTIONS: readonly { key: SortMode; label: TranslationKey }[] = [
  { key: "default", label: "sort.default" },
  { key: "recent", label: "sort.recent" },
  { key: "frequent", label: "sort.frequent" },
];

interface EditDraft {
  readonly id: string | null;
  readonly name: string;
  readonly path: string;
  readonly args: string;
  readonly group: string;
  readonly note: string;
  readonly pinned: boolean;
  readonly isCustom: boolean;
}

interface GroupRenameDraft {
  readonly from: string;
  readonly value: string;
}

export default function App() {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en";
  const [state, setState] = useState<LauncherState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [activeGroup, setActiveGroup] = useState("all");
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<LocalizedMessage | null>(null);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [groupDraft, setGroupDraft] = useState("");
  const [groupRename, setGroupRename] = useState<GroupRenameDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("default");
  const [actionsForId, setActionsForId] = useState<string | null>(null);
  const [openingLocationId, setOpeningLocationId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<LauncherApp | null>(null);
  const [pendingGroupRemoval, setPendingGroupRemoval] = useState<string | null>(null);
  const [groupSelectOpen, setGroupSelectOpen] = useState(false);
  const catalogScrollRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const loadInFlight = useRef<Promise<LauncherState | null> | null>(null);

  useEffect(() => { void load(false); }, []);
  useEffect(startUpdateChecks, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function load(force: boolean): Promise<LauncherState | null> {
    if (loadInFlight.current) return loadInFlight.current;
    const request = performLoad(force);
    loadInFlight.current = request;
    void request.finally(() => {
      if (loadInFlight.current === request) loadInFlight.current = null;
    });
    return request;
  }

  async function performLoad(force: boolean) {
    const startedAt = force ? window.performance.now() : 0;
    if (force) setRefreshing(true);
    else setLoading(true);
    try {
      const nextState = await launcherApi.listApps(force);
      setState(nextState);
      setError(null);
      return nextState;
    } catch (loadError) {
      console.error("Unable to load local applications", loadError);
      setError("load_failed");
      return null;
    } finally {
      if (force) {
        const remaining = MIN_REFRESHING_MS - (window.performance.now() - startedAt);
        if (remaining > 0) await sleep(remaining);
      }
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function rescan() {
    if (loading || refreshing) return;
    setToast(null);
    const previousApps = state.apps;
    const nextState = await load(true);
    if (!nextState) return;
    const previousIds = new Set(previousApps.map((app) => app.id));
    const nextIds = new Set(nextState.apps.map((app) => app.id));
    const added = nextState.apps.filter((app) => !previousIds.has(app.id)).length;
    const removed = previousApps.filter((app) => !nextIds.has(app.id)).length;
    setToast(message("scan.complete", { count: nextState.apps.length, added, removed }));
  }

  async function reloadPreservingCatalogScroll() {
    const scrollTop = catalogScrollRef.current?.scrollTop ?? 0;
    // An edit may finish during a scan. Read again after that snapshot settles.
    if (loadInFlight.current) await loadInFlight.current;
    const nextState = await load(false);
    window.requestAnimationFrame(() => {
      if (catalogScrollRef.current) catalogScrollRef.current.scrollTop = scrollTop;
    });
    return nextState;
  }

  const availableAppTotal = useMemo(() => state.apps.filter((app) => !app.hidden).length, [state.apps]);
  const hiddenAppTotal = useMemo(() => state.apps.filter((app) => app.hidden).length, [state.apps]);
  const visibleApps = useMemo(() => {
    const term = query.trim().toLowerCase();
    const filtered = state.apps.filter((app) => {
      const matchesTerm = !term || app.name.toLowerCase().includes(term) || app.note.toLowerCase().includes(term) || app.path.toLowerCase().includes(term);
      const matchesVisibility = activeGroup === "hidden" ? app.hidden : !app.hidden;
      const matchesGroup = activeGroup === "hidden" || activeGroup === "all" ||
        (activeGroup === "recent" && hasLaunchTime(app)) ||
        (activeGroup === "pinned" && app.pinned) ||
        (activeGroup === "ungrouped" && !app.group) || app.group === activeGroup;
      return matchesTerm && matchesVisibility && matchesGroup;
    });
    return sortLauncherApps(filtered, activeGroup === "recent" ? "recent" : sortMode, locale);
  }, [activeGroup, query, sortMode, state.apps, locale]);
  const pinnedApps = useMemo(() => visibleApps.filter((app) => app.pinned && !app.hidden), [visibleApps]);
  const recentApps = useMemo(() => sortLauncherApps(visibleApps.filter(hasLaunchTime), "recent", locale).slice(0, 5), [visibleApps, locale]);
  const groupSelectOptions = useMemo(() => [
    { value: "", label: t("groups.ungrouped") },
    ...state.groups.map((group) => ({ value: group, label: group })),
  ], [state.groups, locale]);
  const selectedApp = useMemo(
    () => visibleApps.find((app) => app.id === selectedAppId) ?? visibleApps[0] ?? null,
    [selectedAppId, visibleApps],
  );
  const groupTabs = useMemo(() => {
    const counts = new Map<string, number>();
    const availableApps = state.apps.filter((app) => !app.hidden);
    for (const app of availableApps) {
      const key = app.group || "ungrouped";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [
      { key: "all", label: t("groups.all"), count: availableApps.length, alwaysVisible: true },
      { key: "pinned", label: t("groups.pinned"), count: availableApps.filter((app) => app.pinned).length, alwaysVisible: true },
      { key: "recent", label: t("groups.recent"), count: availableApps.filter(hasLaunchTime).length, alwaysVisible: true },
      ...state.groups.map((group) => ({ key: group, label: group, count: counts.get(group) ?? 0, alwaysVisible: true })),
      { key: "ungrouped", label: t("groups.ungrouped"), count: counts.get("ungrouped") ?? 0, alwaysVisible: true },
      { key: "hidden", label: t("groups.hidden"), count: hiddenAppTotal, alwaysVisible: true },
    ].filter((tab) => tab.alwaysVisible || tab.count > 0);
  }, [hiddenAppTotal, state.apps, state.groups, locale]);

  async function launch(app: LauncherApp) {
    if (app.hidden || !app.exists || launchingId) return;
    setLaunchingId(app.id);
    try {
      const result = await launcherApi.launchApp(app.id);
      setState((previous) => ({
        ...previous,
        apps: previous.apps.map((item) => item.id === app.id
          ? { ...item, launchCount: result.launchCount, lastLaunchedAt: result.lastLaunchedAt }
          : item),
      }));
      if (loadInFlight.current) await reloadPreservingCatalogScroll();
      setToast(message("feedback.launched", { name: result.name }));
    } catch (launchError) {
      console.error("Unable to launch application", launchError);
      setToast(message("feedback.launchFailed"));
    } finally { setLaunchingId(null); }
  }

  async function openLocation(app: LauncherApp) {
    setOpeningLocationId(app.id);
    try {
      await launcherApi.openAppLocation(app.id);
      setActionsForId(null);
      setToast(message("feedback.locationOpened"));
    } catch (locationError) {
      console.error("Unable to open application location", locationError);
      setToast(message("feedback.locationFailed"));
    } finally { setOpeningLocationId(null); }
  }

  function openAdd() {
    setEditing({ id: null, name: "", path: "", args: "", group: "", note: "", pinned: false, isCustom: true });
  }

  function openEdit(app: LauncherApp) {
    setActionsForId(null);
    setEditing({ id: app.id, name: app.name, path: app.path, args: app.args, group: app.group, note: app.note, pinned: app.pinned, isCustom: app.source === "custom" });
  }

  async function saveEdit() {
    if (!editing) return;
    const name = editing.name.trim();
    const path = editing.path.trim();
    if (!name) { setToast(message("validation.nameRequired")); return; }
    if (!editing.id && !path) { setToast(message("validation.pathRequired")); return; }
    setSaving(true);
    try {
      if (editing.id) {
        await launcherApi.updateApp({
          id: editing.id, name, group: editing.group.trim(), note: editing.note.trim(), pinned: editing.pinned,
          ...(editing.isCustom ? { path, args: editing.args.trim() } : {}),
        });
      } else {
        await launcherApi.addCustomApp({ name, path, args: editing.args.trim(), group: editing.group.trim(), note: editing.note.trim(), pinned: editing.pinned });
      }
      setEditing(null);
      await reloadPreservingCatalogScroll();
      setToast(message("feedback.appSaved"));
    } catch (saveError) {
      console.error("Unable to save application", saveError);
      setToast(message("feedback.saveFailed"));
    } finally { setSaving(false); }
  }

  function requestRemove(app: LauncherApp) {
    setActionsForId(null);
    if (app.source === "custom") setPendingRemoval(app);
    else void hideOrDelete(app);
  }

  async function hideOrDelete(app: LauncherApp) {
    setSaving(true);
    try {
      await launcherApi.deleteApp(app.id);
      const nextState = await reloadPreservingCatalogScroll();
      if (!nextState?.apps.some((item) => item.id === selectedAppId && !item.hidden)) setSelectedAppId(null);
      setPendingRemoval(null);
      setToast(app.source === "custom" ? message("feedback.appRemoved") : message("feedback.appHidden"));
    } catch (removeError) {
      console.error("Unable to remove application", removeError);
      setToast(app.source === "custom" ? message("feedback.removeFailed") : message("feedback.hideFailed"));
    } finally { setSaving(false); }
  }

  async function restoreApp(app: LauncherApp) {
    setSaving(true);
    try {
      await launcherApi.updateApp({ id: app.id, hidden: false });
      const nextState = await reloadPreservingCatalogScroll();
      if (activeGroup === "hidden" && !nextState?.apps.some((item) => item.hidden)) setActiveGroup("all");
      setToast(message("feedback.appRestored"));
    } catch (restoreError) {
      console.error("Unable to restore application", restoreError);
      setToast(message("feedback.restoreFailed"));
    } finally { setSaving(false); }
  }

  async function togglePin(app: LauncherApp) {
    setActionsForId(null);
    setSaving(true);
    try {
      await launcherApi.updateApp({ id: app.id, pinned: !app.pinned });
      await reloadPreservingCatalogScroll();
      setToast(app.pinned ? message("feedback.unpinned") : message("feedback.pinned"));
    } catch (pinError) {
      console.error("Unable to update pinned state", pinError);
      setToast(message("feedback.pinFailed"));
    } finally { setSaving(false); }
  }

  async function saveGroupList(nextGroups: readonly string[]): Promise<boolean> {
    setSaving(true);
    try {
      const groups = await launcherApi.saveGroups(nextGroups);
      setState((previous) => ({ ...previous, groups }));
      if (loadInFlight.current) await reloadPreservingCatalogScroll();
      setToast(message("feedback.groupsSaved"));
      return true;
    } catch (groupError) {
      console.error("Unable to save groups", groupError);
      setToast(message("feedback.groupsFailed"));
      return false;
    } finally { setSaving(false); }
  }

  async function confirmGroupRemoval() {
    const removing = pendingGroupRemoval;
    if (!removing || saving) return;
    setSaving(true);
    try {
      const moved = await launcherApi.migrateGroup(removing, "");
      setState((previous) => ({
        groups: previous.groups.filter((group) => group !== removing),
        apps: previous.apps.map((app) => app.group === removing ? { ...app, group: "" } : app),
      }));
      if (activeGroup === removing) setActiveGroup("all");
      setGroupRename((previous) => previous?.from === removing ? null : previous);
      setPendingGroupRemoval(null);
      await reloadPreservingCatalogScroll();
      setToast(moved > 0 ? message("feedback.groupMoved", { count: moved }) : message("feedback.groupRemoved"));
    } catch (groupError) {
      console.error("Unable to remove group", groupError);
      setToast(message("feedback.groupRemoveFailed"));
    } finally {
      setSaving(false);
    }
  }

  function closeGroups() {
    if (saving) return;
    setGroupsOpen(false);
    setGroupRename(null);
  }

  async function renameGroup() {
    if (!groupRename || saving) return;
    const from = groupRename.from;
    const next = groupRename.value.trim();
    if (!next) { setToast(message("validation.groupRequired")); return; }
    if (next === from) { setGroupRename(null); return; }
    if (state.groups.includes(next)) { setToast(message("validation.groupExists")); return; }

    setSaving(true);
    try {
      const moved = await launcherApi.migrateGroup(from, next);
      setState((previous) => ({
        groups: previous.groups.map((group) => group === from ? next : group),
        apps: previous.apps.map((app) => app.group === from ? { ...app, group: next } : app),
      }));
      if (activeGroup === from) setActiveGroup(next);
      setGroupRename(null);
      await reloadPreservingCatalogScroll();
      setToast(moved > 0 ? message("feedback.groupMigrated", { count: moved }) : message("feedback.groupRenamed"));
    } catch (groupError) {
      console.error("Unable to rename group", groupError);
      setToast(message("feedback.groupRenameFailed"));
    } finally {
      setSaving(false);
    }
  }

  const listSummary = activeGroup === "hidden"
    ? t("catalog.hidden", { visible: visibleApps.length, count: hiddenAppTotal })
    : t("catalog.available", { visible: visibleApps.length, count: availableAppTotal });

  return (
    <div className="launcher-shell">
      <WindowTitleBar
        hasUnsavedWork={saving || editing !== null || groupsOpen || pendingRemoval !== null || pendingGroupRemoval !== null} query={query} searchInputRef={searchInputRef} searchContext={JSON.stringify([activeGroup, sortMode])} onQueryChange={setQuery} onWindowError={() => setToast(message("feedback.windowFailed"))} />
      <div className="launcher-workspace">
        <aside className="launcher-sidebar" aria-label={t("groups.heading")}>
          <div className="sidebar-heading">
            <span>{t("groups.heading")}</span>
            <button type="button" aria-label={t("groups.manage")} title={t("groups.manage")} onClick={() => setGroupsOpen(true)}><Settings size={16} /></button>
          </div>
          <nav className="group-nav">
            {groupTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={tab.key === activeGroup ? "group-tab group-tab--active" : "group-tab"}
                aria-current={tab.key === activeGroup ? "page" : undefined}
                onClick={() => { setActiveGroup(tab.key); setActionsForId(null); }}
              >
                <span className="group-tab__label"><NavGlyph tabKey={tab.key} /><span className="group-tab__name">{tab.label}</span></span>
                <span className="group-tab__count">{tab.count}</span>
              </button>
            ))}
          </nav>
          <div className="sidebar-motto" aria-hidden="true">
            <p>{t("brand.sidebarMotto")}</p>
          </div>
          <div className="sidebar-footer">
            <Button className="paper-button paper-button--wide" icon={<RefreshCw size={15} />} loading={refreshing} disabled={loading} onClick={() => void rescan()}>
              {refreshing ? t("scan.scanning") : t("scan.rescan")}
            </Button>
            <p>{t("scan.localCount", { count: availableAppTotal })}</p>
          </div>
        </aside>

        <main className="launcher-main">
          <section className="pinned-board" aria-labelledby="pinned-heading">
            <header className="section-heading">
              <h1 id="pinned-heading" className="section-heading__title"><Pin size={15} aria-hidden="true" />{t("pinned.heading")}</h1>
              <Button className="paper-button" icon={<Plus size={15} />} onClick={openAdd}>{t("app.add")}</Button>
            </header>
            <div className="pinned-strip">
              {loading ? <PinnedSkeleton /> : null}
              {!loading && pinnedApps.length === 0 ? <p className="pinned-empty">{t("pinned.empty")}</p> : null}
              {pinnedApps.map((app) => (
                <button key={app.id} type="button" className="pinned-app" disabled={!app.exists || launchingId !== null} aria-label={t("app.launchNamed", { name: app.name })} onClick={() => void launch(app)}>
                  <AppIcon app={app} size="large" /><span title={app.name}>{app.name}</span>{launchingId === app.id ? <small>{t("app.launchingEllipsis")}</small> : null}
                </button>
              ))}
            </div>
          </section>

          <section className="catalog-board" aria-labelledby="catalog-heading">
            <header className="catalog-header">
              <div><span className="section-kicker">{t("catalog.kicker")}</span><h2 id="catalog-heading">{t("catalog.heading")}</h2><p>{listSummary}</p></div>
              <div className="sort-switch" role="radiogroup" aria-label={t("sort.label")}>
                {SORT_OPTIONS.map((option) => (
                  <button key={option.key} type="button" role="radio" aria-checked={sortMode === option.key} className={sortMode === option.key ? "sort-switch__item sort-switch__item--active" : "sort-switch__item"} onClick={() => setSortMode(option.key)}>
                    {t(option.label)}
                  </button>
                ))}
              </div>
            </header>
            {error ? (
              <div className="error-banner" role="alert" >
                <div><strong>{t("error.loadTitle")}</strong><span>{t("error.loadDescription")}</span></div>
                <Button className="paper-button" loading={loading || refreshing} onClick={() => void load(false)}>{t("common.retry")}</Button>
              </div>
            ) : null}
            <div className="catalog-scroll" ref={catalogScrollRef}>
              {loading ? <CatalogSkeleton /> : null}
              {!loading && visibleApps.length === 0 ? (
                <div className="empty-panel">
                  <strong>{query ? t("empty.searchTitle") : t("empty.categoryTitle")}</strong>
                  <span>{query ? t("empty.searchDescription") : t("empty.categoryDescription")}</span>
                  {query ? <Button className="paper-button" onClick={() => { setQuery(""); searchInputRef.current?.focus(); }}>{t("search.clear")}</Button> : null}
                </div>
              ) : null}
              {!loading && visibleApps.length > 0 ? (
                <table className="app-table">
                  <thead><tr><th scope="col">{t("table.app")}</th><th scope="col">{t("table.groupNote")}</th><th scope="col">{t("table.lastLaunch")}</th><th scope="col">{t("table.launchCount")}</th><th scope="col">{t("table.actions")}</th></tr></thead>
                  <tbody>
                    {visibleApps.map((app) => {
                      const selected = selectedApp?.id === app.id;
                      return (
                        <tr key={app.id} className={[selected ? "app-row app-row--selected" : "app-row", !app.exists ? "app-row--missing" : "", app.hidden ? "app-row--hidden" : ""].filter(Boolean).join(" ")}>
                          <td>
                            <button type="button" className="app-identity" aria-label={t("app.viewDetails", { name: app.name })} aria-current={selected ? "true" : undefined} onClick={() => setSelectedAppId(app.id)}>
                              <AppIcon app={app} /><span className="app-identity__copy"><strong title={app.name}>{app.name}</strong><small>{sourceLabel(app)}</small></span>{selected ? <span className="selected-notch" aria-label={t("app.selected")} /> : null}
                            </button>
                          </td>
                          <td><span className="group-note"><strong>{app.group || t("groups.ungrouped")}</strong><small title={app.note}>{app.note || t("app.noNote")}</small></span></td>
                          <td><span className="date-label">{formatLastLaunch(app.lastLaunchedAt, locale)}</span></td>
                          <td><span className="launch-count">{app.launchCount}</span></td>
                          <td>
                            <div className="row-actions">
                              {app.hidden ? (
                                <button type="button" className="launch-button" disabled={saving} onClick={() => void restoreApp(app)}>{t("app.restoreShort")}</button>
                              ) : (
                                <button type="button" className="launch-button" disabled={!app.exists || launchingId !== null} aria-busy={launchingId === app.id} onClick={() => void launch(app)}>
                                  <span className="launch-triangle" aria-hidden="true" />{launchingId === app.id ? t("app.launching") : t("app.launch")}
                                </button>
                              )}
                              <AppActionsMenu
                                app={app} open={actionsForId === app.id} busy={saving} openingLocation={openingLocationId === app.id}
                                onOpenChange={(open) => setActionsForId(open ? app.id : null)} onEdit={() => openEdit(app)}
                                onOpenLocation={() => void openLocation(app)} onTogglePin={() => void togglePin(app)}
                                onRemove={() => requestRemove(app)} onRestore={() => void restoreApp(app)}
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : null}
            </div>
          </section>
        </main>

        <aside className="context-rail" aria-label={t("details.railLabel")}>
          <section className="recent-panel" aria-labelledby="recent-heading">
            <header className="rail-heading"><div><RefreshCw size={16} /><h2 id="recent-heading">{t("recent.heading")}</h2></div><span>{recentApps.length}</span></header>
            <div className="recent-list">
              {recentApps.length === 0 ? <p className="rail-empty">{t("recent.empty")}</p> : null}
              {recentApps.map((app) => (
                <button key={app.id} type="button" className="recent-item" onClick={() => setSelectedAppId(app.id)}>
                  <AppIcon app={app} size="small" /><span><strong>{app.name}</strong><small>{formatLastLaunch(app.lastLaunchedAt, locale)}</small></span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="recent-more"
              onClick={() => { setActiveGroup("recent"); setActionsForId(null); }}
            >
              {t("recent.viewAll")}<span aria-hidden="true">›</span>
            </button>
          </section>
          <section className="detail-panel" aria-labelledby="detail-heading">
            <header className="rail-heading"><div><FolderOpen size={16} /><h2 id="detail-heading">{t("details.heading")}</h2></div></header>
            {selectedApp ? (
              <div className="app-detail">
                <div className="app-detail__identity"><AppIcon app={selectedApp} size="large" /><div><strong>{selectedApp.name}</strong><span>{sourceLabel(selectedApp)}</span></div></div>
                <dl>
                  <div className="detail-note"><dt>{t("app.note")}</dt><dd>{selectedApp.note || t("app.noNote")}</dd></div>
                  <div><dt>{t("app.group")}</dt><dd>{selectedApp.group || t("groups.ungrouped")}</dd></div>
                  <div><dt>{t("table.launchCount")}</dt><dd>{t("details.launchCount", { count: selectedApp.launchCount })}</dd></div>
                  <div><dt>{t("details.lastOpened")}</dt><dd>{formatLastLaunch(selectedApp.lastLaunchedAt, locale)}</dd></div>
                  <div className="detail-path"><dt>{t("details.location")}</dt><dd title={selectedApp.path}>{selectedApp.path || t("details.notProvided")}</dd></div>
                </dl>
                <div className="detail-actions">
                  {selectedApp.hidden ? (
                    <Button className="paper-button paper-button--wide" loading={saving} onClick={() => void restoreApp(selectedApp)}>{t("app.restore")}</Button>
                  ) : (
                    <Button className="paper-button paper-button--terracotta paper-button--wide" disabled={!selectedApp.exists || launchingId !== null} loading={launchingId === selectedApp.id} onClick={() => void launch(selectedApp)}>{t("app.launchFull")}</Button>
                  )}
                  <div><Button className="paper-button" disabled={!selectedApp.path} onClick={() => void openLocation(selectedApp)}>{t("app.openLocationShort")}</Button><Button className="paper-button" onClick={() => openEdit(selectedApp)}>{t("common.edit")}</Button></div>
                  {!selectedApp.hidden ? (
                    <Button className="paper-button paper-button--quiet paper-button--wide" icon={selectedApp.pinned ? <PinOff size={14} /> : <Pin size={14} />} loading={saving} onClick={() => void togglePin(selectedApp)}>
                      {selectedApp.pinned ? t("app.unpin") : t("app.pin")}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : <p className="rail-empty">{t("details.empty")}</p>}
          </section>
        </aside>
      </div>

      <Dialog closeLabel={t("common.close")} feedback={toast ? <p className="dialog-feedback" role="status">{formatMessage(toast)}</p> : undefined}
        open={editing !== null}
        title={editing?.id ? t("editor.editTitle") : t("editor.addTitle")}
        onClose={() => {
          if (saving) return;
          setGroupSelectOpen(false);
          setEditing(null);
        }}
        onEscapeKeyDown={(event) => {
          if (groupSelectOpen) event.preventDefault();
        }}
        footer={<><Button className="paper-button" disabled={saving} onClick={() => { setGroupSelectOpen(false); setEditing(null); }}>{t("common.cancel")}</Button><Button className="paper-button paper-button--terracotta" loading={saving} onClick={() => void saveEdit()}>{t("common.save")}</Button></>}
      >
        {editing ? (
          <div className="form-stack">
            <Field label={t("app.name")}><TextInput autoFocus value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></Field>
            <Field label={t(editing.isCustom ? "app.path" : "app.scannedPath")}><TextInput value={editing.path} disabled={!editing.isCustom} placeholder={t("app.pathExample")} onChange={(event) => setEditing({ ...editing, path: event.target.value })} /></Field>
            <Field label={t("app.args")}><TextInput value={editing.args} disabled={!editing.isCustom} onChange={(event) => setEditing({ ...editing, args: event.target.value })} /></Field>
            <div className="ui-field">
              <span id="app-group-field-label" className="ui-field__label">{t("app.group")}</span>
              <PaperSelect
                value={editing.group}
                options={groupSelectOptions}
                ariaLabelledBy="app-group-field-label"
                onOpenChange={setGroupSelectOpen}
                onValueChange={(group) => setEditing({ ...editing, group })}
              />
            </div>
            <Field label={t("app.note")}><TextInput value={editing.note} onChange={(event) => setEditing({ ...editing, note: event.target.value })} /></Field>
            <Checkbox label={t("app.pin")} checked={editing.pinned} onChange={(event) => setEditing({ ...editing, pinned: event.target.checked })} />
          </div>
        ) : null}
      </Dialog>

      <Dialog closeLabel={t("common.close")} feedback={toast ? <p className="dialog-feedback" role="status">{formatMessage(toast)}</p> : undefined} open={groupsOpen} title={t("groups.title")} onClose={closeGroups} footer={<Button className="paper-button" disabled={saving} onClick={closeGroups}>{t("common.done")}</Button>}>
        <div className="group-editor">
          {state.groups.length === 0 ? <p className="muted">{t("groups.empty")}</p> : null}
          {state.groups.map((group) => (
            <div className="group-editor-row" key={group}>
              {groupRename?.from === group ? (
                <TextInput
                  autoFocus
                  aria-label={t("groups.renameNamed", { name: group })}
                  value={groupRename.value}
                  onChange={(event) => setGroupRename({ from: group, value: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") { event.preventDefault(); void renameGroup(); }
                    if (event.key === "Escape") { event.preventDefault(); setGroupRename(null); }
                  }}
                />
              ) : <span className="group-editor-row__name">{group}</span>}
              <div className="group-editor-row__actions">
                {groupRename?.from === group ? (
                  <>
                    <Button className="paper-button paper-button--quiet" disabled={saving} onClick={() => setGroupRename(null)}>{t("common.cancel")}</Button>
                    <Button className="paper-button paper-button--terracotta" loading={saving} disabled={!groupRename.value.trim()} onClick={() => void renameGroup()}>{t("common.save")}</Button>
                  </>
                ) : (
                  <>
                    <Button className="paper-button paper-button--quiet" disabled={saving} onClick={() => setGroupRename({ from: group, value: group })}>{t("common.rename")}</Button>
                    <Button className="paper-button paper-button--danger" disabled={saving} onClick={() => setPendingGroupRemoval(group)}>{t("common.delete")}</Button>
                  </>
                )}
              </div>
            </div>
          ))}
          <div className="group-add-row"><TextInput value={groupDraft} onChange={(event) => setGroupDraft(event.target.value)} placeholder={t("groups.newName")} /><Button className="paper-button paper-button--terracotta" loading={saving} disabled={!groupDraft.trim() || state.groups.includes(groupDraft.trim())} onClick={() => { const next = groupDraft.trim(); if (!next || state.groups.includes(next)) return; setGroupDraft(""); void saveGroupList([...state.groups, next]); }}>{t("common.add")}</Button></div>
        </div>
      </Dialog>

      <Dialog closeLabel={t("common.close")} feedback={toast ? <p className="dialog-feedback" role="status">{formatMessage(toast)}</p> : undefined} open={pendingRemoval !== null} title={t("remove.title")} onClose={() => !saving && setPendingRemoval(null)} footer={<><Button className="paper-button" disabled={saving} onClick={() => setPendingRemoval(null)}>{t("common.cancel")}</Button><Button className="paper-button paper-button--danger" loading={saving} onClick={() => pendingRemoval && void hideOrDelete(pendingRemoval)}>{t("remove.confirm")}</Button></>}>
        <p className="confirmation-copy">{t("remove.description", { name: pendingRemoval?.name ?? "" })}</p>
      </Dialog>
      <Dialog closeLabel={t("common.close")} feedback={toast ? <p className="dialog-feedback" role="status">{formatMessage(toast)}</p> : undefined} open={pendingGroupRemoval !== null} title={t("groups.delete")} onClose={() => !saving && setPendingGroupRemoval(null)} footer={<><Button className="paper-button" disabled={saving} onClick={() => setPendingGroupRemoval(null)}>{t("common.cancel")}</Button><Button className="paper-button paper-button--danger" loading={saving} onClick={() => void confirmGroupRemoval()}>{t("groups.delete")}</Button></>}>
        <p className="confirmation-copy">{t("groups.deleteDescription", { name: pendingGroupRemoval ?? "" })}</p>
      </Dialog>
      {toast && !editing && !groupsOpen && !pendingRemoval && !pendingGroupRemoval ? <div className="toast" role="status" aria-live="polite">{formatMessage(toast)}</div> : null}
    </div>
  );
}

function PinnedSkeleton() {
  return <div className="pinned-skeleton" role="status" aria-label={t("loading.pinned")}>{[0, 1, 2, 3].map((item) => <span key={item} />)}</div>;
}

function CatalogSkeleton() {
  return <div className="catalog-skeleton" role="status" aria-label={t("loading.apps")}>{[0, 1, 2, 3, 4, 5].map((item) => <span key={item} />)}</div>;
}

function sourceLabel(app: LauncherApp): string {
  if (app.hidden) return t("source.hidden");
  if (!app.exists) return t("source.missing");
  if (app.source === "custom") return t("source.custom");
  if (app.source === "uwp") return t("source.store");
  if (app.source === "start_menu") return t("source.startMenu");
  return t("source.installed");
}

function NavGlyph({ tabKey }: { readonly tabKey: string }) {
  if (tabKey === "all") return <span className="group-tab__grid-icon" aria-hidden="true"><i /><i /><i /><i /></span>;
  if (tabKey === "pinned") return <Pin size={14} aria-hidden="true" />;
  if (tabKey === "recent") return <RefreshCw size={14} aria-hidden="true" />;
  if (tabKey === "hidden") return <EyeOff size={14} aria-hidden="true" />;
  return <FolderOpen size={14} aria-hidden="true" />;
}

function sortLauncherApps(apps: readonly LauncherApp[], sortMode: SortMode, locale: string): LauncherApp[] {
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

function hasLaunchTime(app: LauncherApp): boolean { return timestampValue(app.lastLaunchedAt) > 0; }
function timestampValue(value: number | null): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }

function formatLastLaunch(value: number | null, locale: string): string {
  const timestamp = timestampValue(value);
  if (timestamp <= 0) return t("time.never");
  const elapsed = Date.now() - timestamp;
  if (elapsed >= 0 && elapsed < 60_000) return t("time.justNow");
  if (elapsed >= 0 && elapsed < 3_600_000) return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(-Math.max(1, Math.floor(elapsed / 60_000)), "minute");
  if (elapsed >= 0 && elapsed < 86_400_000) return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(-Math.floor(elapsed / 3_600_000), "hour");
  return new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => window.setTimeout(resolve, ms)); }
