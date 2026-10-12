import { describe, expect, it } from "vitest";
import { ActionDispatcher } from "../src/actions/dispatcher.js";
import { keyComboError, NAMED_VK, parseKeyCombo } from "../src/actions/keys.js";
import { planAction, type PlanContext } from "../src/actions/plan.js";
import { parseConfig, type ActionDef } from "../src/config.js";
import { decodePowershell, DryRunSpawner, type CommandSpec, type RunResult, type Spawner } from "../src/exec.js";

class FakeSpawner implements Spawner {
  calls: CommandSpec[] = [];
  constructor(private respond: (s: CommandSpec) => RunResult | Error = () => ({ code: 0, stdout: "", stderr: "" })) {}
  async run(spec: CommandSpec) {
    this.calls.push(spec);
    const r = this.respond(spec);
    if (r instanceof Error) throw r;
    return r;
  }
}

const winEnv = { USERPROFILE: "C:\\Users\\Kevin", LOCALAPPDATA: "C:\\Users\\Kevin\\AppData\\Local" };
const win: PlanContext = { platform: "win32", env: winEnv, configDir: "C:\\ProgramData\\HomePanel", findNewest: () => undefined };
const linux: PlanContext = { platform: "linux", env: { HOME: "/home/kevin" }, configDir: "/home/kevin/.config/homepanel" };

const cfg = parseConfig(`
pcId: gaming-pc
mqtt: { url: "mqtt://h:1883" }
key: 0123456789abcdef0123
actions:
  open-drive-d: { type: open, path: 'D:\\' }
  open-downloads: { type: open, path: '%USERPROFILE%\\Downloads' }
  launch-studio-path: { type: launch, exe: '%LOCALAPPDATA%\\Roblox\\Versions\\*\\RobloxStudioBeta.exe', label: Roblox Studio }
  launch-studio: { type: launch, exe: 'roblox-studio:' }
  launch-steam: { type: launch, exe: 'steam://open/main' }
  launch-notepad: { type: launch, exe: notepad.exe, args: ['C:\\notes.txt'] }
  launch-full: { type: launch, exe: 'C:\\Program Files\\App\\app.exe', args: ['--fast'] }
  play-pause: { type: keys, keys: media_play_pause }
  vol-up: { type: keys, keys: volume_up }
  discord-mute: { type: keys, keys: ctrl+shift+m }
  lock: { type: system, command: lock }
  sleep: { type: system, command: sleep }
  restart: { type: system, command: restart }
  shutdown: { type: system, command: shutdown, guard: confirm+home-only }
  monitors-off: { type: system, command: monitors-off }
  speakers: { type: script, script: 'scripts\\audio-switch.ps1', args: ['-Name', 'Speakers'] }
  web: { type: url, url: 'https://example.com/?a=1&b=2' }
`);
const A = cfg.actions;
const plan = (id: string, ctx: PlanContext) => planAction(A[id] as ActionDef, ctx);

describe("key combos", () => {
  it("media keys map to the right VK codes", () => {
    expect(NAMED_VK).toMatchObject({ media_play_pause: 0xb3, media_next: 0xb0, media_prev: 0xb1, volume_up: 0xaf, volume_down: 0xae, volume_mute: 0xad });
  });
  it("parses combos, modifiers first", () => {
    expect(parseKeyCombo("ctrl+shift+m")).toEqual({ vks: [0x11, 0x10, 0x4d], names: ["ctrl", "shift", "m"] });
    expect(parseKeyCombo("Win + Alt + F13").vks).toEqual([0x5b, 0x12, 0x7c]);
    expect(parseKeyCombo("Control+Escape").names).toEqual(["ctrl", "esc"]);
    expect(parseKeyCombo("play_pause").vks).toEqual([0xb3]);
  });
  it("rejects nonsense with a helpful message", () => {
    expect(keyComboError("ctrl+banana")).toMatch(/unknown key "banana"/);
    expect(keyComboError("m+ctrl")).toMatch(/not a modifier/);
    expect(keyComboError("ctrl++m")).toMatch(/empty key/);
    expect(keyComboError("volume_up")).toBeUndefined();
  });
});

