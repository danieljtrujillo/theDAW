/**
 * Transport control source for the companion / XR control bus.
 *
 * Publishes the footer player's transport (play/pause, seek, volume, loop, stop)
 * as manifest entries and routes inbound control-sets to the playerStore, so a
 * phone (Phase 3 Slice 1) or a headset (Phase 7 B1) can drive playback with no
 * per-control code. It also mirrors host-side play/loop state back to
 * controllers so their widgets follow theDAW.
 *
 * Volume: playerStore has no stored master-gain value (setMasterGain writes the
 * gain node directly), so this source tracks the last commanded volume locally
 * to seed the widget; it defaults to 1.
 */
import type { XrControlSource, XrManifestEntry, XrControlValue } from './xrControlClient';
import { publishControlChanged } from './xrControlClient';
import { usePlayerStore } from './playerStore';

const AREA = 'transport';
let lastVolume = 1;
let mirrorWired = false;

/** Mirror host-side play/loop changes to controllers (once). */
function ensureMirror(): void {
  if (mirrorWired) return;
  mirrorWired = true;
  let prevPlaying = usePlayerStore.getState().isPlaying;
  let prevLooping = usePlayerStore.getState().isLooping;
  usePlayerStore.subscribe((s) => {
    if (s.isPlaying !== prevPlaying) {
      prevPlaying = s.isPlaying;
      publishControlChanged(`${AREA}.playpause`, s.isPlaying);
    }
    if (s.isLooping !== prevLooping) {
      prevLooping = s.isLooping;
      publishControlChanged(`${AREA}.loop`, s.isLooping);
    }
  });
}

export const transportControlSource: XrControlSource = {
  area: AREA,

  buildEntries(): XrManifestEntry[] {
    ensureMirror();
    const s = usePlayerStore.getState();
    return [
      {
        id: `${AREA}.playpause`,
        area: AREA,
        group: 'Transport',
        label: 'Play / Pause',
        kind: 'toggle',
        value: s.isPlaying,
      },
      {
        id: `${AREA}.stop`,
        area: AREA,
        group: 'Transport',
        label: 'Stop',
        kind: 'button',
      },
      {
        id: `${AREA}.seek`,
        area: AREA,
        group: 'Transport',
        label: 'Seek',
        kind: 'fader',
        min: 0,
        max: 1,
        step: 0.001,
        value: s.duration > 0 ? s.currentTime / s.duration : 0,
      },
      {
        id: `${AREA}.volume`,
        area: AREA,
        group: 'Transport',
        label: 'Volume',
        kind: 'knob',
        min: 0,
        max: 1,
        step: 0.01,
        value: lastVolume,
      },
      {
        id: `${AREA}.loop`,
        area: AREA,
        group: 'Transport',
        label: 'Loop',
        kind: 'toggle',
        value: s.isLooping,
      },
    ];
  },

  apply(id: string, value: XrControlValue): boolean {
    const store = usePlayerStore.getState();
    switch (id) {
      case `${AREA}.playpause`: {
        // Idempotent intent (never invert a matching command). A real
        // transition is mirrored by the store subscription; the one case that
        // never transitions — play with no track loaded — is corrected here so
        // the controller's optimistic "playing" does not stick on.
        const wantPlay = typeof value === 'boolean' ? value : Boolean(value);
        if (wantPlay) {
          if (!store.hasTrack) publishControlChanged(`${AREA}.playpause`, false);
          else if (!store.isPlaying) store.play();
        } else if (store.isPlaying) {
          store.pause();
        }
        return true;
      }
      case `${AREA}.stop`:
        if (value) store.stop();
        return true;
      case `${AREA}.seek`:
        store.seekByFraction(Number(value));
        return true;
      case `${AREA}.volume`: {
        lastVolume = Math.max(0, Math.min(1, Number(value)));
        store.setMasterGain(lastVolume);
        // playerStore keeps no master-gain state, so echo the applied value so
        // other controllers (and a rebuilt manifest) stay in sync.
        publishControlChanged(`${AREA}.volume`, lastVolume);
        return true;
      }
      case `${AREA}.loop`:
        // toggleLoop flips; only flip when the requested state differs.
        if (Boolean(value) !== store.isLooping) store.toggleLoop();
        return true;
      default:
        return false;
    }
  },
};
