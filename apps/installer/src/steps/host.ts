import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { HAOS_IMAGES, HAOS_VERSION, HOMEPANEL_RAW_BASE, MIN_DOCKER_ENGINE } from "../constants.js";
import {
  GREEN_GUIDE,
  HOST_TYPES,
  PI_GUIDE,
  PROXMOX_GUIDE,
  VBOX_GUIDE,
  X86_GUIDE,
  hostDoc,
  x86FlashScript,
} from "../guides.js";
import type { HostType } from "../state.js";
import { randomPassword, showCmd, type Exec } from "../sys.js";
import { HaClient } from "../ha/client.js";
import { saveHaUrl } from "./detect.js";
import type { Step, StepContext } from "./types.js";

/* ------------------------------------------------------------------ */
/* Docker helpers                                                       */
/* ------------------------------------------------------------------ */

export interface DockerCheck {
  installed: boolean;
  engineVersion?: string;
  major?: number;
  desktop: boolean;
  ok: boolean;
  problem?: string;
  composeOk: boolean;
}

export async function checkDocker(exec: Exec): Promise<DockerCheck> {
  const v = await exec("docker", ["version", "--format", "{{.Server.Version}}|{{.Server.Platform.Name}}"], { timeoutMs: 20_000 });
  if (v.code === 127) return { installed: false, desktop: false, ok: false, problem: "Docker is not installed.", composeOk: false };
  if (v.code !== 0) {
    const perm = /permission denied/i.test(v.stderr);
    return {
      installed: true,
      desktop: false,
      ok: false,
      composeOk: false,
      problem: perm
        ? "Docker is installed but your user can't talk to it. Run `sudo usermod -aG docker $USER`, log out and in, then retry."
        : `Docker engine is not running: ${v.stderr.trim().slice(0, 200)}`,
    };
  }
  const [ver = "", platform = ""] = v.stdout.trim().split("|");
  const info = await exec("docker", ["info", "--format", "{{.OperatingSystem}}"], { timeoutMs: 20_000 });
  const desktop = /docker desktop/i.test(platform) || /docker desktop/i.test(info.stdout);
  const major = parseInt(ver, 10);
  const compose = await exec("docker", ["compose", "version"], { timeoutMs: 20_000 });
  let problem: string | undefined;
  if (desktop)
    problem =
      "This is Docker Desktop. Home Assistant Container needs Docker Engine on Linux (host networking, USB, mDNS). " +
      "Use a Linux machine with Docker Engine, or run HA OS in a VM instead.";
  else if (!(major >= MIN_DOCKER_ENGINE)) problem = `Docker Engine ${ver} is too old; HA needs ${MIN_DOCKER_ENGINE} or newer.`;
  else if (compose.code !== 0) problem = "The Docker Compose plugin is missing (`docker compose version` failed). Install docker-compose-plugin.";
  return { installed: true, engineVersion: ver, major, desktop, ok: !problem, problem, composeOk: compose.code === 0 };
}

/** Files that make up the Docker deployment, read from the repo checkout or downloaded. */
async function deployFile(ctx: StepContext, rel: string): Promise<string> {
  if (ctx.repoRoot) {
    const p = join(ctx.repoRoot, "deploy", rel);
    if (existsSync(p)) {
      const { readFileSync } = await import("node:fs");
      return readFileSync(p, "utf8");
    }
  }
  const res = await ctx.fetchImpl(`${HOMEPANEL_RAW_BASE}/deploy/${rel}`);
  if (!res.ok) throw new Error(`Could not download deploy/${rel} (HTTP ${res.status})`);
  return res.text();
}

