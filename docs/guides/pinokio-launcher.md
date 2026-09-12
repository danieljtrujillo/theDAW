# Pinokio launcher

## What the launcher is

The Pinokio launcher is a one-click installer and runner for theDAW. It wraps the install and startup steps so theDAW can be set up and launched from the Pinokio app without terminal commands. The launcher lives on GitHub at github.com/gantasmo/theDAW-Pinokio. It clones and runs theDAW from github.com/gantasmo/theDAW.

The launcher exposes four actions in Pinokio: Install, Start, Update, and Reset.

## Install

Install prepares theDAW and its dependencies. It runs these steps in order:

- Clone theDAW into an `app/` folder next to the launcher. This step runs only when `app/` does not already exist.
- Pull the Magenta sidecar submodule with `git submodule update --init --recursive`.
- Install FFmpeg through conda.
- Resolve all Python dependencies with `uv sync --group dev`.
- Install the frontend packages with `npm install`.

Models are not downloaded during Install. theDAW downloads a model the first time a generation needs it.

## Start

Start launches theDAW as a daemon and opens the app. It runs a preflight and two servers:

- Start first runs `uv run --no-sync python -m backend.ports --free`, which stops theDAW's own stale listeners on 5173 and 8600. `theDAW.bat` and `theDAW.sh` do the same thing with a shell pipeline before they launch; this step is the portable equivalent. It only stops a process it can identify as theDAW's, running from this checkout, so a program of yours that happens to hold one of those ports is reported and left alone.
- The FastAPI backend starts with `uv run --no-sync python -m backend._supervisor`, which runs `backend.run` and relaunches it in place when the app asks for a restart or an update. Start waits until the backend reports that Uvicorn is running.
- The Vite frontend starts with `npm run dev`. Start captures the local URL the frontend prints and opens the app at that URL.

The backend serves on port 8600. The frontend serves on port 5173. If a port is held by something theDAW cannot stop, the backend now says which program and process holds it instead of printing a raw socket error, and Start ends there.

## Update

Update refreshes the launcher and the app to their latest versions. It pulls the launcher and app repositories, refreshes the Magenta sidecar submodule, and re-syncs the Python and npm dependencies.

## Reset

Reset clears the installed dependencies. It deletes `app/.venv` and `app/frontend/node_modules`. The next Install then rebuilds the Python and frontend dependencies from a clean state.

## Ports

- Backend (FastAPI): port 8600. Interactive API docs are at `http://localhost:8600/docs` while the backend runs.
- Frontend (Vite): port 5173.

## Hugging Face cache and gated repositories

The launcher sets `HF_HOME` to the standard user Hugging Face cache at `~/.cache/huggingface`. The launcher does not use an isolated per-app cache. An existing Hugging Face token and any checkpoints already downloaded on the machine are reused, so a shared install does not download the same weights twice.

The Stable Audio 3 and t5gemma repositories are gated. A first-ever download of those weights needs a Hugging Face token with access granted to those repositories. Provide the token through the in-app login. Once the token is stored in the standard cache, later downloads reuse it.

## First run

1. In Pinokio, open theDAW and click Install. Wait for the dependency sync to finish.
2. Click Start. The backend comes up first, then the web UI. The app opens when the frontend URL is ready.
3. If a generation needs gated Stable Audio 3 or t5gemma weights, sign in with a Hugging Face token through the in-app login so the first download can proceed.
