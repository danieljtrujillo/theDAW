# Exporting & Integration

Once your UI is designed, VST Foundry makes it easy to bring it into your actual plugin project. You can export production-ready code, the raw state as JSON, or a self-contained ZIP package.

## Exporting Code

Click the **Export** button in the top navigation bar.

### 1. React / TSX
This mode exports a complete, production-ready React component representing your UI.
- It includes all CSS-in-JS or Tailwind classes needed to render the exact design variants you chose.
- Elements are mapped to their `Export Name`, making it easy to hook up state.

### 2. JSON State
Exports the raw structural data of your UI.
- Useful if you are writing a custom parser for C++ (e.g., JUCE) and just need the X/Y coordinates, dimensions, colors, and types of every element.
- This is **canvas state only** — a single JSON document, not a bundle.

### 3. Export Package (.zip)
Exports a self-contained, distributable snapshot of the entire project as a ZIP archive. This is different from the plain JSON export above: where JSON State is just the canvas state, the ZIP is a complete package you can hand off or archive.

The archive bundles:
- **`project.json`** — the full canvas state.
- **Background images** — any background/texture images used by the project.
- **Per-element JSON stubs** — one JSON stub per element.
- **`README`** — an auto-generated readme describing the package contents.

Under the hood the package is built with **jszip** (to assemble the archive) and **file-saver** (to trigger the download in the browser). The result is a single `.zip` that fully describes the project, independent of the server or your local session.

## Integrating with JUCE / C++

While VST Foundry exports web code, you can use it in C++ plugins via WebViews:
1. Export the React code.
2. Build the React app into a static bundle.
3. Load the bundle into a `juce::WebBrowserComponent`.
4. Use javascript interop to pass parameter changes between C++ and your React UI.

*Note:* Future versions of VST Foundry may include direct C++ export for native JUCE components.
