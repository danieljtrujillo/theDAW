// ===========================================================================
// Frame protocol + message types
// ===========================================================================

export interface Frame {
  type: string;
  [key: string]: any;
}

export interface ChatMessage {
  role: string;
  content: any;
}

// ===========================================================================
// Tool definitions (OpenAI function-calling format)
// Ported from the original Gemini Type.* declarations.
// ===========================================================================

// Full settable property surface of a UIElement. Reused by addElements (per
// new element) and updateElements (applied to every targeted element). Every
// key here can be read back via getElements.
const UI_ELEMENT_PROPERTIES: Record<string, any> = {
  // --- identity / structure ---
  type: {
    type: "string",
    description:
      "Component type. One of: Knob, Button, Slider, Toggle, Meter, Waveform, XYPad, Display, Text/Label, Image, Select, Panel, LED, CustomCode, Group.",
  },
  name: { type: "string", description: "Human-readable element name shown in the layers panel." },
  variant: { type: "string", description: "Visual variant/style preset for this component type (e.g. a knob skin)." },
  groupId: { type: "string", description: "ID of the parent group element, if this element belongs to a group." },
  childrenIds: {
    type: "array",
    items: { type: "string" },
    description: "For Group elements: the IDs of the child elements it contains.",
  },
  isLocked: { type: "boolean", description: "When true the element cannot be moved or edited on the canvas." },
  // --- geometry ---
  x: { type: "number", description: "X position in pixels (distance from canvas left)." },
  y: { type: "number", description: "Y position in pixels (distance from canvas top)." },
  width: { type: "number", description: "Width in pixels." },
  height: { type: "number", description: "Height in pixels." },
  rotation: { type: "number", description: "Rotation in degrees." },
  // --- labelling / imagery ---
  label: { type: "string", description: "Text label rendered on or beneath the element." },
  assetId: { type: "string", description: "ID of an uploaded/generated image asset used to render this element." },
  imageModifiers: {
    type: "object",
    description: "Background-removal / image processing applied to assetId.",
    properties: {
      removeBg: { type: "boolean", description: "Key out the background." },
      tolerance: { type: "number", description: "Color match tolerance for background removal." },
      feathering: { type: "number", description: "Edge feathering amount." },
      targetColor: { type: "string", description: "Hex color to treat as the background to remove." },
    },
  },
  // --- color / surface ---
  opacity: { type: "number", description: "Element opacity, 0-100." },
  transparentBackground: { type: "boolean", description: "Render the element with a transparent background." },
  baseColor: { type: "string", description: "Primary/base color (hex or any CSS color)." },
  activeColor: { type: "string", description: "Color used when the control is active/engaged (hex or CSS color)." },
  textColor: { type: "string", description: "Text/label color." },
  borderColor: { type: "string", description: "Border color." },
  indicatorColor: { type: "string", description: "Indicator/pointer color (e.g. knob pointer, meter needle)." },
  cornerRadius: { type: "number", description: "Corner radius in pixels." },
  blendMode: {
    type: "string",
    description:
      "CSS mix-blend-mode (one of 16): normal, multiply, screen, overlay, darken, lighten, color-dodge, color-burn, hard-light, soft-light, difference, exclusion, hue, saturation, color, luminosity.",
  },
  // --- glow ---
  glow: { type: "boolean", description: "Enable the glow effect." },
  glowAmount: { type: "number", description: "Glow blur / intensity, 0-200." },
  glowActiveOnly: { type: "boolean", description: "Only show the glow when the element is active." },
  glowColor: { type: "string", description: "Glow color (hex or CSS color)." },
  glowGradient: { type: "string", description: "Optional CSS gradient string used to color the glow." },
  glowOpacity: { type: "number", description: "Glow opacity, 0-100." },
  glowStyle: {
    type: "string",
    enum: ["solid", "neon", "inner", "radial", "outer", "center"],
    description: "Glow rendering style.",
  },
  glowSpread: { type: "number", description: "Glow spread, 0-100." },
  // --- animated effect ---
  effect: {
    type: "string",
    enum: ["none", "pulsing", "orbital", "audioReactive", "breathing", "flickering", "floating"],
    description: "Animated effect applied to the element.",
  },
  // --- value model ---
  value: { type: "number", description: "Current value (knob/slider/meter/toggle)." },
  min: { type: "number", description: "Minimum value of the control's range." },
  max: { type: "number", description: "Maximum value of the control's range." },
  valueX: { type: "number", description: "X-axis value for an XYPad." },
  valueY: { type: "number", description: "Y-axis value for an XYPad." },
  options: {
    type: "array",
    items: { type: "string" },
    description: "Option labels for a Select element.",
  },
  // --- custom code ---
  customCode: {
    type: "string",
    description:
      "Raw HTML/CSS/SVG/JS for a CustomCode element. Rendered inside a sandboxed iframe — full JavaScript, CSS animation, SVG and <canvas> are supported. Use this for bespoke visualizers, animated displays, or any control the built-in types can't express. To make it USER-EDITABLE, read tweakable values from window.PARAMS.<key> and implement window.onFoundryParams = (p) => { /* re-render using p */ } so live edits apply without reload — then declare those keys in the 'params' property.",
  },
  params: {
    type: "array",
    description:
      "Tweakable parameters exposed by a CustomCode element. Each becomes an editable control in the properties panel and is delivered into the sandboxed iframe as window.PARAMS[key]. Always provide this when authoring a CustomCode element with any adjustable value (color, size, speed, count, threshold, etc.) so the user can tune it after generation.",
    items: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Identifier read in code as window.PARAMS[key] (letters/digits/_ only).",
        },
        label: { type: "string", description: "Human-readable name shown in the properties panel." },
        type: {
          type: "string",
          enum: ["number", "color", "select", "toggle", "text"],
          description: "Control type rendered for this parameter.",
        },
        value: {
          type: "string",
          description:
            "Current/default value as a STRING: numbers like \"0.5\", booleans like \"true\"/\"false\", colors like \"#ff0000\", or one of the select options. The app converts it to the parameter's real type. (String keeps this schema valid for strict providers like Gemini.)",
        },
        min: { type: "number", description: "Minimum (number params)." },
        max: { type: "number", description: "Maximum (number params)." },
        step: { type: "number", description: "Step increment (number params)." },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Choices (select params).",
        },
      },
      required: ["key", "label", "type", "value"],
    },
  },
  customCodeFit: {
    type: "string",
    enum: ["scale", "stretch", "none"],
    description:
      "How a CustomCode element's content fills its box. 'scale' (default) renders content at its natural size and auto-scales it to fit, so resizing works without any code cooperation. 'stretch' sizes the iframe to the box and exposes size CSS vars for responsive code. 'none' leaves content unscaled.",
  },
  // --- texture overlay ---
  textureId: { type: "string", description: "ID of a texture image to overlay on the element." },
  textureBlendMode: {
    type: "string",
    description: "Texture blend mode — one of the 12 supported CSS blend modes (e.g. multiply, screen, overlay, soft-light).",
  },
  textureOpacity: { type: "number", description: "Texture opacity, 0-100." },
  textureScale: { type: "number", description: "Texture scale percentage, 10-400." },
  textureOffsetX: { type: "number", description: "Texture horizontal offset in pixels." },
  textureOffsetY: { type: "number", description: "Texture vertical offset in pixels." },
  textureRotation: { type: "number", description: "Texture rotation in degrees, 0-360." },
  textureSize: {
    type: "string",
    enum: ["cover", "contain", "auto", "100% 100%"],
    description: "CSS background-size used for the texture.",
  },
  textureRepeat: {
    type: "string",
    enum: ["no-repeat", "repeat", "repeat-x", "repeat-y"],
    description: "CSS background-repeat used for the texture.",
  },
};

