#!/usr/bin/env node
'use strict'

/*
 * VST-UI-FOUNDRY — stdio MCP server
 * --------------------------------------------------------------------------
 * Claude Code spawns this file as a subprocess and speaks the Model Context
 * Protocol (JSON-RPC 2.0) over stdin/stdout (newline-delimited JSON).
 *
 * Tool calls are relayed to the main Express server over HTTP. The Express
 * server forwards the call to the connected browser (which actually mutates
 * the canvas / reads state) and returns the result once the browser responds.
 *
 *   Usage: node mcp-server.cjs <PORT> <SESSION_ID>
 *
 * IMPORTANT: stdout is reserved exclusively for protocol messages. All
 * diagnostics must go to stderr, otherwise the JSON-RPC stream is corrupted.
 */

const http = require('http')

const PORT = process.argv[2] || '3000'
const SESSION_ID = process.argv[3] || ''
// Aligned with server.ts RELAY_TIMEOUT_MS (120s). The persistent Claude session
// keeps this stdio child alive for the whole conversation, so this only bounds a
// SINGLE browser tool round-trip (a slow canvas read/screenshot), not a turn.
const RELAY_TIMEOUT_MS = 120000

// ---------------------------------------------------------------------------
// Shared enums / vocabularies
// ---------------------------------------------------------------------------

const ELEMENT_TYPES = [
  'Button', 'Knob', 'Slider', 'Label', 'Select', 'Toggle', 'Image',
  'Group', 'Waveform', 'Meter', 'XYPad', 'Spatial3D', 'Frame', 'CustomCode',
]

// CSS mix-blend-mode set (16 modes)
const BLEND_MODES = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference',
  'exclusion', 'hue', 'saturation', 'color', 'luminosity',
]

const GLOW_STYLES = ['solid', 'neon', 'inner', 'radial', 'outer', 'center']

const EFFECTS = [
  'none', 'pulsing', 'orbital', 'audioReactive', 'breathing', 'flickering', 'floating',
]

const TEXTURE_SIZES = ['cover', 'contain', 'auto', '100% 100%']

const TEXTURE_REPEATS = ['no-repeat', 'repeat', 'repeat-x', 'repeat-y']

const THEMES = [
  'default', 'neon-green', 'abyssal-blue', 'crimson-forge',
  'solar-flare', 'monochrome', 'cyberpunk', 'oceanic',
]

// ---------------------------------------------------------------------------
// UIElement property schema (every field optional — used by addElements and
// updateElements). All of these are settable via updateElements.
// ---------------------------------------------------------------------------

