<#
.SYNOPSIS
  Installs the HomePanel PC agent on Windows 10/11.

.DESCRIPTION
  Run from the agent folder (dist\windows after `pnpm build`) in an ADMINISTRATOR PowerShell:

      Set-ExecutionPolicy -Scope Process Bypass -Force
      .\install.ps1                                  # asks for the details
      .\install.ps1 -Server 192.168.1.20 -MqttUser homepanel -MqttPass secret -Key <key> -PcId gaming-pc

  What it does:
    1. Checks for Node.js 22+ (offers `winget install OpenJS.NodeJS.LTS` if missing)
    2. Copies homepanel-agent.mjs + scripts to C:\Program Files\HomePanel\agent
    3. Writes C:\ProgramData\HomePanel\agent.yaml if it does not exist yet (your buttons live there)
    4. Installs LibreHardwareMonitor with winget if missing and explains the two settings to turn on
    5. Registers the scheduled task "HomePanel Agent": at your logon, highest privileges, restarts
       on failure - and starts it

  Why a logon task and not a Windows service: services run in "session 0", which has no desktop,
  so "open D:\Projects" or "launch Steam" would start invisible programs. The task runs as you, in
  your session, so windows open on your screen as if you had double-clicked them.

  Compatible with Windows PowerShell 5.1.

.PARAMETER Server      MQTT broker host (your Home Assistant mini PC), e.g. 192.168.1.20 or homeassistant.local
.PARAMETER MqttPort    MQTT port (default 1883)
.PARAMETER MqttUser    MQTT username
.PARAMETER MqttPass    MQTT password
.PARAMETER Key         The key shown by HomePanel admin -> PCs -> Add
.PARAMETER PcId        Id for this PC (lowercase, dashes), must match the one in HomePanel admin
.PARAMETER Name        Display name (default: the computer name)
.PARAMETER NoStart     Register the task but do not start it now
.PARAMETER SkipLhm     Do not install or check LibreHardwareMonitor
#>
[CmdletBinding()]
param(
  [string]$Server,
  [int]$MqttPort = 1883,
  [string]$MqttUser,
  [string]$MqttPass,
  [string]$Key,
  [string]$PcId,
  [string]$Name,
  [switch]$NoStart,
  [switch]$SkipLhm,
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'HomePanel\agent'),
  [string]$DataDir = (Join-Path $env:ProgramData 'HomePanel')
)

$ErrorActionPreference = 'Stop'
$TaskName = 'HomePanel Agent'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$AgentFile = 'homepanel-agent.mjs'

function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Ask-YesNo([string]$question, [bool]$defaultYes = $true) {
  $suffix = '[y/N]'
  if ($defaultYes) { $suffix = '[Y/n]' }
  $a = Read-Host "$question $suffix"
  if ([string]::IsNullOrWhiteSpace($a)) { return $defaultYes }
  return $a.Trim().ToLower().StartsWith('y')
}
function Ask([string]$question, [string]$default) {
  $prompt = $question
  if ($default) { $prompt = "$question [$default]" }
  $a = Read-Host $prompt
  if ([string]::IsNullOrWhiteSpace($a)) { return $default }
  return $a.Trim()
}
function Get-NodeMajor([string]$exe) {
  try {
    $v = & $exe --version 2>$null
    if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
  } catch { }
  return 0
}

# --- 0. checks ------------------------------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Say 'Please run this from an administrator PowerShell (right-click PowerShell -> Run as administrator).' Red
  exit 1
}
if (-not (Test-Path (Join-Path $Here $AgentFile))) {
  Say "$AgentFile not found next to this script ($Here)." Red
  Say 'Run it from the built agent folder (apps\agent\dist\windows after `pnpm build`).' Red
  exit 1
}

# The task must run as the person who uses this PC, not as a separate admin account that may have
# been used to elevate. The owner of explorer.exe is the signed-in user.
$interactive = $null
try {
  $owner = Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Select-Object -First 1 | Invoke-CimMethod -MethodName GetOwner
  if ($owner -and $owner.User) { $interactive = "$($owner.Domain)\$($owner.User)" }
} catch { }
if (-not $interactive) { $interactive = "$env:USERDOMAIN\$env:USERNAME" }