// Partial CanvasState surface settable via updateCanvas.
const CANVAS_STATE_PROPERTIES: Record<string, any> = {
  width: { type: "number", description: "Canvas width in pixels." },
  height: { type: "number", description: "Canvas height in pixels." },
  gridSnapping: { type: "boolean", description: "Snap element movement/resize to the grid." },
  gridSize: { type: "number", description: "Grid cell size in pixels." },
  backgroundColor: { type: "string", description: "Canvas background color (hex or CSS color)." },
};

const THEME_IDS = [
  "default",
  "neon-green",
  "abyssal-blue",
  "crimson-forge",
  "solar-flare",
  "monochrome",
  "cyberpunk",
  "oceanic",
];

export const OPENAI_TOOLS = [
  // ----------------------------- READ -----------------------------------
  {
    type: "function",
    function: {
      name: "getElements",
      description:
        "Read elements currently on the canvas. Omit 'ids' to return every element, or pass specific ids to fetch only those. Returns the full UIElement objects (geometry, styling, glow, texture, value model, etc.).",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Optional element IDs to fetch. If omitted, all elements are returned.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getCanvasState",
      description:
        "Get the current canvas state: dimensions, grid snapping, grid size, background color/image, zoom and selection.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "getBindingCapabilities",
      description:
        "Complete map of the binding/modulation system: every live theDAW target (write + listen), which target kinds each UI element type can bind, element-to-element route destinations, route processing options, and all current routes. Call before creating or explaining bindings.",
      parameters: {
        type: "object",
        properties: {
          includeCurrentRoutes: {
            type: "boolean",
            description: "Include every element's current route stack (default true).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getAnnotations",
      description:
        "Read the user's hand-drawn canvas annotations: freehand strokes, rectangles/ellipses, and text notes, each with canvas-space bounds (same coordinate space as element x/y) plus the color legend mapping colors to intended element types. A legend-colored shape is a placement instruction — create that element type at those bounds. Text notes are free-form written instructions anchored where they matter.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "getAssets",
      description: "List all image assets available in the project (uploaded and AI-generated images).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "getTextures",
      description: "List all textures available to overlay on elements.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "captureCanvasScreenshot",
      description:
        "Request a real-time visual screenshot of the current canvas. The client captures the rendered layout and sends it back to you as an image input. Use this to visually verify alignment, color, and overall composition.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "getCustomCode",
      description:
        "Read a CustomCode element's FULL source (never truncated), its params, its fit mode, and any recent runtime diagnostics (errors the sandboxed code threw). Call this before editing custom code so you modify the real current source instead of regenerating blind.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id of the CustomCode element to read." },
        },
        required: ["id"],
      },
    },
  },
  // --------------------------- ELEMENT CRUD ------------------------------
  {
    type: "function",
    function: {
      name: "addElements",
      description:
        "Create one or more new components on the canvas (knob, button, slider, toggle, meter, waveform, XY pad, display, text, image, select, panel, LED, or a fully custom CustomCode element). Each element accepts the full UIElement property surface.",
      parameters: {
        type: "object",
        properties: {
          elements: {
            type: "array",
            description: "List of elements to create.",
            items: {
              type: "object",
              properties: { ...UI_ELEMENT_PROPERTIES },
              required: ["type"],
            },
          },
        },
        required: ["elements"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "updateElements",
      description:
        "Update one or more existing elements. The 'updates' object is applied to EVERY element id in 'ids'. Any UIElement property may be set: position, size, rotation, colors, glow, blend mode, effect, value model, texture overlay, customCode, lock state, etc.",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Element IDs to update.",
          },
          updates: {
            type: "object",
            description: "Partial UIElement — the properties to set on every targeted element.",
            properties: { ...UI_ELEMENT_PROPERTIES },
          },
        },
        required: ["ids", "updates"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "setCustomCode",
      description:
        "Replace a CustomCode element's source (and optionally its params) in one atomic update, and re-sync the element's saved reusable library module so it never drifts from the on-canvas element. Prefer this over updateElements for custom-code edits. Read the current source first with getCustomCode.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Id of the CustomCode element to modify." },
          customCode: { type: "string", description: "The new full HTML/CSS/SVG/JS source." },
          params: {
            type: "array",
            description:
              "Optional replacement params array (same shape as the element 'params' property). Omit to leave params unchanged.",
            items: UI_ELEMENT_PROPERTIES.params.items,
          },
        },
        required: ["id", "customCode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deleteElements",
      description: "Delete one or more components from the canvas.",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "The unique element IDs to remove.",
          },
        },
        required: ["ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "duplicateElements",
      description:
        "Duplicate one or more elements, returning the newly created copies. Optionally offset the copies so they don't sit exactly on top of the originals.",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, description: "Element IDs to duplicate." },
          offsetX: { type: "number", description: "Horizontal offset for the copies, in pixels (default 0)." },
          offsetY: { type: "number", description: "Vertical offset for the copies, in pixels (default 0)." },
        },
        required: ["ids"],
      },
    },
  },
  // ----------------------------- LAYERS ----------------------------------
  {
    type: "function",
    function: {
      name: "reorderElement",
      description: "Move a single element up or down one step in the z-order, or all the way to the top or bottom.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The element ID to reorder." },
          direction: {
            type: "string",
            enum: ["up", "down", "top", "bottom"],
            description: "Direction to move within the layer stack.",
          },
        },
        required: ["id", "direction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reorderElementTo",
      description: "Move a single element to an explicit z-order index (0 = bottom).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The element ID to reorder." },
          index: { type: "number", description: "Target z-order index (0 is the bottom-most layer)." },
        },
        required: ["id", "index"],
      },
    },
  },
  // ---------------------------- GROUPING ---------------------------------
  {
    type: "function",
    function: {
      name: "groupElements",
      description: "Group several elements into a single Group element, returned as the new group.",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, description: "Element IDs to group together." },
        },
        required: ["ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ungroupElements",
      description: "Dissolve a group, releasing its children back onto the canvas.",
      parameters: {
        type: "object",
        properties: {
          groupId: { type: "string", description: "The ID of the Group element to ungroup." },
        },
        required: ["groupId"],
      },
    },
  },
  // ---------------------------- SELECTION --------------------------------
  {
    type: "function",
    function: {
      name: "setSelection",
      description: "Set the current canvas selection to exactly the given element IDs (pass an empty array to clear).",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, description: "Element IDs to select." },
        },
        required: ["ids"],
      },
    },
  },
  // ---------------------------- ALIGNMENT --------------------------------
  {
    type: "function",
    function: {
      name: "alignElements",
      description:
        "Align the given elements along a shared edge or center axis. centerH aligns horizontal centers (same X-center); centerV aligns vertical centers (same Y-center).",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, description: "Element IDs to align." },
          alignment: {
            type: "string",
            enum: ["left", "right", "top", "bottom", "centerH", "centerV"],
            description: "Edge or center axis to align to.",
          },
        },
        required: ["ids", "alignment"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "distributeElements",
      description: "Evenly distribute the given elements so the spacing between them is equal along the chosen axis.",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" }, description: "Element IDs to distribute (3 or more)." },
          axis: {
            type: "string",
            enum: ["horizontal", "vertical"],
            description: "Axis along which to equalize spacing.",
          },
        },
        required: ["ids", "axis"],
      },
    },
  },
  // ----------------------------- CANVAS ----------------------------------
  {
    type: "function",
    function: {
      name: "updateCanvas",
      description: "Update canvas-level state such as dimensions, grid snapping, grid size, or background color.",
      parameters: {
        type: "object",
        properties: {
          updates: {
            type: "object",
            description: "Partial CanvasState — the canvas properties to change.",
            properties: { ...CANVAS_STATE_PROPERTIES },
          },
        },
        required: ["updates"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "setCanvasBackground",
      description:
        "Set or clear the canvas background image. Pass an image URL (or data URL) to set it, or an empty string to remove the background image.",
      parameters: {
        type: "object",
        properties: {
          imageUrl: {
            type: "string",
            description: "Image URL / data URL for the background, or an empty string to clear it.",
          },
        },
        required: ["imageUrl"],
      },
    },
  },
  // ----------------------------- HISTORY ---------------------------------
  {
    type: "function",
    function: {
      name: "undo",
      description: "Undo the most recent canvas change.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "redo",
      description: "Redo the most recently undone canvas change.",
      parameters: { type: "object", properties: {} },
    },
  },
  // ------------------------------- APP -----------------------------------
  {
    type: "function",
    function: {
      name: "setTheme",
      description: "Switch the application's visual theme.",
      parameters: {
        type: "object",
        properties: {
          themeId: {
            type: "string",
            enum: THEME_IDS,
            description: "The theme to activate.",
          },
        },
        required: ["themeId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "setFontScale",
      description: "Set the global UI font scale multiplier (e.g. 1.0 = default, 1.25 = 25% larger).",
      parameters: {
        type: "object",
        properties: {
          scale: { type: "number", description: "Font scale multiplier." },
        },
        required: ["scale"],
      },
    },
  },
  // ----------------------------- EXTERNAL --------------------------------
  {
    type: "function",
    function: {
      name: "fetchWebPage",
      description:
        "Browse or read a web page by URL, returning its text contents. Runs server-side. Useful for research, design references, and learning about external libraries.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The full web page URL to read (including http/https)." },
        },
        required: ["url"],
      },
    },
  },
  // ----------------------------- TEXTURES --------------------------------
  {
    type: "function",
    function: {
      name: "generateTexture",
      description:
        "Generate a texture image using AI (A1111, ComfyUI, DALL-E, or Gemini Imagen). Returns generated textures added to the library.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["a1111", "comfyui", "openai", "gemini"] },
          prompt: { type: "string", description: "Text prompt" },
          negativePrompt: { type: "string" },
          width: { type: "number" }, height: { type: "number" },
          steps: { type: "number" }, cfgScale: { type: "number" },
          sampler: { type: "string" }, seed: { type: "number" },
          model: { type: "string" }, vae: { type: "string" },
          loras: { type: "array", items: { type: "object", properties: { name: { type: "string" }, weight: { type: "number" } } } },
          batchCount: { type: "number" },
          imageSize: { type: "string" }, count: { type: "number" },
          quality: { type: "string", enum: ["standard", "hd"] },
          style: { type: "string", enum: ["vivid", "natural"] },
          apiKey: { type: "string" },
        },
        required: ["provider", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "applyTexture",
      description: "Apply a texture to elements with blend/opacity/scale/offset/rotation/size/repeat options",
      parameters: {
        type: "object",
        properties: {
          ids: { type: "array", items: { type: "string" } },
          textureId: { type: "string" },
          textureBlendMode: { type: "string" },
          textureOpacity: { type: "number" },
          textureScale: { type: "number" },
          textureOffsetX: { type: "number" }, textureOffsetY: { type: "number" },
          textureRotation: { type: "number" },
          textureSize: { type: "string", enum: ["cover", "contain", "auto", "100% 100%"] },
          textureRepeat: { type: "string", enum: ["no-repeat", "repeat", "repeat-x", "repeat-y"] },
        },
        required: ["ids", "textureId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "removeTexture",
      description: "Remove texture from elements",
      parameters: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] },
    },
  },
  {
    type: "function",
    function: {
      name: "deleteTexture",
      description: "Delete texture from library and disk",
      parameters: { type: "object", properties: { textureId: { type: "string" } }, required: ["textureId"] },
    },
  },
  {
    type: "function",
    function: {
      name: "uploadTexture",
      description: "Upload an image as a texture via base64 data URL",
      parameters: {
        type: "object",
        properties: { dataUrl: { type: "string" }, name: { type: "string" } },
        required: ["dataUrl", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getSDStatus",
      description: "Get local Stable Diffusion process status",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "getSDResources",
      description: "Get available models, VAEs, LoRAs, samplers for local SD",
      parameters: { type: "object", properties: { sdType: { type: "string", enum: ["a1111", "comfyui"] } }, required: ["sdType"] },
    },
  },
  {
    type: "function",
    function: {
      name: "startSDProcess",
      description: "Start local Stable Diffusion (A1111 or ComfyUI)",
      parameters: { type: "object", properties: { sdType: { type: "string", enum: ["a1111", "comfyui"] } }, required: ["sdType"] },
    },
  },
  {
    type: "function",
    function: {
      name: "stopSDProcess",
      description: "Stop local Stable Diffusion process",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "editTexture",
      description: "Edit an existing texture via img2img or inpainting (A1111/ComfyUI/OpenAI gpt-image-1/Gemini/OpenRouter). Optionally provide a mask PNG with alpha for inpainting.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["a1111", "comfyui", "openai", "gemini", "openrouter"] },
          prompt: { type: "string" },
          sourceTextureId: { type: "string" },
          sourceDataUrl: { type: "string" },
          maskDataUrl: { type: "string", description: "PNG with alpha — transparent = regenerate" },
          denoisingStrength: { type: "number", description: "0-1 how much to change vs preserve (default 0.75)" },
          negativePrompt: { type: "string" },
          width: { type: "number" }, height: { type: "number" },
          steps: { type: "number" }, cfgScale: { type: "number" },
          sampler: { type: "string" }, seed: { type: "number" }, model: { type: "string" },
          inputFidelity: { type: "string", enum: ["low", "high", "auto"], description: "Preserve detail (OpenAI gpt-image-1/1.5)" },
          n: { type: "number", description: "Output count 1-10 (OpenAI/OpenRouter)" },
          apiKey: { type: "string" },
        },
        required: ["provider", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "upscaleTexture",
      description: "Upscale a texture using A1111 extras API or ComfyUI upscale models (ESRGAN, 4x-UltraSharp, etc.)",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["a1111", "comfyui"] },
          sourceTextureId: { type: "string" },
          sourceDataUrl: { type: "string" },
          scaleFactor: { type: "number", enum: [2, 4], description: "Upscale factor (default 2)" },
          upscaler: { type: "string", description: "e.g. 'R-ESRGAN 4x+', '4x-UltraSharp'" },
          upscaler2: { type: "string" }, upscaler2Visibility: { type: "number" },
          gfpganVisibility: { type: "number" }, codeformerVisibility: { type: "number" }, codeformerWeight: { type: "number" },
        },
        required: ["provider"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generateTextureVariations",
      description: "Generate variations of an existing texture. A1111/ComfyUI use subseed variation. OpenAI uses variations endpoint (DALL-E 2) or edits for gpt-image.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["a1111", "comfyui", "openai", "openrouter"] },
          sourceTextureId: { type: "string" },
          sourceDataUrl: { type: "string" },
          count: { type: "number", description: "1-10 variations (default 4)" },
          variationStrength: { type: "number", description: "0-1 via subseed_strength (A1111, default 0.3)" },
          prompt: { type: "string" }, model: { type: "string" },
          steps: { type: "number" }, cfgScale: { type: "number" }, apiKey: { type: "string" },
        },
        required: ["provider"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "batchGenerateTextures",
      description: "Generate multiple textures from different prompts in one call. Each request has its own prompt/params; commonParams apply to all.",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["a1111", "comfyui", "openai", "gemini", "openrouter"] },
          requests: {
            type: "array",
            items: {
              type: "object",
              properties: {
                prompt: { type: "string" }, negativePrompt: { type: "string" }, seed: { type: "number" },
                width: { type: "number" }, height: { type: "number" }, steps: { type: "number" }, cfgScale: { type: "number" },
              },
              required: ["prompt"],
            },
          },
          commonParams: {
            type: "object",
            properties: {
              model: { type: "string" }, sampler: { type: "string" },
              width: { type: "number" }, height: { type: "number" },
              steps: { type: "number" }, cfgScale: { type: "number" },
              imageSize: { type: "string" }, quality: { type: "string" }, style: { type: "string" },
            },
          },
          apiKey: { type: "string" },
        },
        required: ["provider", "requests"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "controlNetGenerate",
      description: "Generate a texture with ControlNet structural conditioning (A1111/ComfyUI). Provide a reference image and module (canny, depth, openpose, lineart, scribble, tile, etc.).",
      parameters: {
        type: "object",
        properties: {
          provider: { type: "string", enum: ["a1111", "comfyui"] },
          prompt: { type: "string" },
          controlNetImageDataUrl: { type: "string", description: "Base64 structural reference image" },
          controlNetModule: { type: "string", description: "canny, depth, openpose, lineart, scribble, tile, seg, normal_map, shuffle, softedge, none" },
          controlNetModel: { type: "string" },
          controlNetWeight: { type: "number", description: "0-2 (default 1.0)" },
          controlNetGuidanceStart: { type: "number", description: "0-1 (default 0)" },
          controlNetGuidanceEnd: { type: "number", description: "0-1 (default 1)" },
          negativePrompt: { type: "string" },
          width: { type: "number" }, height: { type: "number" }, steps: { type: "number" },
          cfgScale: { type: "number" }, sampler: { type: "string" }, seed: { type: "number" }, model: { type: "string" },
        },
        required: ["provider", "prompt", "controlNetImageDataUrl"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getLogs",
      description: "Retrieve recent backend log lines — generation events, config changes, SD lifecycle, errors. Call this when the user asks what happened, what was generated, or why something failed. Returns up to `lines` entries (default 200, max 1000) in chronological order.",
      parameters: {
        type: "object",
        properties: {
          lines: { type: "number", description: "How many recent log lines to return (default 200, max 1000)." },
        },
      },
    },
  },
];

// Anthropic uses input_schema instead of the OpenAI parameters wrapper.
export const ANTHROPIC_TOOLS = OPENAI_TOOLS.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters,
}));

