use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, MutexGuard,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const CACHE_VERSION: u16 = 6;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherApp {
    id: String,
    name: String,
    path: String,
    args: String,
    bundle_id: String,
    aumid: String,
    source: String,
    group: String,
    note: String,
    pinned: bool,
    hidden: bool,
    launch_count: u32,
    last_launched_at: Option<u64>,
    order: f64,
    exists: bool,
    icon: String,
}

#[derive(Debug, Serialize)]
pub struct LauncherState {
    groups: Vec<String>,
    apps: Vec<LauncherApp>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchAppResult {
    name: String,
    launch_count: u32,
    last_launched_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScannedApp {
    id: String,
    name: String,
    path: String,
    #[serde(default)]
    args: String,
    #[serde(default)]
    bundle_id: String,
    #[serde(default)]
    aumid: String,
    source: String,
    #[serde(default)]
    icon: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustomApp {
    id: String,
    name: String,
    path: String,
    #[serde(default)]
    args: String,
    #[serde(default)]
    icon: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct OverlayData {
    #[serde(default)]
    groups: Vec<String>,
    #[serde(default)]
    overrides: HashMap<String, AppOverride>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct DeviceData {
    #[serde(default)]
    custom: Vec<CustomApp>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScanCache {
    version: u16,
    apps: Vec<ScannedApp>,
}

impl Default for ScanCache {
    fn default() -> Self {
        Self {
            version: CACHE_VERSION,
            apps: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct AppOverride {
    name: Option<String>,
    group: Option<String>,
    note: Option<String>,
    pinned: Option<bool>,
    hidden: Option<bool>,
    launch_count: Option<u32>,
    last_launched_at: Option<u64>,
    order: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCustomPayload {
    name: String,
    path: String,
    #[serde(default)]
    args: String,
    #[serde(default)]
    group: String,
    #[serde(default)]
    note: String,
    #[serde(default)]
    pinned: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAppPayload {
    id: String,
    name: Option<String>,
    group: Option<String>,
    note: Option<String>,
    pinned: Option<bool>,
    hidden: Option<bool>,
    path: Option<String>,
    args: Option<String>,
}

// Discovery never owns this lock. Only JSON snapshots and existing command
// transactions share it, so a background scan cannot expose partial writes.
static STORE_ACCESS: Mutex<()> = Mutex::new(());
static LIST_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

struct ListRequest<'a>(&'a AtomicBool);

impl<'a> ListRequest<'a> {
    fn begin(in_flight: &'a AtomicBool) -> Result<Self, String> {
        in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "Application discovery is already running".to_string())?;
        Ok(Self(in_flight))
    }
}

impl Drop for ListRequest<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn lock_store() -> Result<MutexGuard<'static, ()>, String> {
    STORE_ACCESS
        .lock()
        .map_err(|_| "Application data access was interrupted; restart the app".to_string())
}

#[tauri::command]
pub async fn list_apps(app: AppHandle, force: bool) -> Result<LauncherState, String> {
    // Acquire before spawning, so repeated IPC calls cannot queue more scans.
    let request = ListRequest::begin(&LIST_IN_FLIGHT)?;
    tauri::async_runtime::spawn_blocking(move || {
        // The worker owns the claim even if its caller stops awaiting the result.
        let _request = request;
        let store = StorePaths::new(&app)?;
        load_apps(&store, force, || {
            #[cfg(target_os = "windows")]
            let _com = WindowsComGuard::initialize()?;
            Ok(scan_installed_apps())
        })
    })
    .await
    .map_err(|err| format!("Application discovery worker failed: {err}"))?
}

fn load_apps(
    store: &StorePaths,
    force: bool,
    discover: impl FnOnce() -> Result<Vec<ScannedApp>, String>,
) -> Result<LauncherState, String> {
    let mut cache: ScanCache = {
        let _access = lock_store()?;
        read_json(&store.cache)?
    };
    let needs_scan = force || cache.version != CACHE_VERSION || cache.apps.is_empty();
    if needs_scan {
        cache = ScanCache {
            version: CACHE_VERSION,
            apps: discover()?,
        };
    }
    let (overlay, device) = {
        let _access = lock_store()?;
        if needs_scan {
            write_json(&store.cache, &cache)?;
        }
        // Read user data after discovery, preserving edits made during the scan.
        (
            read_json::<OverlayData>(&store.overlay)?,
            read_json::<DeviceData>(&store.device)?,
        )
    };
    Ok(build_state(&overlay, &device, &cache))
}

#[tauri::command]
pub fn launch_app(app: AppHandle, id: String) -> Result<LaunchAppResult, String> {
    let store = StorePaths::new(&app)?;
    let (cache, overlay, device) = {
        let _access = lock_store()?;
        (
            read_json::<ScanCache>(&store.cache)?,
            read_json::<OverlayData>(&store.overlay)?,
            read_json::<DeviceData>(&store.device)?,
        )
    };
    let state = build_state(&overlay, &device, &cache);
    let target = state
        .apps
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "应用不存在，请重新扫描".to_string())?;

    if !target.exists {
        return Err("应用路径不存在".to_string());
    }

    let name = start_launcher_app(target)?;
    let _access = lock_store()?;
    let mut overlay: OverlayData = read_json(&store.overlay)?;
    let stats = record_launch(&mut overlay, &id)?;
    write_json(&store.overlay, &overlay)?;
    Ok(LaunchAppResult {
        name,
        launch_count: stats.launch_count,
        last_launched_at: stats.last_launched_at,
    })
}

#[tauri::command]
pub fn open_app_location(app: AppHandle, id: String) -> Result<(), String> {
    let store = StorePaths::new(&app)?;
    let (cache, overlay, device) = {
        let _access = lock_store()?;
        (
            read_json::<ScanCache>(&store.cache)?,
            read_json::<OverlayData>(&store.overlay)?,
            read_json::<DeviceData>(&store.device)?,
        )
    };
    let state = build_state(&overlay, &device, &cache);
    let target = state
        .apps
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "应用不存在，请重新扫描".to_string())?;

    if target.path.is_empty() {
        return Err("该应用没有可打开的本地路径".to_string());
    }
    if !target.exists {
        return Err("应用路径不存在".to_string());
    }

    open_launcher_app_location(target)
}

#[tauri::command]
pub fn add_custom_app(app: AppHandle, payload: AddCustomPayload) -> Result<String, String> {
    let name = clean_text(&payload.name);
    let path = clean_text(&payload.path);
    if name.is_empty() {
        return Err("名称不能为空".to_string());
    }
    if path.is_empty() {
        return Err("路径不能为空".to_string());
    }

    let _access = lock_store()?;
    let store = StorePaths::new(&app)?;
    let mut device: DeviceData = read_json(&store.device)?;
    let mut overlay: OverlayData = read_json(&store.overlay)?;
    let id = format!("custom:{}", now_millis()?);
    device.custom.push(CustomApp {
        id: id.clone(),
        name: name.clone(),
        icon: icon_for_path(&path),
        path,
        args: clean_text(&payload.args),
    });

    let override_item = overlay.overrides.entry(id.clone()).or_default();
    override_item.name = Some(name);
    override_item.group = optional_clean(&payload.group);
    override_item.note = optional_clean(&payload.note);
    override_item.pinned = Some(payload.pinned);

    write_json(&store.device, &device)?;
    write_json(&store.overlay, &overlay)?;
    Ok(id)
}

#[tauri::command]
pub fn update_app(app: AppHandle, payload: UpdateAppPayload) -> Result<(), String> {
    let _access = lock_store()?;
    let store = StorePaths::new(&app)?;
    let mut device: DeviceData = read_json(&store.device)?;
    let mut overlay: OverlayData = read_json(&store.overlay)?;

    if let Some(custom) = device.custom.iter_mut().find(|item| item.id == payload.id) {
        if let Some(name) = &payload.name {
            custom.name = clean_text(name);
        }
        if let Some(path) = &payload.path {
            custom.path = clean_text(path);
            custom.icon = icon_for_path(&custom.path);
        }
        if let Some(args) = &payload.args {
            custom.args = clean_text(args);
        }
    }

    let override_item = overlay.overrides.entry(payload.id).or_default();
    if let Some(name) = payload.name {
        override_item.name = optional_clean(&name);
    }
    if let Some(group) = payload.group {
        override_item.group = optional_clean(&group);
    }
    if let Some(note) = payload.note {
        override_item.note = optional_clean(&note);
    }
    if let Some(pinned) = payload.pinned {
        override_item.pinned = Some(pinned);
    }
    if let Some(hidden) = payload.hidden {
        override_item.hidden = Some(hidden);
    }

    write_json(&store.device, &device)?;
    write_json(&store.overlay, &overlay)
}

#[tauri::command]
pub fn delete_app(app: AppHandle, id: String) -> Result<(), String> {
    let _access = lock_store()?;
    let store = StorePaths::new(&app)?;
    let mut device: DeviceData = read_json(&store.device)?;
    let mut overlay: OverlayData = read_json(&store.overlay)?;
    let original_len = device.custom.len();
    device.custom.retain(|item| item.id != id);

    if device.custom.len() < original_len {
        overlay.overrides.remove(&id);
        write_json(&store.device, &device)?;
    } else {
        overlay.overrides.entry(id).or_default().hidden = Some(true);
    }

    write_json(&store.overlay, &overlay)
}

#[tauri::command]
pub fn save_groups(app: AppHandle, groups: Vec<String>) -> Result<Vec<String>, String> {
    let _access = lock_store()?;
    let store = StorePaths::new(&app)?;
    let mut overlay: OverlayData = read_json(&store.overlay)?;
    let next_groups = normalize_groups(groups);
    let group_set: HashSet<String> = next_groups.iter().cloned().collect();
    overlay.groups = next_groups;
    for override_item in overlay.overrides.values_mut() {
        if let Some(group) = &override_item.group {
            if !group_set.contains(group) {
                override_item.group = None;
            }
        }
    }
    write_json(&store.overlay, &overlay)?;
    Ok(overlay.groups)
}

#[tauri::command]
pub fn migrate_group(app: AppHandle, from: String, to: String) -> Result<usize, String> {
    let from_group = clean_text(&from);
    let to_group = clean_text(&to);
    if from_group.is_empty() {
        return Ok(0);
    }

    let _access = lock_store()?;
    let store = StorePaths::new(&app)?;
    let mut overlay: OverlayData = read_json(&store.overlay)?;
    let mut count = 0;
    for override_item in overlay.overrides.values_mut() {
        if override_item.group.as_deref() == Some(from_group.as_str()) {
            override_item.group = if to_group.is_empty() {
                None
            } else {
                Some(to_group.clone())
            };
            count += 1;
        }
    }
    if !to_group.is_empty() && !overlay.groups.contains(&to_group) {
        overlay.groups.push(to_group);
    }
    overlay.groups.retain(|group| group != &from_group);
    overlay.groups = normalize_groups(overlay.groups);
    write_json(&store.overlay, &overlay)?;
    Ok(count)
}

fn build_state(overlay: &OverlayData, device: &DeviceData, cache: &ScanCache) -> LauncherState {
    let mut apps = Vec::new();

    for custom in &device.custom {
        let override_item = overlay.overrides.get(&custom.id);
        apps.push(to_launcher_app(
            &custom.id,
            &custom.name,
            &custom.path,
            &custom.args,
            "",
            "",
            "custom",
            &custom.icon,
            override_item,
        ));
    }

    for scanned in &cache.apps {
        let override_item = overlay.overrides.get(&scanned.id);
        apps.push(to_launcher_app(
            &scanned.id,
            &scanned.name,
            &scanned.path,
            &scanned.args,
            &scanned.bundle_id,
            &scanned.aumid,
            &scanned.source,
            &scanned.icon,
            override_item,
        ));
    }

    apps.sort_by(|left, right| {
        right
            .pinned
            .cmp(&left.pinned)
            .then_with(|| left.order.total_cmp(&right.order))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    LauncherState {
        groups: normalize_groups(overlay.groups.clone()),
        apps,
    }
}

fn to_launcher_app(
    id: &str,
    name: &str,
    path: &str,
    args: &str,
    bundle_id: &str,
    aumid: &str,
    source: &str,
    icon: &str,
    override_item: Option<&AppOverride>,
) -> LauncherApp {
    LauncherApp {
        id: id.to_string(),
        name: override_item
            .and_then(|item| item.name.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| name.to_string()),
        path: path.to_string(),
        args: args.to_string(),
        bundle_id: bundle_id.to_string(),
        aumid: aumid.to_string(),
        source: source.to_string(),
        group: override_item
            .and_then(|item| item.group.clone())
            .unwrap_or_default(),
        note: override_item
            .and_then(|item| item.note.clone())
            .unwrap_or_default(),
        pinned: override_item.and_then(|item| item.pinned).unwrap_or(false),
        hidden: override_item.and_then(|item| item.hidden).unwrap_or(false),
        launch_count: override_item
            .and_then(|item| item.launch_count)
            .unwrap_or(0),
        last_launched_at: override_item.and_then(|item| item.last_launched_at),
        order: override_item.and_then(|item| item.order).unwrap_or(0.0),
        exists: source == "uwp" || Path::new(path).exists(),
        icon: icon.to_string(),
    }
}

struct LaunchStats {
    launch_count: u32,
    last_launched_at: u64,
}

fn record_launch(overlay: &mut OverlayData, id: &str) -> Result<LaunchStats, String> {
    let last_launched_at = now_millis_u64()?;
    let override_item = overlay.overrides.entry(id.to_string()).or_default();
    let launch_count = override_item.launch_count.unwrap_or(0).saturating_add(1);
    override_item.launch_count = Some(launch_count);
    override_item.last_launched_at = Some(last_launched_at);
    Ok(LaunchStats {
        launch_count,
        last_launched_at,
    })
}

fn start_launcher_app(target: LauncherApp) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        launch_windows_app(target)
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("/usr/bin/open");
        command.arg(&target.path);
        let args = split_args(&target.args);
        if !args.is_empty() {
            command.arg("--args").args(args);
        }
        command.spawn().map_err(|err| format!("启动失败: {err}"))?;
        Ok(target.name)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = target;
        Err("当前 V1 仅支持 macOS/Windows 应用启动".to_string())
    }
}

fn open_launcher_app_location(target: LauncherApp) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        open_windows_app_location(target)
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .arg("-R")
            .arg(&target.path)
            .spawn()
            .map_err(|err| format!("打开所在文件夹失败: {err}"))?;
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = target;
        Err("当前平台不支持打开所在文件夹".to_string())
    }
}

fn scan_installed_apps() -> Vec<ScannedApp> {
    #[cfg(target_os = "macos")]
    {
        let mut seen = HashSet::new();
        let mut apps = Vec::new();
        for app_path in mac_app_paths() {
            if let Some(app) = scanned_mac_app(&app_path) {
                if seen.insert(app.id.clone()) {
                    apps.push(app);
                }
            }
        }
        apps.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
        apps
    }

    #[cfg(target_os = "windows")]
    {
        scan_windows_apps()
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "windows")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowsScanItem {
    #[serde(default)]
    kind: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    args: String,
    #[serde(default)]
    working_directory: String,
    #[serde(default)]
    aumid: String,
    #[serde(default)]
    icon_path: String,
}

#[cfg(target_os = "windows")]
const WINDOWS_SCAN_PS: &str = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'

function Resolve-UwpIconPath($aumid, $packagesByFamily) {
  if (-not $aumid -or -not $aumid.Contains('!')) { return '' }
  $parts = $aumid.Split('!', 2)
  if ($parts.Length -lt 2) { return '' }
  $family = $parts[0].ToLower()
  $appId = $parts[1]
  if (-not $packagesByFamily.ContainsKey($family)) { return '' }

  $pkg = $packagesByFamily[$family]
  if (-not $pkg.InstallLocation) { return '' }
  $manifestPath = Join-Path $pkg.InstallLocation 'AppxManifest.xml'
  if (-not (Test-Path -LiteralPath $manifestPath)) { return '' }

  try { [xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw }
  catch { return '' }

  $apps = @($manifest.Package.Applications.Application)
  if ($apps.Count -eq 0) { return '' }
  $app = $apps | Where-Object { $_.Id -eq $appId } | Select-Object -First 1
  if (-not $app) { $app = $apps | Select-Object -First 1 }
  if (-not $app.VisualElements) { return '' }

  $logo = $app.VisualElements.Square44x44Logo
  if (-not $logo) { $logo = $app.VisualElements.Logo }
  if (-not $logo) { return '' }

  $base = Join-Path $pkg.InstallLocation $logo
  $dir = Split-Path -Parent $base
  $leaf = [System.IO.Path]::GetFileNameWithoutExtension($base)
  $ext = [System.IO.Path]::GetExtension($base)
  $candidates = @(
    (Join-Path $dir "$leaf.targetsize-256$ext"),
    (Join-Path $dir "$leaf.targetsize-128$ext"),
    (Join-Path $dir "$leaf.scale-400$ext"),
    (Join-Path $dir "$leaf.scale-300$ext"),
    (Join-Path $dir "$leaf.scale-200$ext"),
    (Join-Path $dir "$leaf.scale-150$ext"),
    (Join-Path $dir "$leaf.targetsize-64$ext"),
    (Join-Path $dir "$leaf.targetsize-48$ext"),
    $base
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  $match = Get-ChildItem -LiteralPath $dir -Filter "$leaf*$ext" -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    Select-Object -First 1
  if ($match) { return $match.FullName }
  return ''
}

$packagesByFamily = @{}
Get-AppxPackage | ForEach-Object {
  if ($_.PackageFamilyName) { $packagesByFamily[$_.PackageFamilyName.ToLower()] = $_ }
}

$sh = New-Object -ComObject WScript.Shell
$dirs = @(
  [Environment]::GetFolderPath('CommonStartMenu'),
  [Environment]::GetFolderPath('StartMenu')
)
$seen = @{}
$result = New-Object System.Collections.ArrayList
foreach ($d in $dirs) {
  if (-not $d -or -not (Test-Path -LiteralPath $d)) { continue }
  Get-ChildItem -LiteralPath $d -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
    $lnk = $sh.CreateShortcut($_.FullName)
    $target = $lnk.TargetPath
    if (-not $target) { return }
    if ([System.IO.Path]::GetExtension($target).ToLower() -ne '.exe') { return }
    if (-not (Test-Path -LiteralPath $target)) { return }
    $name = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
    if ($name -match '卸载|卸載|uninstall|remove|repair|帮助|help|readme') { return }
    $key = $target.ToLower()
    if ($seen.ContainsKey($key)) { return }
    $seen[$key] = $true
    [void]$result.Add([PSCustomObject]@{
      kind = 'exe'
      name = $name
      path = $target
      args = $lnk.Arguments
      workingDirectory = $lnk.WorkingDirectory
      iconPath = $lnk.IconLocation
      aumid = ''
    })
  }
}

Get-StartApps | ForEach-Object {
  $aid = $_.AppID
  if ($aid -and $aid.Contains('!')) {
    [void]$result.Add([PSCustomObject]@{
      kind = 'uwp'
      name = $_.Name
      path = ''
      args = ''
      workingDirectory = ''
      iconPath = (Resolve-UwpIconPath $aid $packagesByFamily)
      aumid = $aid
    })
  }
}

ConvertTo-Json -InputObject @($result) -Compress
"#;

#[cfg(target_os = "windows")]
fn scan_windows_apps() -> Vec<ScannedApp> {
    let encoded = encode_powershell(WINDOWS_SCAN_PS);
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            &encoded,
        ])
        .output();

    let Ok(output) = output else {
        return Vec::new();
    };
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return Vec::new();
    }

    let Ok(items) = parse_windows_scan_items(&stdout) else {
        return Vec::new();
    };

    let mut seen = HashSet::new();
    let mut apps = Vec::new();
    for item in items {
        let name = clean_text(&item.name);
        if name.is_empty() || should_skip_app(&name) {
            continue;
        }

        if item.kind == "uwp" {
            let aumid = clean_text(&item.aumid);
            if aumid.is_empty() || is_system_uwp(&aumid) {
                continue;
            }
            let id = format!("uwp:{}", aumid.to_lowercase());
            if !seen.insert(id.clone()) {
                continue;
            }
            apps.push(ScannedApp {
                id,
                name,
                path: String::new(),
                args: String::new(),
                bundle_id: String::new(),
                aumid,
                source: "uwp".to_string(),
                icon: windows_icon_for_path(&item.icon_path)
                    .or_else(|| {
                        windows_icon_for_path(&format!(
                            "shell:AppsFolder\\{}",
                            clean_text(&item.aumid)
                        ))
                    })
                    .unwrap_or_default(),
            });
            continue;
        }

        let path = clean_text(&item.path);
        if path.is_empty()
            || is_system_exe(&path)
            || should_skip_windows_shortcut(&name, &path, &item.args)
        {
            continue;
        }
        let id = windows_exe_id(&name, &path);
        if !seen.insert(id.clone()) {
            continue;
        }
        apps.push(ScannedApp {
            id,
            name,
            path: path.clone(),
            args: clean_text(&item.args),
            bundle_id: String::new(),
            aumid: String::new(),
            source: "start_menu".to_string(),
            icon: windows_shortcut_icon_candidate(&item.icon_path, &item.working_directory, &path)
                .and_then(|icon_path| windows_icon_for_path(&icon_path))
                .or_else(|| windows_icon_for_path(&path))
                .unwrap_or_default(),
        });
    }

    apps.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    apps
}

#[cfg(target_os = "windows")]
fn parse_windows_scan_items(raw: &str) -> Result<Vec<WindowsScanItem>, serde_json::Error> {
    serde_json::from_str::<Vec<WindowsScanItem>>(raw)
        .or_else(|_| serde_json::from_str::<WindowsScanItem>(raw).map(|single| vec![single]))
}

#[cfg(target_os = "windows")]
fn encode_powershell(script: &str) -> String {
    let mut bytes = Vec::with_capacity(script.len() * 2);
    for unit in script.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(target_os = "windows")]
fn windows_exe_id(name: &str, path: &str) -> String {
    let base = Path::new(path)
        .file_name()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    format!("exe:{}|{}", normalize_windows_name(name), base)
}

#[cfg(target_os = "windows")]
fn normalize_windows_name(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

#[cfg(target_os = "windows")]
fn is_system_exe(path: &str) -> bool {
    let Ok(windows_root) = std::env::var("SystemRoot") else {
        return false;
    };
    let normalized = path.to_lowercase();
    let root = windows_root.to_lowercase();
    if normalized == root || normalized.starts_with(&format!("{root}\\")) {
        return true;
    }

    let file_name = Path::new(path)
        .file_name()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    matches!(
        file_name.as_str(),
        "wordpad.exe" | "wmplayer.exe" | "iexplore.exe" | "mip.exe"
    )
}

#[cfg(target_os = "windows")]
fn should_skip_windows_shortcut(name: &str, path: &str, args: &str) -> bool {
    let name = normalize_name_phrase(name);
    let args = args.to_lowercase();
    let path_lowered = path.replace('/', "\\").to_lowercase();
    let file_name = Path::new(path)
        .file_name()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();

    if name == "nvm" && file_name == "nvm.exe" {
        return true;
    }
    if name.starts_with("python ")
        && (name.contains("(64-bit)") || name.contains("(32-bit)"))
        && file_name == "python.exe"
    {
        return true;
    }
    if name.contains("command line client") {
        return true;
    }
    if file_name == "mysql.exe" && (name.contains("mysql") || args.contains("-uroot")) {
        return true;
    }
    if file_name == "hh.exe" && args.contains(".chm") {
        return true;
    }
    if file_name == "appcertui.exe" || name == "windows app cert kit" {
        return true;
    }
    if name.starts_with("add a new ") && name.contains("adapter") {
        return true;
    }
    if (name.ends_with("-service") || name.contains(" service"))
        && (file_name.contains("svc") || file_name.contains("service"))
    {
        return true;
    }
    if path_lowered.contains("\\windows kits\\") && (name.contains("cert") || name.contains("kit"))
    {
        return true;
    }

    false
}

#[cfg(target_os = "windows")]
fn is_system_uwp(aumid: &str) -> bool {
    if aumid.is_empty() || aumid.contains("!!!!") {
        return true;
    }
    let family = aumid.split_once('!').map(|(left, _)| left).unwrap_or(aumid);
    let family = family.to_lowercase();
    if family.starts_with("microsoft.")
        || family.starts_with("windows.")
        || family.starts_with("microsoftwindows.")
    {
        return true;
    }
    let publisher = family
        .rsplit_once('_')
        .map(|(_, right)| right)
        .unwrap_or("");
    matches!(publisher, "8wekyb3d8bbwe" | "cw5n1h2txyewy")
}

#[cfg(target_os = "windows")]
fn launch_windows_app(target: LauncherApp) -> Result<String, String> {
    if target.source == "uwp" {
        if target.aumid.trim().is_empty() {
            return Err("UWP 应用缺少 AppUserModelID".to_string());
        }
        Command::new("explorer.exe")
            .arg(format!("shell:AppsFolder\\{}", target.aumid))
            .spawn()
            .map_err(|err| format!("启动失败: {err}"))?;
        return Ok(target.name);
    }

    if target.path.trim().is_empty() {
        return Err("应用路径为空".to_string());
    }

    let path = Path::new(&target.path);
    let extension = path
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if extension == "lnk" {
        Command::new("explorer.exe")
            .arg(&target.path)
            .spawn()
            .map_err(|err| format!("启动失败: {err}"))?;
        return Ok(target.name);
    }

    let mut command = Command::new(&target.path);
    command.args(split_args(&target.args));
    command.spawn().map_err(|err| format!("启动失败: {err}"))?;
    Ok(target.name)
}

#[cfg(target_os = "windows")]
fn open_windows_app_location(target: LauncherApp) -> Result<(), String> {
    let path = clean_text(&target.path);
    if path.is_empty() {
        return Err("应用路径为空".to_string());
    }

    let target_path = Path::new(&path);
    let mut command = Command::new("explorer.exe");
    if target_path.is_dir() {
        command.arg(&path);
    } else {
        command.arg(format!("/select,{path}"));
    }
    command
        .spawn()
        .map_err(|err| format!("打开所在文件夹失败: {err}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn windows_icon_for_path(path: &str) -> Option<String> {
    let path = clean_text(path);
    if path.is_empty() {
        return None;
    }

    let (icon_path, icon_index) = split_windows_icon_location(&path);
    if let Some(data_uri) = image_file_data_uri(&path) {
        return Some(data_uri);
    }
    if icon_path != path {
        if let Some(data_uri) = image_file_data_uri(&icon_path) {
            return Some(data_uri);
        }
    }

    windows_extract_icon_data_uri(&icon_path, icon_index)
        .or_else(|| windows_shell_file_icon_data_uri(&icon_path))
}

#[cfg(target_os = "windows")]
fn image_file_data_uri(path: &str) -> Option<String> {
    let extension = Path::new(path)
        .extension()
        .map(|value| value.to_string_lossy().to_lowercase())?;
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => return None,
    };
    let bytes = fs::read(path).ok()?;
    Some(bytes_to_data_uri(mime, &bytes))
}

#[cfg(target_os = "windows")]
fn split_windows_icon_location(value: &str) -> (String, i32) {
    let trimmed = clean_text(value).trim_matches('"').to_string();
    let Some((path, index)) = trimmed.rsplit_once(',') else {
        return (trimmed, 0);
    };
    let Ok(index) = index.trim().parse::<i32>() else {
        return (trimmed, 0);
    };
    (path.trim().trim_matches('"').to_string(), index)
}

#[cfg(target_os = "windows")]
fn windows_shortcut_icon_candidate(
    icon_location: &str,
    working_directory: &str,
    target_path: &str,
) -> Option<String> {
    let icon_location = clean_text(icon_location);
    if icon_location.is_empty() || icon_location == ",0" {
        return None;
    }

    let (icon_path, icon_index) = split_windows_icon_location(&icon_location);
    if icon_path.is_empty() {
        return None;
    }

    let expanded = expand_windows_env_vars(&icon_path);
    let candidates = if Path::new(&expanded).is_absolute() {
        vec![expanded]
    } else {
        let mut candidates = Vec::new();
        let working_directory = clean_text(working_directory);
        if !working_directory.is_empty() {
            candidates.push(
                Path::new(&working_directory)
                    .join(&expanded)
                    .to_string_lossy()
                    .to_string(),
            );
        }
        if let Some(parent) = Path::new(target_path).parent() {
            let candidate = parent.join(&expanded).to_string_lossy().to_string();
            if !candidates
                .iter()
                .any(|item| item.eq_ignore_ascii_case(&candidate))
            {
                candidates.push(candidate);
            }
        }
        candidates.push(expanded);
        candidates
    };

    let resolved = candidates
        .iter()
        .find(|candidate| Path::new(candidate.as_str()).exists())
        .cloned()
        .or_else(|| candidates.first().cloned())?;
    Some(format!("{resolved},{icon_index}"))
}

#[cfg(target_os = "windows")]
fn expand_windows_env_vars(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut expanded = String::with_capacity(value.len());
    let mut index = 0;

    while index < chars.len() {
        if chars[index] == '%' {
            if let Some(end_offset) = chars[index + 1..].iter().position(|item| *item == '%') {
                let end = index + 1 + end_offset;
                let name: String = chars[index + 1..end].iter().collect();
                if !name.is_empty() {
                    if let Some(replacement) = std::env::vars()
                        .find(|(key, _)| key.eq_ignore_ascii_case(&name))
                        .map(|(_, value)| value)
                    {
                        expanded.push_str(&replacement);
                        index = end + 1;
                        continue;
                    }
                }
            }
        }

        expanded.push(chars[index]);
        index += 1;
    }

    expanded
}

// Shell icon lookup requires COM on the calling thread. Blocking-pool threads
// cannot inherit the main window's apartment, and every successful init is paired.
#[cfg(target_os = "windows")]
struct WindowsComGuard(bool, std::marker::PhantomData<std::rc::Rc<()>>);

#[cfg(target_os = "windows")]
impl WindowsComGuard {
    fn initialize() -> Result<Self, String> {
        use windows_sys::Win32::{
            Foundation::RPC_E_CHANGED_MODE,
            System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED},
        };
        let result = unsafe { CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32) };
        if result >= 0 {
            Ok(Self(true, std::marker::PhantomData))
        } else if result == RPC_E_CHANGED_MODE {
            // Another owner initialized this reused thread in a different apartment.
            Ok(Self(false, std::marker::PhantomData))
        } else {
            Err(format!(
                "Unable to initialize Windows application discovery: {result:#x}"
            ))
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsComGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe { windows_sys::Win32::System::Com::CoUninitialize() };
        }
    }
}

#[cfg(target_os = "windows")]
type WindowsHicon = windows_sys::Win32::UI::WindowsAndMessaging::HICON;

#[cfg(target_os = "windows")]
struct WindowsIconGuard(WindowsHicon);

#[cfg(target_os = "windows")]
impl WindowsIconGuard {
    fn new(icon: WindowsHicon) -> Option<Self> {
        if icon.is_null() {
            None
        } else {
            Some(Self(icon))
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsIconGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon(self.0);
        }
    }
}

#[cfg(target_os = "windows")]
fn windows_extract_icon_data_uri(path: &str, icon_index: i32) -> Option<String> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt, ptr};
    use windows_sys::Win32::{Foundation::S_OK, UI::Shell::SHDefExtractIconW};

    let wide: Vec<u16> = OsStr::new(path).encode_wide().chain(Some(0)).collect();
    let mut large_icon: WindowsHicon = ptr::null_mut();
    const ICON_SIZE: u32 = 128;
    let icon_size = (ICON_SIZE << 16) | ICON_SIZE;
    let result = unsafe {
        SHDefExtractIconW(
            wide.as_ptr(),
            icon_index,
            0,
            &mut large_icon,
            ptr::null_mut(),
            icon_size,
        )
    };
    if result != S_OK {
        return None;
    }
    let icon = WindowsIconGuard::new(large_icon)?;
    windows_icon_to_png_data_uri(&icon, ICON_SIZE, ICON_SIZE)
}

#[cfg(target_os = "windows")]
fn windows_shell_file_icon_data_uri(path: &str) -> Option<String> {
    use std::{ffi::OsStr, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};

    let wide: Vec<u16> = OsStr::new(path).encode_wide().chain(Some(0)).collect();
    let mut file_info: SHFILEINFOW = unsafe { std::mem::zeroed() };
    let result = unsafe {
        SHGetFileInfoW(
            wide.as_ptr(),
            0,
            &mut file_info,
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if result == 0 || file_info.hIcon.is_null() {
        return None;
    }

    let icon = WindowsIconGuard::new(file_info.hIcon)?;
    windows_icon_to_png_data_uri(&icon, 128, 128)
}

#[cfg(target_os = "windows")]
fn windows_icon_to_png_data_uri(
    icon: &WindowsIconGuard,
    width: u32,
    height: u32,
) -> Option<String> {
    use std::ptr;
    use windows_sys::Win32::{
        Graphics::Gdi::{
            CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
            SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        },
        UI::WindowsAndMessaging::{DrawIconEx, DI_NORMAL},
    };

    let width_i32 = i32::try_from(width).ok()?;
    let height_i32 = i32::try_from(height).ok()?;
    let hdc = unsafe { CreateCompatibleDC(ptr::null_mut()) };
    if hdc.is_null() {
        return None;
    }

    let mut bitmap_info: BITMAPINFO = unsafe { std::mem::zeroed() };
    bitmap_info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    bitmap_info.bmiHeader.biWidth = width_i32;
    bitmap_info.bmiHeader.biHeight = -height_i32;
    bitmap_info.bmiHeader.biPlanes = 1;
    bitmap_info.bmiHeader.biBitCount = 32;
    bitmap_info.bmiHeader.biCompression = BI_RGB as u32;

    let screen_dc = unsafe { GetDC(ptr::null_mut()) };
    if screen_dc.is_null() {
        unsafe {
            let _ = DeleteDC(hdc);
        }
        return None;
    }

    let mut pixels_ptr = ptr::null_mut();
    let hbitmap = unsafe {
        CreateDIBSection(
            screen_dc,
            &bitmap_info,
            DIB_RGB_COLORS,
            &mut pixels_ptr,
            ptr::null_mut(),
            0,
        )
    };
    unsafe {
        let _ = ReleaseDC(ptr::null_mut(), screen_dc);
    }
    if hbitmap.is_null() || pixels_ptr.is_null() {
        unsafe {
            let _ = DeleteDC(hdc);
        }
        return None;
    }

    let previous = unsafe { SelectObject(hdc, hbitmap) };
    let drawn = unsafe {
        DrawIconEx(
            hdc,
            0,
            0,
            icon.0,
            width_i32,
            height_i32,
            0,
            ptr::null_mut(),
            DI_NORMAL,
        )
    };
    unsafe {
        let _ = SelectObject(hdc, previous);
    }

    let byte_len = width.checked_mul(height)?.checked_mul(4)? as usize;
    let bgra = if drawn != 0 {
        unsafe { std::slice::from_raw_parts(pixels_ptr.cast::<u8>(), byte_len).to_vec() }
    } else {
        Vec::new()
    };

    unsafe {
        let _ = DeleteObject(hbitmap);
        let _ = DeleteDC(hdc);
    }

    if bgra.is_empty() {
        return None;
    }

    let has_alpha = bgra.chunks_exact(4).any(|pixel| pixel[3] != 0);
    let mut rgba = Vec::with_capacity(bgra.len());
    for pixel in bgra.chunks_exact(4) {
        rgba.push(pixel[2]);
        rgba.push(pixel[1]);
        rgba.push(pixel[0]);
        rgba.push(if has_alpha { pixel[3] } else { 255 });
    }

    rgba_to_png_data_uri(width, height, &rgba)
}

#[cfg(target_os = "macos")]
fn mac_app_paths() -> Vec<PathBuf> {
    let mut roots = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/Applications/Utilities"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }

    let mut paths = Vec::new();
    for root in roots {
        collect_app_paths(&root, 0, &mut paths);
    }
    paths
}

#[cfg(target_os = "macos")]
fn collect_app_paths(root: &Path, depth: u8, paths: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("app") {
            paths.push(path);
        } else if depth == 0 && path.is_dir() {
            collect_app_paths(&path, depth + 1, paths);
        }
    }
}

#[cfg(target_os = "macos")]
fn scanned_mac_app(path: &Path) -> Option<ScannedApp> {
    let fallback_name = path.file_stem()?.to_string_lossy().trim().to_string();
    let display_name =
        mdls_value(path, "kMDItemDisplayName").unwrap_or_else(|| fallback_name.clone());
    if should_skip_app(&display_name) {
        return None;
    }
    let bundle_id = mdls_value(path, "kMDItemCFBundleIdentifier").unwrap_or_default();
    let id = if bundle_id.is_empty() {
        format!("mac:path:{}", normalize_key(&path.to_string_lossy()))
    } else {
        format!("mac:{}", bundle_id.to_lowercase())
    };

    Some(ScannedApp {
        id,
        name: display_name,
        path: path.to_string_lossy().to_string(),
        args: String::new(),
        bundle_id,
        aumid: String::new(),
        source: "mac_app".to_string(),
        icon: extract_app_icon(path).unwrap_or_default(),
    })
}

#[cfg(target_os = "macos")]
fn mdls_value(path: &Path, key: &str) -> Option<String> {
    let output = Command::new("/usr/bin/mdls")
        .arg("-raw")
        .arg("-name")
        .arg(key)
        .arg(path)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() || value == "(null)" {
        None
    } else {
        Some(value)
    }
}

/// 提取 macOS .app 自带图标，转成 128px PNG 的 data URI；失败返回 None（前端显示统一占位图标）。
#[cfg(target_os = "macos")]
fn extract_app_icon(path: &Path) -> Option<String> {
    let resources = path.join("Contents/Resources");
    let icns = locate_icns(path, &resources)?;
    icns_to_data_uri(&icns)
}

#[cfg(target_os = "macos")]
fn locate_icns(bundle: &Path, resources: &Path) -> Option<PathBuf> {
    // 优先读 Info.plist 里声明的 CFBundleIconFile。
    if let Some(name) = plist_icon_name(bundle) {
        let direct = resources.join(&name);
        if direct.extension().and_then(|ext| ext.to_str()) == Some("icns") && direct.exists() {
            return Some(direct);
        }
        let with_ext = resources.join(format!("{name}.icns"));
        if with_ext.exists() {
            return Some(with_ext);
        }
    }
    // 兜底：取 Resources 下第一个 .icns（按名称排序保证稳定）。
    let mut icns_files: Vec<PathBuf> = fs::read_dir(resources)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|item| item.extension().and_then(|ext| ext.to_str()) == Some("icns"))
        .collect();
    icns_files.sort();
    icns_files.into_iter().next()
}

#[cfg(target_os = "macos")]
fn plist_icon_name(bundle: &Path) -> Option<String> {
    let output = Command::new("/usr/libexec/PlistBuddy")
        .arg("-c")
        .arg("Print :CFBundleIconFile")
        .arg(bundle.join("Contents/Info.plist"))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

#[cfg(target_os = "macos")]
fn icns_to_data_uri(icns: &Path) -> Option<String> {
    let tmp = std::env::temp_dir().join(format!(
        "launcher-icon-{}.png",
        normalize_key(&icns.to_string_lossy())
    ));
    let output = Command::new("/usr/bin/sips")
        .arg("-s")
        .arg("format")
        .arg("png")
        .arg("-Z")
        .arg("128")
        .arg(icns)
        .arg("--out")
        .arg(&tmp)
        .output()
        .ok()?;
    if !output.status.success() {
        let _ = fs::remove_file(&tmp);
        return None;
    }
    let bytes = fs::read(&tmp).ok()?;
    let _ = fs::remove_file(&tmp);
    Some(bytes_to_data_uri("image/png", &bytes))
}

#[cfg(target_os = "windows")]
fn rgba_to_png_data_uri(width: u32, height: u32, rgba: &[u8]) -> Option<String> {
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(std::io::Cursor::new(&mut bytes), width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(bytes_to_data_uri("image/png", &bytes))
}

fn bytes_to_data_uri(mime: &str, bytes: &[u8]) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{mime};base64,{encoded}")
}

/// 自定义应用：路径指向可识别应用时提取真实图标，否则留空走统一占位图标。
fn icon_for_path(path: &str) -> String {
    #[cfg(target_os = "macos")]
    {
        let bundle = Path::new(path);
        if bundle.extension().and_then(|ext| ext.to_str()) == Some("app") {
            return extract_app_icon(bundle).unwrap_or_default();
        }
        String::new()
    }

    #[cfg(target_os = "windows")]
    {
        return windows_icon_for_path(path).unwrap_or_default();
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = path;
        String::new()
    }
}

fn should_skip_app(name: &str) -> bool {
    let lowered = normalize_name_phrase(name);
    if lowered.is_empty() {
        return true;
    }

    let skip_fragments = [
        "uninstall",
        "uninstaller",
        "installer",
        "setup",
        "repair",
        "readme",
        "manual",
        "manuals",
        "documentation",
        "docs",
        "command line client",
    ];
    if skip_fragments
        .iter()
        .any(|fragment| lowered.contains(fragment))
    {
        return true;
    }

    lowered.contains('\u{5378}') && lowered.contains('\u{8f7d}')
}

fn normalize_name_phrase(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    static SCAN_TESTS: Mutex<()> = Mutex::new(());

    struct TestStore {
        root: PathBuf,
        paths: StorePaths,
    }

    impl TestStore {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "app-launcher-scan-test-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            Self {
                paths: StorePaths {
                    overlay: root.join("overlay.json"),
                    device: root.join("device.json"),
                    cache: root.join("scan_cache.json"),
                },
                root,
            }
        }
    }

