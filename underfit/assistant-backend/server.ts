import express, { Response as ExpressResponse } from "express";
import path from "path";
import os from "os";
import fs from "fs";
import { spawn, ChildProcess, execSync, execFile } from "child_process";
import { randomUUID } from "crypto";
import { promises as dnsp } from "dns";
// (vite SPA serving removed — underfit's assistant backend is API-only)

// Exported so tests (supertest) can drive the configured app without listening.
export const app = express();
const PORT = Number(process.env.UNDERFIT_ASSISTANT_PORT || process.env.PORT || 5473);

// Parse large JSON bodies for state updates and screenshots
app.use(express.json({ limit: "50mb" }));

// ===========================================================================
// CORS origin allow-list — block drive-by cross-site requests (security)
// ===========================================================================
// The browser UI is served same-origin from this port. The Claude MCP relay
// (mcp-server.cjs) and other server-to-server callers send NO Origin header, so
// we allow no-Origin requests (never a cross-site browser attack) plus this
// app's own origin, and reject any other browser Origin. This closes the
// "any website you visit can drive localhost" hole WITHOUT touching the Claude
// provider — its relay reaches us only via no-Origin calls.
const ALLOWED_ORIGINS = new Set<string>([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  // underfit's dashboard (served on :8791) hosts the orb that calls this backend.
  "http://localhost:8791",
  "http://127.0.0.1:8791",
]);
for (const o of (process.env.FOUNDRY_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)) {
  ALLOWED_ORIGINS.add(o);
}
function isAllowedOrigin(origin?: string): boolean {
  // No Origin header = non-browser / same-origin navigation; not a CSRF vector.
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin);
}
// Echo the caller's own Origin (never "*") when allowed. Used by SSE handlers.
function setCorsOrigin(req: express.Request, res: ExpressResponse): void {
  const origin = req.headers.origin as string | undefined;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
}
// Full CORS header set for a middleware/route. Returns false if the browser
// Origin is disallowed (caller should respond 403).
function applyCors(req: express.Request, res: ExpressResponse): boolean {
  if (!isAllowedOrigin(req.headers.origin as string | undefined)) return false;
  setCorsOrigin(req, res);
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  return true;
}

// Conservative security response headers. Deliberately does NOT set script-src
// (would break Vite dev + Monaco) or frame-ancestors (would break Foundry's
// theDAW sidecar embedding) — CustomCode already runs in sandboxed iframes, so
// these low-risk directives add hardening without breaking anything.
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "object-src 'none'; base-uri 'self'");
  next();
});

// ===========================================================================
// Active session registry — MCP relay bridge
// ===========================================================================
//
// When the Claude Code CLI runs with the vst-foundry MCP server attached, that
// server calls back into THIS process to invoke browser-side tools. Every live
// SSE chat connection that may relay tools is registered here, keyed by the
// session id we also hand to the MCP server. The relay endpoints use it to
//   (a) push a `client_tool_call` frame to the correct browser, and
//   (b) resolve the matching pending promise when the browser returns a result.
interface PendingToolCall {
  resolve: (result: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface ActiveSession {
  sseRes: ExpressResponse;
  pending: Map<string, PendingToolCall>;
}
const activeSessions = new Map<string, ActiveSession>();

// Claude session ids THIS sidecar process has created (captured from the CLI's
// system/init session_id). The orb persists its claudeSessionId in the browser,
// so after a sidecar restart it sends an id the CLI no longer knows — passing
// that to --resume fails the entire turn with "No conversation found with
// session ID". We only --resume ids in this set; an unknown id falls back to a
// fresh full-history turn (which works) instead of erroring.
const knownClaudeSessions = new Set<string>();

// ===========================================================================
// Provider registry — model-agnostic multi-provider dispatch
// ===========================================================================
//
// 🚨 DO NOT downgrade or delete model ids you don't recognize. The user has
// working keys for Gemini 3.x, Claude 4.x/5.x, GPT-5 variants, etc. The live
// /models fetch is the source of truth; the hard-coded fallbacks below are
// safety nets only. Add speculative models freely; never remove real ones.

interface ProviderConfig {
  label: string;
  baseUrl: string;
  envKey: string | null;
  modelsPath: string | null;
  defaultModel: string;
  requiresKey: boolean;
  isLocal: boolean;
}

// ===========================================================================
// Local data persistence — ./data/ tree
// ===========================================================================
const DATA_DIR = path.join(process.cwd(), "data");
const TEXTURES_DIR = path.join(DATA_DIR, "textures");
const GENERATED_DIR = path.join(DATA_DIR, "generated");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const LOGS_DIR = path.join(DATA_DIR, "logs");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const SESSION_PATH = path.join(SESSIONS_DIR, "latest.json");

[DATA_DIR, TEXTURES_DIR, GENERATED_DIR, SESSIONS_DIR, LOGS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

interface SDInstanceConfig {
  execPath: string;
  port: number;
  autoStart: boolean;
  extraArgs: string;
  pythonPath: string; // optional override; auto-detected from venv if blank
}
interface SDCfg {
  preferred: "a1111" | "comfyui";
  a1111: SDInstanceConfig;
  comfyui: SDInstanceConfig;
  modelLibraryDir: string;
  outputDir: string;
}
interface AppCfg {
  sd: SDCfg;
}

function defaultAppCfg(): AppCfg {
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
function loadAppCfg(): AppCfg {
  if (!fs.existsSync(CONFIG_PATH)) return defaultAppCfg();
  try { return mergeAppCfg(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"))); }
  catch { return defaultAppCfg(); }
}
function saveAppCfg(cfg: AppCfg): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}
function mergeAppCfg(incoming: any): AppCfg {
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

// ===========================================================================
// SD Process Manager
// ===========================================================================

// Resolve the Python interpreter for a .py script.
// Priority: explicit override → sibling venv (Stability Matrix / standard venv) → system python.
function resolveSDPython(scriptPath: string, override?: string): string {
  if (override) {
    if (fs.existsSync(override)) return override;
    appendLog(`[SD] Warning: configured pythonPath "${override}" does not exist — falling back to auto-detection`);
  }
  const dir = path.dirname(scriptPath);
  const candidates = [
    path.join(dir, "venv", "Scripts", "python.exe"),   // Windows — SM / standard venv
    path.join(dir, "venv", "Scripts", "python3.exe"),  // Windows alt
    path.join(dir, "venv", "bin", "python"),            // Linux / Mac
    path.join(dir, "Python", "python.exe"),             // SM embedded Python (some builds)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "python"; // system fallback
}
interface SDProcess {
  type: "a1111" | "comfyui";
  proc: ChildProcess;
  port: number;
  startedAt: number;
}
let sdProcess: SDProcess | null = null;

function startSDProcess(
  sdType: "a1111" | "comfyui",
  cfg: AppCfg
): { success: boolean; message: string } {
  if (sdProcess) {
    return { success: false, message: `SD (${sdProcess.type}) already running on port ${sdProcess.port}` };
  }
  const sdCfg = cfg.sd[sdType];
  if (!sdCfg.execPath) {
    return { success: false, message: `No ${sdType} executable path configured in settings` };
  }
  const port = sdCfg.port || (sdType === "a1111" ? 7860 : 8188);
  const extraArgs = sdCfg.extraArgs.split(" ").filter(Boolean);
  const modelDir = cfg.sd.modelLibraryDir;
  const outputDir = cfg.sd.outputDir;

  let spawnCmd: string;
  let spawnArgs: string[];
  let cwd: string | undefined;

  const isWindows = process.platform === "win32";
  const isBatchFile = /\.(bat|cmd)$/i.test(sdCfg.execPath);

  if (sdCfg.execPath.endsWith(".py")) {
    spawnCmd = resolveSDPython(sdCfg.execPath, sdCfg.pythonPath || undefined);
    spawnArgs = [sdCfg.execPath];
    cwd = path.dirname(sdCfg.execPath);
  } else if (isWindows && isBatchFile) {
    spawnCmd = "cmd.exe";
    spawnArgs = ["/c", sdCfg.execPath];
    cwd = path.dirname(sdCfg.execPath);
  } else {
    spawnCmd = sdCfg.execPath;
    spawnArgs = [];
    cwd = path.dirname(sdCfg.execPath);
  }

  const spawnOpts: any = { env: process.env, cwd, stdio: ["ignore", "ignore", "pipe"], detached: false };

  if (sdType === "a1111") {
    spawnArgs.push(...extraArgs, "--port", String(port));
    if (modelDir) spawnArgs.push("--ckpt-dir", modelDir);
    if (outputDir) spawnArgs.push("--outdir-txt2img-samples", outputDir);
  } else {
    spawnArgs.push("--port", String(port), ...extraArgs);
  }

  const proc = spawn(spawnCmd, spawnArgs, spawnOpts);

  sdProcess = { type: sdType, proc, port, startedAt: Date.now() };
  proc.on("close", () => { if (sdProcess?.proc === proc) sdProcess = null; });
  proc.on("error", (err) => {
    appendLog(`[SD:${sdType}] spawn error: ${err.message}`);
    if (sdProcess?.proc === proc) sdProcess = null;
  });
  proc.stderr?.on("data", (d: Buffer) => {
    const line = d.toString().trim();
    if (line) appendLog(`[SD:${sdType}] ${line}`);
  });

  return { success: true, message: `${sdType} launching on port ${port}...` };
}

function stopSDProcess(): { success: boolean; message: string } {
  if (!sdProcess) return { success: false, message: "No SD process is running" };
  killProc(sdProcess.proc);
  sdProcess = null;
  return { success: true, message: "SD process stopped" };
}

// Ensure SD is killed when server exits. These signal handlers only tear down
// the SD child process; the orderly process exit is handled by the graceful
// shutdown() handlers registered later, so they must NOT call process.exit here
// (doing so would pre-empt the graceful HTTP server shutdown).
process.on("exit", () => {
  if (!sdProcess) return;
  // "exit" runs synchronously — async taskkill won't execute. Use sync kill as safety net.
  try {
    if (process.platform === "win32" && sdProcess.proc.pid) {
      execSync(`taskkill /PID ${sdProcess.proc.pid} /T /F`, { stdio: "ignore" });
    } else {
      sdProcess.proc.kill("SIGKILL");
    }
  } catch {}
});

// ===========================================================================
// App logging helper
// ===========================================================================
const LOG_PATH = path.join(LOGS_DIR, "app.log");
const LOG_RING_SIZE = 500;
const logRing: string[] = [];

function appendLog(line: string): void {
  const entry = `[${new Date().toISOString()}] ${line}`;
  logRing.push(entry);
  if (logRing.length > LOG_RING_SIZE) logRing.shift();
  try { fs.appendFileSync(LOG_PATH, entry + "\n", "utf-8"); } catch {}
}

function getRecentLogs(n = 100): string[] {
  return logRing.slice(-Math.min(n, LOG_RING_SIZE));
}

// ===========================================================================
// ComfyUI workflow builder (simple txt2img template)
// ===========================================================================
const COMFY_SAMPLER_MAP: Record<string, string> = {
  "euler a": "euler_ancestral",
  "euler ancestral": "euler_ancestral",
  "dpm++ 2m": "dpmpp_2m",
  "dpm++ sde": "dpmpp_sde",
  "dpm++ 2m sde": "dpmpp_2m_sde",
  "dpm++ 3m sde": "dpmpp_3m_sde",
  "dpm2 a": "dpm_2_ancestral",
  "dpm2": "dpm_2",
  "lms": "lms",
  "heun": "heun",
  "ddim": "ddim",
  "plms": "plms",
  "uni pc": "uni_pc",
  "lcm": "lcm",
  "dpm++ 2m karras": "dpmpp_2m",      // scheduler="karras" handles the Karras part
  "dpm++ sde karras": "dpmpp_sde",
  "dpm++ 2m sde karras": "dpmpp_2m_sde",
  "dpm++ 3m sde karras": "dpmpp_3m_sde",
  "dpm++ 2s a karras": "dpmpp_2s_ancestral",
  "dpm++ 2s ancestral": "dpmpp_2s_ancestral",
  "restart": "restart",
};
function resolveComfySampler(sampler?: string): string {
  if (!sampler) return "euler";
  const key = sampler.toLowerCase().trim();
  const VALID_COMFY_SAMPLERS = new Set(["euler","euler_ancestral","heun","dpm_2","dpm_2_ancestral","lms","dpmpp_2s_ancestral","dpmpp_sde","dpmpp_2m","dpmpp_2m_sde","dpmpp_3m_sde","ddim","plms","uni_pc","lcm","restart","dpmpp_fast","dpmpp_adaptive"]);
  const mapped = COMFY_SAMPLER_MAP[key] ?? key.replace(/\s+/g, "_");
  return VALID_COMFY_SAMPLERS.has(mapped) ? mapped : "euler";
}
function resolveComfyScheduler(sampler?: string): string {
  if (!sampler) return "normal";
  const lower = sampler.toLowerCase();
  if (lower.includes("karras")) return "karras";
  if (lower.includes("exponential")) return "exponential";
  if (lower.includes("sgm")) return "sgm_uniform";
  return "normal";
}
function buildComfyWorkflow(params: {
  prompt: string; negativePrompt?: string; model?: string; width?: number;
  height?: number; steps?: number; cfgScale?: number; sampler?: string;
  seed?: number; batchCount?: number;
}): any {
  const seed = params.seed !== undefined && params.seed !== -1
    ? params.seed : Math.floor(Math.random() * 999999999);
  return {
    "3": { class_type: "KSampler", inputs: {
      seed, steps: params.steps || 20, cfg: params.cfgScale || 7,
      sampler_name: resolveComfySampler(params.sampler),
      scheduler: resolveComfyScheduler(params.sampler), denoise: 1,
      model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0],
    }},
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: params.model || "v1-5-pruned-emaonly.safetensors" }},
    "5": { class_type: "EmptyLatentImage", inputs: {
      width: params.width || 512, height: params.height || 512, batch_size: params.batchCount || 1,
    }},
    "6": { class_type: "CLIPTextEncode", inputs: { text: params.prompt, clip: ["4", 1] }},
    "7": { class_type: "CLIPTextEncode", inputs: { text: params.negativePrompt || "", clip: ["4", 1] }},
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] }},
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "vst-foundry", images: ["8", 0] }},
  };
}

// ===========================================================================
// Generation helpers
// ===========================================================================
interface GenParams {
  provider: string; sdType?: string; prompt: string; negativePrompt?: string;
  width?: number; height?: number; steps?: number; cfgScale?: number;
  sampler?: string; seed?: number; model?: string; vae?: string;
  loras?: Array<{ name: string; weight: number }>; batchCount?: number; nIter?: number;
  count?: number; imageSize?: string; quality?: string; style?: string; apiKey?: string;
}

async function generateViaA1111(params: GenParams, cfg: AppCfg): Promise<string[]> {
  const port = cfg.sd.a1111.port || 7860;
  appendLog(`[A1111] generate | prompt="${params.prompt.slice(0, 80)}" steps=${params.steps ?? 20} cfg=${params.cfgScale ?? 7} size=${params.width ?? 512}x${params.height ?? 512} batch=${params.batchCount ?? 1} iter=${params.nIter ?? 1} model=${params.model || "current"}`);
  let prompt = params.prompt;
  if (params.loras?.length) {
    prompt += " " + params.loras.map((l) => `<lora:${l.name}:${l.weight}>`).join(" ");
  }
  const body: any = {
    prompt, negative_prompt: params.negativePrompt || "",
    width: params.width || 512, height: params.height || 512,
    steps: params.steps || 20, cfg_scale: params.cfgScale || 7,
    sampler_name: params.sampler || "Euler a",
    batch_size: params.batchCount || 1,
    n_iter: params.nIter || 1,
    seed: params.seed !== undefined ? params.seed : -1,
  };
  if (params.model || params.vae) {
    body.override_settings = {};
    if (params.model) body.override_settings.sd_model_checkpoint = params.model;
    if (params.vae) body.override_settings.sd_vae = params.vae;
  }
  const ac = new AbortController();
  const timeoutMs = 10 * 60 * 1000; // 10 min — large batches + model switches can be slow
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch(`http://localhost:${port}/sdapi/v1/txt2img`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!resp.ok) throw new Error(`A1111 ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const data: any = await resp.json();
    return data.images || [];
  } catch (err: any) {
    if (err?.name === "AbortError") throw new Error("A1111 generation timed out after 10 minutes");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function generateViaComfyUI(params: GenParams, cfg: AppCfg): Promise<string[]> {
  if (!params.model) {
    throw new Error("ComfyUI requires a checkpoint model. Select one in the Advanced settings.");
  }
  appendLog(`[ComfyUI] generate | prompt="${params.prompt.slice(0, 80)}" model=${params.model} steps=${params.steps ?? 20} size=${params.width ?? 512}x${params.height ?? 512} sampler=${params.sampler || "default"}`);
  const port = cfg.sd.comfyui.port || 8188;
  const clientId = randomUUID();
  const workflow = buildComfyWorkflow({ ...params, batchCount: params.batchCount || 1 });

  const FETCH_TIMEOUT = 15_000;
  const fetchWithTimeout = async (url: string, init?: RequestInit) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
    try { return await fetch(url, { ...(init || {}), signal: ac.signal }); }
    finally { clearTimeout(t); }
  };

  const submitResp = await fetchWithTimeout(`http://localhost:${port}/prompt`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  });
  if (!submitResp.ok) throw new Error(`ComfyUI ${submitResp.status}: ${(await submitResp.text()).slice(0, 300)}`);
  const submitData: any = await submitResp.json();
  const promptId: string | undefined = submitData?.prompt_id;
  if (!promptId) {
    const detail = submitData?.error || submitData?.node_errors ? JSON.stringify(submitData).slice(0, 400) : "no prompt_id";
    throw new Error(`ComfyUI rejected workflow: ${detail}`);
  }

  const deadline = Date.now() + 5 * 60 * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2500));
    let histResp: Response;
    try { histResp = await fetchWithTimeout(`http://localhost:${port}/history/${promptId}`); }
    catch { continue; }
    if (!histResp.ok) continue;
    const history: any = await histResp.json();
    const entry = history[promptId];
    if (!entry) continue;
    // Detect execution error reported in status
    if (entry.status?.status_str === "error" || entry.status?.completed === false) {
      const msgs = entry.status?.messages?.map((m: any) => m[1]).join("; ") || "unknown error";
      throw new Error(`ComfyUI execution failed: ${msgs}`);
    }
    if (!entry.outputs) continue;
    const images: string[] = [];
    for (const nodeId of Object.keys(entry.outputs)) {
      for (const img of (entry.outputs[nodeId].images || [])) {
        const url = `http://localhost:${port}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || "")}&type=${img.type || "output"}`;
        try {
          const imgResp = await fetchWithTimeout(url);
          if (imgResp.ok) {
            const buf = Buffer.from(await imgResp.arrayBuffer());
            images.push(buf.toString("base64"));
          }
        } catch { /* skip unreadable image */ }
      }
    }
    if (images.length > 0) return images;
    throw new Error("ComfyUI generation completed but all image downloads failed");
  }
  throw new Error("ComfyUI generation timed out after 5 minutes");
}

