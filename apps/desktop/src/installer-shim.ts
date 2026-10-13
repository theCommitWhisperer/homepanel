/**
 * Bridge to the setup wizard (apps/installer). The installer owns
 * `apps/installer/src/main.ts` → `export async function main(argv: string[]): Promise<number>`.
 *
 * The bundler resolves `@homepanel/installer/main` to that file when it exists, otherwise to an
 * empty module, and `@homepanel/installer/cli` to the legacy self-running cli.ts only in that
 * second case (see scripts/bundle.mjs). argv is the installer's own argv, e.g. ["setup", "--plain"].
 */
type InstallerMain = (argv: string[]) => Promise<number>;

export async function runInstaller(argv: string[]): Promise<number> {
  let main: InstallerMain | undefined;
  try {
    // @ts-ignore resolved by the bundler (scripts/bundle.mjs)
    const mod = (await import("@homepanel/installer/main")) as { main?: InstallerMain };
    main = typeof mod.main === "function" ? mod.main : undefined;
  } catch {
    main = undefined;
  }
  if (main) return main(argv);

  // Fallback: the v0.1 cli.ts runs main(process.argv.slice(2)) on import and exits by itself.
  const legacy = argv[0] === "setup" && argv.some((a) => a === "--help" || a === "-h") ? ["--help"] : argv;
  process.argv = [process.argv[0]!, process.argv[1] ?? process.argv[0]!, ...legacy];
  // @ts-ignore resolved by the bundler (scripts/bundle.mjs)
  await import("@homepanel/installer/cli");
  return new Promise<number>(() => {
    /* cli.ts calls process.exit() */
  });
}
