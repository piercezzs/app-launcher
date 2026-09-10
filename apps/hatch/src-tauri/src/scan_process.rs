//! Bounded execution for the application-owned Windows discovery script.
//!
//! This runner is intentionally not a general-purpose user-command launcher:
//! discovery must not spawn descendants that keep inherited pipe handles open.
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
pub(super) fn run_powershell(script: &str) -> Result<String, String> {
    use std::io::Write;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;

    let system_root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "Windows system directory is unavailable".to_string())?;
    let executable = system_root.join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut resource = tempfile::Builder::new()
        .prefix("hatch-discovery-")
        .suffix(".ps1")
        .tempfile()
        .map_err(|_| "Cannot create the discovery script resource".to_string())?;
    // PS 5.1 needs the BOM to interpret non-ASCII script literals as UTF-8.
    // -File avoids stdin prompts and Windows' encoded-command length limit.
    // Preserve param at the start; the script itself configures output encoding.
    resource
        .write_all(b"\xef\xbb\xbf")
        .and_then(|_| resource.write_all(script.as_bytes()))
        .and_then(|_| resource.flush())
        .map_err(|_| "Cannot write the discovery script resource".to_string())?;
    // Close the writable handle before PowerShell opens the script for reading.
    // Windows sharing checks are bidirectional: its read-only sharing mode can
    // reject our still-open write handle. TempPath retains automatic cleanup.
    let resource = resource.into_temp_path();
    let mut command = Command::new(executable);
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&resource)
        // Applies only to discovery, not to applications the user launches.
        .creation_flags(0x08000000); // CREATE_NO_WINDOW
    run_command(&mut command, Duration::from_secs(45), 16 * 1024 * 1024)
}

struct CaptureBudget {
    used: AtomicUsize,
    failed: AtomicBool,
    limit: usize,
}

type ReaderResult = Result<Vec<u8>, String>;

struct RunningProcess {
    child: Child,
    readers: Vec<JoinHandle<ReaderResult>>,
}

impl Drop for RunningProcess {
    fn drop(&mut self) {
        // On every error path, close the producer before joining its readers.
        let _ = self.child.kill();
        let _ = self.child.wait();
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
    }
}

fn capture_pipe(
    mut pipe: impl Read + Send + 'static,
    budget: Arc<CaptureBudget>,
) -> Result<JoinHandle<ReaderResult>, String> {
    thread::Builder::new()
        .name("hatch-discovery-output".to_string())
        .spawn(move || {
            let mut output = Vec::new();
            let mut chunk = [0_u8; 8192];
            loop {
                let count = match pipe.read(&mut chunk) {
                    Ok(count) => count,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => {
                        budget.failed.store(true, Ordering::Release);
                        return Err("Cannot read discovery output".to_string());
                    }
                };
                if count == 0 {
                    return Ok(output);
                }
                let prior = budget.used.fetch_add(count, Ordering::AcqRel);
                if prior.saturating_add(count) > budget.limit {
                    budget.failed.store(true, Ordering::Release);
                    return Err("Discovery output exceeded its size limit".to_string());
                }
                output.extend_from_slice(&chunk[..count]);
            }
        })
        .map_err(|_| "Cannot start the discovery output reader".to_string())
}

