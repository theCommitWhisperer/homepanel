import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { RouteContext } from "./context.js";

/**
 * Serves the Windows PC agent so a PC can be set up with one line in an admin PowerShell:
 *
 *     irm http://<server>:8080/agent/install.ps1 | iex
 *
 * /agent/install.ps1 is a small generated bootstrap: it downloads the real installer files from
 * /agent/files/* into %TEMP% and runs install.ps1 with -Server pointed at this host (the MQTT
 * broker runs on the same machine as HomePanel). The real installer still asks for the PC id,
 * MQTT login and key, exactly as when run by hand.
 */
export const AGENT_FILES = [
  "homepanel-agent.mjs",
  "install.ps1",
  "uninstall.ps1",
  "agent.example.yaml",
  "README.md",
  "scripts/audio-switch.ps1",
  "scripts/mic-mute.ps1",
] as const;

const TYPES: Record<string, string> = {
  ".ps1": "text/plain; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

/** Host the PC should use for MQTT: the host part of the URL it used to reach us. */
export function brokerHost(req: FastifyRequest): string {
  const host = String(req.headers.host ?? "").trim();
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(host) ?? /^([^:]+)(?::\d+)?$/.exec(host);
  const h = m?.[1] ?? "homeassistant.local";
  return /^[A-Za-z0-9.\-:]+$/.test(h) ? h : "homeassistant.local";
}

export function bootstrapScript(origin: string, server: string): string {
  const files = AGENT_FILES.map((f) => `'${f}'`).join(", ");
  return `# HomePanel PC agent bootstrap - downloads the installer from ${origin} and runs it.
# Run in an ADMINISTRATOR PowerShell:  irm ${origin}/agent/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Please run this in PowerShell opened with "Run as administrator".' -ForegroundColor Yellow
  return
}
$dir = Join-Path $env:TEMP 'homepanel-agent-setup'
New-Item -ItemType Directory -Force -Path (Join-Path $dir 'scripts') | Out-Null
foreach ($f in @(${files})) {
  Write-Host "Downloading $f"
  Invoke-WebRequest -UseBasicParsing -Uri ('${origin}/agent/files/' + $f) -OutFile (Join-Path $dir $f)
}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'install.ps1') -Server '${server}'
`;
}

export async function agentDownloadRoutes(app: FastifyInstance, ctx: RouteContext) {
  const dist = ctx.env.agentDist;
  const available = () => fs.existsSync(path.join(dist, "install.ps1"));

  app.get("/agent/install.ps1", async (req, reply) => {
    if (!available()) return reply.code(404).type("text/plain").send("Write-Host 'The PC agent is not built on this server (pnpm --filter @homepanel/agent build).'\n");
    const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
    const origin = `${proto}://${String(req.headers.host ?? "localhost:8080")}`.replace(/[^A-Za-z0-9:/.\-[\]]/g, "");
    return reply.type("text/plain; charset=utf-8").header("cache-control", "no-cache").send(bootstrapScript(origin, brokerHost(req)));
  });

  app.get<{ Params: { "*": string } }>("/agent/files/*", async (req, reply) => {
    const rel = req.params["*"];
    if (!(AGENT_FILES as readonly string[]).includes(rel)) return reply.code(404).send({ error: "not-found" });
    const file = path.join(dist, rel);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: "not-built" });
    return reply
      .type(TYPES[path.extname(file)] ?? "application/octet-stream")
      .header("cache-control", "no-cache")
      .send(fs.createReadStream(file));
  });
}
