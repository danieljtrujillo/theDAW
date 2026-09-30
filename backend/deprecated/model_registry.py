import threading
import logging
from typing import Any, Callable

log = logging.getLogger(__name__)
_lock = threading.Lock()
_cache: dict[str, Any] = {}


def get_model(name: str, loader_fn: Callable, *args: Any, **kwargs: Any) -> Any:
    """
    Return a cached model by name. If not yet loaded, call loader_fn(*args, **kwargs),
    cache it, and return it. Thread-safe.

    Call this inside route handlers, never at module top-level:
        ae = get_model("same-s", AutoencoderModel.from_pretrained, "same-s", device="cuda")
    """
    if name in _cache:
        return _cache[name]
    with _lock:
        if name not in _cache:
            log.info("Loading model '%s' into registry", name)
            _cache[name] = loader_fn(*args, **kwargs)
            log.info("Model '%s' loaded and cached", name)
    return _cache[name]


def release_model(name: str) -> None:
    """Evict a model from the registry to free VRAM."""
    with _lock:
        if name in _cache:
            del _cache[name]
            log.info("Model '%s' released from registry", name)
