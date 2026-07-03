# theDAW Docs Integration — Proposal for the Foundry Doc Set

A proposal for folding this Foundry documentation set into theDAW's own
documentation: where each file should live (`docs/guides/`, `docs/workflows/`, or
the GitHub wiki), which files to register in the RAG index, what to add to the
wiki sidebar and Home page, and how the existing `docs/guides/foundry.md` should
relate to the set without duplicating it. It is written for whoever owns theDAW's
docs and RAG index and has to approve and carry out the move. Plain descriptions
of what each step is and what it touches.

> This file is a proposal only. It makes **no edits to theDAW**. Nothing under
> theDAW's `docs/`, `backend/rag.py`, or the wiki is changed by this document —
> every mapping, `DOC_PATHS` entry, and wiki edit below is a *suggestion* to be
> reviewed and applied by hand. Per theDAW's `CLAUDE.md`, all doc and RAG changes
> are approval-based; this document is the approval request, not the change.

## Scope and constraints

The Foundry doc set lives in the vendored Foundry repository under
`docs/thedaw-style/`. theDAW's docs live in a separate repository root
(`docs/guides/`, `docs/workflows/`, `docs/wiki/theDAW/`) and are indexed for the
in-app assistant by `backend/rag.py`. This proposal spans that boundary: the
source files stay where they are; copies (or moves) into theDAW's tree are what
gets approved.

| Constraint | Detail |
|---|---|
| Approval-based | No doc, `DOC_PATHS`, or wiki edit is applied without sign-off. |
| No source edits | This proposal touches no Foundry source and no theDAW source. |
| Preserve cross-links | The set is densely cross-linked with bare relative sibling links (for example `[vst3-export.md](vst3-export.md)`); the destination layout must keep those links valid. |
| Current-state only | Several Foundry files are being edited concurrently. This proposal, and the docs it references, describe the code as it stands; in-flight areas are flagged. |

> Note: at the time of writing, `backend/modules/foundry/sidecar.py`,
> `backend/modules/plugin/router.py`, `backend/modules/plugin/owl_import.py`,
> `frontend/src/components/audio/EffectGuiStage.tsx`,
> `frontend/src/components/audio/TheOwl.tsx`, `frontend/vite.orb.config.ts`, and
> the FoundryShell `config.h` are modified in the working tree, and
> `component-extractor/` and `AspectStage.tsx` are untracked. The set documents
> these areas as they currently exist. Re-verify the affected sections
> (`thedaw-integration.md`, `component-extractor.md`, `vst3-export.md`) against
> the code before publishing.

## The doc set

Twelve reference documents plus this proposal (thirteen files). Each content doc
is already written in theDAW's documentation style: an H1 title with a plain
subtitle, an intro paragraph, `##` sections, Markdown tables, `>` notes, fenced
code, and relative sibling links. The set's own landing page is
[index.md](index.md); its entry point is [foundry-overview.md](foundry-overview.md).

| File | Covers | Reads as |
|---|---|---|
| [index.md](index.md) | Landing page and table of contents for the set | Orientation |
| [foundry-overview.md](foundry-overview.md) | What Foundry is end to end, its architecture at a glance, and links to every sibling | Guide (entry) |
| [canvas-and-controls.md](canvas-and-controls.md) | The design canvas, the 17 element types, and the panels that place, style, and wire them | Guide |
| [custom-code.md](custom-code.md) | The `CustomCode` element, its sandboxed iframe, postMessage bridge, and parameter model | Guide |
| [gan-format.md](gan-format.md) | The `.gan` portable web-plugin bundle: on-disk shape, export/import round-trip, host bridge | Guide (reference) |
| [textures-and-skins.md](textures-and-skins.md) | Procedural and AI textures, CSS material skins, and image faces; how they composite and ride exports | Guide |
| [assistant-and-mcp.md](assistant-and-mcp.md) | The Assistant orb, the multi-provider chat backend, the persistent BCC session, and the MCP canvas bridge | Guide |
| [thedaw-integration.md](thedaw-integration.md) | The sidecar, the center-tab embed, the two control buses, and the exported-plugin runtime inside theDAW | Guide |
| [projects-and-data.md](projects-and-data.md) | Where Foundry state lives (IndexedDB, localStorage, on-disk `data/`) and what survives a restart | Guide (reference) |
| [troubleshooting.md](troubleshooting.md) | Ports, spawn failures, rejected imports, native-shell build errors, and the commands to clear them | Guide (reference) |
| [component-extractor.md](component-extractor.md) | Turning one reference image into labeled cutout components and real controls via vision AI | Workflow |
| [vst3-export.md](vst3-export.md) | Exporting a canvas to a VST3 data bundle and the native iPlug2 FoundryShell that loads it | Workflow |
| [thedaw-docs-integration-proposal.md](thedaw-docs-integration-proposal.md) | This file | Proposal |

