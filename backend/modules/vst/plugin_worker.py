"""The process that loads third-party VST3 plugins through pedalboard.

A VST3 plugin is native code, and some of them crash whatever process loads
them: MT-PowerDrumKit 2.1.5.1 ends its process with 0xC0000005 while loading.
So the backend never loads one itself. Every pedalboard load of a third-party
plugin for a render, an insert or a ``/api/vst/load`` instance runs here, in a
child the backend starts through ``isolation.py``, and a crash ends only this
process.

Two modes:

``python -m backend.modules.vst.plugin_worker --job DIR``
    One stateless render. ``DIR/job.json`` names the plugin and what to do
    with it (``process``: audio through an effect, ``render``: MIDI through an
    instrument); the audio, MIDI and captured state sit beside it. The answer
    is ``DIR/result.json`` (plus ``DIR/out.npy`` on success). A process that
    ends without writing ``result.json`` crashed, whatever its exit code.

``python -m backend.modules.vst.plugin_worker --serve PLUGIN_PATH``
    One loaded plugin for the ``/api/vst/load`` registry. Requests arrive on
    stdin, one JSON object per line; every answer is one stdout line starting
    with ``PROTOCOL_TAG``. The first answer (id 0) says whether the load
    worked. The process exits when stdin closes, which is also what happens
    when the backend itself goes away.

Both modes leave with ``os._exit``: a plugin's own teardown can hang or crash
too, and once the answer is written nothing in it matters.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, TextIO

import numpy as np

from backend.modules.vst.param_automation import parse_param_automation

#: Starts every protocol line a ``--serve`` worker writes. Anything else on
#: stdout is ignored by the backend, so a plugin that prints cannot be read as
#: an answer.
PROTOCOL_TAG = "@thedaw-plugin-worker "

JOB_FILE = "job.json"
RESULT_FILE = "result.json"
INPUT_AUDIO_FILE = "in.npy"
OUTPUT_AUDIO_FILE = "out.npy"
MIDI_FILE = "midi.json"
#: The captured editor state as the backend was handed it: base64 text, or the
#: raw bytes. ``host`` accepts both and decodes the text itself.
STATE_TEXT_FILE = "state.b64"
STATE_BYTES_FILE = "state.bin"


def quiet_crash_dialogs() -> None:
    """Keep Windows from holding a crashed worker open behind an error dialog.

    Without this, a plugin's access violation can raise the "has stopped
    working" box, and the process stays alive until someone dismisses it on
    the desktop, where the backend's timeout is the only thing that ends it.
    """
    if sys.platform != "win32":
        return
    import ctypes

    sem_failcriticalerrors = 0x0001
    sem_nogpfaulterrorbox = 0x0002
    sem_noopenfileerrorbox = 0x8000
    ctypes.windll.kernel32.SetErrorMode(
        sem_failcriticalerrors | sem_nogpfaulterrorbox | sem_noopenfileerrorbox
    )


def describe_error(error: BaseException) -> dict[str, str]:
    """An exception as ``{"error": kind, "message": text}`` for the backend.

    The kind is one the backend's routes already tell apart (a missing file is
    a 404, a refused value a 400); every other failure travels as its message.
    """
    if isinstance(error, FileNotFoundError):
        kind = "FileNotFoundError"
    elif isinstance(error, KeyError):
        kind = "KeyError"
    elif isinstance(error, ValueError):
        kind = "ValueError"
    else:
        kind = "Exception"
    if isinstance(error, KeyError) and error.args:
        message = str(error.args[0])
    else:
        message = str(error)
    return {"error": kind, "message": message}


def _write_result(job_dir: Path, result: dict[str, Any]) -> None:
    """Write ``result.json`` whole or not at all, so a half-written answer
    never passes for one."""
    partial = job_dir / (RESULT_FILE + ".part")
    partial.write_text(json.dumps(result, ensure_ascii=True), encoding="utf-8")
    os.replace(partial, job_dir / RESULT_FILE)


def _read_state(job_dir: Path) -> str | bytes | None:
    text = job_dir / STATE_TEXT_FILE
    if text.is_file():
        return text.read_text(encoding="utf-8")
    blob = job_dir / STATE_BYTES_FILE
    if blob.is_file():
        return blob.read_bytes()
    return None


def run_job(job_dir: Path) -> int:
    """Run the one render ``job_dir`` describes. Returns the exit code.

    Always writes ``result.json`` unless the plugin takes the process down,
    which is how the backend tells a crash from a failure.
    """
    from backend.modules.vst import host

    warnings: list[str] = []
    try:
        job = json.loads((job_dir / JOB_FILE).read_text(encoding="utf-8"))
        kind = job.get("kind")
        raw_state = _read_state(job_dir)
        if kind == "process":
            audio = np.load(job_dir / INPUT_AUDIO_FILE)
            automation = job.get("automation")
            out = host.process_with_plugin(
                job["plugin_path"],
                audio,
                int(job["sample_rate"]),
                job.get("params"),
                raw_state,
                warnings,
                raw_params=job.get("raw_params"),
                automation=(
                    parse_param_automation(json.dumps(automation)) or None
                    if automation
                    else None
                ),
            )
        elif kind == "render":
            events = json.loads((job_dir / MIDI_FILE).read_text(encoding="utf-8"))
            messages = [(bytes(data), float(t)) for data, t in events]
            out = host.render_instrument(
                job["plugin_path"],
                messages,
                float(job["duration"]),
                int(job["sample_rate"]),
                job.get("params"),
                raw_state,
                warnings,
                int(job["num_channels"]),
            )
        else:
            raise ValueError(f"unknown plugin job kind {kind!r}")
        np.save(job_dir / OUTPUT_AUDIO_FILE, np.asarray(out))
    except Exception as e:
        _write_result(job_dir, {"ok": False, "warnings": warnings, **describe_error(e)})
        return 1
    _write_result(job_dir, {"ok": True, "warnings": warnings})
    return 0


def _claim_stdout() -> TextIO:
    """The protocol stream, with fd 1 pointed at stderr for everything else.

    A plugin that prints (from Python or from its own native code) then lands
    in the worker's log. ``PROTOCOL_TAG`` covers any output that still reaches
    the original stdout some other way.
    """
    proto_fd = os.dup(1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return os.fdopen(proto_fd, "w", encoding="ascii", newline="\n")


def _serve_op(instance: Any, request: dict) -> dict:
    from backend.modules.vst import host

    op = request.get("op")
    if op == "parameters":
        return {"parameters": instance.parameters}
    if op == "set":
        instance.set_parameter(str(request["name"]), float(request["value"]))
        return {}
    if op == "process":
        audio = np.load(request["input"])
        out = host.process_chain(
            [instance.instance_id], audio, int(request["sample_rate"])
        )
        np.save(request["output"], np.asarray(out))
        return {}
    if op == "reset":
        host.on_host_thread(instance.reset)()
        return {}
    raise ValueError(f"unknown plugin worker op {op!r}")


def serve(plugin_path: str) -> int:
    """Hold one plugin and answer requests for it until stdin closes."""
    from backend.modules.vst import host

    proto = _claim_stdout()

    def reply(message: dict) -> None:
        proto.write(PROTOCOL_TAG + json.dumps(message, ensure_ascii=True) + "\n")
        proto.flush()

    try:
        instance = host.load_plugin(plugin_path)
    except Exception as e:
        reply({"id": 0, "ok": False, **describe_error(e)})
        return 1
    reply({"id": 0, "ok": True})
    for raw in iter(sys.stdin.buffer.readline, b""):
        try:
            request = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(request, dict):
            continue
        rid = request.get("id")
        try:
            answer = _serve_op(instance, request)
        except Exception as e:
            reply({"id": rid, "ok": False, **describe_error(e)})
            continue
        reply({"id": rid, "ok": True, **answer})
    return 0


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) == 2 and args[0] == "--job":
        quiet_crash_dialogs()
        return run_job(Path(args[1]))
    if len(args) == 2 and args[0] == "--serve":
        quiet_crash_dialogs()
        return serve(args[1])
    print(
        "usage: python -m backend.modules.vst.plugin_worker "
        "(--job DIR | --serve PLUGIN_PATH)",
        file=sys.stderr,
        flush=True,
    )
    return 2


if __name__ == "__main__":
    code = main()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:
            pass
    os._exit(code)
