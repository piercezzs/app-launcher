# Builds and releases

The `Desktop build` workflow runs on `main`, pull requests, manual dispatch, and
`v*` tags. It checks the workspace, runs native Rust tests on the runner host,
and creates macOS ARM64/Intel DMGs and Windows x64 NSIS installers. Installer
artifacts are retained for 14 days and include license notices as separate files;
the same notices are bundled as application resources.

Node 22, pnpm 10.25.0, and Rust 1.96.0 are pinned. JavaScript and Rust dependency
lockfiles are committed. Actions are pinned by commit SHA. macOS uses ad-hoc
signing; Windows packages are unsigned. CI does not claim notarization,
publisher identity, or real-device functional acceptance.

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
