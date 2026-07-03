// Single source of truth for element types. The union is DERIVED from this
// array so iterating consumers (e.g. the assistant's getBindingCapabilities
// map) can never silently fall out of sync when a type is added — add it
// here and both the type and every iterator pick it up.
export const ELEMENT_TYPES = [
  "Button",
  "Knob",
  "Slider",
  "Label",
  "Select",
  "Toggle",
  "Image",
  "Group",
  "Waveform",
  "Meter",
  "XYPad",
  "Spatial3D",
  "WaveShaper", // wave-shaping / distortion curve control (0–100 drive)
  "Envelope", // ADSR envelope editor (attack / decay / sustain / release)
  "StepSequencer", // grid step sequencer
  "Keyboard", // piano-key input strip
  "CustomCode",
] as const;

export type ElementType = (typeof ELEMENT_TYPES)[number];

// A reusable custom UI module (a CustomCode component saved to the sidebar
// palette). Kept fully serializable (no JSX) so it persists through the same
// autosave path as the rest of the project state — its preview is rendered from
// `customCode` on demand. Created by the user (sidebar form) OR the AI
// (addCustomModule tool); both land in the same store.
export interface CustomModule {
  type: "CustomCode";
  variant: string; // unique key + label shown in the palette
  label: string;
  defaultWidth: number;
  defaultHeight: number;
  customCode: string;
  params?: CustomParam[]; // Parameter schema saved with the module
}

export interface Asset {
  id: string;
  name: string;
  url: string;
  width?: number;
  height?: number;
  processedUrl?: string; // For background removal
  removeBgEnabled?: boolean;
}

// A single tweakable parameter exposed by a CustomCode element. The schema is
// either declared by the AI when it authors the element, added by hand in the
// properties panel, or self-registered by the running code via
// window.foundryRegisterParams([...]). The host renders one control per param
// (see CustomCodePanel) and pushes live values into the sandboxed iframe over
// postMessage, where the code reads them from window.PARAMS[key].
export type CustomParamType = "number" | "color" | "select" | "toggle" | "text";

export interface CustomParam {
  id?: string; // stable per-param id used as the React list key (not user-editable)
  key: string; // identifier read in code as window.PARAMS[key]
  label: string; // display name in the properties panel
  type: CustomParamType;
  value: number | string | boolean; // current value
  default?: number | string | boolean;
  min?: number; // number
  max?: number; // number
  step?: number; // number
  options?: string[]; // select
}

// A runtime problem reported by a CustomCode element's sandboxed iframe (a
// window.onerror / unhandledrejection caught by the bridge bootstrap). Surfaced
// in CustomCodePanel and the assistant's getCustomCode tool so a broken edit is
// visible instead of silently swallowed. `ts` is a Date.now() stamp.
export interface CustomCodeDiagnostic {
  message: string;
  stack?: string;
  ts: number;
}

// Binds one CustomCode parameter (by its `key`) to a theDAW control target.
// CustomCode has no single value, so bindings are per-param rather than the
// element-level ElementBinding used by native controls. The bound target's live
// value is pushed into the iframe as that param; iframe-side changes to a bound
// param dispatch back out to theDAW.
export interface CustomParamBinding {
  key: string; // CustomParam.key this binding drives
  targetId: string; // theDAW manifest control id
}

// Binding of a control to a theDAW function (Feature A). Stores only target
// ids from theDAW's live control manifest — min/max/step are looked up fresh
// from the manifest at dispatch time so bindings never go stale. Continuous /
// toggle / button controls use `targetId`; XYPad / Spatial3D bind one target
// per axis. Rides every save path for free because UIElement is serialized
// whole (autosave, project save, zip export).
// Response curve applied to a route's normalized signal.
export type RouteCurve = "linear" | "exp" | "log" | "scurve";

// One routing in an element's modulation stack. A control carries MANY
// routes: to theDAW targets (dest "daw") and to other canvas elements
// (dest "element" — knob → Label readout, knob → ganged knob, XY axis →
// two knobs, anything → Meter). Signal flow is normalized 0–100 at the
// source, then shaped per route: amount (depth, negative inverts) → curve
// → output range [rangeMin..rangeMax]. See src/lib/routing.ts.
export interface ElementRoute {
  id: string; // stable route id (list key + removal)
  axis?: "value" | "x" | "y"; // source axis (XYPad/Spatial3D emit x/y)
  dest: "daw" | "element";
  targetId: string; // daw manifest id, or canvas element id
  prop?: string; // element routes: "value" | "valueX" | "valueY" | "text" | "on"
  amount?: number; // -100..100 depth; negative inverts (default 100)
  curve?: RouteCurve; // default "linear"
  rangeMin?: number; // 0-100 output clamp low (default 0)
  rangeMax?: number; // 0-100 output clamp high (default 100)
}

export interface ElementBinding {
  // Legacy single-target fields (pre-routing-stack). Honored at runtime via
  // routesOf() migration in src/lib/routing.ts; the routing UI writes
  // `routes` only. Display elements (Meter/Waveform) still use `targetId`
  // as their LISTEN source.
  targetId?: string; // Knob / Slider / Meter(listen) / Toggle / Button
  xTargetId?: string; // XYPad / Spatial3D horizontal axis
  yTargetId?: string; // XYPad / Spatial3D vertical axis
  // The modulation stack (see ElementRoute).
  routes?: ElementRoute[];
}

