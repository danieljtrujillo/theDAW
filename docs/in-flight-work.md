# In-flight work — branch `wip/pre-torchcodec-checkpoint`

**Owner:** Daniel (gantasmo)
**Last updated:** 2026-05-27
**Remote:** `new_origin/wip/pre-torchcodec-checkpoint` (fork at
`gantasmo/theDAW`). Upstream `origin` is `Stability-AI/stable-audio-3`,
no push access.

This is the living "what's been done / what's left" doc for the
**Top-bar restructure + 3D-graph upgrade + Gemini catalog + supervisor**
work that started 2026-05-27. The original plan file lives at
`C:\Users\dtruj\.claude\plans\abundant-hugging-spark.md`; this file is
the up-to-date status companion that future-Claude sessions (and the
user) read FIRST.

> **Future-Claude:** if you're about to "clean up" or "consolidate"
> entries in [backend/assistant_routes.py](../backend/assistant_routes.py)
> model catalogs or change the ruff pin in
> [pyproject.toml](../pyproject.toml) /
> [.github/workflows/lint.yml](../.github/workflows/lint.yml), READ
> [CLAUDE.md](../CLAUDE.md) → "🚨 HARD RULES" first. You have been
> warned (twice).

---

## ✅ DONE — landed on this branch (10 commits since checkpoint)

| SHA | Step | Summary |
|---|---|---|
| `f21b551` | 1 | LineageModal TypeScript cleanup (`useRef<any>` for fgRef; removed dead `cameraPosition` prop on ForceGraph3D). |
| `55fdd24` | 2a | Graph defaults now match the user-supplied appearance screenshot (particle-cloud preset, 0.7/1.0/0.35/0.15/0.004 sliders, pure-black bg). Appearance persists to `localStorage` under `lineageGraphAppearance:v1`. New graph search overlay (substring filter dims non-matches). |
| `e7c2776` | 2b | Tighter initial graph layout (zoomToFit padding 80 → 12, d3Force charge -90 + link distance 18). Neighbor edge highlight on hover via `linkColor` / `linkWidth` callbacks. New `LineageModal` `mode='modal'\|'embedded'` prop; `LineageView` named export so center-bar can mount the graph inline. |
| `8bed1d1` | extra | In-app **Restart Server** button + `backend/_supervisor.py` two-process model. `start-dev.bat` now spawns the supervisor so restart replaces the inner uvicorn inside the SAME SA3 Backend console — no window flashing. |
| `c5ee8a3` | 2c | Node-mesh dimming on hover (Three.js scene-traverse). Cluster tint by `source` (translucent halo spheres centered on per-source centroids). Click-to-select **node-details slide-out** showing source / kind / model / duration chips + incoming/outgoing edges. |
| `74a2f4d` | extra | Restart-button hardening: 90s poll deadline (was 30s, too tight for cold-start with CUDA torch + model load), supervisor detection via `SA3_SUPERVISOR_PRESENT` env var, 412 + helpful detail when run without the supervisor. |
| `a7d9eb9` | 3a | New `CenterTabBar` — TRAIN / MAKE / EDIT / MIX / LEARN, centered, with side-panel collapse arrows at its inner edges. Old left-side CREATE/PROCESS/TRAIN tabs and old center WAVEFORM/ADVANCED/EFFECTS tabs both removed. `appUiStore.centerTab` added with `LEGACY_VIEW_TO_CENTER_TAB` shim so existing `setActiveView('create')` callers (orb-kit, WaveformEditor "back to Create" button, etc.) continue to route correctly. |
| `ee1af32` | 3c | `ProcessingLog` extracted from left panel and pinned to a **persistent right rail** that stays visible when the Library collapses. Sleek 45° clip-path on its left edge when standalone. |
| `f8b5309` | 5 | Gemini model catalog grew 3 → 34 entries (fetched from `ai.google.dev/gemini-api/docs/models`, NOT from training memory). Covers full 3.x family (3.5 Flash stable, 3.1 Pro preview, Live, TTS, Nano Banana 2, Nano Banana Pro, 3-pro shutdowns), full 2.5, deprecated 2.0, research/agent (Deep Research / Antigravity), embeddings, robotics, media-gen siblings (Veo / Imagen / Lyria), sliding latest-aliases. New capability tags: `live`, `tts`, `music_gen`, `video_gen`, `embeddings`, `agentic`, `research`, `robotics`, `deprecated`. New frontend `ModelCapabilityHints` component renders capability chips + "this model can't do chat" / "deprecated" warnings below the active-model line in the assistant panel. |
| `ba5425f` | extra | Re-applied ruff format on `backend/assistant_routes.py` (the catalog edit drifted format). Locked in two new HARD RULES at the top of [CLAUDE.md](../CLAUDE.md): (1) NEVER downgrade external models, (2) NEVER allow ruff version drift. Mirror banners added to [pyproject.toml](../pyproject.toml), [.github/workflows/lint.yml](../.github/workflows/lint.yml), and the top of [backend/assistant_routes.py](../backend/assistant_routes.py). New memory `feedback_never_downgrade_models`; existing `feedback_ruff_version_pin` escalated. |

