import { useTranslation } from "react-i18next";
import { t } from "../i18n";
import { Check, FolderOpen, MoreHorizontal, Pin, PinOff, Trash2, X } from "@tessera/ui";
import { ActionMenu } from "./ActionMenu";
import type { LauncherApp } from "../types";

interface AppActionsMenuProps {
  readonly app: LauncherApp;
  readonly open: boolean;
  readonly busy: boolean;
  readonly openingLocation: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onEdit: () => void;
  readonly onDetails?: () => void;
  readonly onOpenLocation: () => void;
  readonly onTogglePin: () => void;
  readonly onRemove: () => void;
  readonly onRestore: () => void;
}
export function AppActionsMenu({
  app,
  open,
  busy,
  openingLocation,
  onOpenChange,
  onEdit,
  onDetails,
  onOpenLocation,
  onTogglePin,
  onRemove,
  onRestore,
}: AppActionsMenuProps) {
  useTranslation();
  return (
    <ActionMenu label={t("actions.namedMore", { name: app.name })} open={open} onOpenChange={onOpenChange}>
      {onDetails ? <MenuItem icon={<MoreHorizontal size={15} />} onClick={onDetails}>{t("details.heading")}</MenuItem> : null}
          {app.hidden ? (
            <MenuItem icon={<Check size={15} />} disabled={busy} onClick={onRestore}>{t("app.restore")}</MenuItem>
          ) : (
            <>
              <MenuItem icon={<MoreHorizontal size={15} />} onClick={onEdit}>{t("actions.edit")}</MenuItem>
              <MenuItem icon={<FolderOpen size={15} />} disabled={!app.path || openingLocation} onClick={onOpenLocation}>
                {openingLocation ? t("actions.opening") : t("actions.openFolder")}
              </MenuItem>
              <MenuItem icon={app.pinned ? <PinOff size={15} /> : <Pin size={15} />} disabled={busy} onClick={onTogglePin}>
                {app.pinned ? t("actions.unpin") : t("actions.pin")}
              </MenuItem>
              <MenuItem
                icon={app.source === "custom" ? <Trash2 size={15} /> : <X size={15} />}
                disabled={busy}
                danger
                onClick={onRemove}
              >
                {app.source === "custom" ? t("actions.remove") : t("actions.hide")}
              </MenuItem>
            </>
          )}
    </ActionMenu>
  );
}

interface MenuItemProps {
  readonly children: string;
  readonly icon: React.ReactNode;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  readonly onClick: () => void;
}

function MenuItem({ children, icon, disabled = false, danger = false, onClick }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={danger ? "app-action-item app-action-item--danger" : "app-action-item"}
      disabled={disabled}
      onClick={onClick}
    >
      <span aria-hidden="true">{icon}</span>
      <span>{children}</span>
    </button>
  );
}
