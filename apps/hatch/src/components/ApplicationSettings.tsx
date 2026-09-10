import { useId, useRef, useSyncExternalStore } from "react";
import { UpdateSettings } from "../updates/UpdateSettings";
import { updates } from "../updates/client";
import { Button, DialogPrimitive, IconButton, Settings, X } from "@tessera/ui";
import { useTranslation } from "react-i18next";
import { t } from "../i18n";
import { LanguagePicker } from "./LanguagePicker";
import type { InterfaceMode } from "../interface-mode";

interface ApplicationSettingsProps {
  readonly hasUnsavedWork: boolean;
  readonly interfaceMode: InterfaceMode;
  readonly onInterfaceModeChange: (mode: InterfaceMode) => void;
  readonly interfaceModeSaveFailed: boolean;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly hideTrigger?: boolean;
}

export function ApplicationSettings({
  hasUnsavedWork,
  interfaceMode,
  onInterfaceModeChange,
  interfaceModeSaveFailed,
  open,
  onOpenChange,
  hideTrigger = false,
}: ApplicationSettingsProps) {
  const updateState = useSyncExternalStore(updates.subscribe, updates.getSnapshot);
  const hasUpdate = updateState.native.phase === "available" || updateState.native.phase === "ready";
  const modeLabelId = useId();
  const modeHintId = useId();
  const modeErrorId = useId();
  const opener = useRef<HTMLElement | null>(null);
  useTranslation();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {!hideTrigger && <DialogPrimitive.Trigger asChild>
        <Button type="button" className="paper-button settings-trigger" icon={<Settings size={15} />}>
          {t("settings.title")}
          {hasUpdate && <span className="settings-trigger__update" role="img" aria-label={t("updates.notification")} />}
        </Button>
      </DialogPrimitive.Trigger>}
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="ui-dialog-backdrop settings-backdrop" />
        <DialogPrimitive.Content className="ui-dialog settings-panel"
          onOpenAutoFocus={() => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = opener.current?.isConnected && opener.current.matches("button, input, [tabindex]") ? opener.current : document.querySelector<HTMLElement>(".minimal-more-trigger, .settings-trigger");
            target?.focus();
          }}>
          <header className="ui-dialog__head">
            <DialogPrimitive.Title asChild><h2>{t("settings.title")}</h2></DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <IconButton type="button" label={t("common.close")} title={undefined}><X size={16} /></IconButton>
            </DialogPrimitive.Close>
          </header>
          <div className="ui-dialog__body">
            <DialogPrimitive.Description className="settings-description">{t("settings.description")}</DialogPrimitive.Description>
            <div className="interface-mode-field">
              <span id={modeLabelId}>{t("mode.label")}</span>
              <div
                className="interface-mode-options"
                role="radiogroup"
                aria-labelledby={modeLabelId}
                aria-describedby={[
                  hasUnsavedWork ? modeHintId : "",
                  interfaceModeSaveFailed ? modeErrorId : "",
                ].filter(Boolean).join(" ") || undefined}
                aria-disabled={hasUnsavedWork}
              >
                {(["standard", "minimal"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={interfaceMode === value}
                    tabIndex={interfaceMode === value ? 0 : -1}
                    className="interface-mode-option"
                    data-mode={value}
                    disabled={hasUnsavedWork}
                    onClick={() => onInterfaceModeChange(value)}
                    onKeyDown={(event) => {
                      if (hasUnsavedWork) return;
                      const next = event.key === "Home" ? "standard"
                        : event.key === "End" ? "minimal"
                        : ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
                          ? value === "standard" ? "minimal" : "standard"
                          : null;
                      if (next === null) return;
                      event.preventDefault();
                      onInterfaceModeChange(next);
                      event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus();
                    }}
                  >
                    {t(value === "standard" ? "mode.standard" : "mode.minimal")}
                  </button>
                ))}
              </div>
              {hasUnsavedWork && <p id={modeHintId} className="interface-mode-hint">{t("mode.switchBlocked")}</p>}
              {interfaceModeSaveFailed && <p id={modeErrorId} className="interface-mode-error" role="status">{t("mode.saveFailed")}</p>}
            </div>
            <LanguagePicker />
            <UpdateSettings hasUnsavedWork={hasUnsavedWork} />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
