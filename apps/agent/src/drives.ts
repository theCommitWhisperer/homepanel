import type { AgentDrive } from "@homepanel/protocol";
import { powershell, runChecked, type Spawner } from "./exec.js";
import { round } from "./util.js";

const GB = 1024 ** 3;

interface CimDisk {
  DeviceID?: string;
  VolumeName?: string | null;
  Size?: number | string | null;
  FreeSpace?: number | string | null;
}

/** Output of `Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ConvertTo-Json` */
export function parseWindowsDisks(json: string): AgentDrive[] {
  const t = json.trim();
  if (!t) return [];
  const parsed = JSON.parse(t) as CimDisk | CimDisk[];
  const list = Array.isArray(parsed) ? parsed : [parsed]; // single disk → object, not array
  return list
    .filter((d) => d.DeviceID && Number(d.Size) > 0)
    .map((d) => ({
      letter: d.DeviceID!,
      label: d.VolumeName?.trim() || (d.DeviceID === "C:" ? "Windows" : "Local Disk"),
      totalGB: round(Number(d.Size) / GB, 1),
      freeGB: round(Number(d.FreeSpace ?? 0) / GB, 1),
    }))
    .sort((a, b) => a.letter.localeCompare(b.letter));
}

const SKIP_FS = /^(tmpfs|devtmpfs|overlay|squashfs|udev|none|efivarfs|ramfs|shm|cgroup2?|proc|sysfs)$/;
const SKIP_MOUNT = /^\/(snap|proc|sys|dev|run)(\/|$)|^\/boot\/efi$|^\/var\/lib\/docker\//;

/** Output of `df -kP` (POSIX format, 1K blocks). */
export function parseDf(text: string): AgentDrive[] {
  const lines = text.trim().split(/\r?\n/).slice(1);
  const seen = new Set<string>();
  const out: AgentDrive[] = [];
  for (const line of lines) {
    // Filesystem 1024-blocks Used Available Capacity Mounted-on (mount may contain spaces)
    const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+%|-)\s+(.+)$/);
    if (!m) continue;
    const [, fs, blocks, , avail, , mount] = m as unknown as [string, string, string, string, string, string, string];
    if (SKIP_FS.test(fs) || fs.startsWith("/dev/loop") || SKIP_MOUNT.test(mount)) continue;
    // bind mounts repeat the device; tiny mounts (< 1 GB: /boot, recovery, squashfs images) are noise
    if (Number(blocks) < 1024 * 1024 || seen.has(fs)) continue;
    seen.add(fs);
    out.push({
      letter: mount,
      label: mount === "/" ? "System" : mount.split("/").filter(Boolean).pop() ?? mount,
      totalGB: round((Number(blocks) * 1024) / GB, 1),
      freeGB: round((Number(avail) * 1024) / GB, 1),
    });
  }
  return out;
}

export const WINDOWS_DISKS_PS =
  'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,VolumeName,Size,FreeSpace | ConvertTo-Json -Compress';

export async function readDrives(spawner: Spawner, platform: NodeJS.Platform = process.platform): Promise<AgentDrive[]> {
  if (platform === "win32") {
    const r = await runChecked(spawner, powershell(WINDOWS_DISKS_PS, 20_000));
    return parseWindowsDisks(r.stdout);
  }
  const r = await runChecked(spawner, { cmd: "df", args: ["-kP"], timeoutMs: 10_000 });
  return parseDf(r.stdout);
}

export function mockDrives(): AgentDrive[] {
  return [
    { letter: "C:", label: "Windows", totalGB: 1862.4, freeGB: 684.9 },
    { letter: "D:", label: "Games", totalGB: 3726, freeGB: 1062.3 },
  ];
}
