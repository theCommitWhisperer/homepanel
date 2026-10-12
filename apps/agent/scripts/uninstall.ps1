<#
.SYNOPSIS
  Removes the HomePanel PC agent from Windows.

  Run in an administrator PowerShell. Keeps C:\ProgramData\HomePanel (your agent.yaml, scripts
  and log) unless you pass -RemoveConfig. LibreHardwareMonitor is left installed; remove it with
  `winget uninstall LibreHardwareMonitor.LibreHardwareMonitor` if you don't want it anymore.

  Note: the dashboard keeps showing this PC as "offline" until you delete it in the HomePanel
  admin page (Computers). Its Home Assistant entities disappear when you delete the
  "Gaming PC" device under Settings -> Devices & services -> MQTT (or they show "unavailable").
  Compatible with Windows PowerShell 5.1.
#>
[CmdletBinding()]
param(
  [switch]$RemoveConfig,
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'HomePanel\agent'),
  [string]$DataDir = (Join-Path $env:ProgramData 'HomePanel')
)
$ErrorActionPreference = 'Stop'
$TaskName = 'HomePanel Agent'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Please run this from an administrator PowerShell.' -ForegroundColor Red
  exit 1
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
}

# make sure no agent process keeps files locked
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*homepanel-agent.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 500

if (Test-Path $InstallDir) {
  # this script may itself live in $InstallDir; PowerShell has already read it, so deleting is fine
  Remove-Item $InstallDir -Recurse -Force
  $parent = Split-Path $InstallDir -Parent
  if ((Test-Path $parent) -and -not (Get-ChildItem $parent)) { Remove-Item $parent -Force }
  Write-Host "Removed $InstallDir." -ForegroundColor Green
}

if ($RemoveConfig) {
  if (Test-Path $DataDir) { Remove-Item $DataDir -Recurse -Force; Write-Host "Removed $DataDir." -ForegroundColor Green }
} else {
  Write-Host "Kept your config in $DataDir (use -RemoveConfig to delete it)."
}
Write-Host 'HomePanel agent uninstalled.' -ForegroundColor Cyan
