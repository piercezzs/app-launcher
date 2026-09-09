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
enables native window decorations. Windows uses Start Menu, desktop and taskbar shortcuts, App Paths, conservative
uninstall-registry evidence, PowerShell `Get-StartApps`, Shell/GDI APIs, and UWP AUMIDs; the base window config
uses custom title-bar controls. These platform differences are intentional.

## Acceptance still required

- Windows discovery completeness/deduplication, shortcut/executable/UWP icons,
  launch, missing-path errors, cache refresh, standard-user permissions, and DPI.
- Matched populated native-window visual acceptance and resize/menu interactions.
- Physical Intel Mac runtime acceptance.
- Developer ID signing/notarization and Windows publisher signing before treating
  release packages as verified production distribution.

Drag-and-drop ordering and Assets.car-only icon extraction remain future work.

## Whole-package updates

`src/updates` owns typed frontend status, device-local preferences, and update UI.
`src-tauri/src/updater.rs` owns the official updater plugin, a fixed stable update
feed, signature verification, prepared bytes, and installation. No frontend IPC
accepts a URL, signing key, or executable bytes. Missing or malformed production
public keys leave the plugin unregistered and all update commands disabled.

Checks are optional, non-blocking, and throttled to once per 24 hours automatically;
manual checks remain available. Download and installation require separate user
actions. Native single-flight guards reject overlap and release on failure or
cancellation. The frontend reconnects to in-flight native state after WebView reload.
Only verified downloads enter ready; failed installation requires a new download.

Installation drains the existing store transaction mutex and prevents new writes.
JSON files retain their formats and now use atomic temporary-file replacement.
macOS additionally backs up the current app bundle before calling the installer,
restores it on an ordinary installation error or panic, and preserves recovery
files with their path if restoration fails. This is not protection against every
power loss, forced process termination, or storage failure. Windows uses the
NSIS installer lifecycle; its real upgrade behavior still requires Windows testing.

Settings block installation while application/group editing is open or pending.
Application ID, language key, groups, pinned items, custom entries, and launcher
JSON locations are unchanged. Downloads stay in memory and are not resumed across
process restarts. There is no frontend code hot-update mechanism. See
[release setup and acceptance](releasing.md#updater-signing-and-first-installation).

## Windows discovery and cache recovery

The embedded `src-tauri/src/windows_scan.ps1` is application-local, read-only
scanner code. It never launches candidates or executes uninstall commands. It
accepts only existing local absolute EXE paths; network and relative discovery
paths are skipped. Explicit shortcuts take precedence over registry candidates.
Uninstall records need a unique exact normalized product/EXE-name match; ambiguous
or weak evidence is skipped. Portable folders remain manually added custom apps.

The native worker invokes system Windows PowerShell without a console window,
using a temporary script with UTF-8 BOM for Windows PowerShell 5.1. Process output
and execution time are bounded; temporary files and child processes are cleaned
on success or failure. This flag applies only to discovery, not applications the
user deliberately launches. No PowerShell scanning runs on macOS.

The scanner reports items and failed source categories separately. Any failed
source, malformed response, process failure, or timeout rejects the refresh and
leaves the old cache untouched; the UI receives a retryable error. A complete
successful scan can legitimately remove entries, including returning zero apps.
This is conservative all-or-nothing cache replacement, not a partial merge based
on app counts. A version mismatch remains pending after failure so the next load
can retry. macOS retains its existing scanner and cache version.

Windows IDs distinguish full EXE paths, case-sensitive raw argument strings and
working directories. Old IDs are reused only for unique cached path/argument or
AUMID matches; a missing legacy working directory is compatible only when the
match is unique. Ambiguous entries keep new IDs; saved overrides are never
removed or reassigned by EXE basename. Scanned workingDirectory is an optional,
backward-compatible cache field. User groups, overrides and custom-entry formats
retain their ownership and storage locations. Shortcut arguments are passed as a
raw Windows command line and their working directory is respected. A discovered
EXE with no explicit working directory uses its parent directory. Custom non-EXE
launch behavior is unchanged.

Run `scripts/windows/test-app-discovery.ps1` on Windows PowerShell 5.1 for
isolated fixture coverage; CI runs it on the Windows runner. Run
`scripts/windows/diagnose-app-discovery.ps1` for a read-only JSON report of current
sources and failures. Reports contain local application paths; review them before
sharing. Native Windows acceptance must still cover initial startup and refresh
without console flashes, real application discovery/icons/launch, quoted arguments,
working directories, standard-user access, and preservation of saved preferences.
