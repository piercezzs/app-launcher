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
import { BotanicalMark } from "./components/BotanicalMark";
import { PaperSelect } from "./components/PaperSelect";
import { WindowTitleBar } from "./components/WindowTitleBar";
import type { LauncherApp, LauncherState } from "./types";

const EMPTY_STATE: LauncherState = { groups: [], apps: [] };
const MIN_REFRESHING_MS = 700;
type SortMode = "default" | "recent" | "frequent";

const SORT_OPTIONS: readonly { key: SortMode; label: string }[] = [
  { key: "default", label: "默认" },
  { key: "recent", label: "最近" },
  { key: "frequent", label: "常用" },
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
  const [state, setState] = useState<LauncherState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [activeGroup, setActiveGroup] = useState("all");
  const [selectedAppId, setSelectedAppId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
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

  useEffect(() => { void load(false); }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  async function load(force: boolean) {
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
      setError(errorText(loadError));
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
    const changes = [added ? `新增 ${added}` : null, removed ? `移除 ${removed}` : null]
      .filter((item): item is string => item !== null).join("，");
    setToast(changes ? `扫描完成：${nextState.apps.length} 个应用（${changes}）` : `扫描完成：${nextState.apps.length} 个应用`);
  }

  async function reloadPreservingCatalogScroll() {
    const scrollTop = catalogScrollRef.current?.scrollTop ?? 0;
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
    return sortLauncherApps(filtered, activeGroup === "recent" ? "recent" : sortMode);
  }, [activeGroup, query, sortMode, state.apps]);
  const pinnedApps = useMemo(() => visibleApps.filter((app) => app.pinned && !app.hidden), [visibleApps]);
  const recentApps = useMemo(() => sortLauncherApps(visibleApps.filter(hasLaunchTime), "recent").slice(0, 5), [visibleApps]);
  const groupSelectOptions = useMemo(() => [
    { value: "", label: "未分组" },
    ...state.groups.map((group) => ({ value: group, label: group })),
  ], [state.groups]);
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
      { key: "all", label: "全部", count: availableApps.length, alwaysVisible: true },
      { key: "pinned", label: "置顶", count: availableApps.filter((app) => app.pinned).length, alwaysVisible: true },
      { key: "recent", label: "最近使用", count: availableApps.filter(hasLaunchTime).length, alwaysVisible: true },
      ...state.groups.map((group) => ({ key: group, label: group, count: counts.get(group) ?? 0, alwaysVisible: true })),
      { key: "ungrouped", label: "未分组", count: counts.get("ungrouped") ?? 0, alwaysVisible: true },
      { key: "hidden", label: "隐藏", count: hiddenAppTotal, alwaysVisible: true },
    ].filter((tab) => tab.alwaysVisible || tab.count > 0);
  }, [hiddenAppTotal, state.apps, state.groups]);

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
      setToast(`已启动 ${result.name}`);
    } catch (launchError) {
      console.error("Unable to launch application", launchError);
      setToast("启动失败，请检查应用是否仍在原位置");
    } finally { setLaunchingId(null); }
  }

  async function openLocation(app: LauncherApp) {
    setOpeningLocationId(app.id);
    try {
      await launcherApi.openAppLocation(app.id);
      setActionsForId(null);
      setToast("已打开所在文件夹");
    } catch (locationError) {
      console.error("Unable to open application location", locationError);
      setToast("无法打开所在文件夹");
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
    if (!name) { setToast("名称不能为空"); return; }
    if (!editing.id && !path) { setToast("路径不能为空"); return; }
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
      setToast("应用信息已保存");
    } catch (saveError) {
      console.error("Unable to save application", saveError);
      setToast("保存失败，请检查填写内容");
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
      setToast(app.source === "custom" ? "应用已移除" : "应用已隐藏，可在隐藏应用中恢复");
    } catch (removeError) {
      console.error("Unable to remove application", removeError);
      setToast(app.source === "custom" ? "移除失败" : "隐藏失败");
    } finally { setSaving(false); }
  }

  async function restoreApp(app: LauncherApp) {
    setSaving(true);
    try {
      await launcherApi.updateApp({ id: app.id, hidden: false });
      const nextState = await reloadPreservingCatalogScroll();
      if (activeGroup === "hidden" && !nextState?.apps.some((item) => item.hidden)) setActiveGroup("all");
      setToast("应用已恢复");
    } catch (restoreError) {
      console.error("Unable to restore application", restoreError);
      setToast("恢复失败");
    } finally { setSaving(false); }
  }

  async function togglePin(app: LauncherApp) {
    setActionsForId(null);
    setSaving(true);
    try {
      await launcherApi.updateApp({ id: app.id, pinned: !app.pinned });
      await reloadPreservingCatalogScroll();
      setToast(app.pinned ? "已取消置顶" : "已加入置顶应用");
    } catch (pinError) {
      console.error("Unable to update pinned state", pinError);
      setToast("置顶状态更新失败");
    } finally { setSaving(false); }
  }

  async function saveGroupList(nextGroups: readonly string[]): Promise<boolean> {
    setSaving(true);
    try {
      const groups = await launcherApi.saveGroups(nextGroups);
      setState((previous) => ({ ...previous, groups }));
      setToast("分组已保存");
      return true;
    } catch (groupError) {
      console.error("Unable to save groups", groupError);
      setToast("分组保存失败");
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
      setToast(moved > 0 ? `分组已删除，${moved} 个应用已移至未分组` : "分组已删除");
    } catch (groupError) {
      console.error("Unable to remove group", groupError);
      setToast("分组删除失败");
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
    if (!next) { setToast("分组名称不能为空"); return; }
    if (next === from) { setGroupRename(null); return; }
    if (state.groups.includes(next)) { setToast("分组名称已存在"); return; }

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
      setToast(moved > 0 ? `分组已重命名，迁移 ${moved} 个应用` : "分组已重命名");
    } catch (groupError) {
      console.error("Unable to rename group", groupError);
      setToast("分组重命名失败");
    } finally {
      setSaving(false);
    }
  }

  const listSummary = activeGroup === "hidden"
    ? `${visibleApps.length} / ${hiddenAppTotal} 个隐藏项`
    : `${visibleApps.length} / ${availableAppTotal} 个可用项`;

  return (
    <div className="launcher-shell">
      <WindowTitleBar query={query} onQueryChange={setQuery} onWindowError={() => setToast("窗口操作失败，请稍后重试")} />
      <div className="launcher-workspace">
        <aside className="launcher-sidebar" aria-label="应用分类">
          <div className="sidebar-heading">
            <span>应用分类</span>
            <button type="button" aria-label="管理分组" title="管理分组" onClick={() => setGroupsOpen(true)}><Settings size={16} /></button>
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
                <span className="group-tab__label"><NavGlyph tabKey={tab.key} />{tab.label}</span>
                <span className="group-tab__count">{tab.count}</span>
              </button>
            ))}
          </nav>
          <div className="sidebar-motto" aria-hidden="true">
            <BotanicalMark className="sidebar-motto__branch" />
            <p>好的工具，<br />让平凡的日常<br />也有光。</p>
          </div>
          <div className="sidebar-footer">
            <Button className="paper-button paper-button--wide" icon={<RefreshCw size={15} />} loading={refreshing} disabled={loading} onClick={() => void rescan()}>
              {refreshing ? "扫描中" : "重新扫描"}
            </Button>
            <p>{availableAppTotal} 个本地应用</p>
          </div>
        </aside>

        <main className="launcher-main">
          <section className="pinned-board" aria-labelledby="pinned-heading">
            <header className="section-heading">
              <h1 id="pinned-heading" className="section-heading__title"><Pin size={15} aria-hidden="true" />置顶应用</h1>
              <Button className="paper-button" icon={<Plus size={15} />} onClick={openAdd}>添加应用</Button>
            </header>
            <div className="pinned-strip">
              {loading ? <PinnedSkeleton /> : null}
              {!loading && pinnedApps.length === 0 ? <p className="pinned-empty">还没有置顶应用，可从应用行的更多菜单加入。</p> : null}
              {pinnedApps.map((app) => (
                <button key={app.id} type="button" className="pinned-app" disabled={!app.exists || launchingId !== null} aria-label={`启动 ${app.name}`} onClick={() => void launch(app)}>
                  <AppIcon app={app} size="large" /><span title={app.name}>{app.name}</span>{launchingId === app.id ? <small>启动中…</small> : null}
                </button>
              ))}
            </div>
          </section>

          <section className="catalog-board" aria-labelledby="catalog-heading">
            <header className="catalog-header">
              <div><span className="section-kicker">LOCAL CATALOG</span><h2 id="catalog-heading">应用列表</h2><p>{listSummary}</p></div>
              <div className="sort-switch" role="radiogroup" aria-label="排序方式">
                {SORT_OPTIONS.map((option) => (
                  <button key={option.key} type="button" role="radio" aria-checked={sortMode === option.key} className={sortMode === option.key ? "sort-switch__item sort-switch__item--active" : "sort-switch__item"} onClick={() => setSortMode(option.key)}>
                    {option.label}
                  </button>
                ))}
              </div>
            </header>
            {error ? (
              <div className="error-banner" role="alert" title={error}>
                <div><strong>暂时无法读取本机应用</strong><span>原有列表不会被清空。</span></div>
                <Button className="paper-button" onClick={() => void load(false)}>重新尝试</Button>
              </div>
            ) : null}
            <div className="catalog-scroll" ref={catalogScrollRef}>
              {loading ? <CatalogSkeleton /> : null}
              {!loading && visibleApps.length === 0 ? (
                <div className="empty-panel">
                  <strong>{query ? "没有找到匹配的应用" : "此分类中暂无应用"}</strong>
                  <span>{query ? "可以换一个关键词，或清除搜索后继续浏览。" : "可切换分类或重新扫描本机应用。"}</span>
                  {query ? <Button className="paper-button" onClick={() => setQuery("")}>清除搜索</Button> : null}
                </div>
              ) : null}
              {!loading && visibleApps.length > 0 ? (
                <table className="app-table">
                  <thead><tr><th scope="col">应用</th><th scope="col">分组 / 备注</th><th scope="col">最近启动</th><th scope="col">启动次数</th><th scope="col">操作</th></tr></thead>
                  <tbody>
                    {visibleApps.map((app) => {
                      const selected = selectedApp?.id === app.id;
                      return (
                        <tr key={app.id} className={[selected ? "app-row app-row--selected" : "app-row", !app.exists ? "app-row--missing" : "", app.hidden ? "app-row--hidden" : ""].filter(Boolean).join(" ")}>
                          <td>
                            <button type="button" className="app-identity" aria-label={`查看 ${app.name} 的详情`} aria-current={selected ? "true" : undefined} onClick={() => setSelectedAppId(app.id)}>
                              <AppIcon app={app} /><span className="app-identity__copy"><strong title={app.name}>{app.name}</strong><small>{sourceLabel(app)}</small></span>{selected ? <span className="selected-notch" aria-label="当前选中" /> : null}
                            </button>
                          </td>
                          <td><span className="group-note"><strong>{app.group || "未分组"}</strong><small title={app.note}>{app.note || "暂无备注"}</small></span></td>
                          <td><span className="date-label">{formatLastLaunch(app.lastLaunchedAt)}</span></td>
                          <td><span className="launch-count">{app.launchCount}</span></td>
                          <td>
                            <div className="row-actions">
                              {app.hidden ? (
                                <button type="button" className="launch-button" disabled={saving} onClick={() => void restoreApp(app)}>恢复</button>
                              ) : (
                                <button type="button" className="launch-button" disabled={!app.exists || launchingId !== null} aria-busy={launchingId === app.id} onClick={() => void launch(app)}>
                                  <span className="launch-triangle" aria-hidden="true" />{launchingId === app.id ? "启动中" : "启动"}
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

        <aside className="context-rail" aria-label="最近任务与应用信息">
          <section className="recent-panel" aria-labelledby="recent-heading">
            <header className="rail-heading"><div><RefreshCw size={16} /><h2 id="recent-heading">最近任务</h2></div><span>{recentApps.length}</span></header>
            <div className="recent-list">
              {recentApps.length === 0 ? <p className="rail-empty">启动过的应用会出现在这里。</p> : null}
              {recentApps.map((app) => (
                <button key={app.id} type="button" className="recent-item" onClick={() => setSelectedAppId(app.id)}>
                  <AppIcon app={app} size="small" /><span><strong>{app.name}</strong><small>{formatLastLaunch(app.lastLaunchedAt)}</small></span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="recent-more"
              onClick={() => { setActiveGroup("recent"); setActionsForId(null); }}
            >
              查看全部 <span aria-hidden="true">›</span>
            </button>
          </section>
          <section className="detail-panel" aria-labelledby="detail-heading">
            <header className="rail-heading"><div><FolderOpen size={16} /><h2 id="detail-heading">应用信息</h2></div></header>
            {selectedApp ? (
              <div className="app-detail">
                <div className="app-detail__identity"><AppIcon app={selectedApp} size="large" /><div><strong>{selectedApp.name}</strong><span>{sourceLabel(selectedApp)}</span></div></div>
                <dl>
                  <div className="detail-note"><dt>备注</dt><dd>{selectedApp.note || "暂无备注"}</dd></div>
                  <div><dt>分组</dt><dd>{selectedApp.group || "未分组"}</dd></div>
                  <div><dt>启动次数</dt><dd>{selectedApp.launchCount} 次</dd></div>
                  <div><dt>最近打开</dt><dd>{formatLastLaunch(selectedApp.lastLaunchedAt)}</dd></div>
                  <div className="detail-path"><dt>安装位置</dt><dd title={selectedApp.path}>{selectedApp.path || "未提供"}</dd></div>
                </dl>
                <div className="detail-actions">
                  {selectedApp.hidden ? (
                    <Button className="paper-button paper-button--wide" loading={saving} onClick={() => void restoreApp(selectedApp)}>恢复应用</Button>
                  ) : (
                    <Button className="paper-button paper-button--terracotta paper-button--wide" disabled={!selectedApp.exists || launchingId !== null} loading={launchingId === selectedApp.id} onClick={() => void launch(selectedApp)}>启动应用</Button>
                  )}
                  <div><Button className="paper-button" disabled={!selectedApp.path} onClick={() => void openLocation(selectedApp)}>打开位置</Button><Button className="paper-button" onClick={() => openEdit(selectedApp)}>编辑</Button></div>
                  {!selectedApp.hidden ? (
                    <Button className="paper-button paper-button--quiet paper-button--wide" icon={selectedApp.pinned ? <PinOff size={14} /> : <Pin size={14} />} loading={saving} onClick={() => void togglePin(selectedApp)}>
                      {selectedApp.pinned ? "取消置顶" : "加入置顶应用"}
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : <p className="rail-empty">选择一个应用以查看详情。</p>}
          </section>
        </aside>
      </div>

      <Dialog
        open={editing !== null}
        title={editing?.id ? "编辑应用" : "新增应用"}
        onClose={() => {
          if (saving) return;
          setGroupSelectOpen(false);
          setEditing(null);
        }}
        onEscapeKeyDown={(event) => {
          if (groupSelectOpen) event.preventDefault();
        }}
        footer={<><Button className="paper-button" disabled={saving} onClick={() => { setGroupSelectOpen(false); setEditing(null); }}>取消</Button><Button className="paper-button paper-button--terracotta" loading={saving} onClick={() => void saveEdit()}>保存</Button></>}
      >
        {editing ? (
          <div className="form-stack">
            <Field label="名称"><TextInput autoFocus value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></Field>
            <Field label={`路径${editing.isCustom ? "" : "（扫描项不可改）"}`}><TextInput value={editing.path} disabled={!editing.isCustom} placeholder="/Applications/Example.app 或 C:\\Program Files\\Example\\Example.exe" onChange={(event) => setEditing({ ...editing, path: event.target.value })} /></Field>
            <Field label="启动参数"><TextInput value={editing.args} disabled={!editing.isCustom} onChange={(event) => setEditing({ ...editing, args: event.target.value })} /></Field>
            <div className="ui-field">
              <span id="app-group-field-label" className="ui-field__label">分组</span>
              <PaperSelect
                value={editing.group}
                options={groupSelectOptions}
                ariaLabelledBy="app-group-field-label"
                onOpenChange={setGroupSelectOpen}
                onValueChange={(group) => setEditing({ ...editing, group })}
              />
            </div>
            <Field label="备注"><TextInput value={editing.note} onChange={(event) => setEditing({ ...editing, note: event.target.value })} /></Field>
            <Checkbox label="加入置顶应用" checked={editing.pinned} onChange={(event) => setEditing({ ...editing, pinned: event.target.checked })} />
          </div>
        ) : null}
      </Dialog>

      <Dialog open={groupsOpen} title="分组管理" onClose={closeGroups} footer={<Button className="paper-button" disabled={saving} onClick={closeGroups}>完成</Button>}>
        <div className="group-editor">
          {state.groups.length === 0 ? <p className="muted">暂无自定义分组</p> : null}
          {state.groups.map((group) => (
            <div className="group-editor-row" key={group}>
              {groupRename?.from === group ? (
                <TextInput
                  autoFocus
                  aria-label={`重命名分组 ${group}`}
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
                    <Button className="paper-button paper-button--quiet" disabled={saving} onClick={() => setGroupRename(null)}>取消</Button>
                    <Button className="paper-button paper-button--terracotta" loading={saving} disabled={!groupRename.value.trim()} onClick={() => void renameGroup()}>保存</Button>
                  </>
                ) : (
                  <>
                    <Button className="paper-button paper-button--quiet" disabled={saving} onClick={() => setGroupRename({ from: group, value: group })}>重命名</Button>
                    <Button className="paper-button paper-button--danger" disabled={saving} onClick={() => setPendingGroupRemoval(group)}>删除</Button>
                  </>
                )}
              </div>
            </div>
          ))}
          <div className="group-add-row"><TextInput value={groupDraft} onChange={(event) => setGroupDraft(event.target.value)} placeholder="新分组名称" /><Button className="paper-button paper-button--terracotta" loading={saving} disabled={!groupDraft.trim() || state.groups.includes(groupDraft.trim())} onClick={() => { const next = groupDraft.trim(); if (!next || state.groups.includes(next)) return; setGroupDraft(""); void saveGroupList([...state.groups, next]); }}>添加</Button></div>
        </div>
      </Dialog>

      <Dialog open={pendingRemoval !== null} title="确认移除应用" onClose={() => !saving && setPendingRemoval(null)} footer={<><Button className="paper-button" disabled={saving} onClick={() => setPendingRemoval(null)}>取消</Button><Button className="paper-button paper-button--danger" loading={saving} onClick={() => pendingRemoval && void hideOrDelete(pendingRemoval)}>确认移除</Button></>}>
        <p className="confirmation-copy">“{pendingRemoval?.name}”会从 App Launcher 中移除，但不会删除电脑上的应用文件。</p>
      </Dialog>
      <Dialog open={pendingGroupRemoval !== null} title="删除分组" onClose={() => !saving && setPendingGroupRemoval(null)} footer={<><Button className="paper-button" disabled={saving} onClick={() => setPendingGroupRemoval(null)}>取消</Button><Button className="paper-button paper-button--danger" loading={saving} onClick={() => void confirmGroupRemoval()}>删除分组</Button></>}>
        <p className="confirmation-copy">删除“{pendingGroupRemoval}”后，其中的应用会回到“未分组”，应用本身不会被移除。</p>
      </Dialog>
      {toast ? <div className="toast" role="status" aria-live="polite">{toast}</div> : null}
    </div>
  );
}

function PinnedSkeleton() {
  return <div className="pinned-skeleton" role="status" aria-label="正在读取置顶应用">{[0, 1, 2, 3].map((item) => <span key={item} />)}</div>;
}

function CatalogSkeleton() {
  return <div className="catalog-skeleton" role="status" aria-label="正在读取本机应用">{[0, 1, 2, 3, 4, 5].map((item) => <span key={item} />)}</div>;
}

function sourceLabel(app: LauncherApp): string {
  if (app.hidden) return "已隐藏";
  if (!app.exists) return "路径失效";
  if (app.source === "custom") return "自定义";
  if (app.source === "uwp") return "应用商店";
  if (app.source === "start_menu") return "开始菜单";
  return "已安装";
}

function NavGlyph({ tabKey }: { readonly tabKey: string }) {
  if (tabKey === "all") return <span className="group-tab__grid-icon" aria-hidden="true"><i /><i /><i /><i /></span>;
  if (tabKey === "pinned") return <Pin size={14} aria-hidden="true" />;
  if (tabKey === "recent") return <RefreshCw size={14} aria-hidden="true" />;
  if (tabKey === "hidden") return <EyeOff size={14} aria-hidden="true" />;
  return <FolderOpen size={14} aria-hidden="true" />;
}

function sortLauncherApps(apps: readonly LauncherApp[], sortMode: SortMode): LauncherApp[] {
  if (sortMode === "default") {
    return [...apps].sort((left, right) => Number(right.pinned) - Number(left.pinned) || left.order - right.order || left.name.localeCompare(right.name, "zh-CN"));
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
    return left.name.localeCompare(right.name, "zh-CN");
  });
}

function hasLaunchTime(app: LauncherApp): boolean { return timestampValue(app.lastLaunchedAt) > 0; }
function timestampValue(value: number | null): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }

function formatLastLaunch(value: number | null): string {
  const timestamp = timestampValue(value);
  if (timestamp <= 0) return "尚未启动";
  const elapsed = Date.now() - timestamp;
  if (elapsed >= 0 && elapsed < 60_000) return "刚刚";
  if (elapsed >= 0 && elapsed < 3_600_000) return `${Math.max(1, Math.floor(elapsed / 60_000))} 分钟前`;
  if (elapsed >= 0 && elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp));
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => window.setTimeout(resolve, ms)); }
