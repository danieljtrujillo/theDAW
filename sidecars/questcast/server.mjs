/**
 * theDAW Quest cast sidecar.
 *
 * Connects to the LOCAL adb server (the same one questmidi already runs),
 * starts the scrcpy server on the selected device over the scrcpy protocol,
 * and relays the raw H.264 video packets to the browser over a WebSocket.
 * The browser decodes them with WebCodecs (@yume-chan/scrcpy-decoder-webcodecs)
 * straight onto a canvas, which the VJ uses as a live source. No terminal, no
 * external scrcpy app, no OBS.
 *
 * Version pairing (checked against conflicts, 2026-06): @yume-chan/adb-scrcpy
 * 2.3.2 supports scrcpy protocol up to 3.3.3, so we pin the scrcpy SERVER to
 * 3.3.3 (fetched by the postinstall) and use AdbScrcpyOptions3_3_3. scrcpy 4.0
 * exists but is newer than the client lib supports — using it would be a
 * protocol conflict.
 *
 * Wire protocol to the browser:
 *   - first text message: {"type":"metadata","codec":"h264","width":..,"height":..}
 *   - then binary frames: [u8 type(0=config,1=data)][u8 keyframe][6 pad]
 *                         [f64 pts µs LE][...H.264 bytes]
 *   - the latest configuration packet is replayed to late-joining clients.
 */