> Note: `thedaw-docs-integration-proposal.md` (this file) is **not** shipped into
> theDAW. It stays in the Foundry repo as the integration record. It is excluded
> from every destination and `DOC_PATHS` entry below.

## 1. Destination mapping

theDAW splits its docs three ways: `docs/guides/` holds "what each piece does"
references (this is where `foundry.md` and `underfit.md` already live and are
RAG-indexed), `docs/workflows/` holds step-by-step task walkthroughs (`lora.md`,
`inference.md`, `autoencoder.md`, `underfit-lora-training.md`), and
`docs/wiki/theDAW/` holds short orientation pages that link out to the depth.

The set is a cohesive, densely cross-linked unit. Every doc links its siblings by
bare relative filename (for example `canvas-and-controls.md` links
`[vst3-export.md](vst3-export.md)`). To keep those links valid with **zero body
edits**, the whole set should land in a single directory under identical
filenames. The recommended home is a new `docs/guides/foundry/` subfolder.

### Recommended: unified under `docs/guides/foundry/`

Keeps all sibling links intact, groups the set beside the existing
`docs/guides/foundry.md`, and ships in the packaged desktop build (which bundles
`docs/**/*.md`). Filenames are preserved 1:1 from `docs/thedaw-style/`.

| Source (`docs/thedaw-style/`) | Destination | Reads as |
|---|---|---|
| `index.md` | `docs/guides/foundry/index.md` | Orientation |
| `foundry-overview.md` | `docs/guides/foundry/foundry-overview.md` | Guide (entry) |
| `canvas-and-controls.md` | `docs/guides/foundry/canvas-and-controls.md` | Guide |
| `custom-code.md` | `docs/guides/foundry/custom-code.md` | Guide |
| `gan-format.md` | `docs/guides/foundry/gan-format.md` | Guide |
| `textures-and-skins.md` | `docs/guides/foundry/textures-and-skins.md` | Guide |
| `assistant-and-mcp.md` | `docs/guides/foundry/assistant-and-mcp.md` | Guide |
| `thedaw-integration.md` | `docs/guides/foundry/thedaw-integration.md` | Guide |
| `projects-and-data.md` | `docs/guides/foundry/projects-and-data.md` | Guide |
| `troubleshooting.md` | `docs/guides/foundry/troubleshooting.md` | Guide |
| `component-extractor.md` | `docs/guides/foundry/component-extractor.md` | Workflow |
| `vst3-export.md` | `docs/guides/foundry/vst3-export.md` | Workflow |

Under this layout the guide-vs-workflow distinction is honored by cross-linking
and by the wiki, not by physical fragmentation: `component-extractor.md` and
`vst3-export.md` still read as task walkthroughs and are surfaced as such from the
wiki Foundry page and from `docs/guides/foundry.md`, but they stay beside the
references they link to.

### Alternative: physical split into `docs/workflows/`

If theDAW's convention requires the two walkthrough-flavored docs to live under
`docs/workflows/`, move them there and leave the ten references (plus `index.md`)
in `docs/guides/foundry/`.

| Source | Destination |
|---|---|
| `component-extractor.md` | `docs/workflows/foundry-component-extractor.md` |
| `vst3-export.md` | `docs/workflows/foundry-vst3-export.md` |