Say ''
Say '=== HomePanel PC agent installer ===' Cyan
Say "Program folder : $InstallDir"
Say "Config folder  : $DataDir"
Say "Runs as        : $interactive (at logon, highest privileges)"
Say ''

# --- 1. Node.js 22+ -------------------------------------------------------------------------
$node = $null
$cmd = Get-Command node.exe -ErrorAction SilentlyContinue
if ($cmd -and (Get-NodeMajor $cmd.Source) -ge 22) { $node = $cmd.Source }
if (-not $node) {
  $candidate = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if ((Test-Path $candidate) -and (Get-NodeMajor $candidate) -ge 22) { $node = $candidate }
}
if (-not $node) {
  Say 'Node.js 22 or newer is needed to run the agent, and was not found.' Yellow
  if (Ask-YesNo 'Install Node.js LTS now with winget?') {
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    $candidate = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if ((Test-Path $candidate) -and (Get-NodeMajor $candidate) -ge 22) { $node = $candidate }
  }
}
if (-not $node) {
  Say 'Cannot continue without Node.js 22+. Install it from https://nodejs.org and run this script again.' Red
  exit 1
}
Say "Node.js: $node ($(& $node --version))" Green

# --- 2. copy program files ------------------------------------------------------------------
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Say 'Stopping the running agent for the update...'
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*$AgentFile*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item (Join-Path $Here $AgentFile) $InstallDir -Force
foreach ($f in 'README.md', 'agent.example.yaml', 'uninstall.ps1', 'install.ps1') {
  $p = Join-Path $Here $f
  if (Test-Path $p) { Copy-Item $p $InstallDir -Force }
}
$agent = Join-Path $InstallDir $AgentFile
Say "Copied the agent to $InstallDir" Green

# example scripts go next to agent.yaml (actions refer to them as scripts\...); never overwrite edits
$scriptsDir = Join-Path $DataDir 'scripts'
New-Item -ItemType Directory -Force -Path $scriptsDir | Out-Null
Get-ChildItem (Join-Path $Here 'scripts') -Filter *.ps1 -ErrorAction SilentlyContinue | ForEach-Object {
  $dest = Join-Path $scriptsDir $_.Name
  if (-not (Test-Path $dest)) { Copy-Item $_.FullName $dest }
}