export function envFile(vars: Record<string, string | undefined>): string {
  return (
    Object.entries(vars)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${String(v).replace(/\n/g, "")}`)
      .join("\n") + "\n"
  );
}

export async function writeDockerEnv(ctx: StepContext) {
  const dir = ctx.store.state.dockerDir;
  if (!dir) return;
  const s = ctx.store.secrets;
  const tz = ctx.store.state.location?.time_zone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  writeFileSync(
    join(dir, ".env"),
    envFile({
      TZ: tz,
      HOMEPANEL_SRC: ctx.repoRoot,
      HA_TOKEN: s.haToken ?? "",
      MQTT_USER: "homepanel",
      MQTT_PASS: s.mqttPassword ?? "",
      ADMIN_PASSWORD: s.adminPassword ?? "",
      AI_PROVIDER: ctx.store.state.ai?.provider ?? "",
      AI_MODEL: ctx.store.state.ai?.model ?? "",
      AI_BASE_URL: ctx.store.state.ai?.baseUrl ?? "",
      AI_API_KEY: s.extra?.ai_api_key ?? "",
    }),
    { mode: 0o600 },
  );
}

async function setupDocker(ctx: StepContext): Promise<"done" | "failed" | "manual"> {
  const { out, prompt, exec } = ctx;
  if (process.platform !== "linux") {
    out.err("The Docker option must be run ON the Linux machine that will host Home Assistant.");
    out.info(`See docs/${hostDoc("linux-docker")}.`);
    return "manual";
  }
  let d = await checkDocker(exec);
  if (!d.installed) {
    out.warn("Docker is not installed.");
    out.info("The official convenience script installs Docker Engine + Compose:");
    out.code("curl -fsSL https://get.docker.com -o get-docker.sh\nsudo sh get-docker.sh\nsudo usermod -aG docker $USER");
    if (await prompt.confirm({ message: "Run these commands now (needs sudo)?", default: false })) {
      const r1 = await exec("sh", ["-c", "curl -fsSL https://get.docker.com -o /tmp/get-docker.sh && sudo sh /tmp/get-docker.sh"], {
        inherit: true,
        timeoutMs: 15 * 60_000,
      });
      if (r1.code !== 0) {
        out.err("Docker install failed. Fix the error above and run `homepanel setup` again.");
        return "failed";
      }
      await exec("sudo", ["usermod", "-aG", "docker", process.env.USER ?? "root"], { inherit: true });
      out.ok("Docker installed. If the next check fails with 'permission denied', log out and back in, then re-run setup.");
      d = await checkDocker(exec);
    } else return "manual";
  }
  if (!d.ok) {
    out.err(d.problem!);
    return "failed";
  }
  out.ok(`Docker Engine ${d.engineVersion} with Compose.`);

  const def = ctx.store.state.dockerDir ?? join(homedir(), "homepanel");
  const dir = resolve(await prompt.input({ message: "Folder for the Docker setup (config + data):", default: def }));
  mkdirSync(join(dir, "mosquitto"), { recursive: true });
  ctx.store.update({ dockerDir: dir });

  const compose = await deployFile(ctx, "compose.yaml");
  const mosqConf = await deployFile(ctx, "mosquitto/mosquitto.conf");
  writeFileSync(join(dir, "compose.yaml"), compose);
  writeFileSync(join(dir, "mosquitto", "mosquitto.conf"), mosqConf);

  if (!ctx.store.secrets.mqttPassword) ctx.store.setSecret("mqttPassword", randomPassword());
  ctx.vault.add("mqttPassword", ctx.store.secrets.mqttPassword!);
  if (!ctx.store.secrets.adminPassword) {
    out.info("Choose a password for the HomePanel admin page (pairing screens, editing profiles).");
    ctx.store.setSecret("adminPassword", await ctx.secret("HomePanel admin password", { confirm: true, minLength: 6 }));
  }
  // Mosquitto wants a hashed password file: write plaintext, then hash it in place with mosquitto_passwd -U.
  // (The mosquitto container chowns its config dir, so after the first run the file belongs to uid 1883 —
  // we only create it once.)
  const passwd = join(dir, "mosquitto", "passwd");
  if (!existsSync(passwd)) {
    writeFileSync(passwd, `homepanel:${ctx.store.secrets.mqttPassword}\n`, { mode: 0o600 });
    const hash = await exec(
      "docker",
      ["run", "--rm", "-v", `${join(dir, "mosquitto")}:/mosquitto/config`, "eclipse-mosquitto:2", "mosquitto_passwd", "-U", "/mosquitto/config/passwd"],
      { timeoutMs: 5 * 60_000 },
    );
    if (hash.code !== 0) {
      out.err(`Could not hash the MQTT password file: ${hash.stderr.trim().slice(0, 300)}`);
      return "failed";
    }
  } else out.info("Keeping the existing mosquitto/passwd file.");
  await writeDockerEnv(ctx);
  if (!ctx.repoRoot) {
    out.warn("Not running from a HomePanel checkout, so the server image can't be built locally.");
    out.info("Set HOMEPANEL_SRC in .env to a checkout of the repo before starting the homepanel service.");
  }

  out.info(`Wrote ${join(dir, "compose.yaml")}, mosquitto config and .env.`);
  out.info("Next: start Home Assistant and Mosquitto (HomePanel starts later, once it has a token):");
  const args = ["compose", "up", "-d", "homeassistant", "mosquitto"];
  out.code(`cd ${dir} && ${showCmd("docker", args)}`);
  if (!(await prompt.confirm({ message: "Start them now?", default: true }))) return "manual";
  const up = await exec("docker", args, { cwd: dir, inherit: true, timeoutMs: 15 * 60_000 });
  if (up.code !== 0) {
    out.err("docker compose failed (see above).");
    return "failed";
  }
  out.ok("Home Assistant and Mosquitto are starting.");
  ctx.store.update({ haOs: false, mqtt: { host: "127.0.0.1", port: 1883, username: "homepanel" } });
  await saveHaUrl(ctx, "http://127.0.0.1:8123");
  return "done";
}

/* ------------------------------------------------------------------ */
/* VirtualBox                                                           */
/* ------------------------------------------------------------------ */

export const VBOX_VM = "HomeAssistant";

export function vboxManagePath(): string {
  if (process.platform === "win32") {
    const base = process.env.VBOX_MSI_INSTALL_PATH || process.env.VBOX_INSTALL_PATH || "C:\\Program Files\\Oracle\\VirtualBox\\";
    return join(base, "VBoxManage.exe");
  }
  return "VBoxManage";
}

/** The exact VBoxManage commands that create the HA OS VM. */
export function vboxCommands(vdiPath: string, bridgeAdapter: string, vm = VBOX_VM): string[][] {
  return [
    ["createvm", "--name", vm, "--ostype", "Linux_64", "--register"],
    [
      "modifyvm", vm,
      "--firmware", "efi",
      "--memory", "4096",
      "--cpus", "2",
      "--nic1", "bridged",
      "--bridgeadapter1", bridgeAdapter,
      "--graphicscontroller", "vmsvga",
      "--usb-xhci", "on",
    ],
    ["storagectl", vm, "--name", "SATA", "--add", "sata", "--controller", "IntelAhci", "--portcount", "1"],
    ["storageattach", vm, "--storagectl", "SATA", "--port", "0", "--device", "0", "--type", "hdd", "--medium", vdiPath],
    ["startvm", vm, "--type", "headless"],
  ];
}

export async function downloadFile(fetchImpl: typeof fetch, url: string, dest: string, onProgress?: (pct: number) => void) {
  const res = await fetchImpl(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") || 0);
  let got = 0;
  let lastPct = -1;
  const src = Readable.fromWeb(res.body as any);
  src.on("data", (c: Buffer) => {
    got += c.length;
    if (total && onProgress) {
      const pct = Math.floor((got / total) * 100);
      if (pct !== lastPct && pct % 5 === 0) onProgress((lastPct = pct));
    }
  });
  await pipeline(src, createWriteStream(dest));
}

async function setupVbox(ctx: StepContext): Promise<"done" | "failed" | "manual"> {
  const { out, prompt, exec } = ctx;
  out.steps(VBOX_GUIDE());
  const vbm = vboxManagePath();
  const ver = await exec(vbm, ["--version"], { timeoutMs: 20_000 });
  if (ver.code !== 0) {
    out.warn("VBoxManage not found. Install VirtualBox first (virtualbox.org/wiki/Downloads), then re-run setup.");
    return "manual";
  }
  out.ok(`VirtualBox ${ver.stdout.trim()}`);

  const dir = join(homedir(), "HomeAssistantVM");
  mkdirSync(dir, { recursive: true });
  const zipName = HAOS_IMAGES.vdi.split("/").pop()!;
  const zipPath = join(dir, zipName);
  const vdiPath = join(dir, zipName.replace(/\.zip$/, ""));
  if (!existsSync(vdiPath)) {
    out.info(`Home Assistant OS ${HAOS_VERSION} VirtualBox disk: ${HAOS_IMAGES.vdi} (~500 MB download)`);
    if (!(await prompt.confirm({ message: `Download it to ${dir}?`, default: true }))) {
      out.info(`Download it yourself, unzip into ${dir}, then re-run setup.`);
      return "manual";
    }
    await downloadFile(ctx.fetchImpl, HAOS_IMAGES.vdi, zipPath, (p) => out.info(`downloaded ${p}%`));
    const unz = await exec("tar", ["-xf", zipPath, "-C", dir], { timeoutMs: 10 * 60_000 });
    if (unz.code !== 0 || !existsSync(vdiPath)) {
      const any = readdirSync(dir).find((f) => f.endsWith(".vdi"));
      if (!any) {
        out.err(`Could not unzip ${zipPath}. Unzip it manually into ${dir} and re-run.`);
        return "failed";
      }
      copyFileSync(join(dir, any), vdiPath);
    }
    out.ok(`Disk ready: ${vdiPath}`);
  }

  const bridges = await exec(vbm, ["list", "bridgedifs"], { timeoutMs: 20_000 });
  const names = [...bridges.stdout.matchAll(/^Name:\s+(.+)$/gm)].map((m) => m[1]!.trim());
  const adapter = names.length
    ? await prompt.select({
        message: "Which network adapter connects this PC to your router (wired is best)?",
        choices: names.map((n) => ({ value: n, name: n })),
      })
    : await prompt.input({ message: "Network adapter name for bridged networking:" });

  const cmds = vboxCommands(vdiPath, adapter);
  out.info("These commands create and start the VM:");
  out.code(cmds.map((c) => showCmd("VBoxManage", c)).join("\n"));
  if (!(await prompt.confirm({ message: "Run them now?", default: true }))) return "manual";
  for (const c of cmds) {
    const r = await exec(vbm, c, { timeoutMs: 120_000 });
    if (r.code !== 0) {
      if (c[0] === "createvm" && /already exists/i.test(r.stderr)) {
        out.warn(`A VM called ${VBOX_VM} already exists; using it.`);
        continue;
      }
      out.err(`VBoxManage ${c[0]} failed: ${r.stderr.trim().slice(0, 300)}`);
      return "failed";
    }
  }
  out.ok("VM started. Home Assistant needs 5–20 minutes on first boot.");
  out.info("Tip: VirtualBox → the VM → Settings → General → Advanced: nothing to change. To autostart with Windows, see docs/hardware/vm-windows.md.");
  return "done";
}

/* ------------------------------------------------------------------ */

export function printHostGuide(ctx: StepContext, t: HostType) {
  const { out } = ctx;
  if (t === "x86-bare-metal") {
    out.steps(X86_GUIDE());
    out.line();
    out.info("Writing the image from the Ubuntu live USB terminal (checks you picked the internal disk):");
    out.code(x86FlashScript());
  } else if (t === "raspberry-pi") out.steps(PI_GUIDE());
  else if (t === "ha-green") out.steps(GREEN_GUIDE());
  else if (t === "nas-proxmox") out.steps(PROXMOX_GUIDE());
  out.info(`Full guide: docs/${hostDoc(t)}`);
}

export const hostStep: Step = {
  id: "host",
  title: "Install Home Assistant",
  summary: "Pick what Home Assistant runs on and follow (or let the installer run) the install.",
  plan: (ctx) => {
    const t = ctx.store.state.hostType;
    if (t === "linux-docker")
      return "Check Docker Engine ≥ 23 (offer get.docker.com install), write compose.yaml + mosquitto config + .env into a folder you choose, hash the MQTT password and run `docker compose up -d homeassistant mosquitto`. Each command is shown and asked first.";
    if (t === "vm-windows")
      return `Download HA OS ${HAOS_VERSION} .vdi (asks first), then run VBoxManage createvm/modifyvm (EFI, 4 GB, 2 CPU, bridged NIC)/storageattach/startvm (shown and asked first).`;
    return "Print the install guide for your hardware. Nothing on this computer is changed.";
  },
  explain:
    "Home Assistant OS is the recommended install (it supports apps such as Mosquitto, Tailscale and HomePanel). " +
    "On a mini PC like the ACEMAGICIAN T8 Plus you wipe Windows and write the generic-x86-64 image to the internal " +
    "SSD from a Ubuntu live USB. Raspberry Pi uses Raspberry Pi Imager. HA Green ships ready. A Linux box can run HA " +
    "Container with Docker Engine (no apps; Docker Desktop is not supported). A Windows-only household can run HA OS in VirtualBox.",
  async detect(ctx) {
    const t = ctx.store.state.hostType;
    if (!t) return { done: false, detail: "Host type not chosen yet." };
    if (ctx.store.state.haUrl) {
      const ok = await new HaClient(ctx.store.state.haUrl, { fetchImpl: ctx.fetchImpl }).onboardingStatus();
      if (ok.state !== "unreachable") return { done: true, detail: `Host: ${t}; Home Assistant is answering.` };
    }
    return { done: false, detail: `Host: ${t}; Home Assistant not reachable yet.` };
  },
  async run(ctx) {
    const { out, prompt } = ctx;
    const t = await prompt.select<HostType>({
      message: "What will Home Assistant run on?",
      choices: HOST_TYPES.map((h) => ({ value: h.value, name: h.name, description: h.description })),
      default: ctx.store.state.hostType,
    });
    ctx.store.update({ hostType: t, haOs: t !== "linux-docker" });
    if (ctx.store.state.haUrl) {
      const s = await new HaClient(ctx.store.state.haUrl, { fetchImpl: ctx.fetchImpl }).onboardingStatus();
      if (s.state !== "unreachable") {
        out.ok(`Home Assistant is already running at ${ctx.store.state.haUrl} — nothing to install.`);
        return "done";
      }
    }
    if (t === "linux-docker") return setupDocker(ctx);
    if (t === "vm-windows") return setupVbox(ctx);
    printHostGuide(ctx, t);
    if (!ctx.store.state.haUrl) {
      const addr = await prompt.input({
        message: "When it's installed, what's its address? (Enter = homeassistant.local)",
        default: "homeassistant.local",
      });
      await saveHaUrl(ctx, addr);
    }
    return "manual";
  },
};

export const _test = { setupDocker };
