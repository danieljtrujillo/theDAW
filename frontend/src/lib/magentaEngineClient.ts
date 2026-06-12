// Magenta RT2 engine swap — the Model dropdown is the only control.
//
// Picking a magenta model parks SA3 in CPU RAM (frees the 6 GB card), starts
// the WSL2 engine, and polls it to READY. Picking any SA3 model stops every
// magenta engine and swaps SA3 back onto the GPU. The backend endpoints
// (/api/magenta/engine/*) own the actual lifecycle; this client just drives
// them and mirrors the state into the params store for the dropdown pill.
import { useGenerateParamsStore } from '../state/generateParamsStore';
import { logError, logInfo } from '../state/logStore';

const READY_DEADLINE_MS = 10 * 60_000; // model load + one-time JAX compile
const POLL_INTERVAL_MS = 3000;

// Rapid dropdown flips supersede each other; only the latest swap may write state.
let _swapToken = 0;

const setField = <K extends 'magentaEngine' | 'magentaAvailable'>(
  key: K,
  value: K extends 'magentaEngine' ? 'off' | 'starting' | 'ready' | 'error' | 'setup' : boolean,
): void => {
  useGenerateParamsStore.getState().setField(key, value as never);
};

export async function swapEngineForModel(prevModel: string, nextModel: string): Promise<void> {
  const wasMagenta = prevModel.startsWith('magenta-');
  const isMagenta = nextModel.startsWith('magenta-');
  if (wasMagenta === isMagenta) return;
  const token = ++_swapToken;

  if (isMagenta) {
    setField('magentaEngine', 'starting');
    try {
      const r = await fetch('/api/magenta/engine/start', { method: 'POST' });
      if (!r.ok) {
        const detail = await r.json().then((j) => j?.detail).catch(() => null);
        if (r.status === 412 && detail?.setup_required) {
          // The WSL side was never installed — a guided state, not an error.
          if (_swapToken === token) setField('magentaEngine', 'setup');
          logError('magenta', detail.message || 'Magenta engine setup required: run Setup-MRT2.bat once.');
          return;
        }
        throw new Error(
          (typeof detail === 'string' ? detail : detail?.message) || `engine start → HTTP ${r.status}`,
        );
      }
      logInfo('magenta', 'Engine starting: SA3 parked, WSL2 sidecar spawning');
      const deadline = Date.now() + READY_DEADLINE_MS;
      while (Date.now() < deadline) {
        if (_swapToken !== token) return; // a newer swap took over
        const s = await fetch('/api/magenta/engine/status')
          .then((x) => (x.ok ? x.json() : null))
          .catch(() => null);
        if (s?.available) {
          if (_swapToken !== token) return;
          setField('magentaAvailable', true);
          setField('magentaEngine', 'ready');
          logInfo('magenta', `Engine READY (${s.model ?? 'mrt2'} on ${s.device ?? 'GPU'})`);
          return;
        }
        await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
      }
      throw new Error('engine did not become ready within 10 minutes');
    } catch (e) {
      if (_swapToken === token) setField('magentaEngine', 'error');
      logError('magenta', `Engine start failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    try {
      const r = await fetch('/api/magenta/engine/stop', { method: 'POST' });
      if (!r.ok) throw new Error(`engine stop → HTTP ${r.status}`);
      logInfo('magenta', 'Engine stopped; SA3 restored to the GPU');
    } catch (e) {
      // The lazy wake path restores SA3 at the next CREATE regardless.
      logError('magenta', `Engine stop failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (_swapToken === token) setField('magentaEngine', 'off');
  }
}
