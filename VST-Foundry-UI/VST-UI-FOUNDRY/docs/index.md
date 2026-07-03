# VST UI Foundry Documentation

Welcome to the **VST UI Foundry** documentation. VST UI Foundry is a browser-based, drag-and-drop UI builder for audio plugin interfaces (VST, AU, AAX) and web-audio apps. Design your UI visually on a live canvas, let a multi-provider AI co-designer build and restyle it for you, generate your own textures and media in-app, and export production-ready React/TSX, JSON, or a ZIP package for JUCE (via WebView) and web-audio projects.

## Table of Contents

1. [Getting Started](./getting-started.md)
2. [UI Components](./ui-components.md)
3. [Styling and Themes](./styling-and-themes.md)
4. [Exporting & Integration](./exporting.md)
5. [Project Management](./project-management.md)
6. [AI Assistant Orchestrator](./ai-assistant.md)
7. [AI Texture Generation](./texture-generation.md)
8. [Component Extractor](./component-extractor.md)
9. [Local Data & Persistence](./local-data.md)

## Key Features

- **Multi-provider AI co-designer:** one assistant backed by 9 providers — Google Gemini, OpenAI, Anthropic, xAI Grok, Groq, OpenRouter, OpenRouter Free, Ollama (local), and LM Studio (local) — plus **Better Claude Code by skreamb0t (@StarskreamEXE)**, which drives the local Claude Code CLI. Models are discovered live per provider.
- **37 AI tools with direct canvas control:** 22 canvas/app actions, web page fetching, 9 texture tools, and 5 generation/edit tools — the AI can add, move, style, align, theme, and delete elements directly.
- **Drag-and-drop canvas:** Knob, Slider, Button, Toggle, Meter, Waveform, XY Pad, ValueBox, Label, Image, Group, and **CustomCode** (a sandboxed iframe that runs your own JS).
- **Procedural glow engine:** outer, inner, and center (volumetric) glows, plus contoured PNG drop-shadows that trace transparent image shapes.
- **Style variants, FX animations, textures & blend modes:** global themes, font scale, layer ordering, undo/redo, multi-select, align/distribute, and snap-to-grid.
- **AI texture & media generation:** Stable Diffusion (A1111/ComfyUI, headless), DALL-E, Gemini Nano Banana, and OpenRouter — with img2img/inpainting, ESRGAN upscaling, variations, batch, and ControlNet.
- **Export:** React/TSX components, JSON canvas data, or a ZIP package (`project.json` + assets + README).
- **Local persistence:** all data saved to `./data/` on disk (sessions, textures, generated media, config, logs), with IndexedDB as a secondary fallback.
