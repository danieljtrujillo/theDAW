"""VST3 plugin host — manages loaded plugin instances via pedalboard.

In-process hosting: pedalboard runs inside the same Python process.
Each loaded plugin gets a unique instance_id (UUID).

Every call that touches a plugin is funnelled onto one dedicated thread. VST3
plugins are not thread-safe and pedalboard enforces it: a plugin loaded on one
thread and then reloaded on another raises "must be reloaded on the main
thread". FastAPI runs sync endpoints on a threadpool, handing consecutive
requests to different workers, so without this funnel a plugin loads once and
every later request fails.
"""

from __future__ import annotations
import functools
import logging
import re
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, TypeVar

import numpy as np

log = logging.getLogger(__name__)

_HOST_THREAD_PREFIX = "vst-host"
_host_executor = ThreadPoolExecutor(
    max_workers=1, thread_name_prefix=_HOST_THREAD_PREFIX
)

_T = TypeVar("_T")


def on_host_thread(fn: Callable[..., _T]) -> Callable[..., _T]:
    """Run ``fn`` on the single thread that owns every plugin instance.

    Calls already on that thread run inline; dispatching would deadlock, since
    the only worker would be waiting on itself.
    """

    @functools.wraps(fn)
    def wrapper(*args, **kwargs) -> _T:
        if threading.current_thread().name.startswith(_HOST_THREAD_PREFIX):
            return fn(*args, **kwargs)
        return _host_executor.submit(fn, *args, **kwargs).result()

    return wrapper


# Lazy import — pedalboard is heavy and may not be installed in dev
_pedalboard: Any = None


def _get_pedalboard():
    global _pedalboard
    if _pedalboard is None:
        import pedalboard

        _pedalboard = pedalboard
    return _pedalboard


def param_key(name: str) -> str:
    """Normalize a parameter name to pedalboard's python_name convention."""
    return re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")


def describe_parameter(param: Any, current: Any) -> dict:
    """JSON-safe descriptor for one pedalboard AudioProcessorParameter.

    The parameter objects themselves hold a back-reference to the plugin, so
    handing them to FastAPI's encoder walks straight into an object cycle. Only
    primitives leave this function. ``valid_values`` is deliberately omitted: a
    continuous parameter reports it as a list of ~1000 floats.
    """
    raw = getattr(param, "raw_value", None)
    return {
        "name": getattr(param, "name", "") or "",
        "python_name": getattr(param, "python_name", "") or "",
        "raw_value": float(raw) if isinstance(raw, (int, float)) else None,
        "value": current if isinstance(current, (int, float, bool, str)) else None,
        "label": "" if current is None else str(current),
        "min": _as_number(getattr(param, "min_value", None)),
        "max": _as_number(getattr(param, "max_value", None)),
        "step": _as_number(
            getattr(param, "step_size", None)
            or getattr(param, "approximate_step_size", None)
        ),
        "units": getattr(param, "units", None) or "",
    }


def _as_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    return None


class VstInstance:
    """A loaded VST3 plugin instance."""

    def __init__(
        self, instance_id: str, plugin_path: str, plugin_name: str, plugin: Any
    ):
        self.instance_id = instance_id
        self.plugin_path = plugin_path
        self.plugin_name = plugin_name
        self._plugin = plugin

    @property
    def parameters(self) -> dict[str, dict]:
        """JSON-safe descriptors keyed by pedalboard's python_name."""
        return describe_parameters(self._plugin)

    def set_parameter(self, name: str, value: float) -> None:
        set_plugin_parameter(self._plugin, name, value)

    def process(self, audio: np.ndarray, sample_rate: int) -> np.ndarray:
        return self._plugin(audio, sample_rate)

    def reset(self) -> None:
        self._plugin.reset()