async function generateViaDallE(params: GenParams): Promise<string[]> {
  const key = params.apiKey || process.env.OPENAI_API_KEY || "";
  if (!key) throw new Error("OpenAI API key required");
  const model = params.model || "dall-e-3";
  appendLog(`[DALL-E] generate | model=${model} prompt="${params.prompt.slice(0, 80)}" size=${params.imageSize || "1024x1024"} count=${params.count || params.batchCount || 1}`);
  const count = Math.min(params.count || params.batchCount || 1, 4);
  const isDalle3 = model.includes("dall-e-3");
  const body: any = {
    model, prompt: params.prompt,
    n: isDalle3 ? 1 : count,
    size: params.imageSize || "1024x1024",
    ...(isDalle3 || model.includes("dall-e-2") ? { response_format: "b64_json" } : {}),
  };
  if (params.quality && !model.includes("gpt-image")) body.quality = params.quality;
  if (params.style && !model.includes("gpt-image")) body.style = params.style;
  const calls = isDalle3 ? count : 1;
  const images: string[] = [];
  for (let i = 0; i < calls; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5 * 60 * 1000);
    try {
      const resp = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!resp.ok) throw new Error(`DALL-E ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
      const data: any = await resp.json();
      images.push(...(data.data || []).map((d: any) => d.b64_json).filter(Boolean));
    } catch (err: any) {
      if (err?.name === "AbortError") throw new Error("DALL-E generation timed out after 5 minutes");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  return images;
}

async function generateViaGemini(params: GenParams): Promise<string[]> {
  if (params.width || params.height) {
    appendLog(`[Gemini] Note: width/height params are not supported by Imagen and are ignored`);
  }
  const key = params.apiKey || process.env.GEMINI_API_KEY || "";
  if (!key) throw new Error("Gemini API key required");
  const model = params.model || "imagen-3.0-generate-002";
  appendLog(`[Gemini] generate | model=${model} prompt="${params.prompt.slice(0, 80)}" count=${Math.min(params.count || params.batchCount || 1, 4)}`);
  const count = Math.min(params.count || params.batchCount || 1, 4);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${encodeURIComponent(key)}`;
  const body = {
    instances: [{ prompt: params.prompt }],
    parameters: { sampleCount: count },
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5 * 60 * 1000);
  try {
    const resp = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!resp.ok) throw new Error(`Gemini Imagen ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const data: any = await resp.json();
    return (data.predictions || [])
      .map((p: any) => p.bytesBase64Encoded || p.image?.imageBytes)
      .filter(Boolean);
  } catch (err: any) {
    if (err?.name === "AbortError") throw new Error("Gemini generation timed out after 5 minutes");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function saveImagesToFiles(
  images: string[],
  params: GenParams
): Promise<Array<{ id: string; name: string; url: string; prompt: string; provider: string; createdAt: number; isGenerated: boolean }>> {
  const now = Date.now();
  const results = [];
  for (let i = 0; i < images.length; i++) {
    const id = randomUUID();
    const filename = `${id}.png`;
    let raw = images[i];
    if (!raw) continue; // skip falsy entries
    if (raw.includes(",")) raw = raw.split(",")[1]; // strip data-URI prefix
    if (!raw) continue;
    const buf = Buffer.from(raw, "base64");
    try {
      fs.writeFileSync(path.join(TEXTURES_DIR, filename), buf);
    } catch (writeErr: any) {
      appendLog(`[ERROR] Failed to write generated image ${filename}: ${writeErr.message}`);
      continue;
    }
    results.push({
      id, filename,
      name: `Gen ${i + 1} (${params.provider})`,
      url: `/textures/${filename}`,
      prompt: params.prompt,
      provider: params.provider,
      createdAt: now,
      isGenerated: true,
    });
  }
  appendLog(`Generated ${images.length} images via ${params.provider}: ${params.prompt.slice(0, 60)}`);
  return results;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  gemini: {
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    envKey: "GEMINI_API_KEY",
    modelsPath: null, // uses google-specific /v1beta/models endpoint
    defaultModel: "gemini-2.5-flash",
    requiresKey: true,
    isLocal: false,
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com",
    envKey: "OPENAI_API_KEY",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4.1-mini",
    requiresKey: true,
    isLocal: false,
  },
  anthropic: {
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    envKey: "ANTHROPIC_API_KEY",
    modelsPath: "/v1/models",
    defaultModel: "claude-sonnet-5",
    requiresKey: true,
    isLocal: false,
  },
  grok: {
    label: "xAI Grok",
    baseUrl: "https://api.x.ai",
    envKey: "XAI_API_KEY",
    modelsPath: "/v1/models",
    defaultModel: "grok-3-mini-fast",
    requiresKey: true,
    isLocal: false,
  },
  groq: {
    label: "Groq",
    baseUrl: "https://api.groq.com/openai",
    envKey: "GROQ_API_KEY",
    modelsPath: "/v1/models",
    defaultModel: "llama-3.3-70b-versatile",
    requiresKey: true,
    isLocal: false,
  },
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api",
    envKey: "OPENROUTER_API_KEY",
    modelsPath: "/v1/models",
    defaultModel: "google/gemma-3-1b-it:free",
    requiresKey: true,
    isLocal: false,
  },
  "openrouter-free": {
    label: "OpenRouter (Free)",
    baseUrl: "https://openrouter.ai/api",
    envKey: "OPENROUTER_API_KEY",
    modelsPath: "/v1/models",
    defaultModel: "google/gemma-3-1b-it:free",
    requiresKey: false,
    isLocal: false,
  },
  ollama: {
    label: "Ollama (Local)",
    baseUrl: "http://localhost:11434",
    envKey: null,
    modelsPath: null, // uses /api/tags
    defaultModel: "",
    requiresKey: false,
    isLocal: true,
  },
  lmstudio: {
    label: "LM Studio (Local)",
    baseUrl: "http://localhost:1234",
    envKey: null,
    modelsPath: "/v1/models",
    defaultModel: "",
    requiresKey: false,
    isLocal: true,
  },
};
// NOTE: `claude` (Claude Code CLI) is intentionally NOT in PROVIDERS — it is
// special-cased in the routes because it spawns a local CLI process.

const GEMINI_FALLBACK_MODELS = [
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)", capabilities: ["chat", "tools", "vision"] },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", capabilities: ["chat", "tools", "vision"] },
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash (Preview)", capabilities: ["chat", "tools", "vision"] },
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", capabilities: ["chat", "tools", "vision"] },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", capabilities: ["chat", "tools", "vision"] },
];

const GEMINI_MODEL_ALIASES: Record<string, string> = {
  "gemini 3.1 pro": "gemini-3.1-pro-preview",
  "gemini pro 3.1": "gemini-3.1-pro-preview",
  "gemini 3.1 pro preview": "gemini-3.1-pro-preview",
  "gemini 3.1 pro (preview)": "gemini-3.1-pro-preview",
};

function normalizeModelIdForProvider(provider: string, model: string): string {
  const trimmed = model.trim().replace(/^models\//, "");
  if (provider !== "gemini") return trimmed;
  const aliasKey = trimmed.toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ");
  return GEMINI_MODEL_ALIASES[aliasKey] || trimmed;
}

// ===========================================================================
// Claude Code constants
// ===========================================================================

const CLAUDE_DEFAULT_MODEL = "claude-opus-4-8";
const CLAUDE_DEFAULT_EFFORT = "max";
const CLAUDE_VALID_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// REMOVED: --max-turns. The installed claude CLI (v2.1.195) has NO --max-turns
// flag (verified via `claude --help`); passing it was silently ignored. The
// modern CLI runs an agentic turn to completion on its own — the required
// behavior (the agent takes as many turns/actions as a complex task needs).
// Kept commented for provenance; do NOT reintroduce a turn cap.
// const CLAUDE_MAX_TURNS = 25;

// Shared MCP/browser tool-relay timeout. A single source of truth so the Claude
// MCP relay (/api/mcp-relay/call), the direct-API agentic loop
// (awaitBrowserToolResult), and the stdio relay child (mcp-server.cjs) all wait
// the SAME amount of time for a browser tool result. Raised from the old 30s on
// the Claude relay so a slow canvas op (large reads / screenshots) does not time
// out mid-turn. Keep mcp-server.cjs:RELAY_TIMEOUT_MS aligned to this value.
const RELAY_TIMEOUT_MS = 120_000;

// Server-side waiter timeout for /api/mcp-relay/call. Kept STRICTLY below the
// client socket timeout (mcp-server.cjs RELAY_TIMEOUT_MS = 120000) so the server
// resolves+responds first on a true non-response. If they were equal, the client
// could destroy the socket the same instant the server fires its timer, and the
// bare setTimeout would then call res.json() on a destroyed socket -> uncaught
// ERR_STREAM_DESTROYED. The waiter responses are also guarded against a
// writableEnded socket (see the route below).
const RELAY_SERVER_TIMEOUT_MS = 115_000;

// Full model ids passed EXACTLY to `--model` (incl. the `[1m]` 1M-context
// variants the CLI binary accepts). CLI aliases ("opus"/"sonnet") are NOT
// reliable on this machine ("sonnet" fell back to a stale default and 404'd),
// so we enumerate full ids. Newest-first WITHIN each family so
// resolveClaudeModel's family fallback maps a stale/alias value to the latest
// non-1m full id. Fable 5 (claude-fable-5) is CURRENT (July 2026) — the old
// Fable was discontinued; Fable 5 supersedes it. Sonnet 5 is the newest Sonnet
// (claude-sonnet-5). Never write ids from memory (training is stale; see the
// repo HARD RULE on model catalogs).
const CLAUDE_MODELS = [
  // Current
  { id: "claude-fable-5",    label: "Claude Fable 5" },
  { id: "claude-sonnet-5",   label: "Claude Sonnet 5" },
  { id: "claude-opus-4-8",   label: "Claude Opus 4.8" },
  { id: "claude-opus-4-7",   label: "Claude Opus 4.7" },
  { id: "claude-opus-4-6",   label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-5",  label: "Claude Haiku 4.5" },
  // 1M context (CLI accepts the [1m] suffix)
  { id: "claude-sonnet-5[1m]",   label: "Claude Sonnet 5 (1M context)" },
  { id: "claude-opus-4-8[1m]",   label: "Claude Opus 4.8 (1M context)" },
  { id: "claude-opus-4-7[1m]",   label: "Claude Opus 4.7 (1M context)" },
  { id: "claude-opus-4-6[1m]",   label: "Claude Opus 4.6 (1M context)" },
  { id: "claude-sonnet-4-6[1m]", label: "Claude Sonnet 4.6 (1M context)" },
];

function fetchClaudeModels() { return Promise.resolve(CLAUDE_MODELS); }

// ===========================================================================
// Frame protocol types
// ===========================================================================

interface Frame {
  type: string;
  [key: string]: any;
}

interface ChatMessage {
  role: string;
  content: any;
}

interface StreamArgs {
  messages: ChatMessage[];
  provider?: string;
  model?: string;
  apiKey?: string;
  claudeSessionId?: string;
  effort?: string;
  claudeMode?: string;
  appState?: any;
  screenshot?: string;
  signal?: AbortSignal;
  // Live SSE response — only supplied for the Claude Code path so streamClaude
  // can register the session for MCP tool relay.
  sseRes?: ExpressResponse;
  // Relay session id for the direct-API agentic loop (OpenAI-compat + Anthropic).
  // The chat route registers this id in `activeSessions` and emits it as a
  // `session_id` frame so the browser can POST tool results back to
  // /api/mcp-relay/result, which resolves the matching pending promise and lets
  // the stream loop continue with the tool output.
  toolSessionId?: string;
}

// ===========================================================================
// Helpers — Claude CLI discovery / process management
// ===========================================================================

function findClaudeCmd(): string {
  const envOverride = (process.env.CLAUDE_CMD || "").trim();
  if (envOverride && fs.existsSync(envOverride)) return envOverride;
  if (envOverride) return envOverride;
  if (process.platform === "win32") {
    const npmPath = path.join(process.env.APPDATA || "", "npm", "claude.cmd");
    if (fs.existsSync(npmPath)) return npmPath;
    return "claude.cmd";
  }
  return "claude";
}

const CLAUDE_CMD = findClaudeCmd();
const PROJECT_CWD = process.cwd();

// Platform-conditional spawn of the `claude` CLI. On Windows the CLI is a .cmd
// shim, so it must run via `cmd.exe /c`; elsewhere it is invoked directly.
function spawnClaudeCli(args: string[], opts?: { cwd?: string }): ChildProcess {
  const spawnOpts: any = {
    ...(opts?.cwd ? { cwd: opts.cwd } : {}),
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  };
  return process.platform === "win32"
    ? spawn("cmd.exe", ["/c", CLAUDE_CMD, ...args], spawnOpts)
    : spawn(CLAUDE_CMD, args, spawnOpts);
}

function killProc(proc: ChildProcess): void {
  try {
    proc.stdin?.end();
  } catch {}
  try {
    if (process.platform === "win32" && proc.pid) {
      const tk = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"]);
      tk.on("error", () => {}); // taskkill is always present on Windows; swallow for safety
    } else {
      proc.kill("SIGTERM");
    }
  } catch {}
}

// Normalize the requested model to a full id the CLI accepts (matches
// better-claude-code, which passes full ids like "claude-sonnet-4-6" to
// --model). CLI aliases ("opus"/"sonnet") are unreliable here — "sonnet" fell
// back to a stale default and 404'd. So: pass through ids in our shipped list,
// map any family alias ("sonnet") or stale pinned id ("claude-opus-4-1-...") to
// the newest full id in that family, and fall back to the default otherwise.
// Last line before --model, so the CLI never receives a dead model id.
function resolveClaudeModel(model?: string): string {
  const m = (model || "").trim();
  if (!m || m.startsWith("claude-code-")) return CLAUDE_DEFAULT_MODEL;
  const ids = CLAUDE_MODELS.map((x) => x.id);
  if (ids.includes(m)) return m;
  const fam = /(?:^|claude-)(opus|sonnet|haiku)/i.exec(m)?.[1]?.toLowerCase();
  if (fam) {
    const match = ids.find((id) => id.startsWith(`claude-${fam}`));
    if (match) return match;
  }
  return CLAUDE_DEFAULT_MODEL;
}

function resolveClaudeEffort(effort?: string): string {
  const e = (effort || CLAUDE_DEFAULT_EFFORT).trim().toLowerCase();
  return CLAUDE_VALID_EFFORTS.includes(e) ? e : CLAUDE_DEFAULT_EFFORT;
}

function isUuidLike(id?: string): boolean {
  return !!id && /^[a-fA-F0-9-]{8,64}$/.test(id);
}

// ===========================================================================
// Helpers — provider key / URL resolution
// ===========================================================================

function getApiKey(providerId: string, requestKey?: string): string {
  if (requestKey) return requestKey;
  const cfg = PROVIDERS[providerId];
  if (cfg?.envKey) return process.env[cfg.envKey] || "";
  return "";
}

function getChatUrl(providerId: string): string {
  const cfg = PROVIDERS[providerId];
  if (!cfg) return "";
  const base = cfg.baseUrl.replace(/\/$/, "");
  // Gemini's base already ends with /v1beta/openai — append /chat/completions.
  if (providerId === "gemini") return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

// ===========================================================================
// Server-side webpage scraper / reader tool
// ===========================================================================

// SSRF guard: only http/https, and refuse hosts that resolve to loopback,
// private, link-local (incl. cloud metadata 169.254.169.254), CGNAT, or
// reserved IPs. Applies to fetchWebPage on both the direct-API and Claude
// paths (shared helper — does not alter the Claude provider itself).
function isPrivateIp(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/i, "");
  const m = v4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const low = ip.toLowerCase();
  if (low === "::1" || low === "::") return true;
  if (low.startsWith("fe80") || low.startsWith("fc") || low.startsWith("fd")) return true;
  return false;
}
async function assertPublicUrl(urlStr: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error("Invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Blocked non-http(s) URL scheme: ${u.protocol}`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0") {
    throw new Error("Blocked request to a local address");
  }
  const isLiteralIp = /^[0-9.]+$/.test(host) || host.includes(":");
  const addrs = isLiteralIp
    ? [host]
    : (await dnsp.lookup(host, { all: true })).map((a) => a.address);
  for (const ip of addrs) {
    if (isPrivateIp(ip)) throw new Error("Blocked request to a private/internal address");
  }
}

async function scrapeUrl(urlStr: string): Promise<string> {
  try {
    await assertPublicUrl(urlStr);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(urlStr, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      return `Failed to load web page: HTTP ${res.status} ${res.statusText}`;
    }

    const html = await res.text();
    const text = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 15000);

    return text || "The web page loaded successfully, but had no readable text content.";
  } catch (err: any) {
    return `Error reading URL: ${err.message || err}`;
  }
}

// ===========================================================================
// Tool definitions (OpenAI function-calling format)
// Ported from the original Gemini Type.* declarations.
// ===========================================================================