describe("action planning — Windows", () => {
  it("open → explorer.exe <path>, env expanded", () => {
    expect(plan("open-drive-d", win).steps).toEqual([{ cmd: "explorer.exe", args: ["D:\\"], detached: true, hidden: false }]);
    expect(plan("open-downloads", win).steps[0]!.args).toEqual(["C:\\Users\\Kevin\\Downloads"]);
  });

  it("launch protocol URL / bare name → cmd /c start \"\" (verbatim, detached)", () => {
    const [s] = plan("launch-steam", win).steps;
    expect(s).toMatchObject({ cmd: "cmd.exe", detached: true, verbatim: true });
    expect(s!.args).toEqual(["/d", "/s", "/c", '"start "" "steam://open/main""']);
    expect(plan("launch-studio", win).steps[0]!.args[3]).toBe('"start "" "roblox-studio:""');
    expect(plan("launch-notepad", win).steps[0]!.args[3]).toBe('"start "" "notepad.exe" "C:\\notes.txt""');
  });

  it("launch full path → spawned directly, detached, cwd = its folder", () => {
    expect(plan("launch-full", win).steps[0]).toEqual({
      cmd: "C:\\Program Files\\App\\app.exe",
      args: ["--fast"],
      detached: true,
      hidden: false,
      cwd: "C:\\Program Files\\App",
    });
  });

  it("launch wildcard path → newest match", () => {
    let seen = "";
    const hit = "C:\\Users\\Kevin\\AppData\\Local\\Roblox\\Versions\\version-abc\\RobloxStudioBeta.exe";
    const ctx = { ...win, findNewest: (p: string) => ((seen = p), hit) };
    expect(plan("launch-studio-path", ctx).steps[0]).toMatchObject({ cmd: hit, detached: true });
    expect(seen).toBe("C:\\Users\\Kevin\\AppData\\Local\\Roblox\\Versions\\*\\RobloxStudioBeta.exe");
    expect(() => plan("launch-studio-path", win)).toThrow(/nothing matches/);
  });

  it("launch refuses cmd metacharacters (e.g. from env expansion)", () => {
    const ctx = { ...win, env: { EVIL: "a&calc" } };
    expect(() => planAction({ type: "launch", exe: "%EVIL%.exe", args: [] }, ctx)).toThrow(/special characters/);
  });

  it("keys → PowerShell Add-Type keybd_event, press then release in reverse", () => {
    const [s] = plan("play-pause", win).steps;
    expect(s!.cmd).toBe("powershell.exe");
    expect(s!.args).toContain("-EncodedCommand");
    const script = decodePowershell(s!)!;
    expect(script).toContain("Add-Type");
    expect(script).toContain("keybd_event(179, 0, 1,"); // 0xB3 down, extended
    expect(script).toContain("keybd_event(179, 0, 3,"); // up
    const combo = decodePowershell(plan("discord-mute", win).steps[0]!)!.split("\n").filter((l) => l.includes("::keybd_event"));
    expect(combo).toEqual([
      "[HomePanel.Keys]::keybd_event(17, 0, 0, [UIntPtr]::Zero)",
      "[HomePanel.Keys]::keybd_event(16, 0, 0, [UIntPtr]::Zero)",
      "[HomePanel.Keys]::keybd_event(77, 0, 0, [UIntPtr]::Zero)",
      "[HomePanel.Keys]::keybd_event(77, 0, 2, [UIntPtr]::Zero)",
      "[HomePanel.Keys]::keybd_event(16, 0, 2, [UIntPtr]::Zero)",
      "[HomePanel.Keys]::keybd_event(17, 0, 2, [UIntPtr]::Zero)",
    ]);
  });

  it("system commands", () => {
    expect(plan("lock", win).steps[0]).toMatchObject({ cmd: "rundll32.exe", args: ["user32.dll,LockWorkStation"] });
    expect(plan("sleep", win).steps[0]).toMatchObject({ cmd: "rundll32.exe", args: ["powrprof.dll,SetSuspendState", "0,1,0"] });
    expect(plan("restart", win).steps[0]).toMatchObject({ cmd: "shutdown.exe", args: ["/r", "/t", "5"] });
    expect(plan("shutdown", win).steps[0]).toMatchObject({ cmd: "shutdown.exe", args: ["/s", "/t", "5"] });
    const mon = decodePowershell(plan("monitors-off", win).steps[0]!)!;
    expect(mon).toMatch(/0xFFFF, 0x0112, \[IntPtr\]0xF170, \[IntPtr\]2/);
  });

  it("script → powershell -ExecutionPolicy Bypass -File <script>, resolved next to agent.yaml", () => {
    expect(plan("speakers", win).steps[0]).toMatchObject({
      cmd: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\ProgramData\\HomePanel\\scripts\\audio-switch.ps1", "-Name", "Speakers"],
      timeoutMs: 30_000,
      cwd: "C:\\ProgramData\\HomePanel\\scripts",
    });
  });

  it("url → default handler, query string intact", () => {
    expect(plan("web", win).steps[0]).toMatchObject({ cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", "https://example.com/?a=1&b=2"] });
  });
});

describe("action planning — Linux", () => {
  it("open / url / protocol launch → xdg-open", () => {
    expect(planAction({ type: "open", path: "~/Downloads" }, linux).steps[0]).toMatchObject({ cmd: "xdg-open", args: ["/home/kevin/Downloads"] });
    expect(plan("web", linux).steps[0]).toMatchObject({ cmd: "xdg-open", args: ["https://example.com/?a=1&b=2"] });
    expect(plan("launch-steam", linux).steps[0]).toMatchObject({ cmd: "xdg-open", args: ["steam://open/main"] });
  });
  it("keys → playerctl / pactl with xdotool fallback; combos via xdotool", () => {
    const p = plan("play-pause", linux);
    expect(p.mode).toBe("first-success");
    expect(p.steps.map((s) => [s.cmd, ...s.args])).toEqual([["playerctl", "play-pause"], ["xdotool", "key", "XF86AudioPlay"]]);
    expect(plan("vol-up", linux).steps[0]).toMatchObject({ cmd: "pactl", args: ["set-sink-volume", "@DEFAULT_SINK@", "+5%"] });
    expect(plan("discord-mute", linux).steps[0]).toMatchObject({ cmd: "xdotool", args: ["key", "ctrl+shift+m"] });
  });
  it("system commands", () => {
    expect(plan("lock", linux).steps[0]).toMatchObject({ cmd: "loginctl", args: ["lock-session"] });
    expect(plan("sleep", linux).steps[0]).toMatchObject({ cmd: "systemctl", args: ["suspend"] });
    expect(plan("shutdown", linux).steps[0]).toMatchObject({ cmd: "systemctl", args: ["poweroff"] });
  });
});

describe("dispatcher", () => {
  it("advertises actions with labels, icons and guards", () => {
    const list = new ActionDispatcher(A, new FakeSpawner(), win).list();
    expect(list.find((a) => a.id === "launch-studio-path")).toMatchObject({ label: "Roblox Studio", type: "launch", icon: "🚀" });
    expect(list.find((a) => a.id === "open-downloads")).toMatchObject({ label: "Open Downloads", type: "open" });
    expect(list.find((a) => a.id === "restart")).toMatchObject({ guard: "confirm+home-only", icon: "🔄" });
    expect(list.find((a) => a.id === "sleep")).toMatchObject({ guard: "confirm" });
    expect(list.find((a) => a.id === "lock")).not.toHaveProperty("guard");
    expect(list).toHaveLength(Object.keys(A).length);
  });

  it("runs the planned command through the executor", async () => {
    const sp = new FakeSpawner();
    expect(await new ActionDispatcher(A, sp, win).run("lock")).toMatchObject({ ok: true });
    expect(sp.calls).toEqual([expect.objectContaining({ cmd: "rundll32.exe" })]);
  });

  it("dry-run executor records what would run and starts nothing", async () => {
    const lines: string[] = [];
    const dry = new DryRunSpawner((l) => lines.push(l));
    const d = new ActionDispatcher(A, dry, win);
    for (const id of Object.keys(A)) {
      if (id === "launch-studio-path") continue; // needs a real file
      expect(await d.run(id), id).toMatchObject({ ok: true });
    }
    expect(dry.calls.map((c) => c.cmd)).toContain("shutdown.exe");
    expect(lines.some((l) => l.includes("[dry-run] would run: explorer.exe D:\\"))).toBe(true);
    expect(lines.some((l) => l.includes("powershell.exe -EncodedCommand <<"))).toBe(true);
  });

  it("unknown ids → unknown-action, never interpreted, nothing spawned", async () => {
    const sp = new FakeSpawner();
    const d = new ActionDispatcher(A, sp, win);
    for (const id of ["format-c", "__proto__", "constructor", "toString", "lock; shutdown /s", "../lock"]) {
      expect(await d.run(id)).toEqual({ ok: false, error: "unknown-action" });
      expect(d.has(id)).toBe(false);
    }
    expect(sp.calls).toHaveLength(0);
  });

  it("reports non-zero exit codes", async () => {
    const sp = new FakeSpawner(() => ({ code: 1, stdout: "", stderr: "Access denied" }));
    expect(await new ActionDispatcher(A, sp, win).run("restart")).toEqual({ ok: false, error: "shutdown.exe exited with code 1: Access denied" });
  });

  it("first-success chains fall through on Linux", async () => {
    const sp = new FakeSpawner((s) => (s.cmd === "playerctl" ? Object.assign(new Error("spawn playerctl ENOENT"), { code: "ENOENT" }) : { code: 0, stdout: "", stderr: "" }));
    expect((await new ActionDispatcher(A, sp, linux).run("play-pause")).ok).toBe(true);
    expect(sp.calls.map((c) => c.cmd)).toEqual(["playerctl", "xdotool"]);
    const none = new FakeSpawner(() => Object.assign(new Error("x"), { code: "ENOENT" }));
    expect(await new ActionDispatcher(A, none, linux).run("play-pause")).toEqual({ ok: false, error: "playerctl not found; xdotool not found" });
  });
});