export interface UIElement {
  id: string;
  name: string;
  type: ElementType;
  variant?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  assetId?: string; // For Image type
  // Optional image face for native controls: a URL (server /textures/<id> file
  // or data URL) rendered as the control's visual. Opt-in — undefined must
  // render byte-identical to today. NOT assetId (that drives the Image branch).
  faceSrc?: string;
  groupId?: string; // If part of a group
  childrenIds?: string[]; // For Group type
  isLocked?: boolean;
  opacity?: number;
  transparentBackground?: boolean;
  baseColor?: string;
  activeColor?: string;
  textColor?: string;
  borderColor?: string;
  indicatorColor?: string;
  glow?: boolean;
  glowAmount?: number;
  glowActiveOnly?: boolean;
  glowColor?: string;
  glowGradient?: string;
  glowOpacity?: number;
  glowStyle?: "solid" | "neon" | "inner" | "radial" | "outer" | "center";
  glowSpread?: number;
  blendMode?: string;
  effect?: "none" | "pulsing" | "orbital" | "audioReactive" | "breathing" | "flickering" | "floating";
  rotation?: number;
  valueX?: number; // for XYPad
  valueY?: number; // for XYPad
  value?: number;
  min?: number;
  max?: number;
  binding?: ElementBinding; // theDAW function bound to this control (see ElementBinding)
  // Per-control visual/behavioral parameters (sweep angle, tick count, LED
  // segments, bezel width, …). Keys + ranges are declared per control type in
  // src/components/controls/controlParams.ts; the properties panels render an
  // editor per declared param and controls read values via styleParam().
  // Serialized whole with the element, so it rides every save path for free.
  styleParams?: Record<string, number | string | boolean>;
  // Optional universal skin id (see src/lib/skins.ts); overlays decorative
  // layers on top of any control's render. Serialized whole with the element.
  skin?: string;
  cornerRadius?: number;
  options?: string[];
  customCode?: string;
  params?: CustomParam[]; // Exposed, editable parameters for CustomCode elements
  // How a CustomCode element's content fills its box (see customCodeBridge /
  // CustomCodeFrame). "scale" (default): render at natural content size and
  // transform-scale to fit — resize works on any code. "stretch": iframe at
  // 100%, size vars pushed for responsive code. "none": no fitting.
  customCodeFit?: "scale" | "stretch" | "none";
  paramBindings?: CustomParamBinding[]; // per-param theDAW bindings (CustomCode)
  imageModifiers?: {
    removeBg?: boolean;
    tolerance?: number;
    feathering?: number;
    targetColor?: string; // hex
  };
  textureId?: string;
  textureBlendMode?: string;
  textureOpacity?: number;
  textureScale?: number;
  textureOffsetX?: number;
  textureOffsetY?: number;
  textureRotation?: number;
  textureSize?: "cover" | "contain" | "auto" | "100% 100%";
  textureRepeat?: "no-repeat" | "repeat" | "repeat-x" | "repeat-y";
}

export interface Texture {
  id: string;
  name: string;
  url: string;
  filePath?: string;
  prompt?: string;
  provider?: string;
  createdAt?: number;
  isGenerated?: boolean;
}

// User-drawn canvas annotations. All coordinates are canvas pixels (the same
// space as UIElement x/y), so the assistant can translate a drawn shape
// directly into element placement.
export type AnnotationKind = "stroke" | "rect" | "ellipse" | "text";

export interface Annotation {
  id: string;
  kind: AnnotationKind;
  color: string; // hex, lowercased
  strokeWidth: number;
  // stroke (freehand): the polyline
  points?: { x: number; y: number }[];
  // rect / ellipse: the bounding box; text: x/y = anchor (top-left)
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  // text note content + size
  text?: string;
  fontSize?: number;
}

// Optional color→meaning legend ("#ff0000" → "Knob"). Meaning is free text —
// usually an ElementType — telling the assistant what a drawn shape stands for.
export interface AnnotationLegendEntry {
  color: string;
  meaning: string;
}

export type CanvasTool = "select" | "pan" | "annotate";

export interface CanvasState {
  backgroundImage: string | null;
  width: number;
  height: number;
  scale: number;
  panX: number;
  panY: number;
  showGrid?: boolean;
  snapToGrid?: boolean;
  gridSize?: number;
  isPreviewMode?: boolean;
  requireCtrlToZoom?: boolean;
  showRulers?: boolean;
  annotations?: Annotation[];
  showAnnotations?: boolean;
  annotationLegend?: AnnotationLegendEntry[];
}

export interface SDInstanceConfig {
  execPath: string;
  port: number;
  autoStart: boolean;
  extraArgs: string;
  pythonPath: string; // optional override; auto-detected from sibling venv if blank
}

export interface SDConfig {
  preferred: 'a1111' | 'comfyui';
  a1111: SDInstanceConfig;
  comfyui: SDInstanceConfig;
  modelLibraryDir: string;
  outputDir: string;
}

export interface AppConfig {
  sd: SDConfig;
}

export interface LoraEntry {
  name: string;
  weight: number;
}

export interface TextureGenParams {
  provider: string;
  sdType?: 'a1111' | 'comfyui';
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfgScale?: number;
  sampler?: string;
  seed?: number;
  model?: string;
  vae?: string;
  loras?: LoraEntry[];
  batchCount?: number;
  nIter?: number;
  count?: number;
  imageSize?: string;
  quality?: string;
  style?: string;
  apiKey?: string;
}

export interface SDStatus {
  running: boolean;
  type: 'a1111' | 'comfyui' | null;
  port: number | null;
  startedAt: number | null;
}
