import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePowerModeSession, preparePowerMode } from "./prepare.ts";
import type { PreparedPowerMode } from "./prepare.ts";
import type { buildPowerModeFiles, PowerModeFiles } from "./bundle.ts";

export const POWER_MODE_USAGE = "npx tsx --tsconfig scripts/tsconfig.export.json scripts/export-powermode.mts --session <project.json> --textures <directory> --out <new-directory> [--name <name>]";
const POWER_MODE_HELP = [
  POWER_MODE_USAGE,
  "The bundle loader also uses scripts/tsconfig.export.json internally for the headless file-saver shim.",
  "All referenced textures must exist; missing textures abort before building or writing, without creating the output directory.",
].join("\n");

export interface PowerModeExportOptions {
  session: string;
  textures: string;
  out: string;
  name: string;
}

export interface PowerModeIO {
  readSession: (filename: string) => string;
  readTexture: (directory: string, filename: string) => Uint8Array | undefined;
  buildFiles: (prepared: PreparedPowerMode, originalSource: string, name: string) => Promise<PowerModeFiles>;
  writeFiles: (directory: string, files: PowerModeFiles) => void;
  log: (message: string) => void;
}

export function parseExportArgs(args: string[]): PowerModeExportOptions | null {
  if (args.length === 1 && args[0] === "--help") return null;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!["--session", "--textures", "--out", "--name"].includes(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (values.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    values.set(flag, value);
  }
  function required(flag: string): string {
    const value = values.get(flag);
    if (!value) throw new Error(`Required option: ${flag}. Usage: ${POWER_MODE_USAGE}`);
    return value;
  }
  return { session: required("--session"), textures: required("--textures"), out: required("--out"), name: values.get("--name") || "POWER MODE" };
}

export async function loadBundleBuilder(): Promise<typeof buildPowerModeFiles> {
  const { tsImport } = await import("tsx/esm/api");
  const loaded: typeof import("./bundle.ts") = await tsImport("./bundle.ts", {
    parentURL: import.meta.url,
    tsconfig: fileURLToPath(new URL("../tsconfig.export.json", import.meta.url)),
  });
  return loaded.buildPowerModeFiles;
}

const diskIO: PowerModeIO = {
  readSession: filename => fs.readFileSync(filename, "utf8"),
  readTexture: (directory, filename) => {
    try { return fs.readFileSync(path.join(directory, filename)); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  },
  buildFiles: async (prepared, originalSource, name) => (await loadBundleBuilder())(prepared, originalSource, name),
  writeFiles: (directory, files) => {
    const output = path.resolve(directory);
    for (const filename of Object.keys(files)) {
      if (path.basename(filename) !== filename) throw new Error("Invalid export filename.");
      if (fs.existsSync(path.join(output, filename))) throw new Error(`Export already exists: ${filename}. Choose a new --out directory.`);
    }
    fs.mkdirSync(output, { recursive: true });
    for (const [filename, content] of Object.entries(files)) fs.writeFileSync(path.join(output, filename), content, { flag: "wx" });
  },
  log: message => console.log(message),
};

export async function runPowerModeCli(args: string[], io: PowerModeIO = diskIO): Promise<void> {
  const options = parseExportArgs(args);
  if (!options) { io.log(POWER_MODE_HELP); return; }
  const originalSource = io.readSession(options.session);
  const session = parsePowerModeSession(originalSource);
  const prepared = preparePowerMode(session, filename => io.readTexture(options.textures, filename));
  if (prepared.missingTextures.length > 0) {
    throw new Error(`Missing required textures: ${prepared.missingTextures.join(", ")}. Export aborted before building or writing; supply these files in --textures and retry.`);
  }
  const files = await io.buildFiles(prepared, originalSource, options.name);
  io.writeFiles(options.out, files);
  io.log(`Wrote ${Object.keys(files).length} files; inlined textures: ${prepared.inlinedTextures}`);
}

export function isMainModule(moduleUrl: string, entryPath: string | undefined): boolean {
  return Boolean(entryPath) && path.resolve(entryPath!) === fileURLToPath(moduleUrl);
}
