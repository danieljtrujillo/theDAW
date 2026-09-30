/**
 * Quest MIDI bridge status: who has the headset, for Settings → Inputs &
 * outputs and the LOG.
 *
 * The backend `questmidi` module leaves the headset with another program that
 * already serves its port (the standalone Node bridge, another theDAW,
 * anything listening on the headset's port here) and names that program as
 * `headset_holder`. Only the user's Take over (`POST /api/questmidi/takeover`)
 * moves the headset to theDAW.
 *
 * The status arrives two ways: the bridge WebSocket opens with a status frame
 * and sends another whenever the status changes (questMidiClient.ts), and the
 * Settings row fetches `GET /api/questmidi/status` when it mounts or rescans,
 * and every QUEST_MIDI_POLL_MS while it is open and the socket is not. A holder
 * that was not there before posts one notice to the LOG and the orb bubble.
 */
import { create } from 'zustand';
import { pairingHeader } from '../lib/pairing';
import { postStatus } from './statusNoticeStore';

export interface QuestMidiHolder {
  /** 0 when the backend sees the port taken but cannot name the process
   *  (the OS keeps the listening table from it). */
  pid: number;
  /** Process name as the OS reports it; 'another program' when unknown. */
  name: string;
  /** The port on this PC the holder listens on. */
  port: number;
  /** Another theDAW backend. */
  thedaw: boolean;
  /** The headset's own adb mapping names the holder. False: it listens on the
   *  headset's port number here, where a one-to-one bridge maps the headset. */
  mapped: boolean;
}

export interface QuestMidiStatus {
  started: boolean;
  /** The port the headset dials (theDAW_QUESTMIDI_PORT). */
  devicePort: number;
  /** The port theDAW's listener is bound to on this PC. */
  hostPort: number | null;
  adbFound: boolean;
  adbReverseOk: boolean;
  questConnected: boolean;
  holder: QuestMidiHolder | null;
  tookOver: boolean;
}

export type QuestMidiState = 'off' | 'held' | 'connected' | 'ready' | 'waiting';

export const QUEST_MIDI_STATE_WORD: Record<QuestMidiState, string> = {
  off: 'Off',
  held: 'Held',
  connected: 'Connected',
  ready: 'Ready',
  waiting: 'Waiting',
};

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const asPort = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535 ? v : null;

export function normalizeQuestMidiHolder(raw: unknown): QuestMidiHolder | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = asRecord(raw);
  const port = asPort(r.port);
  if (typeof r.pid !== 'number' || port === null) return null;
  return {
    pid: r.pid,
    name: typeof r.name === 'string' && r.name ? r.name : 'another program',
    port,
    thedaw: r.thedaw === true,
    mapped: r.mapped === true,
  };
}

/** The backend's status dict (GET /status, or the WebSocket's status frame). */
export function normalizeQuestMidiStatus(raw: unknown): QuestMidiStatus {
  const r = asRecord(raw);
  return {
    started: r.started === true,
    devicePort: asPort(r.device_port) ?? asPort(r.port) ?? 8765,
    hostPort: asPort(r.host_port),
    adbFound: typeof r.adb_path === 'string' && r.adb_path.length > 0,
    adbReverseOk: r.adb_reverse_ok === true,
    questConnected: r.quest_connected === true,
    holder: normalizeQuestMidiHolder(r.headset_holder),
    tookOver: r.took_over === true,
  };
}

export function questMidiState(status: QuestMidiStatus | null): QuestMidiState {
  if (!status || !status.started) return 'off';
  if (status.holder) return 'held';
  if (status.questConnected) return 'connected';
  if (status.adbReverseOk) return 'ready';
  return 'waiting';
}

export function questMidiHolderName(holder: QuestMidiHolder): string {
  if (holder.thedaw) return `another theDAW (pid ${holder.pid})`;
  return holder.pid > 0 ? `${holder.name} (pid ${holder.pid})` : holder.name;
}

