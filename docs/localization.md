# Localization maintenance

The app bundles English and Simplified Chinese dictionaries through i18next and
react-i18next. No translation service or runtime download is used.

- `src/i18n.ts` owns initialization, fallback, preference persistence, typed keys,
  and message descriptors. `src/locales/` owns the actual copy.
- The top-right Settings panel owns the global language preference. Application
  editing and group dialogs do not contain language controls.
- `system`, `zh-CN`, and `en` are the supported preference values. System mode uses
  the primary WebView language, maps Chinese variants to Simplified Chinese, and
  falls back to English for other languages. It responds to `languagechange` when
  the WebView emits that event; restarting also reads the current system setting.
- The preference is stored under `app-launcher.language` in local WebView storage.
  Invalid or inaccessible storage falls back to system mode. Write failures apply
  the language for the current session and display a persistence warning.
- Keep app identifiers, user group names, notes, paths, and app records unchanged.
  System category IDs remain language-independent. Only display labels translate.
- Use message descriptors for transient notifications so existing messages follow
  a language switch. Use Intl for dates, relative times, and locale-aware name
  comparisons. Do not concatenate translated sentence fragments or persist labels.
- User-facing operation failures are localized by the frontend; native diagnostics
  stay in console logs and must not be exposed through untranslated tooltips.
- The shared Dialog accepts a localized close label. It does
  not depend on the application's translation provider. Modal feedback lives inside
  the dialog's accessible content rather than only behind its focus/ARIA boundary.

Run `pnpm check` and `pnpm test`. Check both locales at the standard window size
and a narrow window, including menus, dialogs, long labels, errors, and keyboard
navigation. Verify saved language after a real application restart. Frontend tests
with native API doubles do not establish target-host native behavior.

Maintain `README.md` and `README.zh-CN.md` together. Screenshots under `docs/images/`
come from the native macOS development build using an isolated app identifier and
demonstration profile; the preview config and profile are not shipped or committed.
Do not photograph personal app paths, groups, or launch history. Match each README's
locale, and label development-only features until a published installer includes them.