**Pre-checkpoint sidecar work** (not in the commit range above, see
`a48ba70` and earlier): torchcodec + FFmpeg shared DLL bootstrap into
`.sidecar_venv/Scripts/`, `sitecustomize.py` for `os.add_dll_directory`,
cross-drive `shutil.move` patch in the integration-package's `main.py`
(line 818). See memory `project_stems_sidecar_venv_setup`.

---

## 🚧 IN FLIGHT — none right now

Branch is in a clean stop-and-resume state. The 4 modified files +
3 untracked frontend files in `git status` are **pre-existing
in-progress work that predates this push series** — leave alone
unless the user picks them up explicitly. See "Floating untracked
work" below.

---

## ⏳ DEFERRED — next up

These are queued from the plan but not started. Suggested order from
smallest-impact-per-context-spend to biggest:

### Step 3a follow-up — vertical alignment polish
The plan called for "Justify the top and bottom lines across create,
process, train, make, edit, mix, library" — i.e. the tab bar's top
edge and the bottom rail's bottom edge should land on the same Y
coordinate regardless of which tab is active. **Status: tab bar is in
place but the bottom-rail / log alignment hasn't been verified
per-tab.** Light pass needed; ~30 min.

### Step 3b — MAKE & MIX content merge (BIG)
The plan's biggest remaining task. Move:

- `GenerateView` content → **MAKE** as a collapsible "Prompt + Settings"
  section alongside the existing `AdvancedView` content
- `AdvancedGenPanel` (inpaint/init/chimera) → **MAKE** as a third
  section
- `StudioView` content → **MIX** as a collapsible "Studio Effects"
  section alongside the existing `AdvancedEditorPanel` content
- Existing stems modal tools → **MIX** as a "Stems Tools" section

**DO NOT REMOVE FEATURES.** The user has explicitly stipulated this
multiple times. Anything in the old views moves into the new tabs.

Once content has fully moved, `GenerateView` / `StudioView` files can
be deleted (currently orphaned imports — Shell.tsx no longer mounts
them after Step 3a). Test that orb-kit `navigate` actions and the
LibraryView's row-click-back-to-CREATE still route via the legacy
shim into MAKE.

Likely 200–400 LOC. Should be its own PR.

### Step 3d — shared ContextMenu primitive + 5–7 surfaces
Per plan:

1. New `frontend/src/components/ui/ContextMenu.tsx` — portal-mounted,
   autopositioned, supports submenus / separators / disabled / danger
   / icons. Closes on outside click + Escape.
2. Migrate existing rolled-their-own callers (`LibraryView.tsx`
   :756/904/1146/1283, `WaveformEditor.tsx` :1487/1645). Visual parity
   verification.
3. Wire onto NEW surfaces: library entries, graph nodes (3D + 2D),
   stems rows, MIDI rows, waveform clips, track headers, tag chips.
4. Per-surface `items` factories: open / rename / duplicate / delete
   / copy id / download / "Send to MAKE" / "Send to MIX" / "Send to
   LEARN" / "Show in Library" / "Open Lineage".

### Done — one console for the whole stack
`start-dev.bat` was renamed to `theDAW.bat` and now launches
`backend._devstack`, which runs backend + frontend + tunnel in a
single window, streaming all three as prefixed `[backend]` /
`[frontend]` / `[tunnel]` log lines. The backend still runs under the
rc=88 supervisor contract, so the in-app Restart button works. This
replaced the previous three-cmd-window launch.

