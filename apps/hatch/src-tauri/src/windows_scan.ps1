param([switch]$FunctionsOnly)

# Read-only discovery. Standard output is reserved for the JSON envelope.
$ErrorActionPreference = 'Stop'

function Test-LocalAbsolutePath([string]$Path) {
  if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.Contains('"')) { return $false }
  # A drive-letter path may still be a mapped network share.
  $drive = New-Object System.IO.DriveInfo ($Path.Substring(0, 3))
  return $drive.DriveType -ne [System.IO.DriveType]::Network
}

function Get-LocalPath([string]$Path) {
  $value = [Environment]::ExpandEnvironmentVariables($Path.Trim().Trim('"'))
  if (-not (Test-LocalAbsolutePath $value)) { return '' }
  return [System.IO.Path]::GetFullPath($value)
}

function Get-LocalExecutable([string]$Path) {
  $value = Get-LocalPath $Path
  if (-not $value -or [IO.Path]::GetExtension($value) -ine '.exe') { return '' }
  if (-not (Test-Path -LiteralPath $value -PathType Leaf -ErrorAction Stop)) { return '' }
  return $value
}

function Normalize-RegistryDisplayName([string]$Name) {
  $value = $Name.Trim() -replace '\s+\((?:x64|x86|32-bit|64-bit)\)$', ''
  $value = $value -replace '\s+(?:(?:version|v)\s*)?\d+(?:\.\d+)*(?:[-+][\w.]+)?$', ''
  return $value.Trim()
}

function Normalize-ProductKey([string]$Name) {
  $value = (Normalize-RegistryDisplayName $Name).Normalize([Text.NormalizationForm]::FormKC)
  return ($value -replace '[^\p{L}\p{Nd}]', '').ToLowerInvariant()
}

function Test-NonAppExecutable([string]$Path) {
  $name = [IO.Path]::GetFileNameWithoutExtension($Path)
  # Whole names / known prefixes only: e.g. ReportDesigner is a valid product.
  return $name -match '^(?:unins\d*|uninstall(?:er)?|setup|installer|update(?:r)?|vc_redist(?:\.[^.]+)?|vcredist(?:_[^.]+)?|msiexec|rundll32|crashpad_handler)$'
}

function Resolve-CommandExecutable([string]$CommandLine) {
  $value = [Environment]::ExpandEnvironmentVariables($CommandLine.Trim())
  if ($value -match '^"([^"\r\n]+\.exe)"(?:\s|,|$)' -or $value -match '^([^"\r\n]+?\.exe)(?:\s|,|$)') {
    return Get-LocalPath $Matches[1]
  }
  return ''
}

function Resolve-EvidenceExecutable([string]$DisplayName, [string]$InstallLocation, [string]$DisplayIcon, [string]$UninstallString, [string]$QuietUninstallString) {
  $key = Normalize-ProductKey $DisplayName
  if (-not $key) { return '' }
  $directories = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $location = Get-LocalPath $InstallLocation
  if ($location -and (Test-Path -LiteralPath $location -PathType Container -ErrorAction Stop)) { [void]$directories.Add($location) }
  foreach ($command in @($DisplayIcon, $UninstallString, $QuietUninstallString)) {
    # Commands are evidence for a directory only. They are never invoked.
    $executable = Resolve-CommandExecutable $command
    if (-not $executable -or [IO.Path]::GetFileName($executable) -match '^(?:msiexec|rundll32)\.exe$') { continue }
    $directory = [IO.Path]::GetDirectoryName($executable)
    if (Test-Path -LiteralPath $directory -PathType Container -ErrorAction Stop) { [void]$directories.Add($directory) }
  }
  $matchesByPath = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($directory in $directories) {
    # Deliberately shallow: do not crawl an installation tree guessing its entrypoint.
    foreach ($file in @(Get-ChildItem -LiteralPath $directory -File -Filter '*.exe' -ErrorAction Stop)) {
      if ((Test-NonAppExecutable $file.FullName) -or (Normalize-ProductKey $file.BaseName) -cne $key) { continue }
      $target = Get-LocalExecutable $file.FullName
      if ($target) { [void]$matchesByPath.Add($target) }
    }
  }
  # A display icon or a lone arbitrary EXE is not sufficient evidence.
  if ($matchesByPath.Count -eq 1) { foreach ($target in $matchesByPath) { return $target } }
  return ''
}