    impl Drop for TestStore {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn scanned_app(id: &str) -> ScannedApp {
        ScannedApp {
            id: id.into(),
            name: id.into(),
            path: String::new(),
            args: String::new(),
            bundle_id: String::new(),
            aumid: String::new(),
            source: "uwp".into(),
            icon: String::new(),
        }
    }

    #[test]
    fn refresh_allows_user_edits_during_discovery_and_returns_latest_data() {
        let _test = SCAN_TESTS.lock().unwrap();
        let store = TestStore::new();
        let state = load_apps(&store.paths, true, || {
            // A concurrent editor must be able to finish before discovery does.
            std::thread::scope(|scope| {
                scope
                    .spawn(|| {
                        let _access = STORE_ACCESS
                            .try_lock()
                            .expect("discovery must not lock storage");
                        let mut overlay = OverlayData::default();
                        overlay.groups.push("Work".into());
                        overlay.overrides.insert(
                            "scanned".into(),
                            AppOverride {
                                name: Some("User name".into()),
                                pinned: Some(true),
                                ..AppOverride::default()
                            },
                        );
                        let device = DeviceData {
                            custom: vec![CustomApp {
                                id: "custom".into(),
                                name: "Custom app".into(),
                                path: String::new(),
                                args: String::new(),
                                icon: String::new(),
                            }],
                        };
                        write_json(&store.paths.overlay, &overlay).unwrap();
                        write_json(&store.paths.device, &device).unwrap();
                    })
                    .join()
                    .unwrap();
            });
            Ok(vec![scanned_app("scanned")])
        })
        .unwrap();
        assert_eq!(state.groups, vec!["Work"]);
        assert_eq!(state.apps.len(), 2);
        let scanned = state.apps.iter().find(|app| app.id == "scanned").unwrap();
        assert_eq!(scanned.name, "User name");
        assert!(scanned.pinned);
        let cached: ScanCache = read_json(&store.paths.cache).unwrap();
        assert_eq!(cached.apps[0].name, "scanned");
    }

