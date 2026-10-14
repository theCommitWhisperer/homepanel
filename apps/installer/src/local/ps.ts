/**
 * Pure generators for the Windows commands the installer runs: PowerShell scripts (Windows
 * PowerShell 5.1 compatible), Windows command-line quoting, .cmd wrappers. Kept free of side
 * effects so tests can check the exact text that would run.
 */

/** PowerShell single-quoted string literal. Doubles ' (and the typographic quotes PS also accepts). */
export function psStr(s: string): string {
  return "'" + s.replace(/['‘’‚‛]/g, (q) => q + q) + "'";
}

/** Quote one argument for a Windows command line (CommandLineToArgvW / MSVCRT rules). */
export function winArg(a: string): string {
  if (a !== "" && !/[\s"]/.test(a)) return a;
  let out = '"';
  let bs = 0;
  for (const ch of a) {
    if (ch === "\\") {
      bs++;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(bs * 2 + 1) + '"';
    } else {
      out += "\\".repeat(bs) + ch;
    }
    bs = 0;
  }
  out += "\\".repeat(bs * 2) + '"';
  return out;
}

export function winCmdLine(args: string[]): string {
  return args.map(winArg).join(" ");
}

/** Base64 UTF-16LE for `powershell -EncodedCommand` (no quoting problems at all). */
export function encodePs(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function powershellArgs(script: string): string[] {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodePs(script)];
}

/** A value that goes into a .cmd file inside double quotes. */
export function cmdQuoted(s: string): string {
  if (/["\r\n]/.test(s)) throw new Error(`Can't use a path containing quotes or newlines in a .cmd file: ${s}`);
  return '"' + s.replace(/%/g, "%%") + '"';
}

/**
 * run-server.cmd / run-agent.cmd: set environment variables, then run the command in a loop so it
 * comes back after a crash (Task Scheduler's own restart only covers "failed to start").
 */
export function loopingCmd(o: { title: string; env?: Record<string, string>; file: string; args: string[]; log?: string; delayS?: number }): string {
  const lines = ["@echo off", `rem ${o.title} - written by HomePanel setup. Runs again ${o.delayS ?? 5} s after it stops.`, "setlocal"];
  for (const [k, v] of Object.entries(o.env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`bad env name ${k}`);
    lines.push(`set ${cmdQuoted(`${k}=${v}`)}`);
  }
  const cmd = [cmdQuoted(o.file), ...o.args.map(cmdQuoted)].join(" ");
  lines.push(":loop");
  lines.push(o.log ? `${cmd} >> ${cmdQuoted(o.log)} 2>&1` : cmd);
  // `timeout` fails without a console (scheduled tasks), ping is the classic portable sleep
  lines.push(`ping -n ${(o.delayS ?? 5) + 1} 127.0.0.1 >nul`);
  lines.push("goto loop");
  return lines.join("\r\n") + "\r\n";
}

/* ------------------------------------------------------------------ */
/* Scheduled tasks                                                      */
/* ------------------------------------------------------------------ */

export interface TaskSpec {
  name: string;
  description: string;
  file: string;
  args: string[];
  workingDir?: string;
  /** startup = at boot as SYSTEM; logon = at logon of `user`, in their session (needs the desktop) */
  trigger: "startup" | "logon";
  /** DOMAIN\user for logon tasks */
  user?: string;
  /** delay after the trigger, seconds */
  delayS?: number;
  /** environment (systemd only; on Windows a .cmd wrapper sets variables) */
  env?: Record<string, string>;
}

export function registerTaskPs(t: TaskSpec): string {
  if (t.trigger === "logon" && !t.user) throw new Error("logon task needs a user");
  const action =
    `$action = New-ScheduledTaskAction -Execute ${psStr(t.file)}` +
    (t.args.length ? ` -Argument ${psStr(winCmdLine(t.args))}` : "") +
    (t.workingDir ? ` -WorkingDirectory ${psStr(t.workingDir)}` : "");
  const trigger =
    t.trigger === "startup" ? "$trigger = New-ScheduledTaskTrigger -AtStartup" : `$trigger = New-ScheduledTaskTrigger -AtLogOn -User ${psStr(t.user!)}`;
  const principal =
    t.trigger === "startup"
      ? "$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest"
      : `$principal = New-ScheduledTaskPrincipal -UserId ${psStr(t.user!)} -LogonType Interactive -RunLevel Highest`;
  return [
    "$ErrorActionPreference = 'Stop'",
    action,
    trigger,
    ...(t.delayS ? [`$trigger.Delay = 'PT${Math.round(t.delayS)}S'`] : []),
    principal,
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable " +
      "-MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)",
    `$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description ${psStr(t.description)}`,
    `Register-ScheduledTask -TaskName ${psStr(t.name)} -InputObject $task -Force | Out-Null`,
  ].join("\n");
}

export function taskInfoPs(name: string): string {
  return [
    `$t = Get-ScheduledTask -TaskName ${psStr(name)} -ErrorAction SilentlyContinue`,
    "if ($t) { $a = $t.Actions | Select-Object -First 1; Write-Output (\"{0}|{1}|{2}\" -f $t.State, $a.Execute, $a.Arguments) }",
  ].join("\n");
}

export const startTaskPs = (name: string) => `Start-ScheduledTask -TaskName ${psStr(name)}`;
export const stopTaskPs = (name: string) =>
  `$t = Get-ScheduledTask -TaskName ${psStr(name)} -ErrorAction SilentlyContinue; if ($t) { Stop-ScheduledTask -TaskName ${psStr(name)} }`;

/* ------------------------------------------------------------------ */
/* Firewall, network, services, processes                               */
/* ------------------------------------------------------------------ */

export interface FirewallRule {
  name: string;
  displayName: string;
  port: number;
  profile: "Private" | "Any";
}

export function firewallRulePs(r: FirewallRule): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `if (-not (Get-NetFirewallRule -Name ${psStr(r.name)} -ErrorAction SilentlyContinue)) {`,
    `  New-NetFirewallRule -Name ${psStr(r.name)} -DisplayName ${psStr(r.displayName)} -Direction Inbound -Protocol TCP -LocalPort ${r.port} -Action Allow -Profile ${r.profile} | Out-Null`,
    "}",
  ].join("\n");
}
export const firewallExistsPs = (name: string) => `if (Get-NetFirewallRule -Name ${psStr(name)} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`;

export const networkCategoryPs =
  "$p = Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -eq 'Internet' } | Select-Object -First 1\n" +
  "if (-not $p) { $p = Get-NetConnectionProfile | Select-Object -First 1 }\n" +
  "if ($p) { [string]$p.NetworkCategory }";
export const setNetworkPrivatePs =
  "Get-NetConnectionProfile | Where-Object { $_.NetworkCategory -eq 'Public' } | Set-NetConnectionProfile -NetworkCategory Private";

/**
 * Mosquitto's Windows service (`mosquitto install`) runs `"mosquitto.exe" run` and, as a service,
 * reads %MOSQUITTO_DIR%\mosquitto.conf (src/service.c: service_main builds "-c <MOSQUITTO_DIR>\mosquitto.conf";
 * main() only enters service mode when argv is exactly `run`, so `run -c x` in binPath would NOT work).
 * We give the service its own MOSQUITTO_DIR through the per-service Environment registry value.
 */
export function serviceEnvPs(service: string, env: Record<string, string>): string {
  const values = Object.entries(env).map(([k, v]) => psStr(`${k}=${v}`));
  return [
    "$ErrorActionPreference = 'Stop'",
    `$key = ${psStr(`HKLM:\\SYSTEM\\CurrentControlSet\\Services\\${service}`)}`,
    `New-ItemProperty -Path $key -Name 'Environment' -PropertyType MultiString -Value @(${values.join(", ")}) -Force | Out-Null`,
    `Set-Service -Name ${psStr(service)} -StartupType Automatic`,
  ].join("\n");
}

export function serviceInfoPs(service: string): string {
  return [
    `$s = Get-Service -Name ${psStr(service)} -ErrorAction SilentlyContinue`,
    "if (-not $s) { 'missing'; return }",
    `$e = (Get-ItemProperty -Path ${psStr(`HKLM:\\SYSTEM\\CurrentControlSet\\Services\\${service}`)} -Name Environment -ErrorAction SilentlyContinue).Environment`,
    "Write-Output ([string]$s.Status)",
    "foreach ($x in @($e)) { if ($x) { Write-Output $x } }",
  ].join("\n");
}
/** Stop a service and set it to start manually (kept installed). */
export const disableServicePs = (service: string) =>
  [
    `$s = Get-Service -Name ${psStr(service)} -ErrorAction SilentlyContinue`,
    "if (-not $s) { return }",
    `Stop-Service -Name ${psStr(service)} -Force -ErrorAction SilentlyContinue`,
    `Set-Service -Name ${psStr(service)} -StartupType Manual`,
  ].join("\n");
export const unregisterTaskPs = (name: string) =>
  `$t = Get-ScheduledTask -TaskName ${psStr(name)} -ErrorAction SilentlyContinue; if ($t) { Stop-ScheduledTask -TaskName ${psStr(name)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${psStr(name)} -Confirm:$false }`;
export const removeFirewallRulePs = (name: string) =>
  `Get-NetFirewallRule -Name ${psStr(name)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`;

export const restartServicePs = (service: string) =>
  `$ErrorActionPreference = 'Stop'\nRestart-Service -Name ${psStr(service)} -Force\nStart-Sleep -Seconds 2\n[string](Get-Service -Name ${psStr(service)}).Status`;

export function stopProcessPs(o: { name?: string; path?: string; commandLike?: string; exceptPid?: number }): string {
  const where: string[] = [];
  if (o.commandLike) where.push(`$_.CommandLine -like ${psStr(o.commandLike)}`);
  if (o.name) where.push(`$_.Name -eq ${psStr(o.name.endsWith(".exe") ? o.name : o.name + ".exe")}`);
  if (o.path) where.push(`$_.ExecutablePath -eq ${psStr(o.path)}`);
  if (o.exceptPid) where.push(`$_.ProcessId -ne ${o.exceptPid}`);
  return [
    `Get-CimInstance Win32_Process | Where-Object { ${where.join(" -and ") || "$false"} } |`,
    "  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    "Start-Sleep -Milliseconds 800",
  ].join("\n");
}
export const processRunningPs = (name: string) =>
  `if (Get-Process -Name ${psStr(name.replace(/\.exe$/i, ""))} -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`;

/** The signed-in user (owner of explorer.exe); the elevated admin account can differ. */
export const interactiveUserPs = [
  "$u = $null",
  "try {",
  "  $o = Get-CimInstance Win32_Process -Filter \"Name='explorer.exe'\" | Select-Object -First 1 | Invoke-CimMethod -MethodName GetOwner",
  '  if ($o -and $o.User) { $u = "$($o.Domain)\\$($o.User)" }',
  "} catch { }",
  'if (-not $u) { $u = "$env:USERDOMAIN\\$env:USERNAME" }',
  "Write-Output $u",
].join("\n");

export const isElevatedPs =
  "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)";

export function relaunchElevatedPs(file: string, args: string[]): string {
  return [
    `$p = Start-Process -FilePath ${psStr(file)} -ArgumentList ${psStr(winCmdLine(args))} -Verb RunAs -PassThru -Wait`,
    "exit $p.ExitCode",
  ].join("\n");
}

/** LibreHardwareMonitor.exe: running process, winget portable folders (machine + user), uninstall keys, Program Files. */
export const findLhmPs = [
  "$c = @()",
  "$p = Get-Process -Name LibreHardwareMonitor -ErrorAction SilentlyContinue | Select-Object -First 1",
  "if ($p -and $p.Path) { $c += $p.Path }",
  'foreach ($root in @("$env:ProgramFiles\\WinGet\\Packages", "$env:LOCALAPPDATA\\Microsoft\\WinGet\\Packages")) {',
  "  Get-ChildItem -Path $root -Directory -Filter 'LibreHardwareMonitor.LibreHardwareMonitor_*' -ErrorAction SilentlyContinue | ForEach-Object {",
  "    Get-ChildItem -Path $_.FullName -Recurse -Filter 'LibreHardwareMonitor.exe' -ErrorAction SilentlyContinue | ForEach-Object { $c += $_.FullName }",
  "  }",
  "}",
  "Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue |",
  "  Where-Object { $_.DisplayName -like '*LibreHardwareMonitor*' -and $_.InstallLocation } |",
  "  ForEach-Object { $c += (Join-Path $_.InstallLocation 'LibreHardwareMonitor.exe') }",
  '$c += "$env:ProgramFiles\\LibreHardwareMonitor\\LibreHardwareMonitor.exe"',
  "$c | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1",
].join("\n");

/** Mosquitto install folder: the service's ImagePath, then the default folders. */
export const findMosquittoPs = [
  "$c = @()",
  "$img = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\mosquitto' -Name ImagePath -ErrorAction SilentlyContinue).ImagePath",
  "if ($img -and ($img -match '^\"?([^\"]+?\\\\)mosquitto\\.exe')) { $c += $Matches[1] }",
  '$c += "$env:ProgramFiles\\mosquitto\\"',
  '$c += "${env:ProgramFiles(x86)}\\mosquitto\\"',
  "$c | Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'mosquitto.exe')) } | Select-Object -First 1",
].join("\n");

/** icacls arguments: only SYSTEM + Administrators (+ optionally one user, modify) keep access. */
export function icaclsArgs(path: string, o: { dir: boolean; user?: string }): string[] {
  const inh = o.dir ? "(OI)(CI)" : "";
  return [
    path,
    "/inheritance:r",
    "/grant:r",
    `*S-1-5-18:${inh}F`,
    `*S-1-5-32-544:${inh}F`,
    ...(o.user ? [`${o.user}:${inh}M`] : []),
  ];
}
