"""Headless Azure Kinect (K4A) capture sidecar for the native ``akvj3d`` path.

Opens the Azure Kinect directly with pyk4a, builds a one-time XY unprojection ray
table, and streams to the akvj relay's ``/ws/source``:

  * a one-time XY table (sent on connect + a slow heartbeat), chunked into
    row-blocks so each WebSocket message stays under the 1 MB default cap; and
  * per frame, depth16 (640x576) + the depth-aligned colour as JPEG.

The VJ ``akvj3d`` source unprojects ``position = (rayX, rayY, 1) * depthMeters``
in a vertex shader and renders the point cloud, so the look lives in the browser.

Wire format (little-endian), matching backend/modules/akvj/router.py and the VJ
``useAkvj3d`` parser:

  Table chunk:  '<4sBBHHHH' magic="AKV1" type=1 version=1 W H rowStart rowCount
                + float32[rowCount*W*2]   (rayX, rayY interleaved, row-major)
  Frame:        '<4sBBHHBBII' magic="AKV1" type=2 version=1 W H
                depthEnc colorEnc depthLen colorLen
                + depth bytes (uint16 LE mm) + colour bytes (JPEG RGB)

Speaks structured JSON status lines on stdout for the sidecar manager:
  {"status": "device", ...} once the camera opens
  {"status": "streaming", "fps": N, ...} periodically
  {"status": "error", "message": ...} on any fatal problem

Windows x64 / Linux x64 only. pyk4a-bundle ships the matched Azure Kinect
runtime inside the wheel (``k4a.dll`` + depthengine on Windows, ``libk4a.so``
on Linux). macOS has no Azure Kinect SDK and is rejected by the sidecar
manager before this script is ever spawned.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import struct
import sys
import time
from pathlib import Path
from typing import Optional

MAGIC = b"AKV1"
MSG_TABLE = 1
MSG_FRAME = 2
VERSION = 1
DEPTH_ENC_RAW_U16 = 0
COLOR_ENC_JPEG = 0
ROWS_PER_CHUNK = 64  # 64 * 640 * 2 * 4 = 327 KB/chunk, safely under the 1 MB cap
TABLE_HEARTBEAT_SEC = 5.0
OPEN_ATTEMPTS = 5  # retry device-open so a brief webcam/other-app hold rides out
OPEN_RETRY_SEC = 1.0


def emit(**kw) -> None:
    """Write one structured status line to stdout for the sidecar manager."""
    sys.stdout.write(json.dumps(kw) + "\n")
    sys.stdout.flush()


def _fps_enum(fps_int: int):
    from pyk4a import FPS

    if fps_int <= 5:
        return FPS.FPS_5, 5
    if fps_int <= 15:
        return FPS.FPS_15, 15
    return FPS.FPS_30, 30


def _xy_table_cache_path(calibration_raw: str) -> Path:
    """Disk-cache location for the XY table, keyed by the device calibration.

    The cache key must also fold in the depth mode, resolution, and a format
    version: the raw calibration JSON is per-device but mode-agnostic, and any
    change to the table layout must invalidate old files instead of loading
    them into a mismatched parser.
    """
    key = hashlib.sha256(
        (calibration_raw + "|NFOV_UNBINNED|640x576|v1").encode()
    ).hexdigest()
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".cache")
    return Path(base) / "theDAW" / "akvj" / f"xy_{key}.npy"


def _build_xy_table_perpixel(calibration, width: int, height: int):
    """Per-pixel table build (~369k convert_2d_to_3d calls), kept as the
    fallback when the SDK's vectorized point-cloud transform is unavailable.
    Emits progress because it takes a few seconds and would otherwise look
    like a hang."""
    import numpy as np
    from pyk4a import CalibrationType

    table = np.zeros((height, width, 2), dtype="<f4")
    ref_mm = 1000.0
    step = max(1, height // 10)
    valid = 0
    for y in range(height):
        for x in range(width):
            try:
                p = calibration.convert_2d_to_3d(
                    (x, y), ref_mm, CalibrationType.DEPTH, CalibrationType.DEPTH
                )
            except Exception:  # noqa: BLE001 — invalid pixel, leave (0,0)
                continue
            if p is None:
                continue
            z = float(p[2])
            if z <= 1e-3:
                continue
            table[y, x, 0] = float(p[0]) / z
            table[y, x, 1] = float(p[1]) / z
            valid += 1
        if y % step == 0 or y == height - 1:
            emit(
                status="building_table",
                percent=round((y + 1) * 100 / height),
                rows=y + 1,
                total=height,
            )
    return table, valid


def build_xy_table(calibration, width: int, height: int, calibration_raw: str = ""):
    """Per-pixel ray slopes (rayX, rayY) with position = (rayX, rayY, 1)*depth.

    Built once from k4a's 2d->3d unprojection at a reference depth, so the browser
    only needs depth per frame. Invalid pixels get (0, 0) and render at the origin
    (the shader discards zero-depth points anyway). The table is device-static, so
    it is cached on disk keyed by the calibration blob; a rebuild uses the SDK's
    vectorized depth->point-cloud transform and falls back to the original
    per-pixel loop when that is unavailable."""
    import numpy as np

    cache_path = None
    if calibration_raw:
        try:
            cache_path = _xy_table_cache_path(calibration_raw)
            cached = np.load(cache_path)
            if cached.shape == (height, width, 2) and cached.dtype == np.dtype("<f4"):
                valid = int(np.count_nonzero(np.any(cached != 0, axis=2)))
                emit(
                    status="table_ready",
                    valid_pixels=valid,
                    total_pixels=width * height,
                    source="cache",
                )
                return cached
        except Exception:  # noqa: BLE001 — any cache problem falls through to a rebuild
            pass

    source = "sdk"
    try:
        from pyk4a.transformation import depth_image_to_point_cloud

        # ref_mm=4000 keeps the SDK's int16-mm point cloud in range (|x| and |y|
        # stay under ~2800 mm at NFOV's field of view) while the 1 mm output
        # quantization divides down to a ray-slope error of only ~2.5e-4.
        ref_mm = 4000
        depth_ref = np.full((height, width), ref_mm, np.uint16)
        pc = depth_image_to_point_cloud(
            depth_ref, calibration, thread_safe=True, calibration_type_depth=True
        )
    except Exception:  # noqa: BLE001 — older pyk4a or SDK failure; use the slow path
        pc = None
    if pc is not None:
        z = pc[:, :, 2].astype(np.float32)
        valid_mask = z > 1e-3
        table = np.zeros((height, width, 2), dtype="<f4")
        np.divide(pc[:, :, 0], z, out=table[:, :, 0], where=valid_mask)
        np.divide(pc[:, :, 1], z, out=table[:, :, 1], where=valid_mask)
        valid = int(np.count_nonzero(valid_mask))
    else:
        source = "perpixel"
        table, valid = _build_xy_table_perpixel(calibration, width, height)

    if cache_path is not None:
        # Best-effort save: a read-only or full disk must never break startup.
        try:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            np.save(cache_path, table)
        except Exception:  # noqa: BLE001
            pass

    emit(
        status="table_ready",
        valid_pixels=valid,
        total_pixels=width * height,
        source=source,
    )
    return table


def pack_table_chunks(table, width: int, height: int):
    """Yield one AKV1 table-chunk message per row-block."""
    for row in range(0, height, ROWS_PER_CHUNK):
        rows = min(ROWS_PER_CHUNK, height - row)
        header = struct.pack(
            "<4sBBHHHH", MAGIC, MSG_TABLE, VERSION, width, height, row, rows
        )
        payload = table[row : row + rows].tobytes()
        yield header + payload


FRAME_HEADER = struct.Struct("<4sBBHHBBII")


async def run() -> None:
    import numpy as np
    import websockets
    from PIL import Image
    from pyk4a import ColorResolution, Config, DepthMode, ImageFormat, PyK4A

    ws_url = os.getenv("AKVJ_WS_URL", "ws://127.0.0.1:8600/api/akvj/ws/source")
    quality = int(os.getenv("AKVJ_COLOR_QUALITY", "70"))
    fps_req = int(os.getenv("AKVJ_FPS", "30"))
    fps_enum, fps_n = _fps_enum(fps_req)

    emit(
        status="opening", ws_url=ws_url, fps=fps_n, color="720p", depth="NFOV_UNBINNED"
    )

    k4a = PyK4A(
        Config(
            color_resolution=ColorResolution.RES_720P,
            color_format=ImageFormat.COLOR_BGRA32,
            depth_mode=DepthMode.NFOV_UNBINNED,  # 640x576
            camera_fps=fps_enum,
            synchronized_images_only=True,
        )
    )
    opened = False
    for attempt in range(1, OPEN_ATTEMPTS + 1):
        try:
            k4a.start()
            opened = True
            emit(status="opened", attempt=attempt)
            break
        except Exception as e:  # noqa: BLE001 — device open failed (in use / unplugged)
            detail = f"{type(e).__name__}: {e}".strip().rstrip(": ")
            emit(
                status="opening",
                attempt=attempt,
                attempts=OPEN_ATTEMPTS,
                retrying=attempt < OPEN_ATTEMPTS,
                note=(
                    f"open failed ({detail or 'no detail'}); the sensor may still be "
                    "releasing from the DEVICE/webcam path or held by another app"
                ),
            )
            if attempt < OPEN_ATTEMPTS:
                time.sleep(OPEN_RETRY_SEC)
    if not opened:
        emit(
            status="error",
            message=(
                f"could not open the Azure Kinect after {OPEN_ATTEMPTS} tries. Check it "
                "is on a USB 3.0 port, powered with its own supply, and not held by the "
                "DEVICE/webcam source, k4aviewer, Unity Akvj, or another app. A fresh "
                "sensor may also need a one-time firmware update."
            ),
        )
        return

    width, height = 640, 576
    emit(
        status="device",
        width=width,
        height=height,
        depth_mode="NFOV_UNBINNED",
        fps=fps_n,
    )

    emit(
        status="building_table",
        percent=0,
        note="one-time XY unprojection table (a few seconds)",
    )
    try:
        cal_raw = k4a.calibration_raw or ""
    except Exception:  # noqa: BLE001 — the disk cache is optional; build without it
        cal_raw = ""
    table = build_xy_table(k4a.calibration, width, height, cal_raw)
    table_msgs = list(pack_table_chunks(table, width, height))
    emit(status="table_packed", chunks=len(table_msgs))

    loop = asyncio.get_event_loop()
    frames = 0
    fps_t0 = time.monotonic()
    fps_count = 0

    depth_nbytes = width * height * 2
    # The scratch buffers are reused across frames; capture_and_pack returns an
    # immutable bytes copy, so packing frame N+1 may overlap sending frame N.
    jpeg_buf = io.BytesIO()
    scratch = bytearray(FRAME_HEADER.size + depth_nbytes + 512 * 1024)

    def capture_and_pack():
        """Capture one frame and assemble the complete AKV1 message.

        Runs entirely in the default executor: get_capture blocks on the
        device, and .depth / .transformed_color trigger the SDK's lazy
        color-to-depth transform (pyk4a is thread_safe by default), so all of
        that work stays off the event loop thread."""
        nonlocal scratch
        capture = k4a.get_capture()
        depth = capture.depth
        color = capture.transformed_color
        if depth is None or color is None:
            return None
        jpeg_buf.seek(0)
        jpeg_buf.truncate()
        rgb = color[:, :, :3][:, :, ::-1]  # BGRA -> RGB
        Image.fromarray(rgb, "RGB").save(jpeg_buf, format="JPEG", quality=quality)
        color_len = jpeg_buf.tell()
        total = FRAME_HEADER.size + depth_nbytes + color_len
        if total > len(scratch):
            scratch = bytearray(total + 128 * 1024)
        FRAME_HEADER.pack_into(
            scratch,
            0,
            MAGIC,
            MSG_FRAME,
            VERSION,
            width,
            height,
            DEPTH_ENC_RAW_U16,
            COLOR_ENC_JPEG,
            depth_nbytes,
            color_len,
        )
        depth_view = np.frombuffer(
            scratch, dtype="<u2", count=width * height, offset=FRAME_HEADER.size
        )
        depth_view.reshape(height, width)[:] = depth
        color_off = FRAME_HEADER.size + depth_nbytes
        scratch[color_off : color_off + color_len] = jpeg_buf.getbuffer()[:color_len]
        return bytes(memoryview(scratch)[:total])

    # Predeclared so the finally below can inspect them even when connect()
    # itself fails before the streaming loop ever assigns them.
    pack_fut: Optional[asyncio.Future] = None
    send_task: Optional[asyncio.Task] = None
    emit(status="connecting", ws_url=ws_url)
    try:
        async with websockets.connect(
            ws_url, max_size=None, ping_interval=20, ping_timeout=20
        ) as ws:
            emit(status="relay_connected", ws_url=ws_url)
            for m in table_msgs:
                await ws.send(m)
            last_table = time.monotonic()
            emit(
                status="streaming", fps=0, frames=0, note="sending depth+colour frames"
            )

            # Depth-1 pipeline: frame N+1 is captured and packed in the executor
            # while frame N's send is awaited. latest_payload keeps only the
            # newest completed pack, so a slow relay link drops frames instead
            # of accumulating queue latency.
            pack_fut = loop.run_in_executor(None, capture_and_pack)
            latest_payload: Optional[bytes] = None
            while True:
                waiting = {pack_fut} if send_task is None else {pack_fut, send_task}
                done, _ = await asyncio.wait(
                    waiting, return_when=asyncio.FIRST_COMPLETED
                )
                if pack_fut in done:
                    payload = pack_fut.result()
                    pack_fut = loop.run_in_executor(None, capture_and_pack)
                    if payload is not None:
                        latest_payload = payload
                if send_task is not None and send_task in done:
                    send_task.result()
                    send_task = None
                    frames += 1
                    fps_count += 1
                now = time.monotonic()
                if now - fps_t0 >= 2.0:
                    fps = round(fps_count / (now - fps_t0))
                    emit(status="streaming", fps=fps, frames=frames)
                    fps_t0 = now
                    fps_count = 0
                if send_task is None and now - last_table >= TABLE_HEARTBEAT_SEC:
                    # The heartbeat shares the socket with frame sends, so it
                    # only runs between frame sends to keep message order whole.
                    for m in table_msgs:
                        await ws.send(m)
                    last_table = now
                if send_task is None and latest_payload is not None:
                    send_task = asyncio.ensure_future(ws.send(latest_payload))
                    latest_payload = None
    except Exception as e:  # noqa: BLE001 — relay closed / device error mid-stream
        emit(status="error", message=f"stream ended: {e}")
    finally:
        # Both in-flight tasks must be retrieved before the device stops:
        # abandoning them logs "exception was never retrieved" noise, and
        # awaiting pack_fut guarantees k4a.stop() never overlaps an executor
        # thread still inside get_capture. CancelledError is a BaseException
        # on this interpreter, so it is suppressed explicitly.
        if send_task is not None:
            send_task.cancel()
            try:
                await send_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        if pack_fut is not None:
            try:
                await pack_fut
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        try:
            k4a.stop()
        except Exception:  # noqa: BLE001
            pass


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    except Exception as e:  # noqa: BLE001
        emit(status="error", message=str(e))
        sys.exit(1)