// Underfit LoRA-training tools (OpenAI function-calling format). These mirror
// underfit's MCP server (mcp-server.cjs) 1:1 and are executed SERVER-SIDE by
// dispatchToolCall against the underfit dashboard control plane on :8791, so
// EVERY direct-API provider drives underfit through the exact same 21 tools the
// Better Claude Code / Claude MCP path already uses.
const OPENAI_TOOLS = [
  // ------------------------------ RUNS -----------------------------------
  {
    type: "function",
    function: {
      name: "list_runs",
      description: "List all training runs (id, status, base_model, max_steps, dataset).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_run_status",
      description: "Live progress + metrics + log tail for a run. Omit run_id for the active run.",
      parameters: {
        type: "object",
        properties: { run_id: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "launch_finetune",
      description: 'Launch a new LoRA finetune (POST /api/runs/new). Mirrors the dashboard "New Finetune" form.',
      parameters: {
        type: "object",
        required: ["name", "base_model", "dataset_id"],
        properties: {
          name: { type: "string", description: "Run name (slugified)." },
          base_model: {
            type: "string",
            enum: ["sa3-medium", "sa3-sm-music", "sa3-sm-sfx"],
            description: "Base model key.",
          },
          dataset_id: { type: "string", description: "Dataset id from list_datasets." },
          lora_type: {
            type: "string",
            enum: ["lora", "dora", "dora-rows", "dora-cols", "bora", "lora-xs", "dora-rows-xs", "dora-cols-xs", "bora-xs"],
            description: "Adapter type (default lora).",
          },
          rank: { type: "integer", description: "LoRA rank (default 16)." },
          alpha: { type: ["number", "string"], description: "Alpha; defaults to rank." },
          lr: { type: "string", description: 'Learning rate, e.g. "1e-4".' },
          max_steps: { type: "integer", description: "Absolute global-step target (default 20000)." },
          batch_size: { type: "integer", description: "Batch size (default 8)." },
          checkpoint_every: { type: "integer", description: "Steps between checkpoints (default 1000)." },
          demo_every: { type: "integer", description: "Steps between demo generations (default 1000)." },
          gpu: { type: "integer", description: "CUDA device index." },
          base_precision: {
            type: ["string", "null"],
            enum: [null, "bf16", "fp16"],
            description: "Frozen-base precision.",
          },
          lora_include: { type: "string", description: "Comma-separated include filter (layer substrings)." },
          lora_exclude: { type: "string", description: "Comma-separated exclude filter." },
          latent_crop_length: { type: "integer", description: "Latent sequence length to crop to." },
          random_crop: { type: "boolean", description: "Random vs start crop (default true)." },
          seed_lora_path: {
            type: "string",
            description: "Path to a seed LoRA .safetensors to start from (see validate_seed_lora).",
          },
          prompt_config: {
            type: "object",
            description: "Prompt-composition config (tags/paths/fixed/trigger + balance).",
          },
          demo_cond: {
            type: "array",
            description: "Demo prompts: [{prompt, cfg, steps, arc?, fixed_prompt?}].",
          },
          ground_truth: {
            type: "array",
            description: "Ground-truth reference tracks for A/B in the demo panel.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "control_run",
      description:
        "Control a run: pause/continue/kill/resume/delete. pause & continue are POSIX-only (400 on Windows). For resume pass max_steps (+ optional batch_size, checkpoint_every, demo_every, lr, checkpoint_path, gpu, latent_crop_length, random_crop). For delete pass delete_files.",
      parameters: {
        type: "object",
        required: ["run_id", "action"],
        properties: {
          run_id: { type: "string" },
          action: { type: "string", enum: ["pause", "continue", "kill", "resume", "delete"] },
          max_steps: { type: "integer" },
          batch_size: { type: "integer" },
          checkpoint_every: { type: "integer" },
          demo_every: { type: "integer" },
          lr: { type: "string" },
          checkpoint_path: { type: "string" },
          gpu: { type: "integer" },
          latent_crop_length: { type: "integer" },
          random_crop: { type: "boolean" },
          delete_files: { type: "boolean" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "clone_settings",
      description: "Full config of a run, to pre-fill a clone.",
      parameters: {
        type: "object",
        properties: { run_id: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_checkpoints",
      description: "Saved LoRA checkpoints for a run (with effective steps across sessions).",
      parameters: {
        type: "object",
        properties: { run_id: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_checkpoint",
      description: "Trigger a manual checkpoint save (SIGUSR1; POSIX-only, 400 on Windows).",
      parameters: {
        type: "object",
        required: ["run_id"],
        properties: { run_id: { type: "string" } },
      },
    },
  },
  // ---------------------------- DATASETS ---------------------------------
  {
    type: "function",
    function: {
      name: "list_datasets",
      description: "List datasets (id, name, model, num_files, status).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "dataset_progress",
      description: "Encoding progress + log tail for a dataset.",
      parameters: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scan_dataset",
      description: "Scan a directory for audio (or a pre-encoded latent dir). Returns the final scan result.",
      parameters: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "encode_dataset",
      description: "Launch pre-encoding of an audio dir into latents on N GPUs.",
      parameters: {
        type: "object",
        required: ["name", "input_dir", "gpus"],
        properties: {
          name: { type: "string" },
          input_dir: { type: "string" },
          model: { type: "string", enum: ["sa3-medium", "sa3-sm-music", "sa3-sm-sfx"], description: "default sa3-medium" },
          gpus: { type: "array", items: { type: "integer" } },
          half: { type: "boolean", description: "default true" },
          default_prompt: { type: "string" },
          exclude: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "import_dataset",
      description: "Register a pre-encoded / native latent directory as a dataset.",
      parameters: {
        type: "object",
        required: ["name", "path", "mode", "model"],
        properties: {
          name: { type: "string" },
          path: { type: "string" },
          mode: { type: "string", enum: ["underfit_native_import", "preencoded_import", "bare_import"] },
          model: { type: "string", enum: ["sa3-medium", "sa3-sm-music", "sa3-sm-sfx"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_dataset",
      description: "Delete a dataset. Use dry_run:true first to check if a run depends on it.",
      parameters: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          dry_run: { type: "boolean" },
          delete_files: { type: "boolean" },
        },
      },
    },
  },
  // ------------------------- MODELS / HARDWARE ---------------------------
  {
    type: "function",
    function: {
      name: "list_models",
      description: "Available base models + per-model UI/config payload.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "estimate_vram",
      description: "Estimate training VRAM for a config.",
      parameters: {
        type: "object",
        properties: {
          model: { type: "string" },
          batch_size: { type: "integer" },
          rank: { type: "integer" },
          precision: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gpu_status",
      description: "nvidia-smi snapshot: per-GPU VRAM/util + which runs/encodes/gradios use each.",
      parameters: { type: "object", properties: {} },
    },
  },
  // --------------------- DEMOS / METRICS / LOGS --------------------------
  {
    type: "function",
    function: {
      name: "get_demos",
      description: "Ground-truth + per-step demo clips (audio + spectrogram URLs) for a run.",
      parameters: {
        type: "object",
        properties: {
          run_id: { type: "string" },
          nocache: { type: "boolean" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "loss_by_timestep",
      description: "Loss split across 5 sigma buckets (the loss-by-timestep chart data).",
      parameters: {
        type: "object",
        properties: { run_id: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_log_tail",
      description:
        "Tail of a run's training log. Pass file_size:0 for the full log. When a launch died before/outside normal logging, the response also carries bash_err (<log>.bash.err — the launch shell's own stderr) and/or exit_info (<log>.exit — the trainer's crash traceback); read those to self-diagnose launch failures.",
      parameters: {
        type: "object",
        properties: {
          run_id: { type: "string" },
          file_size: { type: "integer" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "server_log",
      description: "Tail the dashboard server's own log (startup/errors).",
      parameters: { type: "object", properties: {} },
    },
  },
  // ---------------------------- SEED LORAS -------------------------------
  {
    type: "function",
    function: {
      name: "validate_seed_lora",
      description:
        "Upload + validate a local seed LoRA .safetensors; returns its adapter config. Use the returned path as launch_finetune.seed_lora_path.",
      parameters: {
        type: "object",
        required: ["file_path"],
        properties: {
          file_path: { type: "string", description: "Absolute path to a .safetensors LoRA on this machine." },
        },
      },
    },
  },
  // ------------------------- INFERENCE / AUDITION -------------------------
  {
    type: "function",
    function: {
      name: "launch_inference_ui",
      description:
        "Launch a Gradio inference UI for a trained checkpoint so the user can LISTEN to it — the real quality test. Each instance holds ~10-12 GB VRAM; stop instances before training.",
      parameters: {
        type: "object",
        required: ["checkpoint_path", "gpu"],
        properties: {
          checkpoint_path: { type: "string", description: "Path from list_checkpoints." },
          gpu: { type: "integer", description: "CUDA device index." },
          run_id: { type: "string" },
          checkpoint_name: { type: "string" },
          title: { type: "string", description: "UI title." },
          model_variant: { type: "string" },
          verbose: { type: "boolean" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_inference_uis",
      description: "List running Gradio inference UI instances (id, checkpoint, GPU, status).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_inference_ui",
      description: "Stop a running Gradio inference UI instance and free its VRAM.",
      parameters: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Instance id from list_inference_uis." } },
      },
    },
  },
  // ------------------------- DATASET INSPECTION ---------------------------
  {
    type: "function",
    function: {
      name: "dataset_files",
      description:
        "List a dataset's files with their tag/caption coverage (ID3/JSON/none per file). Use to judge caption quality before training.",
      parameters: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string", description: "Dataset id from list_datasets." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rare_tokens",
      description:
        "Get rare-token suggestions for trigger words (prompt_config.trigger) — tokens the base model barely knows, ideal as a style handle.",
      parameters: { type: "object", properties: {} },
    },
  },
  // --------------------------- RESEARCH & DOCS ----------------------------
  {
    type: "function",
    function: {
      name: "read_guide",
      description:
        "Read Underfit's own documentation. topic: 'app' = the Underfit tab guide, 'training' = the step-by-step LoRA training walkthrough, 'readme' = the upstream README, 'user-guide' = the full in-app user guide. Read this FIRST for questions about the app's UI, fields, or workflow — never invent UI behavior.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", enum: ["app", "training", "readme", "user-guide"], description: "Default: app." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_webpage",
      description:
        "Fetch a live web page server-side (SSRF-guarded) and return its text. Use for current external facts: HF model pages, library docs, unfamiliar error messages. (On Better Claude Code, prefer the native WebSearch/WebFetch tools.)",
      parameters: {
        type: "object",
        required: ["url"],
        properties: { url: { type: "string", description: "Full http(s) URL." } },
      },
    },
  },
  // ------------------------------ INTERVIEW ------------------------------
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user a MULTIPLE-CHOICE question and BLOCK until they answer. Renders as an interactive option-button card in the chat — the user CLICKS a choice instead of typing. Returns {selected:[...], other:string|null}. Use it to run the DATASET CURATION interview (source, scope, target size, caption strategy) and any time a decision has a small, known set of options. Ask ONE question per call. (On Better Claude Code, use the native AskUserQuestion tool for the same effect.)",
      parameters: {
        type: "object",
        required: ["question", "options"],
        properties: {
          question: { type: "string", description: "The single question to put to the user." },
          options: {
            type: "array",
            description: "2-6 answer choices (extra options past 6 are dropped).",
            items: {
              type: "object",
              required: ["label"],
              properties: {
                label: { type: "string", description: "Short choice label — this is the value returned in `selected`." },
                description: { type: "string", description: "Optional one-line hint shown under the label." },
              },
            },
          },
          multi_select: { type: "boolean", description: "Allow picking several options (default false)." },
          allow_other: { type: "boolean", description: "Show a free-text 'Other' field (default true)." },
        },
      },
    },
  },
];

// Anthropic uses input_schema instead of the OpenAI parameters wrapper.
const ANTHROPIC_TOOLS = OPENAI_TOOLS.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters,
}));

function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").toLowerCase());
}

function openAIToolName(tool: any): string {
  return String(tool?.function?.name || "");
}

function clonePlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function normalizeJsonSchemaForGemini(schema: any): any {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const out: any = { ...schema };
  if (out.properties || out.type === "object") {
    out.type = "object";
    const properties = out.properties && typeof out.properties === "object" ? out.properties : {};
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, normalizeJsonSchemaForGemini(value)]),
    );
    if (!Array.isArray(out.required)) out.required = [];
  }
  if (out.items) out.items = normalizeJsonSchemaForGemini(out.items);
  return out;
}

function normalizeOpenAICompatToolForProvider(provider: string, tool: any): any {
  if (provider !== "gemini") return tool;
  const normalized = clonePlain(tool);
  normalized.function.parameters = normalizeJsonSchemaForGemini(normalized.function.parameters || { type: "object", properties: {} });
  return normalized;
}

function providerSupportsImageInput(provider: string, model: string): boolean {
  const id = `${provider}/${model}`.toLowerCase();
  if (provider === "gemini" || provider === "openai" || provider === "anthropic") return true;
  if (provider === "groq") return false;
  if (provider === "grok") return !id.includes("mini");
  if (provider === "openrouter" || provider === "openrouter-free") {
    return /vision|gpt-4o|gpt-4\.1|claude|gemini|gemma-3|qwen.*vl|qwen-vl|llava|pixtral|mistral-small-3\.2/.test(id);
  }
  return /vision|llava|qwen.*vl|qwen-vl|pixtral/.test(id);
}

function shouldSendOpenAICompatTools(provider: string, model: string): { ok: boolean; reason?: string } {
  if ((provider === "ollama" || provider === "lmstudio") && !envFlag("THEDAW_ENABLE_LOCAL_OPENAI_TOOLS")) {
    return {
      ok: false,
      reason: `${provider} tool calls are disabled unless THEDAW_ENABLE_LOCAL_OPENAI_TOOLS=1 because local OpenAI-compatible servers vary by model.`,
    };
  }
  return { ok: true };
}

function openAICompatToolsForProvider(provider: string, model: string): any[] {
  const toolSupport = shouldSendOpenAICompatTools(provider, model);
  if (!toolSupport.ok) return [];
  const canSendImages = providerSupportsImageInput(provider, model);
  const tools = canSendImages
    ? OPENAI_TOOLS
    : OPENAI_TOOLS.filter((tool) => openAIToolName(tool) !== "captureCanvasScreenshot");
  return tools.map((tool) => normalizeOpenAICompatToolForProvider(provider, tool));
}

function isToolCapabilityError(status: number, text: string): boolean {
  return (
    [400, 404, 422].includes(status) &&
    /tool|function|thought_signature|no endpoints found that support tool use/i.test(text)
  );
}

function isImageInputCapabilityError(status: number, text: string): boolean {
  return [400, 404, 422].includes(status) && /image input|vision|image_url|multimodal/i.test(text);
}

function isGeminiGenericInvalidArgument(status: number, text: string): boolean {
  return status === 400 && /invalid argument|INVALID_ARGUMENT/i.test(text);
}

function contentShape(content: any): string {
  if (Array.isArray(content)) return `array:${content.map((part) => part?.type || typeof part).join(",")}`;
  return typeof content;
}

function messagesHaveImageContent(messages: any[]): boolean {
  return messages.some((msg) => Array.isArray(msg.content) && msg.content.some((part: any) => part?.type === "image_url"));
}

function stripImageContent(messages: any[]): void {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    const text = extractText(msg.content);
    msg.content = msg.content.filter((part: any) => part?.type !== "image_url");
    if (!msg.content.some((part: any) => part?.type === "text")) {
      msg.content.unshift({ type: "text", text: text || "Continue without image input." });
    }
  }
}

function openAICompatRequestSummary(body: any): any {
  return {
    model: body?.model,
    stream: !!body?.stream,
    bodyKeys: Object.keys(body || {}).sort(),
    messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
    messages: Array.isArray(body?.messages)
      ? body.messages.map((msg: any) => ({
          role: msg.role,
          content: contentShape(msg.content),
          hasToolCalls: Array.isArray(msg.tool_calls),
          toolCallCount: Array.isArray(msg.tool_calls) ? msg.tool_calls.length : 0,
          hasToolCallId: !!msg.tool_call_id,
        }))
      : [],
    toolCount: Array.isArray(body?.tools) ? body.tools.length : 0,
    toolNames: Array.isArray(body?.tools) ? body.tools.map((tool: any) => openAIToolName(tool)).filter(Boolean) : [],
  };
}

function capabilitiesFromOpenRouterModel(model: any): string[] {
  const caps = new Set<string>(["chat"]);
  const supported = Array.isArray(model?.supported_parameters) ? model.supported_parameters : [];
  const input = [
    ...(Array.isArray(model?.input_modalities) ? model.input_modalities : []),
    ...(Array.isArray(model?.architecture?.input_modalities) ? model.architecture.input_modalities : []),
  ];
  if (supported.includes("tools")) caps.add("tools");
  if (supported.includes("tool_choice")) caps.add("tool_choice");
  if (supported.includes("reasoning") || supported.includes("include_reasoning")) caps.add("reasoning");
  if (supported.includes("structured_outputs") || supported.includes("response_format")) caps.add("structured_output");
  if (input.includes("image")) caps.add("vision");
  return Array.from(caps);
}

// ===========================================================================
// System instruction builder
// ===========================================================================

// The system instruction is rebuilt and resent on EVERY turn, so the canvas
// state embedded in it must stay lean. The killers are per-element string blobs
// — `customCode` (tens of KB of canvas JS each) and inline base64 data URLs —
// which previously made a few CustomCode elements balloon the prompt past 200K
// chars every single message. We keep the full structural state (ids, types,
// geometry, names, colors, value model, texture refs — everything needed to act)
// but replace any oversized string field with a compact marker. The model still
// sees that an element HAS custom code and how large it is, and fetches the real
// source on demand with getElements([id]) (read-before-write).
const PROMPT_STRING_FIELD_CAP = 240; // per-string ceiling in the per-turn summary

function leanForPrompt(value: any): any {
  if (typeof value === "string") {
    if (value.length <= PROMPT_STRING_FIELD_CAP) return value;
    return `<${value.length} chars omitted — fetch by id with getElements>`;
  }
  if (Array.isArray(value)) return value.map(leanForPrompt);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value)) out[k] = leanForPrompt(value[k]);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Auto-detected hardware for the system prompt. The guide's VRAM/batch advice
// must reflect the REAL machine, never a hardcoded card. Primary source: the
// underfit dashboard's /api/gpu (includes live free VRAM). Fallback: direct
// nvidia-smi (works even when the dashboard is down). TTL-cached; refreshed
// per chat request. If both fail, the prompt tells the model to call
// gpu_status() before giving any memory advice.
// ---------------------------------------------------------------------------

type HwGpu = { idx: number; name?: string; total_mb: number; free_mb?: number; compute_cap?: string };
let _hwGpus: HwGpu[] | null = null;
let _hwFetchedAt = 0;
const HW_TTL_MS = 60_000;

async function _hwFromDashboard(): Promise<HwGpu[] | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2000);
  try {
    const resp = await fetch(`${UNDERFIT_DASHBOARD_BASE}/api/gpu`, { signal: ctrl.signal });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const gpus = Array.isArray(data?.gpus) ? data.gpus : [];
    if (!gpus.length) return null;
    return gpus.map((g: any, i: number) => ({
      idx: g.gpu ?? i,
      name: typeof g.name === "string" ? g.name : undefined,
      total_mb: Number(g.total_mb) || 0,
      free_mb: Number.isFinite(Number(g.free_mb)) ? Number(g.free_mb) : undefined,
      compute_cap: typeof g.compute_cap === "string" ? g.compute_cap : undefined,
    }));
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function _hwFromNvidiaSmi(): Promise<HwGpu[] | null> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=index,name,memory.total,memory.free,compute_cap", "--format=csv,noheader,nounits"],
      { timeout: 4000, windowsHide: true },
      (err: Error | null, stdout: string) => {
        if (err || !stdout) { resolve(null); return; }
        const gpus: HwGpu[] = [];
        for (const line of stdout.trim().split(/\r?\n/)) {
          const p = line.split(",").map((s) => s.trim());
          if (p.length >= 4 && Number(p[2]) > 0) {
            gpus.push({
              idx: Number(p[0]) || 0,
              name: p[1],
              total_mb: Number(p[2]),
              free_mb: Number.isFinite(Number(p[3])) ? Number(p[3]) : undefined,
              compute_cap: p[4],
            });
          }
        }
        resolve(gpus.length ? gpus : null);
      },
    );
  });
}

// The dashboard's /api/gpu carries no GPU *name* — only stats. Names are
// static, so fetch them from nvidia-smi once and cache them forever, merging
// into the dashboard's live free-VRAM data.
let _hwNames: Record<number, string> | null = null;

async function refreshHardwareInfo(): Promise<void> {
  if (_hwGpus && Date.now() - _hwFetchedAt < HW_TTL_MS) return;
  let gpus = await _hwFromDashboard();
  if (gpus && gpus.some((g) => !g.name)) {
    if (!_hwNames) {
      const smi = await _hwFromNvidiaSmi();
      const names: Record<number, string> = {};
      for (const g of smi || []) if (g.name) names[g.idx] = g.name;
      _hwNames = names;
    }
    const names = _hwNames;
    for (const g of gpus) if (!g.name && names[g.idx]) g.name = names[g.idx];
  }
  if (!gpus) gpus = await _hwFromNvidiaSmi();
  if (gpus) {
    _hwGpus = gpus;
    _hwFetchedAt = Date.now();
  }
}

function hardwarePromptBlock(): string {
  if (!_hwGpus || !_hwGpus.length) {
    return "Hardware could NOT be auto-detected right now. Call gpu_status() FIRST and base all VRAM/batch advice on its answer.";
  }
  const lines = _hwGpus.map((g) => {
    const total = (g.total_mb / 1024).toFixed(1);
    const free = g.free_mb != null ? `, ${(g.free_mb / 1024).toFixed(1)} GB free at last check` : "";
    const cc = g.compute_cap ? ` (compute ${g.compute_cap})` : "";
    return `- GPU ${g.idx}: ${g.name || "unknown GPU"} — ${total} GB VRAM${free}${cc}`;
  });
  const minTotal = Math.min(..._hwGpus.map((g) => g.total_mb));
  let tier: string;
  if (minTotal >= 70000) tier = "80 GB-class: training batch_size 8+ is comfortable for sa3-medium.";
  else if (minTotal >= 40000) tier = "40-48 GB-class: training batch_size 4-8 for sa3-medium.";
  else if (minTotal >= 22000) tier = "24 GB-class: keep training batch_size 1-4 for sa3-medium; the small models can go higher.";
  else if (minTotal >= 14000) tier = "16 GB-class: training batch_size 1-2; prefer fp16 base_precision and/or the sa3-sm-* models.";
  else tier = "under 16 GB: batch_size 1, fp16, low rank, prefer sa3-sm-* models; sa3-medium may not fit at all.";
  return `${lines.join("\n")}\nSizing rule for THIS machine: ${tier} Always confirm with estimate_vram + gpu_status before launching.`;
}

function buildSystemInstruction(appState?: any, toolsAvailable = true, imageInputAvailable = true): string {
  // appState / imageInputAvailable are accepted for call-site compatibility with
  // the direct-API streamers, but Underfit's live state comes from the tools
  // (list_runs, get_run_status, gpu_status, …), not a canvas snapshot, and no
  // tool takes image input — so neither is embedded in the prompt.
  void appState;
  void imageInputAvailable;

  if (!toolsAvailable) {
    return `You are the Underfit Guide — an expert LoRA-training mentor for Stable Audio 3, embedded in the Underfit dashboard. You know dataset craft, adapter types (LoRA/DoRA/BoRA and their -xs variants), rank/LR/step selection, how to read loss curves and loss-by-timestep, how to judge demo audio, and how to keep runs inside GPU memory.

This provider/model is running WITHOUT callable tools right now. Give expert, concrete text guidance (exact settings, exact next steps), or tell the user to switch to the Better Claude Code provider for live, tool-driven control of Underfit.

THIS MACHINE (auto-detected):
${hardwarePromptBlock()}`;
  }

  return `You are the Underfit Guide — an expert LoRA-training mentor for Stable Audio 3, embedded in the Underfit dashboard. You do two things at once: OPERATE the dashboard by calling tools, and COACH the user like a senior practitioner — proactive, opinionated, and concrete. You drive real training end-to-end: scan/pre-encode/import datasets, launch/resume/kill runs, and inspect GPUs, demos, loss curves and checkpoints. Every tool executes live against the Underfit dashboard, so acting = calling a tool, not describing one.

═══════════════════════════════════════════════════════════════
YOUR TOOLSET (29 tools)
═══════════════════════════════════════════════════════════════
RUNS — inspect & control
- list_runs()                          → every run (id, status, base_model, max_steps, dataset).
- get_run_status(run_id?)              → live progress + metrics + log tail. Omit run_id for the active run.
- launch_finetune(name, base_model, dataset_id, …) → start a new LoRA finetune. Optional: lora_type, rank, alpha, lr, max_steps, batch_size, checkpoint_every, demo_every, gpu, base_precision, lora_include/lora_exclude, latent_crop_length, random_crop, seed_lora_path, prompt_config, demo_cond, ground_truth.
- control_run(run_id, action, …)       → action = pause | continue | kill | resume | delete. resume takes max_steps (+ optional batch_size, checkpoint_every, demo_every, lr, checkpoint_path, gpu, latent_crop_length, random_crop); delete takes delete_files.
- clone_settings(run_id?)              → full config of a run, to pre-fill a clone before launch_finetune.
- save_checkpoint(run_id)              → trigger a manual checkpoint save (SIGUSR1).
- list_checkpoints(run_id?)            → saved LoRA checkpoints (with effective steps across resume sessions).

DATASETS
- list_datasets()                      → every dataset (id, name, model, num_files, status).
- dataset_progress(id)                 → encoding progress + log tail for a dataset.
- scan_dataset(path)                   → scan a directory for audio (or a pre-encoded latent dir); returns the final scan result.
- encode_dataset(name, input_dir, gpus[], …) → pre-encode an audio dir into latents on N GPUs (optional model, half, default_prompt, exclude).
- import_dataset(name, path, mode, model) → register a pre-encoded / native latent dir (mode = underfit_native_import | preencoded_import | bare_import).
- delete_dataset(id, dry_run?, delete_files?) → delete a dataset.

MODELS / HARDWARE
- list_models()                        → available base models + per-model UI/config payload.
- estimate_vram(model?, batch_size?, rank?, precision?) → estimated training VRAM for a config.
- gpu_status()                         → nvidia-smi snapshot: per-GPU VRAM/util + which runs/encodes use each GPU.

DEMOS / METRICS / LOGS
- get_demos(run_id?, nocache?)         → ground-truth + per-step demo clips (audio + spectrogram URLs).
- loss_by_timestep(run_id?)            → loss split across 5 sigma buckets (loss-by-timestep chart data).
- get_log_tail(run_id?, file_size?)    → tail of a run's training log. Pass file_size:0 for the full log. Also returns bash_err / exit_info sidecar fields when a launch died before logging — that's where launcher/shell failures live.
- server_log()                         → tail the dashboard server's own log (startup/errors).

SEED LORAS
- validate_seed_lora(file_path)        → upload + validate a local seed LoRA .safetensors; returns its adapter config. Use the returned path as launch_finetune.seed_lora_path.

INFERENCE / AUDITION
- launch_inference_ui(checkpoint_path, gpu, …) → spin up a Gradio inference UI to LISTEN to a checkpoint — the real quality test. Each instance holds ~10-12 GB VRAM.
- list_inference_uis() / stop_inference_ui(id) → manage running inference UIs. Stop them before launching training on the same GPU.

DATASET INSPECTION
- dataset_files(id)                    → per-file tag/caption coverage (ID3/JSON/none). Judge caption quality BEFORE training.
- rare_tokens()                        → rare-token suggestions for prompt_config.trigger (style-handle words the base model barely knows).

RESEARCH & DOCS
- read_guide(topic)                    → Underfit's own docs: "app" (tab guide), "training" (walkthrough), "readme", "user-guide" (full manual). Read FIRST for app/UI questions — never invent UI behavior.
- fetch_webpage(url)                   → fetch a live web page (SSRF-guarded) for current external facts: HF model pages, library docs, unfamiliar errors. (On Better Claude Code prefer native WebSearch/WebFetch.)

INTERVIEW
- ask_user(question, options[2-6], multi_select?, allow_other?) → ask ONE multiple-choice question and BLOCK for the answer. Renders as a clickable option card; returns {selected:[...], other:string|null}. Use it to run the DATASET CURATION interview and any either/or decision with a small set of clear options — do NOT bury such a choice in prose. (On Better Claude Code, use the native AskUserQuestion tool instead.)

═══════════════════════════════════════════════════════════════
BASE MODELS
═══════════════════════════════════════════════════════════════
sa3-medium (Stable Audio 3 medium DiT), sa3-sm-music (small music model), sa3-sm-sfx (small SFX model). Confirm exact keys and per-model config with list_models() before launching.

═══════════════════════════════════════════════════════════════
EXPERT PLAYBOOK — the full workflow you guide users through
═══════════════════════════════════════════════════════════════
1. DATASET: one coherent style per dataset (one artist / one genre / one SFX family). 10+ minutes of audio minimum; 30+ is meaningfully better. Captions come from JSON/.txt sidecars, embedded tags, or folder/filename structure; prompt_config mixes tag/path/fixed prompts with a balance slider and an optional trigger token (use a rare token for a nameable style handle).
2. ENCODE: scan_dataset first, then encode_dataset. Encoding is one-time per (dataset, model family); SAME-S and SAME-L latents are cross-compatible across the small/medium models. Batch sizing is auto (VRAM-probed, length-bucketed) — do not force a large batch.
3. LAUNCH: sane defaults are lora_type "dora", rank 16, alpha = rank, lr 1e-4, 10k–20k max_steps, checkpoint_every/demo_every 1000. Verify VRAM first: estimate_vram + gpu_status. Match batch_size to THIS MACHINE (see the auto-detected hardware section) — if the estimate approaches free VRAM, cut batch_size before anything else.
4. MONITOR: get_run_status for step/loss/lr; loss_by_timestep for the 5 sigma buckets; get_demos to actually LISTEN. Judge runs by demos, not by loss alone — train loss is noisy and plateaus early while quality keeps improving.
5. JUDGE & STOP: overfit = demos reproduce training clips near-verbatim, lose prompt responsiveness, or collapse in variety → stop earlier, lower rank, or add data. Underfit = demos sound generic/mushy with weak style transfer → more steps, more data, or higher rank. Pick the CHECKPOINT whose demos sound best, not the lowest-loss one; earlier checkpoints often generalize better.
6. ITERATE: clone_settings to tweak one variable at a time (rank, lr, dataset, prompt balance). Resume from a checkpoint (control_run resume with a higher max_steps — max_steps is ABSOLUTE global steps, not additional).

ADAPTER TYPES (lora_type): "lora" = classic, cheapest. "dora"/"dora-rows"/"dora-cols" = magnitude-decomposed, usually better quality at the same rank — the default recommendation. "bora" = bi-dimensional DoRA. "-xs" variants (lora-xs, dora-rows-xs, dora-cols-xs, bora-xs) = tiny trainable core over frozen SVD bases → much smaller checkpoints, good for stacking many adapters.

READING loss_by_timestep: 5 buckets from low sigma (fine detail) to high sigma (coarse structure). High-sigma buckets are inherently noisy — don't panic over them. A healthy run shows the mid-sigma buckets trending down; if ONLY low-sigma improves while demos stay mushy, the model is polishing detail without learning structure — usually needs more data or steps.

HARDWARE SAFETY (learned the hard way): an oversized batch on Windows doesn't just OOM — the driver spills into system RAM and can freeze the whole machine. The encoder auto-probes VRAM; for TRAINING always sanity-check estimate_vram against gpu_status free memory before launching, and size the batch per the THIS MACHINE section below.

═══════════════════════════════════════════════════════════════
DATASET CURATION (interview mode)
═══════════════════════════════════════════════════════════════
When the user wants a dataset curated / built / prepared for training, do NOT
dump a wall of questions or start scanning blindly. Run a short INTERVIEW: ask
2-4 MULTIPLE-CHOICE questions ONE AT A TIME via ask_user (on Better Claude Code:
the native AskUserQuestion tool), each with 2-6 concrete options. Wait for each
answer before asking the next. Cover, in order:
  1. SOURCE — where the audio lives. Options e.g. "A folder path (I'll paste it)",
     "theDAW library". If they pick a folder, follow up in plain text for the exact path.
  2. SCOPE — the ONE coherent style this dataset captures. Options e.g. "One artist",
     "One genre", "One SFX family". (One coherent style per dataset — never mix.)
  3. TARGET SIZE — how much audio. Options: "10-30 min (quick style)",
     "30-60 min (solid)", "60+ min (deep)".
  4. CAPTION STRATEGY — how training prompts are built. Options: "Use existing tags
     (ID3/JSON sidecars)", "Auto-tag from folder/filename structure", "Fixed prompt +
     trigger word". If they choose a trigger word, offer rare_tokens() suggestions.

Then, WITHOUT launching anything yet:
  a. scan_dataset(path) on the chosen directory. Use the returned file list, tags,
     and dataset naming from the scan — never invent files or counts.
  b. PROPOSE the selection: show which files you'd include (grouped/counted), the
     caption strategy, and the derived dataset name. Call out files you'd DROP
     (silent, too short/long, wrong style, missing captions) and WHY.
  c. On approval, encode_dataset with exclude[] listing every deselected file, plus
     the chosen name/model/prompt settings. NEVER encode without first showing this
     plan and getting a yes. After encoding, verify with list_datasets / dataset_files.
Skip a question only if the user already answered it unambiguously; otherwise ask.

═══════════════════════════════════════════════════════════════
THIS MACHINE (auto-detected)
═══════════════════════════════════════════════════════════════
${hardwarePromptBlock()}

UI PRESETS & GUIDES (know these; OFFER them proactively)
The New Finetune form has one-click PRESET buttons — "⭐ Standard (recommended)" (dora-rows, rank 16, alpha=rank, lr 1e-4, 20k steps, batch 2, ckpt/demo 1000), "⚡ Quick test" (lora, rank 8, 3k steps, batch 1 — fast sanity run), "💪 High capacity" (dora-rows, rank 32, batch 1) — plus inline guide hints (what to expect after launch, overfit-vs-underfit demo judging, dataset size rules). When a user is unsure what settings to use, POINT THEM AT THE PRESETS ("hit ⭐ Standard, then Launch") or offer to launch the equivalent yourself via launch_finetune. When they seem new, mention the 📖 DOCS button (opens the LoRA training guide) and the hover tooltips on every field.

═══════════════════════════════════════════════════════════════
OPERATING LOOP (every request)
═══════════════════════════════════════════════════════════════
1. UNDERSTAND the intent. If genuinely ambiguous, ask ONE sharp question; otherwise proceed.
2. GATHER live state with read tools — never assume ids, statuses, or free VRAM.
3. SAFETY-CHECK mutations: estimate_vram + gpu_status before launching; dry_run before dataset deletes; confirm destructive actions with the user.
4. ACT with exact arguments.
5. VERIFY the effect immediately: get_run_status after launch/resume/kill; list_datasets after encode/import; list_inference_uis after a Gradio launch.
6. REPORT: the result, what it MEANS, and the single best next step.

ERROR RECOVERY
- A tool errors → read server_log() and get_log_tail() to diagnose BEFORE retrying; report the root cause, not just the error string.
- App/UI questions ("what does this field do?") → read_guide first.
- Unfamiliar external facts (model releases, HF repos, error messages you don't recognize) → fetch_webpage (or native web tools on Better Claude Code). Never answer from stale memory when a live source is one call away.
- OOM during training → control_run kill, then resume from the last checkpoint with a smaller batch_size. The encode path auto-sizes itself.

═══════════════════════════════════════════════════════════════
HOW TO BEHAVE
═══════════════════════════════════════════════════════════════
- ACT by calling tools. When the user asks to start/resume/stop a run, build/encode/import a dataset, or check status, GPU, loss, demos, or checkpoints, call the matching tool with real arguments — do not merely explain what you would do.
- BE THE GUIDE. When the user asks something vague ("how's it going?", "is it done?", "is this any good?"), pull get_run_status + loss_by_timestep + get_demos and give a VERDICT with reasoning and a recommended next action — not a raw data dump. For first-time users, walk the playbook stages explicitly and say what comes next.
- READ before you change. Call list_runs / list_datasets / gpu_status / get_run_status to learn the live state and the EXACT ids before you launch, resume, or delete. Never invent a run_id or dataset_id — always use ids returned by the list tools.
- Before launching a finetune: confirm the dataset exists (list_datasets), pick a valid base_model (list_models), and check the config fits in VRAM (estimate_vram + gpu_status). To reuse a run's settings, start from clone_settings.
- To seed from an existing LoRA: call validate_seed_lora(file_path) first, then pass the returned path as launch_finetune.seed_lora_path.
- CONFIRM before destructive actions (kill, delete, delete_files). To delete a dataset, ALWAYS call delete_dataset with dry_run:true first to see whether any run depends on it.
- Windows note: pause, continue, and save_checkpoint are POSIX-only and return HTTP 400 on Windows. To stop and continue a run on Windows use control_run kill, then control_run resume with max_steps.
- Be concise but decisive. After acting, report the key result — ids, status, current step, loss, VRAM, checkpoint path — plus your read on what it MEANS and what to do next. Surface any tool error plainly and suggest the fix.`;
}

// ===========================================================================
// Message / content helpers
// ===========================================================================

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p?.text || (p?.type === "text" ? p.text : "")))
      .filter(Boolean)
      .join(" ");
  }
  if (content == null) return "";
  return String(content);
}

function normalizeRole(role: string): string {
  return role === "model" ? "assistant" : role;
}

function screenshotDataUrl(screenshot: string): string {
  if (screenshot.startsWith("data:")) return screenshot;
  const b64 = screenshot.includes(",") ? screenshot.split(",")[1] : screenshot;
  return `data:image/png;base64,${b64}`;
}

function screenshotBase64(screenshot: string): string {
  if (screenshot.includes(",")) return screenshot.split(",")[1] || "";
  return screenshot;
}

function normalizeUsage(u: any): { input_tokens: number; output_tokens: number } | undefined {
  if (!u) return undefined;
  return {
    input_tokens: u.input_tokens ?? u.prompt_tokens ?? 0,
    output_tokens: u.output_tokens ?? u.completion_tokens ?? 0,
  };
}

// Build OpenAI-format message list with system instruction + optional screenshot.
function buildOpenAIMessages(systemText: string, messages: ChatMessage[], screenshot?: string): any[] {
  const out: any[] = [{ role: "system", content: systemText }];
  for (const m of messages) {
    out.push({ role: normalizeRole(m.role), content: m.content });
  }
  if (screenshot) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role === "user") {
        const text = extractText(out[i].content);
        out[i] = {
          role: "user",
          content: [
            { type: "text", text },
            { type: "image_url", image_url: { url: screenshotDataUrl(screenshot) } },
          ],
        };
        break;
      }
    }
  }
  return out;
}

// Build Anthropic-format message list (system goes to a top-level param).
function buildAnthropicMessages(messages: ChatMessage[], screenshot?: string): any[] {
  const out: any[] = [];
  for (const m of messages) {
    const role = normalizeRole(m.role);
    if (role !== "user" && role !== "assistant") continue;
    out.push({ role, content: extractText(m.content) });
  }
  if (screenshot) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].role === "user") {
        const text = typeof out[i].content === "string" ? out[i].content : extractText(out[i].content);
        out[i] = {
          role: "user",
          content: [
            { type: "text", text },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: screenshotBase64(screenshot) },
            },
          ],
        };
        break;
      }
    }
  }
  return out;
}

