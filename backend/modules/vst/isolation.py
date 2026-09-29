"""Third-party VST3 plugins run in worker processes, never in the backend.

A VST3 plugin is native code, and some crash the process that loads them:
MT-PowerDrumKit 2.1.5.1 ends its process with 0xC0000005 while loading. The
backend used to load plugins itself for every pedalboard render, insert and
``/api/vst/load`` instance, so one such plugin took the server down and the
app lost its backend. Every one of those loads now happens in
``plugin_worker.py``, started from here:

- ``process_with_plugin`` and ``render_instrument`` run one stateless render
  each in a fresh worker (``--job``) with a timeout that grows with the audio.
- ``load_plugin`` starts a worker that holds one plugin for the persistent
  registry (``--serve``); every later call on that instance is a request to
  its worker.

A worker that crashes, ends without answering, or runs past its timeout
raises ``PluginProcessError``, which names the plugin; the routes answer it
with a 502 and the backend keeps serving. A failure the plugin reports in the
ordinary way (a missing file, an effect asked to play MIDI, a parameter it
does not have) comes back as the same exception type the in-process code
raised, so every route answers it exactly as before.
"""

from __future__ import annotations

import json
import logging
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, BinaryIO, NoReturn

import numpy as np

from backend.lib import paths
from backend.lib.launch_token import child_env
from backend.modules.vst import plugin_worker as worker

log = logging.getLogger(__name__)

#: A render is given this long to load its plugin and start, plus
#: ``JOB_SECONDS_PER_AUDIO_SECOND`` for every second of audio it produces.
JOB_TIMEOUT_BASE_SECONDS = 300.0
JOB_SECONDS_PER_AUDIO_SECOND = 2.0
#: How long a ``/api/vst/load`` worker has to load its plugin.
LOAD_TIMEOUT_SECONDS = 120.0
#: How long a loaded instance has to answer a parameter read, set or reset.
CALL_TIMEOUT_SECONDS = 30.0
#: After a worker is killed or its stdin is closed, how long to wait for it to
#: actually exit. Bounded, so a worker that will not die cannot stall a request.
EXIT_WAIT_SECONDS = 5.0

#: Workers are headless: no console window may flash on Windows.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_REPO_ROOT = Path(__file__).resolve().parents[3]

#: Windows exit codes a crash leaves behind, in words.
_WINDOWS_CRASHES = {
    0xC0000005: "an access violation",
    0xC000001D: "an illegal instruction",
    0xC0000094: "an integer division by zero",
    0xC00000FD: "a stack overflow",
    0xC0000374: "heap corruption",
    0xC0000409: "a stack buffer overrun",
    0x80000003: "a breakpoint",
}


class PluginProcessError(Exception):
    """The worker holding a plugin crashed, ended without answering, or ran
    past its timeout. ``str()`` is a sentence naming the plugin."""

    status_code = 502

    def __init__(self, plugin_name: str, message: str) -> None:
        super().__init__(message)
        self.plugin_name = plugin_name


class PluginCrashed(PluginProcessError):
    def __init__(self, plugin_name: str, doing: str, returncode: int | None) -> None:
        super().__init__(
            plugin_name,
            f"The VST3 plugin '{plugin_name}' crashed while {doing} "
            f"({describe_exit(returncode)}). It ran in a process of its own, so "
            "theDAW kept running.",
        )
        self.returncode = returncode


class PluginTimedOut(PluginProcessError):
    def __init__(self, plugin_name: str, doing: str, seconds: float) -> None:
        super().__init__(
            plugin_name,
            f"The VST3 plugin '{plugin_name}' did not finish {doing} within "
            f"{seconds:.0f}s and was stopped.",
        )


def describe_exit(returncode: int | None) -> str:
    """A worker's exit status in words: the Windows crash code in hex with its
    meaning, the POSIX signal, or the plain exit code."""
    if returncode is None:
        return "it did not exit"
    if returncode < 0:
        try:
            return f"signal {signal.Signals(-returncode).name}"
        except ValueError:
            return f"signal {-returncode}"
    unsigned = returncode & 0xFFFFFFFF
    if unsigned >= 0x80000000:
        code = f"exit code 0x{unsigned:08X}"
        meaning = _WINDOWS_CRASHES.get(unsigned)
        return f"{code}, {meaning}" if meaning else code
    if returncode == 0:
        return "it exited without answering"
    return f"exit code {returncode}"


