// UI-element extraction endpoints — segment + classify a composite UI image
// (the Foundry canvas background) via the Gemini REST API. Prompts and
// response schemas are ported VERBATIM from component-extractor/server.ts
// (the proven working set). Plain fetch, same pattern as sd.ts
// generateViaGemini — no SDK dependency. Key resolution follows getApiKey:
// request-body key (the user's in-app key) first, env fallback.
import { Express, Request, Response } from "express";
import { getApiKey } from "./providers";
import { appendLog } from "./logging";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MIME_OK = /^image\/(png|jpe?g|webp)$/;

const DETECT_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      label: { type: "STRING", description: "Descriptive name of the element" },
      type: { type: "STRING", description: "Type of element (e.g., knob, button, panel, display)" },
      ymin: { type: "NUMBER", description: "Normalized top Y coordinate (0.0 to 1.0)" },
      xmin: { type: "NUMBER", description: "Normalized left X coordinate (0.0 to 1.0)" },
      ymax: { type: "NUMBER", description: "Normalized bottom Y coordinate (0.0 to 1.0)" },
      xmax: { type: "NUMBER", description: "Normalized right X coordinate (0.0 to 1.0)" },
    },
    required: ["label", "type", "ymin", "xmin", "ymax", "xmax"],
  },
};

const LABEL_SCHEMA = {
  type: "OBJECT",
  properties: {
    label: { type: "STRING", description: "Short descriptive label" },
    description: { type: "STRING", description: "Brief description of the element's purpose" },
    type: { type: "STRING", description: "Control type (e.g., knob, button, switch, display)" },
    tags: { type: "ARRAY", items: { type: "STRING" }, description: "Tags describing the element (e.g., 'knob', 'metal', 'red', 'delay')" },
    group: { type: "STRING", description: "Suggested logical group for this element (e.g., 'Delay Controls', 'Master Section', 'Oscillator')" },
    shape: { type: "STRING", description: "The general shape of the foreground component (e.g. 'circle', 'rectangle', 'rounded_rectangle')" },
    polygon: {
      type: "ARRAY",
      description: "Array of [x, y] coordinates in percentages (0 to 1) representing a tight polygon around the foreground component for cutout.",
      items: { type: "ARRAY", items: { type: "NUMBER" } },
    },
  },
  required: ["label", "description", "type", "tags", "group", "polygon"],
};

function detectPrompt(sensitivity: number): string {
  const thresholdLevel =
    sensitivity > 0.7
      ? "Be extremely aggressive and detect even the smallest or faintest elements."
      : sensitivity < 0.3
        ? "Be conservative and only detect the most obvious, distinct, large elements."
        : "Use a balanced threshold for detection.";
  return `Analyze this image and identify EVERY single interactive UI element (such as knobs, buttons, sliders, meters, switches, icons, displays, readouts, and panels). ${thresholdLevel} Break down complex groups into their individual components. You must return their precise bounding boxes. Coordinate values (ymin, xmin, ymax, xmax) must be exactly normalized floats between 0.000 and 1.000. Be extremely thorough. Provide a short, descriptive label for each (e.g., 'Reverb Knob', 'Sync Button', 'Filter Icon').`;
}

function labelPrompt(sensitivity: number): string {
  const margin =
    sensitivity > 0.7
      ? "The polygon should hug the object VERY closely, cutting aggressively to ensure no background is left."
      : sensitivity < 0.3
        ? "The polygon can be slightly loose, ensuring you don't cut off any part of the actual component."
        : "The polygon should hug the object closely for a clean cutout.";
  return `Analyze this UI element snippet concisely. Identify what type of control it is (e.g., knob, button, slider), what it appears to control, and its visual characteristics. Provide a short label, a brief description, an array of descriptive tags (e.g., 'knob', 'metal', 'red', 'delay'), and a suggested logical grouping (e.g., 'Delay Controls', 'Master Section', 'Oscillator'). Finally, carefully trace the EXACT visual boundaries of the primary foreground control (ignoring any shadow or background panel) and provide a tightly-fitting 'polygon' array of [x, y] coordinates in percentage values (0.0 to 1.0). ${margin} Provide enough points to make the shape perfectly smooth and accurate.`;
}