const UI_ELEMENT_PROPERTIES = {
  // Identity / structure
  id: { type: 'string', description: 'Unique element id (assigned by the app; usually omit on create).' },
  name: { type: 'string', description: 'Human-readable element name shown in the layers panel.' },
  type: { type: 'string', enum: ELEMENT_TYPES, description: 'Element type.' },
  variant: { type: 'string', description: 'Type-specific visual/behavioral variant.' },
  groupId: { type: 'string', description: 'Id of the parent Group element, if any.' },
  childrenIds: { type: 'array', items: { type: 'string' }, description: 'Child element ids (Group elements).' },
  isLocked: { type: 'boolean', description: 'Whether the element is locked from editing/selection.' },

  // Transform
  x: { type: 'number', description: 'X position in canvas px.' },
  y: { type: 'number', description: 'Y position in canvas px.' },
  width: { type: 'number', description: 'Width in px.' },
  height: { type: 'number', description: 'Height in px.' },
  rotation: { type: 'number', description: 'Rotation in degrees.' },

  // Content / asset
  label: { type: 'string', description: 'Display label/text.' },
  assetId: { type: 'string', description: 'Id of the bound image/media asset.' },
  imageModifiers: {
    type: 'object',
    description: 'Image processing options (Image elements).',
    properties: {
      removeBg: { type: 'boolean', description: 'Remove the background color.' },
      tolerance: { type: 'number', description: 'Background color match tolerance.' },
      feathering: { type: 'number', description: 'Edge feathering amount.' },
      targetColor: { type: 'string', description: 'Hex color treated as background, e.g. "#00ff00".' },
    },
    additionalProperties: false,
  },

  // Appearance
  opacity: { type: 'number', minimum: 0, maximum: 100, description: 'Element opacity (0-100).' },
  transparentBackground: { type: 'boolean', description: 'Render with a transparent background.' },
  baseColor: { type: 'string', description: 'Base/idle color (hex/rgb/hsl).' },
  activeColor: { type: 'string', description: 'Active/engaged color.' },
  textColor: { type: 'string', description: 'Text/label color.' },
  borderColor: { type: 'string', description: 'Border color.' },
  indicatorColor: { type: 'string', description: 'Indicator/pointer color (Knob/Slider).' },
  cornerRadius: { type: 'number', description: 'Corner radius in px.' },
  blendMode: { type: 'string', enum: BLEND_MODES, description: 'CSS blend mode (16 modes).' },

  // Glow
  glow: { type: 'boolean', description: 'Enable glow effect.' },
  glowAmount: { type: 'number', minimum: 0, maximum: 200, description: 'Glow intensity (0-200).' },
  glowActiveOnly: { type: 'boolean', description: 'Only show glow in the active state.' },
  glowColor: { type: 'string', description: 'Glow color.' },
  glowGradient: { type: 'string', description: 'Optional CSS gradient for the glow.' },
  glowOpacity: { type: 'number', minimum: 0, maximum: 100, description: 'Glow opacity (0-100).' },
  glowStyle: { type: 'string', enum: GLOW_STYLES, description: 'Glow rendering style.' },
  glowSpread: { type: 'number', minimum: 0, maximum: 100, description: 'Glow spread (0-100).' },

  // Animation
  effect: { type: 'string', enum: EFFECTS, description: 'Animated effect applied to the element.' },

  // Values (Knob/Slider/Meter/XYPad/etc.)
  value: { type: 'number', description: 'Primary value.' },
  min: { type: 'number', description: 'Minimum value.' },
  max: { type: 'number', description: 'Maximum value.' },
  valueX: { type: 'number', description: 'X-axis value (XYPad).' },
  valueY: { type: 'number', description: 'Y-axis value (XYPad).' },

  // Select
  options: { type: 'array', items: { type: 'string' }, description: 'Option list (Select elements).' },

  // Custom code
  customCode: { type: 'string', description: 'HTML/CSS/SVG/JS rendered in a sandboxed iframe (CustomCode elements).' },
  customCodeFit: {
    type: 'string',
    enum: ['scale', 'stretch', 'none'],
    description: "How CustomCode content fills the element box. 'scale' (default) renders at the content's natural size and scales it to fit — resize works with zero code cooperation. 'stretch' sizes the iframe to the box and hands the code size CSS vars. 'none' leaves content unscaled.",
  },
  params: {
    type: 'array',
    description: 'Tweakable parameters exposed by a CustomCode element. Each becomes an editable control in the properties panel and is delivered into the sandboxed iframe as window.PARAMS[key]. Declare one per adjustable value (color, size, speed, count, threshold, etc.) so the user can tune it after generation.',
    items: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Identifier read in code as window.PARAMS[key] (letters/digits/_ only).' },
        label: { type: 'string', description: 'Human-readable name shown in the properties panel.' },
        type: { type: 'string', enum: ['number', 'color', 'select', 'toggle', 'text'], description: 'Control type rendered for this parameter.' },
        value: { type: 'string', description: 'Current/default value as a STRING ("0.5", "true", "#ff0000", or a select option); the app converts it to the real type.' },
        min: { type: 'number', description: 'Minimum (number params).' },
        max: { type: 'number', description: 'Maximum (number params).' },
        step: { type: 'number', description: 'Step increment (number params).' },
        options: { type: 'array', items: { type: 'string' }, description: 'Choices (select params).' },
      },
      required: ['key', 'label', 'type', 'value'],
    },
  },

  // Texture overlay
  textureId: { type: 'string', description: 'Id of the applied texture.' },
  textureBlendMode: { type: 'string', description: 'Texture blend mode (one of 12 supported modes).' },
  textureOpacity: { type: 'number', minimum: 0, maximum: 100, description: 'Texture opacity (0-100).' },
  textureScale: { type: 'number', minimum: 10, maximum: 400, description: 'Texture scale percent (10-400).' },
  textureOffsetX: { type: 'number', description: 'Texture X offset in px.' },
  textureOffsetY: { type: 'number', description: 'Texture Y offset in px.' },
  textureRotation: { type: 'number', minimum: 0, maximum: 360, description: 'Texture rotation in degrees (0-360).' },
  textureSize: { type: 'string', enum: TEXTURE_SIZES, description: 'Texture sizing mode.' },
  textureRepeat: { type: 'string', enum: TEXTURE_REPEATS, description: 'Texture repeat mode.' },
}

// ---------------------------------------------------------------------------
// CanvasState property schema (every field optional — used by updateCanvas).
// ---------------------------------------------------------------------------

const CANVAS_STATE_PROPERTIES = {
  backgroundImage: { type: ['string', 'null'], description: 'Background image URL/data URL, or null to clear.' },
  width: { type: 'number', description: 'Canvas width in px.' },
  height: { type: 'number', description: 'Canvas height in px.' },
  scale: { type: 'number', minimum: 0.1, maximum: 3, description: 'Zoom level (0.1-3).' },
  panX: { type: 'number', description: 'Horizontal pan offset.' },
  panY: { type: 'number', description: 'Vertical pan offset.' },
  showGrid: { type: 'boolean', description: 'Show the alignment grid.' },
  snapToGrid: { type: 'boolean', description: 'Snap elements to the grid.' },
  gridSize: { type: 'number', description: 'Grid cell size in px.' },
  isPreviewMode: { type: 'boolean', description: 'Toggle interactive preview mode.' },
  requireCtrlToZoom: { type: 'boolean', description: 'Require Ctrl to be held while zooming.' },
  showRulers: { type: 'boolean', description: 'Show canvas rulers.' },
}

