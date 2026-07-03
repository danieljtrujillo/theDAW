# Local Data & Persistence

VST Foundry keeps all of its persistent state on your local filesystem, in a single `data/` folder at the project root. Nothing in this folder is committed to version control — your personal paths, Stable Diffusion configuration, textures, and session state never leave your machine.

This guide explains what lives under `data/`, how each piece is used, and how to back up, move, or reset your local state.

## Where Everything Lives

Everything is stored under `./data/` in the project root. The server creates this folder (and every subfolder below) automatically on first start, so you never have to set it up by hand.

```
./data/
  config.json          — app configuration (SD paths, ports, preferences)
  sessions/
    latest.json        — auto-saved session state (elements, canvas, assets, textures)
  textures/            — texture image files served at /textures/<filename>
  generated/           — raw AI-generated images (also copied to textures/)
  logs/
    app.log            — server-side event and error log
```

| Path | Purpose |
|------|---------|
| `data/config.json` | Stable Diffusion engine settings and app preferences. |
| `data/sessions/latest.json` | The auto-saved snapshot of your current project. |
| `data/textures/` | Uploaded and generated texture files, served over HTTP. |
| `data/generated/` | Raw output from AI generation, before it is copied into `textures/`. |
| `data/logs/app.log` | Append-only server log of SD process events, generation requests, and errors. |

## `config.json` — Application Configuration

`config.json` stores your Stable Diffusion settings and machine-specific preferences:

- **Preferred engine** — `a1111` or `comfyui`.
- **Per-engine settings** — executable path, port, extra launch arguments, and an optional Python interpreter override.
- **Model library directory** — where your Stable Diffusion checkpoints live.
- **Output directory** — where generation output is written (when overridden).
- **Auto-start flags** — whether an engine should launch automatically with the server.

A typical file looks like this:

```json
{
  "sd": {
    "preferred": "a1111",
    "a1111": {
      "execPath": "D:\\StabilityMatrix-win\\...\\launch.py",
      "port": 7860,
      "autoStart": false,
      "extraArgs": "--api",
      "pythonPath": ""
    },
    "comfyui": {
      "execPath": "D:\\StabilityMatrix-win\\...\\main.py",
      "port": 8188,
      "autoStart": false,
      "extraArgs": "",
      "pythonPath": ""
    },
    "modelLibraryDir": "D:\\StabilityMatrix-win\\...\\Stable-diffusion",
    "outputDir": ""
  }
}
```

**How it is created:** On the first server start, if `config.json` does not exist, the server writes one with empty defaults. You normally never create this file yourself.

**How to edit it:** Use the in-app UI — **Settings → Stable Diffusion** — which reads and writes this file for you. You can also edit it by hand if you prefer; the server reads it on start.

**It is gitignored.** Because the paths here are absolute and point to your own machine, this file is never committed. Your personal layout never leaks into the repository.

## Session Persistence

Your project state is saved continuously, with no manual "Save" step:

- On every state change, the app auto-saves the current project to `data/sessions/latest.json`.
- On startup, the server loads this file and sends the saved state to the client, so you pick up exactly where you left off.
- The browser's IndexedDB is used as a **secondary fallback** — if the server-side session is unavailable, the client can restore from its local copy.

`latest.json` contains a full snapshot of your project:

- **Canvas elements** — every component you have placed.
- **Canvas state** — dimensions, background, and grid settings.
- **Assets list** — metadata for images and background assets (metadata only, not the image bytes).
- **Textures list** — texture metadata plus file references (the `/textures/...` URLs described below).

## Textures

Textures are stored as real files on disk, not embedded in the session JSON.

- When you upload a texture, the file is written into `data/textures/` and served by the Express server at `/textures/<filename>`.
- The URL stored in each Texture object is a **server-relative path** — for example `/textures/3f0f...e8.png` — **not** a `data:` URL or a `blob:` URL. This keeps the session file small and lets textures be shared by reference.

**Generated textures** follow one extra step: AI-generated images are first written to `data/generated/`, then copied into `data/textures/` so they can be served like any other texture. The raw originals remain in `data/generated/`.

## Logs

`data/logs/app.log` is the server-side event and error log. It records:

- **SD process lifecycle** — start and stop events for the Stable Diffusion engine.
- **Generation requests** — the provider used, a snippet of the prompt, and the number of images requested.
- **Server-side errors** — failures that occur in the backend.

The log is **append-only and grows indefinitely**. There is no automatic rotation, so prune or delete `app.log` manually if it gets large. (Note: `*.log` files are also covered by `.gitignore`.)

## Gitignore Implications

The entire `data/` directory is listed in `.gitignore`:

```gitignore
# Local data — personal files, not committed
data/
```

What this means in practice:

- If you **fork, clone, or publish** this project, none of your local data is included — no config, no textures, no session state, no logs.
- A fresh clone has **no `data/` folder at all**; the server recreates it with empty defaults on first start.
- Your machine-specific Stable Diffusion paths stay private. Nothing under `data/` is ever staged or pushed.

## Backup & Portability

### Backing up or moving a project

To back up your work or move it to another machine:

1. **Copy the entire `data/` folder.** This captures your config, session, textures, and logs in one move.
2. The `textures/` subfolder contains **all image files referenced by your session state**, so copying the folder keeps every texture reference intact.
3. **Update absolute paths after moving.** The paths in `config.json` (executable paths, model library directory, etc.) are absolute and point at the original machine. After moving to a new machine, open **Settings → Stable Diffusion** and update them, or edit `config.json` directly.

### Resetting to a clean state

To start over:

- Delete `data/sessions/latest.json` to clear the saved project while keeping your config and textures, **or**
- Delete the whole `data/` folder to reset everything. The server recreates it with empty defaults on the next start.

> Tip: When clearing the server-side session, remember the browser's IndexedDB fallback may still hold a copy of recent state. Clear the site's browser storage too if you want a fully clean slate.