@on_host_thread
def describe_parameters(plugin: Any) -> dict[str, dict]:
    """Every parameter of a plugin as JSON-safe descriptors."""
    out: dict[str, dict] = {}
    for key, param in plugin.parameters.items():
        try:
            current = getattr(plugin, key, None)
        except Exception:
            current = None
        try:
            out[key] = describe_parameter(param, current)
        except Exception as e:
            log.debug("Could not describe VST parameter '%s': %s", key, e)
    return out


@on_host_thread
def set_plugin_parameter(plugin: Any, name: str, value: float) -> None:
    """Set one parameter on a pedalboard plugin.

    ``plugin.parameters[name] = value`` looks like the obvious way and is not:
    that mapping is a read-only wrapper whose __setitem__ raises. The supported
    route is the attribute named by the parameter's ``python_name``, which takes
    the value in the parameter's own units; a value that only makes sense as the
    normalized 0..1 position falls back to ``raw_value``. Raises KeyError for an
    unknown name and ValueError for a value the plugin rejects.
    """
    params = plugin.parameters
    key = name if name in params else param_key(name)
    if key not in params:
        raise KeyError(f"Unknown parameter: {name}")
    param = params[key]
    try:
        setattr(plugin, key, value)
        return
    except Exception as attr_error:
        if not 0.0 <= float(value) <= 1.0:
            raise ValueError(str(attr_error)) from attr_error
    try:
        param.raw_value = float(value)
    except Exception as raw_error:
        raise ValueError(str(raw_error)) from raw_error


def _raw_state_bytes(plugin: Any) -> bytes | None:
    try:
        return bytes(plugin.raw_state)
    except Exception:
        return None


def _apply_raw_state(plugin: Any, raw_state: str | bytes) -> str:
    """Restore a captured editor state. Returns "" on success, else the reason.

    Assigning ``raw_state`` does not raise when the blob belongs to a different
    plugin or is corrupt, the plugin simply keeps what it had, and the render
    comes out at defaults sounding like a success. The only way to know is to
    read the state back and see whether anything moved.
    """
    import base64

    try:
        blob = base64.b64decode(raw_state) if isinstance(raw_state, str) else raw_state
    except Exception as e:
        return f"state is not valid base64 ({e})"
    before = _raw_state_bytes(plugin)
    try:
        plugin.raw_state = blob
    except Exception as e:
        return str(e)
    if before is None or blob == before:
        return ""
    after = _raw_state_bytes(plugin)
    if after is not None and after == before:
        return "the plugin ignored it (captured from a different plugin or version)"
    return ""


# Global registry of loaded instances
_instances: dict[str, VstInstance] = {}


def load_plugin_file(pb: Any, path: str) -> Any:
    """Load a VST3 by path, resilient to multi-shell files.

    Some VST3 files bundle several plugins; ``load_plugin`` then raises and asks
    for an explicit name. We retry with the first contained plugin so those load
    instead of failing outright. Genuinely unsupported files still raise their
    original error.
    """
    try:
        return pb.load_plugin(path)
    except Exception:
        try:
            names = pb.VST3Plugin.get_plugin_names_for_file(path)
        except Exception:
            names = None
        if names:
            log.info(
                "Multi-shell VST3 — loading first sub-plugin '%s' from %s",
                names[0],
                path,
            )
            return pb.load_plugin(path, plugin_name=names[0])
        raise


@on_host_thread
def load_plugin(plugin_path: str, instance_id: str | None = None) -> VstInstance:
    """Load a VST3 plugin and register it. Returns a VstInstance."""
    pb = _get_pedalboard()
    path = Path(plugin_path)
    if not path.exists():
        raise FileNotFoundError(f"VST3 plugin not found: {plugin_path}")

    plugin = load_plugin_file(pb, str(path))
    iid = instance_id or str(uuid.uuid4())
    inst = VstInstance(
        instance_id=iid, plugin_path=str(path), plugin_name=path.stem, plugin=plugin
    )
    _instances[iid] = inst
    log.info("Loaded VST3 '%s' as instance %s", inst.plugin_name, iid)
    return inst