> This split **breaks relative links** and requires body edits, so it is not the
> default. Moving these two out of the set changes the relative path between them
> and their siblings. Every `[vst3-export.md](vst3-export.md)` and
> `[component-extractor.md](component-extractor.md)` link (in `index.md`,
> `foundry-overview.md`, `canvas-and-controls.md`, `custom-code.md`,
> `gan-format.md`, `textures-and-skins.md`, and in the two files themselves) would
> need rewriting to `../workflows/foundry-vst3-export.md`, and the two moved
> files' own sibling links would need `../guides/foundry/` prefixes. Those edits
> are approval-gated like everything else here. Prefer the unified layout unless
> there is a strong reason not to.

## 2. Proposed `DOC_PATHS` entries for RAG

`backend/rag.py` indexes an explicit list, `DOC_PATHS`, chunked by `##` headers
(`MAX_CHUNK_CHARS = 800`). The RAG serves the **in-app assistant**, which answers
end-user questions, so the goal is user-relevant coverage, not indexing every
source-internal reference. The set's files are large (18–39 KB each) and several
document source-file internals that an end user would never ask about; indexing
all twelve would add a large number of chunks and can dilute retrieval.

The recommendation is two tiers. Register the user-facing conceptual docs; leave
the deep source-internal references as repo/wiki docs only (still shipped, still
linked, just not embedded).

> These entries assume the **unified `docs/guides/foundry/` layout** from §1 has
> been approved and the files copied. If the alternative split is used instead,
> change the two workflow paths to `docs / "workflows" / "foundry-*.md"`.

```python
# --- PROPOSED (approval-based) — add to DOC_PATHS in backend/rag.py ---
# VST Foundry guide set (docs/guides/foundry/). The concise user entry,
# docs/guides/foundry.md, is already indexed above and links into this set.
# Tier 1 — user-facing, recommended for RAG:
PROJECT_ROOT / "docs" / "guides" / "foundry" / "foundry-overview.md",
PROJECT_ROOT / "docs" / "guides" / "foundry" / "canvas-and-controls.md",
PROJECT_ROOT / "docs" / "guides" / "foundry" / "textures-and-skins.md",
PROJECT_ROOT / "docs" / "guides" / "foundry" / "assistant-and-mcp.md",
PROJECT_ROOT / "docs" / "guides" / "foundry" / "component-extractor.md",
PROJECT_ROOT / "docs" / "guides" / "foundry" / "vst3-export.md",
PROJECT_ROOT / "docs" / "guides" / "foundry" / "gan-format.md",
PROJECT_ROOT / "docs" / "guides" / "foundry" / "projects-and-data.md",
PROJECT_ROOT / "docs" / "guides" / "foundry" / "troubleshooting.md",
# Tier 2 — source-internal references. OPTIONAL for RAG; index only if the
# assistant is expected to answer developer-level questions. Otherwise leave
# them as repo/wiki docs (they still ship and are still linked):
# PROJECT_ROOT / "docs" / "guides" / "foundry" / "custom-code.md",
# PROJECT_ROOT / "docs" / "guides" / "foundry" / "thedaw-integration.md",
# --- END PROPOSED ---
```

> `index.md` is deliberately not indexed: it is a table of contents, so its chunks
> would be low-signal for retrieval. `thedaw-docs-integration-proposal.md` is
> never indexed — it does not ship into theDAW.

