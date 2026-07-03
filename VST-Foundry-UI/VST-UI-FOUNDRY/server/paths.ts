import path from "path";
import fs from "fs";

// ===========================================================================
// Local data persistence — ./data/ tree
// ===========================================================================
// Central definition of the on-disk data tree so logging, persistence, and the
// route handlers all reference the same directories. The mkdir side effect runs
// once when this module is first imported (before any log write or config read).
export const DATA_DIR = path.join(process.cwd(), "data");
export const TEXTURES_DIR = path.join(DATA_DIR, "textures");
export const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
export const LOGS_DIR = path.join(DATA_DIR, "logs");
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const SESSION_PATH = path.join(SESSIONS_DIR, "latest.json");

[DATA_DIR, TEXTURES_DIR, SESSIONS_DIR, LOGS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});
