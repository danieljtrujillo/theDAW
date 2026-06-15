import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, Loader2, RefreshCw, Square, Tv2 } from 'lucide-react';

export type QuestCastDevice = { serial?: string; state?: string };

export type QuestCastStatus = {
  ok?: boolean;
  running?: boolean;
  state?: string;
  ws_port?: number;
  adb?: string | null;
  node?: string | null;
  bootstrapped?: boolean;
  server_bin?: boolean;
  serial?: string | null;
  devices?: Array<QuestCastDevice | string> | unknown;
  codec?: string;
  message?: string;
  error?: string;
  detail?: string;
};

type PreviewStats = {
  connection: 'idle' | 'connecting' | 'connected' | 'waiting-video' | 'playing' | 'error';
  codec: string | null;
  width: number | null;
  height: number | null;
  fps: number;
  kbps: number;
  frames: number;
  error: string | null;
};

type QuestCastPreviewProps = {
  status: QuestCastStatus | null;
  busy: boolean;
  detail: string;
  onStart: () => void | Promise<void>;
  onStop: () => void | Promise<void>;
  onRefresh: () => void | Promise<void>;
};

export const summarizeQuestCastDevices = (devices: QuestCastStatus['devices']): string | null => {
  if (!Array.isArray(devices) || devices.length === 0) return null;
  const labels = devices
    .map((device) => {
      if (typeof device === 'string') return device;
      if (device && typeof device === 'object') {
        const d = device as QuestCastDevice;
        if (!d.serial) return null;
        return d.state ? `${d.serial}:${d.state}` : d.serial;
      }
      return null;
    })
    .filter((label): label is string => Boolean(label));
  return labels.length ? `devices ${labels.join(', ')}` : null;
};

export const describeQuestCastStatus = (status: QuestCastStatus | null): string => {
  if (!status) return 'delinQuest status not loaded yet.';
  const state = typeof status.state === 'string' ? status.state : status.running ? 'running' : 'stopped';
  const parts = [`state ${state}`];
  if (status.error) parts.push(`error ${status.error}`);
  if (status.message && status.message !== status.error) parts.push(status.message);
  if (status.detail) parts.push(`detail ${status.detail}`);
  parts.push(status.adb ? 'ADB found' : 'ADB not found');
  if (!status.node) parts.push('Node not found');
  if (status.bootstrapped === false) parts.push('deps not installed');
  if (status.server_bin === false) parts.push('scrcpy server missing');
  if (status.serial) parts.push(`device ${status.serial}`);
  const devices = summarizeQuestCastDevices(status.devices);
  if (devices) parts.push(devices);
  if (typeof status.ws_port === 'number') parts.push(`WS ${status.ws_port}`);
  if (status.codec) parts.push(`codec ${status.codec}`);
  return parts.join(' · ');
};

const initialStats: PreviewStats = {
  connection: 'idle',
  codec: null,
  width: null,
  height: null,
  fps: 0,
  kbps: 0,
  frames: 0,
  error: null,
};

const byteHex = (value: number) => value.toString(16).padStart(2, '0').toUpperCase();

const findStartCode = (data: Uint8Array, from: number): number => {
  for (let i = from; i + 3 < data.length; i += 1) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) return i;
    if (i + 4 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) return i;
  }
  return -1;
};

const h264CodecFromAnnexB = (data: Uint8Array): string | null => {
  let cursor = 0;
  while (cursor < data.length) {
    const start = findStartCode(data, cursor);
    if (start < 0) break;
    const startCodeLength = data[start + 2] === 1 ? 3 : 4;
    const nalStart = start + startCodeLength;
    const next = findStartCode(data, nalStart);
    const nalEnd = next < 0 ? data.length : next;
    if (nalStart < nalEnd && (data[nalStart] & 0x1f) === 7) {
      // H.264 SPS: [nal header][profile_idc][constraint flags][level_idc]...
      if (nalEnd - nalStart >= 4) {
        return `avc1.${byteHex(data[nalStart + 1])}${byteHex(data[nalStart + 2])}${byteHex(data[nalStart + 3])}`;
      }
    }
    cursor = nalEnd;
  }
  return null;
};

const wsUrlForPort = (port: number): string => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.hostname || 'localhost';
  return `${protocol}//${host}:${port}`;
};

