/**
 * Audima Sway -> theDAW control-surface mirror.
 *
 * The "Audima Labs The Sway" Ableton Remote Script maps the physical controller
 * to a fixed set of MIDI messages (decoded from its compiled MIDI.py):
 *   - Play button : Note 0   on ch 1 (0-indexed 0)   -> transport play/stop
 *   - 8 volume    : CC 1-8   on ch 1                  -> track volume
 *   - 8 pan       : CC 9-16  on ch 1                  -> track pan
 *   - 16 pads     : Notes 24-39 on ch 16 (0-indexed 15) -> pads (selectable mode)
 *
 * When DAW-control mode is on (useSwaySurfaceStore) this subscribes to the global
 * MIDI bus and applies that map to theDAW's EDIT timeline: transport, a
 * selection-following bank of 8 mixer strips, and the pads. It mirrors how the
 * controller drives Ableton. This is distinct from the expressive-dimension
 * `swayBus`, which reads the same device's CCs as learnable 0..1 signals; the two
 * are different ways to use the one controller, chosen by the DAW-control toggle.
 *
 * The mirror stands down while PERFORM or the SWAY tab is the open view: PERFORM
 * launches scenes and clips from the same controller and the SWAY tab hands it to
 * the cockpit, so a pad there must not also sound a General MIDI note, nor the
 * Play button and faders reach an EDIT timeline nobody is looking at. A pad the
 * mirror holds when either tab opens is released. The Sway's pad and Play notes
 * stay the controller's while it stands down (`swaySurfaceConsumes`), so the
 * keyboard monitor does not sound them either.
 */
import { subscribeToMidi, type MidiBusMessage } from './midiBus';
import { useEditorStore, type EditorTrack } from './editorStore';
import { callEditorPlay, callEditorStop } from './editorPlaybackBridge';
import { isPlaying as liveMixerIsPlaying } from './liveMixer';
import { getSelectedTracks } from './editorSelectionBridge';
import { triggerPianoNoteFromMidi } from '../lib/pianoTrigger';
import {
  ensureSoundfontReady,
  getGlobalVoice,
  isLiveSynthReady,
  liveNoteOn,
  liveNoteOff,
} from '../lib/soundfontEngine';
import { PAD_LO, swayPadVoice } from '../lib/swayPadVoice';
import { isSwaySurfaceEnabled, getSwayPadMode, isSwaySustain } from './swaySurfaceStore';
import { useAppUiStore, type CenterTab } from './appUiStore';

// --- The decoded "The Sway" MIDI map (channels are 0-indexed here) ---------- //
const PLAY_NOTE = 0;
const BUTTON_CH = 0; // channel for the Play button
const SLIDER_CH = 0; // channel for the volume / pan CCs
const PAD_CH = 15; // channel for the 16 pads (PADCHANNEL = 15)
const TRACKVOL_CC = [1, 2, 3, 4, 5, 6, 7, 8];
const TRACKPAN_CC = [9, 10, 11, 12, 13, 14, 15, 16];
const PAD_HI = 39; // inclusive -> 16 pads (from lib/swayPadVoice PAD_LO)
const BANK_SIZE = 8;

// Held pad voices, so note-off releases exactly what note-on started (and a held
// pad sustains until release). null = a fallback piano one-shot with nothing to
// release. Keyed by pad index; survives a pad-mode change mid-hold.
const padVoices = new Map<number, { channel: number; note: number } | null>();

/** The tabs that own the Sway while they are open: PERFORM ('session') and SWAY. */
const STAND_DOWN_TABS: ReadonlySet<CenterTab> = new Set<CenterTab>(['session', 'sway']);

/** True while PERFORM or the SWAY tab is the open view. */
const standsDown = (): boolean => STAND_DOWN_TABS.has(useAppUiStore.getState().centerTab);

