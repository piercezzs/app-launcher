# Builds and releases

The `Desktop build` workflow runs on `main`, pull requests, manual dispatch, and
`v*` tags. It checks the workspace, runs locale tests and native Rust tests on the runner host,
and creates macOS ARM64/Intel DMGs, signed updater archives, and Windows x64 NSIS installers with updater signatures. Installer
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
4. Configure the production updater signing secrets described below. CI validates
   the tag, checks that the private key matches the committed public key, completes
   every platform build, verifies the merged signatures, and creates one **draft**
   Release. A failed matrix or incomplete platform asset set prevents release creation.
5. Inspect installers, source/tag correspondence, notices, and target-host results.
   Add release notes and publish the draft when authorized. Leave the prerelease flag
   unchecked. Only published stable releases enter the update feed. Publication
   triggers the separate update-channel workflow; creating
   a draft or uploading an Actions artifact never advances an update channel.

Tag validation rejects a mismatched version before compilation. An existing
release is not overwritten by the publishing job; resume a failed first release
from its failed jobs, or inspect the existing draft explicitly.

## Source and installation continuity

Every distributed binary must point to its matching source tag. Keep the complete
buildable source available, including `packages/ui`, both lockfiles, and build
scripts. GitHub's source archives for a tag are the corresponding project source;
third-party notices describe dependency source locations and licenses.

Keep `com.tessera.app-launcher` stable. The repository move does not authorize
data-format migration or user-data removal. Application self-updates preserve this
identity. JSON data migration and older App Launcher installation migration remain
separate acceptance boundaries.

## Hatch branding transition

Hatch replaces the App Launcher product name. The application identifier
`com.tessera.app-launcher`, Rust binary/library names, `app-launcher.language`
preference key, and launcher JSON storage remain unchanged. Repository/source
directory names do not determine the user-data directory.

Existing tags and release installers keep their original branding. The v0.3.0
public preview introduces Hatch installers without migrating an installed
application. Publish it as a GitHub prerelease, not a verified production release.

The NSIS installer derives its uninstall registry key from the product name.
Changing it to Hatch therefore does not establish automatic upgrade detection
of an older App Launcher installation. The v0.3.0 Windows public preview is
limited to clean installations and must explicitly exclude existing-installation
upgrades in its release notes. Existing Windows users should stay on their old
version until migration is verified. Before enabling upgrade support, implement
and verify the transition on Windows, including shortcut cleanup, uninstall
behavior, and preservation of JSON data and WebView preferences. Do not claim
seamless upgrade based only on the stable bundle identifier.

On macOS, the built bundle is Hatch.app. Existing App Launcher.app copies are
not automatically replaced or removed by a source build; do not run both versions
against the shared data directory at the same time.

## Updater signing and first installation

The first updater-enabled release must be installed manually by v0.3.0 users.
Those existing binaries contain no updater and cannot discover this capability.
Subsequent Hatch-to-Hatch upgrades require successful target-host acceptance before
being advertised as supported. Legacy App Launcher-to-Hatch upgrades are excluded.

The production updater public key is stored in
`apps/hatch/src-tauri/tauri.conf.json` with `bundle.createUpdaterArtifacts: true`.
Private signing material is configured separately in GitHub Actions secrets.
Check that those secrets match the committed public key before releasing.
A checkout without a valid public key reports that updates are unavailable;
ordinary local app builds remain usable. Never commit an empty or temporary key.
For local updater-installer builds, configure `plugins.updater.windows.installMode`
as `passive` as well. Native update code uses one fixed stable endpoint.

Generate the production Tauri updater key on a trusted device, with an encrypted
private-key file and a securely stored password. Keep an offline encrypted backup;
loss of the private key prevents updates to clients that trust its public key.
Never commit the private key or password, paste them into chat, put them in command
history, or use a CI test key for production. Only the public key belongs in the
committed Tauri configuration. Configure repository Actions secrets through secure
local input or the GitHub UI:

- `TAURI_SIGNING_PRIVATE_KEY`: the base64 contents of the encrypted private-key file.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its decryption password.

### One-time configuration from your own terminal

Run these steps yourself in a private local terminal, from the repository root.
Do not run key generation in an agent transcript or share its output in chat.
If you already have a signing key, reuse it; do not overwrite it or generate a
replacement for an app that already trusts the existing key.

```sh
mkdir -p "$HOME/.config/hatch"
chmod 700 "$HOME/.config/hatch"
umask 077
pnpm --filter hatch exec tauri signer generate -w "$HOME/.config/hatch/updater-signing.key"
```

Enter a nonempty strong password when prompted and save it in your password
manager. The `.key` file is the encrypted private key; `.key.pub` is the public key.
Back up the encrypted key and retain the password securely.

Copy only the public key into the existing application configuration. This command
merges the required fields without replacing the rest of the configuration:

```sh
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const path = 'apps/hatch/src-tauri/tauri.conf.json';
const config = JSON.parse(readFileSync(path, 'utf8'));
config.plugins ??= {};
config.plugins.updater ??= {};
config.plugins.updater.pubkey = readFileSync(join(homedir(), '.config/hatch/updater-signing.key.pub'), 'utf8').trim();
config.plugins.updater.windows = { ...config.plugins.updater.windows, installMode: 'passive' };
config.bundle.createUpdaterArtifacts = true;
writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
NODE
```

After authenticating GitHub CLI to the intended account, upload the encrypted
private key directly from the file; enter its password at the hidden prompt of the
second command. Never place the password in command arguments or shell history.

