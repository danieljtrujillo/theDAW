/**
 * The single owner of "which device".
 *
 * Before this store there were three device preferences and no agreement
 * between them: the MIDI tab and the SING pitch lane both persisted the key
 * `vocal.inputDeviceId` into two React states that never reconciled in-session,
 * and the DJ cue output persisted nowhere at all, resetting to the system
 * default on every reload. Nothing subscribed to `devicechange`, so plugging an
 * interface in never updated any list.
 *
 * What lives here: the LIVE device world (enumerated lists, permission state,
 * runtime capabilities) and the apply layer. What does NOT live here: the
 * choices themselves — those are in the backend settings store's `io` section
 * (featureToggleStore), because the same user opens theDAW as a browser tab AND
 * as the desktop app, which are two origins with two localStorage partitions.
 *
 * The resolution rules are in lib/ioResolve, pure and tested.
 */
import { create } from 'zustand';
import {
  applyElementSink,
  refreshSinkElements,
  setSinkResolver,
  supportsContextSink,
  supportsElementSink,
} from '../lib/audioSink';
import {
  FOLLOW_GLOBAL,
  isSystemDefault,
  labelsAreKnown,
  missingNoticeId,
  overrideFromSelect,
  resolveRef,
  resolveSlot,
  type DeviceRef,
  type IoKind,
  type LiveDevice,
  type Resolved,
} from '../lib/ioResolve';
import { normalizeMidiInputConfig, type MidiInputConfig } from '../lib/midiPortFilter';
import { dismissFeatureGate, requireFeature } from '../notices/featureGateStore';
import {
  DEFAULT_FEATURE_SETTINGS,
  useFeatureToggleStore,
  type IoSettings,
} from './featureToggleStore';
import { logInfo, logWarn } from './logStore';
import { midiOutDevices, setMidiThruTarget } from './midiOutBus';
import { setEngineSink } from './playerStore';
import { GLOBAL_SLOT_FOR_KIND, IO_SURFACES, surfaceById, type SurfaceId } from './ioSurfaces';

export type { DeviceRef, LiveDevice, Resolved } from '../lib/ioResolve';
export { FOLLOW_GLOBAL } from '../lib/ioResolve';

/** The global slots, named exactly as they are persisted. */
export type IoSlot =
  | 'audio_output'
  | 'cue_output'
  | 'audio_input'
  | 'midi_output'
  | 'visual_display';

const SLOT_KIND: Record<IoSlot, IoKind> = {
  audio_output: 'audioOut',
  cue_output: 'audioOut',
  audio_input: 'audioIn',
  midi_output: 'midiOut',
  visual_display: 'display',
};

interface IoDevicesState {
  audioOut: LiveDevice[];
  audioIn: LiveDevice[];
  midiIn: LiveDevice[];
  midiOut: LiveDevice[];
  display: LiveDevice[];
  /**
   * False until a getUserMedia has resolved once: enumerateDevices() returns
   * blank labels before that, and a list of blanks must never be rendered as a
   * dropdown (it used to render as "Input 4f2a1b" and three rows of "Output").
   */
  labelsKnown: boolean;
  /** True once enumerateDevices has returned at least once. */
  enumerated: boolean;
  micPermission: PermissionState | 'unknown';
  supports: {
    /** Move the whole shared graph — Chromium 110+. */
    ctxSink: boolean;
    /** Move one <audio> element — the DJ cue and the loose previews. */
    elementSink: boolean;
    enumerate: boolean;
    midi: boolean;
    /** Electron only: position a pop-out on a chosen monitor. */
    displays: boolean;
  };
  refresh: () => Promise<void>;
  refreshDisplays: () => Promise<void>;
  /** Call from the resolved branch of every getUserMedia: labels exist now. */
  notePermissionGranted: () => void;
  /** App.tsx publishes the Web MIDI port lists here. */
  setMidiPorts: (inputs: LiveDevice[]) => void;
}

const byKind = (s: IoDevicesState, kind: IoKind): LiveDevice[] => s[kind];