function envFlag(name: string): boolean {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").toLowerCase());
}

export function openAIToolName(tool: any): string {
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

export function providerSupportsImageInput(provider: string, model: string): boolean {
  const id = `${provider}/${model}`.toLowerCase();
  if (provider === "gemini" || provider === "openai" || provider === "anthropic") return true;
  if (provider === "groq") return false;
  if (provider === "grok") return !id.includes("mini");
  if (provider === "openrouter" || provider === "openrouter-free") {
    return /vision|gpt-4o|gpt-4\.1|claude|gemini|gemma-3|qwen.*vl|qwen-vl|llava|pixtral|mistral-small-3\.2/.test(id);
  }
  return /vision|llava|qwen.*vl|qwen-vl|pixtral/.test(id);
}

export function shouldSendOpenAICompatTools(provider: string, model: string): { ok: boolean; reason?: string } {
  if ((provider === "ollama" || provider === "lmstudio") && !envFlag("THEDAW_ENABLE_LOCAL_OPENAI_TOOLS")) {
    return {
      ok: false,
      reason: `${provider} tool calls are disabled unless THEDAW_ENABLE_LOCAL_OPENAI_TOOLS=1 because local OpenAI-compatible servers vary by model.`,
    };
  }
  return { ok: true };
}

export function openAICompatToolsForProvider(provider: string, model: string): any[] {
  const toolSupport = shouldSendOpenAICompatTools(provider, model);
  if (!toolSupport.ok) return [];
  const canSendImages = providerSupportsImageInput(provider, model);
  const tools = canSendImages
    ? OPENAI_TOOLS
    : OPENAI_TOOLS.filter((tool) => openAIToolName(tool) !== "captureCanvasScreenshot");
  return tools.map((tool) => normalizeOpenAICompatToolForProvider(provider, tool));
}

export function isToolCapabilityError(status: number, text: string): boolean {
  return (
    [400, 404, 422].includes(status) &&
    /tool|function|thought_signature|no endpoints found that support tool use/i.test(text)
  );
}

export function isImageInputCapabilityError(status: number, text: string): boolean {
  return [400, 404, 422].includes(status) && /image input|vision|image_url|multimodal/i.test(text);
}

export function isGeminiGenericInvalidArgument(status: number, text: string): boolean {
  return status === 400 && /invalid argument|INVALID_ARGUMENT/i.test(text);
}

function contentShape(content: any): string {
  if (Array.isArray(content)) return `array:${content.map((part) => part?.type || typeof part).join(",")}`;
  return typeof content;
}

export function messagesHaveImageContent(messages: any[]): boolean {
  return messages.some((msg) => Array.isArray(msg.content) && msg.content.some((part: any) => part?.type === "image_url"));
}

export function stripImageContent(messages: any[]): void {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    const text = extractText(msg.content);
    msg.content = msg.content.filter((part: any) => part?.type !== "image_url");
    if (!msg.content.some((part: any) => part?.type === "text")) {
      msg.content.unshift({ type: "text", text: text || "Continue without image input." });
    }
  }
}