// ---------------------------------------------------------------------------
// Tool schemas (34 canvas/app tools + fetchWebPage)
// ---------------------------------------------------------------------------

const TOOL_SCHEMAS = [
  // ----- READ -----
  {
    name: 'getElements',
    description: 'Get UI elements on the canvas. Optionally filter by a list of element ids. Returns an array of UIElement objects.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional element ids to fetch. Omit to return all elements.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'getCanvasState',
    description: 'Get the current canvas state (dimensions, zoom, pan, grid, snap, preview mode, rulers, background).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'getAnnotations',
    description: "Read the user's hand-drawn canvas annotations: freehand strokes, rectangles/ellipses, and text notes, each with canvas-space bounds (same coordinate space as element x/y) plus the color legend mapping colors to intended element types. A legend-colored shape is a placement instruction — create that element type at those bounds. Text notes are free-form written instructions anchored where they matter. When the user references their drawing, call this FIRST.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'getAssets',
    description: 'Get all imported image/media assets available in the project.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'getTextures',
    description: 'Get all textures available in the project.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'getCustomModules',
    description: 'Get all saved custom UI modules (reusable CustomCode components in the sidebar palette). Each has a name and its HTML/JSX code.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'addCustomModule',
    description: 'Save a reusable custom UI module to the sidebar palette so it persists (autosaved) and can be dragged onto the canvas. Provide a unique name and the HTML/JSX code it renders. Re-using an existing name overwrites that module. Use this whenever you build a custom component the user may want to reuse.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique module name (also the label shown in the palette).' },
        code: { type: 'string', description: 'The HTML/JSX markup the module renders.' },
      },
      required: ['name', 'code'],
      additionalProperties: false,
    },
  },
  {
    name: 'captureCanvasScreenshot',
    description: 'Capture a TRUE PNG screenshot of the live theDAW window — real composited pixels including CustomCode (sandboxed iframes), exactly what the user sees. Server-side OS capture (PrintWindow); works even when the window is occluded or on another monitor. Falls back to a synthetic redraw only if the OS capture is unavailable.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'getRenderedGeometry',
    description: "Read each element's ACTUAL on-screen rendered rectangle (from the live DOM) and map it back to canvas coordinates. Returns both the model x/y/width/height and the rendered screen + canvas-space rects, so you can verify where elements truly land vs where the model says — catching rotation, overflow, and layout drift. Optionally filter by ids.",
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Optional element ids to measure. Omit to measure all.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'getElementTree',
    description: 'Read the element hierarchy: group/parent-child nesting plus full z-order (layer index = paint order). Use to understand structure, grouping, and stacking without pulling every element\'s bulky props. CustomCode nodes carry hasCustomCode:true and paramCount so you can spot custom elements (and how many params they expose) without reading their source.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'getCustomCode',
    description: "Read a CustomCode element's FULL source (never truncated), its params, its fit mode, and any recent runtime diagnostics (errors the sandboxed code threw). Use this before editing custom code so you modify the real current source rather than regenerating blind.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of the CustomCode element to read.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'getBindingCapabilities',
    description: 'Complete map of the binding/modulation system: every live theDAW target (write + listen), which target kinds each UI element type can bind, element-to-element route destinations, route processing options, and all current routes. Call before creating or explaining bindings.',
    inputSchema: {
      type: 'object',
      properties: {
        includeCurrentRoutes: {
          type: 'boolean',
          description: 'Include every element\'s current route stack (default true).',
        },
      },
      additionalProperties: false,
    },
  },

  // ----- ELEMENT CRUD -----
  {
    name: 'addElements',
    description: 'Add one or more new UI elements to the canvas. Each element is a partial UIElement; unspecified properties use sensible defaults. Returns the created elements (with generated ids).',
    inputSchema: {
      type: 'object',
      properties: {
        elements: {
          type: 'array',
          description: 'Array of partial UIElement objects to create.',
          items: { type: 'object', properties: UI_ELEMENT_PROPERTIES },
        },
      },
      required: ['elements'],
      additionalProperties: false,
    },
  },
  {
    name: 'updateElements',
    description: 'Update properties on one or more existing elements. The same updates object is applied to every element id listed. Returns the updated elements.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ids of the elements to update.',
        },
        updates: {
          type: 'object',
          description: 'Partial UIElement — any subset of element properties to set.',
          properties: UI_ELEMENT_PROPERTIES,
        },
      },
      required: ['ids', 'updates'],
      additionalProperties: false,
    },
  },
  {
    name: 'setCustomCode',
    description: "Replace a CustomCode element's source (and optionally its params) in one atomic update, and re-sync the element's saved reusable library module so it never drifts from the on-canvas element. Prefer this over updateElements for custom-code edits. Read the current source first with getCustomCode.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of the CustomCode element to modify.' },
        customCode: { type: 'string', description: 'The new full HTML/CSS/SVG/JS source.' },
        params: {
          type: 'array',
          description: 'Optional replacement params array (same shape as the params property). Omit to leave params unchanged.',
          items: UI_ELEMENT_PROPERTIES.params.items,
        },
      },
      required: ['id', 'customCode'],
      additionalProperties: false,
    },
  },
  {
    name: 'deleteElements',
    description: 'Delete the elements with the given ids.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Ids of the elements to delete.' },
      },
      required: ['ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'duplicateElements',
    description: 'Duplicate elements by id, offsetting the copies. Returns the newly created elements.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Ids of the elements to duplicate.' },
        offsetX: { type: 'number', description: 'X offset applied to the copies (default 20).' },
        offsetY: { type: 'number', description: 'Y offset applied to the copies (default 20).' },
      },
      required: ['ids'],
      additionalProperties: false,
    },
  },

  // ----- LAYERS -----
  {
    name: 'reorderElement',
    description: 'Move an element within the layer (z-order) stack.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of the element to move.' },
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Direction to move the element.' },
      },
      required: ['id', 'direction'],
      additionalProperties: false,
    },
  },
  {
    name: 'reorderElementTo',
    description: 'Move an element to a specific index in the layer (z-order) stack.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of the element to move.' },
        index: { type: 'integer', description: 'Target layer index (0 = bottom).' },
      },
      required: ['id', 'index'],
      additionalProperties: false,
    },
  },

  // ----- GROUPING -----
  {
    name: 'groupElements',
    description: 'Group the given elements into a new Group element. Returns the created group.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Ids of the elements to group.' },
      },
      required: ['ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'ungroupElements',
    description: 'Ungroup a Group element, releasing its children back to the canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        groupId: { type: 'string', description: 'Id of the Group element to ungroup.' },
      },
      required: ['groupId'],
      additionalProperties: false,
    },
  },

  // ----- SELECTION -----
  {
    name: 'setSelection',
    description: 'Set the current selection to the given element ids. Pass an empty array to clear the selection.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Ids of the elements to select.' },
      },
      required: ['ids'],
      additionalProperties: false,
    },
  },

  // ----- ALIGNMENT -----
  {
    name: 'alignElements',
    description: 'Align the given elements along an edge or center axis.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Ids of the elements to align.' },
        alignment: {
          type: 'string',
          enum: ['left', 'right', 'top', 'bottom', 'centerH', 'centerV'],
          description: 'Alignment edge or axis. centerH = horizontal centers, centerV = vertical centers.',
        },
      },
      required: ['ids', 'alignment'],
      additionalProperties: false,
    },
  },
  {
    name: 'distributeElements',
    description: 'Evenly distribute the given elements along an axis.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Ids of the elements to distribute.' },
        axis: { type: 'string', enum: ['horizontal', 'vertical'], description: 'Axis to distribute along.' },
      },
      required: ['ids', 'axis'],
      additionalProperties: false,
    },
  },

  // ----- CANVAS -----
  {
    name: 'updateCanvas',
    description: 'Update one or more canvas state properties.',
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'object',
          description: 'Partial CanvasState — any subset of canvas properties to set.',
          properties: CANVAS_STATE_PROPERTIES,
        },
      },
      required: ['updates'],
      additionalProperties: false,
    },
  },
  {
    name: 'setCanvasBackground',
    description: 'Set or clear the canvas background image. Pass null to clear it.',
    inputSchema: {
      type: 'object',
      properties: {
        imageUrl: { type: ['string', 'null'], description: 'Image URL/data URL, or null to clear the background.' },
      },
      required: ['imageUrl'],
      additionalProperties: false,
    },
  },

  // ----- HISTORY -----
  {
    name: 'undo',
    description: 'Undo the last action.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'redo',
    description: 'Redo the last undone action.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },

  // ----- APP -----
  {
    name: 'setTheme',
    description: 'Set the application theme.',
    inputSchema: {
      type: 'object',
      properties: {
        themeId: { type: 'string', enum: THEMES, description: 'Theme identifier.' },
      },
      required: ['themeId'],
      additionalProperties: false,
    },
  },
  {
    name: 'setFontScale',
    description: 'Set the global font scale multiplier (e.g. 1.0 = 100%).',
    inputSchema: {
      type: 'object',
      properties: {
        scale: { type: 'number', description: 'Font scale multiplier.' },
      },
      required: ['scale'],
      additionalProperties: false,
    },
  },

  // ----- EXTERNAL -----
  {
    name: 'fetchWebPage',
    description: 'Fetch and scrape a web page server-side, returning its text content. Handled directly by the server (no browser required).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },

  // ----- TEXTURES -----
  {
    name: 'generateTexture',
    description: 'Generate a texture image using AI. PROVIDER PRIORITY: call getSDStatus() first — if local SD is running use a1111/comfyui (no API key needed). If SD is offline use openrouter (free models available, no key needed). Only use openai/gemini if the user explicitly requests them. Returns generated Texture objects added to the library. Handled directly by the server (no browser required).',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['a1111', 'comfyui', 'openai', 'gemini', 'openrouter'], description: 'Generation provider. Prefer a1111/comfyui (no key) or openrouter (free) before openai/gemini.' },
        prompt: { type: 'string', description: 'Text prompt describing the texture.' },
        negativePrompt: { type: 'string', description: 'What to avoid (SD only).' },
        width: { type: 'number', description: 'Width in px (SD only, default 512).' },
        height: { type: 'number', description: 'Height in px (SD only, default 512).' },
        steps: { type: 'number', description: 'Sampling steps (SD only, default 25).' },
        cfgScale: { type: 'number', description: 'CFG scale (SD only, default 7).' },
        sampler: { type: 'string', description: 'Sampler name (SD only).' },
        seed: { type: 'number', description: 'Seed, -1 for random (SD only).' },
        model: { type: 'string', description: 'Model/checkpoint name (SD only).' },
        vae: { type: 'string', description: 'VAE name (A1111 only).' },
        loras: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              weight: { type: 'number' },
            },
          },
          description: 'LoRA weights (A1111 only).',
        },
        batchCount: { type: 'number', description: 'Number of batches (SD only, default 1).' },
        imageSize: { type: 'string', description: "Image size string e.g. '1024x1024' (cloud only)." },
        count: { type: 'number', description: 'Number of images to generate (cloud only, default 1).' },
        quality: { type: 'string', enum: ['standard', 'hd'], description: 'Quality (DALL-E only).' },
        style: { type: 'string', enum: ['vivid', 'natural'], description: 'Style (DALL-E only).' },
        apiKey: { type: 'string', description: 'API key override for cloud providers.' },
      },
      required: ['provider', 'prompt'],
    },
  },
  {
    name: 'applyTexture',
    description: 'Apply a texture to one or more elements with display options.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Element IDs to apply texture to.' },
        textureId: { type: 'string', description: 'ID of texture to apply.' },
        textureBlendMode: { type: 'string', description: 'Blend mode: normal, multiply, screen, overlay, darken, lighten, color-dodge, color-burn, hard-light, soft-light, difference, exclusion.' },
        textureOpacity: { type: 'number', description: 'Opacity 0-100.' },
        textureScale: { type: 'number', description: 'Scale 10-400 percent.' },
        textureOffsetX: { type: 'number', description: 'X offset in px.' },
        textureOffsetY: { type: 'number', description: 'Y offset in px.' },
        textureRotation: { type: 'number', description: 'Rotation 0-360 degrees.' },
        textureSize: { type: 'string', enum: ['cover', 'contain', 'auto', '100% 100%'] },
        textureRepeat: { type: 'string', enum: ['no-repeat', 'repeat', 'repeat-x', 'repeat-y'] },
      },
      required: ['ids', 'textureId'],
    },
  },
  {
    name: 'removeTexture',
    description: 'Remove texture from one or more elements.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Element IDs to remove texture from.' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'deleteTexture',
    description: 'Delete a texture from the library and disk. Handled directly by the server (no browser required).',
    inputSchema: {
      type: 'object',
      properties: {
        textureId: { type: 'string', description: 'ID of texture to delete.' },
      },
      required: ['textureId'],
    },
  },
  {
    name: 'uploadTexture',
    description: 'Upload an image as a texture (base64 data URL). Handled directly by the server (no browser required).',
    inputSchema: {
      type: 'object',
      properties: {
        dataUrl: { type: 'string', description: 'Base64 data URL of the image.' },
        name: { type: 'string', description: 'Name for the texture.' },
      },
      required: ['dataUrl', 'name'],
    },
  },
  {
    name: 'getSDStatus',
    description: 'Get the status of the local Stable Diffusion process. Handled directly by the server (no browser required).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'getSDResources',
    description: 'Get available models, VAEs, LoRAs, and samplers for a local SD instance. Handled directly by the server (no browser required).',
    inputSchema: {
      type: 'object',
      properties: {
        sdType: { type: 'string', enum: ['a1111', 'comfyui'] },
      },
      required: ['sdType'],
    },
  },
  {
    name: 'startSDProcess',
    description: 'Start the local Stable Diffusion process. Handled directly by the server (no browser required).',
    inputSchema: {
      type: 'object',
      properties: {
        sdType: { type: 'string', enum: ['a1111', 'comfyui'] },
      },
      required: ['sdType'],
    },
  },
  {
    name: 'stopSDProcess',
    description: 'Stop the local Stable Diffusion process. Handled directly by the server (no browser required).',
    inputSchema: { type: 'object', properties: {} },
  },

  // ----- TEXTURE EDIT / UPSCALE / VARIATIONS / BATCH / CONTROLNET -----
  {
    name: 'editTexture',
    description: 'Edit an existing texture using img2img or inpainting. Supports local SD (A1111/ComfyUI) and cloud providers (OpenAI gpt-image-1, Gemini, OpenRouter). For A1111/ComfyUI uses /sdapi/v1/img2img with optional mask. For OpenAI uses /v1/images/edits. For Gemini uses generateContent with reference image.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['a1111', 'comfyui', 'openai', 'gemini', 'openrouter'] },
        prompt: { type: 'string', description: 'Edit instruction or new prompt' },
        sourceTextureId: { type: 'string', description: 'ID of texture in library to use as source' },
        sourceDataUrl: { type: 'string', description: 'Base64 data URL of source image (alternative to sourceTextureId)' },
        maskDataUrl: { type: 'string', description: 'Base64 PNG with alpha channel — transparent areas will be regenerated (A1111/OpenAI inpainting)' },
        denoisingStrength: { type: 'number', description: '0.0-1.0 how much to change vs preserve source (A1111/ComfyUI, default 0.75)' },
        negativePrompt: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        steps: { type: 'number' },
        cfgScale: { type: 'number' },
        sampler: { type: 'string' },
        seed: { type: 'number' },
        model: { type: 'string' },
        inputFidelity: { type: 'string', enum: ['low', 'high', 'auto'], description: 'Preserve faces/fine detail (OpenAI gpt-image-1/1.5 only)' },
        n: { type: 'number', description: 'Number of output images (OpenAI/OpenRouter, 1-10)' },
        apiKey: { type: 'string' },
      },
      required: ['provider', 'prompt'],
    },
  },
  {
    name: 'upscaleTexture',
    description: "Upscale/super-resolve a texture using A1111's extras API or ComfyUI upscale models (ESRGAN, 4x-UltraSharp, etc.)",
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['a1111', 'comfyui'] },
        sourceTextureId: { type: 'string', description: 'ID of texture in library to upscale' },
        sourceDataUrl: { type: 'string', description: 'Base64 data URL (alternative to sourceTextureId)' },
        scaleFactor: { type: 'number', enum: [2, 4], description: 'Upscale multiplier (default 2)' },
        upscaler: { type: 'string', description: "Upscaler model name e.g. 'ESRGAN_4x', 'R-ESRGAN 4x+', '4x-UltraSharp'" },
        upscaler2: { type: 'string', description: 'Secondary upscaler for blending (A1111 only)' },
        upscaler2Visibility: { type: 'number', description: 'Secondary upscaler blend weight 0-1 (A1111 only)' },
        gfpganVisibility: { type: 'number', description: 'Face restoration strength 0-1 (A1111 GFPGAN)' },
        codeformerVisibility: { type: 'number', description: 'CodeFormer face restoration 0-1 (A1111)' },
        codeformerWeight: { type: 'number', description: 'CodeFormer weight 0-1' },
      },
      required: ['provider'],
    },
  },
  {
    name: 'generateTextureVariations',
    description: 'Generate variations of an existing texture. A1111/ComfyUI use subseed variation. OpenAI uses /v1/images/variations (DALL-E 2) or /v1/images/edits for gpt-image models. OpenRouter re-runs with seed variation.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['a1111', 'comfyui', 'openai', 'openrouter'] },
        sourceTextureId: { type: 'string', description: 'ID of texture in library' },
        sourceDataUrl: { type: 'string', description: 'Base64 data URL (alternative to sourceTextureId)' },
        count: { type: 'number', description: 'Number of variations to generate (1-10, default 4)' },
        variationStrength: { type: 'number', description: '0.0-1.0 variation amount via subseed_strength (A1111, default 0.3)' },
        prompt: { type: 'string', description: 'Optional prompt override (keeps original style if omitted)' },
        model: { type: 'string' },
        steps: { type: 'number' },
        cfgScale: { type: 'number' },
        apiKey: { type: 'string' },
      },
      required: ['provider'],
    },
  },
  {
    name: 'batchGenerateTextures',
    description: 'Generate multiple textures from different prompts in a single call. Each request can have its own prompt and params. Provider handles batching natively where supported.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['a1111', 'comfyui', 'openai', 'gemini', 'openrouter'] },
        requests: {
          type: 'array',
          description: 'Array of individual generation requests',
          items: {
            type: 'object',
            properties: {
              prompt: { type: 'string' },
              negativePrompt: { type: 'string' },
              seed: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
              steps: { type: 'number' },
              cfgScale: { type: 'number' },
            },
            required: ['prompt'],
          },
        },
        commonParams: {
          type: 'object',
          description: 'Shared params applied to all requests (model, sampler, etc.)',
          properties: {
            model: { type: 'string' },
            sampler: { type: 'string' },
            width: { type: 'number' },
            height: { type: 'number' },
            steps: { type: 'number' },
            cfgScale: { type: 'number' },
            imageSize: { type: 'string' },
            quality: { type: 'string' },
            style: { type: 'string' },
          },
        },
        apiKey: { type: 'string' },
      },
      required: ['provider', 'requests'],
    },
  },
  {
    name: 'controlNetGenerate',
    description: 'Generate a texture with structural conditioning via ControlNet (A1111/ComfyUI). Provide a reference image for structural guidance with modules like canny, depth, openpose, lineart, scribble, tile, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['a1111', 'comfyui'] },
        prompt: { type: 'string' },
        controlNetImageDataUrl: { type: 'string', description: 'Base64 data URL of structural reference image' },
        controlNetModule: { type: 'string', description: 'Preprocessor: canny, depth, openpose, lineart, scribble, tile, seg, normal_map, shuffle, softedge, none' },
        controlNetModel: { type: 'string', description: 'ControlNet model name (leave empty to auto-select)' },
        controlNetWeight: { type: 'number', description: '0-2, influence of ControlNet (default 1.0)' },
        controlNetGuidanceStart: { type: 'number', description: '0-1 when to start ControlNet (default 0)' },
        controlNetGuidanceEnd: { type: 'number', description: '0-1 when to end ControlNet (default 1)' },
        negativePrompt: { type: 'string' },
        width: { type: 'number' },
        height: { type: 'number' },
        steps: { type: 'number' },
        cfgScale: { type: 'number' },
        sampler: { type: 'string' },
        seed: { type: 'number' },
        model: { type: 'string' },
      },
      required: ['provider', 'prompt', 'controlNetImageDataUrl'],
    },
  },
]