    #[test]
    fn failed_discovery_keeps_cache_and_next_request_can_retry() {
        let _test = SCAN_TESTS.lock().unwrap();
        let store = TestStore::new();
        write_json(
            &store.paths.cache,
            &ScanCache {
                version: CACHE_VERSION,
                apps: vec![scanned_app("previous")],
            },
        )
        .unwrap();
        let in_flight = AtomicBool::new(false);
        let result = {
            let _request = ListRequest::begin(&in_flight).unwrap();
            assert!(ListRequest::begin(&in_flight).is_err());
            load_apps(&store.paths, true, || Err("discovery failed".into()))
        };
        assert_eq!(result.unwrap_err(), "discovery failed");
        let cached: ScanCache = read_json(&store.paths.cache).unwrap();
        assert_eq!(cached.apps[0].id, "previous");
        let _retry = ListRequest::begin(&in_flight).expect("failure releases the request claim");
        let state = load_apps(&store.paths, true, || Ok(vec![scanned_app("replacement")])).unwrap();
        assert_eq!(state.apps[0].id, "replacement");
    }

    #[test]
    fn worker_unwinding_releases_the_request_claim() {
        let in_flight = AtomicBool::new(false);
        let failed = std::panic::catch_unwind(|| {
            let _request = ListRequest::begin(&in_flight).unwrap();
            panic!("simulated worker failure");
        });
        assert!(failed.is_err());
        assert!(ListRequest::begin(&in_flight).is_ok());
    }

