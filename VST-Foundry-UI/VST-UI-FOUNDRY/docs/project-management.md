# Project Management

VST Foundry persists your work **server-side**. A small companion server keeps the authoritative copy of your project on disk under the `./data/` directory and serves it back to the browser. The browser's IndexedDB is used only as a secondary fallback for offline / no-server scenarios.

## How Persistence Works

The app talks to the server over a handful of HTTP endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/state` | `GET` | Load the saved canvas state. |
| `/api/state` | `POST` | Save the current canvas state. |
| `/api/config` | `GET` | Load app configuration. |
| `/api/config` | `POST` | Save app configuration. |
| `/api/health` | `GET` | Check that the server is up. |

### Auto-save

Your canvas state is saved automatically:

- **Every 5 seconds** while you work.
- **On change** — significant edits trigger a save as they happen.

Saves are written to `./data/sessions/latest.json` on the server. Because the server holds the authoritative copy, your work survives a browser refresh, a new tab, or moving to a different browser on the same machine — as long as the server is running.

### IndexedDB Fallback

If the server is unreachable (offline use, server not started), the app falls back to **IndexedDB** in the browser. This is a secondary store only. When the server comes back, the server-side copy in `./data/sessions/latest.json` is the source of truth.

## The `./data/` Directory

Everything the server persists lives under `./data/`:

| Path | Contents |
|------|----------|
| `./data/sessions/latest.json` | The auto-saved canvas state (elements, layout, colors, dimensions). |
| `./data/textures/` | Texture files. Served to the app at `/textures/`. |
| `./data/generated/` | AI-generated images (raw output). |
| `./data/config.json` | App configuration. |
| `./data/logs/` | Server logs. |

## Save / Load / New Project Flows

### Saving

You normally don't need to do anything — auto-save handles it. Clicking **Save** in the top bar forces an immediate write of the current canvas state to `./data/sessions/latest.json` via `POST /api/state`.

Saved state includes all elements, layout data, colors, and canvas dimensions. Uploaded image assets are stored as texture files under `./data/textures/` and referenced by URL, rather than being inlined into the state file.

### Loading

On startup the app calls `GET /api/state` and restores the canvas from `./data/sessions/latest.json`. There is nothing to load manually — the most recent state comes back automatically.

### New / Clearing the Canvas

To start fresh, click the **Trash** icon in the top bar. You'll be prompted to confirm before the canvas is wiped. The next auto-save then overwrites `latest.json` with the empty canvas.

## What Lives in the Browser (localStorage)

A small set of values is kept in the browser's **localStorage**, *not* on the server:

- **API keys** (OpenAI / Gemini, etc.) — kept client-side and out of any saved project file or export.
- **UI preferences** — panel layout and similar interface settings.
- **Theme** — your light/dark and color choices.

These are per-browser conveniences. They are intentionally never written into `./data/` so that credentials and personal UI settings stay out of the shared project state.

## Backups & Restore

Because everything important lives under `./data/`, backing up your work is just a matter of copying that folder:

- **Back up:** copy the entire `./data/` directory somewhere safe. This captures your sessions, textures, generated images, config, and logs in one shot.
- **Restore:** stop the server, replace `./data/` with your backup copy, and start the server again. The app will load `./data/sessions/latest.json` and your project returns exactly as it was.

*Tip:* `./data/generated/` and `./data/textures/` can grow large with AI-generated assets. If you only want the project itself, `./data/sessions/latest.json` and `./data/config.json` are the two files that define your working state.
