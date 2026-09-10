//! Signed whole-package updates. IPC never accepts a URL, key, or installer bytes.
use base64::Engine;
use serde::Serialize;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;

/// A source checkout is allowed to omit updater credentials entirely. Only a
/// structurally valid public verification key enables the plugin and checks.
/// This inspects public configuration; private signing material is never read.
pub(crate) fn is_configured(config: &tauri::utils::config::Config) -> bool {
    config
        .plugins
        .0
        .get("updater")
        .and_then(|value| value.get("pubkey"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(is_public_key)
}

fn is_public_key(encoded: &str) -> bool {
    let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(encoded.trim()) else {
        return false;
    };
    let Ok(text) = std::str::from_utf8(&decoded) else {
        return false;
    };
    let mut lines = text.lines();
    if !lines
        .next()
        .is_some_and(|line| line.starts_with("untrusted comment:"))
    {
        return false;
    }
    let Some(key) = lines.next() else {
        return false;
    };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(key) else {
        return false;
    };
    bytes.len() == 42 && &bytes[..2] == b"Ed" && bytes[10..].iter().any(|byte| *byte != 0)
}

const UPDATE_ENDPOINT: &str =
    "https://raw.githubusercontent.com/piercezzs/hatch/updates/stable.json";

/// Stable IPC categories: do not expose raw transport errors or device paths.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum CheckFailureCode {
    SourceUnavailable,
    Network,
    InvalidMetadata,
    Check,
}

#[derive(Debug, Serialize)]
pub struct CheckFailure {
    code: CheckFailureCode,
}

impl From<String> for CheckFailure {
    fn from(_: String) -> Self {
        Self {
            code: CheckFailureCode::Check,
        }
    }
}

fn classify_check_error(error: tauri_plugin_updater::Error) -> CheckFailure {
    use tauri_plugin_updater::Error;
    let code = match error {
        // Updater 2.11 discards non-success HTTP status codes. A 404 and a 503
        // both surface here; neither proves "no newer version" or "unpublished".
        Error::ReleaseNotFound => CheckFailureCode::SourceUnavailable,
        Error::Reqwest(error) if error.is_decode() => CheckFailureCode::InvalidMetadata,
        Error::Reqwest(error) if error.is_builder() => CheckFailureCode::Check,
        Error::Reqwest(_) => CheckFailureCode::Network,
        Error::Serialization(_)
        | Error::Semver(_)
        | Error::TargetNotFound(_)
        | Error::TargetsNotFound(_) => CheckFailureCode::InvalidMetadata,
        _ => CheckFailureCode::Check,
    };
    CheckFailure { code }
}

async fn check_candidate(
    updater: &tauri_plugin_updater::Updater,
) -> Result<Option<Update>, CheckFailure> {
    let candidate = updater.check().await.map_err(classify_check_error)?;
    if let Some(update) = candidate.as_ref() {
        validate_download_url(update.download_url.as_str()).map_err(|_| CheckFailure {
            code: CheckFailureCode::InvalidMetadata,
        })?;
    }
    Ok(candidate)
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePhase {
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    Installing,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    notes: Option<String>,
    date: Option<String>,
}

impl From<&Update> for UpdateInfo {
    fn from(update: &Update) -> Self {
        Self {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
            notes: update.body.clone(),
            date: update.date.map(|date| date.to_string()),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current_version: String,
    configured: bool,
    phase: UpdatePhase,
    update: Option<UpdateInfo>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

#[derive(Default)]
struct UpdateData {
    operation: Option<UpdatePhase>,
    candidate: Option<Update>,
    // Only Update::download's signature-verified output can enter this slot.
    prepared: Option<Vec<u8>>,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

impl UpdateData {
    fn phase(&self) -> UpdatePhase {
        self.operation.unwrap_or_else(|| {
            if self.prepared.is_some() {
                UpdatePhase::Ready
            } else if self.candidate.is_some() {
                UpdatePhase::Available
            } else {
                UpdatePhase::Idle
            }
        })
    }
}

#[derive(Clone, Default)]
pub struct UpdateState(Arc<Mutex<UpdateData>>);

impl UpdateState {
    fn lock(&self) -> Result<MutexGuard<'_, UpdateData>, String> {
        self.0
            .lock()
            .map_err(|_| "Update state was interrupted; restart Hatch".into())
    }

    fn begin(&self, phase: UpdatePhase) -> Result<Operation, String> {
        let mut data = self.lock()?;
        if data.operation.is_some() {
            return Err("An update operation is already running".into());
        }
        match phase {
            UpdatePhase::Downloading if data.candidate.is_none() || data.prepared.is_some() => {
                return Err("Check for an update before downloading".into());
            }
            UpdatePhase::Installing if data.prepared.is_none() => {
                return Err("Download and verify the update before installing".into());
            }
            UpdatePhase::Checking | UpdatePhase::Downloading | UpdatePhase::Installing => {}
            _ => return Err("Invalid update operation".into()),
        }
        data.operation = Some(phase);
        Ok(Operation(self.clone()))
    }

    fn status(&self, version: String, configured: bool) -> Result<UpdateStatus, String> {
        let data = self.lock()?;
        Ok(UpdateStatus {
            current_version: version,
            configured,
            phase: data.phase(),
            update: data.candidate.as_ref().map(UpdateInfo::from),
            downloaded_bytes: data.downloaded_bytes,
            total_bytes: data.total_bytes,
        })
    }
}

// A cancelled future, network error, or worker unwind releases the single-flight claim.
struct Operation(UpdateState);
impl Drop for Operation {
    fn drop(&mut self) {
        if let Ok(mut data) = self.0.lock() {
            data.operation = None;
        }
    }
}

#[tauri::command]
pub fn update_status(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<UpdateStatus, String> {
    state.status(
        app.package_info().version.to_string(),
        is_configured(app.config()),
    )
}

#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<UpdateStatus, CheckFailure> {
    if !is_configured(app.config()) {
        return Err(CheckFailure {
            code: CheckFailureCode::Check,
        });
    }
    let operation = state.begin(UpdatePhase::Checking)?;
    {
        let mut data = state.lock()?;
        data.candidate = None;
        data.prepared = None;
        data.downloaded_bytes = 0;
        data.total_bytes = None;
    }
    let endpoint = UPDATE_ENDPOINT
        .parse()
        .map_err(|err| format!("Invalid update endpoint: {err}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|err| err.to_string())?
        .timeout(CHECK_TIMEOUT)
        .version_comparator(move |current, release| {
            release.version > current && release.version.pre.is_empty()
        })
        .build()
        .map_err(|err| err.to_string())?;
    let candidate = check_candidate(&updater).await?;
    state.lock()?.candidate = candidate;
    drop(operation);
    state
        .status(
            app.package_info().version.to_string(),
            is_configured(app.config()),
        )
        .map_err(CheckFailure::from)
}

fn validate_download_url(url: &str) -> Result<(), String> {
    // The feed is fixed and package signatures remain mandatory. Restrict its
    // initial package URL to this repository's immutable Release assets as well.
    if !url.starts_with("https://github.com/piercezzs/hatch/releases/download/") {
        return Err("The update points outside Hatch release assets".into());
    }
    Ok(())
}

fn exceeds_download_limit(downloaded: u64, total: Option<u64>) -> bool {
    downloaded > MAX_DOWNLOAD_BYTES || total.is_some_and(|total| total > MAX_DOWNLOAD_BYTES)
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    state: State<'_, UpdateState>,
    on_progress: Channel<DownloadProgress>,
) -> Result<UpdateStatus, String> {
    if !is_configured(app.config()) {
        return Err("Automatic updates are not configured in this build".into());
    }
    download_candidate(state.inner(), on_progress).await?;
    state.status(
        app.package_info().version.to_string(),
        is_configured(app.config()),
    )
}

async fn download_candidate(
    state: &UpdateState,
    on_progress: Channel<DownloadProgress>,
) -> Result<(), String> {
    let operation = state.begin(UpdatePhase::Downloading)?;
    let mut update = {
        let mut data = state.lock()?;
        data.downloaded_bytes = 0;
        data.total_bytes = None;
        data.candidate.clone().ok_or("No update is available")?
    };
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    let stop = tokio::sync::Notify::new();
    let progress_state = state.clone();
    let download = update.download(
        |chunk, total| {
            if let Ok(mut data) = progress_state.lock() {
                data.downloaded_bytes = data.downloaded_bytes.saturating_add(chunk as u64);
                data.total_bytes = total;
                if exceeds_download_limit(data.downloaded_bytes, total) {
                    stop.notify_one();
                }
                let _ = on_progress.send(DownloadProgress {
                    downloaded_bytes: data.downloaded_bytes,
                    total_bytes: total,
                });
            }
        },
        || {},
    );
    // The plugin exposes progress, not a fallible chunk callback. Cancellation
    // is cooperative at its next async yield, and a final size check also covers
    // a response completed within one poll. Never mark unverified bytes ready.
    let bytes = tokio::select! {
        biased;
        _ = stop.notified() => return Err("Update exceeds the 256 MiB download limit".into()),
        result = tokio::time::timeout(DOWNLOAD_TIMEOUT, download) => {
            result.map_err(|_| "Update download timed out")?
                .map_err(|err| format!("Could not download or verify update: {err}"))?
        }
    };
    if exceeds_download_limit(bytes.len() as u64, state.lock()?.total_bytes) {
        return Err("Update exceeds the 256 MiB download limit".into());
    }
    state.lock()?.prepared = Some(bytes);
    drop(operation);
    Ok(())
}

#[tauri::command]
pub async fn install_update(app: AppHandle, state: State<'_, UpdateState>) -> Result<(), String> {
    if !is_configured(app.config()) {
        return Err("Automatic updates are not configured in this build".into());
    }
    let operation = state.begin(UpdatePhase::Installing)?;
    let (update, bytes) = {
        let mut data = state.lock()?;
        let update = data.candidate.clone().ok_or("No update is available")?;
        let bytes = data.prepared.take().ok_or("No verified update is ready")?;
        (update, bytes)
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        // Acquires the same mutex as every JSON transaction, then closes the
        // gate before releasing it. No store mutex survives into platform hooks.
        let _installation = crate::launcher::begin_update_installation()?;
        let install = || {
            update
                .install(&bytes)
                .map_err(|err| format!("Could not install update: {err}"))
        };
        #[cfg(target_os = "macos")]
        install_with_bundle_backup(&current_bundle_path()?, install)?;
        #[cfg(not(target_os = "macos"))]
        install()?;
        // Windows exits inside install(). macOS returns after replacing the app.
        app.restart();
        #[allow(unreachable_code)]
        Ok(())
    })
    .await
    .map_err(|err| format!("Update installation worker failed: {err}"))?
}

#[cfg(target_os = "macos")]
fn current_bundle_path() -> Result<std::path::PathBuf, String> {
    let executable = tauri::utils::platform::current_exe()
        .map_err(|error| format!("Could not locate the running Hatch app: {error}"))?;
    bundle_from_executable(&executable)
}

#[cfg(target_os = "macos")]
fn bundle_from_executable(executable: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let macos = executable.parent().ok_or("Missing application directory")?;
    let contents = macos.parent().ok_or("Missing bundle contents")?;
    let bundle = contents.parent().ok_or("Missing application bundle")?;
    if macos.file_name() != Some(std::ffi::OsStr::new("MacOS"))
        || contents.file_name() != Some(std::ffi::OsStr::new("Contents"))
        || bundle.extension() != Some(std::ffi::OsStr::new("app"))
        || !executable.is_file()
        || !bundle.join("Contents/Info.plist").is_file()
        || std::fs::symlink_metadata(bundle)
            .map_err(|error| error.to_string())?
            .file_type()
            .is_symlink()
    {
        return Err("Install Hatch in a writable .app bundle before updating".into());
    }
    Ok(bundle.to_path_buf())
}

#[cfg(target_os = "macos")]
fn copy_bundle(source: &std::path::Path, destination: &std::path::Path) -> Result<(), String> {
    use std::process::{Command, Stdio};
    // ditto preserves app-bundle resource forks, attributes, ACLs and symlinks.
    // Explicit arguments avoid shell interpretation of installation paths.
    let mut child = Command::new("/usr/bin/ditto")
        .args(["--rsrc", "--extattr", "--acl"])
        .arg(source)
        .arg(destination)
        .env_remove("DITTO_TEST_OPTIONS")
        .env_remove("DITTONORSRC")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Could not back up Hatch: {error}"))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                return Err(format!(
                    "Could not back up Hatch (ditto {status}); original app was not changed"
                ))
            }
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20))
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result {
                    Err(error) => format!("Could not back up Hatch: {error}"),
                    _ => "Hatch backup timed out; original app was not changed".into(),
                });
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn install_with_bundle_backup(
    bundle: &std::path::Path,
    install: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let parent = bundle.parent().ok_or("Application bundle has no parent")?;
    // Refuse read-only/administrator-owned installs before invoking the plugin.
    // A sibling backup also proves we can create entries on the destination
    // filesystem, and keeps restoration as a same-filesystem rename.
    for path in [parent, bundle] {
        if std::fs::metadata(path)
            .map_err(|error| error.to_string())?
            .permissions()
            .readonly()
        {
            return Err("The Hatch installation is read-only; original app was not changed".into());
        }
        let writable = std::process::Command::new("/bin/test")
            .arg("-w")
            .arg(path)
            .status()
            .map_err(|error| format!("Could not check installation permissions: {error}"))?;
        if !writable.success() {
            return Err("The Hatch installation is not writable; move it to a writable Applications folder before updating".into());
        }
    }
    let temporary = tempfile::Builder::new()
        .prefix(".hatch-update-recovery-")
        .tempdir_in(parent)
        .map_err(|error| format!("Could not prepare Hatch recovery backup: {error}"))?;
    let saved_bundle = temporary.path().join("original.app");
    copy_bundle(bundle, &saved_bundle)?;
    // Never let TempDir's automatic cleanup delete the recovery copy while an
    // installer is changing the live bundle. Explicit cleanup follows success.
    let recovery = temporary.keep();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(install))
        .unwrap_or_else(|_| Err("The update installer was interrupted".into()));
    if let Err(error) = result {
        let restore = (|| -> std::io::Result<()> {
            // Preserve any partial replacement until the old bundle is back.
            if bundle.try_exists()? {
                std::fs::rename(bundle, recovery.join("failed.app"))?;
            }
            std::fs::rename(&saved_bundle, bundle)
        })();
        if let Err(restore_error) = restore {
            return Err(format!("{error}. Automatic recovery failed: {restore_error}. Your previous app is preserved at {}. Restore it to {} before restarting Hatch.", saved_bundle.display(), bundle.display()));
        }
        let cleanup = std::fs::remove_dir_all(&recovery);
        return Err(if cleanup.is_ok() {
            format!("{error}. The previous Hatch app was restored; retry the download.")
        } else {
            format!(
                "{error}. The previous Hatch app was restored. Recovery files remain at {}.",
                recovery.display()
            )
        });
    }
    // A leftover backup is harmless; do not report installation failure after
    // the new app has already been installed successfully.
    let _ = std::fs::remove_dir_all(&recovery);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Public, non-production fixture from minisign-verify's documentation:
    // https://github.com/jedisct1/rust-minisign-verify/blob/master/src/lib.rs
    const TEST_PUBLIC_KEY: &str =
        "untrusted comment: test key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
    const TEST_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1633700835\tfile:test\tprehashed\nwLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==\n";

    fn test_app() -> tauri::App<tauri::test::MockRuntime> {
        use base64::Engine;
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({
                "pubkey": base64::engine::general_purpose::STANDARD.encode(TEST_PUBLIC_KEY),
                // This exception is compiled only into tests. No production IPC can set it.
                "dangerousInsecureTransportProtocol": true
            }),
        );
        tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap()
    }

    fn serve_responses(
        responses: impl FnOnce(String) -> Vec<(u16, Vec<u8>)>,
    ) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let responses = responses(address.clone());
        listener.set_nonblocking(true).unwrap();
        let worker = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            for (status, body) in responses {
                let mut connection = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                std::time::Instant::now() < deadline,
                                "fixture server timed out"
                            );
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("fixture server error: {error}"),
                    }
                };
                // Windows accepted sockets inherit the listener's nonblocking
                // mode. A read timeout does not switch them back to blocking.
                connection.set_nonblocking(false).unwrap();
                connection
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = [0; 4096];
                let mut received = 0;
                while !request[..received].windows(4).any(|part| part == b"\r\n\r\n") {
                    assert!(received < request.len(), "fixture request headers too large");
                    let count = connection.read(&mut request[received..]).unwrap();
                    assert!(count > 0, "fixture request ended before its headers");
                    received += count;
                }
                write!(
                    connection,
                    "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                connection.write_all(&body).unwrap();
            }
        });
        (address, worker)
    }

    #[test]
    fn loopback_download_rejects_tampering_then_allows_verified_retry() {
        use base64::Engine;
        let app = test_app();
        let (address, server) = serve_responses(|address| {
            let manifest = serde_json::to_vec(&serde_json::json!({
                "version": "0.2.0",
                "url": format!("{address}/package"),
                "signature": base64::engine::general_purpose::STANDARD.encode(TEST_SIGNATURE)
            }))
            .unwrap();
            vec![
                (200, manifest),
                (200, b"tampered".to_vec()),
                (200, b"test".to_vec()),
            ]
        });
        tauri::async_runtime::block_on(async {
            let candidate = app
                .updater_builder()
                .endpoints(vec![address.parse().unwrap()])
                .unwrap()
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap()
                .check()
                .await
                .unwrap()
                .unwrap();
            let state = UpdateState::default();
            state.lock().unwrap().candidate = Some(candidate);
            let failure = download_candidate(&state, Channel::new(|_| Ok(())))
                .await
                .unwrap_err();
            assert!(failure.contains("signature"), "unexpected error: {failure}");
            assert!(state.lock().unwrap().prepared.is_none());
            assert_eq!(state.lock().unwrap().phase(), UpdatePhase::Available);
            assert!(state.begin(UpdatePhase::Installing).is_err());
            download_candidate(&state, Channel::new(|_| Ok(())))
                .await
                .unwrap();
            assert_eq!(
                state.lock().unwrap().prepared.as_deref(),
                Some(b"test".as_slice())
            );
            assert_eq!(state.lock().unwrap().phase(), UpdatePhase::Ready);
            // Deliberately never call install: this fixture is data, not a bundle.
        });
        server.join().unwrap();
    }

    #[test]
    fn loopback_failed_check_releases_claim_for_retry() {
        let app = test_app();
        let (address, server) = serve_responses(|_| vec![(503, Vec::new()), (204, Vec::new())]);
        tauri::async_runtime::block_on(async {
            let updater = app
                .updater_builder()
                .endpoints(vec![address.parse().unwrap()])
                .unwrap()
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap();
            let state = UpdateState::default();
            let operation = state.begin(UpdatePhase::Checking).unwrap();
            assert_eq!(
                check_candidate(&updater)
                    .await
                    .err()
                    .expect("check must fail")
                    .code,
                CheckFailureCode::SourceUnavailable
            );
            drop(operation);
            let _retry = state.begin(UpdatePhase::Checking).unwrap();
            assert!(check_candidate(&updater).await.unwrap().is_none());
        });
        server.join().unwrap();
    }

    #[test]
    fn real_http_failures_have_stable_ipc_categories_and_allow_retry() {
        let app = test_app();
        let manifest = |value: serde_json::Value| serde_json::to_vec(&value).unwrap();
        let cases = vec![
            (
                404,
                b"Not Found".to_vec(),
                CheckFailureCode::SourceUnavailable,
            ),
            (
                503,
                b"Unavailable".to_vec(),
                CheckFailureCode::SourceUnavailable,
            ),
            (
                200,
                b"<html>Bad gateway</html>".to_vec(),
                CheckFailureCode::InvalidMetadata,
            ),
            (
                200,
                manifest(serde_json::json!({"version":"invalid"})),
                CheckFailureCode::InvalidMetadata,
            ),
            (
                200,
                manifest(serde_json::json!({"version":"99.0.0","platforms":{}})),
                CheckFailureCode::InvalidMetadata,
            ),
            (
                200,
                manifest(
                    serde_json::json!({"version":"99.0.0","url":"https://example.com/package","signature":"fixture"}),
                ),
                CheckFailureCode::InvalidMetadata,
            ),
        ];
        let responses = cases
            .iter()
            .map(|(status, body, _)| (*status, body.clone()))
            .chain(std::iter::once((204, Vec::new())))
            .collect();
        let (address, server) = serve_responses(|_| responses);
        tauri::async_runtime::block_on(async {
            let updater = app
                .updater_builder()
                .endpoints(vec![address.parse().unwrap()])
                .unwrap()
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap();
            let state = UpdateState::default();
            for (_, _, expected) in cases {
                let operation = state.begin(UpdatePhase::Checking).unwrap();
                let failure = check_candidate(&updater)
                    .await
                    .err()
                    .expect("check must fail");
                assert_eq!(failure.code, expected);
                let encoded = serde_json::to_value(&failure).unwrap();
                assert_eq!(encoded.as_object().unwrap().len(), 1);
                assert!(encoded["code"].is_string());
                drop(operation);
                assert_eq!(state.lock().unwrap().phase(), UpdatePhase::Idle);
                assert!(state.lock().unwrap().candidate.is_none());
            }
            assert!(check_candidate(&updater).await.unwrap().is_none());
        });
        server.join().unwrap();
    }

    #[test]
    fn stalled_connection_is_network_failure_not_missing_release() {
        let app = test_app();
        // Keep the listener open without replying: deterministic request timeout.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        tauri::async_runtime::block_on(async {
            let updater = app
                .updater_builder()
                .endpoints(vec![address.parse().unwrap()])
                .unwrap()
                .no_proxy()
                .timeout(Duration::from_millis(100))
                .build()
                .unwrap();
            assert_eq!(
                check_candidate(&updater)
                    .await
                    .err()
                    .expect("check must fail")
                    .code,
                CheckFailureCode::Network
            );
        });
    }

    #[test]
    fn unknown_internal_errors_do_not_leak_through_ipc() {
        let failure = CheckFailure::from("internal path or transport details".to_string());
        assert_eq!(
            serde_json::to_value(failure).unwrap(),
            serde_json::json!({"code":"check"})
        );
        for (error, code) in [
            (
                tauri_plugin_updater::Error::ReleaseNotFound,
                "sourceUnavailable",
            ),
            (
                tauri_plugin_updater::Error::TargetNotFound("fixture".into()),
                "invalidMetadata",
            ),
        ] {
            assert_eq!(
                serde_json::to_value(classify_check_error(error)).unwrap(),
                serde_json::json!({"code":code})
            );
        }
    }

    #[test]
    fn absent_empty_and_malformed_keys_keep_updates_disabled() {
        let mut context =
            tauri::test::mock_context::<tauri::test::MockRuntime, _>(tauri::test::noop_assets());
        assert!(!is_configured(context.config()));
        for key in ["", "placeholder", "aGVsbG8=", "   "] {
            context
                .config_mut()
                .plugins
                .0
                .insert("updater".into(), serde_json::json!({ "pubkey": key }));
            assert!(!is_configured(context.config()));
        }
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({
                "pubkey": base64::engine::general_purpose::STANDARD.encode(TEST_PUBLIC_KEY)
            }),
        );
        assert!(is_configured(context.config()));
        let status = UpdateState::default()
            .status("0.3.0".into(), false)
            .unwrap();
        assert!(!status.configured);
        assert_eq!(status.phase, UpdatePhase::Idle);
    }

    #[cfg(target_os = "macos")]
    fn dummy_bundle(root: &std::path::Path) -> std::path::PathBuf {
        use std::os::unix::fs::symlink;
        let bundle = root.join("Hatch.app");
        std::fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        std::fs::write(bundle.join("Contents/Info.plist"), "original metadata").unwrap();
        std::fs::write(bundle.join("Contents/MacOS/hatch"), "original executable").unwrap();
        symlink("MacOS/hatch", bundle.join("Contents/link")).unwrap();
        bundle
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn failed_install_restores_removed_bundle_and_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let bundle = dummy_bundle(directory.path());
        let result = install_with_bundle_backup(&bundle, || {
            std::fs::remove_dir_all(&bundle).unwrap();
            Err("simulated new-bundle rename failure".into())
        });
        assert!(result
            .unwrap_err()
            .contains("previous Hatch app was restored"));
        assert_eq!(
            std::fs::read_to_string(bundle.join("Contents/MacOS/hatch")).unwrap(),
            "original executable"
        );
        assert_eq!(
            std::fs::read_link(bundle.join("Contents/link")).unwrap(),
            std::path::PathBuf::from("MacOS/hatch")
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn successful_install_cleans_recovery_backup() {
        let directory = tempfile::tempdir().unwrap();
        let bundle = dummy_bundle(directory.path());
        install_with_bundle_backup(&bundle, || {
            std::fs::write(bundle.join("Contents/MacOS/hatch"), "new executable").unwrap();
            Ok(())
        })
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(bundle.join("Contents/MacOS/hatch")).unwrap(),
            "new executable"
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn interrupted_install_restores_partial_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let bundle = dummy_bundle(directory.path());
        let result = install_with_bundle_backup(&bundle, || {
            std::fs::write(bundle.join("Contents/MacOS/hatch"), "partial executable").unwrap();
            panic!("simulated installer unwind");
        });
        assert!(result.is_err());
        assert_eq!(
            std::fs::read_to_string(bundle.join("Contents/MacOS/hatch")).unwrap(),
            "original executable"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn failed_recovery_retains_original_backup_with_reported_location() {
        let directory = tempfile::tempdir().unwrap();
        let bundle = dummy_bundle(directory.path());
        let result = install_with_bundle_backup(&bundle, || {
            let recovery = std::fs::read_dir(directory.path())
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| {
                    path.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with(".hatch-update-recovery-")
                })
                .unwrap();
            // A nonempty conflicting destination forces the first restore rename
            // to fail, without touching permissions or any real installed app.
            std::fs::create_dir(recovery.join("failed.app")).unwrap();
            std::fs::write(recovery.join("failed.app/occupied"), "failure injection").unwrap();
            Err("simulated install failure".into())
        });
        let error = result.unwrap_err();
        assert!(error.contains("Automatic recovery failed"));
        let recovery = std::fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".hatch-update-recovery-")
            })
            .unwrap();
        let original = recovery.join("original.app");
        assert!(error.contains(original.to_str().unwrap()));
        assert_eq!(
            std::fs::read_to_string(original.join("Contents/MacOS/hatch")).unwrap(),
            "original executable"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn readonly_bundle_rejects_before_invoking_installer() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let bundle = dummy_bundle(directory.path());
        let original_permissions = std::fs::metadata(&bundle).unwrap().permissions();
        std::fs::set_permissions(&bundle, std::fs::Permissions::from_mode(0o555)).unwrap();
        let result = install_with_bundle_backup(&bundle, || panic!("installer must not run"));
        std::fs::set_permissions(&bundle, original_permissions).unwrap();
        assert!(result.unwrap_err().contains("read-only"));
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn dev_executable_is_not_an_installable_bundle() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("hatch");
        std::fs::write(&executable, "not a bundled executable").unwrap();
        assert!(bundle_from_executable(&executable).is_err());
        let bundle = dummy_bundle(directory.path());
        assert_eq!(
            bundle_from_executable(&bundle.join("Contents/MacOS/hatch")).unwrap(),
            bundle
        );
    }

    #[test]
    fn invalid_phases_cannot_download_or_install() {
        let state = UpdateState::default();
        assert!(state.begin(UpdatePhase::Downloading).is_err());
        assert!(state.begin(UpdatePhase::Installing).is_err());
        assert_eq!(state.lock().unwrap().phase(), UpdatePhase::Idle);
    }

    #[test]
    fn duplicate_operations_reject_and_failure_releases_claim() {
        let state = UpdateState::default();
        let operation = state.begin(UpdatePhase::Checking).unwrap();
        assert!(state.begin(UpdatePhase::Checking).is_err());
        assert!(state.begin(UpdatePhase::Installing).is_err());
        drop(operation); // models check returning an error or being cancelled
        assert!(state.begin(UpdatePhase::Checking).is_ok());
    }

    #[test]
    fn unwinding_releases_operation() {
        let state = UpdateState::default();
        let cloned = state.clone();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _operation = cloned.begin(UpdatePhase::Checking).unwrap();
            panic!("simulated worker failure");
        }));
        assert!(state.begin(UpdatePhase::Checking).is_ok());
    }

    #[test]
    fn download_limit_covers_declared_and_chunked_responses() {
        assert!(!exceeds_download_limit(MAX_DOWNLOAD_BYTES, None));
        assert!(exceeds_download_limit(1, Some(MAX_DOWNLOAD_BYTES + 1)));
        assert!(exceeds_download_limit(MAX_DOWNLOAD_BYTES + 1, None));
    }

    #[test]
    fn release_assets_are_confined_to_this_repository() {
        assert!(validate_download_url(
            "https://github.com/piercezzs/hatch/releases/download/v0.5.0/Hatch.app.tar.gz"
        )
        .is_ok());
        for url in [
            "http://github.com/piercezzs/hatch/releases/download/a",
            "https://github.com/other/hatch/releases/download/a",
            "https://github.com.evil.test/piercezzs/hatch/releases/download/a",
        ] {
            assert!(validate_download_url(url).is_err());
        }
    }
}