// ---------------------------------------------------------------------------
// HTTP relay -> main Express server -> browser
// ---------------------------------------------------------------------------

function relay(toolCallId, toolName, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ sessionId: SESSION_ID, toolCallId, toolName, args })
    const req = http.request(
      {
        hostname: 'localhost',
        port: parseInt(PORT, 10),
        path: '/api/mcp-relay/call',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: RELAY_TIMEOUT_MS,
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch (e) {
            reject(new Error(`Invalid relay response (HTTP ${res.statusCode}): ${data.slice(0, 200)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`Relay timeout after ${RELAY_TIMEOUT_MS}ms waiting for tool "${toolName}"`))
    })
    req.write(body)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Direct server-side HTTP call (no browser relay)
//
// Some tools (texture generation, SD process control, texture upload/delete)
// are fully server-side: they hit Express endpoints directly rather than being
// forwarded to the browser. Generation in particular can take minutes, so a
// longer timeout than the browser relay is used.
// ---------------------------------------------------------------------------

const SERVER_SIDE_TIMEOUT_MS = 300000 // 5 minutes — SD generation can be slow.

function serverSideCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const hasBody = body !== undefined && body !== null
    const payload = hasBody ? JSON.stringify(body) : null
    const headers = {}
    if (hasBody) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(payload)
    }
    const req = http.request(
      {
        hostname: 'localhost',
        port: parseInt(PORT, 10),
        path,
        method,
        headers,
        timeout: SERVER_SIDE_TIMEOUT_MS,
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300
          let parsed
          if (data) {
            try {
              parsed = JSON.parse(data)
            } catch (e) {
              if (ok) {
                resolve(data)
              } else {
                reject(new Error(`Server error (${method} ${path}, HTTP ${res.statusCode}): ${data.slice(0, 200)}`))
              }
              return
            }
          } else {
            parsed = {}
          }
          if (ok) {
            resolve(parsed)
          } else {
            const errVal = parsed && parsed.error !== undefined ? parsed.error : `HTTP ${res.statusCode}`
            const errMsg = typeof errVal === 'string' ? errVal : JSON.stringify(errVal)
            reject(new Error(`Server error (${method} ${path}): ${errMsg}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`Server-side call timeout after ${SERVER_SIDE_TIMEOUT_MS}ms for ${method} ${path}`))
    })
    if (hasBody) req.write(payload)
    req.end()
  })
}

