import { MoreHorizontal } from "@tessera/ui";
import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

interface ActionMenuProps {
  readonly label: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly children: ReactNode;
  readonly className?: string;
  readonly triggerClassName?: string;
  readonly notification?: string;
}

/** Shared anchored menu for catalog items and launcher-level commands. */
export function ActionMenu({ label, open, onOpenChange, children, className = "", triggerClassName = "", notification }: ActionMenuProps) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)') ?? []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!rect || !menu) return;
      setPosition({
        left: Math.max(12, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 12)),
        top: rect.bottom + menu.offsetHeight + 18 > window.innerHeight
          ? Math.max(12, rect.top - menu.offsetHeight - 6) : rect.bottom + 6,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, children]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => items()[0]?.focus());
    const outside = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!menuRef.current?.contains(node) && !triggerRef.current?.contains(node)) onOpenChange(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => { window.cancelAnimationFrame(frame); document.removeEventListener("pointerdown", outside); };
  }, [open]);

  return <>
    <button ref={triggerRef} type="button" className={`row-more-button ${triggerClassName}`} aria-label={label} title={label}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => onOpenChange(!open)} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); onOpenChange(true); }
      }}>
      <MoreHorizontal size={17} aria-hidden="true" />
      {notification ? <span className="settings-trigger__update" role="img" aria-label={notification} /> : null}
    </button>
    {open ? createPortal(<div id={id} ref={menuRef} className={`app-action-menu ${className}`} role="menu" aria-label={label}
      style={position}
      onClick={(event) => {
        const item = (event.target as HTMLElement).closest<HTMLButtonElement>('button[role^="menuitem"]');
        if (!item || item.disabled) return;
        // Run after the item's action; closing during capture can unmount it
        // before its click handler runs. React commits the dialog after bubbling.
        triggerRef.current?.focus();
        onOpenChange(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onOpenChange(false); triggerRef.current?.focus(); return; }
        if (event.key === "Tab") { onOpenChange(false); triggerRef.current?.focus(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const enabled = items();
        if (!enabled.length) return;
        const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "Home") enabled[0]?.focus();
        else if (event.key === "End") enabled[enabled.length - 1]?.focus();
        else enabled[(index + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length]?.focus();
      }}>{children}</div>, document.body) : null}
  </>;
}
