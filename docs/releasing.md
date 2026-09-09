# Builds and releases

The `Desktop build` workflow runs on `main`, pull requests, manual dispatch, and
`v*` tags. It checks the workspace, runs locale tests and native Rust tests on the runner host,
and creates macOS ARM64/Intel DMGs and Windows x64 NSIS installers. Installer
artifacts are retained for 14 days and include license notices as separate files;
the same notices are bundled as application resources.

Node 22, pnpm 10.25.0, and Rust 1.96.0 are pinned. JavaScript and Rust dependency
lockfiles are committed. Actions are pinned by commit SHA. macOS uses ad-hoc
signing; Windows packages are unsigned. CI does not claim notarization,
publisher identity, or real-device functional acceptance.

## Local macOS verification build

Run `pnpm desktop:build:local` from the repository root on macOS. The wrapper uses
this Mac's Rust host target explicitly, reads Cargo's target directory (including
`CARGO_TARGET_DIR`), and prints the verified `.app` path. It accepts no arguments.
Node, pnpm, the native Rust toolchain, and Xcode command-line tools must be installed.

The stages are: build the frontend/native bundle, apply ad-hoc signing, verify the
bundle with `codesign --verify --deep --strict`, and compare bundled `LICENSE` and
`THIRD_PARTY_NOTICES.txt` byte-for-byte with repository sources. A failed command
or resource check stops execution and returns a nonzero exit status.

Apple signing/notarization environment variables are omitted from child processes,
and `APPLE_SIGNING_IDENTITY` is set to `-`. This is a local ad-hoc build, not a
Developer ID-signed or notarized distribution. It neither installs nor launches the
app and does not upload artifacts, create tags, or publish a Release. The existing
`pnpm build` command and GitHub workflow remain the installer/release build paths.

## Create a release

1. Finish platform acceptance for the intended release. Update the application
   package version and Rust package version together. Update Cargo.lock as needed.
2. Update dependencies and third-party notices together when dependencies change.
   Preserve dependency license texts and copyright notices, including licenses
   with multiple required notices. Review the final packaged legal resources.
3. Commit the release on `main`. Use `v0.1.0` for application version `0.1.0`, for
   example. Push the version tag only when a draft release is intended.
4. CI validates the tag, completes every platform build, downloads the installers,
   and creates one **draft** Release. A failed matrix prevents release creation.
5. Inspect installers, source/tag correspondence, notices, and target-host results.
   Add release notes and publish the draft when authorized.

Tag validation rejects a mismatched version before compilation. An existing
release is not overwritten by the publishing job; resume a failed first release
from its failed jobs, or inspect the existing draft explicitly.

## Source and installation continuity

Every distributed binary must point to its matching source tag. Keep the complete
buildable source available, including `packages/ui`, both lockfiles, and build
scripts. GitHub's source archives for a tag are the corresponding project source;
third-party notices describe dependency source locations and licenses.

Keep `com.tessera.app-launcher` stable. The repository move does not authorize
data-format migration or user-data removal. In-app updating is deliberately a
separate follow-up; this workflow does not create updater keys or manifests.

## Hatch branding transition

Hatch replaces the App Launcher product name. The application identifier
`com.tessera.app-launcher`, Rust binary/library names, `app-launcher.language`
preference key, and launcher JSON storage remain unchanged. Repository/source
directory names do not determine the user-data directory.

Existing tags and release installers keep their original branding. This change
does not publish a new installer or migrate an installed application.

The NSIS installer derives its uninstall registry key from the product name.
Changing it to Hatch therefore does not establish automatic upgrade detection
of an older App Launcher installation. Before a Windows release, implement and
verify the old-installation transition on Windows, including shortcut cleanup,
uninstall behavior, and preservation of JSON data and WebView preferences.
Do not claim seamless upgrade based only on the stable bundle identifier.

On macOS, the built bundle is Hatch.app. Existing App Launcher.app copies are
not automatically replaced or removed by a source build; do not run both versions
against the shared data directory at the same time.