// ===========================================================================
// Underfit tool executor — direct HTTP to the dashboard control plane (:8791)
// ===========================================================================
//
// Mirrors underfit's MCP server (mcp-server.cjs) EXACTLY so every direct-API
// provider drives underfit through the same 21 tools the Better Claude Code /
// Claude MCP path uses. No browser round-trip — tool calls execute server-side
// against the underfit dashboard's REST API.
const UNDERFIT_DASHBOARD_HOST = process.env.UNDERFIT_DASHBOARD_HOST_MCP || "localhost";
const UNDERFIT_DASHBOARD_PORT = process.env.UNDERFIT_DASHBOARD_PORT || "8791";
const UNDERFIT_DASHBOARD_BASE = `http://${UNDERFIT_DASHBOARD_HOST}:${UNDERFIT_DASHBOARD_PORT}`;
const UNDERFIT_CALL_TIMEOUT_MS = 300_000; // 5 min — matches mcp-server.cjs CALL_TIMEOUT_MS

// Query-string builder — drops undefined/null/'' (0 and false survive), URL-
// encodes both key and value. Mirrors mcp-server.cjs `qs`.
function underfitQs(obj: Record<string, any>): string {
  const parts: string[] = [];
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? "?" + parts.join("&") : "";
}

// JSON in / JSON out. Rejects on non-2xx (mirrors serverSideCall's error text),
// treats an empty 2xx body as {}, and falls back to the LAST valid JSON line for
// NDJSON streams (scan_dataset streams progress lines then a final result line).
async function underfitServerCall(method: string, urlPath: string, body?: any): Promise<any> {
  const hasBody = body !== undefined && body !== null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UNDERFIT_CALL_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${UNDERFIT_DASHBOARD_BASE}${urlPath}`, {
      method,
      headers: hasBody ? { "Content-Type": "application/json" } : undefined,
      body: hasBody ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (e: any) {
    clearTimeout(timer);
    if (e?.name === "AbortError") throw new Error(`Timeout after ${UNDERFIT_CALL_TIMEOUT_MS}ms for ${method} ${urlPath}`);
    throw e;
  }
  clearTimeout(timer);
  const data = await resp.text();
  const ok = resp.status >= 200 && resp.status < 300;
  if (!ok) {
    let errVal: any = `HTTP ${resp.status}`;
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object" && "error" in parsed) errVal = (parsed as any).error;
    } catch {
      /* non-JSON error body — keep the HTTP status text */
    }
    throw new Error(
      `underfit error (${method} ${urlPath}): ${typeof errVal === "string" ? errVal : JSON.stringify(errVal)} ${data.slice(0, 200)}`,
    );
  }
  if (!data) return {};
  try {
    return JSON.parse(data);
  } catch {
    /* fall through to the NDJSON scan below */
  }
  const lines = data
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* keep scanning backward for the last valid JSON line */
    }
  }
  return data;
}

// Raw octet-stream upload (only validate_seed_lora). No status-code rejection —
// resolve the parsed JSON body (or raw text) regardless. Mirrors uploadBinary.
async function underfitUploadBinary(urlPath: string, filePath: string): Promise<any> {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e: any) {
    throw new Error(`Cannot read ${filePath}: ${e?.message || e}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UNDERFIT_CALL_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${UNDERFIT_DASHBOARD_BASE}${urlPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(buf),
      signal: controller.signal,
    });
  } catch (e: any) {
    clearTimeout(timer);
    if (e?.name === "AbortError") throw new Error("upload timeout");
    throw e;
  }
  clearTimeout(timer);
  const data = await resp.text();
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

// Route one underfit tool to its dashboard endpoint (method/path/body per
// mcp-server.cjs). Returns parsed JSON (or a string). Throws on transport /
// non-2xx errors; dispatchToolCall catches those and surfaces them as content.
async function executeUnderfitTool(name: string, a: any): Promise<any> {
  switch (name) {
    case "list_runs":
      return underfitServerCall("GET", "/api/runs");
    case "get_run_status":
      return underfitServerCall("GET", "/api/status" + underfitQs({ run_id: a.run_id }));
    case "launch_finetune":
      return underfitServerCall("POST", "/api/runs/new", a);
    case "control_run": {
      const body: any = { ...a };
      delete body.run_id;
      delete body.action;
      const sendBody = Object.keys(body).length ? body : undefined;
      return underfitServerCall("POST", `/api/runs/${encodeURIComponent(a.run_id)}/${a.action}`, sendBody);
    }
    case "clone_settings":
      return underfitServerCall("GET", "/api/clone_settings" + underfitQs({ run_id: a.run_id }));
    case "list_checkpoints":
      return underfitServerCall("GET", "/api/checkpoints" + underfitQs({ run_id: a.run_id }));
    case "save_checkpoint":
      return underfitServerCall("POST", "/api/save_checkpoint", { run_id: a.run_id });
    case "list_datasets":
      return underfitServerCall("GET", "/api/datasets");
    case "dataset_progress":
      return underfitServerCall("GET", `/api/datasets/${encodeURIComponent(a.id)}/progress`);
    case "scan_dataset":
      return underfitServerCall("POST", "/api/datasets/scan", { path: a.path });
    case "encode_dataset":
      return underfitServerCall("POST", "/api/datasets/encode", a);
    case "import_dataset":
      return underfitServerCall("POST", "/api/datasets/import", a);
    case "delete_dataset":
      return underfitServerCall("POST", `/api/datasets/${encodeURIComponent(a.id)}/delete`, {
        dry_run: a.dry_run,
        delete_files: a.delete_files,
      });
    case "list_models":
      return underfitServerCall("GET", "/api/models");
    case "estimate_vram":
      return underfitServerCall(
        "GET",
        "/api/estimate_vram" + underfitQs({ model: a.model, batch_size: a.batch_size, rank: a.rank, precision: a.precision }),
      );
    case "gpu_status":
      return underfitServerCall("GET", "/api/gpu");
    case "get_demos":
      return underfitServerCall("GET", "/api/demos" + underfitQs({ run_id: a.run_id, nocache: a.nocache ? 1 : undefined }));
    case "loss_by_timestep":
      return underfitServerCall("GET", "/api/loss_by_timestep" + underfitQs({ run_id: a.run_id }));
    case "get_log_tail":
      return underfitServerCall(
        "GET",
        "/api/log_tail" + underfitQs({ run_id: a.run_id, file_size: a.file_size == null ? 0 : a.file_size }),
      );
    case "server_log":
      return underfitServerCall("GET", "/api/server_log");
    case "validate_seed_lora":
      return underfitUploadBinary(
        `/api/lora/validate_seed?filename=${encodeURIComponent(path.basename(a.file_path))}`,
        a.file_path,
      );
    case "launch_inference_ui":
      return underfitServerCall("POST", "/api/gradio", a);
    case "list_inference_uis":
      return underfitServerCall("GET", "/api/gradio");
    case "stop_inference_ui":
      return underfitServerCall("DELETE", `/api/gradio/${encodeURIComponent(a.id)}`);
    case "dataset_files":
      return underfitServerCall("GET", `/api/datasets/${encodeURIComponent(a.id)}/files`);
    case "rare_tokens":
      return underfitServerCall("GET", "/api/rare_tokens");
    case "read_guide": {
      const root = process.env.UNDERFIT_ROOT || "C:\\Users\\skream\\projects\\underfit";
      const topics: Record<string, string> = {
        app: path.join(root, "docs", "thedaw-style", "underfit.md"),
        training: path.join(root, "docs", "thedaw-style", "underfit-lora-training.md"),
        readme: path.join(root, "README.md"),
        "user-guide": path.join(root, "dashboard", "assistant", "USER_GUIDE.md"),
      };
      const file = topics[String(a.topic || "app")] || topics.app;
      const text = fs.readFileSync(file, "utf8");
      const CAP = 30_000;
      return text.length <= CAP
        ? text
        : text.slice(0, CAP) + `\n\n[truncated ${text.length - CAP} of ${text.length} chars — ask for a specific section]`;
    }
    case "fetch_webpage":
      return scrapeUrl(String(a.url || ""));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ===========================================================================
// ask_user — interactive multiple-choice questions (direct-API providers)
// ===========================================================================
//
// `ask_user` is NOT executed server-side. It is answered by the HUMAN in the
// orb: dispatchToolCall emits an `ask_user` SSE frame and parks a promise here,
// keyed by the tool-call id; the orb renders an option-button card and POSTs the
// choice to /api/assistant/control-response, which resolves the promise. The
// answer is then fed back to the model as the tool's result. Mirrors the MCP
// relay pending-map, but keyed by the tool-call id instead of a relay id.
// Better Claude Code does NOT use this — it has its own native AskUserQuestion.
const ASK_USER_TIMEOUT_MS = 300_000; // 5 min → tool_result {error:"user did not answer"}

type AskUserOption = { label: string; description?: string };
type AskUserAnswer = { selected: string[]; other: string | null } | { error: string };

const askUserWaiters = new Map<string, { resolve: (v: AskUserAnswer) => void; timer: NodeJS.Timeout }>();

// Coerce a model-supplied options list into [{label, description?}], tolerating
// bare strings, dropping empties, and capping at 6 to keep the card scannable.
function normalizeAskOptions(raw: any): AskUserOption[] {
  if (!Array.isArray(raw)) return [];
  const out: AskUserOption[] = [];
  for (const o of raw) {
    if (out.length >= 6) break;
    if (typeof o === "string") {
      const label = o.trim();
      if (label) out.push({ label });
    } else if (o && typeof o === "object") {
      const label = String(o.label ?? "").trim();
      if (!label) continue;
      const description =
        typeof o.description === "string" && o.description.trim() ? o.description.trim() : undefined;
      out.push(description ? { label, description } : { label });
    }
  }
  return out;
}

// Park a promise for one ask_user tool call. Resolved by control-response, the
// 5-min timeout, or a stream abort (all via `finish`, which never rejects so the
// agentic loop can always continue with a result).
function awaitAskUser(id: string, signal?: AbortSignal): Promise<AskUserAnswer> {
  return new Promise<AskUserAnswer>((resolve) => {
    let settled = false;
    const finish = (v: AskUserAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      askUserWaiters.delete(id);
      resolve(v);
    };
    const timer = setTimeout(() => finish({ error: "user did not answer" }), ASK_USER_TIMEOUT_MS);
    const onAbort = () => finish({ error: "user did not answer" });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);
    askUserWaiters.set(id, { resolve: finish, timer });
  });
}

// ===========================================================================
// Tool-call dispatch — every tool runs server-side against underfit (:8791)
// ===========================================================================

async function* dispatchToolCall(
  id: string,
  name: string,
  args: any,
  signal?: AbortSignal,
): AsyncGenerator<Frame> {
  // ask_user blocks on a human answer rather than executing against underfit:
  // emit the interactive frame, wait for the orb's POST, feed the choice back.
  if (name === "ask_user") {
    const a = args || {};
    const options = normalizeAskOptions(a.options);
    if (options.length < 2) {
      yield {
        type: "tool_result",
        id,
        result: {
          content: JSON.stringify({ error: "ask_user needs 2-6 options; ask the user in plain text instead." }),
        },
      };
      return;
    }
    const multi_select = !!a.multi_select;
    const allow_other = a.allow_other === undefined ? true : !!a.allow_other;
    yield {
      type: "ask_user",
      id,
      question: String(a.question || "").trim(),
      options,
      multi_select,
      allow_other,
    };
    const answer = await awaitAskUser(id, signal);
    yield { type: "tool_result", id, result: { content: JSON.stringify(answer) } };
    return;
  }
  try {
    const data = await executeUnderfitTool(name, args || {});
    const content = typeof data === "string" ? data : JSON.stringify(data);
    yield { type: "tool_result", id, result: { content } };
  } catch (e: any) {
    yield { type: "tool_result", id, result: { content: JSON.stringify({ error: e?.message || String(e) }) } };
  }
}

// ===========================================================================
// Agentic tool loop — shared by the direct-API streamers
// ===========================================================================
//
// "Claude Code" (the CLI provider) loops natively: the MCP relay feeds tool
// results back to the running agent. The direct-API providers (OpenAI-compat
// and the Anthropic Messages API) historically emitted a single response and
// stopped — any tool call was fire-and-forget with no result channel. These
// helpers give them the SAME loop: emit `client_tool_call`, await the browser's
// result over the relay, feed it back to the provider API, and repeat until the
// model returns a final answer with no tool calls (capped below).

// High ceiling, not a functional cap: multi-step tool tasks on the direct-API
// providers (Gemini/OpenRouter/Anthropic) must not be cut short. Each iteration
// is a full LLM round-trip and every browser tool call is bounded by
// RELAY_TIMEOUT_MS, so this only guards against a pathological infinite loop.
const MAX_AGENT_ITERATIONS = 100;

type BrowserToolResult = { result?: any; error?: string; imageData?: string };

// Register a pending browser tool call on a relay session and return a promise
// that resolves when the browser POSTs the result to /api/mcp-relay/result (the
// same endpoint the Claude MCP relay uses). Mirrors that relay's pending-map
// contract: the result handler calls resolve({result|imageData}) or
// reject(Error). Resolves (never rejects) so the loop can always continue.
function awaitBrowserToolResult(
  session: ActiveSession,
  toolCallId: string,
  signal?: AbortSignal,
  timeoutMs = RELAY_TIMEOUT_MS,
): Promise<BrowserToolResult> {
  return new Promise<BrowserToolResult>((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (v: BrowserToolResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      session.pending.delete(toolCallId);
      resolve(v);
    };
    const timer = setTimeout(() => finish({ error: "Tool call timed out" }), timeoutMs);
    const onAbort = () => finish({ error: "aborted" });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);
    session.pending.set(toolCallId, {
      resolve: (r: any) => finish((r as BrowserToolResult) || {}),
      reject: (err: Error) => finish({ error: err.message }),
      timer,
    });
  });
}