export function openAICompatRequestSummary(body: any): any {
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

export function buildSystemInstruction(appState?: any, toolsAvailable = true, imageInputAvailable = true): string {
  const stateSummary = appState
    ? `CURRENT CANVAS STATE (structural summary — bulky string fields like customCode are shown as size markers; call getElements(["<id>"]) to read full source before editing it):
- Elements Count: ${appState.elements?.length || 0}
- Current Elements JSON: ${JSON.stringify(leanForPrompt(appState.elements || []))}
- Selected Elements: ${JSON.stringify(appState.selectedElementIds || [])}
- Canvas Dimensions: ${appState.canvasState?.width || 800}x${appState.canvasState?.height || 500}
- Grid Snapping: ${appState.canvasState?.gridSnapping ? "Enabled" : "Disabled"}`
    : "No app state is loaded currently.";

  if (!toolsAvailable) {
    return `You are the Expert AI Assistant for VST Foundry — a premium interactive audio-software UI design assistant.

This provider/model is currently running WITHOUT callable app tool schemas. Do not claim that you can call getElements, updateCanvas, getCanvasState, generateTexture, or any other app tool in this turn.

You still receive a structural snapshot of the current canvas below. Use it to give concise text guidance, explain what you would change, or tell the user to switch to BCC / OpenAI / Anthropic for live canvas editing.

${stateSummary}`;
  }

  const screenshotToolLine = imageInputAvailable
    ? "- captureCanvasScreenshot() → get a live rendered image of the canvas to visually verify your work."
    : "- captureCanvasScreenshot() is unavailable for this provider/model because it does not accept image input.";

  return `You are the Expert AI Assistant for VST Foundry — a premium, state-of-the-art interactive skeuomorphic and modern audio-software UI designer.
You possess COMPLETE AWARENESS AND DIRECT CONTROL of the client application. You act by CALLING TOOLS, not by describing actions.

═══════════════════════════════════════════════════════════════
YOUR TOOLSET (25 canvas tools + web research + texture generation + backend logs)
═══════════════════════════════════════════════════════════════
READ / INSPECT
- getElements(ids?)       → read full UIElement objects (all live state). Omit ids for everything.
- getCanvasState()        → canvas dimensions, grid, background, zoom, selection.
- getBindingCapabilities(includeCurrentRoutes?) → complete map of the binding/modulation system: every live theDAW target (write + listen), the target kinds each element type can bind/listen to, element→element route destinations, route processing options, and all current routes. CALL THIS FIRST before creating, changing, or explaining ANY binding or modulation route.
- getAnnotations()        → the user's hand-drawn annotations (freehand strokes, rect/ellipse shapes, text notes) with canvas-space bounds + the color legend. When the user references their drawing ("build what I drew", "see my annotations"), call this FIRST: a shape whose color maps to an element type in the legend = "create that element at those bounds"; text notes are written instructions; unmapped colors still show intent (position/size/grouping).
- getAssets()             → list image assets (uploaded + AI-generated).
- getTextures()           → list textures you can overlay on elements.
- getCustomCode(id)       → a CustomCode element's FULL source (never truncated) + params + fit mode + runtime error diagnostics. Call before editing custom code.
${screenshotToolLine}

CREATE / EDIT / DELETE
- addElements(elements[])             → create new components.
- updateElements(ids[], updates)      → apply one set of property changes to every listed element.
- setCustomCode(id, customCode, params?) → atomically replace a CustomCode element's source (+ optional params) and re-sync its saved library module. Prefer over updateElements for custom-code edits.
- deleteElements(ids[])               → remove components.
- duplicateElements(ids[], offsetX?, offsetY?) → copy components.

LAYERS / GROUPING / SELECTION
- reorderElement(id, "up"|"down"|"top"|"bottom")   → z-order one step or to an extreme.
- reorderElementTo(id, index)                       → z-order to an explicit index (0 = bottom).
- groupElements(ids[]) / ungroupElements(groupId)   → group/dissolve.
- setSelection(ids[])                               → set the current selection (empty array clears).

ALIGNMENT / DISTRIBUTION
- alignElements(ids[], "left"|"right"|"top"|"bottom"|"centerH"|"centerV")
- distributeElements(ids[], "horizontal"|"vertical")

CANVAS / APP / HISTORY
- updateCanvas(updates)               → width, height, gridSnapping, gridSize, backgroundColor.
- setCanvasBackground(imageUrl)       → set/clear background image ("" clears).
- undo() / redo()
- setTheme("default"|"neon-green"|"abyssal-blue"|"crimson-forge"|"solar-flare"|"monochrome"|"cyberpunk"|"oceanic")
- setFontScale(scale)                 → global UI font multiplier.

RESEARCH
- fetchWebPage(url)                   → read a web page server-side for references, trends, docs.

BACKEND DIAGNOSTICS
- getLogs(lines?)  → fetch recent backend log entries (generation events, config changes, SD lifecycle, errors). Call this when the user asks what happened, what was generated, or why something failed. Default 200 lines, max 1000.

TEXTURE & MEDIA GENERATION
PROVIDER PRIORITY — always follow this order unless the user explicitly requests a specific provider:
1. Call getSDStatus() first. If local SD is running → use a1111 or comfyui (no API key needed).
2. If SD is not running → use openrouter-free (no API key needed, free image models available).
3. Only use openai / gemini / anthropic if the user explicitly asks for them or has confirmed a key is available.
Never default to a keyed cloud provider when a free option is viable.

- generateTexture(provider, prompt, …)     → AI texture via a1111 / comfyui / openai / gemini / openrouter.
- editTexture(provider, prompt, …)         → img2img + inpainting (a1111 / comfyui / openai gpt-image-1 / gemini / openrouter). Pass maskDataUrl (transparent alpha = regenerate) for inpainting; denoisingStrength controls change vs preserve.
- upscaleTexture(provider, …)              → higher resolution via A1111 extras API or ComfyUI upscale models (ESRGAN, 4x-UltraSharp). a1111 | comfyui only.
- generateTextureVariations(provider, …)   → explore multiple options from an existing texture (A1111/ComfyUI subseed variation; OpenAI variations/edits endpoint).
- batchGenerateTextures(provider, requests[]) → generate many textures from different prompts in one call; commonParams apply to all requests.
- controlNetGenerate(provider, prompt, controlNetImageDataUrl, …) → ControlNet structural conditioning (a1111 / comfyui): canny, depth, openpose, lineart, scribble, tile, etc.
- applyTexture(ids[], textureId, …)        → apply texture with blend/opacity/scale/offset/rotation/size/repeat.
- removeTexture(ids[])                      → strip texture from elements.
- deleteTexture(textureId)                  → delete texture from library + disk.
- uploadTexture(dataUrl, name)              → add a base64 image as a texture.
- getSDStatus()                             → local Stable Diffusion process status.
- getSDResources(sdType)                    → available models / VAEs / LoRAs / samplers (a1111 | comfyui).
- startSDProcess(sdType) / stopSDProcess()  → start / stop local Stable Diffusion.
NOTES:
- OpenAI DALL-E 3 has NO edit or variation endpoint — use the gpt-image-1 model for edits/img2img and variations.
- Gemini Imagen is deprecated (Aug 2026) — use the gemini provider (Nano Banana) for image generation/editing instead.

═══════════════════════════════════════════════════════════════
COMPONENT TYPES
═══════════════════════════════════════════════════════════════
Knob, Button, Slider, Toggle, Meter, Waveform, XYPad, Display, Text/Label, Image, Select (dropdown with options[]), Panel, LED, Group, and CustomCode.
CustomCode elements render arbitrary HTML/CSS/SVG/JS inside a SANDBOXED IFRAME — full JavaScript, CSS animation, SVG and <canvas> are supported. Reach for CustomCode when you need a bespoke visualizer, animated readout, or any control the built-in types cannot express. Put the markup/script in the 'customCode' property.
MAKE CUSTOMCODE ELEMENTS EDITABLE — this is important: whenever a CustomCode element has any tunable value (a color, size, speed, count, threshold, label, on/off, etc.), do BOTH of these so the user can adjust it afterwards:
  1. In 'customCode', read every tunable value from window.PARAMS.<key> (with a sensible fallback), and implement window.onFoundryParams = (p) => { /* re-read window.PARAMS and re-render */ } so live edits apply without a reload.
  2. In 'params', declare each of those keys ({ key, label, type: number|color|select|toggle|text, value, and min/max/step for number or options for select }). The host renders one editable control per param and pushes values back into window.PARAMS.
The host injects a bridge into every CustomCode iframe, so you can also:
  - Call window.foundryRegisterParams(schema) at runtime to expose knobs you did not declare up front (same shape as 'params'); the host reconciles them, keeping any values the user already set.
  - Call window.foundrySetParam(key, value) when the user interacts with a control you drew INSIDE the iframe, so the change flows back to the element's params (and to any theDAW binding). Native <input>/<select> controls are auto-detected — no wiring needed.
  - STYLE with the injected CSS variables so skins/materials apply: --el-base-color, --el-active-color, --el-border-color, --el-text-color (this element's colors) and the --app-* theme vars. Prefer these over hard-coded colors.
Content is AUTO-SCALED to the element box by default (customCodeFit:'scale'), so authoring at a fixed natural size is fine — resizing just works. Use 'stretch' for genuinely responsive layouts, 'none' to opt out.
Read/modify existing custom code with getCustomCode(id) then setCustomCode(id, customCode, params?) — never regenerate blind. Params and customCodeFit are settable directly on the element via addElements/updateElements too.
CustomCode elements you create are auto-saved to the user's reusable Custom Code library, so a well-parameterised element becomes a reusable, tweakable component. Do NOT hard-code values you have exposed as params — always source them from window.PARAMS.

═══════════════════════════════════════════════════════════════
ELEMENT PROPERTIES YOU CAN SET (via addElements / updateElements)
═══════════════════════════════════════════════════════════════
- Identity/structure: name, type, variant, groupId, childrenIds, isLocked.
- Geometry: x, y, width, height, rotation.
- Imagery: label, assetId, imageModifiers { removeBg, tolerance, feathering, targetColor }.
- Color/surface: opacity (0-100), transparentBackground, baseColor, activeColor, textColor, borderColor, indicatorColor, cornerRadius, blendMode (16 CSS blend modes).
- Glow: glow, glowAmount (0-200), glowActiveOnly, glowColor, glowGradient, glowOpacity (0-100), glowStyle (solid|neon|inner|radial|outer|center), glowSpread (0-100).
- Animated effect: effect (none|pulsing|orbital|audioReactive|breathing|flickering|floating).
- Value model: value, min, max, valueX, valueY; options[] for Select.
- Custom: customCode (HTML/CSS/SVG/JS for CustomCode elements), params[] (editable parameters exposed to the user + delivered to the iframe as window.PARAMS), customCodeFit (scale|stretch|none — how content fills the box, default scale).
- Texture overlay: textureId, textureBlendMode (12 modes), textureOpacity (0-100), textureScale (10-400), textureOffsetX, textureOffsetY, textureRotation (0-360), textureSize (cover|contain|auto|100% 100%), textureRepeat (no-repeat|repeat|repeat-x|repeat-y).

${stateSummary}

═══════════════════════════════════════════════════════════════
HOW TO BEHAVE
═══════════════════════════════════════════════════════════════
- You are a precise visual designer and software architect. Treat layout alignment like a Swiss watchmaker — symmetric spacing, intentional palettes, balanced composition.
- When the user asks for a change ("move the pitch knob right", "make all dials glow neon cyan", "align these 3 buttons", "add a VU meter", "build an animated spectrum analyzer"), ACTUALLY CALL the relevant tool(s). Do not merely explain.
- Prefer reading before writing: call getElements / getCanvasState (or captureCanvasScreenshot for a visual check) when you are unsure of current state, then act with exact element IDs.
- Batch related edits: updateElements applies one 'updates' object to many ids at once; use alignElements / distributeElements for tidy layouts.
- Use exact element IDs returned by getElements when updating, deleting, reordering, or grouping.
- For anything the standard components can't do, build a CustomCode element with real JS/SVG/canvas.
- Be elegant, professional, and concise. Briefly explain what you changed after acting.`;
}

// ===========================================================================
// Message / content helpers
// ===========================================================================

export function extractText(content: any): string {
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

export function normalizeRole(role: string): string {
  return role === "model" ? "assistant" : role;
}

function screenshotDataUrl(screenshot: string): string {
  if (screenshot.startsWith("data:")) return screenshot;
  const b64 = screenshot.includes(",") ? screenshot.split(",")[1] : screenshot;
  return `data:image/png;base64,${b64}`;
}

export function screenshotBase64(screenshot: string): string {
  if (screenshot.includes(",")) return screenshot.split(",")[1] || "";
  return screenshot;
}

export function normalizeUsage(u: any): { input_tokens: number; output_tokens: number } | undefined {
  if (!u) return undefined;
  return {
    input_tokens: u.input_tokens ?? u.prompt_tokens ?? 0,
    output_tokens: u.output_tokens ?? u.completion_tokens ?? 0,
  };
}

// Build OpenAI-format message list with system instruction + optional screenshot.
export function buildOpenAIMessages(systemText: string, messages: ChatMessage[], screenshot?: string): any[] {
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
export function buildAnthropicMessages(messages: ChatMessage[], screenshot?: string): any[] {
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
