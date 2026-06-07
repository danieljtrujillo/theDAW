"""GPUSidecar — manages a long-lived neural model server subprocess.

Mirrors the pattern in ``backend/modules/stems/sidecar.py``: heavy ML deps live
in an isolated venv/process so the main API stays light; the sidecar is spawned
lazily on first use, health-checked over HTTP, and kept warm. One sidecar can
host several models (Mel-Roformer, DeepFilterNet, AudioSR, Apollo, …) with LRU
VRAM eviction inside the server.

This base implements the *manager* (spawn / health / infer). The per-fleet model
server (the script it launches) is provided separately and speaks:

    GET  /health                 -> 200 {"ok": true, "loaded": [...]}
    POST /infer/{model}          -> streams/returns the processed audio file

Until a server command is configured, ``ensure()`` raises a clear error so callers
return 501 rather than hanging.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Optional


class SidecarUnavailable(RuntimeError):
    pass


class GPUSidecar:
    def __init__(
        self,
        name: str,
        server_cmd: Optional[list[str]] = None,
        host: str = "127.0.0.1",
        port: int = 8911,
        boot_timeout: float = 300.0,  # first boot may download model weights
    ) -> None:
        self.name = name
        self.server_cmd = server_cmd
        self.host = host
        self.port = port
        self.boot_timeout = boot_timeout
        self._proc: Optional[asyncio.subprocess.Process] = None
        self._lock = asyncio.Lock()

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    async def _healthy(self) -> bool:
        try:
            import httpx

            async with httpx.AsyncClient(timeout=2.0) as c:
                r = await c.get(f"{self.base_url}/health")
                return r.status_code == 200
        except Exception:
            return False

    async def ensure(self) -> None:
        """Make sure the sidecar is up (spawn + wait for health). Lazy + idempotent."""
        async with self._lock:
            if await self._healthy():
                return
            if not self.server_cmd:
                raise SidecarUnavailable(
                    f"GPU sidecar '{self.name}' has no server command configured. "
                    f"Set server_cmd to launch the model server (see core/sidecar.py)."
                )
            self._proc = await asyncio.create_subprocess_exec(
                *self.server_cmd,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            deadline = asyncio.get_event_loop().time() + self.boot_timeout
            while asyncio.get_event_loop().time() < deadline:
                if await self._healthy():
                    return
                if self._proc.returncode is not None:
                    raise SidecarUnavailable(
                        f"sidecar '{self.name}' exited during boot (code {self._proc.returncode})"
                    )
                await asyncio.sleep(1.0)
            raise SidecarUnavailable(
                f"sidecar '{self.name}' did not become healthy in time"
            )

    async def infer(
        self,
        model: str,
        input_path: Path,
        output_path: Path,
        params: dict,
        timeout: float = 600.0,
    ) -> Path:
        """Send a file to the model server and write the processed result."""
        await self.ensure()
        import httpx

        async with httpx.AsyncClient(timeout=timeout) as c:
            with open(input_path, "rb") as f:
                r = await c.post(
                    f"{self.base_url}/infer/{model}",
                    files={"audio": f},
                    data={"params": __import__("json").dumps(params)},
                )
            r.raise_for_status()
            output_path.write_bytes(r.content)
        return output_path

    async def shutdown(self) -> None:
        if self._proc and self._proc.returncode is None:
            self._proc.terminate()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=10)
            except asyncio.TimeoutError:
                self._proc.kill()


# Single shared restoration/enhance sidecar (configure server_cmd when the model
# server module is added). Example once implemented:
#   server_cmd=[sys.executable, "-m", "edit_tools_backend.sidecar_server", "--port", "8911"]
RESTORE_SIDECAR = GPUSidecar(name="restore", server_cmd=None, port=8911)
NEURAL_SIDECAR = GPUSidecar(name="neural", server_cmd=None, port=8912)
_ = sys  # referenced in docstring example
