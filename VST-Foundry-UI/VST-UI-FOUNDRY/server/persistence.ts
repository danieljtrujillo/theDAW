import fs from "fs";
import { CONFIG_PATH } from "./paths";
import { appendLog } from "./logging";

export interface SDInstanceConfig {
  execPath: string;
  port: number;
  autoStart: boolean;
  extraArgs: string;
  pythonPath: string; // optional override; auto-detected from venv if blank
}
export interface SDCfg {
  preferred: "a1111" | "comfyui";
  a1111: SDInstanceConfig;
  comfyui: SDInstanceConfig;
  modelLibraryDir: string;
  outputDir: string;
}
export interface AppCfg {
  sd: SDCfg;
}

export function defaultAppCfg(): AppCfg {
  return {
    sd: {
      preferred: "a1111",
      a1111: { execPath: "", port: 7860, autoStart: false, extraArgs: "--api", pythonPath: "" },
      comfyui: { execPath: "", port: 8188, autoStart: false, extraArgs: "", pythonPath: "" },
      modelLibraryDir: "",
      outputDir: "",
    },
  };
}
export function loadAppCfg(): AppCfg {
  if (!fs.existsSync(CONFIG_PATH)) return defaultAppCfg();
  try { return mergeAppCfg(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"))); }
  catch (e: any) {
    appendLog(`[Config] primary config file corrupt (${e?.message || e}) — attempting .bak recovery`);
  }
  const bak = CONFIG_PATH + ".bak";
  if (fs.existsSync(bak)) {
    try { return mergeAppCfg(JSON.parse(fs.readFileSync(bak, "utf-8"))); }
    catch (e: any) { appendLog(`[Config] backup config file also corrupt (${e?.message || e}) — using defaults`); }
  }
  return defaultAppCfg();
}
export function saveAppCfg(cfg: AppCfg): void {
  if (fs.existsSync(CONFIG_PATH)) {
    try { fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + ".bak"); } catch {}
  }
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf-8");
  fs.renameSync(tmp, CONFIG_PATH);
}
export function mergeAppCfg(incoming: any): AppCfg {
  const defaults = defaultAppCfg();
  return {
    sd: {
      ...defaults.sd,
      ...(incoming?.sd || {}),
      a1111: { ...defaults.sd.a1111, ...(incoming?.sd?.a1111 || {}) },
      comfyui: { ...defaults.sd.comfyui, ...(incoming?.sd?.comfyui || {}) },
    },
  };
}
