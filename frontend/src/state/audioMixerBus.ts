/**
 * Audio mixer bus — links the SLIDE tab's AUDIO lanes to the real mixer model.
 *
 * Unlike the VISUAL side (where the VJ iframe owns state), the audio mixer's
 * single source of truth is already in-app:
 *   - MASTER volume  → playbackStore (drives playerStore.setMasterGain, LIVE)
 *   - per-track vol / pan / mute / solo → editorStore.tracks
 * The EDIT tab's own faders read/write the exact same stores, so SLIDE is just a
 * second control surface — there's no separate value store to keep in sync and
 * no way for the two surfaces to "fight": both mutate editorStore/playbackStore.
 *
 * What this module does:
 *   - exposes the live AUDIO catalog ('MASTER' + each editor track name),
 *   - OUTBOUND: a slideStore subscription turns SLIDE audio fader/knob/pad moves
 *     into editorStore/playbackStore mutations,
 *   - INBOUND: editorStore/playbackStore subscriptions mirror the current mixer
 *     state back onto slideStore's audio values/pads so the lanes render at the
 *     right positions (and follow the EDIT-tab faders).
 *
 * Honesty about "live": MASTER is genuinely real-time. Per-track changes write
 * editorStore; multi-track audio is an offline bounce on play today, so a track
 * fader is *heard* on the next play (identical to the EDIT tab). The SLIDE UI
 * reflects it immediately. The real-time per-track scheduler is deferred
 * (see docs/plans/2026-05-31-slide-phase2-mixer-and-stacks.md, "2B-plus").
 *
 * Echo guard: `applying` is set while we write INBOUND changes into slideStore
 * so the outbound subscription ignores them.
 */
import { useSlideStore } from './slideStore';
import { useEditorStore, type EditorTrack } from './editorStore';
import { usePlaybackStore } from './playbackStore';

/** The fixed master lane label (always slot 0 of the AUDIO catalog). */
export const MASTER_LABEL = 'MASTER';

/** Solo is exposed as a dedicated pad whose label is the track name + this
 *  suffix, so a track can have both a MUTE pad (bare name) and a SOLO pad. */
export const SOLO_SUFFIX = ' SOLO';

/** Pan is exposed as a knob whose label is the track name + this suffix, so a
 *  track's volume (bare-name fader) and pan (suffixed knob) never collide on
 *  the same `audio/<label>` store key. */
export const PAN_SUFFIX = ' PAN';

let applying = false;

/* ----------------------------- catalog --------------------------------- */
/** Live AUDIO catalog: MASTER first, then every editor track by name. Falls
 *  back to just MASTER when the project has no tracks yet. */
export function audioCatalog(): string[] {
  const tracks = useEditorStore.getState().tracks;
  return [MASTER_LABEL, ...tracks.map((t) => t.name)];
}

/** Strip any control suffix to get the bare track name. */
function baseName(label: string): string {
  if (label.endsWith(SOLO_SUFFIX)) return label.slice(0, -SOLO_SUFFIX.length);
  if (label.endsWith(PAN_SUFFIX)) return label.slice(0, -PAN_SUFFIX.length);
  return label;
}

/** Resolve a lane label to an editor track (by name). undefined for MASTER /
 *  unknown. Names can collide; first match wins (same rule the EDIT UI uses). */
function trackByLabel(label: string): EditorTrack | undefined {
  const base = baseName(label);
  return useEditorStore.getState().tracks.find((t) => t.name === base);
}

/* ----------------------------- conversions ----------------------------- */
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const volToPct = (v: number) => clamp(v * 100, 0, 100); // editor vol 0..1 → 0..100
const pctToVol = (p: number) => clamp(p / 100, 0, 1);
const panToPct = (p: number) => clamp((p + 1) * 50, 0, 100); // -1..1 → 0..100
const pctToPan = (p: number) => clamp(p / 50 - 1, -1, 1);

/* ----------------------------- outbound (SLIDE → mixer) ----------------- */
// A value change on `audio/<name> PAN` is a pan knob; `audio/<name>` (bare) is
// a volume fader. Routed here from the slideStore subscription below.
function applyValueToMixer(label: string, pct: number): void {
  if (label.endsWith(PAN_SUFFIX)) {
    const track = trackByLabel(label);
    if (track) useEditorStore.getState().updateTrack(track.id, { pan: pctToPan(pct) });
    return;
  }
  if (label === MASTER_LABEL) {
    usePlaybackStore.getState().setVolume(clamp(pct, 0, 100)); // LIVE master
    return;
  }
  const track = trackByLabel(label);
  if (track) useEditorStore.getState().updateTrack(track.id, { volume: pctToVol(pct) });
}

