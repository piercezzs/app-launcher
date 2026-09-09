//! Windows discovery protocol and stable launch identities; pure for host tests.
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ScanItem {
    pub kind: String,
    pub source: String,
    pub name: String,
    pub path: String,
    pub args: String,
    pub working_directory: String,
    pub aumid: String,
    pub icon_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanResult {
    items: Vec<ScanItem>,
    failed_sources: Vec<String>,
}

pub(super) fn local_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
        && !path.contains('\0')
}

pub(super) fn normalize_path(path: &str) -> String {
    path.replace('/', "\\").to_lowercase()
}

pub(super) fn exe_id(path: &str, args: &str, directory: &str) -> String {
    // JSON tuple avoids delimiter collisions and preserves argument case/quoting.
    format!(
        "exe:v2:{}",
        serde_json::to_string(&(normalize_path(path), args, normalize_path(directory)))
            .expect("string tuple serializes")
    )
}

pub(super) fn parse_scan(raw: &str) -> Result<Vec<ScanItem>, String> {
    let scan: ScanResult = serde_json::from_str(raw.trim_start_matches('\u{feff}').trim())
        .map_err(|_| "Windows 应用扫描返回了无效数据，旧缓存保持不变".to_string())?;
    if !scan.failed_sources.is_empty() {
        return Err("部分 Windows 应用来源读取失败，旧缓存保持不变，请重试".into());
    }
    for item in &scan.items {
        let valid = match item.kind.as_str() {
            "uwp" => item.source == "uwp" && item.aumid.contains('!') && !item.aumid.contains('\0'),
            "exe" => {
                matches!(
                    item.source.as_str(),
                    "start_menu"
                        | "desktop"
                        | "taskbar"
                        | "app_paths"
                        | "uninstall_registry"
                        | "start_apps"
                ) && local_path(&item.path)
                    && item.path.to_lowercase().ends_with(".exe")
                    && (item.working_directory.is_empty() || local_path(&item.working_directory))
            }
            _ => false,
        };
        if !valid
            || item.name.trim().is_empty()
            || item.args.contains('\0')
            || (!item.icon_path.is_empty() && !local_path(&item.icon_path))
        {
            return Err("Windows 应用扫描记录无效，旧缓存保持不变".into());
        }
    }
    Ok(scan.items)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failure_is_not_a_successful_empty_scan() {
        assert!(parse_scan(r#"{"items":[],"failedSources":[]}"#)
            .unwrap()
            .is_empty());
        for raw in [
            "",
            "[]",
            "{}",
            r#"{"items":[],"failedSources":["desktop"]}"#,
        ] {
            assert!(parse_scan(raw).is_err());
        }
    }
    #[test]
    fn rejects_remote_relative_and_invalid_records() {
        for path in [
            r"\\host\share\app.exe",
            r"C:app.exe",
            "app.exe",
            "https://host/app.exe",
        ] {
            assert!(!local_path(path));
        }
        assert!(local_path(r"D:\中文目录\App.exe"));
        assert!(local_path("C:\\"));
        let mut record = serde_json::json!({"kind":"exe","source":"desktop","name":"中文应用","path":"D:\\Apps\\App.exe","args":"--profile \"Work A\"","workingDirectory":"D:\\Apps","iconPath":"","aumid":""});
        assert!(parse_scan(
            &serde_json::json!({"items":[record.clone()],"failedSources":[]}).to_string()
        )
        .is_ok());
        record["source"] = "unexpected".into();
        assert!(
            parse_scan(&serde_json::json!({"items":[record],"failedSources":[]}).to_string())
                .is_err()
        );
    }
    #[test]
    fn identity_preserves_location_arguments_and_working_directory() {
        assert_eq!(
            exe_id("C:/Apps/App.exe", "", ""),
            exe_id(r"c:\apps\app.exe", "", "")
        );
        assert_ne!(
            exe_id(r"C:\one\app.exe", "", ""),
            exe_id(r"D:\two\app.exe", "", "")
        );
        assert_ne!(
            exe_id("C:/a.exe", "--profile Work", ""),
            exe_id("C:/a.exe", "--profile work", "")
        );
        assert_ne!(
            exe_id("C:/a.exe", "", "C:/one"),
            exe_id("C:/a.exe", "", "C:/two")
        );
    }
}
