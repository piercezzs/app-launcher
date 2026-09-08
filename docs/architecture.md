# Architecture and acceptance

The pnpm workspace has one desktop product and one internal UI package. Both
TypeScript projects extend `tsconfig.base.json`. The UI exports TypeScript source
and CSS, so Vite builds the complete frontend without a published UI dependency.

React handles presentation and user interaction. `src/api.ts` invokes typed
application-local Tauri commands. Rust in `src-tauri/src/launcher.rs` handles
discovery, icons, local application launch, grouping, and JSON persistence.

The JSON files `launcher/device.json`, `launcher/overlay.json`, and
`launcher/scan_cache.json` live under Tauri's OS app-data directory. Runtime app
records combine those inputs. Cache version mismatches trigger rediscovery;
cache invalidation must not delete user-owned groups or custom entries.

The bundle identifier is `com.tessera.app-launcher`. It is retained for data and
installation continuity despite the repository becoming independent.

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
