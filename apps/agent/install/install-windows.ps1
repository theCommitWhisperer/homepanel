<#
.SYNOPSIS
  Installs the HomePanel PC agent on Windows.

.DESCRIPTION
  Run from the unzipped release folder in an *administrator* PowerShell:

      Set-ExecutionPolicy -Scope Process Bypass -Force
      .\install-windows.ps1

  What it does:
    1. Finds Node.js 22+ (a node.exe next to this script, or on PATH, or installs Node LTS with winget)
    2. Copies agent.cjs + node.exe to C:\Program Files\HomePanel\Agent
    3. Offers to install LibreHardwareMonitor (winget) and tells you the two settings to switch on
    4. Writes C:\ProgramData\HomePanel\agent.yaml if it doesn't exist (asks for server, pc id, key)
       and copies the example scripts to C:\ProgramData\HomePanel\scripts
    5. Registers the scheduled task "HomePanel Agent": at logon of YOUR user, hidden, restarts on failure

  Why a logon task and not a Windows service: services run in "session 0", which has no desktop.
  Buttons like "open D:\Projects" or "launch Steam" would start invisible programs there. Running
  as you, in your session, makes them appear on your screen like you double-clicked them.

.PARAMETER Elevated
  Run the agent with highest privileges. Not needed for any built-in action, and programs it
  launches (Steam, games, Discord) would also run as administrator — so it's off by default.

.PARAMETER NoStart
  Register the task but don't start it now.
#>
[CmdletBinding()]
param(
  [switch]$Elevated,
  [switch]$NoStart,
  [string]$InstallDir = "$env:ProgramFiles\HomePanel\Agent",
  [string]$DataDir = "$env:ProgramData\HomePanel"
)

$ErrorActionPreference = 'Stop'
$TaskName = 'HomePanel Agent'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Ask-YesNo($question, $defaultYes = $true) {
  $suffix = if ($defaultYes) { '[Y/n]' } else { '[y/N]' }
  $a = Read-Host "$question $suffix"
  if ([string]::IsNullOrWhiteSpace($a)) { return $defaultYes }
  return $a.Trim().ToLower().StartsWith('y')
}
function Ask($question, $default) {
  $prompt = if ($default) { "$question [$default]" } else { $question }
  $a = Read-Host $prompt
  if ([string]::IsNullOrWhiteSpace($a)) { return $default }
  return $a.Trim()
}

# --- 0. admin check ---------------------------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Say 'Please run this script from an administrator PowerShell (right-click PowerShell -> Run as administrator).' Red
  exit 1
}
if (-not (Test-Path (Join-Path $Here 'agent.cjs'))) {
  Say "agent.cjs not found next to this script ($Here). Run it from the unzipped release folder." Red
  exit 1
}

# The task must run as the person who uses this PC, not as the admin account that may have been
# used to elevate. explorer.exe's owner is the interactive user.
$interactive = $null
try {
  $owner = (Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" | Select-Object -First 1 | Invoke-CimMethod -MethodName GetOwner)
  if ($owner -and $owner.User) { $interactive = "$($owner.Domain)\$($owner.User)" }
} catch { }
if (-not $interactive) { $interactive = "$env:USERDOMAIN\$env:USERNAME" }

Say ''
Say '=== HomePanel PC agent installer ===' Cyan
Say "Install folder : $InstallDir"
Say "Config folder  : $DataDir"
Say "Runs as user   : $interactive"
Say ''

# --- 1. Node.js -------------------------------------------------------------------------------
function Get-NodeMajor($exe) {
  try { $v = & $exe --version 2>$null; if ($v -match '^v(\d+)\.') { return [int]$Matches[1] } } catch { }
  return 0
}
$nodeSrc = $null
$bundled = Join-Path $Here 'node.exe'
if ((Test-Path $bundled) -and (Get-NodeMajor $bundled) -ge 22) { $nodeSrc = $bundled }
if (-not $nodeSrc) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd -and (Get-NodeMajor $cmd.Source) -ge 22) { $nodeSrc = $cmd.Source }
}
if (-not $nodeSrc) {
  Say 'Node.js 22 or newer was not found.' Yellow
  if (Ask-YesNo 'Install Node.js LTS now with winget?') {
    winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    $candidate = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if ((Test-Path $candidate) -and (Get-NodeMajor $candidate) -ge 22) { $nodeSrc = $candidate }
  }
}
if (-not $nodeSrc) {
  Say 'Cannot continue without Node.js 22+. Install it from https://nodejs.org and run this script again.' Red
  exit 1
}
Say "Using Node.js from $nodeSrc ($(& $nodeSrc --version))" Green

