/**
 * The only place the agent starts processes. Everything goes through spawn() with an argument
 * array (shell: false), so nothing from MQTT or config is ever interpreted by a shell here.
 * Tests inject a fake Spawner and inspect the planned commands.
 */
import { spawn } from "node:child_process";

export interface CommandSpec {
  cmd: string;
  args: string[];
  /** start and forget (GUI programs). Otherwise wait for exit and fail on non-zero code. */
  detached?: boolean;
  timeoutMs?: number;
  /** Windows: hide the console window of helper processes (powershell, cmd) */
  hidden?: boolean;
  /** Windows: pass args verbatim (needed for `cmd /c start "" "exe"` quoting) */
  verbatim?: boolean;
  cwd?: string;
}

export const decodePowershell = (spec: CommandSpec): string | undefined => {
  const i = spec.args.indexOf("-EncodedCommand");
  return i >= 0 ? Buffer.from(spec.args[i + 1]!, "base64").toString("utf16le") : undefined;
};

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface Spawner {
  run(spec: CommandSpec): Promise<RunResult>;
}

export class NodeSpawner implements Spawner {
  run(spec: CommandSpec): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(spec.cmd, spec.args, {
          shell: false,
          detached: !!spec.detached,
          windowsHide: spec.hidden ?? true,
          windowsVerbatimArguments: !!spec.verbatim,
          stdio: spec.detached ? "ignore" : ["ignore", "pipe", "pipe"],
          cwd: spec.cwd,
        });
      } catch (e) {
        reject(e);
        return;
      }
      if (spec.detached) {
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve({ code: 0, stdout: "", stderr: "" });
        });
        return;
      }
      let stdout = "";
      let stderr = "";
      const cap = (s: string, d: Buffer) => (s.length < 64_000 ? s + d.toString() : s);
      child.stdout?.on("data", (d: Buffer) => (stdout = cap(stdout, d)));
      child.stderr?.on("data", (d: Buffer) => (stderr = cap(stderr, d)));
      let timedOut = false;
      const timer = spec.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill();
          }, spec.timeoutMs)
        : undefined;
      child.once("error", (e) => {
        if (timer) clearTimeout(timer);
        reject(e);
      });
      child.once("close", (code) => {
        if (timer) clearTimeout(timer);
        if (timedOut) reject(new Error(`timed out after ${spec.timeoutMs} ms`));
        else resolve({ code, stdout, stderr });
      });
    });
  }
}

/**
 * Dry-run executor: records and logs what would run, starts nothing. Used by tests, by
 * `test-action` without --really, by `run --mock`, and by default on non-Windows machines.
 */
export class DryRunSpawner implements Spawner {
  readonly calls: CommandSpec[] = [];
  constructor(private logFn: (line: string) => void = () => undefined) {}
  async run(spec: CommandSpec): Promise<RunResult> {
    this.calls.push(spec);
    this.logFn(`[dry-run] would run: ${describeCommand(spec)}`);
    return { code: 0, stdout: "", stderr: "" };
  }
}

/** One-line human description; inline PowerShell is shown decoded. */
export function describeCommand(spec: CommandSpec): string {
  const ps = decodePowershell(spec);
  if (ps) return `${spec.cmd} -EncodedCommand <<${ps.split("\n").length} line script>>`;
  return [spec.cmd, ...spec.args.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a))].join(" ");
}

/** Run and require exit code 0 (unless detached). */
export async function runChecked(spawner: Spawner, spec: CommandSpec): Promise<RunResult> {
  const r = await spawner.run(spec);
  if (!spec.detached && r.code !== 0) {
    const tail = (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-3).join(" | ");
    throw new Error(`${spec.cmd} exited with code ${r.code}${tail ? `: ${tail}` : ""}`);
  }
  return r;
}

/**
 * PowerShell invocation for inline scripts we ship (never user/MQTT input). The script is passed
 * as -EncodedCommand (base64 of UTF-16LE), which sidesteps every Windows command-line quoting
 * rule — important because the snippets contain C# with quotes and braces.
 */
export function powershell(script: string, timeoutMs = 15_000): CommandSpec {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return {
    cmd: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", encoded],
    timeoutMs,
    hidden: true,
  };
}
