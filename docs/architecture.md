# Architecture and acceptance

The pnpm workspace has one desktop product and one internal UI package. Both
TypeScript projects extend `tsconfig.base.json`. The UI exports TypeScript source
and CSS, so Vite builds the complete frontend without a published UI dependency.

React handles presentation and user interaction. Application-local i18next resources
provide English and Simplified Chinese; locale preferences use local WebView
storage and do not change the three JSON data files. See `localization.md`. `src/api.ts` invokes typed
application-local Tauri commands. Rust in `src-tauri/src/launcher.rs` handles
discovery, icons, local application launch, grouping, and JSON persistence.

The JSON files `launcher/device.json`, `launcher/overlay.json`, and
`launcher/scan_cache.json` live under Tauri's OS app-data directory. Runtime app
records combine those inputs. Cache version mismatches trigger rediscovery;
cache invalidation must not delete user-owned groups or custom entries.

`list_apps` runs discovery, icon extraction, and state assembly on a Tauri blocking
worker through an async command. A process-local claim rejects overlapping list
requests instead of queuing scans; success, failure, and worker unwinding release
the claim so a later request can retry. Discovery never holds the store lock.
Short cache/snapshot transactions share a mutex with the existing synchronous
commands, preventing readers from observing a JSON write in progress. Application
launch and reveal operations execute after releasing the snapshot lock. The worker
reads overlay and custom entries after scanning so edits made during discovery
are reflected in its result. These guards coordinate one running app process;
they do not introduce cross-process storage coordination or change JSON formats.
Windows workers initialize COM before Shell icon lookup and release only their own
initialization on that same thread.

The bundle identifier is `com.tessera.app-launcher`. It is retained for application identity and data continuity after the Hatch
rebrand. Installer upgrade detection is a separate platform boundary; see
[the branding transition](releasing.md#hatch-branding-transition).

macOS uses system metadata/icon tools and `/usr/bin/open`. Its platform config
enables native window decorations. Windows uses Start Menu shortcuts,
PowerShell `Get-StartApps`, Shell/GDI APIs, and UWP AUMIDs; the base window config
uses custom title-bar controls. These platform differences are intentional.

## Acceptance still required

- Windows discovery completeness/deduplication, shortcut/executable/UWP icons,
  launch, missing-path errors, cache refresh, standard-user permissions, and DPI.
- Matched populated native-window visual acceptance and resize/menu interactions.
- Physical Intel Mac runtime acceptance.
- Developer ID signing/notarization and Windows publisher signing before treating
  release packages as verified production distribution.

In-app updates, drag-and-drop ordering, and Assets.car-only icon extraction are
future work. The extraction itself preserves the existing application behavior.