// Tools handled directly by the server (no browser relay). Each entry maps the
// tool's args to a serverSideCall against the main Express server. The resolved
// JSON is wrapped as { result } so it flows through the same response path as
// relayed tool calls.
const SERVER_SIDE_TOOLS = {
  generateTexture: (args) => serverSideCall('POST', '/api/textures/generate', args),
  deleteTexture: (args) => serverSideCall('DELETE', `/api/textures/${encodeURIComponent(args.textureId)}`),
  uploadTexture: (args) => serverSideCall('POST', '/api/textures/upload', { dataUrl: args.dataUrl, name: args.name }),
  getSDStatus: () => serverSideCall('GET', '/api/sd/status'),
  getSDResources: (args) => serverSideCall('GET', `/api/sd/resources?type=${encodeURIComponent(args.sdType)}`),
  startSDProcess: (args) => serverSideCall('POST', '/api/sd/start', { sdType: args.sdType }),
  stopSDProcess: () => serverSideCall('POST', '/api/sd/stop'),
  editTexture: (args) => serverSideCall('POST', '/api/textures/edit', args),
  upscaleTexture: (args) => serverSideCall('POST', '/api/textures/upscale', args),
  generateTextureVariations: (args) => serverSideCall('POST', '/api/textures/variations', args),
  batchGenerateTextures: (args) => serverSideCall('POST', '/api/textures/batch', args),
  controlNetGenerate: (args) => serverSideCall('POST', '/api/textures/controlnet', args),
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

function log(...args) {
  // stdout is reserved for protocol traffic — diagnostics go to stderr.
  process.stderr.write('[vst-foundry mcp] ' + args.join(' ') + '\n')
}

// Large reads (getCanvasState / unfiltered getElements) serialize every
// element's full `customCode`, which can balloon past 1.7M chars and overflow
// the MCP transport — the call then dies with "terminated" and nothing reaches
// the client. This guard only engages when a payload is genuinely oversized:
// it recursively truncates long string fields to a labeled preview so the
// response stays well-formed JSON. Small/targeted reads pass through untouched.
const MAX_RESPONSE_CHARS = 200000 // overall serialized-text ceiling
const MAX_STRING_FIELD_CHARS = 1200 // per-string cap once clamping engages

function clampStrings(value) {
  if (typeof value === 'string') {
    if (value.length <= MAX_STRING_FIELD_CHARS) return value
    return (
      value.slice(0, MAX_STRING_FIELD_CHARS) +
      `… [truncated ${value.length - MAX_STRING_FIELD_CHARS} of ${value.length} chars — fetch this element by id for full content]`
    )
  }
  if (Array.isArray(value)) return value.map(clampStrings)
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value)) out[k] = clampStrings(value[k])
    return out
  }
  return value
}

