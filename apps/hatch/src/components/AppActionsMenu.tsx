import { useTranslation } from "react-i18next";
import { t } from "../i18n";
import { Check, FolderOpen, MoreHorizontal, Pin, PinOff, Trash2, X } from "@tessera/ui";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import type { LauncherApp } from "../types";

interface AppActionsMenuProps {
  readonly app: LauncherApp;
  readonly open: boolean;
  readonly busy: boolean;
  readonly openingLocation: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onEdit: () => void;
  readonly onOpenLocation: () => void;
  readonly onTogglePin: () => void;
  readonly onRemove: () => void;
  readonly onRestore: () => void;
}

interface MenuPosition {
  readonly top: number;
  readonly left: number;
}

const MENU_FALLBACK_WIDTH = 164;
const VIEWPORT_GUTTER = 12;

export function AppActionsMenu({
  app,
  open,
  busy,
  openingLocation,
  onOpenChange,
  onEdit,
  onOpenLocation,
  onTogglePin,
  onRemove,
  onRestore,
}: AppActionsMenuProps) {
  const { i18n } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<MenuPosition>({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menuWidth = menuRef.current?.offsetWidth ?? MENU_FALLBACK_WIDTH;
      const left = Math.min(window.innerWidth - menuWidth - VIEWPORT_GUTTER, Math.max(VIEWPORT_GUTTER, rect.right - menuWidth));
      const estimatedHeight = menuRef.current?.offsetHeight ?? 176;
      const openAbove = rect.bottom + estimatedHeight + VIEWPORT_GUTTER > window.innerHeight;
      setPosition({
        left,
        top: openAbove ? Math.max(VIEWPORT_GUTTER, rect.top - estimatedHeight - 6) : rect.bottom + 6,
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, i18n.resolvedLanguage]);

  useEffect(() => {
    if (!open) return;

    const focusTimer = window.requestAnimationFrame(() => {
      getEnabledMenuItems(menuRef)[0]?.focus();
    });
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onOpenChange(false);
      triggerRef.current?.focus();
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusTimer);
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onOpenChange, open]);

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = getEnabledMenuItems(menuRef);
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Home") items[0]?.focus();
    if (event.key === "End") items[items.length - 1]?.focus();
    if (event.key === "ArrowDown") items[(currentIndex + 1 + items.length) % items.length]?.focus();
    if (event.key === "ArrowUp") items[(currentIndex - 1 + items.length) % items.length]?.focus();
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="row-more-button"
        aria-label={t("actions.namedMore", { name: app.name })}
        title={t("actions.more")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            onOpenChange(true);
          }
        }}
      >
        <MoreHorizontal size={17} aria-hidden="true" />
      </button>

      {open ? createPortal(
        <div
          ref={menuRef}
          className="app-action-menu"
          role="menu"
          aria-label={t("actions.namedMenu", { name: app.name })}
          style={{ top: position.top, left: position.left }}
          onKeyDown={handleMenuKeyDown}
        >
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
        </div>,
        document.body,
      ) : null}
    </>
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

function getEnabledMenuItems(menuRef: RefObject<HTMLDivElement | null>): HTMLButtonElement[] {
  return Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
}
