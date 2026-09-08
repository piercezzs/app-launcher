# App Launcher

A local-first application launcher for macOS and Windows, built with Tauri 2,
React, and Rust. Search installed applications, organize them into groups, pin
favorites, and add your own local launch entries.

## Features

- Search, groups, pinned applications, recent launches, and hidden entries.
- macOS application discovery and Windows Start Menu / UWP discovery.
- Native application icons with a placeholder when extraction is unavailable.
- Custom local application paths and launch arguments.
- Paper-inspired interface with platform-specific window controls.
- Device-local data; no account or remote service is required for launching apps.

## Download and platform status

Download published installers from [Releases](https://github.com/piercezzs/app-launcher/releases).
Before the first release, CI installers are available as signed-in GitHub workflow
artifacts from [Actions](https://github.com/piercezzs/app-launcher/actions).

| Platform | Build target | Acceptance status |
| --- | --- | --- |
| macOS Apple Silicon | `aarch64-apple-darwin` | Prior local runtime evidence; ongoing visual acceptance |
| macOS Intel | `x86_64-apple-darwin` | Build target; physical Intel acceptance pending |
| Windows x64 | `x86_64-pc-windows-msvc` | Implemented; real-host scan, icons, launch and window acceptance pending |

Linux and mobile applications are not supported. Platform-specific build success
does not establish runtime acceptance on that platform.

Current CI macOS packages use ad-hoc signing and are **not notarized**. Windows
installers are **not Authenticode-signed**. Downloaded packages can trigger system
security prompts; do not disable system security globally. Developer ID signing,
notarization, and Windows publisher signing are separate release tasks.

In-app updates are not implemented yet. Install a newer release manually.

## Development

Install Node.js 22 (22.12 or later), pnpm 10.25.0, Rust, and the
[Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).
macOS requires Xcode command-line tools. Windows requires MSVC C++ build tools
and WebView2.

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm dev
```

Build a native installer on its supported host:

```sh
pnpm build
```

The app frontend development port is `1430`. A renderer-only preview is available
with `pnpm --filter app-launcher dev`, but native scan/launch commands require
the Tauri runtime.

## Repository layout

```text
apps/app-launcher/   React frontend and application-local Tauri/Rust shell
packages/ui/        UI components maintained only by this repository
docs/               Architecture, release process, and acceptance boundaries
.github/workflows/  Native checks, installers, and draft releases
```

This is an independent repository with a fresh history. The UI package was copied
at the extraction boundary and is now maintained independently. Its internal
`@tessera/ui` package name is retained for import compatibility; it has no runtime
dependency on another checkout and is not synchronized with another repository.

## Local data and privacy

Rust owns three JSON files in the operating system's application-data directory,
under `launcher/`: `device.json` (custom entries), `overlay.json` (groups and user
overrides), and `scan_cache.json` (rebuildable discovery data). The application
identifier remains `com.tessera.app-launcher` to preserve existing installations.

Installed paths, icons, groups, and launch history stay on the device. This app
does not provide telemetry, an account service, or automatic updates. Scanning
uses local system tools and APIs; a missing application never triggers a download.
GitHub downloads are governed by GitHub's own policies.

## Known limitations

- Drag-and-drop ordering and macOS Assets.car-only icons are not implemented.
- Windows coverage, icons, UWP launch, permission behavior, and window interactions
  still require real Windows acceptance.
- Data backup is currently manual; stop the application before copying its data.

See [architecture](docs/architecture.md) and [release instructions](docs/releasing.md).
Report reproducible bugs through [Issues](https://github.com/piercezzs/app-launcher/issues).

## License

Copyright (c) 2026 piercezzs. Original project code is licensed under the
GNU General Public License version 3 only (`GPL-3.0-only`); see [LICENSE](LICENSE).
You may use, modify, and redistribute it under those terms. It is provided without
warranty. Third-party components retain their own licenses and notices; see
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).

Binary releases must provide access to the matching complete corresponding source,
including the build configuration and this repository's UI package.