@on_host_thread
def unload_plugin(instance_id: str) -> None:
    """Unload and remove a plugin instance."""
    inst = _instances.pop(instance_id, None)
    if inst is None:
        raise KeyError(f"No VST instance with id: {instance_id}")
    inst.reset()
    log.info("Unloaded VST3 instance %s", instance_id)


def get_instance(instance_id: str) -> VstInstance:
    if instance_id not in _instances:
        raise KeyError(f"No VST instance with id: {instance_id}")
    return _instances[instance_id]


def list_instances() -> list[dict]:
    """List all loaded instances as serializable dicts."""
    return [
        {
            "instance_id": v.instance_id,
            "plugin_name": v.plugin_name,
            "plugin_path": v.plugin_path,
            "parameters": v.parameters,
        }
        for v in _instances.values()
    ]


@on_host_thread
def process_chain(
    instance_ids: list[str], audio: np.ndarray, sample_rate: int
) -> np.ndarray:
    """Process audio through an ordered chain of loaded VST instances."""
    result = audio
    for iid in instance_ids:
        inst = get_instance(iid)
        result = inst.process(result, sample_rate)
    return result


@on_host_thread
def process_with_plugin(
    plugin_path: str,
    audio: np.ndarray,
    sample_rate: int,
    params: dict[str, float] | None = None,
    raw_state: str | bytes | None = None,
    warnings: list[str] | None = None,
) -> np.ndarray:
    """Process audio through a single VST3 plugin, statelessly.

    The plugin is loaded fresh, an optional full ``raw_state`` (captured from the
    plugin's native editor, base64 or bytes) is restored, optional individual
    parameters are applied, the audio is processed, and the plugin is discarded
    (it is never added to the instance registry). This mirrors the studio effect
    pipeline so a VST3 can be one stage of the MIX effect chain.

    Anything that could not be applied is appended to ``warnings`` rather than
    swallowed, because the audible symptom of a silent skip (a plugin running at
    its defaults) is indistinguishable from the plugin simply doing nothing.
    """
    pb = _get_pedalboard()
    path = Path(plugin_path)
    if not path.exists():
        raise FileNotFoundError(f"VST3 plugin not found: {plugin_path}")
    plugin = load_plugin_file(pb, str(path))
    notes = warnings if warnings is not None else []
    if raw_state:
        error = _apply_raw_state(plugin, raw_state)
        if error:
            # The plugin then runs at defaults, which sounds like a working
            # render, say so instead of letting it pass for success.
            notes.append(f"saved editor state could not be restored: {error}")
            log.warning("VST raw_state rejected by %s: %s", path.stem, error)
    if params:
        for name, value in params.items():
            try:
                set_plugin_parameter(plugin, name, float(value))
            except Exception as e:
                notes.append(f"parameter '{name}' not applied: {e}")
                log.warning("VST param '%s' rejected by %s: %s", name, path.stem, e)
    return plugin(audio, sample_rate)


# Container / abstract / non-effect pedalboard classes to exclude from the
# built-in effect list (they are not stand-alone processors).
_NON_EFFECT_PLUGINS = {
    "Plugin",
    "Pedalboard",
    "ExternalPlugin",
    "VST3Plugin",
    "AudioUnitPlugin",
    "PluginContainer",
    "Chain",
    "Mix",
    "AudioStream",
    # Abstract base for the shelf/peak filters; cannot be instantiated directly.
    "IIRFilter",
}


def list_builtin_effects() -> list[dict]:
    """List pedalboard's built-in effects (available without any VST3).

    Introspected from the installed pedalboard rather than hardcoded, so the
    list never drifts from the version actually present.
    """
    pb = _get_pedalboard()
    plugin_base = pb.Plugin
    names = sorted(
        n
        for n in dir(pb)
        if not n.startswith("_")
        and n not in _NON_EFFECT_PLUGINS
        and isinstance(getattr(pb, n), type)
        and issubclass(getattr(pb, n), plugin_base)
    )
    return [{"name": name, "type": "builtin"} for name in names]