function Resolve-LocalIconPath([string]$IconPath, [string]$WorkingDirectory = '', [string]$ExecutablePath = '') {
  # Validate the file separately from the resource index; negative indexes select IDs.
  $value = [Environment]::ExpandEnvironmentVariables($IconPath.Trim())
  $suffix = ''
  if ($value -match ',\s*([+-]?\d+)$') {
    $suffix = ',' + $Matches[1]
    $value = $value.Substring(0, $value.LastIndexOf(',')).Trim()
  }
  $value = $value.Trim('"')
  if (-not $value) { return '' }
  try {
    $candidates = New-Object 'System.Collections.Generic.List[string]'
    if ($value -match '^[A-Za-z]:[\\/]') {
      $candidates.Add($value)
    } else {
      # Only ordinary relative paths: reject UNC, rooted, drive-relative and device paths.
      if ($value -match '^[/\\]' -or $value.Contains(':')) { return '' }
      foreach ($rawDirectory in @($WorkingDirectory, [IO.Path]::GetDirectoryName($ExecutablePath))) {
        $directory = Get-LocalPath $rawDirectory
        if ($directory) { $candidates.Add((Join-Path $directory $value)) }
      }
    }
    foreach ($candidate in $candidates) {
      $path = Get-LocalPath $candidate
      if ($path -and (Test-Path -LiteralPath $path -PathType Leaf -ErrorAction Stop)) { return $path + $suffix }
    }
  } catch { return '' }
  return ''
}

function New-ExeCandidate([string]$Source, [string]$Name, [string]$Path, [string]$Arguments, [string]$WorkingDirectory, [string]$IconPath) {
  $target = Get-LocalExecutable $Path
  if (-not $target) { return }
  $directory = Get-LocalPath $WorkingDirectory
  if ($WorkingDirectory -and -not $directory) { return }
  # Unspecified shortcut cwd uses the executable directory, independent of Hatch's cwd.
  if (-not $directory) { $directory = [IO.Path]::GetDirectoryName($target) }
  [PSCustomObject]@{
    kind = 'exe'; source = $Source; name = $Name.Trim(); path = $target
    args = $Arguments; workingDirectory = $directory; iconPath = (Resolve-LocalIconPath $IconPath $directory $target); aumid = ''
  }
}

function Get-ShortcutCandidates([string]$Source, [string[]]$Directories) {
  $shell = New-Object -ComObject WScript.Shell
  try {
    foreach ($rawDirectory in $Directories) {
      $directory = Get-LocalPath $rawDirectory
      if (-not $directory -or -not (Test-Path -LiteralPath $directory -PathType Container -ErrorAction Stop)) { continue }
      foreach ($file in @(Get-ChildItem -LiteralPath $directory -Recurse -File -Filter '*.lnk' -ErrorAction Stop)) {
        $shortcut = $shell.CreateShortcut($file.FullName)
        try {
          New-ExeCandidate $Source $file.BaseName $shortcut.TargetPath $shortcut.Arguments $shortcut.WorkingDirectory $shortcut.IconLocation
        } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
      }
    }
  } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}

function Get-RegistryRecords([string[]]$Roots) {
  foreach ($root in $Roots) {
    if (-not (Test-Path -LiteralPath $root -ErrorAction Stop)) { continue }
    foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction Stop)) {
      Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
    }
  }
}

function Get-AppPathCandidates {
  $roots = @(
    'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths',
    'Registry::HKEY_CURRENT_USER\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths',
    'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths',
    'Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths'
  )
  foreach ($record in @(Get-RegistryRecords $roots)) {
    $target = Get-LocalExecutable ([string]$record.'(default)')
    if (-not $target) { continue }
    # App Paths "Path" is a search-path list, not the application's working directory.
    New-ExeCandidate 'app_paths' ([IO.Path]::GetFileNameWithoutExtension($record.PSChildName)) $target '' ([IO.Path]::GetDirectoryName($target)) $target
  }
}

function Get-UninstallCandidates {
  $roots = @(
    'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'Registry::HKEY_CURRENT_USER\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
    'Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  foreach ($record in @(Get-RegistryRecords $roots)) {
    if (-not $record.DisplayName -or $record.ParentKeyName -or $record.SystemComponent -eq 1) { continue }
    $target = Resolve-EvidenceExecutable $record.DisplayName $record.InstallLocation $record.DisplayIcon $record.UninstallString $record.QuietUninstallString
    if ($target) {
      New-ExeCandidate 'uninstall_registry' (Normalize-RegistryDisplayName $record.DisplayName) $target '' ([IO.Path]::GetDirectoryName($target)) $target
    }
  }
}