function applyPadToMixer(label: string, on: boolean): void {
  if (label === MASTER_LABEL) {
    // a MASTER pad acts as global mute
    const muted = usePlaybackStore.getState().muted;
    if (muted !== on) usePlaybackStore.getState().toggleMute();
    return;
  }
  const track = trackByLabel(label);
  if (!track) return;
  if (label.endsWith(SOLO_SUFFIX)) {
    // toggleSolo flips this track's solo (and clears others when soloing)
    if (track.solo !== on) useEditorStore.getState().toggleSolo(track.id);
  } else {
    useEditorStore.getState().updateTrack(track.id, { mute: on });
  }
}

// Watch slideStore for AUDIO value/pad changes → push into the mixer. Skipped
// while `applying` an inbound change. Pad keys ending in SOLO_SUFFIX are solo;
// others are mute. (In ROW/FOCUS the faders carry volume; pan/mute/solo are
// reachable from CONTROLLER view.)
const AUDIO_PREFIX = 'audio/';
useSlideStore.subscribe((state, prev) => {
  if (applying) return;
  if (state.values !== prev.values) {
    for (const k in state.values) {
      if (!k.startsWith(AUDIO_PREFIX)) continue;
      if (state.values[k] === prev.values[k]) continue;
      applyValueToMixer(k.slice(AUDIO_PREFIX.length), state.values[k]);
    }
  }
  if (state.pads !== prev.pads) {
    for (const k in state.pads) {
      if (!k.startsWith(AUDIO_PREFIX)) continue;
      if (state.pads[k] === prev.pads[k]) continue;
      applyPadToMixer(k.slice(AUDIO_PREFIX.length), state.pads[k]);
    }
  }
});

/* ----------------------------- inbound (mixer → SLIDE) ------------------ */
function writeAudio(values: Record<string, number>, pads: Record<string, boolean>): void {
  applying = true;
  try {
    const store = useSlideStore.getState();
    for (const [label, v] of Object.entries(values)) store.setValueFor('audio', label, v);
    for (const [label, on] of Object.entries(pads)) store.setOnFor('audio', label, on);
  } finally {
    applying = false;
  }
}

// editorStore keeps playheadSec / zoom / scrollSec in the SAME store, so its
// subscribe fires on every playback tick. We compute a signature of only the
// mixer-relevant fields and skip the (churny) slideStore write when nothing
// mixer-related changed — otherwise we'd rewrite the audio lanes every frame.
let lastSig = '';

function mixerSignature(): string {
  const { tracks } = useEditorStore.getState();
  const pb = usePlaybackStore.getState();
  let sig = `M:${pb.volume}:${pb.muted}`;
  for (const t of tracks) sig += `|${t.name}:${t.volume}:${t.pan}:${t.mute}:${t.solo}`;
  return sig;
}

/** Push the current mixer state onto the SLIDE audio namespace, but only when
 *  a mixer-relevant field actually changed (see mixerSignature). Called on init
 *  and on every editorStore / playbackStore change. */
function syncFromMixer(force = false): void {
  const sig = mixerSignature();
  if (!force && sig === lastSig) return;
  lastSig = sig;

  const { tracks } = useEditorStore.getState();
  const pb = usePlaybackStore.getState();
  const values: Record<string, number> = { [MASTER_LABEL]: clamp(pb.volume, 0, 100) };
  const pads: Record<string, boolean> = { [MASTER_LABEL]: pb.muted };
  for (const t of tracks) {
    values[t.name] = volToPct(t.volume);
    values[t.name + PAN_SUFFIX] = panToPct(t.pan);
    pads[t.name] = t.mute;
    pads[t.name + SOLO_SUFFIX] = t.solo;
  }
  writeAudio(values, pads);
}

let started = false;
/** Begin mirroring mixer → SLIDE. Idempotent; safe to call from a component
 *  mount. Returns an unsubscribe that stops the mirroring. */
export function startAudioMixerSync(): () => void {
  // Force an immediate full sync so lanes open at the right positions.
  syncFromMixer(true);
  if (started) return () => undefined;
  started = true;
  const unsubEditor = useEditorStore.subscribe(() => syncFromMixer());
  const unsubPlayback = usePlaybackStore.subscribe(() => syncFromMixer());
  return () => {
    started = false;
    unsubEditor();
    unsubPlayback();
  };
}

/** True while the bus is applying an inbound write (for tests / guards). */
export function isApplyingAudio(): boolean {
  return applying;
}