def plugin_label(plugin_path: str) -> str:
    """The name a message uses for a plugin: its file name without ``.vst3``."""
    return Path(plugin_path).stem or plugin_path


def job_timeout(audio_seconds: float) -> float:
    return JOB_TIMEOUT_BASE_SECONDS + JOB_SECONDS_PER_AUDIO_SECOND * max(
        0.0, float(audio_seconds)
    )


def _work_root() -> Path:
    """Where jobs and instances stage their files. Read on every call, so the
    data root a test (or a relocated install) sets is the one used."""
    return paths.data_path("vst_render")


def _worker_command(*args: str) -> list[str]:
    return [sys.executable, "-m", "backend.modules.vst.plugin_worker", *args]


def _error_from_worker(answer: dict) -> Exception:
    """The exception a worker reported, as the type the routes already map."""
    kind = answer.get("error")
    message = str(answer.get("message") or "the plugin reported an error")
    if kind == "FileNotFoundError":
        return FileNotFoundError(message)
    if kind == "KeyError":
        return KeyError(message)
    if kind == "ValueError":
        return ValueError(message)
    return RuntimeError(message)


def _could_not_start(name: str, error: OSError) -> PluginProcessError:
    return PluginProcessError(
        name, f"The process for the VST3 plugin '{name}' could not start: {error}"
    )


def _log_tail(text: str, limit: int = 1200) -> str:
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    return " | ".join(lines[-12:])[-limit:]


# ---------------------------------------------------------------------------
# Stateless renders: one worker per call
# ---------------------------------------------------------------------------


def _run_job_process(job_dir: Path, timeout: float) -> tuple[int | None, str]:
    """Run the job staged in ``job_dir`` in a fresh worker.

    Returns the worker's exit code (None when it was stopped at ``timeout``)
    and what it wrote to stderr. Raises OSError when it cannot be started.
    """
    proc = subprocess.Popen(
        _worker_command("--job", str(job_dir)),
        cwd=str(_REPO_ROOT),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=_NO_WINDOW,
        env=child_env(),
    )
    try:
        _, stderr = proc.communicate(timeout=timeout)
        return proc.returncode, stderr or ""
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.communicate(timeout=EXIT_WAIT_SECONDS)
        except subprocess.TimeoutExpired:
            pass
        return None, ""


