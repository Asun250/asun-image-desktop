param(
  [string] $IconFile = (Join-Path $PSScriptRoot '..\public\asun-img-husky.ico'),
  [string] $Launcher = (Join-Path $PSScriptRoot '..\Launch Asun IMG.ps1'),
  [string] $LogFile = (Join-Path $PSScriptRoot '..\logs\window-brand.json'),
  [switch] $InspectOnly
)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'WindowBrand.cs')
if ($InspectOnly) {
  @([AsunIMG.WindowBrand]::Windows() | ForEach-Object { [AsunIMG.WindowBrand]::Inspect($_) }) | ConvertTo-Json -Depth 5
  return
}
$brandMutex = [System.Threading.Mutex]::new($false, 'Local\AsunIMGWindowBrandV2')
if (-not $brandMutex.WaitOne(0)) { $brandMutex.Dispose(); return }
try {
  $IconFile = [System.IO.Path]::GetFullPath($IconFile)
  $Launcher = [System.IO.Path]::GetFullPath($Launcher)
  if (-not (Test-Path -LiteralPath $IconFile -PathType Leaf)) { throw 'Asun husky icon is missing.' }
  if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf)) { throw 'Asun launcher is missing.' }
  $shellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $relaunch = '"' + $shellPath + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $Launcher + '"'
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  $seen = $false
  $emptySince = $null
  $history = [System.Collections.Generic.List[object]]::new()
  $tracked = [System.Collections.Generic.HashSet[long]]::new()
  while ($true) {
    $windows = @([AsunIMG.WindowBrand]::Windows())
    foreach ($trackedHandle in @($tracked)) {
      if (-not [AsunIMG.WindowBrand]::Alive($trackedHandle)) { $tracked.Remove($trackedHandle) | Out-Null }
    }
    if ($windows.Count -gt 0) {
      $seen = $true; $emptySince = $null
      foreach ($windowHandle in $windows) {
        # Retain HICON ownership until the actual HWND is destroyed, even while
        # it is hidden or its browser temporarily changes the document title.
        $tracked.Add($windowHandle) | Out-Null
        try {
          if ([AsunIMG.WindowBrand]::Apply($windowHandle,$IconFile,$relaunch)) {
            $info = [AsunIMG.WindowBrand]::Inspect($windowHandle)
            $history.Add([ordered]@{ at=[DateTime]::UtcNow.ToString('o'); window=$info })
            # Keep diagnostics bounded and exclude project titles from persistent logs.
            if ($history.Count -gt 20) { $history.RemoveAt(0) }
            foreach ($entry in $history) { $entry.window.Title = $null }
            [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($LogFile)) | Out-Null
            [ordered]@{ helperPid=$PID; appId=[AsunIMG.WindowBrand]::AppId; icon=$IconFile; updates=@($history.ToArray()) } |
              ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $LogFile -Encoding UTF8
          }
        } catch {
          # A window can disappear between enumeration and assignment. A hung window
          # times out, so branding can never block the browser or other windows.
          if ([AsunIMG.WindowBrand]::Windows() -contains $windowHandle) {
            [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($LogFile)) | Out-Null
            [ordered]@{ helperPid=$PID; error=$_.Exception.Message; at=[DateTime]::UtcNow.ToString('o') } |
              ConvertTo-Json | Set-Content -LiteralPath $LogFile -Encoding UTF8
          }
        }
      }
    } elseif ($tracked.Count -eq 0) {
      if (-not $seen -and [DateTime]::UtcNow -gt $deadline) { break }
      if ($seen) {
        if ($null -eq $emptySince) { $emptySince=[DateTime]::UtcNow }
        if (([DateTime]::UtcNow-$emptySince).TotalSeconds -ge 10) { break }
      }
    }
    Start-Sleep -Milliseconds 1000
  }
  [AsunIMG.WindowBrand]::Release()
} finally { $brandMutex.ReleaseMutex(); $brandMutex.Dispose() }
