# VST Foundry Documentation

VST Foundry is a browser-based, drag-and-drop builder for audio-plugin and
web-audio interfaces. You lay knobs, sliders, meters, and artwork out on a live
canvas, style and wire them, optionally let a multi-provider AI co-designer drive
the canvas for you, generate textures and media in-app, then export a runnable
plugin — React/TSX source, raw JSON, a self-contained ZIP, a portable `.gan`
web-plugin, or a VST3 data bundle that a prebuilt native shell loads. Foundry is
a *designer*, not a DAW: it produces plugin UIs and their parameter manifests and
hosts no audio graph of its own. It runs on its own in a browser and, from the
same codebase, as a vendored sidecar embedded as the **Foundry** center tab
inside [theDAW](https://github.com/gantasmo/theDAW).

This is the theDAW-styled doc set for VST Foundry. Start at
[foundry-overview.md](foundry-overview.md), which maps the whole system end to
end; every page below then goes deep on one piece. Each doc describes the code as
it stands and links its siblings for context.

## Docs

| Doc | Covers |
|---|---|
| [foundry-overview.md](foundry-overview.md) | The entry point: what Foundry is end to end, how the designer app, `.gan` format, VST3 path, assistant, and theDAW embed fit together. |
| [canvas-and-controls.md](canvas-and-controls.md) | The designer surface — the infinite canvas, the 17 element types, and the panels that place, style, and wire each control. |
| [custom-code.md](custom-code.md) | The **CustomCode** element: your own HTML/CSS/JS in a sandboxed iframe, its postMessage bridge, parameters, and theDAW bindings. |
| [textures-and-skins.md](textures-and-skins.md) | The visual asset pipeline — procedural and AI-generated textures, CSS material skins, and image faces, and how they attach and export. |
| [component-extractor.md](component-extractor.md) | The Component Extractor: turning one reference image into labeled cutout components (and real controls) via vision AI, integrated and standalone. |
| [assistant-and-mcp.md](assistant-and-mcp.md) | The in-app AI co-designer — the Assistant orb, the multi-provider chat backend, the persistent BCC session, and the MCP canvas bridge. |
| [gan-format.md](gan-format.md) | The `.gan` portable web-plugin package: its on-disk shape, Foundry's export/import round-trip, and the theDAW host bridge that wires it up. |
| [vst3-export.md](vst3-export.md) | The VST3 export path — the browser-side data-bundle exporter and the native iPlug2 **FoundryShell** that loads it at runtime. |
| [thedaw-integration.md](thedaw-integration.md) | How Foundry lives inside theDAW: the Node sidecar, the center-tab embed, the two control buses, and the exported-`.gan` plugin runtime. |
| [projects-and-data.md](projects-and-data.md) | The persistence model — where the canvas lives across IndexedDB, localStorage, and the sidecar `data/` folder, and what survives a restart. |
| [troubleshooting.md](troubleshooting.md) | When Foundry will not start: ports, sidecar spawns, rejected imports, native-shell build failures, the exact errors, and how to clear them. |
| [index.md](index.md) | This page — the map of the doc set. |
| [thedaw-docs-integration-proposal.md](thedaw-docs-integration-proposal.md) | Proposal for folding this doc set into theDAW's own wiki/docs. |

> Note: `thedaw-docs-integration-proposal.md` is present but is a *proposal*, not
> a shipped plan — it describes how this doc set could fold into theDAW's own
> wiki/docs and awaits a decision. Treat it as a design note, not current state.

## Where else things live

The pre-restyle legacy docs still sit one level up in
[`../`](../) (for example [`../getting-started.md`](../getting-started.md),
[`../ai-assistant.md`](../ai-assistant.md), and the legacy
[`../index.md`](../index.md)). Design and implementation plans and their reports
live in [`../plans/`](../plans/) and [`../reports/`](../reports/). Where the
legacy docs and this set disagree, treat this set and the code as authoritative.

---

<p align="center"><a href="foundry-overview.md">Next: Foundry Overview &gt;</a></p>
