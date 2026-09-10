import { Dialog, type DialogProps } from "@tessera/ui";
import { useRef } from "react";

/** Launcher dialogs can be opened by a menu item that unmounts on selection. */
export function LauncherDialog(props: DialogProps) {
  const opener = useRef<HTMLElement | null>(null);
  return <Dialog {...props}
    onOpenAutoFocus={(event) => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      props.onOpenAutoFocus?.(event);
    }}
    onCloseAutoFocus={(event) => {
      props.onCloseAutoFocus?.(event);
      if (event.defaultPrevented) return;
      event.preventDefault();
      const target = opener.current?.isConnected && opener.current.matches("button, input, [tabindex]") ? opener.current : document.querySelector<HTMLInputElement>(".titlebar-search input");
      target?.focus();
    }} />;
}
