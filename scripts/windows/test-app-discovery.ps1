param([string]$ScannerPath = (Join-Path $PSScriptRoot '..\..\apps\hatch\src-tauri\src\windows_scan.ps1'))
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile($ScannerPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }
. $ScannerPath -FunctionsOnly

$script:assertionCount = 0
function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "Assertion failed: $Message" }
  $script:assertionCount++
}
function New-FixtureExe([string]$Directory, [string]$Name) {
  $path = Join-Path $Directory $Name
  [IO.File]::WriteAllBytes($path, [byte[]]@())
  return $path
}

$fixture = Join-Path ([IO.Path]::GetTempPath()) ('hatch-discovery-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($fixture)
try {
  $primary = Join-Path $fixture 'primary'
  $alternate = Join-Path $fixture 'alternate'
  $shortcuts = Join-Path $fixture 'shortcuts'
  foreach ($directory in @($primary, $alternate, $shortcuts)) { [void][IO.Directory]::CreateDirectory($directory) }
  $target = New-FixtureExe $primary 'Example.exe'
  $other = New-FixtureExe $alternate 'Example.exe'
  $helper = New-FixtureExe $primary 'helper.exe'
  $report = New-FixtureExe $primary 'ReportDesigner.exe'

  Assert-True (-not (Test-LocalAbsolutePath '\\server\share\Example.exe')) 'UNC targets rejected before probing'
  Assert-True (-not (Test-LocalAbsolutePath 'Example.exe')) 'relative targets rejected'
  Assert-True (-not (Test-LocalAbsolutePath 'C:Example.exe')) 'drive-relative targets rejected'
  Assert-True (-not (Test-LocalAbsolutePath '\\?\C:\Example.exe')) 'device paths rejected'
  Assert-True ((Get-LocalExecutable (Join-Path $primary 'absent.exe')) -eq '') 'missing executable rejected'
  $fakeDirectory = Join-Path $primary 'directory.exe'
  [void][IO.Directory]::CreateDirectory($fakeDirectory)
  Assert-True ((Get-LocalExecutable $fakeDirectory) -eq '') 'directory named exe rejected'

  Assert-True ((Resolve-EvidenceExecutable 'Example 1.2 (x64)' $primary '' '' '') -eq $target) 'version-normalized exact filename accepted'
  Assert-True ((Resolve-EvidenceExecutable 'Unknown Product' $primary $helper '' '') -eq '') 'display icon is not standalone launch evidence'
  Assert-True ((Resolve-EvidenceExecutable 'Different Product' $alternate '' '' '') -eq '') 'lone arbitrary exe rejected'
  Assert-True ((Resolve-EvidenceExecutable 'Example' $primary $other '' '') -eq '') 'same filename in competing evidence directories rejected'
  Assert-True ((Resolve-EvidenceExecutable 'ReportDesigner' $primary '' '' '') -eq $report) 'report substring does not exclude actual products'
  $uninstaller = New-FixtureExe $primary 'uninstall.exe'
  Assert-True ((Resolve-EvidenceExecutable 'uninstall' $primary '' '' '') -eq '') 'known maintenance executable excluded'
  Assert-True ((Resolve-CommandExecutable 'cmd.exe /c echo unsafe') -eq '') 'relative uninstall command rejected without execution'

  $unicodeName = -join @([char]0x732b, [char]0x54aa, [char]0x5e94, [char]0x7528)
  $unicodeTarget = New-FixtureExe $primary ($unicodeName + '.exe')
  Assert-True ((Resolve-EvidenceExecutable ($unicodeName + ' 2.5') $primary '' '' '') -eq $unicodeTarget) 'Chinese product names retain meaningful identity'

  $quotedArgs = '--profile "Case Sensitive Profile" --mode A'
  $first = New-ExeCandidate 'start_menu' 'Example' $target $quotedArgs $primary $target
  $duplicate = New-ExeCandidate 'desktop' 'Duplicate' $target.ToUpperInvariant() $quotedArgs $primary $target
  $caseVariant = New-ExeCandidate 'desktop' 'Other profile' $target ($quotedArgs.Replace('--mode A', '--mode a')) $primary $target
  $directoryVariant = New-ExeCandidate 'desktop' 'Other directory' $target $quotedArgs $alternate $target
  $result = Invoke-DiscoverySources ([ordered]@{ start_menu = { $first }; desktop = { $duplicate; $caseVariant; $directoryVariant } })
  Assert-True ($result.items.Count -eq 3) 'dedup folds paths but preserves argument case and working directory'
  Assert-True ($result.items[0].source -eq 'start_menu') 'higher-priority shortcut source retained'
  Assert-True ($result.items[0].args -ceq $quotedArgs) 'quoted arguments retained exactly'
  Assert-True ($result.failedSources.Count -eq 0) 'successful sources do not report failure'
  foreach ($field in @('kind', 'source', 'name', 'path', 'args', 'workingDirectory', 'iconPath', 'aumid')) {
    Assert-True ($null -ne $result.items[0].PSObject.Properties[$field]) "envelope item includes $field"
  }

  $blankDirectory = New-ExeCandidate 'start_menu' 'Example' $target '' '' $target
  $appPathDirectory = New-ExeCandidate 'app_paths' 'Example' $target '' $primary $target
  Assert-True ($blankDirectory.workingDirectory -ieq $primary) 'blank shortcut cwd defaults to executable parent'
  $defaultDirectoryResult = Invoke-DiscoverySources ([ordered]@{ start_menu = { $blankDirectory }; app_paths = { $appPathDirectory } })
  Assert-True ($defaultDirectoryResult.items.Count -eq 1) 'blank shortcut cwd deduplicates with App Paths executable parent'

  $empty = Invoke-DiscoverySources ([ordered]@{ start_menu = {}; uwp = {} })
  $emptyJson = $empty | ConvertTo-Json -Depth 6 -Compress
  Assert-True ($emptyJson.Contains('"items":[]')) 'successful empty result serializes as array'
  Assert-True ($emptyJson.Contains('"failedSources":[]')) 'empty failures serialize as array'
  $failed = Invoke-DiscoverySources ([ordered]@{ desktop = { $first; throw 'fixture enumeration denied' }; app_paths = { $caseVariant } })
  Assert-True ($failed.items.Count -eq 1 -and $failed.items[0].args -ceq $caseVariant.args) 'failed source does not publish partial records'
  Assert-True ($failed.failedSources.Count -eq 1 -and $failed.failedSources[0] -eq 'desktop') 'enumeration failure is explicit'

  # Exercise the actual shortcut reader without running any fixture executable.
  $shell = New-Object -ComObject WScript.Shell
  try {
    $link = $shell.CreateShortcut((Join-Path $shortcuts 'Example.lnk'))
    try {
      $link.TargetPath = $target
      $link.Arguments = $quotedArgs
      $link.WorkingDirectory = $primary
      $link.IconLocation = "$target,0"
      $link.Save()
    } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) }
  } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
  $shortcutItems = @(Get-ShortcutCandidates 'desktop' @($shortcuts))
  Assert-True ($shortcutItems.Count -eq 1) 'actual Shell shortcut scanned'
  Assert-True ($shortcutItems[0].args -ceq $quotedArgs) 'Shell shortcut preserves quoted arguments'
  Assert-True ($shortcutItems[0].workingDirectory -ieq $primary) 'Shell shortcut preserves working directory'

  Assert-True ((Resolve-LocalIconPath '\\server\share\icon.ico') -eq '') 'remote icon rejected without probing'
  Assert-True ((Resolve-LocalIconPath ('"' + $target + '",0')) -eq ($target + ',0')) 'local icon resource path parsed'

  Assert-True ((Resolve-LocalIconPath ('"' + $target + '",-42')) -eq ($target + ',-42')) 'negative icon resource ID preserved'
  $customIcon = Join-Path $alternate 'custom.ico'
  [IO.File]::WriteAllBytes($customIcon, [byte[]]@())
  Assert-True ((Resolve-LocalIconPath 'custom.ico' $alternate $target) -eq $customIcon) 'relative icon resolves against explicit working directory'
  $fallbackIcon = Join-Path $primary 'fallback.ico'
  [IO.File]::WriteAllBytes($fallbackIcon, [byte[]]@())
  Assert-True ((Resolve-LocalIconPath 'fallback.ico,-7' $alternate $target) -eq ($fallbackIcon + ',-7')) 'relative icon falls back to executable parent with resource ID'
  Assert-True ((Resolve-LocalIconPath 'C:relative.ico' $primary $target) -eq '') 'drive-relative icon rejected'
  Assert-True ((Resolve-LocalIconPath '\\server\share\icon.ico,-1' $primary $target) -eq '') 'remote indexed icon rejected despite local fallback directories'

  $package = Join-Path $fixture 'package'
  [void][IO.Directory]::CreateDirectory($package)
  $manifest = '<Package><Applications><Application Id="App"><VisualElements Square44x44Logo="logo.png" /></Application></Applications></Package>'
  [IO.File]::WriteAllText((Join-Path $package 'AppxManifest.xml'), $manifest)
  $logo = Join-Path $package 'logo.targetsize-256.png'
  [IO.File]::WriteAllBytes($logo, [byte[]]@())
  $packageMap = @{ 'family' = [PSCustomObject]@{ InstallLocation = $package } }
  Assert-True ((Resolve-UwpIconPath 'family!App' $packageMap) -eq $logo) 'UWP high-resolution icon preserved'
  Assert-True ((Resolve-UwpIconPath 'family!Unknown' $packageMap) -eq '') 'unknown UWP application does not borrow another app icon'

  # Registry readers use terminating errors; permission failures cannot become an empty cache.
  function Get-RegistryRecords { throw 'fixture registry denied' }
  $registryFailed = Invoke-DiscoverySources ([ordered]@{ app_paths = { Get-AppPathCandidates }; uninstall_registry = { Get-UninstallCandidates } })
  Assert-True ($registryFailed.failedSources.Count -eq 2) 'registry failures propagate for both sources'
  Remove-Item Function:\Get-RegistryRecords

  Write-Host "Windows discovery fixtures passed ($script:assertionCount assertions)."
} finally {
  Remove-Item -LiteralPath $fixture -Recurse -Force -ErrorAction Stop
}
