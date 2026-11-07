# Optional, explicit installation. This script is never run by npm or the app.
[CmdletBinding()]
param(
  [string] $RuntimeRoot = '',
  [string] $Python = 'py'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'This installer supports native 64-bit Windows only.' }

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $RuntimeRoot) {
  $RuntimeRoot = if ($env:ASUN_SAM_ROOT) { $env:ASUN_SAM_ROOT } else { 'local-ai\sam2' }
}
if (-not [System.IO.Path]::IsPathRooted($RuntimeRoot)) { $RuntimeRoot = Join-Path $repoRoot $RuntimeRoot }
$RuntimeRoot = [System.IO.Path]::GetFullPath($RuntimeRoot)
if (Test-Path -LiteralPath $RuntimeRoot) {
  if (-not (Test-Path -LiteralPath $RuntimeRoot -PathType Container)) { throw 'RuntimeRoot must be a directory.' }
  if (@(Get-ChildItem -LiteralPath $RuntimeRoot -Force).Count) {
    throw "The runtime directory is not empty: $RuntimeRoot. Choose a new empty directory; existing installations are never overwritten."
  }
}

function Assert-NativeSuccess([string] $Step) {
  if ($LASTEXITCODE -ne 0) { throw "$Step failed (exit $LASTEXITCODE). The runtime has not been marked installed." }
}
$git = (Get-Command git.exe -CommandType Application -ErrorAction Stop).Source
$pythonCommand = (Get-Command $Python -CommandType Application -ErrorAction Stop).Source
$pythonArguments = @()
if ([System.IO.Path]::GetFileNameWithoutExtension($pythonCommand) -eq 'py') { $pythonArguments = @('-3.12') }
& $pythonCommand @pythonArguments -c "import struct, sys; assert sys.version_info[:2] == (3, 12) and struct.calcsize('P') == 8, 'Install 64-bit Python 3.12 first'"
Assert-NativeSuccess 'Python prerequisite check'

$sourceCommit = '2b90b9f5ceec907a1c18123530e92e794ad901a4'
$sourceRepository = 'https://github.com/facebookresearch/sam2.git'
$modelUrl = 'https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_base_plus.pt'
$modelSha256 = 'a2345aede8715ab1d5d31b4a509fb160c5a4af1970f199d9054ccfb746c004c5'
$modelBytes = 323606802
$source = Join-Path $RuntimeRoot 'source'
$environment = Join-Path $RuntimeRoot 'env'
$pythonExe = Join-Path $environment 'Scripts\python.exe'
$checkpointDirectory = Join-Path $RuntimeRoot 'checkpoints'
$checkpoint = Join-Path $checkpointDirectory 'sam2.1_hiera_base_plus.pt'
$requirements = Join-Path $PSScriptRoot 'sam2-requirements.txt'
$oldBuildCuda = $env:SAM2_BUILD_CUDA
$oldNoUserSite = $env:PYTHONNOUSERSITE
$oldPythonUtf8 = $env:PYTHONUTF8
try {
  $env:SAM2_BUILD_CUDA = '0'
  $env:PYTHONNOUSERSITE = '1'
  $env:PYTHONUTF8 = '1'
  Write-Host "Installing optional local detection into $RuntimeRoot"
  Write-Host 'This downloads several GB of Python packages, SAM source and model weights.'
  New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
  & $pythonCommand @pythonArguments -m venv $environment
  Assert-NativeSuccess 'Virtual environment creation'
  & $git clone --filter=blob:none --no-checkout $sourceRepository $source
  Assert-NativeSuccess 'SAM source clone'
  & $git -C $source checkout --detach $sourceCommit
  Assert-NativeSuccess 'Pinned SAM source checkout'
  $checkedCommit = (& $git -C $source rev-parse HEAD).Trim()
  Assert-NativeSuccess 'SAM revision check'
  if ($checkedCommit -ne $sourceCommit) { throw 'SAM source revision did not match the pinned commit.' }

  & $pythonExe -m pip install --index-url https://pypi.org/simple -r $requirements
  Assert-NativeSuccess 'Pinned Python dependencies'
  & $pythonExe -m pip install --index-url https://download.pytorch.org/whl/cu126 --constraint $requirements 'torch==2.7.1' 'torchvision==0.22.1'
  Assert-NativeSuccess 'CUDA PyTorch installation'
  & $pythonExe -m pip install --no-build-isolation --no-deps -e $source
  Assert-NativeSuccess 'SAM installation without the optional CUDA extension'
  & $pythonExe -m pip check
  Assert-NativeSuccess 'Python dependency verification'

  New-Item -ItemType Directory -Path $checkpointDirectory -Force | Out-Null
  $download = "$checkpoint.partial"
  Invoke-WebRequest -UseBasicParsing -Uri $modelUrl -OutFile $download
  if ((Get-Item -LiteralPath $download).Length -ne $modelBytes -or (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -ne $modelSha256) {
    throw 'The checkpoint size or SHA-256 did not match. The incomplete runtime remains uninstalled.'
  }
  Move-Item -LiteralPath $download -Destination $checkpoint

  $verificationJson = & $pythonExe (Join-Path $PSScriptRoot 'verify-local-detection.py') $RuntimeRoot
  Assert-NativeSuccess 'CUDA and model verification'
  $verification = ($verificationJson -join "`n") | ConvertFrom-Json
  $manifest = [ordered]@{
    status = 'installed'
    installedAt = [DateTime]::UtcNow.ToString('o')
    model = 'Meta SAM 2.1 Base Plus'
    modelFile = 'checkpoints/sam2.1_hiera_base_plus.pt'
    modelBytes = $modelBytes
    modelSha256 = $modelSha256
    modelUrl = $modelUrl
    sourceRepository = $sourceRepository
    sourceCommit = $sourceCommit
    python = $verification.python
    torch = $verification.torch
    torchvision = $verification.torchvision
    cuda = $verification.cuda
    device = $verification.device
    optionalCudaExtension = $false
    localOnly = $true
  }
  $installedRequirements = & $pythonExe -m pip freeze
  Assert-NativeSuccess 'Installed dependency record'
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText((Join-Path $RuntimeRoot 'requirements-installed.txt'), ($installedRequirements -join "`n") + "`n", $utf8)
  [System.IO.File]::WriteAllText((Join-Path $RuntimeRoot 'runtime.json'), ($manifest | ConvertTo-Json -Depth 5) + "`n", $utf8)
  Write-Host 'Local detection is installed and its CUDA model loaded successfully.'
  Write-Host 'Restart the Asun server. For a custom directory, set ASUN_SAM_ROOT to that directory before launching.'
} finally {
  $env:SAM2_BUILD_CUDA = $oldBuildCuda
  $env:PYTHONNOUSERSITE = $oldNoUserSite
  $env:PYTHONUTF8 = $oldPythonUtf8
}
