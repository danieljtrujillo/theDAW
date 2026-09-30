// A Magenta engine this copy of theDAW did not start (another copy's, a
// worktree's, one started by hand) holds the GPU. The backend stops only this
// copy's engines, so an action that needs the GPU while such an engine runs is
// refused with a 409 whose detail names it:
//
//   { state: "engine_elsewhere", engines: [{ pid, args, owner }], message }
//
// (backend/modules/magenta/sidecar.py elsewhere_detail). /api/magenta/engine/
// status carries the same object as `blocked` after a queued start met one,
// and /engine/stop lists the engines still running in `survivors` and
// `left_running`. This module turns each of those into one card: it names the
// engine, and its action asks for confirmation before POST
// /api/magenta/engine/stop-process ends that pid.
import { dismissFeatureGate, requireFeature } from '../notices/featureGateStore';
import { logError, logInfo, logWarn } from '../state/logStore';
import { postStatus } from '../state/statusNoticeStore';

export const MAGENTA_ELSEWHERE_GATE_ID = 'magenta:elsewhere';
export const MAGENTA_ELSEWHERE_CONFIRM_ID = 'magenta:elsewhere-confirm';

export interface MagentaEngineProcess {
  pid: number;
  /** The process's argument line on the engine side (WSL on Windows). */
  args: string;
  /** "this": this copy's engine that would not stop; "other": anyone else's. */
  owner: 'this' | 'other';
}

export interface MagentaElsewhereDetail {
  state: 'engine_elsewhere';
  engines: MagentaEngineProcess[];
  message: string;
}

function isEngineProcess(value: unknown): value is MagentaEngineProcess {
  const v = value as Partial<MagentaEngineProcess> | null;
  return !!v && typeof v === 'object' && typeof v.pid === 'number' && typeof v.args === 'string';
}

function asEngines(value: unknown): MagentaEngineProcess[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isEngineProcess).map((e) => ({ ...e, owner: e.owner === 'this' ? 'this' : 'other' }));
}

/**
 * The engine_elsewhere detail in a response body: a FastAPI error body
 * (`{detail: {...}}`), an /engine/status reply (`{blocked: {...}}`), or the
 * detail itself. Null for anything else.
 */
export function readEngineElsewhere(body: unknown): MagentaElsewhereDetail | null {
  if (!body || typeof body !== 'object') return null;
  const outer = body as { detail?: unknown; blocked?: unknown };
  const candidates = [outer.detail, outer.blocked, body];
  for (const c of candidates) {
    const d = c as Partial<MagentaElsewhereDetail> | null | undefined;
    if (d && typeof d === 'object' && d.state === 'engine_elsewhere') {
      const engines = asEngines(d.engines);
      if (engines.length === 0) continue;
      return { state: 'engine_elsewhere', engines, message: typeof d.message === 'string' ? d.message : '' };
    }
  }
  return null;
}

/** The engines still running after an /engine/stop: this copy's survivors, then everyone else's. */
export function enginesLeftRunning(stopReply: unknown): MagentaEngineProcess[] {
  const r = stopReply as { survivors?: unknown; left_running?: unknown } | null;
  if (!r || typeof r !== 'object') return [];
  return [...asEngines(r.survivors), ...asEngines(r.left_running)];
}

/**
 * The checkout folder an engine runs from, read from its arguments: the part
 * of the script path before "/sidecars/" ("/mnt/g/Users/me/Dev/theDAW"). The
 * whole argument line when no such path is in it.
 */
export function engineFolder(args: string): string {
  const m = /(\S+?)\/sidecars\//.exec(args.replace(/\\/g, '/'));
  return m ? m[1] : args;
}

/** "pid 202 (/mnt/g/Users/me/Dev/theDAW)", joined with "; " for several. */
export function describeEngines(engines: MagentaEngineProcess[]): string {
  return engines.map((e) => `pid ${e.pid} (${engineFolder(e.args)})`).join('; ');
}

/**
 * Raise the card for engines that keep running. `blocked` says what they
 * prevent ("Stable Audio cannot load beside it."). The full backend message
 * goes to the LOG; the card names the engines and offers to stop them.
 */
export function raiseMagentaElsewhereGate(detail: MagentaElsewhereDetail, blocked: string): void {
  const who = detail.engines.some((e) => e.owner === 'other')
    ? 'A Magenta engine another copy of theDAW started is running'
    : 'This copy’s Magenta engine did not stop';
  logWarn('magenta', detail.message || `${who}: ${describeEngines(detail.engines)}. ${blocked}`);
  requireFeature({
    id: MAGENTA_ELSEWHERE_GATE_ID,
    kind: 'error',
    title: 'Another Magenta engine holds the GPU',
    message: `${who}: ${describeEngines(detail.engines)}. ${blocked}`,
    action: { label: 'Stop that engine', run: () => askToStop(detail.engines) },
  });
}

function askToStop(engines: MagentaEngineProcess[]): void {
  const pids = engines.map((e) => e.pid).join(', ');
  requireFeature({
    id: MAGENTA_ELSEWHERE_CONFIRM_ID,
    kind: 'error',
    title: `Stop pid ${pids}?`,
    message: `This ends the Magenta engine in ${engines.map((e) => engineFolder(e.args)).join(', ')}. A take it is making for that copy of theDAW stops with it.`,
    action: { label: 'Yes, stop it', run: () => stopMagentaEngineProcesses(engines) },
  });
}

/**
 * POST /api/magenta/engine/stop-process for each engine. Throws on the first
 * refusal, so the confirmation card stays up for another try.
 */
export async function stopMagentaEngineProcesses(engines: MagentaEngineProcess[]): Promise<void> {
  for (const e of engines) {
    const r = await fetch('/api/magenta/engine/stop-process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: e.pid }),
    });
    const body = (await r.json().catch(() => null)) as { detail?: unknown; stopped?: boolean } | null;
    if (!r.ok || !body?.stopped) {
      const reason =
        typeof body?.detail === 'string' ? body.detail : r.ok ? 'it was still running after SIGKILL' : `HTTP ${r.status}`;
      logError('magenta', `Could not stop the Magenta engine at pid ${e.pid}: ${reason}`);
      throw new Error(reason);
    }
    logInfo('magenta', `Stopped the Magenta engine at pid ${e.pid} (${engineFolder(e.args)})`);
  }
  dismissFeatureGate(MAGENTA_ELSEWHERE_GATE_ID);
  postStatus(`MAGENTA ENGINE STOPPED: ${describeEngines(engines)}`, { source: 'magenta', level: 'info', logged: true });
  requireFeature({
    id: 'magenta:elsewhere-stopped',
    kind: 'success',
    title: 'Engine stopped',
    message: 'The GPU is free of it. Run your action again.',
    autoDismissMs: 6000,
  });
}

/**
 * For callers holding a failed response body: raise the card and return true
 * when the body is an engine_elsewhere refusal, else return false.
 */
export function handleEngineElsewhere(body: unknown, blocked: string): boolean {
  const detail = readEngineElsewhere(body);
  if (!detail) return false;
  raiseMagentaElsewhereGate(detail, blocked);
  return true;
}