// Collapse a browser/server tool result into a plain text payload suitable for a
// provider tool message (image results are surfaced separately by the caller).
function toolResultToText(r: BrowserToolResult): string {
  if (r.error) return JSON.stringify({ error: r.error });
  if (r.imageData) return "[Canvas screenshot captured and provided to you as an image.]";
  const v = r.result;
  if (v == null) return JSON.stringify({ ok: true });
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// Run one tool call inside the loop. Server-side tools execute here (their
// `tool_result` frame is surfaced and its content captured); client-side tools
// are relayed to the browser as a `client_tool_call` frame and the result is
// awaited via the pending map. Returns the resolved result for the API turn.
async function* runLoopToolCall(
  session: ActiveSession | null,
  id: string,
  name: string,
  args: any,
  signal?: AbortSignal,
): AsyncGenerator<Frame, BrowserToolResult> {
  let resolved: BrowserToolResult | null = null;
  for await (const frame of dispatchToolCall(id, name, args, signal)) {
    if (frame.type === "client_tool_call") {
      if (session) {
        // Register the pending promise BEFORE emitting so a fast browser result
        // cannot race ahead of the listener.
        const pending = awaitBrowserToolResult(session, id, signal);
        yield frame;
        resolved = await pending;
      } else {
        // No relay channel available — emit and treat as fire-and-forget.
        yield frame;
        resolved = { result: { ok: true } };
      }
    } else if (frame.type === "tool_result") {
      const content = (frame as any).result?.content;
      resolved = { result: content !== undefined ? content : (frame as any).result };
      yield frame;
    } else {
      yield frame;
    }
  }
  return resolved ?? { result: { ok: true } };
}

// ===========================================================================
// Streamer 1 — OpenAI-compatible (gemini, openai, grok, groq, openrouter,
//                                  ollama, lmstudio)
// ===========================================================================

async function* streamOpenAICompat(args: StreamArgs): AsyncGenerator<Frame> {
  const { messages, provider, model, apiKey, appState, screenshot, signal, toolSessionId } = args;
  const cfg = PROVIDERS[provider!];
  if (!cfg) {
    yield { type: "error", message: `Unknown provider: ${provider}` };
    return;
  }

  const useModel = normalizeModelIdForProvider(provider!, model || cfg.defaultModel);
  if (!useModel) {
    yield { type: "error", message: `No model specified for ${provider}. Local providers require an explicit model id.` };
    return;
  }

  const key = getApiKey(provider!, apiKey);
  if (!cfg.isLocal && !key) {
    yield { type: "error", message: `${cfg.envKey} not set. Provide an API key in the assistant settings.` };
    return;
  }

  const url = getChatUrl(provider!);
  let requestTools = openAICompatToolsForProvider(provider!, useModel);
  let toolsSupported = requestTools.length > 0;
  let imageInputSupported = providerSupportsImageInput(provider!, useModel);
  if (!imageInputSupported && screenshot) {
    appendLog(`[chat] dropped screenshot for ${provider}/${useModel}: model/provider does not advertise image input`);
  }
  const payloadMessages = buildOpenAIMessages(
    buildSystemInstruction(appState, toolsSupported, imageInputSupported),
    messages,
    imageInputSupported ? screenshot : undefined,
  );

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  if (provider === "openrouter" || provider === "openrouter-free") {
    headers["HTTP-Referer"] = "https://vst-foundry.local";
    headers["X-Title"] = "VST Foundry Assistant";
  }

  yield { type: "status", message: `Connecting to ${cfg.label} (${useModel})...` };
  if (!toolsSupported) {
    const reason = shouldSendOpenAICompatTools(provider!, useModel).reason || "No compatible tool schema is available for this provider/model.";
    yield { type: "status", message: `${reason} Continuing without live app tools.` };
    appendLog(`[chat] tools disabled provider=${provider} model=${useModel}: ${reason}`);
  } else if (!imageInputSupported) {
    appendLog(`[chat] image tool disabled provider=${provider} model=${useModel}`);
  }

  const session = toolSessionId ? activeSessions.get(toolSessionId) ?? null : null;
  let lastUsage: any = null;

  // Agentic loop: call the API, run any tool calls, feed results back, repeat
  // until the model returns a final answer with no tool calls (or the cap).
  for (let iter = 0; iter < MAX_AGENT_ITERATIONS; iter++) {
    if (signal?.aborted) return;

    const body: any = {
      model: useModel,
      messages: payloadMessages,
      stream: true,
      ...(toolsSupported ? { tools: requestTools } : {}),
    };
    if (provider === "gemini" && toolsSupported) {
      body.tool_choice = "auto";
    }
    if ((provider === "openrouter" || provider === "openrouter-free") && toolsSupported) {
      body.provider = {
        ...(body.provider || {}),
        require_parameters: true,
      };
    }

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      if (cfg.isLocal) {
        yield { type: "error", message: `${cfg.label} is not running at ${cfg.baseUrl}` };
      } else {
        yield { type: "error", message: `Cannot connect to ${cfg.label}: ${e?.message || e}` };
      }
      yield { type: "done" };
      return;
    }

    if (!resp.ok) {
      const errText = await resp.text();
      if (provider === "gemini" && isGeminiGenericInvalidArgument(resp.status, errText) && imageInputSupported && messagesHaveImageContent(payloadMessages)) {
        imageInputSupported = false;
        requestTools = requestTools.filter((tool) => openAIToolName(tool) !== "captureCanvasScreenshot");
        payloadMessages[0] = {
          role: "system",
          content: buildSystemInstruction(appState, toolsSupported, false),
        };
        stripImageContent(payloadMessages);
        yield { type: "status", message: `${cfg.label} rejected the image payload; retrying with tools but without screenshots.` };
        appendLog(
          `[chat] gemini retry without images provider=${provider} model=${useModel} status=${resp.status} response=${errText.slice(0, 300)} summary=${JSON.stringify(openAICompatRequestSummary(body)).slice(0, 1200)}`,
        );
        iter--;
        continue;
      }
      if (toolsSupported && isToolCapabilityError(resp.status, errText)) {
        // Provider doesn't support tools — retry this turn without them. Don't
        // consume a loop iteration on the capability downgrade.
        toolsSupported = false;
        requestTools = [];
        payloadMessages[0] = {
          role: "system",
          content: buildSystemInstruction(appState, false, false),
        };
        yield { type: "status", message: `${cfg.label} rejected tool schemas; retrying without live app tools.` };
        appendLog(
          `[chat] provider rejected tools provider=${provider} model=${useModel} status=${resp.status} response=${errText.slice(0, 300)} summary=${JSON.stringify(openAICompatRequestSummary(body)).slice(0, 1200)}`,
        );
        iter--;
        continue;
      }
      if (imageInputSupported && isImageInputCapabilityError(resp.status, errText)) {
        imageInputSupported = false;
        requestTools = requestTools.filter((tool) => openAIToolName(tool) !== "captureCanvasScreenshot");
        payloadMessages[0] = {
          role: "system",
          content: buildSystemInstruction(appState, toolsSupported, false),
        };
        stripImageContent(payloadMessages);
        yield { type: "status", message: `${cfg.label} rejected image input; retrying without screenshots.` };
        appendLog(
          `[chat] provider rejected image input provider=${provider} model=${useModel} status=${resp.status} response=${errText.slice(0, 300)} summary=${JSON.stringify(openAICompatRequestSummary(body)).slice(0, 1200)}`,
        );
        iter--;
        continue;
      }
      appendLog(
        `[chat] provider rejected request provider=${provider} model=${useModel} status=${resp.status} response=${errText.slice(0, 500)} summary=${JSON.stringify(openAICompatRequestSummary(body)).slice(0, 1600)}`,
      );
      yield { type: "error", message: `${cfg.label} ${resp.status}: ${errText.slice(0, 500)}` };
      yield { type: "done" };
      return;
    }

    const collected = yield* parseOpenAIStreamCollect(resp, signal);
    if (collected.usage) lastUsage = collected.usage;

    const toolCalls = collected.toolCalls;
    if (!toolCalls.length) {
      // Final answer — preserves single-turn behavior when no tools are called.
      yield { type: "done", ...(normalizeUsage(lastUsage) ? { usage: normalizeUsage(lastUsage) } : {}) };
      return;
    }

    // Record the assistant turn (text + tool_calls) in the running transcript.
    payloadMessages.push({
      role: "assistant",
      content: collected.text || null,
      tool_calls: toolCalls.map((tc) => {
        const toolCall: any = {
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments || "{}" },
        };
        if (provider === "gemini" && tc.thoughtSignature) {
          toolCall.extra_content = { google: { thought_signature: tc.thoughtSignature } };
        }
        return toolCall;
      }),
    });

    // Execute each tool call, emit frames, and append the results as tool
    // messages so the next API turn can consume them.
    const imageFollowUps: any[] = [];
    for (const tc of toolCalls) {
      if (signal?.aborted) return;
      const r = yield* runLoopToolCall(session, tc.id, tc.name, tc.parsed, signal);
      payloadMessages.push({ role: "tool", tool_call_id: tc.id, content: toolResultToText(r) });
      if (r.imageData) {
        imageFollowUps.push({
          type: "image_url",
          image_url: { url: `data:image/png;base64,${r.imageData}` },
        });
      }
    }
    // OpenAI tool messages can't carry images, so surface any captured
    // screenshot as a follow-up user turn (mirrors the legacy resubmit).
    if (imageFollowUps.length && imageInputSupported) {
      payloadMessages.push({
        role: "user",
        content: [{ type: "text", text: "Here is the requested canvas screenshot." }, ...imageFollowUps],
      });
    }
  }

  // Iteration cap reached without a tool-free final answer.
  yield { type: "done", ...(normalizeUsage(lastUsage) ? { usage: normalizeUsage(lastUsage) } : {}) };
}

// Parse an OpenAI-compatible SSE stream, yielding text/thinking frames and
// returning the accumulated tool calls + final text + usage for the agentic
// loop (tool dispatch is handled by the caller, not here).
async function* parseOpenAIStreamCollect(
  resp: Response,
  signal?: AbortSignal,
): AsyncGenerator<
  Frame,
  { toolCalls: Array<{ id: string; name: string; arguments: string; parsed: any; thoughtSignature?: string }>; text: string; usage: any }
> {
  if (!resp.body) return { toolCalls: [], text: "", usage: null };
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolAcc: Record<number, { id: string; name: string; arguments: string; thoughtSignature?: string }> = {};
  let usage: any = null;
  let text = "";

  const assemble = () => ({
    toolCalls: Object.keys(toolAcc)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => toolAcc[Number(k)])
      .filter((tc) => tc.name)
      .map((tc) => {
        let parsed: any = {};
        try {
          parsed = tc.arguments ? JSON.parse(tc.arguments) : {};
        } catch {
          parsed = {};
        }
          return {
            id: tc.id || `call_${Math.random().toString(36).slice(2, 10)}`,
            name: tc.name,
            arguments: tc.arguments,
            ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
            parsed,
          };
      }),
    text,
    usage,
  });

  try {
    while (true) {
      if (signal?.aborted) return assemble();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line || line === "data: [DONE]") continue;
        if (!line.startsWith("data:")) continue;

        let data: any;
        try {
          data = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }

        if (data.usage) usage = data.usage;
        const choice = data.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta || {};
        if (delta.content) {
          text += delta.content;
          yield { type: "text_delta", text: delta.content };
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolAcc[i]) toolAcc[i] = { id: tc.id || "", name: "", arguments: "" };
            if (tc.id) toolAcc[i].id = tc.id;
            const fn = tc.function || {};
            if (fn.name) toolAcc[i].name = fn.name;
            if (fn.arguments) toolAcc[i].arguments += fn.arguments;
            const thoughtSignature =
              tc.extra_content?.google?.thought_signature ||
              tc.extra_content?.google?.thoughtSignature ||
              tc.thought_signature ||
              tc.thoughtSignature ||
              fn.thought_signature ||
              fn.thoughtSignature;
            if (thoughtSignature) toolAcc[i].thoughtSignature = thoughtSignature;
          }
        }
        // Keep reading past finish_reason so trailing usage chunks are captured;
        // the stream closes (done) immediately after for compliant providers.
      }
    }
  } catch (e: any) {
    if (e?.name === "AbortError") return assemble();
    yield { type: "error", message: e?.message || String(e) };
  }

  return assemble();
}

// ===========================================================================
// Streamer 2 — Anthropic Messages API
// ===========================================================================

async function* streamAnthropic(args: StreamArgs): AsyncGenerator<Frame> {
  const { messages, model, apiKey, appState, screenshot, signal, toolSessionId } = args;
  const cfg = PROVIDERS["anthropic"];

  const key = getApiKey("anthropic", apiKey);
  if (!key) {
    yield { type: "error", message: "ANTHROPIC_API_KEY not set. Provide an API key in the assistant settings." };
    return;
  }

  const useModel = normalizeModelIdForProvider("anthropic", model || cfg.defaultModel);
  const systemText = buildSystemInstruction(appState);
  const anthMessages = buildAnthropicMessages(messages, screenshot);
  if (!anthMessages.length) {
    yield { type: "error", message: "No user/assistant messages provided" };
    return;
  }

  const url = `${cfg.baseUrl}/v1/messages`;
  const headers: Record<string, string> = {
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };

  yield { type: "status", message: `Connecting to Anthropic (${useModel})...` };

  const session = toolSessionId ? activeSessions.get(toolSessionId) ?? null : null;
  const usageTotal = { input_tokens: 0, output_tokens: 0 };

  // Agentic loop: call the API, run any tool_use blocks, feed the results back
  // as tool_result blocks, repeat until a tool-free final answer (or the cap).
  for (let iter = 0; iter < MAX_AGENT_ITERATIONS; iter++) {
    if (signal?.aborted) return;

    const body: any = {
      model: useModel,
      system: systemText,
      messages: anthMessages,
      max_tokens: 4096,
      stream: true,
      tools: ANTHROPIC_TOOLS,
    };

    let resp: Response;
    try {
      resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      yield { type: "error", message: `Cannot connect to Anthropic: ${e?.message || e}` };
      yield { type: "done" };
      return;
    }

    if (!resp.ok) {
      const errText = await resp.text();
      yield { type: "error", message: `Anthropic ${resp.status}: ${errText.slice(0, 500)}` };
      yield { type: "done" };
      return;
    }

    const collected = yield* parseAnthropicStreamCollect(resp, signal);
    usageTotal.input_tokens += collected.usage.input_tokens || 0;
    usageTotal.output_tokens += collected.usage.output_tokens || 0;

    if (!collected.toolCalls.length) {
      // Final answer — preserves single-turn behavior when no tools are called.
      yield { type: "done", usage: usageTotal };
      return;
    }

    // Record the assistant turn (text + tool_use blocks) verbatim.
    const assistantContent: any[] = [];
    if (collected.text) assistantContent.push({ type: "text", text: collected.text });
    for (const tc of collected.toolCalls) {
      assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
    }
    anthMessages.push({ role: "assistant", content: assistantContent });

    // Execute tools and feed every result back in a single user turn.
    const toolResultBlocks: any[] = [];
    for (const tc of collected.toolCalls) {
      if (signal?.aborted) return;
      const r = yield* runLoopToolCall(session, tc.id, tc.name, tc.input, signal);
      const block: any = { type: "tool_result", tool_use_id: tc.id };
      if (r.error) {
        block.content = JSON.stringify({ error: r.error });
        block.is_error = true;
      } else if (r.imageData) {
        block.content = [
          { type: "text", text: "Canvas screenshot:" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: r.imageData } },
        ];
      } else {
        block.content = toolResultToText({ result: r.result });
      }
      toolResultBlocks.push(block);
    }
    anthMessages.push({ role: "user", content: toolResultBlocks });
  }

  // Iteration cap reached without a tool-free final answer.
  yield { type: "done", usage: usageTotal };
}

// Parse an Anthropic Messages SSE stream, yielding text/thinking frames and
// returning the accumulated tool_use blocks + final text + usage for the
// agentic loop (tool dispatch is handled by the caller, not here).
async function* parseAnthropicStreamCollect(
  resp: Response,
  signal?: AbortSignal,
): AsyncGenerator<
  Frame,
  {
    toolCalls: Array<{ id: string; name: string; input: any }>;
    text: string;
    usage: { input_tokens: number; output_tokens: number };
    stopReason: string | null;
  }
> {
  const usage = { input_tokens: 0, output_tokens: 0 };
  let text = "";
  let stopReason: string | null = null;
  // Track every content block by index so multiple parallel tool_use blocks are
  // captured (the previous single-toolAcc only handled one tool per turn).
  const blocks: Record<number, { type: string; id?: string; name?: string; json: string }> = {};

  const assemble = () => ({
    toolCalls: Object.keys(blocks)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => blocks[Number(k)])
      .filter((b) => b.type === "tool_use" && b.name)
      .map((b) => {
        let input: any = {};
        try {
          input = b.json ? JSON.parse(b.json) : {};
        } catch {
          input = {};
        }
        return { id: b.id || `toolu_${Math.random().toString(36).slice(2, 10)}`, name: b.name as string, input };
      }),
    text,
    usage,
    stopReason,
  });

  if (!resp.body) return assemble();
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) return assemble();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        if (line.startsWith("event:")) continue;
        if (!line.startsWith("data:")) continue;

        let data: any;
        try {
          data = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }

        const t = data.type;
        if (t === "content_block_start") {
          const idx = data.index ?? 0;
          const cb = data.content_block || {};
          if (cb.type === "tool_use") {
            blocks[idx] = { type: "tool_use", id: cb.id || "", name: cb.name || "", json: "" };
          } else {
            blocks[idx] = { type: cb.type || "text", json: "" };
          }
        } else if (t === "content_block_delta") {
          const idx = data.index ?? 0;
          const d = data.delta || {};
          if (d.type === "text_delta" && d.text) {
            text += d.text;
            yield { type: "text_delta", text: d.text };
          } else if (d.type === "thinking_delta" && d.thinking) {
            yield { type: "thinking", text: d.thinking };
          } else if (d.type === "input_json_delta") {
            if (blocks[idx]) blocks[idx].json += d.partial_json || "";
          }
        } else if (t === "message_start") {
          const u = data.message?.usage;
          if (u?.input_tokens) usage.input_tokens = u.input_tokens;
        } else if (t === "message_delta") {
          const u = data.usage;
          if (u?.output_tokens) usage.output_tokens = u.output_tokens;
          if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
        } else if (t === "message_stop") {
          return assemble();
        } else if (t === "error") {
          yield { type: "error", message: data.error?.message || "Anthropic stream error" };
        }
      }
    }
  } catch (e: any) {
    if (e?.name === "AbortError") return assemble();
    yield { type: "error", message: e?.message || String(e) };
  }

  return assemble();
}

// ===========================================================================
// Streamer 3 — Claude Code CLI (PERSISTENT per-conversation session, stream-json I/O)
// ===========================================================================

// Normalize a tool_result's polymorphic `content` (string | [{text}] | other)
// into a display string. Ported verbatim from BCC (resolveToolResultText).
function resolveToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c: any) => c?.text ?? "").join("\n");
  return JSON.stringify(content ?? "");
}

function* parseClaudeEvent(data: any): Generator<Frame> {
  const t = data?.type;

  // Partial-message stream events nest the real event under `event`.
  if (t === "stream_event" && data.event && typeof data.event === "object") {
    yield* parseClaudeEvent(data.event);
    return;
  }

  if (t === "system" && data.subtype === "init") {
    if (data.session_id) yield { type: "session_id", sessionId: data.session_id };
    // Surface the CLI's ACTUAL model (may differ from the requested alias) so
    // the orb can show what's really running (BCC reads this from init too).
    if (data.model) yield { type: "model", model: String(data.model) };
    return;
  }

  if (t === "assistant") {
    // Text + thinking stream via content_block_delta (below). Here we surface
    // ONLY tool_use blocks — DISPLAY-ONLY frames the orb renders as tool bubbles
    // (BCC parity). These are DISTINCT from the MCP relay's `client_tool_call`
    // (tc_ id) frames, which remain the authoritative EXECUTION channel for
    // canvas tools. The orb never EXECUTES a `tool_use` frame (it only renders
    // it), so this cannot re-introduce the old duplicate-execution / "Unknown
    // tool" flashes that motivated dropping these before. Claude's internal
    // tools (Read/Bash/Edit/Task/…) now show up too, exactly like in BCC.
    // `parent_tool_use_id` marks events from a SUB-AGENT (a Task/Agent spawn).
    // BCC routes these into a separate nested transcript so they never pollute
    // the main turn. We tag the frame with `parentToolId` so the orb can nest
    // the sub-agent's tools under its Task card instead of the main list.
    const parentToolId = typeof data.parent_tool_use_id === "string" ? data.parent_tool_use_id : "";
    const content = data.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "tool_use") {
          yield {
            type: "tool_use",
            toolId: block.id || "",
            name: block.name || "tool",
            inputJson: JSON.stringify(block.input ?? {}),
            parentToolId,
          };
        } else if (block?.type === "redacted_thinking") {
          // Redacted reasoning has no thinking_delta to stream — surface a
          // placeholder so the user knows the model reasoned here (BCC parity).
          yield { type: "thinking", text: "\n[reasoning redacted]\n" };
        }
      }
    }
    return;
  }

  if (t === "user") {
    // Tool RESULTS come back as a `user` message whose content carries
    // tool_result blocks. Surface them DISPLAY-ONLY so the orb can pair each
    // result with its tool_use bubble (BCC parity). `content` is polymorphic.
    // `parent_tool_use_id` (sub-agent) is tagged so the result nests correctly.
    const parentToolId = typeof data.parent_tool_use_id === "string" ? data.parent_tool_use_id : "";
    const content = data.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "tool_result") {
          yield {
            type: "tool_result",
            toolId: block.tool_use_id || "",
            content: resolveToolResultText(block.content),
            isError: !!block.is_error,
            parentToolId,
          };
        }
      }
    }
    return;
  }

  if (t === "control_request") {
    // The CLI is asking the USER something: AskUserQuestion (multiple choice) or
    // a `can_use_tool` permission prompt. Forward it verbatim so the orb can
    // render a question card and POST the answer back as a control_response
    // (see POST /api/assistant/control-response). The CLI is BLOCKED on stdin
    // until we reply — the turn stays busy meanwhile, so this must reach the
    // live SSE mid-turn.
    yield {
      type: "control_request",
      requestId: String(data.request_id ?? ""),
      request: data.request ?? {},
    };
    return;
  }

  if (t === "control_cancel_request") {
    // The CLI retracted a pending prompt (already answered / superseded).
    yield { type: "control_cancel", requestId: String(data.request_id ?? "") };
    return;
  }

  if (t === "content_block_delta") {
    const d = data.delta || {};
    if (d.type === "text_delta" && d.text) {
      yield { type: "text_delta", text: d.text };
    } else if (d.type === "thinking_delta" && d.thinking) {
      yield { type: "thinking", text: d.thinking };
    }
    return;
  }

  if (t === "result") {
    // Surface the full per-turn accounting BCC shows: token usage (incl. cache),
    // cumulative session cost (total_cost_usd — the orb deltas it per turn),
    // wall-clock duration, and whether the turn ERRORED (is_error). Previously
    // only bare in/out tokens survived and the orb dropped even those.
    const u = data.usage || {};
    yield {
      type: "done",
      usage: {
        input_tokens: u.input_tokens || 0,
        output_tokens: u.output_tokens || 0,
        cache_read_input_tokens: u.cache_read_input_tokens || 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
      },
      totalCostUsd: typeof data.total_cost_usd === "number" ? data.total_cost_usd : undefined,
      durationMs: typeof data.duration_ms === "number" ? data.duration_ms : undefined,
      isError: !!data.is_error,
      numTurns: typeof data.num_turns === "number" ? data.num_turns : undefined,
    };
    return;
  }
}