    #[test]
    fn keeps_common_gui_tools() {
        assert!(!should_skip_app("Docker Desktop"));
        assert!(!should_skip_app("Navicat Premium 16"));
        assert!(!should_skip_app("OpenVPN GUI"));
    }

    #[test]
    fn skips_non_user_facing_names() {
        assert!(should_skip_app("MySQL 8.0 Command Line Client - Unicode"));
        assert!(should_skip_app("Python 3.11 Manuals (64-bit)"));
        assert!(should_skip_app("MySQL Installer - Community"));
    }

    #[test]
    fn records_launch_stats_without_overflowing_count() {
        let mut overlay = OverlayData::default();
        overlay.overrides.insert(
            "app:test".to_string(),
            AppOverride {
                name: Some("Pinned Name".to_string()),
                launch_count: Some(u32::MAX),
                ..AppOverride::default()
            },
        );

        let stats = record_launch(&mut overlay, "app:test").expect("record launch stats");
        let override_item = overlay.overrides.get("app:test").expect("override exists");

        assert_eq!(stats.launch_count, u32::MAX);
        assert_eq!(override_item.launch_count, Some(u32::MAX));
        assert_eq!(override_item.last_launched_at, Some(stats.last_launched_at));
        assert_eq!(override_item.name.as_deref(), Some("Pinned Name"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn skips_windows_cli_and_sdk_shortcuts() {
        assert!(should_skip_windows_shortcut(
            "Python 3.11 (64-bit)",
            r"D:\software\Python\Python311\python.exe",
            ""
        ));
        assert!(should_skip_windows_shortcut(
            "nvm",
            r"D:\software\nvm\nvm.exe",
            ""
        ));
        assert!(should_skip_windows_shortcut(
            "Windows App Cert Kit",
            r"C:\Program Files (x86)\Windows Kits\10\App Certification Kit\appcertui.exe",
            ""
        ));
    }
}

fn split_args(args: &str) -> Vec<String> {
    args.split_whitespace().map(ToString::to_string).collect()
}

fn normalize_groups(groups: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    groups
        .into_iter()
        .map(|group| clean_text(&group))
        .filter(|group| !group.is_empty())
        .filter(|group| seen.insert(group.clone()))
        .collect()
}

#[cfg(target_os = "macos")]
fn normalize_key(value: &str) -> String {
    let normalized: String = value
        .chars()
        .flat_map(char::to_lowercase)
        .filter(|char| char.is_ascii_alphanumeric())
        .collect();
    if normalized.is_empty() {
        "unknown".to_string()
    } else {
        normalized
    }
}

fn optional_clean(value: &str) -> Option<String> {
    let text = clean_text(value);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn clean_text(value: &str) -> String {
    value.trim().to_string()
}

fn now_millis() -> Result<u128, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .map_err(|err| format!("系统时间异常: {err}"))
}

fn now_millis_u64() -> Result<u64, String> {
    u64::try_from(now_millis()?).map_err(|_| "系统时间超出可记录范围".to_string())
}

fn read_json<T>(path: &Path) -> Result<T, String>
where
    T: for<'de> Deserialize<'de> + Default,
{
    if !path.exists() {
        return Ok(T::default());
    }
    let content = fs::read_to_string(path).map_err(|err| format!("读取数据失败: {err}"))?;
    if content.trim().is_empty() {
        return Ok(T::default());
    }
    serde_json::from_str(&content).map_err(|err| format!("解析数据失败: {err}"))
}

fn write_json<T>(path: &Path, value: &T) -> Result<(), String>
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("创建数据目录失败: {err}"))?;
    }
    let content =
        serde_json::to_string_pretty(value).map_err(|err| format!("序列化数据失败: {err}"))?;
    fs::write(path, content).map_err(|err| format!("写入数据失败: {err}"))
}

struct StorePaths {
    overlay: PathBuf,
    device: PathBuf,
    cache: PathBuf,
}

impl StorePaths {
    fn new(app: &AppHandle) -> Result<Self, String> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|err| format!("无法定位应用数据目录: {err}"))?
            .join("launcher");
        fs::create_dir_all(&root).map_err(|err| format!("创建数据目录失败: {err}"))?;
        Ok(Self {
            overlay: root.join("overlay.json"),
            device: root.join("device.json"),
            cache: root.join("scan_cache.json"),
        })
    }
}