def _read_result(job_dir: Path) -> dict | None:
    try:
        result = json.loads((job_dir / worker.RESULT_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return result if isinstance(result, dict) else None


def _stage_state(job_dir: Path, raw_state: str | bytes | None) -> None:
    if not raw_state:
        return
    if isinstance(raw_state, str):
        (job_dir / worker.STATE_TEXT_FILE).write_text(raw_state, encoding="utf-8")
    else:
        (job_dir / worker.STATE_BYTES_FILE).write_bytes(bytes(raw_state))


def _run_job(
    plugin_path: str,
    job: dict,
    stage: dict[str, Any],
    raw_state: str | bytes | None,
    warnings: list[str] | None,
    audio_seconds: float,
    doing: str,
) -> np.ndarray:
    """Stage ``job``, run it in a worker, and return the audio it wrote.

    ``stage`` maps file names in the job directory to what goes in them: an
    ndarray is saved with ``np.save``, anything else as JSON.
    """
    name = plugin_label(plugin_path)
    root = _work_root()
    root.mkdir(parents=True, exist_ok=True)
    job_dir = Path(tempfile.mkdtemp(prefix="plugin-", dir=str(root)))
    try:
        (job_dir / worker.JOB_FILE).write_text(
            json.dumps({**job, "plugin_path": plugin_path}), encoding="utf-8"
        )
        for filename, content in stage.items():
            if isinstance(content, np.ndarray):
                np.save(job_dir / filename, np.ascontiguousarray(content))
            else:
                (job_dir / filename).write_text(json.dumps(content), encoding="utf-8")
        _stage_state(job_dir, raw_state)
        timeout = job_timeout(audio_seconds)
        try:
            returncode, stderr = _run_job_process(job_dir, timeout)
        except OSError as e:
            raise _could_not_start(name, e) from e
        result = _read_result(job_dir)
        if result is None:
            if returncode is None:
                log.warning("VST3 plugin %s timed out after %.0fs", name, timeout)
                raise PluginTimedOut(name, doing, timeout)
            log.warning(
                "VST3 plugin %s crashed its worker (%s). %s",
                name,
                describe_exit(returncode),
                _log_tail(stderr),
            )
            raise PluginCrashed(name, doing, returncode)
        if warnings is not None:
            warnings.extend(str(w) for w in result.get("warnings") or [])
        if not result.get("ok"):
            raise _error_from_worker(result)
        return np.load(job_dir / worker.OUTPUT_AUDIO_FILE)
    finally:
        shutil.rmtree(job_dir, ignore_errors=True)


def process_with_plugin(
    plugin_path: str,
    audio: np.ndarray,
    sample_rate: int,
    params: dict[str, float] | None = None,
    raw_state: str | bytes | None = None,
    warnings: list[str] | None = None,
) -> np.ndarray:
    """``host.process_with_plugin`` in a worker: audio through one effect,
    loaded fresh with its captured state and parameters, then discarded."""
    frames = int(np.shape(audio)[0]) if np.ndim(audio) else 0
    return _run_job(
        plugin_path,
        {"kind": "process", "sample_rate": int(sample_rate), "params": params},
        {worker.INPUT_AUDIO_FILE: np.asarray(audio)},
        raw_state,
        warnings,
        frames / max(1, int(sample_rate)),
        "processing audio",
    )


def render_instrument(
    plugin_path: str,
    midi_messages: list[tuple[bytes, float]],
    duration: float,
    sample_rate: int,
    params: dict[str, float] | None = None,
    raw_state: str | bytes | None = None,
    warnings: list[str] | None = None,
    num_channels: int = 2,
) -> np.ndarray:
    """``host.render_instrument`` in a worker: MIDI through one instrument,
    loaded fresh with its captured state and parameters; (frames, channels)."""
    return _run_job(
        plugin_path,
        {
            "kind": "render",
            "sample_rate": int(sample_rate),
            "duration": float(duration),
            "num_channels": int(num_channels),
            "params": params,
        },
        {worker.MIDI_FILE: [[list(data), float(t)] for data, t in midi_messages]},
        raw_state,
        warnings,
        float(duration),
        "rendering",
    )


# ---------------------------------------------------------------------------
# The /api/vst/load registry: one long-lived worker per instance
# ---------------------------------------------------------------------------


def _read_replies(stream: BinaryIO, replies: queue.Queue) -> None:
    """Move a ``--serve`` worker's protocol lines onto ``replies``; None marks
    the end of its stdout, which means the worker is gone."""
    try:
        for raw in iter(stream.readline, b""):
            text = raw.decode("utf-8", "replace").rstrip("\r\n")
            if not text.startswith(worker.PROTOCOL_TAG):
                continue
            try:
                message = json.loads(text[len(worker.PROTOCOL_TAG) :])
            except ValueError:
                continue
            if isinstance(message, dict):
                replies.put(message)
    except (OSError, ValueError):
        pass
    finally:
        try:
            stream.close()
        except (OSError, ValueError):
            pass
        replies.put(None)


class IsolatedInstance:
    """A plugin loaded in a worker of its own, for ``/api/vst/load``.

    Offers what the routes use of an in-process instance: ``parameters``,
    ``set_parameter``, ``process`` and ``reset``. A worker that crashes or
    stops answering raises ``PluginProcessError`` and leaves the registry.
    """

    def __init__(
        self,
        instance_id: str,
        plugin_path: str,
        proc: subprocess.Popen,
        work_dir: Path,
    ) -> None:
        self.instance_id = instance_id
        self.plugin_path = plugin_path
        self.plugin_name = plugin_label(plugin_path)
        self._proc = proc
        self._work_dir = work_dir
        self._replies: queue.Queue = queue.Queue()
        self._lock = threading.Lock()
        self._next_id = 0
        self._closed = False
        threading.Thread(
            target=_read_replies,
            args=(proc.stdout, self._replies),
            name=f"vst-worker-{instance_id[:8]}",
            daemon=True,
        ).start()

    # -- the calls the routes make -------------------------------------------

    @property
    def parameters(self) -> dict[str, dict]:
        answer = self._call("parameters", CALL_TIMEOUT_SECONDS, "reading parameters")
        params = answer.get("parameters")
        return params if isinstance(params, dict) else {}

    def set_parameter(self, name: str, value: float) -> None:
        self._call(
            "set",
            CALL_TIMEOUT_SECONDS,
            "setting a parameter",
            name=name,
            value=float(value),
        )

    def process(self, audio: np.ndarray, sample_rate: int) -> np.ndarray:
        self._refuse_if_closed()
        seq = uuid.uuid4().hex
        src = self._work_dir / f"in-{seq}.npy"
        dst = self._work_dir / f"out-{seq}.npy"
        try:
            np.save(src, np.ascontiguousarray(audio))
            frames = int(np.shape(audio)[0]) if np.ndim(audio) else 0
            self._call(
                "process",
                job_timeout(frames / max(1, int(sample_rate))),
                "processing audio",
                input=str(src),
                output=str(dst),
                sample_rate=int(sample_rate),
            )
            return np.load(dst)
        finally:
            for path in (src, dst):
                path.unlink(missing_ok=True)

    def reset(self) -> None:
        self._call("reset", CALL_TIMEOUT_SECONDS, "resetting")

    @property
    def pid(self) -> int:
        return self._proc.pid

    def close(self) -> None:
        """Stop the worker: closing its stdin ends it, a kill follows if not."""
        with self._lock:
            self._shut_down(kill=False)

    # -- the wire ---------------------------------------------------------------

    def _await(self, rid: int, timeout: float, doing: str) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self._fail_timeout(doing, timeout)
            try:
                message = self._replies.get(timeout=remaining)
            except queue.Empty:
                self._fail_timeout(doing, timeout)
            if message is None:
                self._fail_crashed(doing)
            if message.get("id") == rid:
                return message

    def _refuse_if_closed(self) -> None:
        if self._closed:
            raise PluginProcessError(
                self.plugin_name,
                f"The VST3 plugin '{self.plugin_name}' is no longer loaded.",
            )

    def _call(self, op: str, timeout: float, doing: str, **fields: Any) -> dict:
        with self._lock:
            self._refuse_if_closed()
            self._next_id += 1
            rid = self._next_id
            line = json.dumps({"id": rid, "op": op, **fields}, ensure_ascii=True)
            try:
                self._proc.stdin.write(line.encode("ascii") + b"\n")
                self._proc.stdin.flush()
            except (OSError, ValueError):
                self._fail_crashed(doing)
            answer = self._await(rid, timeout, doing)
        if not answer.get("ok"):
            raise _error_from_worker(answer)
        return answer

    def _fail_crashed(self, doing: str) -> NoReturn:
        try:
            returncode = self._proc.wait(timeout=EXIT_WAIT_SECONDS)
        except subprocess.TimeoutExpired:
            returncode = None
        tail = self._log_tail()
        self._shut_down(kill=True)
        log.warning(
            "VST3 plugin %s crashed its worker (%s). %s",
            self.plugin_name,
            describe_exit(returncode),
            tail,
        )
        raise PluginCrashed(self.plugin_name, doing, returncode)

    def _fail_timeout(self, doing: str, seconds: float) -> NoReturn:
        self._shut_down(kill=True)
        log.warning("VST3 plugin %s timed out after %.0fs", self.plugin_name, seconds)
        raise PluginTimedOut(self.plugin_name, doing, seconds)

    def _log_tail(self) -> str:
        try:
            text = (self._work_dir / "worker.log").read_text(
                encoding="utf-8", errors="replace"
            )
        except OSError:
            return ""
        return _log_tail(text)

    def _shut_down(self, kill: bool) -> None:
        """End the worker, drop its files, and take it out of the registry.
        The caller holds ``self._lock``."""
        if self._closed:
            return
        self._closed = True
        proc = self._proc
        try:
            proc.stdin.close()
        except (OSError, ValueError):
            pass
        if not kill:
            try:
                proc.wait(timeout=EXIT_WAIT_SECONDS)
            except subprocess.TimeoutExpired:
                kill = True
        if kill and proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass
            try:
                proc.wait(timeout=EXIT_WAIT_SECONDS)
            except subprocess.TimeoutExpired:
                pass
        # stdout is left to the reader thread, which closes it at the end of
        # the stream: closing it here would wait on that thread's read.
        shutil.rmtree(self._work_dir, ignore_errors=True)
        _forget(self)


_instances: dict[str, IsolatedInstance] = {}
_registry_lock = threading.Lock()


def _forget(instance: IsolatedInstance) -> None:
    with _registry_lock:
        if _instances.get(instance.instance_id) is instance:
            del _instances[instance.instance_id]


def _start_instance(instance_id: str, plugin_path: str) -> IsolatedInstance:
    name = plugin_label(plugin_path)
    root = _work_root()
    root.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="instance-", dir=str(root)))
    try:
        # The worker's stderr, and anything its plugin prints, goes to a file:
        # nothing has to drain it, and a crash can still be read afterwards.
        with open(work / "worker.log", "wb") as log_fh:
            proc = subprocess.Popen(
                _worker_command("--serve", plugin_path),
                cwd=str(_REPO_ROOT),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=log_fh,
                creationflags=_NO_WINDOW,
                env=child_env(),
            )
    except OSError as e:
        shutil.rmtree(work, ignore_errors=True)
        raise _could_not_start(name, e) from e
    instance = IsolatedInstance(instance_id, plugin_path, proc, work)
    with instance._lock:
        ready = instance._await(0, LOAD_TIMEOUT_SECONDS, "loading")
        if not ready.get("ok"):
            instance._shut_down(kill=False)
            raise _error_from_worker(ready)
    return instance