/** What the pads sound through. */
export interface SwaySurfaceDeps {
  liveSynthReady: () => boolean;
  warmSoundfont: () => void;
  /** The built-in piano, for a pad pressed before the soundfont synth is live. */
  oneShot: (note: number, velocity: number) => void;
  noteOn: (channel: number, program: number, note: number, velocity: number) => void;
  noteOff: (channel: number, note: number) => void;
}

const SOUNDFONT_PADS: SwaySurfaceDeps = {
  liveSynthReady: isLiveSynthReady,
  warmSoundfont: () => { void ensureSoundfontReady(); },
  oneShot: (note, velocity) => triggerPianoNoteFromMidi(note, velocity),
  noteOn: liveNoteOn,
  noteOff: liveNoteOff,
};

let pads: SwaySurfaceDeps = SOUNDFONT_PADS;

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const clampPan = (v: number): number => Math.max(-1, Math.min(1, v));

/** The selection-following bank: tracks[start..start+7], paged to the selected
 *  track so banks of 8 are reachable beyond the first eight. */
function bankView(): { tracks: EditorTrack[]; start: number } {
  const tracks = useEditorStore.getState().tracks;
  const sel = getSelectedTracks();
  let selIdx = 0;
  if (sel.length) {
    const i = tracks.findIndex((t) => t.id === sel[0]);
    if (i >= 0) selIdx = i;
  }
  return { tracks, start: Math.floor(selIdx / BANK_SIZE) * BANK_SIZE };
}

function setBankTrack(stripIdx: number, updates: Partial<EditorTrack>): void {
  const { tracks, start } = bankView();
  const t = tracks[start + stripIdx];
  if (t) useEditorStore.getState().updateTrack(t.id, updates);
}

function toggleTransport(): void {
  // Ask the engine, not editorStore.isPlaying — that field has no writer anywhere
  // in the app (setPlaying has zero callers), so it reads false forever and the
  // hardware Play button could only ever start playback, never stop it.
  if (liveMixerIsPlaying()) callEditorStop();
  else callEditorPlay();
}

/** The selected EDIT track, else the first one. */
function selectedTrack(): EditorTrack | undefined {
  const tracks = useEditorStore.getState().tracks;
  const sel = getSelectedTracks();
  return sel.length ? tracks.find((x) => x.id === sel[0]) : tracks[0];
}

function padOn(padIdx: number, velocity: number): void {
  const sustain = isSwaySustain();
  // Sustain (latch): a second press on a held pad releases it; melodic drums
  // aside, the note rings until then.
  if (sustain && padVoices.get(padIdx)) {
    padRelease(padIdx);
    return;
  }
  if (!sustain) padRelease(padIdx); // retrigger safety when not latching

  const mode = getSwayPadMode();
  const vel = Math.max(1, Math.min(127, velocity));
  // Until the soundfont synth is live, fall back to the built-in piano one-shot
  // (no sustain) and warm the soundfont so the next hit can hold.
  if (!pads.liveSynthReady()) {
    pads.warmSoundfont();
    pads.oneShot(PAD_LO + padIdx, vel);
    padVoices.set(padIdx, null);
    return;
  }
  // Drums, the selected track's voice (its kit on a drum track) or the piano;
  // a melodic pad plays a sustaining organ while sustain latches (lib/swayPadVoice).
  const { channel, program, note } = swayPadVoice(mode, padIdx, sustain, mode === 'track' ? selectedTrack() : null, getGlobalVoice());
  // Note-on now; with sustain off, note-off on release; with sustain on, the note
  // is latched and only released by the next press on this pad.
  pads.noteOn(channel, program, note, vel);
  padVoices.set(padIdx, { channel, note });
}

/** Release a pad's held voice immediately, regardless of latch state. */
function padRelease(padIdx: number): void {
  const v = padVoices.get(padIdx);
  if (v) pads.noteOff(v.channel, v.note);
  padVoices.delete(padIdx);
}