# --- 3. agent.yaml --------------------------------------------------------------------------
$configPath = Join-Path $DataDir 'agent.yaml'
if (Test-Path $configPath) {
  Say "Keeping your existing $configPath" Green
} else {
  Say 'Connection details. In HomePanel admin open PCs -> Add: it shows the PC id and its key.' Cyan
  $defaultId = ($env:COMPUTERNAME.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
  if (-not $Server) { $Server = Ask 'MQTT broker address (your Home Assistant mini PC)' 'homeassistant.local' }
  if (-not $MqttUser) { $MqttUser = Ask 'MQTT username' 'homepanel' }
  if (-not $PSBoundParameters.ContainsKey('MqttPass')) {
    $sec = Read-Host 'MQTT password' -AsSecureString
    $MqttPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  }
  while (-not ($PcId -match '^[a-z0-9][a-z0-9-]{0,47}$')) { $PcId = Ask 'PC id (lowercase letters, digits, dashes)' 'gaming-pc' }
  if (-not $Name) { $Name = Ask 'Display name' $env:COMPUTERNAME }
  while (-not $Key -or $Key.Length -lt 16) { $Key = Ask 'Key from HomePanel admin' $null }

  # Secrets go through environment variables: Windows PowerShell 5.1 drops empty arguments and
  # mangles quotes when calling native programs.
  $env:HOMEPANEL_INIT_MQTT_PASS = $MqttPass
  $env:HOMEPANEL_INIT_KEY = $Key
  $env:HOMEPANEL_INIT_NAME = $Name
  & $node $agent init "--config=$configPath" "--pc-id=$PcId" "--mqtt-url=mqtt://$($Server):$MqttPort" "--mqtt-user=$MqttUser"
  $initExit = $LASTEXITCODE
  Remove-Item Env:HOMEPANEL_INIT_MQTT_PASS, Env:HOMEPANEL_INIT_KEY, Env:HOMEPANEL_INIT_NAME -ErrorAction SilentlyContinue
  if ($initExit -ne 0) { Say 'Could not write agent.yaml (see the message above).' Red; exit 1 }

  # it holds the key and MQTT password: readable only by SYSTEM, Administrators and you
  icacls $configPath /inheritance:r /grant:r "*S-1-5-18:F" "*S-1-5-32-544:F" "$($interactive):M" | Out-Null
  Say "Wrote $configPath with the suggested buttons (edit it any time)." Green
}
& $node $agent check-config "--config=$configPath"
if ($LASTEXITCODE -ne 0) {
  Say "Fix $configPath and run this script again." Red
  exit 1
}

# --- 4. LibreHardwareMonitor ----------------------------------------------------------------
if (-not $SkipLhm) {
  $lhmOk = $false
  try { $lhmOk = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://localhost:8085/data.json').StatusCode -eq 200 } catch { }
  if ($lhmOk) {
    Say 'LibreHardwareMonitor web server answers on port 8085 - temperatures will work.' Green
  } else {
    $installed = $false
    try { $installed = [bool](winget list --id LibreHardwareMonitor.LibreHardwareMonitor -e 2>$null | Select-String 'LibreHardwareMonitor') } catch { }
    if (-not $installed) {
      Say ''
      Say 'Temperatures and fan speeds come from LibreHardwareMonitor (free, open source).' Yellow
      if (Ask-YesNo 'Install LibreHardwareMonitor now with winget?') {
        winget install --id LibreHardwareMonitor.LibreHardwareMonitor -e --accept-source-agreements --accept-package-agreements
      }
    }
    Say ''
    Say '>>> One-time LibreHardwareMonitor setup (takes a minute) <<<' Cyan
    Say '  1. Start LibreHardwareMonitor (Start menu). Allow it to run as administrator.'
    Say '     If it asks to install the PawnIO driver, click YES - that is what lets it read'
    Say '     CPU temperatures and fan speeds. (PawnIO is signed; old versions used WinRing0,'
    Say '     which Windows Defender flags - update LibreHardwareMonitor if you see that.)'
    Say '  2. Options -> Remote Web Server -> Run       (port 8085; the agent reads it locally)'
    Say '  3. Options -> Run On Windows Startup          (so it is there after every reboot)'
    Say '     Optional: Options -> Start Minimized, Minimize To Tray.'
    Say '  Check: open http://localhost:8085 in a browser - you should see your sensors.'
    Say '  Until then the dashboard still gets CPU load and memory from the agent itself.'
    Say ''
  }
}

# --- 5. scheduled task ----------------------------------------------------------------------
# conhost.exe --headless runs node without a console window (Windows 10 21H2+ / 11).
# --supervise: a small parent process restarts the agent if it crashes; Task Scheduler's own
# restart settings additionally cover the task failing to start.
$argLine = "--headless `"$node`" `"$agent`" run --supervise --config `"$configPath`""
$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\conhost.exe') -Argument $argLine -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $interactive
$trigger.Delay = 'PT10S'  # let the network and LibreHardwareMonitor come up first
$principalTask = New-ScheduledTaskPrincipal -UserId $interactive -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principalTask -Settings $settings `
  -Description 'HomePanel PC agent: sends temperatures and drive space to your dashboard and runs its buttons.'
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Say "Registered scheduled task '$TaskName' (at logon of $interactive, highest privileges)." Green

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  Say "Agent started (task state: $((Get-ScheduledTask -TaskName $TaskName).State))." Green
}

Say ''
Say 'Done! Useful commands:' Cyan
Say "  Your sensors      : & `"$node`" `"$agent`" list-sensors"
Say "  Try a button      : & `"$node`" `"$agent`" test-action open-drive-c --really"
Say "  Edit buttons      : notepad `"$configPath`"   (then restart the agent)"
Say "  Restart the agent : Stop-ScheduledTask '$TaskName'; Start-ScheduledTask '$TaskName'"
Say "  Uninstall         : & `"$(Join-Path $InstallDir 'uninstall.ps1')`""
Say 'Firewall: the agent only connects OUT to MQTT (port 1883); nothing needs to be opened on this PC.'
