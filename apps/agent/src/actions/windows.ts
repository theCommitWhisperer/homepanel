/**
 * Inline PowerShell snippets for Windows system actions. Constants only (nothing from MQTT or
 * config is interpolated); sent with -EncodedCommand so no command-line quoting is involved.
 */

/**
 * Turn monitors off: WM_SYSCOMMAND (0x0112) / SC_MONITORPOWER (0xF170) / 2 broadcast to all
 * top-level windows. PostMessage rather than SendMessage: a broadcast SendMessage waits for
 * *every* window to answer and can hang on a frozen app; the effect is the same.
 */
export const MONITORS_OFF_PS = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace HomePanel -Name Monitor -MemberDefinition @'
[DllImport("user32.dll")]
public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
'@
# HWND_BROADCAST = 0xFFFF, WM_SYSCOMMAND = 0x0112, SC_MONITORPOWER = 0xF170, 2 = off
[void][HomePanel.Monitor]::PostMessage([IntPtr]0xFFFF, 0x0112, [IntPtr]0xF170, [IntPtr]2)
`.trim();