fn run_command(
    command: &mut Command,
    timeout: Duration,
    output_limit: usize,
) -> Result<String, String> {
    let started = Instant::now();
    let child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Cannot start Windows application discovery".to_string())?;
    let mut process = RunningProcess {
        child,
        readers: Vec::with_capacity(2),
    };
    let budget = Arc::new(CaptureBudget {
        used: AtomicUsize::new(0),
        failed: AtomicBool::new(false),
        limit: output_limit,
    });
    let stdout = process
        .child
        .stdout
        .take()
        .ok_or_else(|| "Discovery stdout is unavailable".to_string())?;
    let stderr = process
        .child
        .stderr
        .take()
        .ok_or_else(|| "Discovery stderr is unavailable".to_string())?;
    process.readers.push(capture_pipe(stdout, budget.clone())?);
    process.readers.push(capture_pipe(stderr, budget.clone())?);

    let status = loop {
        if budget.failed.load(Ordering::Acquire) {
            return Err(if budget.used.load(Ordering::Acquire) > output_limit {
                "Discovery output exceeded its size limit"
            } else {
                "Cannot read discovery output"
            }
            .to_string());
        }
        if let Some(status) = process
            .child
            .try_wait()
            .map_err(|_| "Cannot observe the discovery process".to_string())?
        {
            break status;
        }
        if started.elapsed() >= timeout {
            return Err("Windows application discovery timed out".to_string());
        }
        thread::sleep(Duration::from_millis(10));
    };
    // A finished child can still have unread bytes buffered in its pipes.
    // Check reader results before accepting either its status or its stdout.
    let stdout = process
        .readers
        .remove(0)
        .join()
        .map_err(|_| "Discovery output reader stopped unexpectedly".to_string())??;
    let _stderr = process
        .readers
        .remove(0)
        .join()
        .map_err(|_| "Discovery error reader stopped unexpectedly".to_string())??;
    if !status.success() {
        // Do not expose arbitrary script output or device-local paths in errors.
        return Err(format!(
            "Windows application discovery failed (exit code {:?})",
            status.code()
        ));
    }
    let stdout =
        String::from_utf8(stdout).map_err(|_| "Discovery output is not valid UTF-8".to_string())?;
    Ok(stdout
        .strip_prefix('\u{feff}')
        .unwrap_or(&stdout)
        .to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    // Re-execute this test executable as a controlled child. This avoids shell
    // syntax differences and exercises identical failure paths on both OSes.
    #[test]
    #[ignore = "subprocess fixture; exercised by the runner tests"]
    fn process_fixture() {
        let Ok(mode) = std::env::var("HATCH_DISCOVERY_PROCESS_FIXTURE") else {
            return;
        };
        match mode.as_str() {
            "success" => {
                print!("{{\"name\":\"中文应用 🐈\"}}");
                std::io::stdout().flush().unwrap();
                std::process::exit(0);
            }
            "failure" => {
                eprintln!("private diagnostic must not leak");
                std::process::exit(23);
            }
            "timeout" => loop {
                std::thread::sleep(Duration::from_millis(10));
            },
            "large_stdout" | "large_stderr" => {
                let bytes = [b'x'; 8192];
                for _ in 0..128 {
                    let result = if mode == "large_stdout" {
                        std::io::stdout().write_all(&bytes)
                    } else {
                        std::io::stderr().write_all(&bytes)
                    };
                    if result.is_err() {
                        break;
                    }
                }
                std::process::exit(0);
            }
            "invalid_utf8" => {
                std::io::stdout().write_all(&[0xff]).unwrap();
                std::io::stdout().flush().unwrap();
                std::process::exit(0);
            }
            _ => std::process::exit(24),
        }
    }

    fn fixture(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        let module = module_path!().split_once("::").unwrap().1;
        command
            .args([
                "--exact",
                &format!("{module}::process_fixture"),
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("HATCH_DISCOVERY_PROCESS_FIXTURE", mode);
        command
    }

    #[test]
    fn captures_non_ascii_output() {
        let output = run_command(&mut fixture("success"), Duration::from_secs(5), 65536).unwrap();
        assert!(output.contains("中文应用 🐈"));
    }

    #[test]
    fn nonzero_status_does_not_expose_stderr() {
        let error =
            run_command(&mut fixture("failure"), Duration::from_secs(5), 65536).unwrap_err();
        assert!(error.contains("23"));
        assert!(!error.contains("private diagnostic"));
    }

    #[test]
    fn timeout_stops_and_reaps_child() {
        let started = Instant::now();
        let error =
            run_command(&mut fixture("timeout"), Duration::from_millis(200), 65536).unwrap_err();
        assert!(error.contains("timed out"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn limits_both_output_streams() {
        for mode in ["large_stdout", "large_stderr"] {
            let error = run_command(&mut fixture(mode), Duration::from_secs(5), 4096).unwrap_err();
            assert!(error.contains("size limit"), "{mode}: {error}");
        }
    }

    #[test]
    fn rejects_invalid_utf8() {
        let error =
            run_command(&mut fixture("invalid_utf8"), Duration::from_secs(5), 65536).unwrap_err();
        assert!(error.contains("UTF-8"));
    }

    #[test]
    fn reports_spawn_failure() {
        let dir = tempfile::tempdir().unwrap();
        let mut command = Command::new(dir.path().join("missing-discovery-executable"));
        let error = run_command(&mut command, Duration::from_secs(5), 65536).unwrap_err();
        assert!(error.contains("Cannot start"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn powershell_is_hidden_and_handles_large_unicode_script() {
        let script = format!(
            "param()\r\n[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false\r\n# {}\r\nAdd-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class HatchConsoleProbe {{ [DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); }}'\r\nif ([HatchConsoleProbe]::GetConsoleWindow() -ne [IntPtr]::Zero) {{ exit 27 }}\r\n[Console]::Write('{{\"name\":\"中文应用 🐈\"}}')",
            "large resource ".repeat(6000)
        );
        assert_eq!(
            run_powershell(&script).unwrap(),
            "{\"name\":\"中文应用 🐈\"}"
        );
    }
}