export const useIoDevicesStore = create<IoDevicesState>()((set, get) => ({
  audioOut: [],
  audioIn: [],
  midiIn: [],
  midiOut: [],
  display: [],
  labelsKnown: false,
  enumerated: false,
  micPermission: 'unknown',
  supports: {
    ctxSink: false,
    elementSink: false,
    enumerate: false,
    midi: false,
    displays: false,
  },

  refresh: async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
    let all: MediaDeviceInfo[] = [];
    try {
      all = await navigator.mediaDevices.enumerateDevices();
    } catch (e) {
      logWarn('audio', `Device list unavailable: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const pick = (kind: MediaDeviceKind): LiveDevice[] =>
      all
        .filter((d) => d.kind === kind)
        .map((d) => ({ id: d.deviceId, label: d.label }))
        // The blank placeholder Chrome returns pre-permission is not a device.
        .filter((d) => d.id !== '' || d.label !== '');
    const audioOut = pick('audiooutput');
    const audioIn = pick('audioinput');
    set({
      audioOut,
      audioIn,
      enumerated: true,
      labelsKnown: labelsAreKnown([...audioIn, ...audioOut]),
    });
    void queryMicPermission().then((micPermission) => set({ micPermission }));
    // Labels may have just become readable, which is the condition the legacy
    // mic adoption waits on.
    adoptLegacyMic();
    syncResolution();
  },

  refreshDisplays: async () => {
    const api = (window as unknown as { electronAPI?: { listDisplays?: () => Promise<Array<{ id: string; label: string }>> } })
      .electronAPI;
    if (!api?.listDisplays) return;
    try {
      const list = await api.listDisplays();
      set({ display: list.map((d) => ({ id: d.id, label: d.label })) });
    } catch (e) {
      logWarn('vj', `Display list unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  notePermissionGranted: () => {
    set({ micPermission: 'granted' });
    void get().refresh();
  },

  setMidiPorts: (inputs) => {
    set({ midiIn: inputs, midiOut: midiOutDevices() });
    syncResolution();
  },
}));

/** Current mic permission, or 'unknown' where the Permissions API is absent. */
async function queryMicPermission(): Promise<PermissionState | 'unknown'> {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return p.state;
  } catch {
    return 'unknown';
  }
}

/* ── reading the choices ──────────────────────────────────────────────────── */

export const ioSettings = (): IoSettings =>
  useFeatureToggleStore.getState().settings.io ?? DEFAULT_FEATURE_SETTINGS.io;

export const midiInputConfig = (): MidiInputConfig =>
  normalizeMidiInputConfig(ioSettings().midi_inputs);

/** The live list for a device family. */
export const liveDevices = (kind: IoKind): LiveDevice[] => byKind(useIoDevicesStore.getState(), kind);

/**
 * Is the live list for this family authoritative enough to declare a saved
 * device "gone"?
 *
 * Audio: not until a getUserMedia has resolved, because every label is blank
 * before that. MIDI and displays: their entries always carry a name, but an
 * EMPTY list means nothing has been enumerated — MIDI is opt-in and off by
 * default, and a browser has no display API — so an empty list is "we cannot
 * tell", never "your device is missing". Getting this wrong shows a scary
 * notice to a user who simply has MIDI switched off.
 */
const labelsKnownFor = (kind: IoKind): boolean =>
  kind === 'audioIn' || kind === 'audioOut'
    ? useIoDevicesStore.getState().labelsKnown
    : liveDevices(kind).length > 0;

/** Resolve one global slot against the live world. */
export function resolveGlobal(slot: IoSlot): Resolved {
  const kind = SLOT_KIND[slot];
  return resolveSlot({
    global: ioSettings()[slot],
    live: liveDevices(kind),
    labelsKnown: labelsKnownFor(kind),
  });
}

/** Resolve one surface: its own override, else the global slot, else the OS. */
export function resolveSurface(surface: SurfaceId): Resolved {
  const def = surfaceById(surface);
  const kind: IoKind = def?.kind ?? 'audioIn';
  const io = ioSettings();
  return resolveSlot({
    override: io.overrides?.[surface],
    global: io[GLOBAL_SLOT_FOR_KIND[def?.kind ?? 'audioIn']],
    live: liveDevices(kind),
    labelsKnown: labelsKnownFor(kind),
  });
}

/** The deviceId a surface should open right now ('' = the OS default). */
export const surfaceDeviceId = (surface: SurfaceId): string => resolveSurface(surface).deviceId;

/** `undefined` when the surface follows its global slot. */
export const surfaceOverride = (surface: SurfaceId): DeviceRef | undefined =>
  ioSettings().overrides?.[surface];

/* ── writing the choices ──────────────────────────────────────────────────── */

const patchIo = (part: Partial<IoSettings>): Promise<boolean> =>
  useFeatureToggleStore.getState().patch({ io: part });

/**
 * Set a global slot. Always writes the COMPLETE {id,label} object: the backend
 * store assigns a dict-valued key wholesale rather than deep-merging, so a
 * fragment would replace the slot and drop the label that makes the choice
 * survive an id rotation.
 */
export const setGlobalDevice = async (slot: IoSlot, ref: DeviceRef): Promise<boolean> => {
  const ok = await patchIo({ [slot]: { id: ref.id ?? '', label: ref.label ?? '' } } as Partial<IoSettings>);
  if (ok) applyAll();
  return ok;
};

/** Build a ref from a `<select>` value against the live list for that slot. */
export const deviceRefFromId = (slot: IoSlot, id: string): DeviceRef => {
  const hit = liveDevices(SLOT_KIND[slot]).find((d) => d.id === id);
  return { id, label: id ? (hit?.label ?? '') : '' };
};

/** `null` removes the override so the surface follows its global slot again. */
export const setSurfaceOverride = async (
  surface: SurfaceId,
  ref: DeviceRef | null,
): Promise<boolean> => {
  const next = { ...(ioSettings().overrides ?? {}) };
  if (ref === null) delete next[surface];
  else next[surface] = { id: ref.id ?? '', label: ref.label ?? '' };
  // `overrides` is replaced wholesale, which is exactly what makes a deletion
  // stick — a deep merge here would resurrect the entry we just dropped.
  const ok = await patchIo({ overrides: next });
  if (ok) applyAll();
  return ok;
};

/** Set an override straight from a `<select>` value (FOLLOW_GLOBAL / '' / id). */
export const setSurfaceOverrideFromSelect = (surface: SurfaceId, value: string): Promise<boolean> => {
  const def = surfaceById(surface);
  return setSurfaceOverride(surface, overrideFromSelect(value, liveDevices(def?.kind ?? 'audioIn')));
};

export const setMidiInputSelection = async (cfg: MidiInputConfig): Promise<boolean> => {
  const ok = await patchIo({ midi_inputs: { mode: cfg.mode, ports: cfg.ports } });
  if (ok) applyAll();
  return ok;
};

/* ── notices: a chosen device that is not there ───────────────────────────── */

/** Notice ids currently raised, so one absent device cannot stack cards. */
const raised = new Set<string>();
/** Refs whose id rotation we have already tried to re-persist. See below. */
const rewriteAttempted = new Set<string>();
let syncing = false;

function noticeFor(kind: IoKind, ref: DeviceRef, where: string): void {
  const id = missingNoticeId(kind, ref);
  if (raised.has(id)) return;
  raised.add(id);
  requireFeature({
    id,
    kind: 'error',
    title: 'Device not connected',
    message: `${ref.label || ref.id} is not connected — ${where} is using the system default. The choice is kept, so plugging it back in restores it.`,
    action: {
      label: 'Open Settings',
      run: () => {
        window.dispatchEvent(new CustomEvent('thedaw:open-settings'));
      },
    },
    docsHint: 'Settings → Inputs & outputs',
  });
}

function clearNotice(kind: IoKind, ref: DeviceRef): void {
  const id = missingNoticeId(kind, ref);
  if (!raised.delete(id)) return;
  dismissFeatureGate(id);
}

/**
 * Re-check every choice against the live world: raise a notice for anything
 * that has gone missing, clear the notice when it comes back, and re-persist a
 * ref whose id rotated but whose label still matches.
 *
 * Never called during render — it writes to two stores.
 */
export function syncResolution(): void {
  if (syncing) return;
  syncing = true;
  try {
    const io = ioSettings();
    const check = (kind: IoKind, ref: DeviceRef | undefined, where: string, rewrite: (r: DeviceRef) => void) => {
      if (!ref || isSystemDefault(ref)) return;
      const r = resolveRef(ref, liveDevices(kind), labelsKnownFor(kind));
      if (r.source === 'missing') noticeFor(kind, ref, where);
      else clearNotice(kind, ref);
      if (r.rewrite && !rewriteAttempted.has(missingNoticeId(kind, ref))) {
        // Once per ref per session. A failed PATCH rolls the settings back to
        // the OLD id, which lands here again through the store subscription —
        // without this the pair would spin a fetch loop against a backend that
        // is down (the Restart server button in this very modal does that).
        rewriteAttempted.add(missingNoticeId(kind, ref));
        logInfo('audio', `${r.label} came back with a new device id; the saved choice was updated.`);
        rewrite(r.rewrite);
      }
    };

    check('audioOut', io.audio_output, 'the main output', (r) => void setGlobalDevice('audio_output', r));
    check('audioOut', io.cue_output, 'the DJ headphone cue', (r) => void setGlobalDevice('cue_output', r));
    check('audioIn', io.audio_input, 'the microphone', (r) => void setGlobalDevice('audio_input', r));
    check('midiOut', io.midi_output, 'MIDI thru', (r) => void setGlobalDevice('midi_output', r));
    for (const surface of IO_SURFACES) {
      check(surface.kind, io.overrides?.[surface.id], surface.label, (r) =>
        void setSurfaceOverride(surface.id, r),
      );
    }
  } finally {
    syncing = false;
  }
}

/* ── the apply layer ──────────────────────────────────────────────────────── */

let lastCueId = '';
let lastThruKey = '';

/** Push every resolved choice at the thing that actually makes the sound. */
export function applyAll(): void {
  // 1. The whole shared graph (footer transport, sequencer, decks, mixer).
  void setEngineSink(resolveGlobal('audio_output').deviceId);

  // 2. The DJ cue bus — a separate device on purpose, so pre-listen is not
  //    audible in the mains. Skipped entirely while nothing is chosen so a user
  //    who never opens the menu gets no cue bus (and no AudioContext) built.
  const cueId = resolveGlobal('cue_output').deviceId;
  if (cueId !== lastCueId) {
    const hadOne = lastCueId !== '';
    lastCueId = cueId;
    if (cueId || hadOne) {
      void import('./djEngine')
        .then((m) => m.setCueSinkId(cueId))
        .catch(() => {
          /* the DJ engine is not in this bundle yet; it applies on first use */
        });
    }
  }

  // 3. The loose <audio> elements outside the graph.
  refreshSinkElements();

  // 4. MIDI thru.
  const thru = ioSettings().midi_output ?? { id: '', label: '' };
  const key = `${thru.id}|${thru.label}`;
  if (key !== lastThruKey) {
    lastThruKey = key;
    setMidiThruTarget(thru);
  }

  syncResolution();
}

/* ── one-time migration of the old localStorage mic key ───────────────────── */

const LEGACY_MIC_KEY = 'vocal.inputDeviceId';
let migrated = false;

/**
 * The MIDI tab and the SING pitch lane both wrote this key, in two React states
 * that never reconciled. Adopt it as the GLOBAL microphone once, then leave the
 * key in place for one release as a read-only fallback so rolling the build
 * back does not lose the user's mic.
 *
 * Called from `refresh()` as well as from the settings subscription, because it
 * needs a device list whose LABELS are readable — see below.
 */
function adoptLegacyMic(): void {
  if (migrated) return;
  // Only once the BACKEND has answered: the persisted local mirror can be stale
  // on a first run in the other launch mode, and adopting against it would
  // overwrite a device the user had already chosen on the other origin.
  if (!useFeatureToggleStore.getState().loaded) return;
  const io = ioSettings();
  if (!isSystemDefault(io.audio_input)) {
    migrated = true;
    return;
  }
  let legacy = '';
  try {
    legacy = localStorage.getItem(LEGACY_MIC_KEY) ?? '';
  } catch {
    // Site data blocked. The old code read this in a useState initializer with
    // no try/catch and threw during render; this is that bug's fix.
    migrated = true;
    return;
  }
  if (!legacy) {
    migrated = true;
    return;
  }
  // Wait for a list we can actually read. The old key held a bare deviceId, and
  // a ref saved with no label cannot be recovered by label — so in the other
  // launch mode (a second origin, where that id means nothing) it would resolve
  // to 'missing' and raise a notice naming a salted hash the user has never
  // seen. Adopt the LABEL too or do not adopt at all.
  const live = liveDevices('audioIn');
  if (!labelsAreKnown(live)) return;
  migrated = true;
  const hit = live.find((d) => d.id === legacy);
  if (!hit) {
    logInfo(
      'audio',
      'The old microphone choice is no longer connected; Settings → Inputs & outputs stays on the system default.',
    );
    return;
  }
  void setGlobalDevice('audio_input', { id: hit.id, label: hit.label });
  logInfo('audio', `Adopted the old microphone choice (${hit.label}) into Settings → Inputs & outputs.`);
}

/* ── boot ─────────────────────────────────────────────────────────────────── */

let started = false;

/**
 * Start the one device-change subscription for the whole app and wire the apply
 * layer. Idempotent; App.tsx calls it once.
 */
export function startIoDevices(): void {
  if (started || typeof navigator === 'undefined') return;
  started = true;

  useIoDevicesStore.setState({
    supports: {
      ctxSink: supportsContextSink(),
      elementSink: supportsElementSink(),
      enumerate: !!navigator.mediaDevices?.enumerateDevices,
      midi: 'requestMIDIAccess' in navigator,
      displays: !!(window as unknown as { electronAPI?: { listDisplays?: unknown } }).electronAPI
        ?.listDisplays,
    },
  });

  // Loose <audio> elements ask the registry which device they belong on.
  setSinkResolver((surface) => resolveSurface(surface as SurfaceId).deviceId);

  // ONE devicechange subscription for the entire app (there were zero before),
  // so every picker follows a hot-plug at once.
  navigator.mediaDevices?.addEventListener?.('devicechange', () => {
    logInfo('audio', 'Audio devices changed');
    void useIoDevicesStore.getState().refresh();
  });

  void useIoDevicesStore.getState().refresh();
  void useIoDevicesStore.getState().refreshDisplays();

  // Re-apply whenever the choices change. The settings are read from the
  // BACKEND at boot (not only when the Settings modal opens) — that round trip
  // is what makes a device chosen in the browser build take effect in the
  // desktop app, which is the whole reason these live server-side.
  let lastIo = ioSettings();
  let lastLoaded = useFeatureToggleStore.getState().loaded;
  useFeatureToggleStore.subscribe((s) => {
    const io = s.settings.io;
    if (io === lastIo && s.loaded === lastLoaded) return;
    lastIo = io;
    lastLoaded = s.loaded;
    adoptLegacyMic();
    applyAll();
  });
  void useFeatureToggleStore.getState().refresh();
  adoptLegacyMic();
  applyAll();
}

/* ── React helpers ────────────────────────────────────────────────────────── */

/** Re-renders when either the live list or the saved choice changes. */
export function useResolvedSurface(surface: SurfaceId): Resolved {
  const def = surfaceById(surface);
  const kind: IoKind = def?.kind ?? 'audioIn';
  useIoDevicesStore((s) => byKind(s, kind));
  useIoDevicesStore((s) => s.labelsKnown);
  useFeatureToggleStore((s) => s.settings.io);
  return resolveSurface(surface);
}

export function useResolvedGlobal(slot: IoSlot): Resolved {
  useIoDevicesStore((s) => byKind(s, SLOT_KIND[slot]));
  useIoDevicesStore((s) => s.labelsKnown);
  useFeatureToggleStore((s) => s.settings.io);
  return resolveGlobal(slot);
}

/** Point one element at its surface's output and keep it there. */
export const followSurfaceSink = (surface: SurfaceId, el: HTMLMediaElement | null): void => {
  if (el) void applyElementSink(el, resolveSurface(surface).deviceId);
};
