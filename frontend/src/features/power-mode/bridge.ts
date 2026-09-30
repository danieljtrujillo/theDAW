import { powerModePatch } from './controlMap';

export interface PowerModeEntryLike {
  id: string;
  params: Record<string, number>;
}

export interface PowerModeBridgeOptions {
  findEntry: () => PowerModeEntryLike | null | undefined;
  updateParams: (entryId: string, params: Record<string, number>) => void;
}

let activeDetach: (() => void) | null = null;

function isRuntimeSource(source: MessageEventSource | null): boolean {
  if (!source) return false;
  if (source === window) return true;
  return Array.from(window.document.querySelectorAll('iframe')).some(frame => frame.contentWindow === source);
}

export function registerPowerModeBridge(options: PowerModeBridgeOptions): () => void {
  activeDetach?.();
  let frameId: number | null = null;
  let pendingPatch: Record<string, number> | null = null;
  const flush = () => {
    frameId = null;
    const patch = pendingPatch;
    pendingPatch = null;
    if (!patch) return;
    const entry = options.findEntry();
    if (entry) options.updateParams(entry.id, { ...entry.params, ...patch });
  };
  const handler = (event: MessageEvent<unknown>) => {
    const patch = powerModePatch(event.data);
    if (!patch || !isRuntimeSource(event.source)) return;
    pendingPatch = { ...pendingPatch, ...patch };
    if (frameId === null) frameId = requestAnimationFrame(flush);
  };
  window.addEventListener('message', handler);
  const detach = () => {
    window.removeEventListener('message', handler);
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
    pendingPatch = null;
  };
  activeDetach = detach;
  return () => {
    if (activeDetach !== detach) return;
    detach();
    activeDetach = null;
  };
}
