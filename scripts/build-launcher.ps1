[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [string]$IconPath = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$SourcePath = Join-Path $ProjectRoot "installer\launcher\OfferGoLauncher.cs"
if (-not $IconPath) { $IconPath = Join-Path $ProjectRoot "assets\OfferGo.ico" }
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$IconPath = [System.IO.Path]::GetFullPath($IconPath)

foreach ($Required in @($SourcePath, $IconPath)) {
  if (-not (Test-Path -LiteralPath $Required -PathType Leaf)) {
    throw "OfferGo launcher input is missing: $Required"
  }
}

$Compiler = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $Compiler) {
  throw "Windows .NET Framework C# compiler was not found."
}

$OutputDir = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
& $Compiler `
  /nologo `
  /target:winexe `
  /optimize+ `
  "/win32icon:$IconPath" `
  "/out:$OutputPath" `
  /reference:System.dll `
  /reference:System.Drawing.dll `
  /reference:System.Windows.Forms.dll `
  /reference:System.Web.Extensions.dll `
  $SourcePath
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) {
  throw "OfferGo native launcher compilation failed."
}
Write-Host "OfferGo launcher: $OutputPath"