function buildClaudePrompt(messages: ChatMessage[], appState: any, resume: boolean): string {
  const sys = buildSystemInstruction(appState);
  let bodyText: string;
  if (resume) {
    const lastUser = [...messages].reverse().find((m) => normalizeRole(m.role) === "user");
    bodyText = lastUser ? extractText(lastUser.content) : "";
  } else {
    bodyText = messages
      .map((m) => `${normalizeRole(m.role)}: ${extractText(m.content)}`)
      .join("\n\n");
  }
  return `${sys}\n\n---\n\n${bodyText}`;
}

// =============================================================================
// Streamer 3 — Claude Code CLI: PERSISTENT per-conversation session.
// -----------------------------------------------------------------------------
// Ported from the proven better-claude-code (BCC) mechanism: ONE long-lived
// `claude` child PER conversationId, spawned once with
//   -p --input-format stream-json --output-format stream-json --verbose
//   --include-partial-messages
// and then kept alive across turns. Each user turn is a single NDJSON line
// written to the SAME stdin (NO stdin.end() between turns); turn completion is
// the real `{"type":"result"}` event (mapped to a `done` frame by
// parseClaudeEvent), with a child-`close` fallback. The vst-foundry MCP child
// (mcp-server.cjs) therefore lives for the whole conversation instead of being
// re-spawned and killed every message — which is what made MCP "disconnect"
// every turn on the old per-message path.
//
// The old per-message streamClaude is preserved verbatim in
//   deprecated/streamClaude-per-message-20260628.ts.txt
// and the full prior server.ts in  server.ts.bak-persist-20260628 .
// =============================================================================

const MAX_CLAUDE_SESSIONS = 8; // live persistent children cap (LRU-reaped above this)
const CLAUDE_SESSION_IDLE_MS = 15 * 60 * 1000; // reap a session idle longer than this
const CLAUDE_REAP_INTERVAL_MS = 60 * 1000; // idle-reaper tick
const CLAUDE_HEARTBEAT_MS = 15 * 1000; // SSE keepalive comment cadence during a turn
// Inactivity (NOT total-duration) watchdog for a busy turn. Re-armed on EVERY
// stdout frame, so a productive long task (which streams frames continuously)
// NEVER trips it — only a genuine upstream stall with no output for this long
// does, letting the wedged turn self-heal so its session can be reaped.
const CLAUDE_TURN_STALL_MS = 300_000; // 5 min of stdout silence while busy

// One persistent Claude CLI child per conversation. `relayEntry` is the SAME
// object stored in `activeSessions` under `relayId` (and aliased under Claude's
// session_id) so the MCP relay endpoints resolve in-turn tool calls; its
// `sseRes` is re-pointed at the current turn's response on every turn.
interface ClaudeSession {
  proc: ChildProcess;
  relayId: string;
  conversationId: string;
  claudeSessionId: string | null;
  mcpConfigPath: string;
  mcpConfigWritten: boolean;
  model: string;
  effort: string;
  activeSse: ExpressResponse | null;
  stdoutBuf: string;
  stderr: string;
  busy: boolean;
  lastActivity: number;
  relayEntry: ActiveSession;
  aliasedSids: Set<string>;
  turnResolver: (() => void) | null;
  firstTurnPending: boolean;
  interruptSeq: number;
  heartbeat: ReturnType<typeof setInterval> | null;
  // Turn generation token (FIX 2). `turnGen` is bumped at the START of every turn;
  // `resultGen` is bumped each time a `result`-derived `done` frame is consumed.
  // A `result` legitimately ends the turn only when resultGen === turnGen while
  // busy; a stale `result` from an interrupted/superseded turn satisfies
  // resultGen < turnGen and is DRAINED as a no-op so it cannot end the NEXT turn.
  turnGen: number;
  resultGen: number;
  // Inactivity watchdog (FIX 3): re-armed on every stdout frame while busy. Fires
  // only on a true upstream stall (no stdout for CLAUDE_TURN_STALL_MS), never on a
  // productive long task (those emit frames regularly).
  stallTimer: ReturnType<typeof setTimeout> | null;
  // FIFO turn queue (BCC parity). A turn that arrives while this session is busy is
  // NOT rejected with 409 (BCC never does that — sending mid-turn just queues the
  // message). Instead the route parks here and is released, in arrival order, the
  // moment the in-flight turn finishes. Each entry is a one-shot resolver for a
  // route awaiting its slot.
  idleWaiters: Array<() => void>;
}

// Release every route parked behind a busy turn (BCC parity: one turn at a time,
// queued not rejected). Called wherever a turn ends and `busy` drops to false.
// Resolvers fire in arrival order; the first to re-check `busy` claims the slot
// (synchronously, before any await), so the rest re-park behind the new turn.
function releaseClaudeIdleWaiters(session: ClaudeSession): void {
  if (!session.idleWaiters.length) return;
  const waiters = session.idleWaiters;
  session.idleWaiters = [];
  for (const wake of waiters) {
    try { wake(); } catch {}
  }
}

const claudeSessions = new Map<string, ClaudeSession>();
// Secondary index: Claude's own session_id -> our conversationId key. Lets a
// turn that arrives with only a claudeSessionId (e.g. conversationId lost) still
// resolve its live persistent session.
const claudeSidToConversation = new Map<string, string>();

function isClaudeProcAlive(proc: ChildProcess): boolean {
  return proc.exitCode === null && !proc.killed && !!proc.stdin && !proc.stdin.destroyed;
}

// Base CLI args (no resume / no mcp-config). EXACT set + order from the proven
// per-message path — do NOT reorder or drop -p/--verbose/--include-partial-messages.
function buildClaudeBaseArgs(useModel: string, useEffort: string): string[] {
  const cmdArgs = [
    "--model", useModel,
    "--dangerously-skip-permissions",
    "--permission-prompt-tool", "stdio",
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];
  if (CLAUDE_VALID_EFFORTS.includes(useEffort)) cmdArgs.push("--effort", useEffort);
  // No --max-turns: the CLI has no such flag (v2.1.195) and must run the agentic
  // turn to completion — the agent takes as many tool steps as the task needs.
  return cmdArgs;
}

function writeClaudeMcpConfig(relayId: string, mcpConfigPath: string): boolean {
  try {
    const mcpConfig = {
      mcpServers: {
        // underfit's own MCP (21 tools). It calls underfit's dashboard API on
        // :8791 DIRECTLY (no browser relay), so it takes only the port arg;
        // relayId is unused here (Foundry used it for its canvas relay).
        underfit: {
          command: "node",
          args: [
            process.env.UNDERFIT_MCP_PATH ||
              "C:\\Users\\skream\\projects\\underfit\\mcp-server.cjs",
            process.env.UNDERFIT_DASHBOARD_PORT || "8791",
          ],
          env: {},
        },
      },
    };
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));
    return true;
  } catch (e: any) {
    appendLog(`[MCP] Failed to write mcp-config for ${relayId}: ${e?.message || e}`);
    return false;
  }
}

function writeFrameToActiveSse(session: ClaudeSession, frame: Frame): void {
  const res = session.activeSse;
  if (!res || res.writableEnded) return;
  try {
    res.write(`data: ${JSON.stringify(frame)}\n\n`);
  } catch (e: any) {
    appendLog(`[Claude] SSE write failed conv=${session.conversationId}: ${e?.message || e}`);
  }
}

// SSE keepalive: an EventSource-ignored comment line written periodically while a
// turn is in flight, so a long silent thinking/tool phase never looks idle. Has
// no overall timeout to fight (httpServer.timeout/requestTimeout are 0) — this is
// belt-and-suspenders for the core product path.
function stopClaudeHeartbeat(session: ClaudeSession): void {
  if (session.heartbeat) {
    clearInterval(session.heartbeat);
    session.heartbeat = null;
  }
}

function startClaudeHeartbeat(session: ClaudeSession): void {
  stopClaudeHeartbeat(session);
  session.heartbeat = setInterval(() => {
    const res = session.activeSse;
    if (!res || res.writableEnded) return;
    try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
  }, CLAUDE_HEARTBEAT_MS);
}

// Inactivity watchdog (FIX 3). Clears any prior timer. While a turn is busy this
// is re-armed on every stdout frame, so it only fires when the upstream model
// truly stalls (no stdout for CLAUDE_TURN_STALL_MS). On fire: interrupt the
// wedged turn and finish it (viaStall) so the SSE closes, the awaiting route
// returns, and the session drops to idle and becomes reapable. Does NOT cap a
// productive long task — those stream frames and keep re-arming the timer.
function clearClaudeStallWatchdog(session: ClaudeSession): void {
  if (session.stallTimer) {
    clearTimeout(session.stallTimer);
    session.stallTimer = null;
  }
}

function armClaudeStallWatchdog(session: ClaudeSession): void {
  clearClaudeStallWatchdog(session);
  session.stallTimer = setTimeout(() => {
    session.stallTimer = null;
    if (!session.busy) return;
    appendLog(
      `[Claude] turn STALL self-heal conv=${session.conversationId} ` +
        `(no stdout for ${Math.round(CLAUDE_TURN_STALL_MS / 1000)}s while busy) — interrupting + finishing`,
    );
    writeClaudeInterrupt(session);
    finishClaudeTurn(session, { viaClose: true, viaStall: true });
  }, CLAUDE_TURN_STALL_MS);
}

// End the in-flight turn: optionally emit a synthetic done (only when the child
// died without a `result`), detach the SSE, mark idle, end the response, and
// release the route awaiting turn completion. Does NOT kill the child.
function finishClaudeTurn(
  session: ClaudeSession,
  opts: { viaClose: boolean; exitCode?: number | null; viaStall?: boolean },
): void {
  if (!session.busy && !opts.viaClose) return;
  stopClaudeHeartbeat(session);
  clearClaudeStallWatchdog(session);
  if (opts.viaStall) {
    writeFrameToActiveSse(session, {
      type: "error",
      message: "The turn stalled (no output for several minutes) and was ended so the assistant can continue.",
    });
  }
  const res = session.activeSse;
  if (opts.viaClose && res && !res.writableEnded) {
    const code = opts.exitCode;
    if (code && code !== 0 && session.stderr.trim()) {
      writeFrameToActiveSse(session, {
        type: "error",
        message: `Claude CLI exited with code ${code}: ${session.stderr.slice(0, 500)}`,
      });
    }
    writeFrameToActiveSse(session, { type: "done" });
  }
  session.activeSse = null;
  session.busy = false;
  session.lastActivity = Date.now();
  const resolver = session.turnResolver;
  session.turnResolver = null;
  if (res && !res.writableEnded) {
    try { res.end(); } catch {}
  }
  if (resolver) resolver();
  // BCC parity: the slot just freed — wake the next queued turn (if any).
  releaseClaudeIdleWaiters(session);
}

// Interrupt the running turn over stdin (control_request) — the BCC clear/stop
// mechanism. We do NOT kill the child; it stays warm for the next turn.
function writeClaudeInterrupt(session: ClaudeSession): void {
  try {
    const requestId = `int_${++session.interruptSeq}`;
    const payload = { type: "control_request", request_id: requestId, request: { subtype: "interrupt" } };
    session.proc.stdin?.write(JSON.stringify(payload) + "\n");
    appendLog(`[Claude] sent interrupt ${requestId} conv=${session.conversationId}`);
  } catch (e: any) {
    appendLog(`[Claude] failed to write interrupt conv=${session.conversationId}: ${e?.message || e}`);
  }
}

// Route ONE parsed stdout line's frames to the live SSE. Captures Claude's
// session_id (for --resume + tool-result aliasing) and treats the `done` frame
// (derived from the real `result` event) as authoritative turn-end.
// Pending UI-INITIATED control requests (get_context_usage / set_permission_mode)
// awaiting the CLI's control_response, keyed by the request_id we minted. Mirrors
// BCC's controlResolvers map; resolved from the stdout handler below.
const claudeControlWaiters = new Map<string, { resolve: (v: any) => void; timer: NodeJS.Timeout }>();

function handleClaudeStdoutLine(session: ClaudeSession, data: any, rawLine: string): void {
  const rawType = data?.type;
  // A control_response FROM the CLI answers a UI-initiated control_request
  // (get_context_usage etc.). Match it to its pending waiter by request_id and
  // resolve — it does NOT belong to the turn's SSE stream. (The answer we send
  // TO the CLI for can_use_tool/AskUserQuestion is a separate outbound write.)
  if (rawType === "control_response") {
    const rid = data.response?.request_id;
    const waiter = rid ? claudeControlWaiters.get(rid) : undefined;
    if (waiter) {
      claudeControlWaiters.delete(rid);
      clearTimeout(waiter.timer);
      waiter.resolve(data.response);
    }
    return;
  }
  const innerType = rawType === "stream_event" && data.event ? data.event.type : rawType;
  if (innerType === "result" || innerType === "error" || innerType === "assistant" || innerType === "system") {
    appendLog(`[Claude raw ${innerType}] ${rawLine.slice(0, 700)}`);
  }
  for (const frame of parseClaudeEvent(data)) {
    if (frame.type === "session_id") {
      const sid = (frame as any).sessionId as string | undefined;
      if (sid) {
        knownClaudeSessions.add(sid);
        session.claudeSessionId = sid;
        claudeSidToConversation.set(sid, session.conversationId);
        if (!session.aliasedSids.has(sid)) {
          session.aliasedSids.add(sid);
          // Alias the relay entry under Claude's session_id for the LIFE of the
          // session: the browser POSTs tool results keyed by session_id, but the
          // relay registers the channel under relayId. Without this every tool
          // call times out -> empty turn -> the "completed adjustments" fallback.
          activeSessions.set(sid, session.relayEntry);
          appendLog(`[Claude] aliased relay ${session.relayId} -> ${sid} (tool-result routing)`);
        }
      }
      writeFrameToActiveSse(session, frame); // orb stores claudeSessionId for --resume
      continue;
    }
    if (frame.type === "client_tool_call") {
      appendLog(`[Claude] client_tool_call name=${(frame as any).name} id=${(frame as any).id}`);
      writeFrameToActiveSse(session, frame);
      continue;
    }
    if (frame.type === "error") {
      appendLog(`[Claude] error frame: ${(frame as any).message}`);
      writeFrameToActiveSse(session, frame);
      continue;
    }
    if (frame.type === "done") {
      // FIX 2: the `done` frame derives from the CLI's `result` event, which
      // carries no turn identity. Match it FIFO against the turn generation:
      // consume one result generation, and only end the turn if this result
      // belongs to the CURRENT busy turn (resultGen === turnGen). A result from
      // an interrupted/superseded turn (resultGen < turnGen) is DRAINED — we do
      // NOT write to the newer turn's SSE and do NOT resolve its await.
      session.resultGen++;
      if (session.busy && session.resultGen === session.turnGen) {
        writeFrameToActiveSse(session, frame);
        finishClaudeTurn(session, { viaClose: false }); // authoritative result-driven turn-end
      } else {
        appendLog(
          `[Claude] draining stale result conv=${session.conversationId} ` +
            `resultGen=${session.resultGen} turnGen=${session.turnGen} busy=${session.busy}`,
        );
      }
      continue;
    }
    if (frame.type === "control_request") {
      const r: any = (frame as any).request || {};
      appendLog(
        `[Claude] control_request id=${(frame as any).requestId} ` +
          `subtype=${r.subtype} tool=${r.tool_name} conv=${session.conversationId}`,
      );
      writeFrameToActiveSse(session, frame);
      continue;
    }
    writeFrameToActiveSse(session, frame);
  }
}

// Attach stdout/stderr/error/close handlers to a child. Every handler carries a
// stale-proc guard (`session.proc !== proc`) so a respawned session's OLD child
// handlers no-op. Called once per child (create + respawn).
function attachClaudeHandlers(session: ClaudeSession): void {
  const proc = session.proc;
  proc.on("error", (err) => {
    if (session.proc !== proc) return;
    appendLog(`[Claude CLI] spawn error conv=${session.conversationId}: ${err.message}`);
  });
  proc.stdout?.on("data", (chunk: Buffer) => {
    if (session.proc !== proc) return; // stale-proc guard
    if (session.busy) armClaudeStallWatchdog(session); // FIX 3: reset inactivity watchdog on every frame
    session.stdoutBuf += chunk.toString();
    let nl: number;
    while ((nl = session.stdoutBuf.indexOf("\n")) !== -1) {
      const line = session.stdoutBuf.slice(0, nl).trim();
      session.stdoutBuf = session.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let data: any;
      try { data = JSON.parse(line); } catch { continue; }
      try { handleClaudeStdoutLine(session, data, line); }
      catch (e: any) { appendLog(`[Claude] stdout handler threw conv=${session.conversationId}: ${e?.message || e}`); }
    }
  });
  proc.stderr?.on("data", (c: Buffer) => {
    if (session.proc !== proc) return;
    session.stderr = (session.stderr + c.toString()).slice(-4000);
  });
  proc.on("close", (code) => {
    if (session.proc !== proc) return; // a respawn replaced this child — ignore its death
    appendLog(`[Claude] child closed conv=${session.conversationId} code=${code} busy=${session.busy}`);
    if (session.busy) finishClaudeTurn(session, { viaClose: true, exitCode: code }); // close-fallback turn-end
    teardownClaudeSession(session.conversationId, false); // already dead — don't re-kill
  });
}

// Reap the least-recently-used IDLE session(s) to keep under the cap. Never
// reaps a busy session (an active turn); allows a brief overflow instead.
function reapLruClaudeSessionsIfNeeded(): void {
  while (claudeSessions.size >= MAX_CLAUDE_SESSIONS) {
    let oldest: ClaudeSession | null = null;
    for (const s of claudeSessions.values()) {
      if (s.busy) continue;
      if (!oldest || s.lastActivity < oldest.lastActivity) oldest = s;
    }
    if (!oldest) break; // every session busy — tolerate overflow rather than kill an active turn
    appendLog(`[Claude] LRU-reaping idle session conv=${oldest.conversationId} (cap ${MAX_CLAUDE_SESSIONS})`);
    teardownClaudeSession(oldest.conversationId, true);
  }
}

// Spawn a fresh persistent child for a conversation. Writes a per-session MCP
// config (stable relayId for the session's life) and keeps --strict-mcp-config.
function createClaudeSession(
  conversationId: string,
  useModel: string,
  useEffort: string,
  claudeSessionId: string | undefined,
  res: ExpressResponse,
): ClaudeSession {
  reapLruClaudeSessionsIfNeeded();
  const relayId = randomUUID();
  const mcpConfigPath = path.join(os.tmpdir(), `vst-mcp-${relayId}.json`);
  const cmdArgs = buildClaudeBaseArgs(useModel, useEffort);
  // Only resume an id THIS process created (a stale orb id 404s the whole turn).
  const resume = isUuidLike(claudeSessionId) && knownClaudeSessions.has(claudeSessionId!);
  if (resume) cmdArgs.push("--resume", claudeSessionId!);
  const mcpConfigWritten = writeClaudeMcpConfig(relayId, mcpConfigPath);
  if (mcpConfigWritten) {
    cmdArgs.push("--mcp-config", mcpConfigPath);
    // Restrict the spawn to ONLY the vst-foundry relay server — without this the
    // CLI boots every global/user MCP server too (boot storm => flapping).
    cmdArgs.push("--strict-mcp-config");
  }
  appendLog(
    `[Claude] spawn persistent child conv=${conversationId} relay=${relayId} ` +
      `model=${useModel} effort=${useEffort} resume=${resume} args=${cmdArgs.join(" ")}`,
  );
  const proc = spawnClaudeCli(cmdArgs, { cwd: PROJECT_CWD });
  const relayEntry: ActiveSession = { sseRes: res, pending: new Map() };
  activeSessions.set(relayId, relayEntry);
  const session: ClaudeSession = {
    proc,
    relayId,
    conversationId,
    claudeSessionId: resume ? claudeSessionId! : null,
    mcpConfigPath,
    mcpConfigWritten,
    model: useModel,
    effort: useEffort,
    activeSse: res,
    stdoutBuf: "",
    stderr: "",
    busy: false,
    lastActivity: Date.now(),
    relayEntry,
    aliasedSids: new Set<string>(),
    turnResolver: null,
    firstTurnPending: !resume, // resumed child already has context — send only the new turn
    interruptSeq: 0,
    heartbeat: null,
    turnGen: 0,
    resultGen: 0,
    stallTimer: null,
    idleWaiters: [],
  };
  if (resume && claudeSessionId) claudeSidToConversation.set(claudeSessionId, conversationId);
  claudeSessions.set(conversationId, session);
  // FIX 5: when resuming a KNOWN Claude session_id, pre-register the relay alias
  // immediately (don't wait for the system/init session_id frame). The browser
  // POSTs tool results keyed by session_id; without the alias an in-turn tool
  // call before that frame arrives would not resolve.
  if (resume && claudeSessionId) {
    activeSessions.set(claudeSessionId, relayEntry);
    session.aliasedSids.add(claudeSessionId);
    appendLog(`[Claude] pre-aliased relay ${relayId} -> ${claudeSessionId} (resume path)`);
  }
  attachClaudeHandlers(session);
  return session;
}

// Respawn a session's child in place (model/effort change). Ports BCC switchModel:
// set session.proc = newProc BEFORE killing the old one so the old child's late
// handlers no-op. relayId + mcpConfigPath are reused, so the relay aliasing and
// pending map stay valid across the swap.
function respawnClaudeSession(session: ClaudeSession, useModel: string, useEffort: string): void {
  const oldProc = session.proc;
  const sid = session.claudeSessionId;
  const canResume = !!sid && isUuidLike(sid) && knownClaudeSessions.has(sid);
  const cmdArgs = buildClaudeBaseArgs(useModel, useEffort);
  if (canResume) cmdArgs.push("--resume", sid!);
  if (session.mcpConfigWritten) {
    cmdArgs.push("--mcp-config", session.mcpConfigPath);
    cmdArgs.push("--strict-mcp-config");
  }
  appendLog(
    `[Claude] respawn child conv=${session.conversationId} ` +
      `model=${session.model}->${useModel} effort=${session.effort}->${useEffort} resume=${canResume}`,
  );
  const newProc = spawnClaudeCli(cmdArgs, { cwd: PROJECT_CWD });
  session.proc = newProc; // swap BEFORE kill so old handlers are stale-guarded
  session.model = useModel;
  session.effort = useEffort;
  session.stdoutBuf = "";
  session.stderr = "";
  session.firstTurnPending = !canResume; // resumed => context restored by the CLI
  // FIX 2: the old child is about to be killed; any unconsumed `result` it owed
  // (e.g. an interrupted prior turn) is dropped by the stale-proc guard and will
  // never increment resultGen. Resync so the next turn's result FIFO-matches.
  session.resultGen = session.turnGen;
  attachClaudeHandlers(session);
  killProc(oldProc);
}