```sh
gh secret set TAURI_SIGNING_PRIVATE_KEY --repo piercezzs/hatch < "$HOME/.config/hatch/updater-signing.key"
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo piercezzs/hatch
gh secret list --repo piercezzs/hatch
```

The last command lists secret names, not their values. Alternatively use repository
Settings > Secrets and variables > Actions to configure these same two secrets.
Commit only the public configuration together with the implementation before the
first authorized release. Secret setup alone does not rebuild an installed app or
publish the stable update feed. Never use a production tag merely as a key test.

Release builds fail closed when keys are absent, malformed, or do not match the
committed public key. `scripts/configure-ci-updater.mjs` signs a disposable probe
and checks its signature before building. Non-tag builds generate an encrypted,
ephemeral key and set the public key only in the disposable runner checkout.
After key verification, the helper enables `bundle.createUpdaterArtifacts` and
passive Windows installation in that build-only configuration for every CI build.
It does not require a production key for non-tag builds, and does not add generated
keys to source control. These artifacts cannot update production clients. Fork pull
requests need no secrets.

Updater signatures authenticate update archives; they do not provide Apple
Developer ID signing, notarization, or a Windows publisher certificate. macOS
packages remain ad-hoc signed and Windows installers unsigned until those separate
credentials and acceptance checks are configured. Do not claim production OS trust.

`pnpm desktop:build:local` builds an `.app` for local inspection. If invoking a
bundling command that creates updater archives directly, configure the signing key
locally through environment variables; never substitute a committed test key.

## Release assets and channel promotion

Each release contains exactly these 12 files (`<version>` has no leading `v`):

- `Hatch_<version>_aarch64.dmg` and `Hatch_<version>_x64.dmg`.
- `Hatch_<version>_aarch64.app.tar.gz` and its `.sig`.
- `Hatch_<version>_x64.app.tar.gz` and its `.sig`.
- `Hatch_<version>_x64-setup.exe` and its `.sig`.
- `LICENSE`, `THIRD_PARTY_NOTICES.txt`, `latest.json`, and `SHA256SUMS`.

Archives are renamed before upload so Intel and ARM artifacts cannot overwrite one
another. The Node 22 standard-library verifier checks all three updater signatures
(including their trusted comments), public-key identity, fixed GitHub URLs, exact
platform coverage, filenames, sizes, SHA-256 hashes, version, and full source commit.
`latest.json` embeds asset hashes and sizes; `SHA256SUMS` covers every asset except
itself, including the manifest. Generated JSON contains no private signing material.

The `Publish update channel` workflow runs on `release.published`, or manually
against an existing published release tag from `main`. It fetches verifier code
from `main`, requires the release tag commit to be an ancestor of `main`, compares
that commit to manifest provenance, validates metadata before downloading assets,
and rechecks all downloaded bytes. It never executes downloaded release content.
Drafts, incomplete uploads, invalid signatures and checksum mismatches stop promotion.
The source commit and checksums are release metadata, not independent cryptographic
build attestations. Signatures authenticate the archives, while source association
relies on the trusted build workflow and release-maintainer permissions. Do not
claim these checks prove reproducible binaries or defend against a compromised
maintainer/signing workflow.
Prereleases are excluded from automatic promotion and rejected by manual promotion.
Only published stable releases can advance the update feed.

The workflow commits both `versions/<version>.json` and the channel file atomically
to an independent `updates` branch. Client endpoints are:

- `https://raw.githubusercontent.com/piercezzs/hatch/updates/stable.json`

Publishing is serialized, uses normal fast-forward pushes, rejects downgrades, and
rejects a changed manifest for a version already present. An identical retry is a
no-op. Use plain numeric versions. GitHub prereleases do not reach installed clients;
if a release is later marked stable, manually dispatch the workflow to promote its
existing verified assets. The app has no channel selector.

The branch and endpoints do not exist until the first authorized promotion. A
channel with no published release may return 404; clients must treat this as a
nonfatal failed check, not a broken launcher. GitHub/CDN visibility can lag briefly.
If another workflow publishes with `GITHUB_TOKEN`, GitHub may suppress subsequent
workflow triggers: manually dispatch `Publish update channel` with the published
tag to recover. Retry that workflow after a transient failure rather than replacing
release assets. Do not edit or delete already promoted archives. Publish a higher
version containing a corrective change to recover from a faulty release; this is
not a promise of native-installer rollback or user-data rollback.

Repository settings must permit the workflow token to push the `updates` branch.
Branch protection/rulesets must be checked before first publication. Secret setup,
remote branch creation, tag push and publication remain deliberate release actions;
merging the implementation alone does not configure credentials or publish updates.

## Update acceptance

Run `node --test scripts/updater-release.test.mjs`, `pnpm check`, `pnpm test`, and
native packaging checks for relevant changes. Script tests cover missing platforms,
tampered archives/comments, wrong keys, unsafe metadata, version/checksum mismatch,
invalid sizes and downgrade/conflicting-version prevention. A live Tauri CLI signer
must also agree with the Node verifier when changing signature verification code.

Use two actual updater-enabled versions on macOS ARM64, macOS Intel and Windows x64
before declaring an upgrade supported. Verify download cancellation/interruption,
retry, invalid signatures, simultaneous clicks, unavailable channel, standard-user
installation permissions, installation failure and restart behavior. Before
installation, finish or cancel unsaved edits and wait for pending JSON persistence.
After upgrade, compare custom applications, groups, pins and language preferences.
Keep a backup of user-owned JSON data for these tests. CI compilation or another
architecture's build is not target-host acceptance.
