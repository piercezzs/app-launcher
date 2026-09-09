# Hatch

Local macOS/Windows application launcher client.

## Commands

Run from the workspace root:

```bash
pnpm --filter hatch tauri dev
pnpm --filter hatch check
pnpm --filter hatch tauri build
```

## Current Scope

- Scans macOS applications and Windows Start Menu/UWP entries.
- Launches apps and opens app locations through the local Tauri command layer, without the old browser-plugin/Python localhost bridge.
- Stores user data in the app data directory under `launcher/`:
  - `overlay.json` for groups, names, notes, pinning, hidden state, ordering, and launch stats.
  - `device.json` for custom local app paths.
  - `scan_cache.json` for rebuildable scanned app cache.