// Resolve a live session by conversationId (preferred) or Claude session_id
// (fallback index). Drops + tears down a dead child so the caller respawns.
function resolveLiveClaudeSession(conversationId?: string, claudeSessionId?: string): ClaudeSession | undefined {
  let session: ClaudeSession | undefined;
  if (conversationId) session = claudeSessions.get(conversationId);
  if (!session && claudeSessionId) {
    const cid = claudeSidToConversation.get(claudeSessionId);
    if (cid) session = claudeSessions.get(cid);
  }
  if (session && !isClaudeProcAlive(session.proc)) {
    appendLog(`[Claude] discarding dead session conv=${session.conversationId}`);
    teardownClaudeSession(session.conversationId, true);
    return undefined;
  }
  return session;
}

// Fully dispose a session: (optionally) kill the child, unlink its MCP config,
// clear pending tool timers, and drop ALL relay registrations (relayId + every
// aliased session_id). Idempotent.
function teardownClaudeSession(conversationId: string, doKill: boolean): void {
  const session = claudeSessions.get(conversationId);
  if (!session) return;
  claudeSessions.delete(conversationId);
  stopClaudeHeartbeat(session);
  clearClaudeStallWatchdog(session); // FIX 3
  if (doKill) { try { killProc(session.proc); } catch {} }
  if (session.mcpConfigWritten) {
    try { fs.unlinkSync(session.mcpConfigPath); } catch {}
  }
  for (const p of session.relayEntry.pending.values()) clearTimeout(p.timer);
  activeSessions.delete(session.relayId);
  for (const sid of session.aliasedSids) {
    activeSessions.delete(sid);
    claudeSidToConversation.delete(sid);
  }
  if (session.turnResolver) {
    const r = session.turnResolver;
    session.turnResolver = null;
    r();
  }
  // Wake any routes parked behind this (now-gone) session so they re-resolve and
  // create a fresh child instead of hanging forever in the idle wait.
  session.busy = false;
  releaseClaudeIdleWaiters(session);
  appendLog(`[Claude] torn down session conv=${conversationId} relay=${session.relayId} kill=${doKill}`);
}

// Graceful (async killProc) teardown of every session — used on shutdown().
function killAllClaudeSessions(): void {
  for (const cid of Array.from(claudeSessions.keys())) teardownClaudeSession(cid, true);
}

// Synchronous kill of every child — for process 'exit' (async taskkill won't run
// then). Mirrors the SD sync-kill pattern.
function killAllClaudeSessionsSync(): void {
  for (const session of claudeSessions.values()) {
    try {
      if (process.platform === "win32" && session.proc.pid) {
        execSync(`taskkill /PID ${session.proc.pid} /T /F`, { stdio: "ignore" });
      } else {
        session.proc.kill("SIGKILL");
      }
    } catch {}
    // FIX 4: the async teardownClaudeSession (which unlinks the per-session MCP
    // config) does NOT run on process 'exit', so remove the temp file here too,
    // otherwise os.tmpdir()/vst-mcp-<relayId>.json leaks on every hard exit.
    if (session.mcpConfigWritten) {
      try { fs.unlinkSync(session.mcpConfigPath); } catch {}
    }
  }
}
process.on("exit", killAllClaudeSessionsSync);

// Idle reaper: kill sessions idle beyond CLAUDE_SESSION_IDLE_MS (never busy ones).
const claudeIdleReaper = setInterval(() => {
  const now = Date.now();
  for (const [cid, session] of claudeSessions) {
    if (!session.busy && now - session.lastActivity > CLAUDE_SESSION_IDLE_MS) {
      appendLog(`[Claude] reaping idle session conv=${cid} idleMs=${now - session.lastActivity}`);
      teardownClaudeSession(cid, true);
    }
  }
}, CLAUDE_REAP_INTERVAL_MS);
claudeIdleReaper.unref();

// One chat turn over the persistent session. Owns the SSE/HTTP lifecycle for the
// Claude path (status/headers/close). Resolves when the turn ends (real `result`,
// child close, or mid-turn interrupt). NEVER calls stdin.end(); NEVER kills the
// child except via explicit teardown (reap / close endpoint / dead-child).
async function streamClaude(opts: {
  req: express.Request;
  res: ExpressResponse;
  messages: ChatMessage[];
  model?: string;
  conversationId?: string;
  claudeSessionId?: string;
  effort?: string;
  appState?: any;
  screenshot?: string;
}): Promise<void> {
  const { req, res, messages, appState, screenshot } = opts;
  const useModel = resolveClaudeModel(opts.model);
  const useEffort = resolveClaudeEffort(opts.effort);
  let conversationId = (opts.conversationId || "").trim();
  const claudeSessionId = opts.claudeSessionId;

  const sseWrite = (frame: Frame) => {
    if (res.writableEnded) return;
    try { res.write(`data: ${JSON.stringify(frame)}\n\n`); } catch {}
  };

  let session = resolveLiveClaudeSession(conversationId || undefined, claudeSessionId);
  if (session) conversationId = session.conversationId;

  // Open the SSE stream immediately — even if we're about to queue behind a busy
  // turn, the client must get response headers so its fetch resolves and starts
  // reading (otherwise it would time out waiting for headers).
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  setCorsOrigin(req, res);
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof (res as any).flushHeaders === "function") (res as any).flushHeaders();

  // Ensure a conversation key; announce a freshly minted one so the orb adopts it
  // and routes subsequent turns to THIS persistent session.
  if (!conversationId) {
    conversationId = randomUUID();
    sseWrite({ type: "conversationId", conversationId });
    appendLog(`[Claude] minted conversationId=${conversationId} (none supplied by client)`);
  }

  // BCC PARITY: one turn at a time per conversation, but a concurrent turn is
  // QUEUED, not rejected. BCC never returns 409 — sending while a turn runs just
  // hands the message to the live CLI, which serializes it after the current turn.
  // We mirror that: park this route in the session's FIFO idle-waiter list and
  // resume (in arrival order) the moment the in-flight turn finishes, keeping the
  // SSE alive with pings so the client never times out while waiting.
  if (session && session.busy) {
    sseWrite({ type: "status", message: "Queued — finishing the current turn first…" });
    appendLog(`[Claude] queued turn behind busy conv=${conversationId} (BCC-style serialize)`);
    const queuedPing = setInterval(() => {
      if (res.writableEnded) return;
      try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
    }, CLAUDE_HEARTBEAT_MS);
    try {
      while (session && session.busy) {
        await new Promise<void>((resolve) => session!.idleWaiters.push(resolve));
        if (res.writableEnded) {
          // Client gave up while queued — stop waiting; nothing was submitted.
          appendLog(`[Claude] queued client disconnected before its slot conv=${conversationId}`);
          return;
        }
        // The session may have been torn down (child died) while we waited; the
        // create-on-`!session` path below spins up a fresh child if so.
        session = resolveLiveClaudeSession(conversationId || undefined, claudeSessionId);
      }
    } finally {
      clearInterval(queuedPing);
    }
  }

  // Model/effort switch on a live session -> respawn (resume keeps context).
  if (session && (session.model !== useModel || session.effort !== useEffort)) {
    respawnClaudeSession(session, useModel, useEffort);
  }

  // Create the persistent child on first contact for this conversation.
  if (!session) {
    session = createClaudeSession(conversationId, useModel, useEffort, claudeSessionId, res);
  }

  const stdin = session.proc.stdin;
  if (!stdin || !session.proc.stdout) {
    teardownClaudeSession(conversationId, true);
    sseWrite({ type: "error", message: "Failed to capture Claude CLI stdio" });
    sseWrite({ type: "done" });
    if (!res.writableEnded) res.end();
    return;
  }

  // Per-turn wiring: re-point the live SSE channel AND the MCP relay's sseRes
  // (shared by reference) at THIS response so in-turn tool calls reach the
  // current browser connection.
  session.activeSse = res;
  session.relayEntry.sseRes = res;
  session.busy = true;
  // FIX 2: open a new turn generation. The trailing `result` of this turn will
  // FIFO-match resultGen === turnGen; a stale `result` from a prior interrupted
  // turn (lower generation) is drained in handleClaudeStdoutLine's `done` branch.
  session.turnGen++;
  const myGen = session.turnGen;
  session.lastActivity = Date.now();
  startClaudeHeartbeat(session); // keepalive for long silent thinking/tool phases
  armClaudeStallWatchdog(session); // FIX 3: inactivity watchdog (re-armed on every stdout frame)

  // Mid-turn client disconnect -> interrupt the running turn (control_request),
  // do NOT kill the child; it stays warm for the next turn.
  let closeHandled = false;
  const onClose = () => {
    if (closeHandled) return;
    closeHandled = true;
    const s = session!;
    if (s.busy && s.activeSse === res) {
      appendLog(`[Claude] SSE closed mid-turn conv=${conversationId} — interrupting (child kept)`);
      stopClaudeHeartbeat(s);
      clearClaudeStallWatchdog(s); // FIX 3
      writeClaudeInterrupt(s);
      s.activeSse = null;
      s.busy = false;
      s.lastActivity = Date.now();
      const r = s.turnResolver;
      s.turnResolver = null;
      if (r) r();
      // BCC parity: a queued turn may be waiting behind this interrupted one.
      releaseClaudeIdleWaiters(s);
    }
  };
  // Listen ONLY on res "close" (the real client/SSE disconnect). Do NOT listen on
  // req "close": Node fires it the instant the POST body is fully received (request
  // COMPLETE, not disconnect), which tripped ~1ms into every turn and self-interrupted
  // the Claude CLI -> zero frames streamed -> client 150s timeout. res "close" only
  // fires on an actual connection close; the s.busy/activeSse guard ignores normal end.
  res.on("close", onClose);

  // First turn on a fresh (non-resumed) child seeds the system instruction +
  // full transcript; every later turn on the SAME warm child sends ONLY the new
  // user message (the child remembers the rest).
  let content: string;
  if (session.firstTurnPending) {
    content = buildClaudePrompt(messages, appState, false);
    session.firstTurnPending = false;
  } else {
    const lastUser = [...messages].reverse().find((m) => normalizeRole(m.role) === "user");
    content = lastUser ? extractText(lastUser.content) : "";
  }

  if (!content.trim()) {
    const anyUser = messages.some((m) => normalizeRole(m.role) === "user" && extractText(m.content).trim());
    if (!anyUser) {
      sseWrite({ type: "error", message: "No prompt content found in messages" });
      finishClaudeTurn(session, { viaClose: false });
      res.removeListener("close", onClose);
      return;
    }
    const lastUser = [...messages].reverse().find((m) => normalizeRole(m.role) === "user");
    content = lastUser ? extractText(lastUser.content) : content;
  }

  // Image attach — BCC method: write to a temp file and reference BY PATH
  // (inline base64 content blocks are rejected by the CLI).
  let promptToSend = content;
  if (screenshot) {
    try {
      const mt = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/.exec(screenshot)?.[1] || "image/png";
      const ext = mt.includes("jpeg") ? "jpg" : mt.includes("webp") ? "webp" : mt.includes("gif") ? "gif" : "png";
      const pasteDir = path.join(os.tmpdir(), "vst-foundry-pastes");
      fs.mkdirSync(pasteDir, { recursive: true });
      const imgPath = path.join(pasteDir, `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
      fs.writeFileSync(imgPath, Buffer.from(screenshotBase64(screenshot), "base64"));
      promptToSend = `${content}\n\n[The user attached an image. Read it with your Read tool at this absolute path: ${imgPath}]`;
      appendLog(`[Claude] wrote attached image to ${imgPath} (${mt}) — referencing by path (BCC method)`);
    } catch (e: any) {
      appendLog(`[Claude] failed to persist attached image: ${e?.message || e}`);
    }
  }

  // Arm turn completion BEFORE writing stdin so a fast `result` cannot race us.
  const turnComplete = new Promise<void>((resolve) => { session!.turnResolver = resolve; });

  try {
    const userPayload = { type: "user", message: { role: "user", content: promptToSend }, parent_tool_use_id: null };
    // NDJSON user turn on the SHARED stdin — NO stdin.end() (child stays alive).
    stdin.write(JSON.stringify(userPayload) + "\n");
    appendLog(
      `[Claude] wrote user turn conv=${conversationId} relay=${session.relayId} ` +
        `gen=${myGen} model=${useModel} effort=${useEffort} len=${promptToSend.length}`,
    );
  } catch (e: any) {
    appendLog(`[Claude] failed to write user turn conv=${conversationId}: ${e?.message || e}`);
    sseWrite({ type: "error", message: `Failed to write to Claude CLI: ${e?.message || e}` });
    finishClaudeTurn(session, { viaClose: false });
    res.removeListener("close", onClose);
    teardownClaudeSession(conversationId, true); // child likely dead — respawn next turn
    return;
  }

  await turnComplete;
  res.removeListener("close", onClose);
}

// ===========================================================================
// CORS for assistant routes (cors package not bundled; set headers manually)
// ===========================================================================

app.use("/api/assistant", (req, res, next) => {
  if (!applyCors(req, res)) {
    res.status(403).json({ error: "Cross-origin request blocked" });
    return;
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// ===========================================================================
// Routes
// ===========================================================================

// Health check
app.get("/api/health", (req, res) => {
  res.json({ app: "vst-foundry", status: "ok", time: new Date().toISOString() });
});

app.post("/api/shutdown", (_req, res) => {
  res.json({ ok: true });
  setTimeout(() => shutdown("API shutdown"), 50);
});

// Provider catalog
app.get("/api/assistant/providers", (req, res) => {
  const list = Object.entries(PROVIDERS).map(([id, cfg]) => ({
    id,
    label: cfg.label,
    requiresKey: cfg.requiresKey,
    isLocal: cfg.isLocal,
    defaultModel: cfg.defaultModel,
  }));
  // Claude Code (CLI-based) is always available; surface it first.
  list.unshift({
    id: "claude",
    label: "BCC (Better Claude Code)",
    requiresKey: false,
    isLocal: true,
    defaultModel: CLAUDE_DEFAULT_MODEL,
  });
  res.json(list);
});

// Model discovery
app.get("/api/assistant/models/:provider", async (req, res) => {
  const provider = req.params.provider;
  const apiKey = typeof req.query.apiKey === "string" ? (req.query.apiKey as string) : undefined;

  if (provider === "claude") {
    res.json(await fetchClaudeModels());
    return;
  }

  const cfg = PROVIDERS[provider];
  if (!cfg) {
    res.json([]);
    return;
  }

  try {
    const models = await fetchProviderModels(provider, cfg, apiKey);
    res.json(models.length ? models : fallbackModels(provider, cfg));
  } catch {
    res.json(fallbackModels(provider, cfg));
  }
});

function fallbackModels(provider: string, cfg: ProviderConfig): { id: string; label: string }[] {
  if (provider === "gemini") return GEMINI_FALLBACK_MODELS;
  return cfg.defaultModel ? [{ id: cfg.defaultModel, label: cfg.defaultModel }] : [];
}

async function fetchProviderModels(
  provider: string,
  cfg: ProviderConfig,
  apiKey?: string,
): Promise<{ id: string; label: string; capabilities?: string[] }[]> {
  const key = getApiKey(provider, apiKey);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    // Gemini: native models endpoint (OpenAI-compat base has no /models list).
    if (provider === "gemini") {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`;
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) return [];
      const data: any = await resp.json();
      return (data.models || [])
        .filter((m: any) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m: any) => ({
          id: String(m.name || "").replace(/^models\//, ""),
          label: m.displayName || String(m.name || "").replace(/^models\//, ""),
          capabilities: ["chat", "tools"],
        }));
    }

    // Ollama: /api/tags rather than an OpenAI-style /models list.
    if (provider === "ollama") {
      const resp = await fetch(`${cfg.baseUrl}/api/tags`, { signal: controller.signal });
      if (!resp.ok) return [];
      const data: any = await resp.json();
      return (data.models || []).map((m: any) => ({
        id: m.name,
        label: m.name,
        capabilities: ["chat", "tools"],
      }));
    }

    // OpenRouter Free: fetch full catalog unauthenticated, filter to zero-cost models.
    // Free detection per OPENROUTER-ROUTER: pricing.prompt === "0" && pricing.completion === "0"
    // OR model id ends with ":free".
    if (provider === "openrouter-free") {
      const resp = await fetch("https://openrouter.ai/api/v1/models", { signal: controller.signal });
      if (!resp.ok) return [];
      const data: any = await resp.json();
      const rows: any[] = data.data || [];
      return rows
        .filter(
          (m: any) =>
            (m.pricing?.prompt === "0" && m.pricing?.completion === "0") ||
            String(m.id || "").endsWith(":free"),
        )
        .sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)))
        .map((m: any) => ({
          id: m.id,
          label: m.name || m.id,
          capabilities: capabilitiesFromOpenRouterModel(m),
        }));
    }

    // Generic OpenAI-compatible /v1/models discovery.
    if (cfg.modelsPath) {
      const headers: Record<string, string> = {};
      if (key) headers["Authorization"] = `Bearer ${key}`;
      const resp = await fetch(`${cfg.baseUrl}${cfg.modelsPath}`, {
        headers,
        signal: controller.signal,
      });
      if (!resp.ok) return [];
      const data: any = await resp.json();
      const rows = data.data || data.models || [];
      return rows.map((m: any) => ({
        id: m.id || m.name,
        label: m.name || m.id,
        capabilities: provider === "openrouter" ? capabilitiesFromOpenRouterModel(m) : ["chat"],
      }));
    }

    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

