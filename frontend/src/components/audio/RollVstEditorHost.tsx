/**
 * RollVstEditorHost — the box a roll part's VST3 instrument opens its own
 * window in, over the right of the MIDI tab's roll.
 *
 * The part's plugin name (RollPartInstrument) opens the editor through the one
 * app-wide editor session (state/vstEditorStore). While that session belongs
 * to one of the roll's parts, this box holds it: embedded, the plugin's window
 * is pinned inside it (VstEmbedHost scrolls an oversized editor and can grow
 * it); floating, the plugin keeps its own window and the box says so. Closing
 * the box, or the plugin's own window, keeps what was set on the part.
 */
import React, { useCallback, useState } from 'react';
import { usePianoRollStore } from '../../state/pianoRollStore';
import { useVstEditorStore } from '../../state/vstEditorStore';
import { VstEmbedHost } from './VstEmbedHost';

/** The box's size before the plugin reports its own, and the most it takes of the roll. */
const DEFAULT_W = 480;
const DEFAULT_H = 320;

export const RollVstEditorHost: React.FC = () => {
  const entryId = useVstEditorStore((s) => s.entryId);
  const pluginPath = useVstEditorStore((s) => s.pluginPath);
  const pluginName = useVstEditorStore((s) => s.pluginName);
  const error = useVstEditorStore((s) => s.error);
  // The part whose instrument the open session is, if any.
  const part = usePianoRollStore((s) => (entryId ? s.tracks.find((t) => t.vstInstrument?.id === entryId) : undefined));
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const onNaturalSize = useCallback((w: number, h: number) => {
    setNatural((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
  }, []);
  if (!part || !pluginPath) return null;
  const w = natural?.w ?? DEFAULT_W;
  const h = (natural?.h ?? DEFAULT_H) + 28;
  return (
    <section
      aria-label={`${pluginName ?? 'VST3 instrument'} of ${part.name}`}
      className="absolute top-1 right-1 z-30 flex flex-col max-w-[calc(100%-8px)] max-h-[calc(100%-8px)] bg-[#0a080f] border border-white/10 rounded-sm shadow-[0_8px_32px_rgba(0,0,0,0.75)] overflow-hidden"
      style={{ width: w, height: h }}
      data-roll-vst-editor=""
    >
      <VstEmbedHost
        pluginPath={pluginPath}
        pluginName={pluginName ?? part.name}
        error={error ?? undefined}
        onClose={() => useVstEditorStore.getState().close()}
        onNaturalSize={onNaturalSize}
      />
    </section>
  );
};
