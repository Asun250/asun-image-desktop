param([switch] $NoBrowser)
$ErrorActionPreference = 'Stop'
$launchMutex = [System.Threading.Mutex]::new($false, 'Local\AsunImageLauncherV167')
if (-not $launchMutex.WaitOne(0)) { $launchMutex.Dispose(); return }
try {
$appRoot = $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Asun IMG needs the existing Node.js installation. Node.js was not found.' }
function Get-AsunHealth([int] $port) {
  try { return Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 1 } catch { return $null }
}
$chosenPort = $null
foreach ($candidate in 48010..48019) {
  $health = Get-AsunHealth $candidate
  if ($health -and $health.app -eq 'asun-image-local-v1' -and $health.build -eq '1.6.7') { $chosenPort = $candidate; break }
  $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $candidate)
  try { $probe.Start(); $chosenPort = $candidate } catch { $chosenPort = $null } finally { $probe.Stop() }
  if ($chosenPort) {
    $logRoot = Join-Path $appRoot 'logs'
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $env:ASUN_PORT = [string]$chosenPort
    $serverScript = Join-Path $appRoot 'server.mjs'
    Start-Process -FilePath $nodeCommand.Source -ArgumentList @('"' + $serverScript + '"') -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logRoot "$stamp-out.log") -RedirectStandardError (Join-Path $logRoot "$stamp-error.log") | Out-Null
    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
      Start-Sleep -Milliseconds 200
      $health = Get-AsunHealth $chosenPort
      if ($health -and $health.app -eq 'asun-image-local-v1' -and $health.build -eq '1.6.7') { $ready = $true; break }
    }
    if (-not $ready) { throw "Asun IMG could not start. Check the logs in $logRoot." }
    break
  }
}
if (-not $chosenPort) { throw 'No free local port was found between 48010 and 48019.' }
$appUrl = "http://127.0.0.1:$chosenPort"
if ($NoBrowser) { Write-Output $appUrl; return }
$brandHelper = Join-Path $appRoot 'windows\Keep-WindowBrand.ps1'
$shellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
# The browser may reuse an existing process. Brand only matching Asun app windows,
# keeping their icon handles alive until those windows close. No browser restart.
Start-Process -FilePath $shellPath -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',('"' + $brandHelper + '"')) -WorkingDirectory $appRoot -WindowStyle Hidden | Out-Null
function Find-AsunBrowser([string] $Executable, [string] $RelativePath) {
  foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
    if ($base) {
      $candidate = Join-Path $base $RelativePath
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
  }
  $command = Get-Command $Executable -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  return $null
}
$edgePath = Find-AsunBrowser 'msedge.exe' 'Microsoft\Edge\Application\msedge.exe'
$chromePath = Find-AsunBrowser 'chrome.exe' 'Google\Chrome\Application\chrome.exe'
if ($edgePath) { Start-Process -FilePath $edgePath -ArgumentList "--app=$appUrl" -WindowStyle Normal }
elseif ($chromePath) { Start-Process -FilePath $chromePath -ArgumentList "--app=$appUrl" -WindowStyle Normal }
else { Start-Process $appUrl }
} finally { $launchMutex.ReleaseMutex(); $launchMutex.Dispose() }