import { Adb, AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { AdbScrcpyClient, AdbScrcpyOptions3_3_3 } from "@yume-chan/adb-scrcpy";
import { DefaultServerPath, ScrcpyVideoCodecNameMap } from "@yume-chan/scrcpy";
import { ReadableStream, WritableStream } from "@yume-chan/stream-extra";
import { BIN, VERSION } from "@yume-chan/fetch-scrcpy-server";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const WS_PORT = Number(process.env.QUESTCAST_WS_PORT || process.argv[2] || 8930);
const ADB_HOST = process.env.QUESTCAST_ADB_HOST || "127.0.0.1";
const ADB_PORT = Number(process.env.QUESTCAST_ADB_PORT || 5037);
const DEVICE_SERIAL = process.env.QUESTCAST_DEVICE_SERIAL || ""; // empty = first device

/** Structured one-line status to stdout so the Python module can parse it. */
function emit(status, extra = {}) {
  process.stdout.write(JSON.stringify({ status, ...extra }) + "\n");
}

function fail(message, extra = {}) {
  emit("error", { message, ...extra });
  process.exitCode = 1;
}

async function main() {
  emit("step", { step: "boot", wsPort: WS_PORT, adbHost: ADB_HOST, adbPort: ADB_PORT, node: process.version });

  // 1. Connect to the local adb server (questmidi keeps one alive; the Python
  //    module also runs `adb start-server` before spawning us as a guard).
  emit("step", { step: "connecting-adb", host: ADB_HOST, port: ADB_PORT });
  const connector = new AdbServerNodeTcpConnector({ host: ADB_HOST, port: ADB_PORT });
  const serverClient = new AdbServerClient(connector);

  let devices;
  try {
    devices = await serverClient.getDevices();
  } catch (e) {
    return fail(`could not reach adb server at ${ADB_HOST}:${ADB_PORT} (is it running?)`, {
      detail: String(e?.message ?? e),
    });
  }
  emit("step", { step: "got-devices", count: devices.length, serials: devices.map((d) => d.serial) });

  if (!devices.length) {
    return fail("no adb device found — plug in the headset and enable USB debugging (or pair wireless adb)");
  }

  const device =
    (DEVICE_SERIAL && devices.find((d) => d.serial === DEVICE_SERIAL)) || devices[0];
  emit("device", { serial: device.serial, all: devices.map((d) => d.serial) });

  const transport = await serverClient.createTransport({ serial: device.serial });
  const adb = new Adb(transport);
  emit("step", { step: "transport-open", serial: device.serial });

  // 2. Push the version-matched scrcpy server, then start it (video only).
  emit("step", { step: "pushing-scrcpy-server", version: VERSION });
  const serverBytes = await readFile(fileURLToPath(BIN));
  await AdbScrcpyClient.pushServer(
    adb,
    new ReadableStream({
      start(controller) {
        controller.enqueue(serverBytes);
        controller.close();
      },
    }),
  );

  const options = new AdbScrcpyOptions3_3_3({
    // video-only: we just want the picture as a VJ source.
    audio: false,
    control: false,
    video: true,
    videoCodec: "h264",
    maxSize: 1920,
    maxFps: 60,
    videoBitRate: 8_000_000,
  });

  emit("step", { step: "starting-scrcpy", codec: "h264", maxSize: 1920, maxFps: 60 });
  let client;
  try {
    client = await AdbScrcpyClient.start(adb, DefaultServerPath, options);
  } catch (e) {
    return fail("scrcpy server failed to start on the device", {
      detail: String(e?.output ? e.output.join("\n") : e?.message ?? e),
    });
  }
  emit("step", { step: "scrcpy-started" });

  // Surface scrcpy's own stdout/stderr for diagnostics.
  void client.output.pipeTo(
    new WritableStream({
      write(line) {
        emit("scrcpy", { line });
      },
    }),
  ).catch(() => {});

  const video = await client.videoStream;
  if (!video) return fail("video stream was not produced (video disabled?)");

  const { metadata, stream } = video;
  const codecName = ScrcpyVideoCodecNameMap.get(metadata.codec) ?? "h264";
  emit("video-meta", {
    codec: codecName,
    width: metadata.width ?? null,
    height: metadata.height ?? null,
    deviceName: metadata.deviceName ?? null,
  });
  const metaMessage = JSON.stringify({
    type: "metadata",
    codec: codecName,
    width: metadata.width ?? null,
    height: metadata.height ?? null,
    deviceName: metadata.deviceName ?? null,
    scrcpyVersion: VERSION,
  });

  // 3. WebSocket fan-out. The packet stream MUST be consumed continuously or
  //    the device connection blocks, so we always pump it, broadcasting to any
  //    connected clients and caching the last configuration packet for late
  //    joiners.
  const wss = new WebSocketServer({ port: WS_PORT });
  const clients = new Set();
  let lastConfig = null;

  wss.on("listening", () => emit("ready", { port: WS_PORT, codec: codecName, serial: device.serial }));
  wss.on("error", (e) => fail("websocket server error", { detail: String(e?.message ?? e) }));
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.binaryType = "arraybuffer";
    emit("client-connected", { clients: clients.size, replayedConfig: !!lastConfig });
    try {
      ws.send(metaMessage);
      if (lastConfig) ws.send(lastConfig);
    } catch { /* client went away */ }
    ws.on("close", () => { clients.delete(ws); emit("client-closed", { clients: clients.size }); });
    ws.on("error", () => clients.delete(ws));
  });

  // Periodic packet stats so we can see frames actually flowing (or NOT).
  let pktCount = 0;
  let keyCount = 0;
  let configCount = 0;
  let byteCount = 0;
  let sawFirstData = false;
  const statsTimer = setInterval(() => {
    emit("packet-stats", {
      packets: pktCount,
      keyframes: keyCount,
      configs: configCount,
      bytes: byteCount,
      clients: clients.size,
    });
  }, 2000);
  statsTimer.unref?.();

  const encode = (pkt) => {
    const isData = pkt.type === "data";
    const data = pkt.data; // Uint8Array
    const out = new Uint8Array(16 + data.byteLength);
    const dv = new DataView(out.buffer);
    dv.setUint8(0, isData ? 1 : 0);
    dv.setUint8(1, isData && pkt.keyframe ? 1 : 0);
    dv.setFloat64(8, isData && pkt.pts != null ? Number(pkt.pts) : 0, true);
    out.set(data, 16);
    return out;
  };

  await stream.pipeTo(
    new WritableStream({
      write(packet) {
        const frame = encode(packet);
        if (packet.type === "configuration") {
          lastConfig = frame;
          configCount += 1;
          emit("config-packet", { bytes: packet.data?.byteLength ?? 0 });
        } else {
          pktCount += 1;
          byteCount += packet.data?.byteLength ?? 0;
          if (packet.keyframe) keyCount += 1;
          if (!sawFirstData) {
            sawFirstData = true;
            emit("first-data-packet", { keyframe: !!packet.keyframe, bytes: packet.data?.byteLength ?? 0, clients: clients.size });
          }
        }
        for (const ws of clients) {
          if (ws.readyState === ws.OPEN) {
            try { ws.send(frame); } catch { /* drop */ }
          }
        }
      },
      close() { clearInterval(statsTimer); emit("video-ended"); },
      abort(reason) { clearInterval(statsTimer); fail("video stream aborted", { detail: String(reason) }); },
    }),
  );
}

main().catch((e) => fail("unexpected sidecar failure", { detail: String(e?.stack ?? e) }));