# --- 2. copy program files --------------------------------------------------------------------
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Say 'Stopping the running agent for the update...'
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*HomePanel*agent.cjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 1
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item (Join-Path $Here 'agent.cjs') $InstallDir -Force
# A private copy of node.exe: updating or removing Node later won't break the agent.
Copy-Item $nodeSrc (Join-Path $InstallDir 'node.exe') -Force
foreach ($f in 'agent.example.yaml', 'README.md', 'uninstall-windows.ps1') {
  $p = Join-Path $Here $f
  if (Test-Path $p) { Copy-Item $p $InstallDir -Force }
}
$node = Join-Path $InstallDir 'node.exe'
$agent = Join-Path $InstallDir 'agent.cjs'
Say "Copied agent to $InstallDir" Green

# --- 3. LibreHardwareMonitor ------------------------------------------------------------------
$lhmOk = $false
try { $lhmOk = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://localhost:8085/data.json').StatusCode -eq 200 } catch { }
if ($lhmOk) {
  Say 'LibreHardwareMonitor web server is answering on port 8085.' Green
} else {
  $lhmInstalled = $false
  try { $lhmInstalled = [bool](winget list --id LibreHardwareMonitor.LibreHardwareMonitor -e 2>$null | Select-String 'LibreHardwareMonitor') } catch { }
  if (-not $lhmInstalled) {
    Say ''
    Say 'Temperatures come from LibreHardwareMonitor (free, open source).' Yellow
    if (Ask-YesNo 'Install LibreHardwareMonitor now with winget?') {
      winget install --id LibreHardwareMonitor.LibreHardwareMonitor -e --accept-source-agreements --accept-package-agreements
    }
  }
  Say ''
  Say 'Set up LibreHardwareMonitor once:' Cyan
  Say '  1. Start it as administrator (right-click -> Run as administrator). Recent versions use the'
  Say '     Microsoft-signed PawnIO driver; if it offers to install PawnIO, say yes. (Old versions used'
  Say '     WinRing0, which Windows Defender flags - update LHM if you see that warning.)'
  Say '  2. Options -> tick "Run On Windows Startup"  (starts it elevated at every logon)'
  Say '  3. Options -> Remote Web Server -> Run       (port 8085; the agent reads http://localhost:8085/data.json)'
  Say '  Also handy: Options -> "Start Minimized" and "Minimize To Tray".'
  Say ''
}

# --- 4. config --------------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$configPath = Join-Path $DataDir 'agent.yaml'
if (Test-Path $configPath) {
  Say "Keeping existing config $configPath" Green
} else {
  Say 'Now the connection details. In the HomePanel admin page open "Computers" -> "Add computer";' Cyan
  Say 'it shows the PC id and a key for this PC.' Cyan
  $defaultId = ($env:COMPUTERNAME.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
  $server = Ask 'HomePanel / MQTT server address (IP or hostname)' 'homeassistant.local'
  $port = Ask 'MQTT port' '1883'
  $mqttUser = Ask 'MQTT username' 'homepanel'
  $mqttPassSecure = Read-Host 'MQTT password' -AsSecureString
  $mqttPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($mqttPassSecure))
  do { $pcId = Ask 'PC id (lowercase, dashes)' $defaultId } until ($pcId -match '^[a-z0-9][a-z0-9-]{0,47}$')
  $pcName = Ask 'Display name' $env:COMPUTERNAME
  do { $key = Ask 'Agent key from the admin page' $null } until ($key -and $key.Length -ge 16)

  $example = Get-Content (Join-Path $Here 'agent.example.yaml') -Raw -Encoding UTF8
  # YAML single-quoted string; then '$' doubled because -replace treats '$1' etc. in the
  # replacement text as group references (passwords may contain '$').
  $q = { param($s) ("'" + ($s -replace "'", "''") + "'").Replace('$', '$$') }
  $example = $example -replace '(?m)^pcId: .*$', ("pcId: " + $pcId)
  $example = $example -replace '(?m)^name: .*$', ("name: " + (& $q $pcName))
  $example = $example -replace '(?m)^  url: mqtt://.*$', ("  url: mqtt://" + $server + ":" + $port).Replace('$', '$$')
  $example = $example -replace '(?m)^  username: .*$', ("  username: " + (& $q $mqttUser))
  $example = $example -replace '(?m)^  password: .*$', ("  password: " + (& $q $mqttPass))
  $example = $example -replace '(?m)^key: .*$', ("key: " + (& $q $key))
  $example = $example -replace '(?m)^  # file: .*$', ("  file: " + (& $q (Join-Path $DataDir 'agent.log')))
  [IO.File]::WriteAllText($configPath, $example, (New-Object Text.UTF8Encoding($false)))

  # agent.yaml holds the key and MQTT password: readable only by SYSTEM, Administrators and you.
  icacls $configPath /inheritance:r /grant:r "*S-1-5-18:F" "*S-1-5-32-544:F" "${interactive}:M" | Out-Null
  Say "Wrote $configPath" Green
}
$scriptsDir = Join-Path $DataDir 'scripts'
New-Item -ItemType Directory -Force -Path $scriptsDir | Out-Null
Get-ChildItem (Join-Path $Here 'scripts') -Filter *.ps1 -ErrorAction SilentlyContinue | ForEach-Object {
  $dest = Join-Path $scriptsDir $_.Name
  if (-not (Test-Path $dest)) { Copy-Item $_.FullName $dest }
}

& $node $agent check-config --config $configPath
if ($LASTEXITCODE -ne 0) {
  Say "Fix $configPath and run this script again (or: `"$node`" `"$agent`" check-config)." Red
  exit 1
}

