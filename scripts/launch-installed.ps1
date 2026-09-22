[CmdletBinding()]
param(
  [int]$Port = 8787,
  [string]$ProgressPath = ""
)

$ErrorActionPreference = "Stop"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom
$ProjectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "lib\startup-identity.ps1")
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw "ROLEFLOW_LOCALAPPDATA_REQUIRED: 无法确定当前 Windows 用户的数据目录。"
}
if ($env:LOCALAPPDATA.StartsWith("\\", [System.StringComparison]::Ordinal)) {
  throw "ROLEFLOW_LOCALAPPDATA_UNC_REJECTED"
}
$LocalAppDataRoot = Resolve-RoleFlowNormalizedPath -Path $env:LOCALAPPDATA
[void](Assert-RoleFlowPathHasNoReparsePoint -Path $LocalAppDataRoot)
$DataRoot = Resolve-RoleFlowNormalizedPath -Path (Join-Path $LocalAppDataRoot "RoleFlow\Data")
$LogDir = Join-Path $DataRoot ".runtime\logs"
$LogPath = Join-Path $LogDir "launcher.log"
$StartScript = Join-Path $PSScriptRoot "start-workspace.ps1"

function Write-OfferGoProgress {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("checking_install", "starting_service", "starting_browser", "checking_workspace", "ready", "failed")]
    [string]$State,
    [Parameter(Mandatory = $true)][string]$Message
  )
  if ([string]::IsNullOrWhiteSpace($ProgressPath)) { return }
  $FullPath = [System.IO.Path]::GetFullPath($ProgressPath)
  $Parent = Split-Path -Parent $FullPath
  New-Item -ItemType Directory -Force -Path $Parent | Out-Null
  $TempPath = Join-Path $Parent (".{0}.{1}.tmp" -f ([System.IO.Path]::GetFileName($FullPath)), [guid]::NewGuid().ToString("N"))
  @{
    state = $State
    message = $Message
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath $TempPath -Encoding utf8
  Move-Item -LiteralPath $TempPath -Destination $FullPath -Force
}

function Write-RoleFlowLauncherLog {
  param([Parameter(Mandatory = $true)][string]$Value)
  if (-not (Test-Path -LiteralPath $DataRoot -PathType Container)) { return }
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $DataRoot -IncludeDescendants)
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  [void](Assert-RoleFlowPathHasNoReparsePoint -Path $LogDir -IncludeDescendants)
  Add-Content -LiteralPath $LogPath -Encoding utf8 -Value $Value
}

function Show-RoleFlowError {
  param([string]$Reason)
  Add-Type -AssemblyName System.Windows.Forms
  $DisplayReason = if ($Reason -match '^PORTABLE_EDGE_LISTENER_ENUMERATION_FAILED') {
    '无法检查 OfferGo 专用 Edge 使用的本地端口。请重启电脑后重试；若仍失败，请提供下方诊断日志。'
  } else {
    $Reason
  }
  $CanOpenLogs = Test-Path -LiteralPath $LogDir -PathType Container
  $Message = @"
OfferGo 启动失败。

$DisplayReason

OfferGo 工作台未能启动，已有用户数据不会被删除或覆盖。请按提示处理后重试。
诊断日志：$LogPath
$(if ($CanOpenLogs) { "`r`n是否打开诊断日志文件夹？" } else { "" })
"@
  $Buttons = if ($CanOpenLogs) {
    [System.Windows.Forms.MessageBoxButtons]::YesNo
  } else {
    [System.Windows.Forms.MessageBoxButtons]::OK
  }
  $Result = [System.Windows.Forms.MessageBox]::Show(
    $Message,
    "OfferGo",
    $Buttons,
    [System.Windows.Forms.MessageBoxIcon]::Error
  )
  if ($CanOpenLogs -and $Result -eq [System.Windows.Forms.DialogResult]::Yes) {
    [void](Assert-RoleFlowPathHasNoReparsePoint -Path $LogDir -IncludeDescendants)
    Start-Process -FilePath "explorer.exe" -ArgumentList @(('"{0}"' -f $LogDir)) | Out-Null
  }
}

$StartupMutex = $null
$StartupMutexAcquired = $false
try {
  Write-OfferGoProgress -State "checking_install" -Message "正在检查 OfferGo 运行环境…"
  $StartupMutex = [System.Threading.Mutex]::new(
    $false,
    (Get-RoleFlowStartupMutexName -ProjectRoot $ProjectRoot -Port $Port)
  )
  try {
    $StartupMutexAcquired = $StartupMutex.WaitOne([TimeSpan]::FromSeconds(30))
  } catch [System.Threading.AbandonedMutexException] {
    $StartupMutexAcquired = $true
  }
  if (-not $StartupMutexAcquired) {
    throw "ROLEFLOW_STARTUP_ALREADY_IN_PROGRESS: 另一个 OfferGo 启动过程仍在运行。"
  }
  $StartArguments = @(
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle", "Hidden",
    "-ExecutionPolicy", "Bypass",
    "-File", $StartScript,
    "-Port", [string]$Port
  )
  if (-not [string]::IsNullOrWhiteSpace($ProgressPath)) {
    $StartArguments += @("-ProgressPath", $ProgressPath)
  }
  $Output = & powershell.exe @StartArguments 2>&1
  $ExitCode = $LASTEXITCODE
  $Text = ($Output | Out-String).Trim()
  Write-RoleFlowLauncherLog -Value (
    "{0:o} exit={1}`r`n{2}" -f (Get-Date), $ExitCode, $Text
  )
  if ($ExitCode -ne 0) {
    $Reason = ($Output | Select-Object -Last 1 | Out-String).Trim()
    if (-not $Reason) {
      $Reason = "启动组件返回错误代码 $ExitCode。"
    }
    Show-RoleFlowError -Reason $Reason
    Write-OfferGoProgress -State "failed" -Message $Reason
    exit $ExitCode
  }
} catch {
  try {
    Write-RoleFlowLauncherLog -Value (
      "{0:o} launcher_error={1}" -f (Get-Date), $_.Exception.Message
    )
  } catch {}
  try { Write-OfferGoProgress -State "failed" -Message $_.Exception.Message } catch {}
  Show-RoleFlowError -Reason $_.Exception.Message
  exit 1
} finally {
  if ($StartupMutexAcquired) {
    try { $StartupMutex.ReleaseMutex() } catch {}
  }
  if ($null -ne $StartupMutex) { $StartupMutex.Dispose() }
}
