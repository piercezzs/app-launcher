import { getCurrentWindow } from "@tauri-apps/api/window";
import { Search, X } from "@tessera/ui";
import type { MouseEvent } from "react";
import { BotanicalMark } from "./BotanicalMark";

interface WindowTitleBarProps {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly onWindowError: () => void;
}

type WindowAction = "minimize" | "maximize" | "close";

export function WindowTitleBar({ query, onQueryChange, onWindowError }: WindowTitleBarProps) {
  const isMacOS = document.documentElement.dataset.platform === "macos";

  async function runWindowAction(action: WindowAction) {
    try {
      const appWindow = getCurrentWindow();
      if (action === "minimize") await appWindow.minimize();
      if (action === "maximize") await appWindow.toggleMaximize();
      if (action === "close") await appWindow.close();
    } catch (error) {
      console.error(`Window action failed: ${action}`, error);
      onWindowError();
    }
  }

  function handleTitleBarDoubleClick(event: MouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (isMacOS || target.closest("button, input")) return;
    void runWindowAction("maximize");
  }

  return (
    <header
      className="window-titlebar"
      data-tauri-drag-region
      onDoubleClick={handleTitleBarDoubleClick}
    >
      <div className="window-brand" data-tauri-drag-region>
        <span className="window-brand__mark" aria-hidden="true" data-tauri-drag-region>
          <BotanicalMark className="window-brand__leaf" />
        </span>
        <span data-tauri-drag-region>
          <strong data-tauri-drag-region>App Launcher</strong>
          <small data-tauri-drag-region>本机应用启动器</small>
        </span>
      </div>

      <label className="titlebar-search">
        <span className="visually-hidden">搜索应用、备注或路径</span>
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder="搜索应用、备注或路径"
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {query ? (
          <button
            type="button"
            className="titlebar-search__clear"
            aria-label="清除搜索"
            title="清除搜索"
            onClick={() => onQueryChange("")}
          >
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </label>

      <p className="window-motto" data-tauri-drag-region>在本地，遇见更好的自己。</p>

      {!isMacOS ? (
        <div className="window-controls" aria-label="窗口控制">
          <button type="button" aria-label="最小化" title="最小化" onClick={() => void runWindowAction("minimize")}>
            <span aria-hidden="true">—</span>
          </button>
          <button type="button" aria-label="最大化或还原" title="最大化或还原" onClick={() => void runWindowAction("maximize")}>
            <span aria-hidden="true">□</span>
          </button>
          <button className="window-control--close" type="button" aria-label="关闭" title="关闭" onClick={() => void runWindowAction("close")}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      ) : null}
    </header>
  );
}
