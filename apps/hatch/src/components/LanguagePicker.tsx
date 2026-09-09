import { useId, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
  getLanguagePreference,
  isLanguagePreference,
  setLanguagePreference,
  subscribeLanguagePreference,
  t,
} from "../i18n";

export function LanguagePicker() {
  useTranslation();
  const preference = useSyncExternalStore(subscribeLanguagePreference, getLanguagePreference);
  const [saveFailed, setSaveFailed] = useState(false);
  const errorId = useId();
  return (
    <div className="language-picker">
      <fieldset className="language-options" aria-describedby={saveFailed ? errorId : undefined}>
        <legend>{t("language.label")}</legend>
        {(["system", "zh-CN", "en"] as const).map((value) => (
          <label className="language-option" key={value}>
            <input
              type="radio"
              name="application-language"
              value={value}
              checked={preference === value}
              onChange={(event) => {
                const next = event.target.value;
                if (isLanguagePreference(next)) setSaveFailed(!setLanguagePreference(next));
              }}
            />
            <span>{value === "system" ? t("language.system") : value === "zh-CN" ? "简体中文" : "English"}</span>
          </label>
        ))}
      </fieldset>
      {saveFailed ? <span id={errorId} className="language-picker__error" role="status">{t("language.saveFailed")}</span> : null}
    </div>
  );
}
