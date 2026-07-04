# theDAW Desktop App

theDAW ships as a packaged desktop application built with Electron. The desktop
build wraps the same Python backend and web front end that run in the browser,
supervises the backend as a child process, and adds operating-system integration
such as file associations and native file dialogs. This guide covers what the
installer places on disk, how the first launch prepares the Python environment,
how project and plugin files open from the desktop, and how the desktop shell
relates to the web app.

## What the installer bundles

The installer is a per-user NSIS package on Windows and a dmg on Apple Silicon
macOS. It installs without administrator rights. On Windows the app lands under
the per-user programs directory, which is writable, so the runtime can create
its Python environment and write its data tree without elevation.

The download stays small because it carries a bootstrap payload rather than a
prebuilt Python environment or model weights. The package contains:

- The Electron shell: the built renderer, main, and preload bundles.
- The Python source tree (the `backend` and `stable_audio_3` packages) staged
  under `resources/python`, together with `pyproject.toml`, `uv.lock`, and the
  pinned Python version.
- A bundled `uv` binary plus `ffmpeg` and `ffprobe` under `resources/tools`.
- The static VJ build under `resources/python/vj-dist`, served by the backend at
  `/vj-app`, so the VJ tab works without Node.js on the target machine.
- The VST Foundry production bundle, which ships its own Node runtime.
- User documentation (Markdown docs and the user guide).

Machine-local artifacts are excluded from the package on purpose: per-module
Python virtual environments, the uv package cache, and generated model weights
never ship. Each target machine rebuilds these for itself.

The installer creates desktop and Start Menu shortcuts. The uninstaller leaves
user data in place unless removal is requested, because the first run downloads
several gigabytes that a reinstall would otherwise repeat.

## First launch and the Python bootstrap

The desktop shell paints its window and starts the boot cinematic immediately.
In the background the main process checks whether a working Python environment
already exists.

On a packaged build the main process looks for the virtual environment next to
the bundled `pyproject.toml` under `resources/python`. It confirms the
environment is usable by importing the core web-server packages. When the
environment is missing, or the import check fails (for example a setup that was
interrupted after the environment directory was created but before packages
finished installing), the shell runs the bundled `uv` to build it. This step
uses `uv sync --group dev` from the Python directory. The bundled `uv` pulls a
managed CPython, resolves every dependency from the lockfile, and installs the
platform-correct wheels, so the machine needs nothing pre-installed.

The first setup downloads several gigabytes and can take several minutes.
Progress streams into the boot cinematic as log lines, and a status line reports
the current step. When setup finishes, the shell starts the backend supervisor.
On later launches the environment check passes and the shell skips setup, so the
backend starts without the download.

To keep setup fast, the shell points uv's package cache at the same disk volume
as the virtual environment. Wheels then hard-link into the environment instead
of being copied. An explicit cache directory set by the environment (for example
from a development launch) is respected.

The bundled `ffmpeg` and `ffprobe` are added to the front of the backend
process PATH, so audio import and export resolve ffmpeg from the package rather
than from a system install.

## Model download on first generation

The installer does not carry model weights. The generation model is fetched the
first time audio is generated. The backend resolves the model from its
configuration, downloads the checkpoint, and caches it locally. That first
generation takes longer while the download runs. Later generations reuse the
cached weights and start without the wait.

## Project and plugin file associations

The desktop build registers theDAW as the handler for two file types:

- `.tasmo`: a theDAW project. Double-clicking opens the project in the app.
- `.gan`: a GANTASMO web plugin. Double-clicking opens the plugin through the
  MIX plugin loader.

On Windows and Linux the launched app reads the file path from its command-line
arguments. On macOS the operating system delivers the path through a file-open
event. In both cases the main process forwards the path to the renderer, which
routes a `.tasmo` path to project loading and a `.gan` path to the plugin
loader. If a file is opened before the window has finished loading, the path is
held and delivered once the renderer is ready.

theDAW runs as a single instance. Double-clicking an associated file while the
app is already open forwards the path to the existing window and brings that
window to the front instead of starting a second copy.

On Windows the installer also registers an Explorer right-click entry,
"Convert with theDAW", backed by a helper script that uses the bundled ffmpeg.

## Links that open in the system browser

The renderer only loads local content, but some links point to outside pages,
such as release notes or a Hugging Face sign-in. The main process inspects the
target of any http or https navigation and compares its origin to the app's own
origin. A link to a different origin opens in the default system browser, where
an existing sign-in session is available. This applies both to links that would
open a new window and to attempts to navigate the main window away from the app.
Navigations that stay on the app's own origin remain inside the window.

## Desktop shell and the web app

The desktop shell and the browser version run the same backend and the same
front end. The backend listens on port 8600 and the web front end on port 5173,
the same ports used when the two servers are launched directly.

In a packaged build the renderer is served through an internal app protocol.
Requests under `/api/` are proxied to the backend on port 8600, and other paths
serve the built renderer files. The renderer runs the same boot cinematic as the
browser version and polls the backend health endpoint on its own, holding until
the backend reports ready. Because the boot flow is shared, the desktop and web
startup behave the same way.

Before starting the backend, the shell checks whether one is already listening
on port 8600. If a backend is already running (for example one started from a
development launch), the shell uses it and does not spawn another. When the shell
starts the backend itself, it also shuts that backend down on quit: it first
requests a graceful shutdown over HTTP, then force-terminates the process tree if
the backend does not exit within the grace period. A backend the shell did not
start is left running.

The desktop shell adds native integration that the browser cannot provide:
native open, save, and folder-picker dialogs; microphone and camera access for
vocal recording and the VJ tab; a "Shutdown" action in Settings that quits the
app; and a native window handle used to embed a VST3 editor window inside the
MIX area.
