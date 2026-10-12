import { describe, expect, it } from "vitest";
import { parseDf, parseWindowsDisks, readDrives } from "../src/drives.js";
import { decodePowershell, type CommandSpec } from "../src/exec.js";

describe("drives", () => {
  it("Windows CIM JSON (array and single object)", () => {
    const json = JSON.stringify([
      { DeviceID: "C:", VolumeName: "", Size: 1999738298368, FreeSpace: 735410135040 },
      { DeviceID: "D:", VolumeName: "Games", Size: 4000768323584, FreeSpace: 1140640313344 },
    ]);
    expect(parseWindowsDisks(json)).toEqual([
      { letter: "C:", label: "Windows", totalGB: 1862.4, freeGB: 684.9 },
      { letter: "D:", label: "Games", totalGB: 3726.0, freeGB: 1062.3 },
    ]);
    expect(parseWindowsDisks(JSON.stringify({ DeviceID: "C:", VolumeName: "OS", Size: 1073741824, FreeSpace: 536870912 }))).toEqual([
      { letter: "C:", label: "OS", totalGB: 1, freeGB: 0.5 },
    ]);
    expect(parseWindowsDisks("")).toEqual([]);
  });

  it("df -kP, skipping pseudo filesystems and snaps", () => {
    const df = `Filesystem     1024-blocks      Used Available Capacity Mounted on
udev               8000000         0   8000000       0% /dev
tmpfs              1600000      2000   1598000       1% /run
/dev/nvme0n1p2   976000000 400000000 526000000      44% /
/dev/nvme0n1p1      524000      6000    518000       2% /boot/efi
/dev/loop3           65000     65000         0     100% /snap/core20/2105
overlay          976000000 400000000 526000000      44% /var/lib/docker/overlay2/abc/merged
/dev/sda1       1921000000 100000000 1821000000      6% /mnt/Media Drive
/dev/nvme0n1p2   976000000 400000000 526000000      44% /home/kevin/bind`;
    expect(parseDf(df)).toEqual([
      { letter: "/", label: "System", totalGB: 930.8, freeGB: 501.6 },
      { letter: "/mnt/Media Drive", label: "Media Drive", totalGB: 1832, freeGB: 1736.6 },
    ]);
  });

  it("uses Get-CimInstance on Windows and df on Linux", async () => {
    const calls: CommandSpec[] = [];
    const sp = { run: async (s: CommandSpec) => (calls.push(s), { code: 0, stdout: "[]", stderr: "" }) };
    await readDrives(sp, "win32");
    expect(decodePowershell(calls[0]!)).toContain('Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3"');
    const sp2 = { run: async (s: CommandSpec) => (calls.push(s), { code: 0, stdout: "Filesystem\n", stderr: "" }) };
    await readDrives(sp2, "linux");
    expect(calls[1]).toMatchObject({ cmd: "df", args: ["-kP"] });
  });
});
