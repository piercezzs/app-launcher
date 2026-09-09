param([string]$ScannerPath = (Join-Path $PSScriptRoot '..\..\apps\hatch\src-tauri\src\windows_scan.ps1'))
$ErrorActionPreference = 'Stop'
# Read-only: invokes the exact production scanner and emits its JSON envelope.
# Output contains device-local app names and paths. Review before sharing.
& $ScannerPath