/** Release every pad the mirror holds, latched ones included. */
function releaseAllPads(): void {
  for (const padIdx of [...padVoices.keys()]) padRelease(padIdx);
}

function padOff(padIdx: number): void {
  // When sustain (latch) is on, ignore the physical release — the note is held
  // until the pad is pressed again (handled in padOn).
  if (isSwaySustain()) return;
  padRelease(padIdx);
}

function handle(msg: MidiBusMessage): void {
  if (!isSwaySurfaceEnabled()) return;
  // PERFORM and the SWAY tab own the controller while they are open.
  if (standsDown()) return;
  const data = msg.data;
  const status = data[0] ?? 0;
  const cmd = status & 0xf0;
  const ch = status & 0x0f;
  const d1 = data[1] ?? 0;
  const d2 = data[2] ?? 0;

  // Volume / pan CCs on the slider channel.
  if (cmd === 0xb0 && ch === SLIDER_CH) {
    const volIdx = TRACKVOL_CC.indexOf(d1);
    if (volIdx >= 0) {
      setBankTrack(volIdx, { volume: clamp01(d2 / 127) });
      return;
    }
    const panIdx = TRACKPAN_CC.indexOf(d1);
    if (panIdx >= 0) {
      setBankTrack(panIdx, { pan: clampPan((d2 - 64) / 63) });
    }
    return;
  }

  // Play button (note-on) -> toggle transport.
  if (cmd === 0x90 && d2 > 0 && ch === BUTTON_CH && d1 === PLAY_NOTE) {
    toggleTransport();
    return;
  }

  // Pads.
  if (ch === PAD_CH && d1 >= PAD_LO && d1 <= PAD_HI) {
    const padIdx = d1 - PAD_LO;
    if (cmd === 0x90 && d2 > 0) padOn(padIdx, d2);
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) padOff(padIdx);
  }
}

/**
 * Whether the Sway surface (when enabled) consumes this note message, so the
 * caller can suppress the default piano-synth trigger for the Play button and
 * pads. CCs are not piano-triggering, so they are not reported here. True
 * while the mirror stands down for PERFORM or the SWAY tab too: the pads and
 * Play belong to that view then, and are no keys for the keyboard monitor.
 */
export function swaySurfaceConsumes(data: Uint8Array | number[]): boolean {
  if (!isSwaySurfaceEnabled()) return false;
  const status = Number(data[0]) | 0;
  const cmd = status & 0xf0;
  const ch = status & 0x0f;
  const d1 = Number(data[1]) | 0;
  if (cmd === 0x90 || cmd === 0x80) {
    if (ch === BUTTON_CH && d1 === PLAY_NOTE) return true;
    if (ch === PAD_CH && d1 >= PAD_LO && d1 <= PAD_HI) return true;
  }
  return false;
}

let _unsub: (() => void) | null = null;

/** Start mirroring the Sway control surface onto theDAW. Idempotent; returns a
 *  stop function. Runs for the MIDI session; the per-message handler no-ops when
 *  DAW-control mode is off, so it is safe to leave subscribed. `deps` is a seam
 *  for tests; the app passes none and the pads play the soundfont. */
export function startSwaySurface(deps: SwaySurfaceDeps = SOUNDFONT_PADS): () => void {
  if (_unsub) return _unsub;
  pads = deps;
  if (isSwaySurfaceEnabled()) pads.warmSoundfont();
  const off = subscribeToMidi(handle);
  // A pad held (or latched) when PERFORM or the SWAY tab opens would otherwise
  // ring until pressed again, and that press no longer reaches the mirror.
  const offTabs = useAppUiStore.subscribe((state, prev) => {
    if (state.centerTab !== prev.centerTab && STAND_DOWN_TABS.has(state.centerTab)) releaseAllPads();
  });
  _unsub = () => {
    off();
    offTabs();
    releaseAllPads();
    pads = SOUNDFONT_PADS;
    _unsub = null;
  };
  return _unsub;
}