// Serialize a payload to text, clamping bulky string fields only if the raw
// serialization blows past the transport ceiling.
function serializePayload(payload) {
  const raw = JSON.stringify(payload === undefined ? { ok: true } : payload)
  if (raw.length <= MAX_RESPONSE_CHARS) return raw
  log(`payload ${raw.length} chars exceeds ${MAX_RESPONSE_CHARS}; clamping string fields`)
  const clamped = JSON.stringify(clampStrings(payload === undefined ? { ok: true } : payload))
  if (clamped.length <= MAX_RESPONSE_CHARS) return clamped
  // Still too big even after clamping (e.g. thousands of elements) — return a
  // structured notice instead of a doomed oversized blob.
  return JSON.stringify({
    error: 'response_too_large',
    message: `Result is ${raw.length} chars even after truncation. Fetch fewer elements by id, or use captureCanvasScreenshot for a visual check.`,
    truncatedPreview: clamped.slice(0, 8000),
  })
}

async function handleMessage(msg) {
  // Notifications (no id) require no response.
  if (msg.id === undefined || msg.id === null) {
    if (typeof msg.method === 'string' && msg.method.startsWith('notifications/')) return
    // Unknown notification — ignore.
    return
  }

  switch (msg.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'vst-foundry', version: '1.0.0' },
        },
      })
      return

    case 'ping':
      send({ jsonrpc: '2.0', id: msg.id, result: {} })
      return

    case 'tools/list':
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOL_SCHEMAS } })
      return

    case 'tools/call': {
      const params = msg.params || {}
      const name = params.name
      const args = params.arguments || {}
      const toolCallId = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      try {
        // Server-side tools hit Express endpoints directly; everything else is
        // forwarded to the browser via the relay.
        const result = SERVER_SIDE_TOOLS[name]
          ? { result: await SERVER_SIDE_TOOLS[name](args) }
          : await relay(toolCallId, name, args)
        if (result && result.error) {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(result.error) } })
        } else if (result && result.imageData) {
          // captureCanvasScreenshot -> image content
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              content: [{ type: 'image', data: result.imageData, mimeType: 'image/png' }],
            },
          })
        } else {
          let payload = result ? result.result : undefined
          // Lean-by-default reads: getCanvasState and an UNFILTERED getElements
          // return every element's full customCode/base64, which is what blew
          // past the transport before. Strip bulky string fields to size markers
          // for these broad reads. A targeted getElements({ids:[...]}) is left
          // untouched so the model can read full source before editing it.
          const isBroadRead =
            name === 'getCanvasState' ||
            (name === 'getElements' && !(Array.isArray(args.ids) && args.ids.length))
          if (isBroadRead && payload && typeof payload === 'object') {
            payload = clampStrings(payload)
          }
          const text =
            typeof payload === 'string'
              ? payload
              : serializePayload(payload)
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text }] },
          })
        }
      } catch (e) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: e && e.message ? e.message : String(e) } })
      }
      return
    }

    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } })
  }
}

// ---------------------------------------------------------------------------
// stdin reader (line-delimited JSON)
// ---------------------------------------------------------------------------

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  const lines = buf.split('\n')
  buf = lines.pop()
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed
    try {
      parsed = JSON.parse(trimmed)
    } catch (e) {
      log('Failed to parse line:', trimmed.slice(0, 200))
      continue
    }
    Promise.resolve()
      .then(() => handleMessage(parsed))
      .catch((e) => log('handleMessage error:', e && e.message ? e.message : String(e)))
  }
})

process.stdin.on('end', () => process.exit(0))
process.stdin.on('error', (e) => {
  log('stdin error:', e && e.message ? e.message : String(e))
  process.exit(1)
})

// Never let an unexpected error tear down the protocol stream silently.
process.on('uncaughtException', (e) => log('uncaughtException:', e && e.stack ? e.stack : String(e)))
process.on('unhandledRejection', (e) => log('unhandledRejection:', e && e.message ? e.message : String(e)))