async function geminiGenerateJson(args: {
  model: string;
  apiKey: string;
  base64Image: string;
  mimeType: string;
  prompt: string;
  responseSchema: unknown;
}): Promise<unknown> {
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(args.model)}:generateContent`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 120_000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": args.apiKey },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inlineData: { mimeType: args.mimeType, data: args.base64Image } },
              { text: args.prompt },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: args.responseSchema,
        },
      }),
      signal: ac.signal,
    });
    if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
    const data: any = await resp.json();
    const text = (data?.candidates?.[0]?.content?.parts || [])
      .map((p: any) => p?.text || "")
      .join("");
    if (!text) throw new Error("Empty response from Gemini");
    return JSON.parse(text);
  } catch (err: any) {
    if (err?.name === "AbortError") throw new Error("Gemini request timed out after 120s");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Shared request validation → returns cleaned inputs, or writes the 4xx
// response itself and returns null.
function validateExtractBody(
  req: Request,
  res: Response,
): { base64Image: string; mimeType: string; sensitivity: number; model: string; apiKey: string } | null {
  const { image, mimeType, sensitivity = 0.5, apiKey, model } = req.body || {};
  if (!image || typeof image !== "string" || !mimeType || typeof mimeType !== "string") {
    res.status(400).json({ error: "Missing image or mimeType" });
    return null;
  }
  if (!MIME_OK.test(mimeType)) {
    res.status(400).json({ error: "Unsupported image type" });
    return null;
  }
  const useModel =
    typeof model === "string" && model ? model.replace(/^models\//, "") : "";
  if (!useModel) {
    res.status(400).json({ error: "model required" });
    return null;
  }
  const key = getApiKey("gemini", typeof apiKey === "string" && apiKey ? apiKey : undefined);
  if (!key) {
    res.status(400).json({ error: "Gemini API key required — set one in assistant settings" });
    return null;
  }
  const sens = Math.min(1, Math.max(0, Number(sensitivity) || 0.5));
  return {
    base64Image: image.replace(/^data:image\/\w+;base64,/, ""),
    mimeType,
    sensitivity: sens,
    model: useModel,
    apiKey: key,
  };
}

export function registerExtractRoutes(app: Express): void {
  // Auto-detect every UI element in a composite image → normalized bboxes.
  app.post("/api/extract/detect", async (req, res) => {
    const v = validateExtractBody(req, res);
    if (!v) return;
    try {
      const elements = await geminiGenerateJson({
        model: v.model,
        apiKey: v.apiKey,
        base64Image: v.base64Image,
        mimeType: v.mimeType,
        prompt: detectPrompt(v.sensitivity),
        responseSchema: DETECT_SCHEMA,
      });
      res.json({ elements: Array.isArray(elements) ? elements : [] });
    } catch (e: any) {
      appendLog(`[extract] detect failed: ${e?.message || e}`);
      res.status(502).json({ error: e?.message || "Detection failed" });
    }
  });

  // Label + semantic polygon trace for one cropped element.
  app.post("/api/extract/label", async (req, res) => {
    const v = validateExtractBody(req, res);
    if (!v) return;
    try {
      const info = await geminiGenerateJson({
        model: v.model,
        apiKey: v.apiKey,
        base64Image: v.base64Image,
        mimeType: v.mimeType,
        prompt: labelPrompt(v.sensitivity),
        responseSchema: LABEL_SCHEMA,
      });
      res.json(info);
    } catch (e: any) {
      appendLog(`[extract] label failed: ${e?.message || e}`);
      res.status(502).json({ error: e?.message || "Labeling failed" });
    }
  });
}
