import { describe, expect, it } from "vitest";
import { ActionDispatcher } from "../src/actions/dispatcher.js";
import { planAction, type PlanContext } from "../src/actions/plan.js";
import { VK } from "../src/actions/windows.js";
import { parseConfig, type ActionDef } from "../src/config.js";
import { decodePowershell, type CommandSpec, type RunResult, type Spawner } from "../src/exec.js";

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
  open-downloads: { type: open, path: '%USERPROFILE%\\Downloads' }
  launch-studio: { type: launch, find: '%LOCALAPPDATA%\\Roblox\\Versions\\*\\RobloxStudioBeta.exe', label: Roblox Studio }
  launch-steam: { type: launch, exe: steam.exe, args: ['-silent'] }
  play-pause: { type: keys, key: media_play_pause }
  vol-up: { type: keys, key: volume_up }
  lock: { type: system, op: lock }
  sleep: { type: system, op: sleep }
  restart: { type: system, op: restart }
  shutdown: { type: system, op: shutdown, guard: confirm+home-only }
  monitors-off: { type: system, op: monitors_off }
  mute-mic: { type: system, op: mute_mic }
  speakers: { type: script, file: 'scripts\\audio-speakers.ps1' }
  web: { type: url, url: 'https://example.com/?a=1&b=2' }
  probe: { type: echo }
