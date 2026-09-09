import { useSyncExternalStore } from "react";
import { UpdateSettings } from "../updates/UpdateSettings";
import { updates } from "../updates/client";
import { Button, DialogPrimitive, IconButton, Settings, X } from "@tessera/ui";
import { useTranslation } from "react-i18next";
import { t } from "../i18n";
import { LanguagePicker } from "./LanguagePicker";

export function ApplicationSettings({ hasUnsavedWork }: { readonly hasUnsavedWork: boolean }) {
  const updateState = useSyncExternalStore(updates.subscribe, updates.getSnapshot);
  const hasUpdate = updateState.native.phase === "available" || updateState.native.phase === "ready";
  useTranslation();
  return (
    <DialogPrimitive.Root>
      <DialogPrimitive.Trigger asChild>
        <Button type="button" className="paper-button settings-trigger" icon={<Settings size={15} />}>
          {t("settings.title")}
          {hasUpdate && <span className="settings-trigger__update" role="img" aria-label={t("updates.notification")} />}
        </Button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="ui-dialog-backdrop settings-backdrop" />
        <DialogPrimitive.Content className="ui-dialog settings-panel">
          <header className="ui-dialog__head">
            <DialogPrimitive.Title asChild><h2>{t("settings.title")}</h2></DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <IconButton type="button" label={t("common.close")} title={undefined}><X size={16} /></IconButton>
            </DialogPrimitive.Close>
          </header>
          <div className="ui-dialog__body">
            <DialogPrimitive.Description className="settings-description">{t("settings.description")}</DialogPrimitive.Description>
            <LanguagePicker />
            <UpdateSettings hasUnsavedWork={hasUnsavedWork} />
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
