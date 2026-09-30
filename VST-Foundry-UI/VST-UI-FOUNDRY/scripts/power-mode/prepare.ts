import { Buffer } from "node:buffer";
import { ELEMENT_TYPES } from "../../src/types";
import type { Asset, CanvasState, CustomModule, Texture, UIElement } from "../../src/types";
import type { GanProjectSource } from "../../src/lib/ganExport";

export interface PowerModeSession {
  elements: UIElement[];
  canvasState: CanvasState;
  assets?: Asset[];
  textures?: Texture[];
  customModules?: CustomModule[];
  [key: string]: unknown;
}

export interface PreparedPowerMode {
  project: GanProjectSource;
  missingTextures: string[];
  inlinedTextures: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function parsePowerModeSession(source: string): PowerModeSession {
  const session: unknown = JSON.parse(source);
  if (!isRecord(session) || !Array.isArray(session.elements) || !isRecord(session.canvasState)) {
    throw new Error("POWER MODE source must contain elements and canvasState.");
  }
  if (![session.canvasState.width, session.canvasState.height].every(value => isFiniteNumber(value) && value > 0)) {
    throw new Error("POWER MODE source canvas dimensions must be positive finite numbers.");
  }
  if (!session.elements.every(element => isRecord(element) && typeof element.id === "string" &&
    typeof element.name === "string" && ELEMENT_TYPES.some(type => type === element.type) &&
    [element.x, element.y, element.width, element.height].every(isFiniteNumber))) {
    throw new Error("POWER MODE source contains an invalid element.");
  }
  for (const key of ["assets", "textures", "customModules"] as const) {
    const values = session[key];
    if (values !== undefined && (!Array.isArray(values) || !values.every(isRecord))) {
      throw new Error(`POWER MODE source ${key} must be an array of objects.`);
    }
  }
  return session as unknown as PowerModeSession;
}

const MIME: Readonly<Record<string, string>> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
};

export function preparePowerMode(
  session: PowerModeSession,
  readTexture: (filename: string) => Uint8Array | undefined,
): PreparedPowerMode {
  const referencedAssets = new Set(session.elements.map(element => element.assetId));
  const referencedTextures = new Set(session.elements.map(element => element.textureId));
  const cache = new Map<string, string>();
  const missingTextures = new Set<string>();
  function inlineString(value: string): string {
    return value.replace(/\/textures\/([A-Za-z0-9._-]+\.(png|jpe?g|webp|gif))(?![A-Za-z0-9._/-])/gi,
      (url: string, filename: string, extension: string) => {
        const cached = cache.get(filename);
        if (cached) return cached;
        if (missingTextures.has(filename)) return url;
        const bytes = readTexture(filename);
        if (bytes === undefined) { missingTextures.add(filename); return url; }
        const inlined = `data:${MIME[extension.toLowerCase()]};base64,${Buffer.from(bytes).toString("base64")}`;
        cache.set(filename, inlined);
        return inlined;
      });
  }
  function inlineValue(value: unknown): unknown {
    if (typeof value === "string") return inlineString(value);
    if (Array.isArray(value)) return value.map(inlineValue);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, inlineValue(child)]));
    return value;
  }
  const project: GanProjectSource = {
    version: 1,
    elements: session.elements,
    canvasState: session.canvasState,
    assets: (session.assets ?? []).filter(asset => referencedAssets.has(asset.id)),
    textures: (session.textures ?? []).filter(texture => referencedTextures.has(texture.id)),
    customModules: session.customModules ?? [],
  };
  const inlinedProject = inlineValue(project) as GanProjectSource;
  return { project: inlinedProject, missingTextures: [...missingTextures], inlinedTextures: cache.size };
}
