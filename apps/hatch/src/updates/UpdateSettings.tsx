import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@tessera/ui";
import { t, type TranslationKey } from "../i18n";
import { updates } from "./client";
import { downloadPercent, type UpdateFailure } from "./model";

const errors: Record<UpdateFailure, TranslationKey> = {
  initialize: "updates.error.initialize", check: "updates.error.check", download: "updates.error.download",
  install: "updates.error.install", blocked: "updates.unsaved",
};

export function UpdateSettings({ hasUnsavedWork }: { readonly hasUnsavedWork: boolean }) {
  useTranslation();
  const state = useSyncExternalStore(updates.subscribe, updates.getSnapshot);
  const [confirmInstall, setConfirmInstall] = useState(false);
  const section = useRef<HTMLElement>(null);
  useEffect(() => { if (confirmInstall) section.current?.querySelector<HTMLButtonElement>("[data-update-later]")?.focus(); }, [confirmInstall]);
  const { native, busy, preferences, failure } = state;
  const percent = downloadPercent(native);
  const disabled = !state.initialized || !native.configured;
  const notes = native.update?.notes;
  const action = native.phase;
  return (
    <section ref={section} className="update-settings" aria-labelledby="update-settings-title" aria-busy={busy}>
      <div className="update-settings__heading"><h3 id="update-settings-title">{t("updates.title")}</h3><span>{native.currentVersion || "—"}</span></div>
      <label className="update-settings__automatic"><input type="checkbox" checked={preferences.automatic} disabled={action === "installing"} onChange={(event) => updates.setPreferences({ automatic: event.target.checked })} />{t("updates.automatic")}</label>
      {state.preferenceSaveFailed && <p className="update-settings__error" role="alert">{t("updates.preferenceFailed")}</p>}
      <div className="update-settings__status" role="status" aria-live="polite">
        {!state.initialized ? <p>{t("updates.loading")}</p> : !native.configured ? <p>{t("updates.unconfigured")}</p> : <>
          {action === "idle" && !failure && <p>{t(state.checked ? "updates.current" : "updates.notChecked")}</p>}
          {action === "checking" && <p>{t("updates.checking")}</p>}
          {action === "available" && native.update && <strong>{t("updates.available", { version: native.update.version })}</strong>}
          {action === "downloading" && <><p>{percent === undefined ? t("updates.downloading") : t("updates.progress", { percent })}</p><progress max={100} value={percent} aria-label={t("updates.downloading")} /><p className="update-settings__hint">{t("updates.downloadHint")}</p></>}
          {action === "ready" && <strong>{t("updates.ready")}</strong>}
          {action === "installing" && <p>{t("updates.installing")}</p>}
        </>}
      </div>
      {notes && (action === "available" || action === "ready") && <div className="update-settings__notes" tabIndex={0} aria-label={t("updates.notes")}>{notes.slice(0, 16000)}</div>}
      {failure && <p className="update-settings__error" role="alert">{t(errors[failure])}</p>}
      {failure === "install" && state.failureDetail && <p className="update-settings__error update-settings__details">{state.failureDetail}</p>}
      {action === "ready" && hasUnsavedWork && <p className="update-settings__notice">{t("updates.unsaved")}</p>}
      {confirmInstall && action === "ready" ? <div className="update-settings__confirmation">
        <p>{t("updates.confirm")}</p><div className="update-settings__actions"><Button type="button" className="paper-button" data-update-later onClick={() => { setConfirmInstall(false); requestAnimationFrame(() => section.current?.querySelector<HTMLButtonElement>("[data-update-install]")?.focus()); }}>{t("updates.later")}</Button><Button type="button" className="paper-button paper-button--terracotta" disabled={hasUnsavedWork || busy} onClick={() => { setConfirmInstall(false); void updates.install(hasUnsavedWork); }}>{t("updates.installRestart")}</Button></div>
      </div> : <div className="update-settings__actions">
        {(!state.initialized || action === "idle" || action === "checking" || action === "available") && <Button type="button" className="paper-button" loading={action === "checking"} disabled={busy || (state.initialized && !native.configured)} onClick={() => void updates.check()}>{t(state.checked || failure ? "updates.recheck" : "updates.check")}</Button>}
        {(action === "available" || action === "downloading") && <Button type="button" className="paper-button paper-button--terracotta" loading={action === "downloading"} disabled={busy || disabled} onClick={() => void updates.download()}>{t(failure === "download" || failure === "install" ? "updates.retryDownload" : "updates.download")}</Button>}
        {(action === "ready" || action === "installing") && <Button type="button" className="paper-button paper-button--terracotta" data-update-install loading={action === "installing"} disabled={busy || hasUnsavedWork || disabled} onClick={() => setConfirmInstall(true)}>{t("updates.install")}</Button>}
      </div>}
    </section>
  );
}