> After any approved change to `DOC_PATHS`, the index re-hashes and rebuilds on
> next assistant use (`_compute_docs_hash` includes each path's mtime), so no
> manual re-index step is needed. Confirm there are no `[RAG] Skipping missing doc`
> warnings on startup, which would mean a path in the list does not resolve.

## 3. Wiki sidebar and Home additions

The set is too deep to paste into the wiki, whose pages are short orientation
stubs that link out to the depth (see `Modules-and-Sidecars.md`). The proposal is
one **new orientation page**, `docs/wiki/theDAW/Foundry.md`, written fresh in the
wiki's own style (a few paragraphs plus a table linking into the guide set) — not
a copy of any set file. `foundry-overview.md` is the source to summarize. Drafting
that page is its own approval item (§5).

### `docs/wiki/theDAW/_Sidebar.md`

Add a `Foundry` entry to the `### theDAW` list, after `Modules and Sidecars`:

```markdown
- [Modules and Sidecars](Modules-and-Sidecars)
- [Foundry](Foundry)
- [Troubleshooting](Troubleshooting)
```

### `docs/wiki/theDAW/Home.md`

Add one row to the `## Pages` table, after the `Modules and Sidecars` row:

```markdown
| [Foundry](Foundry) | The plugin-UI builder: canvas, controls, textures, export, and how it embeds. |
```

> The new `Foundry.md` wiki page should link into the guide set by GitHub blob URL
> (the pattern the wiki already uses for the User Guide and README), for example
> `https://github.com/gantasmo/theDAW/blob/main/docs/guides/foundry/foundry-overview.md`,
> since wiki pages and `docs/` live in different trees and cannot use relative
> links to each other.

## 4. Relationship to the existing `docs/guides/foundry.md`

`docs/guides/foundry.md` already exists as the **concise, user-facing** Foundry
guide, and it is already in `DOC_PATHS`. It should stay exactly that: a short
"what the tab is and how to use it" overview. This set is the **deep reference**
underneath it. The two must not duplicate each other.

| Doc | Role | Audience |
|---|---|---|
| `docs/guides/foundry.md` (existing) | Concise tab overview: opening Foundry, the workspace, the AI orb, texture generation, exporting, operational notes | End users |
| `docs/guides/foundry/` (this set) | Subsystem-level reference: element model, `.gan`/VST3 internals, extractor pipeline, control buses, persistence, failure modes | Power users and developers |

Proposed relationship, to be applied on approval (an edit to `foundry.md`, so
approval-based):

- Add a short "Further reference" pointer near the top or bottom of `foundry.md`
  linking into the set — `[foundry/foundry-overview.md](foundry/foundry-overview.md)`
  as the entry point, plus the two walkthroughs (`component-extractor.md`,
  `vst3-export.md`) by name.
- Where `foundry.md` already summarizes a topic the set covers in depth (the
  workspace, the AI orb, exporting, operational notes), keep the summary and add a
  "see …" link to the matching set doc instead of expanding it in place.
- The set's own docs already link *back* to concepts by sibling filename; they do
  not need a link to `foundry.md`, but `foundry-overview.md` may gain one pointing
  up to the concise guide as the "start here" page.

> Do not merge the two. `foundry.md` is what a first-time user reads; the set is
> what someone editing Foundry or debugging an export reads. Keeping them separate
> keeps the RAG's user-facing answers concise while the depth stays one link away.

## 5. Approval checklist

Each item is an independent, approval-gated action. None is applied by this
document. Recommended order top to bottom.

- [ ] Approve the destination layout: unified `docs/guides/foundry/` (§1
      recommended) **or** the physical `docs/workflows/` split (§1 alternative,
      accepting the link-rewrite cost).
- [ ] Copy the twelve content files into the approved destination, preserving
      filenames. Exclude `thedaw-docs-integration-proposal.md`.
- [ ] If the alternative split is chosen, rewrite the affected relative sibling
      links in the moved and referencing files (§1).
- [ ] Add the approved `DOC_PATHS` entries to `backend/rag.py` (§2). Decide Tier 2
      (`custom-code.md`, `thedaw-integration.md`) in or out.
- [ ] Start theDAW and confirm no `[RAG] Skipping missing doc` warnings for the
      new paths; spot-check an assistant question against the new content.
- [ ] Draft the new `docs/wiki/theDAW/Foundry.md` orientation page (fresh, wiki
      style, blob-URL links into the set).
- [ ] Apply the `_Sidebar.md` and `Home.md` additions (§3).
- [ ] Edit `docs/guides/foundry.md` to add the "Further reference" links into the
      set and swap in-place depth for "see …" links (§4). Do not duplicate.
- [ ] Re-verify the in-flight sections (`thedaw-integration.md`,
      `component-extractor.md`, `vst3-export.md`) against the current source before
      publishing, since those files are being edited concurrently.
- [ ] Per theDAW's `CLAUDE.md`, keep this proposal as the record of what was
      approved and applied.
