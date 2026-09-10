import { Button } from "@tessera/ui";
import { useId, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { t } from "../i18n";
import type { CatalogView } from "../catalog";
import type { LauncherApp } from "../types";
import { AppActionsMenu } from "./AppActionsMenu";
import { AppIcon } from "./AppIcon";
import { PaperSelect } from "./PaperSelect";

interface MinimalCatalogProps {
  readonly apps: readonly LauncherApp[];
  readonly groups: readonly string[];
  readonly view: Exclude<CatalogView, "hidden">;
  readonly group: string | null;
  readonly query: string;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly error: boolean;
  readonly saving: boolean;
  readonly launchingId: string | null;
  readonly actionsForId: string | null;
  readonly openingLocationId: string | null;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly onViewChange: (view: Exclude<CatalogView, "hidden">) => void;
  readonly onGroupChange: (group: string | null) => void;
  readonly onClearSearch: () => void;
  readonly onRetry: () => void;
  readonly onRescan: () => void;
  readonly onActionsChange: (id: string | null) => void;
  readonly onLaunch: (app: LauncherApp) => void;
  readonly onDetails: (app: LauncherApp) => void;
  readonly onEdit: (app: LauncherApp) => void;
  readonly onOpenLocation: (app: LauncherApp) => void;
  readonly onTogglePin: (app: LauncherApp) => void;
  readonly onRemove: (app: LauncherApp) => void;
  readonly onRestore: (app: LauncherApp) => void;
}

export function MinimalCatalog(props: MinimalCatalogProps) {
  useTranslation();
  const groupLabel = useId();
  // Values are encoded so a user-defined group cannot collide with built-in options.
  const options = [
    { value: "all", label: t("minimal.allGroups") },
    { value: JSON.stringify(""), label: t("groups.ungrouped") },
    ...props.groups.map((group) => ({ value: JSON.stringify(group), label: group })),
  ];
  const emptyTitle = props.query ? t("empty.searchTitle") : props.view === "pinned"
    ? t("minimal.emptyPinnedTitle") : props.view === "recent" ? t("minimal.emptyRecentTitle") : t("empty.categoryTitle");
  const emptyDescription = props.query ? t("empty.searchDescription") : props.view === "pinned"
    ? t("minimal.emptyPinnedDescription") : props.view === "recent" ? t("minimal.emptyRecentDescription") : t("empty.categoryDescription");

  return <main className="minimal-workspace">
    <nav className="minimal-filterbar" aria-label={t("groups.heading")}>
      <div className="minimal-tabs">
        {(["all", "pinned", "recent"] as const).map((view) => <button key={view} type="button"
          className={`minimal-tab${view === props.view ? " minimal-tab--active" : ""}`}
          aria-pressed={view === props.view} onClick={() => props.onViewChange(view)}>
          {t(view === "recent" ? "minimal.recent" : view === "all" ? "groups.all" : "groups.pinned")}
        </button>)}
      </div>
      <div className="minimal-group-filter">
        <span id={groupLabel} className="visually-hidden">{t("minimal.groupFilter")}</span>
        <PaperSelect ariaLabelledBy={groupLabel} value={props.group === null ? "all" : JSON.stringify(props.group)} options={options}
          onValueChange={(value) => props.onGroupChange(value === "all" ? null : value === JSON.stringify("") ? "" : props.groups.find((group) => JSON.stringify(group) === value) ?? null)} />
      </div>
    </nav>
    {props.error ? <div className="error-banner" role="alert">
      <div><strong>{t("error.loadTitle")}</strong><span>{t("error.loadDescription")}</span></div>
      <Button className="paper-button" loading={props.loading || props.refreshing} onClick={props.onRetry}>{t("common.retry")}</Button>
    </div> : null}
    <div className="minimal-catalog" ref={props.scrollRef} aria-label={t("catalog.heading")} aria-busy={props.loading || props.refreshing}>
      {props.loading ? <div className="minimal-empty" role="status"><span className="ui-spinner" aria-hidden="true" /><strong>{t("loading.apps")}</strong></div> : null}
      {!props.loading && !props.error && props.apps.length === 0 ? <div className="minimal-empty">
        <strong>{emptyTitle}</strong><span>{emptyDescription}</span>
        {props.query ? <Button className="paper-button" onClick={props.onClearSearch}>{t("search.clear")}</Button> :
          props.view !== "all" || props.group !== null ? <Button className="paper-button" onClick={() => { props.onViewChange("all"); props.onGroupChange(null); }}>{t("recent.viewAll")}</Button> :
            <Button className="paper-button" loading={props.refreshing} onClick={props.onRescan}>{t("scan.rescan")}</Button>}
      </div> : null}
      {!props.loading ? <div className="minimal-grid">
        {props.apps.map((app) => <div key={app.id} className={`minimal-tile${!app.exists ? " minimal-tile--missing" : ""}`}>
          <button type="button" className="minimal-launch" title={app.name}
            aria-label={t(app.exists ? "app.launchNamed" : "app.viewDetails", { name: app.name })}
            aria-busy={props.launchingId === app.id} disabled={app.hidden || props.launchingId !== null}
            onClick={() => app.exists ? props.onLaunch(app) : props.onDetails(app)}>
            <AppIcon app={app} size="large" /><span className="minimal-app-name">{app.name}</span>
            {props.launchingId === app.id ? <span className="minimal-app-state">{t("app.launchingEllipsis")}</span> :
              !app.exists ? <span className="minimal-app-state">{t("source.missing")}</span> : null}
          </button>
          <AppActionsMenu app={app} open={props.actionsForId === app.id} busy={props.saving} openingLocation={props.openingLocationId === app.id}
            onOpenChange={(open) => props.onActionsChange(open ? app.id : null)} onDetails={() => props.onDetails(app)}
            onEdit={() => props.onEdit(app)} onOpenLocation={() => props.onOpenLocation(app)} onTogglePin={() => props.onTogglePin(app)}
            onRemove={() => props.onRemove(app)} onRestore={() => props.onRestore(app)} />
        </div>)}
      </div> : null}
    </div>
  </main>;
}