### Step 2 polish (low priority)
- Cluster tint computes centroids ONCE after a 2.8s settle delay; if
  the user reopens the view or the graph relayouts, halos may drift.
  Could re-run on `onEngineStop` callback for stability.
- Search overlay re-runs the `data` useMemo on every keystroke — may
  re-mount node Three.js groups on bigger graphs. Debouncing the
  query input would help if perf becomes an issue.
- Node-details panel `Open in Editor / Add Stems / Send to MAKE`
  action buttons were deferred pending Step 3b's target tabs existing.
  Now that 3a is in, these CAN be wired.

---

## ⚠️ FLOATING WORK — present in `git status` but not mine

These four files have been modified since before this branch started,
and three new files are untracked. I deliberately have NOT touched
them so my diffs stay focused and reviewable. Picking them up is a
follow-on task the user owns.

Modified:
- `backend/modules/library/router.py` — has format drift; needs
  `ruff format` + a check of what's actually changed.
- `backend/modules/stems/engine.py` — format drift + content drift.
- `frontend/src/views/LibraryView.tsx` — extensive edits.
- `tests/test_library_endpoints.py` — format drift + new tests.

Untracked (frontend):
- `frontend/src/components/audio/MicRecorder.tsx` — looks like a new
  mic-capture component.
- `frontend/src/components/library/StemsRunModal.tsx` — likely the
  modal that pairs with the stems sidecar.
- `frontend/src/lib/sendToTargets.ts` — utility for "Send to X"
  flows (probably what 3d's right-click actions would call).

Untracked (other):
- `tests/test_stems_engine.py` — new test for the stems engine.
- `frontend/tsconfig.tsbuildinfo` — tsc cache; should probably be in
  `.gitignore`.

When picking these up: run `uv run ruff format .` first to clear the
format drift, then review the content diffs separately.

---

## 🔑 OPEN QUESTIONS / DECISIONS LOG

1. **Lyria integration** — Step 5 surfaced Lyria 3 (Google's music-gen
   model) in the catalog. Worth wiring up as an alternative
   generation backend alongside local `stable_audio_3`? Would slot
   into MAKE as a "remote backend" toggle. **No decision yet.**
2. **Left panel future** — currently shows a "context palette —
   coming with the MAKE / MIX merge" placeholder. The plan is to make
   it a context-sensitive palette per active center tab. Not designed
   yet.
3. **`tsbuildinfo` in `.gitignore`** — should add. Tiny housekeeping
   commit, can roll into the next 3b push.
4. **Right-click everywhere scope** — user picked "primitive + 5–7
   surfaces" in plan mode. If they later want more surfaces (settings
   rows, log lines, footer items), do it as a separate pass.

---

## 🧠 STANDING NOTES for any session that touches this branch

1. **`uv run ruff check .` AND `uv run ruff format --check .` from
   the repo root before every commit.** Both. Always. From repo root,
   not from a subdir. See `CLAUDE.md` → HARD RULES.
2. **`npx tsc -b` in `frontend/` before every commit.** TypeScript
   strict mode catches things the IDE diagnostics don't.
3. **Push to `new_origin`, not `origin`.** Upstream is read-only for
   this user.
4. **No `Co-Authored-By` trailer on commits.** User explicitly
   disallowed.
5. **On GPUs with limited VRAM, heavy model loads can OOM** (medium-size
   DiT, Demucs CUDA on long files). Stems
   sidecar uses its OWN venv with torch+cu128 at
   `D:/StableAudio/JoshOG/integration-package/backend/.sidecar_venv`
   — that venv requires the specific bootstrap described in
   `feedback_never_downgrade_models` and
   `project_stems_sidecar_venv_setup` memories.
6. **Test the restart button via `theDAW.bat`, not `python -m
   backend.run`.** Direct launch lacks the supervisor and the endpoint
   refuses with a 412 explaining why.
7. **The user lives across C: and D: drives.** The integration-
   package uses `tempfile.mkdtemp()` (defaults to `C:\Users\...\Temp`)
   while results go to `D:\StableAudio\...`. `shutil.move` everywhere
   that crosses; `os.rename` / `os.replace` are forbidden across
   drives on Windows (WinError 17).