// Chat stream — SSE dispatcher
app.post("/api/assistant/chat", async (req, res) => {
  const {
    messages = [],
    provider = "gemini",
    model,
    apiKey,
    conversationId,
    claudeSessionId,
    effort,
    claudeMode,
    appState,
    screenshot,
  } = req.body || {};

  // Refresh auto-detected hardware (TTL-cached, ≤2 s worst case) so the
  // system prompt built for this turn reflects the real machine.
  await refreshHardwareInfo().catch(() => {});
  void claudeMode; // accepted from the orb but not used by the Claude CLI path

  // Claude Code CLI path — a PERSISTENT per-conversation child (see streamClaude
  // above). It owns its own SSE/HTTP lifecycle (status / headers / close), so we
  // branch out BEFORE the shared SSE setup the direct-API providers use below.
  if (provider === "claude") {
    appendLog(
      `[chat] provider=claude model=${model} effort=${effort} ` +
        `conv=${conversationId || "(new)"} msgs=${Array.isArray(messages) ? messages.length : 0} ` +
        `screenshotInBody=${screenshot ? `yes(len=${screenshot.length})` : "NO"}`,
    );
    await streamClaude({ req, res, messages, model, conversationId, claudeSessionId, effort, appState, screenshot });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  setCorsOrigin(req, res);
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof (res as any).flushHeaders === "function") (res as any).flushHeaders();

  const sse = (data: object) => {
    if (res.writableEnded) return;
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  const ac = new AbortController();
  res.on("close", () => ac.abort());

  // Direct-API providers (OpenAI-compat + Anthropic) loop agentically over tool
  // calls. They need a relay channel so the browser can post tool results back
  // (the Claude CLI path registers its own session inside streamClaude). Register
  // one here, keyed by a fresh id, and announce it as a `session_id` frame so the
  // orb's relayToolResult targets the right session. /api/mcp-relay/result then
  // resolves the matching pending promise and the stream loop continues.
  let toolSessionId: string | undefined;
  if (provider !== "claude" && (provider === "anthropic" || PROVIDERS[provider])) {
    toolSessionId = randomUUID();
    activeSessions.set(toolSessionId, { sseRes: res, pending: new Map() });
    sse({ type: "session_id", sessionId: toolSessionId });
  }

  try {
    let stream: AsyncGenerator<Frame> | null = null;

    if (provider === "anthropic") {
      stream = streamAnthropic({ messages, model, apiKey, appState, screenshot, signal: ac.signal, toolSessionId });
    } else if (PROVIDERS[provider]) {
      stream = streamOpenAICompat({ messages, provider, model, apiKey, appState, screenshot, signal: ac.signal, toolSessionId });
    } else {
      sse({ type: "error", message: `Unknown provider: ${provider}` });
      sse({ type: "done" });
      res.end();
      return;
    }

    for await (const frame of stream) {
      if (ac.signal.aborted) break;
      sse(frame);
    }
  } catch (error: any) {
    console.error("Error in /api/assistant/chat:", error);
    appendLog(`[chat] route catch: ${error?.message || String(error)}`);
    sse({ type: "error", message: error?.message || "An unexpected error occurred during the session." });
  } finally {
    // Tear down the relay session: clear any outstanding tool timers and drop it
    // from the registry so a closed SSE channel can't be written to later.
    if (toolSessionId) {
      const sess = activeSessions.get(toolSessionId);
      if (sess) {
        for (const p of sess.pending.values()) clearTimeout(p.timer);
        activeSessions.delete(toolSessionId);
      }
    }
    if (!res.writableEnded) res.end();
  }
});

// Explicitly dispose a persistent Claude session (orb "new chat" / unmount).
// Kills the child, unlinks its MCP config, and drops all relay registrations.
// Idempotent: a missing/unknown conversationId is a no-op.
app.post("/api/assistant/session/close", express.json({ limit: "1mb" }), (req, res) => {
  const conversationId = (req.body?.conversationId || "").trim();
  if (conversationId && claudeSessions.has(conversationId)) {
    teardownClaudeSession(conversationId, true);
    appendLog(`[Claude] session/close conv=${conversationId}`);
  }
  res.json({ ok: true });
});

// Answer a live CLI control_request (AskUserQuestion / can_use_tool permission).
// The CLI is BLOCKED on stdin until this arrives, so the answer must reach the
// SAME persistent child that raised the request. Mirrors BCC's writeToSession:
//   { type:"control_response", response:{ subtype:"success", request_id, response:<UI answer> } }\n
// where <UI answer> is the orb's choice object — e.g. for AskUserQuestion:
//   { behavior:"allow", updatedInput:{ questions, answers } }
// or for a permission prompt: { behavior:"allow"|"deny", updatedInput?, message? }.
app.post("/api/assistant/control-response", express.json({ limit: "1mb" }), (req, res) => {
  const { conversationId, sessionId, requestId, response } = req.body || {};
  if (!requestId || typeof requestId !== "string") {
    res.status(400).json({ ok: false, error: "requestId (string) required" });
    return;
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    res.status(400).json({ ok: false, error: "response (object) required" });
    return;
  }
  // ask_user (direct-API providers): the requestId is a tool-call id parked in
  // askUserWaiters by dispatchToolCall. There is NO live Claude CLI child here —
  // the answer flows back into the agentic loop as the ask_user tool_result. Check
  // this BEFORE the Claude-session path (which would 409 for a non-Claude turn).
  // Accepts response as {selected:[...], other?} or {answers:[...]}.
  const askWaiter = askUserWaiters.get(requestId);
  if (askWaiter) {
    const r = response as any;
    const rawSelected = r.selected ?? r.answers ?? [];
    const selected = Array.isArray(rawSelected)
      ? rawSelected.map((s: any) => String(s)).filter(Boolean)
      : rawSelected
        ? [String(rawSelected)]
        : [];
    const other = typeof r.other === "string" && r.other.trim() ? r.other.trim() : null;
    askWaiter.resolve({ selected, other });
    appendLog(`[ask_user] answered id=${requestId} selected=${JSON.stringify(selected)} other=${other ? "yes" : "no"}`);
    res.json({ ok: true });
    return;
  }
  const session = resolveLiveClaudeSession(
    typeof conversationId === "string" ? conversationId : undefined,
    typeof sessionId === "string" ? sessionId : undefined,
  );
  if (!session || !session.proc.stdin || session.proc.stdin.destroyed) {
    res.status(409).json({ ok: false, error: "No live Claude session for this conversation" });
    return;
  }
  try {
    const payload = {
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    };
    session.proc.stdin.write(JSON.stringify(payload) + "\n");
    appendLog(
      `[Claude] wrote control_response id=${requestId} conv=${session.conversationId} ` +
        `behavior=${(response as any).behavior}`,
    );
    res.json({ ok: true });
  } catch (e: any) {
    appendLog(`[Claude] control_response write failed id=${requestId}: ${e?.message || e}`);
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// UI-INITIATED control request to the CLI (get_context_usage, set_permission_mode,
// …). Writes `{type:"control_request", request_id, request}` to the persistent
// child's stdin (BCC's sendControl → writeToSession) and awaits the matching
// control_response on stdout (resolved by handleClaudeStdoutLine). Returns the
// CLI's response envelope. Works BETWEEN turns (the child is persistent/idle).
app.post("/api/assistant/control-request", express.json({ limit: "1mb" }), async (req, res) => {
  const { conversationId, sessionId, request } = req.body || {};
  if (!request || typeof request !== "object" || typeof request.subtype !== "string") {
    res.status(400).json({ ok: false, error: "request.subtype (string) required" });
    return;
  }
  const session = resolveLiveClaudeSession(
    typeof conversationId === "string" ? conversationId : undefined,
    typeof sessionId === "string" ? sessionId : undefined,
  );
  if (!session || !session.proc.stdin || session.proc.stdin.destroyed) {
    res.status(409).json({ ok: false, error: "No live Claude session for this conversation" });
    return;
  }
  const requestId = "ui_" + randomUUID().replace(/-/g, "").slice(0, 24);
  const result = await new Promise<any>((resolve) => {
    const timer = setTimeout(() => {
      claudeControlWaiters.delete(requestId);
      resolve(null);
    }, 12000);
    claudeControlWaiters.set(requestId, { resolve, timer });
    try {
      session.proc.stdin!.write(JSON.stringify({ type: "control_request", request_id: requestId, request }) + "\n");
      appendLog(`[Claude] wrote control_request id=${requestId} subtype=${request.subtype} conv=${session.conversationId}`);
    } catch (e: any) {
      clearTimeout(timer);
      claudeControlWaiters.delete(requestId);
      resolve(null);
    }
  });
  if (result == null) {
    res.status(504).json({ ok: false, error: `control request '${request.subtype}' timed out` });
    return;
  }
  res.json({ ok: true, response: result });
});

// ---------- /api/assistant/transcribe: local Whisper STT via faster-whisper ----------
// Ported verbatim from better-claude-code (backend/src/bridge.ts:1412-1460).
// Raw audio body (audio/*) → temp file → spawn stt/transcribe.py → return its
// clean stdout transcript. The global express.json() parser only matches
// application/json, so an audio/* body passes through untouched to the raw
// parser below. PYTHON_CMD/THEDAW_PYTHON_CMD override the interpreter; on Windows
// the launcher `py -3.10` is preferred since faster-whisper is installed there.
const STT_DIR = path.join(os.tmpdir(), "vst-foundry-stt");
const STT_SCRIPT = path.join(process.cwd(), "stt", "transcribe.py");
const STT_PYTHON_CMD =
  process.env.THEDAW_PYTHON_CMD ||
  process.env.PYTHON_CMD ||
  (process.platform === "win32" ? "py" : "python3");
const STT_PYTHON_ARGS =
  process.env.THEDAW_PYTHON_CMD || process.env.PYTHON_CMD
    ? []
    : process.platform === "win32"
      ? ["-3.10"]
      : [];

app.post("/api/assistant/transcribe", express.raw({ type: "audio/*", limit: "25mb" }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.json({ ok: false, error: "no audio data received" });
    return;
  }
  const ct = String(req.headers["content-type"] ?? "audio/webm");
  const ext = ct.includes("wav")
    ? "wav"
    : ct.includes("ogg")
      ? "ogg"
      : ct.includes("mpeg") || ct.includes("mp3")
        ? "mp3"
        : ct.includes("mp4") || ct.includes("m4a")
          ? "m4a"
          : "webm";

  let file: string;
  try {
    fs.mkdirSync(STT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    file = path.join(STT_DIR, `rec-${stamp}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
    fs.writeFileSync(file, req.body);
  } catch (error) {
    res.json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }

  const cleanup = () => {
    try {
      fs.unlinkSync(file);
    } catch {
      /* best effort */
    }
  };

  execFile(
    STT_PYTHON_CMD,
    [...STT_PYTHON_ARGS, STT_SCRIPT, file],
    { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout, stderr) => {
      cleanup();
      if (err) {
        const detail = (stderr || "").trim().split(/\r?\n/).slice(-3).join(" ") || err.message;
        appendLog(`[STT] transcription failed: ${detail}`);
        res.json({ ok: false, error: `transcription failed: ${detail}` });
        return;
      }
      res.json({ ok: true, text: stdout.trim() });
    },
  );
});

// ===========================================================================
// CORS for all /api/* routes (data/SD/texture endpoints)
// ===========================================================================
app.use("/api", (req, res, next) => {
  if (!applyCors(req, res)) {
    res.status(403).json({ error: "Cross-origin request blocked" });
    return;
  }
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// ===========================================================================
// MCP relay endpoints — bridge Claude Code MCP tool calls to the browser
// ===========================================================================
//
// Flow: Claude CLI invokes an MCP tool → mcp-server.cjs POSTs /api/mcp-relay/call
// → server-side tools run here directly; browser-side tools are pushed to the
// active SSE channel as a `client_tool_call` frame and the request blocks until
// the browser POSTs /api/mcp-relay/result (or RELAY_TIMEOUT_MS elapses).

app.post("/api/mcp-relay/call", express.json({ limit: "50mb" }), async (req, res) => {
  const { sessionId, toolCallId, toolName, args } = req.body || {};
  const session = activeSessions.get(sessionId);
  if (!session) {
    res.json({ error: "No active session" });
    return;
  }

  // Server-side tools — handled here without a browser round-trip.
  if (toolName === "fetchWebPage") {
    try {
      const content = await scrapeUrl(args?.url || "");
      res.json({ result: content });
    } catch (e: any) {
      res.json({ error: e?.message || String(e) });
    }
    return;
  }

  // Browser-side tools — relay over SSE and await the result. Every response on
  // this socket is guarded: by the time the waiter fires, the client may already
  // have destroyed the socket (it times out at RELAY_TIMEOUT_MS, just above our
  // RELAY_SERVER_TIMEOUT_MS), so res.json() on a destroyed socket would throw an
  // uncaught ERR_STREAM_DESTROYED from a bare timer/callback.
  const sendRelayJson = (payload: any) => {
    if (!res.writableEnded) {
      try { res.json(payload); } catch {}
    }
  };
  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      session.pending.delete(toolCallId);
      sendRelayJson({ error: `Tool call timed out after ${Math.round(RELAY_SERVER_TIMEOUT_MS / 1000)}s` });
      done();
    }, RELAY_SERVER_TIMEOUT_MS);

    session.pending.set(toolCallId, {
      resolve: (result: any) => {
        clearTimeout(timer);
        session.pending.delete(toolCallId);
        sendRelayJson(result);
        done();
      },
      reject: (err: Error) => {
        clearTimeout(timer);
        session.pending.delete(toolCallId);
        sendRelayJson({ error: err.message });
        done();
      },
      timer,
    });

    // Emit client_tool_call to the browser over the live SSE channel.
    const sseData = JSON.stringify({ type: "client_tool_call", id: toolCallId, name: toolName, args: args || {} });
    try {
      session.sseRes.write(`data: ${sseData}\n\n`);
    } catch (e: any) {
      clearTimeout(timer);
      session.pending.delete(toolCallId);
      sendRelayJson({ error: `Failed to relay tool call: ${e?.message || e}` });
      done();
    }
  });
});

app.post("/api/mcp-relay/result", express.json({ limit: "50mb" }), (req, res) => {
  const { sessionId, toolCallId, result, error, imageData } = req.body || {};
  const session = activeSessions.get(sessionId);
  if (!session) {
    res.json({ ok: false });
    return;
  }
  const pending = session.pending.get(toolCallId);
  if (!pending) {
    res.json({ ok: false });
    return;
  }
  if (error) {
    pending.reject(new Error(error));
  } else {
    pending.resolve(imageData ? { imageData } : { result });
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Real canvas screenshot — server-side OS capture.
//
// The browser's old captureCanvasScreenshot redrew elements onto an in-memory
// 2D canvas (canvasMockup.ts) and so could NEVER show CustomCode (sandboxed
// iframes) — which is most of a real design. The server runs on the same
// machine, so it can grab true composited pixels of the theDAW window via a
// DPI-aware PowerShell capture: exactly what the user sees, iframes included,
// with no browser permission prompt or user gesture. Windows-only by design
// (the app's target platform); non-win32 returns a clear error so the browser
// falls back to the (now live-data) mockup.
// ---------------------------------------------------------------------------
// PrintWindow + PW_RENDERFULLCONTENT (flag 2) renders the TARGET window's own
// content into the bitmap even when it is occluded or on another monitor —
// unlike CopyFromScreen, which grabs whatever pixels are visually on top. The
// flag is mandatory for Chromium/Electron/DirectComposition windows (theDAW),
// which render blank under plain PrintWindow.
const WIN_CAPTURE_PS = `
Add-Type @"
using System;using System.Runtime.InteropServices;
public class VstCap{
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
 public struct RECT{public int Left,Top,Right,Bottom;}
}
"@ -ReferencedAssemblies System.Drawing
[VstCap]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Drawing
$p = Get-Process | Where-Object { $_.MainWindowTitle -match 'theDAW' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Error 'theDAW window not found'; exit 1 }
$h = $p.MainWindowHandle
$r = New-Object VstCap+RECT
[VstCap]::GetWindowRect($h,[ref]$r) | Out-Null
$w=$r.Right-$r.Left; $ht=$r.Bottom-$r.Top
if ($w -lt 1) { $w=1 }
if ($ht -lt 1) { $ht=1 }
$bmp = New-Object System.Drawing.Bitmap $w,$ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [VstCap]::PrintWindow($h,$hdc,2)
$g.ReleaseHdc($hdc); $g.Dispose()
$bmp.Save($env:VSTSHOT_OUT,[System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("{0}x{1}" -f $w,$ht)
`;

app.post("/api/screen-capture", express.json({ limit: "1mb" }), async (_req, res) => {
  if (process.platform !== "win32") {
    res.status(501).json({ error: "Server screen capture is Windows-only" });
    return;
  }
  const outPath = path.join(os.tmpdir(), `vst-shot-${randomUUID()}.png`);
  try {
    const dims: string = await new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WIN_CAPTURE_PS],
        { env: { ...process.env, VSTSHOT_OUT: outPath }, timeout: 30000, windowsHide: true, maxBuffer: 1 << 20 },
        (err, stdout) => (err ? reject(err) : resolve(String(stdout || "").trim()))
      );
    });
    const buf = fs.readFileSync(outPath);
    res.json({ dataUrl: `data:image/png;base64,${buf.toString("base64")}`, dims, bytes: buf.length });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || String(e) });
  } finally {
    fs.unlink(outPath, () => {});
  }
});

// Serve texture files
app.use("/textures", express.static(TEXTURES_DIR));

// Config
app.get("/api/config", (_req, res) => {
  res.json(loadAppCfg());
});
app.post("/api/config", (req, res) => {
  try {
    const merged = mergeAppCfg(req.body);
    saveAppCfg(merged);
    appendLog(`[Config] Settings saved (preferred=${merged.sd.preferred} a1111Port=${merged.sd.a1111.port} comfyPort=${merged.sd.comfyui.port})`);
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// State persistence
app.get("/api/state", (_req, res) => {
  if (!fs.existsSync(SESSION_PATH)) { res.json(null); return; }
  try { res.json(JSON.parse(fs.readFileSync(SESSION_PATH, "utf-8"))); }
  catch { res.json(null); }
});
app.post("/api/state", express.json({ limit: "5mb" }), (req, res) => {
  try {
    fs.writeFileSync(SESSION_PATH, JSON.stringify(req.body), "utf-8");
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Texture upload (base64 payload)
app.post("/api/textures/upload", (req, res) => {
  try {
    const { dataUrl, name } = req.body || {};
    if (!dataUrl) { res.status(400).json({ error: "dataUrl required" }); return; }
    const matches = dataUrl.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/);
    if (!matches) { res.status(400).json({ error: "Invalid dataUrl" }); return; }
    const rawExt = matches[1].toLowerCase();
    if (!["png", "jpg", "jpeg", "gif", "webp"].includes(rawExt)) {
      res.status(400).json({ error: "Unsupported image type" }); return;
    }
    const ext = rawExt === "jpeg" ? "jpg" : rawExt;
    const id = randomUUID();
    const filename = `${id}.${ext}`;
    fs.writeFileSync(path.join(TEXTURES_DIR, filename), Buffer.from(matches[2], "base64"));
    res.json({ id, name: name || filename, url: `/textures/${filename}` });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Texture delete
app.delete("/api/textures/:id", (req, res) => {
  const { id } = req.params;
  if (!id || id.includes("..") || id.includes("/") || id.includes("\\") || !/^[a-f0-9-]{36}$/i.test(id)) {
    res.status(400).json({ error: "Invalid id" }); return;
  }
  const files = fs.existsSync(TEXTURES_DIR) ? fs.readdirSync(TEXTURES_DIR) : [];
  const match = files.find((f) => f === id || f.startsWith(id + "."));
  if (match) {
    try { fs.unlinkSync(path.join(TEXTURES_DIR, match)); } catch {}
    try { fs.unlinkSync(path.join(GENERATED_DIR, match)); } catch {}
  }
  res.json({ success: true });
});

// List textures on disk
app.get("/api/textures/list", (_req, res) => {
  if (!fs.existsSync(TEXTURES_DIR)) { res.json([]); return; }
  const files = fs.readdirSync(TEXTURES_DIR).filter((f) => /\.(png|jpg|jpeg|gif|webp)$/i.test(f));
  res.json(files.map((f) => ({ id: f.replace(/\.[^.]+$/, ""), name: f, url: `/textures/${f}` })));
});

// Logs — recent in-memory ring buffer, optionally backfilled from disk
app.get("/api/logs", (req, res) => {
  const n = Math.min(parseInt(String(req.query.lines ?? "200"), 10) || 200, 1000);
  const ring = getRecentLogs(n);
  if (ring.length < n && fs.existsSync(LOG_PATH)) {
    try {
      const all = fs.readFileSync(LOG_PATH, "utf-8").trim().split("\n").filter(Boolean);
      const fromDisk = all.slice(-n);
      const ringSet = new Set(ring);
      const merged = [...fromDisk.filter((l) => !ringSet.has(l)), ...ring];
      res.json({ lines: merged.slice(-n) });
      return;
    } catch {}
  }
  res.json({ lines: ring });
});

// SD status
app.get("/api/sd/status", (_req, res) => {
  res.json({
    running: !!sdProcess,
    type: sdProcess?.type || null,
    port: sdProcess?.port || null,
    startedAt: sdProcess?.startedAt || null,
  });
});

// SD start
app.post("/api/sd/start", (req, res) => {
  const cfg = loadAppCfg();
  const sdType = req.body?.sdType || cfg.sd.preferred;
  if (sdType !== "a1111" && sdType !== "comfyui") {
    res.status(400).json({ error: "Invalid sdType" }); return;
  }
  res.json(startSDProcess(sdType as "a1111" | "comfyui", cfg));
});

// SD stop
app.post("/api/sd/stop", (_req, res) => {
  res.json(stopSDProcess());
});

// SD resources (models, VAEs, LoRAs, samplers)
app.get("/api/sd/resources", async (req, res) => {
  const cfg = loadAppCfg();
  const sdType = (req.query.type as string) || cfg.sd.preferred;
  if (sdType !== "a1111" && sdType !== "comfyui") {
    res.status(400).json({ error: "Invalid type" }); return;
  }
  const port = sdType === "a1111" ? (cfg.sd.a1111.port || 7860) : (cfg.sd.comfyui.port || 8188);
  const modelDir = cfg.sd.modelLibraryDir;

  if (sdType === "a1111") {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10_000);
    const [modR, vaeR, loraR, sampR] = await Promise.allSettled([
      fetch(`http://localhost:${port}/sdapi/v1/sd-models`, { signal: ac.signal }),
      fetch(`http://localhost:${port}/sdapi/v1/sd-vae`, { signal: ac.signal }),
      fetch(`http://localhost:${port}/sdapi/v1/loras`, { signal: ac.signal }),
      fetch(`http://localhost:${port}/sdapi/v1/samplers`, { signal: ac.signal }),
    ]);
    clearTimeout(t);
    const ok = (r: PromiseSettledResult<Response>) => r.status === "fulfilled" && r.value.ok;
    const models = ok(modR) ? (await (modR as any).value.json()).map((m: any) => ({ id: m.title, label: m.model_name || m.title })) : [];
    const vaes = ok(vaeR) ? (await (vaeR as any).value.json()).map((v: any) => ({ id: v.model_name, label: v.model_name })) : [];
    const loras = ok(loraR) ? (await (loraR as any).value.json()).map((l: any) => ({ id: l.name, label: l.name })) : [];
    const samplers = ok(sampR) ? (await (sampR as any).value.json()).map((s: any) => ({ id: s.name, label: s.name })) : [];
    res.json({ models, vaes, loras, samplers });
  } else {
    let models: any[] = [];
    if (modelDir && fs.existsSync(modelDir)) {
      models = fs.readdirSync(modelDir)
        .filter((f) => /\.(safetensors|ckpt|pt)$/i.test(f))
        .map((f) => ({ id: f, label: f.replace(/\.(safetensors|ckpt|pt)$/i, "") }));
    }
    res.json({ models, vaes: [], loras: [], samplers: [] });
  }
});

// Generate textures
app.post("/api/textures/generate", async (req, res) => {
  const params: GenParams = req.body || {};
  if (!params.prompt) { res.status(400).json({ error: "prompt required" }); return; }

  const cfg = loadAppCfg();
  let images: string[] = [];

  try {
    switch (params.provider) {
      case "a1111": images = await generateViaA1111(params, cfg); break;
      case "comfyui": images = await generateViaComfyUI(params, cfg); break;
      case "openai": case "dalle": images = await generateViaDallE(params); break;
      case "gemini": images = await generateViaGemini(params); break;
      default:
        res.status(400).json({ error: `Unsupported image generation provider: ${params.provider}` });
        return;
    }

    if (!images.length) {
      res.status(500).json({ error: "No images returned from provider" });
      return;
    }

    const results = await saveImagesToFiles(images, params);
    res.json({ results });
  } catch (e: any) {
    appendLog(`[ERROR] generate via ${params.provider}: ${e.message}`);
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ===========================================================================
// Vite middleware / production static serving
// ===========================================================================

const setupStaticAndVite = async () => {
  // underfit's assistant backend is API-ONLY. The UI is underfit's own
  // dashboard (served on :8791); there is no SPA/Vite to serve here.
};

// ===========================================================================
// Process error handlers + graceful shutdown
// ===========================================================================

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[WARN] Unhandled promise rejection:", reason);
  appendLog(`[WARN] Unhandled rejection: ${String(reason)}`);
});

let httpServer: ReturnType<typeof app.listen> | null = null;

function shutdown(signal: string) {
  console.log(`\n[Server] Received ${signal}, shutting down gracefully...`);
  killAllClaudeSessions();
  if (sdProcess) { killProc(sdProcess.proc); sdProcess = null; }
  if (httpServer) {
    const server = httpServer;
    httpServer = null;
    server.close((err) => {
      if (err) console.error("[Server] Error during shutdown:", err);
      else console.log("[Server] HTTP server closed.");
      process.exit(err ? 1 : 0);
    });
    server.closeAllConnections?.();
    server.closeIdleConnections?.();
    // Force-exit after 10 s if connections linger
    setTimeout(() => {
      console.error("[Server] Graceful shutdown timed out, forcing exit.");
      process.exit(1);
    }, 10_000).unref();
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Skip startup when imported by tests (Vitest sets NODE_ENV=test); supertest
// drives the exported `app` directly, so no port bind / SD auto-start needed.
if (process.env.NODE_ENV !== "test")
  setupStaticAndVite()
  .then(() => {
    httpServer = app.listen(PORT, "127.0.0.1", () => {
      console.log(
        `[Fullstack Server] Running on http://localhost:${PORT} in ${process.env.NODE_ENV || "development"} mode.`,
      );
      // Auto-start SD instances where autoStart is enabled in config
      const autoStartCfg = loadAppCfg();
      let autoStarted = false;
      for (const t of ["a1111", "comfyui"] as const) {
        if (autoStartCfg.sd[t].autoStart && autoStartCfg.sd[t].execPath) {
          if (autoStarted) {
            console.log(`[autoStart] Warning: both a1111 and comfyui have autoStart=true; only one can run at a time. Skipping ${t}.`);
            appendLog(`[autoStart] Skipping ${t} — only one SD instance can run at a time`);
            continue;
          }
          const result = startSDProcess(t, autoStartCfg);
          console.log(`[autoStart] ${t}: ${result.message}`);
          appendLog(`[autoStart] ${t}: ${result.message}`);
          if (result.success) autoStarted = true;
        }
      }
    });

    // No overall request/response timeout — a chat turn can legitimately run for
    // many minutes (long agentic tool sequences). Node's defaults (requestTimeout
    // 300s; socket timeout) must never abort a live SSE turn. headersTimeout is
    // left at default (it only bounds header receipt). Localhost-only bind.
    httpServer.requestTimeout = 0;
    httpServer.timeout = 0;

    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[Server] Port ${PORT} is already in use. Stop the existing process and try again.`);
      } else {
        console.error("[Server] HTTP server error:", err);
      }
      process.exit(1);
    });
  })
  .catch((err) => {
    console.error("[Server] Failed to start:", err);
    process.exit(1);
  });