def load_plugin(plugin_path: str, instance_id: str | None = None) -> IsolatedInstance:
    """Load a plugin in a worker of its own and register it.

    Raises FileNotFoundError for a missing file, the plugin's own load error
    as RuntimeError, and ``PluginProcessError`` when loading it crashed or hung
    its worker. A reused ``instance_id`` replaces (and stops) the worker that
    held it.
    """
    path = Path(plugin_path)
    if not path.exists():
        raise FileNotFoundError(f"VST3 plugin not found: {plugin_path}")
    iid = instance_id or str(uuid.uuid4())
    instance = _start_instance(iid, str(path))
    with _registry_lock:
        previous = _instances.get(iid)
        _instances[iid] = instance
    if previous is not None:
        previous.close()
    log.info("Loaded VST3 '%s' as instance %s in its own process", path.stem, iid)
    return instance


def unload_plugin(instance_id: str) -> None:
    """Stop an instance's worker and remove it from the registry."""
    with _registry_lock:
        instance = _instances.pop(instance_id, None)
    if instance is None:
        raise KeyError(f"No VST instance with id: {instance_id}")
    instance.close()
    log.info("Unloaded VST3 instance %s", instance_id)


def get_instance(instance_id: str) -> IsolatedInstance:
    with _registry_lock:
        instance = _instances.get(instance_id)
    if instance is None:
        raise KeyError(f"No VST instance with id: {instance_id}")
    return instance


def list_instances() -> list[dict]:
    """Every loaded instance as a serializable dict; one whose worker has
    died is dropped rather than listed."""
    with _registry_lock:
        instances = list(_instances.values())
    out: list[dict] = []
    for instance in instances:
        try:
            parameters = instance.parameters
        except PluginProcessError:
            continue
        out.append(
            {
                "instance_id": instance.instance_id,
                "plugin_name": instance.plugin_name,
                "plugin_path": instance.plugin_path,
                "parameters": parameters,
            }
        )
    return out


def process_chain(
    instance_ids: list[str], audio: np.ndarray, sample_rate: int
) -> np.ndarray:
    """Audio through an ordered chain of loaded instances, each in its worker.

    Every id is looked up before any audio moves, so an unknown one is a
    KeyError without half the chain having run.
    """
    chain = [get_instance(iid) for iid in instance_ids]
    result = audio
    for instance in chain:
        result = instance.process(result, sample_rate)
    return result


def stop_all() -> None:
    """Stop every instance worker. Each also ends on its own when the backend
    exits, since its stdin closes."""
    with _registry_lock:
        instances = list(_instances.values())
        _instances.clear()
    for instance in instances:
        instance.close()
