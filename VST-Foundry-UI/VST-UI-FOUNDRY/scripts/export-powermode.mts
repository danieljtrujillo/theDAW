import { isMainModule, runPowerModeCli } from "./power-mode/cli.mts";

export { runPowerModeCli } from "./power-mode/cli.mts";

if (isMainModule(import.meta.url, process.argv[1])) {
  runPowerModeCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "POWER MODE export failed.");
    process.exitCode = 1;
  });
}
