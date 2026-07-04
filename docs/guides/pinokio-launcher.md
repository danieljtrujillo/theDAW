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

Start launches theDAW as a daemon and opens the app. It runs two servers:

- The FastAPI backend starts with `uv run uvicorn backend.server:app --port 8600`. Start waits until the backend reports that Uvicorn is running.
- The Vite frontend starts with `npm run dev`. Start captures the local URL the frontend prints and opens the app at that URL.

The backend serves on port 8600. The frontend serves on port 5173. If Start fails right away, close any other process already holding 5173 or 8600, such as a copy launched through `theDAW.bat`.

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