`);
const A = cfg.actions;
const plan = (id: string, ctx: PlanContext) => planAction(A[id] as ActionDef, ctx);

describe("action planning — Windows", () => {
  it("open → explorer.exe with env expanded", () => {
    expect(plan("open-downloads", win).steps).toEqual([
      { cmd: "explorer.exe", args: ["C:\\Users\\Kevin\\Downloads"], detached: true, hidden: false },
    ]);
  });

  it("launch exe → cmd /c start with quoting, verbatim, detached", () => {
    const [s] = plan("launch-steam", win).steps;
    expect(s).toMatchObject({ cmd: "cmd.exe", detached: true, verbatim: true });
    expect(s!.args).toEqual(["/d", "/s", "/c", '"start "" "steam.exe" "-silent""']);
  });

  it("launch find → newest match, %LOCALAPPDATA% expanded", () => {
    let seen = "";
    const ctx = { ...win, findNewest: (p: string) => ((seen = p), "C:\\Users\\Kevin\\AppData\\Local\\Roblox\\Versions\\version-abc\\RobloxStudioBeta.exe") };
    const [s] = plan("launch-studio", ctx).steps;
    expect(seen).toBe("C:\\Users\\Kevin\\AppData\\Local\\Roblox\\Versions\\*\\RobloxStudioBeta.exe");
    expect(s!.args[3]).toBe('"start "" "C:\\Users\\Kevin\\AppData\\Local\\Roblox\\Versions\\version-abc\\RobloxStudioBeta.exe""');
    expect(() => plan("launch-studio", win)).toThrow(/nothing matches/);
  });

  it("launch refuses cmd metacharacters coming from env expansion", () => {
    const ctx = { ...win, env: { EVIL: "a&calc" } };
    expect(() => planAction({ type: "launch", exe: "%EVIL%.exe", args: [] }, ctx)).toThrow(/special characters/);
  });

  it("keys → PowerShell keybd_event with the right VK code", () => {
    const [s] = plan("play-pause", win).steps;
    expect(s!.cmd).toBe("powershell.exe");
    expect(s!.args).toContain("-EncodedCommand");
    const script = decodePowershell(s!)!;
    expect(script).toContain("keybd_event");
    expect(script).toContain(`keybd_event(${0xb3}, 0, 1,`);
    expect(script).toContain(`keybd_event(${0xb3}, 0, 3,`);
    expect(decodePowershell(plan("vol-up", win).steps[0]!)).toContain(`(${VK.volume_up},`);
    expect(VK).toEqual({ media_play_pause: 0xb3, media_next: 0xb0, media_prev: 0xb1, volume_up: 0xaf, volume_down: 0xae, volume_mute: 0xad });
  });

  it("system ops", () => {
    expect(plan("lock", win).steps[0]).toMatchObject({ cmd: "rundll32.exe", args: ["user32.dll,LockWorkStation"] });
    expect(plan("sleep", win).steps[0]).toMatchObject({ cmd: "rundll32.exe", args: ["powrprof.dll,SetSuspendState", "0,1,0"] });
    expect(plan("restart", win).steps[0]).toMatchObject({ cmd: "shutdown.exe", args: ["/r", "/t", "5"] });
    expect(plan("shutdown", win).steps[0]).toMatchObject({ cmd: "shutdown.exe", args: ["/s", "/t", "5"] });
    const mon = decodePowershell(plan("monitors-off", win).steps[0]!)!;
    expect(mon).toMatch(/0xFFFF, 0x0112, \[IntPtr\]0xF170, \[IntPtr\]2/);
    const mic = decodePowershell(plan("mute-mic", win).steps[0]!)!;
    expect(mic).toContain("IAudioEndpointVolume");
    expect(mic).toContain("5CDF2C82-841E-4546-9722-0CF74078229A");
    expect(mic).toContain("BCDE0395-E52F-467C-8E3D-C4579291692E");
    expect(mic).toContain("[HomePanel.Mic]::Toggle()");
  });

  it("script → powershell -File resolved next to agent.yaml with 30 s timeout", () => {
    const [s] = plan("speakers", win).steps;
    expect(s).toMatchObject({
      cmd: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\ProgramData\\HomePanel\\scripts\\audio-speakers.ps1"],
      timeoutMs: 30_000,
      cwd: "C:\\ProgramData\\HomePanel\\scripts",
    });
  });

  it("url → rundll32 FileProtocolHandler, query string intact", () => {
    expect(plan("web", win).steps[0]).toMatchObject({ cmd: "rundll32.exe", args: ["url.dll,FileProtocolHandler", "https://example.com/?a=1&b=2"] });
  });
});

describe("action planning — Linux", () => {
  it("open / url → xdg-open", () => {
    expect(planAction({ type: "open", path: "~/Downloads" }, linux).steps[0]).toMatchObject({ cmd: "xdg-open", args: ["/home/kevin/Downloads"] });
    expect(plan("web", linux).steps[0]).toMatchObject({ cmd: "xdg-open", args: ["https://example.com/?a=1&b=2"] });
  });
  it("launch spawns the program directly", () => {
    expect(plan("launch-steam", linux).steps[0]).toMatchObject({ cmd: "steam.exe", args: ["-silent"], detached: true });
  });
  it("keys → playerctl with xdotool fallback, volume via pactl", () => {
    const p = plan("play-pause", linux);
    expect(p.mode).toBe("first-success");
    expect(p.steps.map((s) => [s.cmd, ...s.args])).toEqual([["playerctl", "play-pause"], ["xdotool", "key", "XF86AudioPlay"]]);
    expect(plan("vol-up", linux).steps[0]).toMatchObject({ cmd: "pactl", args: ["set-sink-volume", "@DEFAULT_SINK@", "+5%"] });
  });
  it("system ops", () => {
    expect(plan("lock", linux).steps[0]).toMatchObject({ cmd: "loginctl", args: ["lock-session"] });
    expect(plan("sleep", linux).steps[0]).toMatchObject({ cmd: "systemctl", args: ["suspend"] });
    expect(plan("restart", linux).steps[0]).toMatchObject({ cmd: "systemctl", args: ["reboot"] });
    expect(plan("shutdown", linux).steps[0]).toMatchObject({ cmd: "systemctl", args: ["poweroff"] });
    expect(plan("mute-mic", linux).steps[0]).toMatchObject({ cmd: "pactl", args: ["set-source-mute", "@DEFAULT_SOURCE@", "toggle"] });
  });
  it("script defaults to sh for unknown extensions", () => {
    expect(planAction({ type: "script", file: "/opt/x.sh", args: [], timeoutMs: 30000 }, linux).steps[0]).toMatchObject({ cmd: "/bin/sh", args: ["/opt/x.sh"] });
  });
});

describe("dispatcher", () => {
  it("advertises actions with labels, icons and guards; hides echo outside mock", () => {
    const d = new ActionDispatcher(A, new FakeSpawner(), win);
    const list = d.list();
    expect(list.find((a) => a.id === "probe")).toBeUndefined();
    expect(list.find((a) => a.id === "launch-studio")).toMatchObject({ label: "Roblox Studio", type: "launch", icon: "🚀" });
    expect(list.find((a) => a.id === "open-downloads")).toMatchObject({ label: "Open Downloads", type: "open" });
    expect(list.find((a) => a.id === "restart")).toMatchObject({ guard: "confirm+home-only", icon: "🔄" });
    expect(list.find((a) => a.id === "sleep")).toMatchObject({ guard: "confirm" });
    expect(list.find((a) => a.id === "lock")).not.toHaveProperty("guard");
    const mock = new ActionDispatcher(A, new FakeSpawner(), win, { mock: true });
    expect(mock.list().find((a) => a.id === "probe")).toMatchObject({ type: "url" });
  });

  it("runs the planned command through the spawner", async () => {
    const sp = new FakeSpawner();
    const d = new ActionDispatcher(A, sp, win);
    expect(await d.run("lock")).toMatchObject({ ok: true });
    expect(sp.calls).toHaveLength(1);
    expect(sp.calls[0]).toMatchObject({ cmd: "rundll32.exe" });
  });

  it("unknown ids and echo-outside-mock are errors, nothing spawned", async () => {
    const sp = new FakeSpawner();
    const d = new ActionDispatcher(A, sp, win);
    expect(await d.run("format-c")).toEqual({ ok: false, error: 'unknown action "format-c"' });
    expect(await d.run("probe")).toMatchObject({ ok: false });
    expect(await d.run("__proto__")).toMatchObject({ ok: false });
    expect(sp.calls).toHaveLength(0);
  });

  it("reports non-zero exit codes", async () => {
    const sp = new FakeSpawner(() => ({ code: 1, stdout: "", stderr: "Access denied" }));
    const r = await new ActionDispatcher(A, sp, win).run("restart");
    expect(r).toEqual({ ok: false, error: "shutdown.exe exited with code 1: Access denied" });
  });

  it("first-success chains fall through on Linux", async () => {
    const sp = new FakeSpawner((s) => (s.cmd === "playerctl" ? Object.assign(new Error("spawn playerctl ENOENT"), { code: "ENOENT" }) : { code: 0, stdout: "", stderr: "" }));
    const r = await new ActionDispatcher(A, sp, linux).run("play-pause");
    expect(r.ok).toBe(true);
    expect(sp.calls.map((c) => c.cmd)).toEqual(["playerctl", "xdotool"]);
    const none = new FakeSpawner(() => Object.assign(new Error("x"), { code: "ENOENT" }));
    expect(await new ActionDispatcher(A, none, linux).run("play-pause")).toEqual({ ok: false, error: "playerctl not found; xdotool not found" });
  });

  it("mock mode never spawns, echo replies ok", async () => {
    const sp = new FakeSpawner();
    const d = new ActionDispatcher(A, sp, win, { mock: true });
    expect(await d.run("shutdown")).toMatchObject({ ok: true });
    expect(await d.run("probe")).toMatchObject({ ok: true });
    expect(sp.calls).toHaveLength(0);
  });
});