# --- 5. scheduled task ------------------------------------------------------------------------
# conhost.exe --headless runs node without a console window (Windows 10 21H2+ / 11).
# --supervise: a tiny parent process restarts the agent if it ever crashes (Task Scheduler's own
# "restart on failure" only covers failures to *start* the task).
$argLine = "--headless `"$node`" `"$agent`" run --supervise --config `"$configPath`""
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument $argLine -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $interactive
$trigger.Delay = 'PT15S'  # let the network and LibreHardwareMonitor come up first
$runLevel = if ($Elevated) { 'Highest' } else { 'Limited' }
$principalTask = New-ScheduledTaskPrincipal -UserId $interactive -LogonType Interactive -RunLevel $runLevel
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principalTask -Settings $settings `
  -Description 'HomePanel PC agent: sends sensors and drives to your dashboard and runs its buttons.'
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
Say "Registered scheduled task '$TaskName' (at logon of $interactive, run level $runLevel)." Green

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $TaskName
  Start-Sleep -Seconds 3
  Say "Agent started (task state: $((Get-ScheduledTask -TaskName $TaskName).State))." Green
}

Say ''
Say 'Done! Useful commands:' Cyan
Say "  See your sensors : & `"$node`" `"$agent`" list-sensors"
Say "  Try a button     : & `"$node`" `"$agent`" test-action lock"
Say "  Edit buttons     : notepad $configPath   (then restart the agent, below)"
Say "  Restart agent    : Stop-ScheduledTask '$TaskName'; Start-ScheduledTask '$TaskName'"
Say "  Log file         : $(Join-Path $DataDir 'agent.log')"
Say "  Uninstall        : & `"$(Join-Path $InstallDir 'uninstall-windows.ps1')`""
