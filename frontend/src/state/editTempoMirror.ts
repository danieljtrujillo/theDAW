/**
 * editTempoMirror — keeps state/tempoStore holding the EDIT arrangement's tempo map.
 *
 * tempoStore is the app's one owned tempo map, and the arrangement's map is that
 * map. The document copy lives in editorStore (`tempoMap`: undo, autosave and
 * .tasmo read the store's slices); every change to it is pushed into tempoStore,
 * so a surface that reads tempo through tempoStore (the EDIT click,
 * metronomeStore `editTempoMap`) hears the arrangement. An edit made through
 * tempoStore's own actions comes back the other way as an ordinary, undoable
 * `editorStore.setTempoMap`. Both directions compare contents
 * (lib/editTimeMap sameTempoMap), so a push the other side sanitizes to the same
 * map stops there.
 *
 * Its own module, installed on import, because tempoStore reaches the shared
 * beat clock and the audio engine (beatClock -> playerStore) and editorStore
 * must stay loadable without either. metronomeStore imports it, since it is the
 * reader the mirror exists for; `installEditTempoMirror` is idempotent, so a
 * second importer adds nothing.
 */
import { useEditorStore } from './editorStore';
import { useTempoStore } from './tempoStore';
import { sameTempoMap } from '../lib/editTimeMap';
import type { TempoEvent } from '../lib/tempoMap';

let installed = false;

const pushToTempoStore = (map: readonly TempoEvent[]): void => {
  const mirror = useTempoStore.getState();
  if (!sameTempoMap(mirror.events, map)) mirror.setEvents(map);
};

/** Start mirroring (once). Pushes the arrangement's current map at once. */
export function installEditTempoMirror(): void {
  if (installed) return;
  installed = true;
  pushToTempoStore(useEditorStore.getState().tempoMap);
  useEditorStore.subscribe((state, prev) => {
    if (state.tempoMap !== prev.tempoMap) pushToTempoStore(state.tempoMap);
  });
  useTempoStore.subscribe((mirror, prev) => {
    if (mirror.events === prev.events) return;
    const editor = useEditorStore.getState();
    if (!sameTempoMap(mirror.events, editor.tempoMap)) editor.setTempoMap(mirror.events);
  });
}

installEditTempoMirror();
