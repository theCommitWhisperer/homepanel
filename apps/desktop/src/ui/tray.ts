/**
 * Tray icon for `HomePanel.exe tray`: a hidden Windows PowerShell child shows a
 * System.Windows.Forms.NotifyIcon and talks to us with one JSON object per line:
 *
 *   PowerShell → us   {"type":"ready"} | {"type":"menu","id":"open"|"dashboard"|"restart-agent"|"setup"|"quit"}
 *   us → PowerShell   {"type":"balloon","title","text","icon"?:"Info"|"Warning"|"Error"} | {"type":"tooltip","text"} | {"type":"quit"}
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { powershellArgs, psStr } from "../../../installer/src/local/ps.js";

export type TrayMenuId = "open" | "dashboard" | "restart-agent" | "setup" | "quit";

export const TRAY_MENU: { id: TrayMenuId; text: string; bold?: boolean }[] = [
  { id: "open", text: "Open HomePanel", bold: true },
  { id: "dashboard", text: "Open dashboard" },
  { id: "restart-agent", text: "Restart agent" },
  { id: "setup", text: "Run setup" },
  { id: "quit", text: "Quit tray" },
];

/** The PowerShell 5.1 script (STA, WinForms). `iconFrom` = exe whose icon is shown. */
export function trayScript(iconFrom: string, tooltip = "HomePanel"): string {
  const items = TRAY_MENU.map(
    (m) =>
      `$i = New-Object System.Windows.Forms.ToolStripMenuItem(${psStr(m.text)}); $i.Tag = ${psStr(m.id)}; $i.add_Click($onClick)` +
      (m.bold ? "; $i.Font = New-Object System.Drawing.Font($i.Font, [System.Drawing.FontStyle]::Bold)" : "") +
      (m.id === "quit" ? "; [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))" : "") +
      "; [void]$menu.Items.Add($i)",
  );
  return [
    "$ErrorActionPreference = 'Continue'",
    "[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "[System.Windows.Forms.Application]::EnableVisualStyles()",
    "function Send-Msg($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }",
    "$icon = New-Object System.Windows.Forms.NotifyIcon",
    `try { $icon.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon(${psStr(iconFrom)}) } catch { $icon.Icon = [System.Drawing.SystemIcons]::Application }`,
    `$icon.Text = ${psStr(tooltip.slice(0, 63))}`,
    "$menu = New-Object System.Windows.Forms.ContextMenuStrip",
    "$onClick = { param($s, $e) Send-Msg @{ type = 'menu'; id = [string]$s.Tag } }",
    ...items,
    "$icon.ContextMenuStrip = $menu",
    "$icon.add_MouseDoubleClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Send-Msg @{ type = 'menu'; id = 'open' } } })",
    "$icon.add_BalloonTipClicked({ Send-Msg @{ type = 'menu'; id = 'open' } })",
    "$icon.Visible = $true",
    "$script:reader = [Console]::In",
    "$script:pending = $script:reader.ReadLineAsync()",
    "$timer = New-Object System.Windows.Forms.Timer",
    "$timer.Interval = 200",
    "$timer.add_Tick({",
    "  while ($script:pending.IsCompleted) {",
    "    $line = $script:pending.Result",
    "    if ($null -eq $line) { $timer.Stop(); [System.Windows.Forms.Application]::Exit(); return }",
    "    try {",
    "      $m = $line | ConvertFrom-Json",
    "      switch ($m.type) {",
    "        'balloon' { $ti = [System.Windows.Forms.ToolTipIcon]::Info; if ($m.icon) { $ti = [System.Windows.Forms.ToolTipIcon]$m.icon }; $icon.ShowBalloonTip(8000, [string]$m.title, [string]$m.text, $ti) }",
    "        'tooltip' { $t = [string]$m.text; if ($t.Length -gt 63) { $t = $t.Substring(0, 63) }; $icon.Text = $t }",
    "        'quit' { $timer.Stop(); [System.Windows.Forms.Application]::Exit(); return }",
    "      }",
    "    } catch { }",
    "    $script:pending = $script:reader.ReadLineAsync()",
    "  }",
    "})",
    "$timer.Start()",
    "Send-Msg @{ type = 'ready' }",
    "[System.Windows.Forms.Application]::Run()",
    "$icon.Visible = $false",
    "$icon.Dispose()",
  ].join("\n");
}

export interface TrayMessage {
  type: string;
  id?: string;
}

/** Spawns and supervises the PowerShell tray child; emits "menu" (id), "ready", "exit" (code). */
export class TrayIcon extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;

  constructor(
    private readonly iconFrom: string,
    private readonly spawnImpl: typeof spawn = spawn,
  ) {
    super();
  }

  start(): void {
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = this.spawnImpl(powershell, ["-STA", "-WindowStyle", "Hidden", ...powershellArgs(trayScript(this.iconFrom))], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => {
      const m = parseTrayLine(line);
      if (!m) return;
      if (m.type === "ready") this.emit("ready");
      if (m.type === "menu" && m.id) this.emit("menu", m.id as TrayMenuId);
    });
    child.stderr.on("data", (d: Buffer) => this.emit("stderr", d.toString()));
    child.on("exit", (code) => {
      this.child = undefined;
      this.emit("exit", code);
    });
    child.on("error", (e) => this.emit("error", e));
  }

  send(msg: Record<string, unknown>): void {
    this.child?.stdin.write(JSON.stringify(msg) + "\n");
  }

  balloon(title: string, text: string, icon: "Info" | "Warning" | "Error" = "Info"): void {
    this.send({ type: "balloon", title, text, icon });
  }

  stop(): void {
    if (!this.child) return;
    this.send({ type: "quit" });
    const c = this.child;
    setTimeout(() => c.kill(), 2000).unref();
  }
}

export function parseTrayLine(line: string): TrayMessage | undefined {
  try {
    const m = JSON.parse(line.trim()) as TrayMessage;
    return m && typeof m.type === "string" ? m : undefined;
  } catch {
    return undefined;
  }
}

/** Items that went from running to stopped/error since the last look (for balloons). */
export function newlyStopped(
  before: Map<string, string>,
  items: { id: string; label: string; state: string }[],
): { id: string; label: string; state: string }[] {
  const out: { id: string; label: string; state: string }[] = [];
  for (const it of items) {
    const prev = before.get(it.id);
    if (prev === "running" && (it.state === "stopped" || it.state === "error")) out.push(it);
    before.set(it.id, it.state);
  }
  return out;
}