/** What the Settings row says about the holder. */
export function questMidiHolderSentence(holder: QuestMidiHolder, devicePort: number): string {
  const who = questMidiHolderName(holder);
  const where = holder.mapped
    ? `has the headset: its port ${devicePort} is mapped to port ${holder.port} on this PC.`
    : `listens on port ${devicePort} here, the port the headset dials.`;
  return `${who} ${where} theDAW leaves the headset with it until you press Take over.`;
}

/** The LOG / orb notice for a holder that was not there before. */
export function questMidiHolderNotice(holder: QuestMidiHolder, devicePort: number): string {
  return (
    `QUEST MIDI HELD: ${questMidiHolderName(holder)} serves port ${devicePort}, the port the ` +
    'headset dials. Take over is in Settings, Inputs & outputs.'
  );
}

// One program, one notice: the same identity the backend's Take over consent
// uses (_consent_key), so a program that goes from listening on the port to
// mapping the headset is not announced twice.
const holderKey = (h: QuestMidiHolder | null): string => {
  if (!h) return '';
  return h.pid > 0 ? `pid ${h.pid}:${h.name}` : `port ${h.port}`;
};

const errText = async (res: Response): Promise<string> => {
  if (res.status === 404) return 'The Quest MIDI module is off (Settings, Modules).';
  try {
    const detail = asRecord(await res.clone().json()).detail;
    if (typeof detail === 'string' && detail) return detail;
  } catch {
    /* not json */
  }
  return `Request failed (HTTP ${res.status})`;
};

export type QuestMidiBusy = 'refresh' | 'takeover' | 'reattach' | null;

/** How often the open Settings row re-reads the status while the bridge
 *  WebSocket, which pushes changes, is closed (MIDI off, or reconnecting). */
export const QUEST_MIDI_POLL_MS = 10_000;

interface QuestMidiStatusStore {
  status: QuestMidiStatus | null;
  error: string | null;
  busy: QuestMidiBusy;
  /** Take a status dict from the backend. */
  apply: (raw: unknown) => void;
  /** Fetch GET /status. `quiet` (the Settings row's timer) leaves `busy`
   *  alone, so the buttons do not flicker on every poll. */
  refresh: (opts?: { quiet?: boolean }) => Promise<void>;
  /** The user's Take over: move the headset to theDAW from its holder. */
  takeOver: () => Promise<void>;
  /** Run adb reverse again after plugging the headset in. */
  reattach: () => Promise<void>;
}

// The holder the last notice was about, so a reconnect or a rescan that finds
// the same program posts nothing new.
let notifiedHolder = '';

export const useQuestMidiStatusStore = create<QuestMidiStatusStore>()((set, get) => {
  const post = async (route: 'takeover' | 'reattach'): Promise<void> => {
    set({ busy: route, error: null });
    try {
      const res = await fetch(`/api/questmidi/${route}`, { method: 'POST', headers: pairingHeader() });
      if (!res.ok) throw new Error(await errText(res));
      get().apply(await res.json());
    } catch (e) {
      set({ error: e instanceof Error ? e.message : 'The Quest MIDI bridge did not answer.' });
    } finally {
      set({ busy: null });
    }
  };

  return {
    status: null,
    error: null,
    busy: null,
    apply: (raw) => {
      const status = normalizeQuestMidiStatus(raw);
      const key = holderKey(status.holder);
      if (status.holder && key !== notifiedHolder) {
        postStatus(questMidiHolderNotice(status.holder, status.devicePort), {
          source: 'questmidi',
          level: 'warn',
        });
      }
      notifiedHolder = key;
      set({ status, error: null });
    },
    refresh: async (opts) => {
      const quiet = opts?.quiet === true;
      if (!quiet) set({ busy: 'refresh' });
      try {
        const res = await fetch('/api/questmidi/status', { cache: 'no-store', headers: pairingHeader() });
        if (!res.ok) throw new Error(await errText(res));
        get().apply(await res.json());
      } catch (e) {
        set({ status: null, error: e instanceof Error ? e.message : 'The Quest MIDI bridge did not answer.' });
      } finally {
        if (!quiet) set({ busy: null });
      }
    },
    takeOver: () => post('takeover'),
    reattach: () => post('reattach'),
  };
});