function Resolve-UwpIconPath([string]$Aumid, $PackagesByFamily) {
  if (-not $Aumid.Contains('!')) { return '' }
  $parts = $Aumid.Split('!', 2)
  $family = $parts[0].ToLowerInvariant()
  if (-not $PackagesByFamily.ContainsKey($family)) { return '' }
  try {
    $location = Get-LocalPath ([string]$PackagesByFamily[$family].InstallLocation)
    if (-not $location) { return '' }
    $manifestPath = Join-Path $location 'AppxManifest.xml'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf -ErrorAction Stop)) { return '' }
    [xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop
    $app = @($manifest.Package.Applications.Application) | Where-Object { $_.Id -eq $parts[1] } | Select-Object -First 1
    if (-not $app) { return '' }
    $logo = $app.VisualElements.Square44x44Logo
    if (-not $logo) { $logo = $app.VisualElements.Logo }
    if (-not $logo) { return '' }
    $base = Get-LocalPath (Join-Path $location $logo)
    if (-not $base -or -not $base.StartsWith(($location.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { return '' }
    $directory = [IO.Path]::GetDirectoryName($base)
    $leaf = [IO.Path]::GetFileNameWithoutExtension($base)
    $extension = [IO.Path]::GetExtension($base)
    foreach ($suffix in @('.targetsize-256', '.targetsize-128', '.scale-400', '.scale-300', '.scale-200', '.scale-150', '.targetsize-64', '.targetsize-48', '')) {
      $candidate = Join-Path $directory "$leaf$suffix$extension"
      if (Test-Path -LiteralPath $candidate -PathType Leaf -ErrorAction Stop) { return $candidate }
    }
    $fallback = Get-ChildItem -LiteralPath $directory -File -Filter "$leaf*$extension" -ErrorAction Stop | Sort-Object Name -Descending | Select-Object -First 1
    if ($fallback) { return $fallback.FullName }
  } catch {
    # Optional icon enrichment must not discard an otherwise launchable UWP app.
    return ''
  }
  return ''
}

function Get-StartAppCandidates {
  foreach ($app in @(Get-StartApps -ErrorAction Stop)) {
    if (([string]$app.AppID).Contains('!')) { continue }
    $target = Get-LocalExecutable ([string]$app.AppID)
    if ($target) { New-ExeCandidate 'start_apps' $app.Name $target '' ([IO.Path]::GetDirectoryName($target)) $target }
  }
}

function Get-UwpCandidates {
  $packages = @{}
  foreach ($package in @(Get-AppxPackage -ErrorAction Stop)) {
    if ($package.PackageFamilyName) { $packages[$package.PackageFamilyName.ToLowerInvariant()] = $package }
  }
  foreach ($app in @(Get-StartApps -ErrorAction Stop)) {
    $aumid = [string]$app.AppID
    if (-not $aumid.Contains('!')) { continue }
    [PSCustomObject]@{
      kind = 'uwp'; source = 'uwp'; name = [string]$app.Name; path = ''; args = ''
      workingDirectory = ''; iconPath = (Resolve-UwpIconPath $aumid $packages); aumid = $aumid
    }
  }
}

function Invoke-DiscoverySources($Sources) {
  $items = New-Object 'System.Collections.Generic.List[object]'
  $failures = New-Object 'System.Collections.Generic.List[string]'
  # Ordinal comparison retains case-sensitive arguments; Windows paths are folded separately.
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  foreach ($source in $Sources.Keys) {
    try {
      # Buffer the whole source before publishing any records from it.
      $candidates = @(& $Sources[$source])
      foreach ($candidate in $candidates) {
        $key = if ($candidate.kind -eq 'uwp') {
          'uwp:' + $candidate.aumid.ToLowerInvariant()
        } else {
          ConvertTo-Json -InputObject @($candidate.path.ToLowerInvariant(), $candidate.args, $candidate.workingDirectory.ToLowerInvariant()) -Compress
        }
        if ($seen.Add($key)) { $items.Add($candidate) }
      }
    } catch { $failures.Add([string]$source) }
  }
  return [PSCustomObject]@{ items = @($items.ToArray()); failedSources = @($failures.ToArray()) }
}

if ($FunctionsOnly) { return }
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$sources = [ordered]@{
  start_menu = { Get-ShortcutCandidates 'start_menu' @([Environment]::GetFolderPath('CommonStartMenu'), [Environment]::GetFolderPath('StartMenu')) }
  desktop = { Get-ShortcutCandidates 'desktop' @([Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('DesktopDirectory')) }
  taskbar = {
    $directory = Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned'
    Get-ShortcutCandidates 'taskbar' @((Join-Path $directory 'TaskBar'), (Join-Path $directory 'ImplicitAppShortcuts'))
  }
  app_paths = { Get-AppPathCandidates }
  uninstall_registry = { Get-UninstallCandidates }
  start_apps = { Get-StartAppCandidates }
  uwp = { Get-UwpCandidates }
}
Invoke-DiscoverySources $sources | ConvertTo-Json -Depth 6 -Compress
