import importlib
import json
import logging
from pathlib import Path
from fastapi import FastAPI

log = logging.getLogger(__name__)


def load_modules(app: FastAPI, modules_dir: Path) -> list[dict]:
    """
    Discover backend/modules/*/router.py files, import their APIRouter,
    and mount them on the app. Failures are logged and skipped — they
    never prevent the rest of the app from starting.
    """
    manifests: list[dict] = []
    if not modules_dir.is_dir():
        return manifests

    for module_dir in sorted(modules_dir.iterdir()):
        if not module_dir.is_dir():
            continue
        config_path = module_dir / "module.json"
        router_path = module_dir / "router.py"
        if not config_path.exists() or not router_path.exists():
            continue

        try:
            # Inside the try: PATCH /api/modules/{name}/enabled rewrites these
            # files at runtime, and an interrupted write must not brick the
            # next boot (the docstring promise is "logged and skipped").
            # utf-8 explicitly — read_text() defaults to the locale codepage
            # on Windows.
            config = json.loads(config_path.read_text(encoding="utf-8"))
            if not config.get("enabled", True):
                log.info("Module %s is disabled — skipping", module_dir.name)
                continue

            mod = importlib.import_module(f"backend.modules.{module_dir.name}.router")
            router = getattr(mod, "router")
            prefix = config.get("api_prefix", f"/api/{module_dir.name}")
            app.include_router(router, prefix=prefix)
            manifests.append(config)
            log.info("Loaded module: %s → %s", module_dir.name, prefix)
        except Exception as e:
            log.warning(
                "Module %s failed to load: %s — continuing without it",
                module_dir.name,
                e,
            )

    return manifests
