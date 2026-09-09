# Hatch Project Rules

## Scope and ownership

- This repository is the only development authority for Hatch.
- `apps/hatch` owns the frontend, Rust commands, Tauri configuration, and assets.
- `packages/ui` is a repository-local copy maintained independently; its historical
  package name is retained for compatibility. Do not synchronize it externally.
- Read `docs/architecture.md` for data and platform boundaries, and
  `docs/releasing.md` before changing builds or distribution.
- Keep this rule file concise and in English. Do not include private operational
  history, host-specific paths, or unrelated project instructions in public files.

## Implementation boundaries

- Keep discovery, launch, icon extraction, and persistence in application-local Rust.
- Keep application-specific behavior out of `packages/ui`; import shared interaction
  components through that package, with Radix dependencies confined to it.
- Runtime data belongs in the OS app-data directory. Preserve the application
  identifier and existing data semantics unless a migration is explicitly approved.
- The launcher may open user-selected local paths. Missing paths must not trigger
  remote download or execution. Application self-update work is a separate task.
- Prefer explicit types and pure transformations; avoid `any`.

## Dependencies and verification

- Use pnpm 10.25.0 and the root lockfile; never depend on sibling checkouts.
- Use frozen installs in CI. After an intentional manifest change, update the
  lockfile without unrelated dependency upgrades and inspect the diff.
- Frontend or shared UI changes: run `pnpm check`.
- Rust changes: run `pnpm test` and a relevant failure-path case.
- Packaging, paths, dependencies, or migration changes: run frontend checks, Rust
  tests, and the affected native build. Inspect bundled resources and permissions.
- Check Windows and macOS behavior on their respective hosts; cross-compilation
  cannot establish target-host runtime or visual acceptance.
- Run `git diff --check` before handoff. Never publish secrets, runtime data,
  dependencies, build output, or private source history.

## Releases and licensing

- Original code uses GPL-3.0-only; preserve third-party notices and source access.
- Tags are `v<apps/hatch/package.json version>` and originate from `main`.
- Installers belong in Actions artifacts or Releases, not Git source history.
- Publishing a release, changing signing credentials, or adding self-update behavior
  must stay within the user's explicitly authorized task.
- Unsigned/ad-hoc CI packaging is not signed or notarized production acceptance.