export const QuestCastPreview: React.FC<QuestCastPreviewProps> = ({
  status,
  busy,
  detail,
  onStart,
  onStop,
  onRefresh,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [stats, setStats] = useState<PreviewStats>(initialStats);

  const state = typeof status?.state === 'string' ? status.state : status?.running ? 'running' : 'stopped';
  const ready = state === 'ready' && typeof status?.ws_port === 'number';
  const running = Boolean(status?.running) || ready;
  const errored = state === 'error' || Boolean(status?.error) || stats.connection === 'error';

  useEffect(() => {
    if (!ready || typeof status?.ws_port !== 'number') {
      setStats((prev) => ({ ...initialStats, error: prev.error && running ? prev.error : null }));
      return;
    }

    if (!('VideoDecoder' in window)) {
      setStats({
        ...initialStats,
        connection: 'error',
        error: 'This browser cannot preview delinQuest directly because WebCodecs VideoDecoder is unavailable. Use current Chrome or Edge.',
      });
      return;
    }

    let closed = false;
    let decoder: VideoDecoder | null = null;
    let configured = false;
    let waitingForKeyframe = true;
    let framesThisSecond = 0;
    let bytesThisSecond = 0;
    let lastTick = performance.now();

    const updateError = (message: string) => {
      if (closed) return;
      setStats((prev) => ({ ...prev, connection: 'error', error: message }));
    };

    const configureDecoder = (codec: string) => {
      decoder?.close();
      decoder = new VideoDecoder({
        output(frame) {
          try {
            const canvas = canvasRef.current;
            const context = canvas?.getContext('2d');
            if (!canvas || !context) return;
            const width = frame.displayWidth || frame.codedWidth || 1280;
            const height = frame.displayHeight || frame.codedHeight || 720;
            if (canvas.width !== width || canvas.height !== height) {
              canvas.width = width;
              canvas.height = height;
            }
            context.drawImage(frame, 0, 0, width, height);
            framesThisSecond += 1;
            const now = performance.now();
            if (now - lastTick >= 1000) {
              const elapsed = now - lastTick;
              setStats((prev) => ({
                ...prev,
                connection: 'playing',
                codec,
                width,
                height,
                fps: Math.round((framesThisSecond * 1000) / elapsed),
                kbps: Math.round((bytesThisSecond * 8) / elapsed),
                frames: prev.frames + framesThisSecond,
                error: null,
              }));
              framesThisSecond = 0;
              bytesThisSecond = 0;
              lastTick = now;
            }
          } finally {
            frame.close();
          }
        },
        error(error) {
          updateError(error instanceof Error ? error.message : String(error));
        },
      });
      decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
      configured = true;
      waitingForKeyframe = true;
      setStats((prev) => ({ ...prev, connection: 'waiting-video', codec, error: null }));
    };

    const socket = new WebSocket(wsUrlForPort(status.ws_port));
    socket.binaryType = 'arraybuffer';
    setStats({ ...initialStats, connection: 'connecting' });

    socket.onopen = () => {
      if (!closed) setStats((prev) => ({ ...prev, connection: 'connected', error: null }));
    };

    socket.onerror = () => updateError('delinQuest WebSocket connection failed. Stop and start delinQuest, then try again.');
    socket.onclose = () => {
      if (!closed) setStats((prev) => ({ ...prev, connection: ready ? 'idle' : prev.connection }));
    };

    socket.onmessage = (event) => {
      if (closed) return;
      if (typeof event.data === 'string') {
        try {
          const metadata = JSON.parse(event.data) as { codec?: string; width?: number | null; height?: number | null };
          setStats((prev) => ({
            ...prev,
            codec: metadata.codec ?? prev.codec,
            width: metadata.width ?? prev.width,
            height: metadata.height ?? prev.height,
          }));
        } catch {
          // Ignore non-metadata text frames.
        }
        return;
      }

      const buffer = event.data instanceof ArrayBuffer ? event.data : null;
      if (!buffer || buffer.byteLength < 16) return;
      const view = new DataView(buffer);
      const packetType = view.getUint8(0);
      const keyframe = view.getUint8(1) === 1;
      const timestamp = Math.max(0, Math.round(view.getFloat64(8, true) || performance.now() * 1000));
      const data = new Uint8Array(buffer, 16);
      bytesThisSecond += data.byteLength;

      if (packetType === 0) {
        configureDecoder(h264CodecFromAnnexB(data) ?? 'avc1.42E01E');
        return;
      }

      if (packetType !== 1 || !decoder || !configured) return;
      if (waitingForKeyframe && !keyframe) return;
      waitingForKeyframe = false;
      if (decoder.decodeQueueSize > 8) return;

      try {
        decoder.decode(new EncodedVideoChunk({ type: keyframe ? 'key' : 'delta', timestamp, data }));
      } catch (error) {
        updateError(error instanceof Error ? error.message : String(error));
      }
    };

    return () => {
      closed = true;
      try { socket.close(); } catch { /* already closed */ }
      try { decoder?.close(); } catch { /* already closed */ }
    };
  }, [ready, running, status?.ws_port]);

  const connectionLabel = errored
    ? 'Problem'
    : stats.connection === 'playing'
    ? `Live ${stats.fps}fps`
    : ready
    ? 'Ready, waiting for frames'
    : running
    ? 'Starting'
    : 'Off';

  return (
    <div className="absolute left-3 bottom-3 z-30 w-80 overflow-hidden rounded-xl border border-sky-500/30 bg-[#050712]/95 shadow-2xl shadow-black/70 backdrop-blur">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <Tv2 className="w-3.5 h-3.5 text-sky-300 shrink-0" />
          <div className="min-w-0">
            <div className="text-[9px] font-black uppercase tracking-widest text-sky-100">delinQuest Preview</div>
            <div className="truncate text-[8px] font-mono text-zinc-500">No window picker. USB/ADB direct feed.</div>
          </div>
        </div>
        <span className={`rounded border px-1.5 py-0.5 text-[8px] font-mono uppercase ${
          errored
            ? 'border-rose-500/40 bg-rose-500/10 text-rose-200'
            : stats.connection === 'playing'
            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
            : ready || running
            ? 'border-sky-500/40 bg-sky-500/10 text-sky-200'
            : 'border-white/10 text-zinc-500'
        }`}>{connectionLabel}</span>
      </div>

      <div className="relative aspect-video bg-black">
        <canvas ref={canvasRef} className="h-full w-full object-contain" />
        {stats.connection !== 'playing' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
            {busy || running ? (
              <Loader2 className="h-5 w-5 animate-spin text-sky-300" />
            ) : errored ? (
              <AlertCircle className="h-5 w-5 text-rose-300" />
            ) : (
              <Tv2 className="h-5 w-5 text-zinc-500" />
            )}
            <div className="text-[9px] font-mono uppercase tracking-widest text-zinc-300">
              {errored ? 'Quest preview needs attention' : ready ? 'Waiting for Quest frames…' : 'Quest direct feed is off'}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-2 p-3">
        <p className="text-[8px] font-mono leading-relaxed text-zinc-400">
          Use <span className="text-sky-200">Start delinQuest</span> for the direct delinQuest path. Do <span className="text-amber-200">not</span> choose a browser window for this path. The browser “choose a window” dialog is only for the separate VJ SCREEN source, and it requires an already-open scrcpy/window source.
        </p>
        {(stats.error || status?.error || status?.message) && (
          <p className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1.5 text-[8px] font-mono leading-relaxed text-rose-200">
            {stats.error || status?.error || status?.message}
          </p>
        )}
        <p className="text-[8px] font-mono leading-relaxed text-zinc-500">{detail}</p>
        {stats.connection === 'playing' && (
          <div className="flex flex-wrap gap-1 text-[8px] font-mono text-zinc-400">
            {stats.codec && <span className="rounded bg-white/5 px-1.5 py-0.5">{stats.codec}</span>}
            {stats.width && stats.height && <span className="rounded bg-white/5 px-1.5 py-0.5">{stats.width}×{stats.height}</span>}
            <span className="rounded bg-white/5 px-1.5 py-0.5">{stats.kbps} kbps</span>
            <span className="rounded bg-white/5 px-1.5 py-0.5">{stats.frames} frames</span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void (running ? onStop() : onStart())}
            disabled={busy}
            className={`flex items-center gap-1 rounded border px-2 py-1 text-[9px] font-black uppercase tracking-widest disabled:opacity-50 ${
              running
                ? 'border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'
                : 'border-sky-500/40 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20'
            }`}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : running ? <Square className="h-3 w-3" /> : <Check className="h-3 w-3" />}
            {running ? 'Stop Quest' : 'Start Quest'}
          </button>
          <button
            type="button"
            onClick={() => void onRefresh()}
            disabled={busy}
            className="flex items-center gap-1 rounded border border-white/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-zinc-300 hover:bg-white/5 disabled:opacity-50"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </div>
      </div>
    </div>
  );
};