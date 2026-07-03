import path from "path";
import fs from "fs";
import { spawn, ChildProcess, execSync } from "child_process";
import { randomUUID } from "crypto";
import { TEXTURES_DIR } from "./paths";
import { appendLog } from "./logging";
import { killProc } from "./proc";
import type { AppCfg } from "./persistence";

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

// Read the current SD process handle. Exposed as a getter (not a live-binding
// export) so cross-module readers always see the latest reassignment.
export function getSdProcess(): SDProcess | null {
  return sdProcess;
}

export function startSDProcess(
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

export function stopSDProcess(): { success: boolean; message: string } {
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
export interface GenParams {
  provider: string; sdType?: string; prompt: string; negativePrompt?: string;
  width?: number; height?: number; steps?: number; cfgScale?: number;
  sampler?: string; seed?: number; model?: string; vae?: string;
  loras?: Array<{ name: string; weight: number }>; batchCount?: number; nIter?: number;
  count?: number; imageSize?: string; quality?: string; style?: string; apiKey?: string;
}

export async function generateViaA1111(params: GenParams, cfg: AppCfg): Promise<string[]> {
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

export async function generateViaComfyUI(params: GenParams, cfg: AppCfg): Promise<string[]> {
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

export async function generateViaDallE(params: GenParams): Promise<string[]> {
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

export async function generateViaGemini(params: GenParams): Promise<string[]> {
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

export async function saveImagesToFiles(
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
