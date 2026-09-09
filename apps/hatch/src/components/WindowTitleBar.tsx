import { ApplicationSettings } from "./ApplicationSettings";
import { useTranslation } from "react-i18next";
import { t } from "../i18n";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Search, X } from "@tessera/ui";
import type { MouseEvent, RefObject } from "react";
import { useSearchQuery } from "./useSearchQuery";
import hatchIcon from "../assets/hatch-icon.png";

interface WindowTitleBarProps {
  readonly hasUnsavedWork: boolean;
  readonly query: string;
  readonly searchContext: string;
  readonly searchInputRef: RefObject<HTMLInputElement | null>;
  readonly onQueryChange: (query: string) => void;
  readonly onWindowError: () => void;
}

type WindowAction = "minimize" | "maximize" | "close";

export function WindowTitleBar({ hasUnsavedWork, query, searchContext, searchInputRef: inputRef, onQueryChange, onWindowError }: WindowTitleBarProps) {
  useTranslation();
  const search = useSearchQuery(query, onQueryChange, searchContext);
  function clearSearch() {
    search.clear();
    inputRef.current?.focus();
  }
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
          <img className="window-brand__icon" src={hatchIcon} alt="" draggable={false} />
        </span>
        <span data-tauri-drag-region>
          <strong data-tauri-drag-region>Hatch</strong>
          <small data-tauri-drag-region>{t("brand.subtitle")}</small>
        </span>
      </div>

      <div className="titlebar-search-area">
      <label className="titlebar-search">
        <span className="visually-hidden">{t("search.placeholder")}</span>
        <Search size={16} aria-hidden="true" />
        <input
          type="search"
          ref={inputRef}
          value={search.draft}
          placeholder={t("search.placeholder")}
          onChange={(event) => search.change(event.currentTarget.value)}
          onCompositionStart={search.compositionStart}
          onCompositionEnd={(event) => search.compositionEnd(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && event.keyCode !== 229) {
              event.preventDefault();
              search.flush();
            }
          }}
        />
        {search.draft ? (
          <button
            type="button"
            className="titlebar-search__clear"
            aria-label={t("search.clear")}
            title={t("search.clear")}
            onClick={clearSearch}
          >
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </label>
      </div>

      <div className="titlebar-tools">
        <p className="window-motto" data-tauri-drag-region>{t("brand.motto")}</p>
        <ApplicationSettings hasUnsavedWork={hasUnsavedWork} />
      </div>

      {!isMacOS ? (
        <div className="window-controls" aria-label={t("window.controls")}>
          <button type="button" aria-label={t("window.minimize")} title={t("window.minimize")} onClick={() => void runWindowAction("minimize")}>
            <span aria-hidden="true">—</span>
          </button>
          <button type="button" aria-label={t("window.maximize")} title={t("window.maximize")} onClick={() => void runWindowAction("maximize")}>
            <span aria-hidden="true">□</span>
          </button>
          <button className="window-control--close" type="button" aria-label={t("common.close")} title={t("common.close")} onClick={() => void runWindowAction("close")}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      ) : null}
    </header>
  );
}
