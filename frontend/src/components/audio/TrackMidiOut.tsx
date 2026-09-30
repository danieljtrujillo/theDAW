/**
 * TrackMidiOut — an EDIT track's MIDI output and per-note expression.
 *
 * The button in the track header opens a panel: the output port the track's
 * live MIDI also goes to (state/midiOutBus), the channel it starts on, clock
 * (24 to the quarter note with song position, Start/Continue and Stop, so an
 * external host follows the timeline), and how many member channels the
 * track's expressive notes rotate across (lib/mpeRotation; Off plays them on
 * the track's own channel). The track plays live on its instrument, so an
 * external host hears it while theDAW's synth does too; the track fader
 * silences theDAW's side.
 */
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Cable } from 'lucide-react';
import { useEditorStore, type EditorTrack } from '../../state/editorStore';
import { useMidiOutPorts } from '../../state/midiOutBus';
import { MPE_DEFAULT_MEMBERS, MPE_MAX_MEMBERS } from '../../lib/mpeRotation';
import { resolveRef } from '../../lib/ioResolve';

const field = 'rounded border border-white/10 bg-black/40 px-1.5 py-0.5 text-xs font-bold text-zinc-100 outline-none focus:border-purple-400/60';

export const TrackMidiOut: React.FC<{ track: EditorTrack }> = ({ track }) => {
  const uid = useId().replace(/:/g, '');
  const updateTrack = useEditorStore((s) => s.updateTrack);
  const ports = useMidiOutPorts((s) => s.ports);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const out = track.midiOut;
  // The open port the track's MIDI goes to, matched as the routes match it: by id, else by name
  // (a port's id can change between sessions while its name stays).
  const resolvedId = out ? resolveRef({ id: out.id, label: out.label }, ports, true).deviceId : '';
  const connected = !!out && ports.some((p) => p.id === resolvedId);
  const selectedPort = out ? (connected ? resolvedId : out.id) : '';

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const r = buttonRef.current.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(window.innerWidth - 296, r.left)), y: r.bottom + 4 });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  const setPort = (value: string) => {
    if (!value) {
      updateTrack(track.id, { midiOut: undefined });
      return;
    }
    const port = ports.find((p) => p.id === value);
    const label = port?.label ?? out?.label ?? value;
    updateTrack(track.id, { midiOut: { id: value, label, channel: out?.channel ?? 1, ...(out?.clock ? { clock: true } : {}) } });
  };
  const members = track.mpeChannels ?? MPE_DEFAULT_MEMBERS;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={`${uid}-panel`}
        aria-label={`Track ${track.name} MIDI out${out ? `: ${out.label}, channel ${out.channel}${out.clock ? ', clock' : ''}` : ''}`}
        title={out ? `MIDI out to ${out.label}, channel ${out.channel}${out.clock ? ' with clock' : ''}${connected ? '' : ' (port not open)'}` : 'MIDI out and per-note expression'}
        className={`w-4 h-4 rounded flex items-center justify-center border shrink-0 ${out ? (connected ? 'bg-sky-500/25 text-sky-200 border-sky-500/60' : 'bg-amber-500/20 text-amber-200 border-amber-500/60') : 'bg-black/40 text-zinc-500 border-white/10 hover:text-white'}`}
      >
        <Cable aria-hidden="true" className="w-3 h-3" />
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            id={`${uid}-panel`}
            role="dialog"
            aria-labelledby={`${uid}-title`}
            className="fixed z-200 w-72 rounded-lg border border-white/10 bg-zinc-900 p-3 flex flex-col gap-2 shadow-2xl"
            style={pos ? { left: pos.x, top: pos.y } : { left: -9999, top: -9999 }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setOpen(false);
                buttonRef.current?.focus();
              }
            }}
          >
            <h2 id={`${uid}-title`} className="text-xs font-bold uppercase tracking-wider text-zinc-200">{`${track.name}: MIDI out`}</h2>
            <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-2">
              <label htmlFor={`${uid}-port`} className="text-xs font-bold text-zinc-400">Output port</label>
              <select
                id={`${uid}-port`}
                name={`track-midi-out-port-${track.id}`}
                value={selectedPort}
                onChange={(e) => setPort(e.target.value)}
                className={field}
                style={{ colorScheme: 'dark' }}
              >
                <option value="">None (inside theDAW)</option>
                {ports.map((p) => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
                {out && !connected && <option value={out.id}>{`${out.label} (not open)`}</option>}
              </select>

              <label htmlFor={`${uid}-channel`} className="text-xs font-bold text-zinc-400">Channel</label>
              <select
                id={`${uid}-channel`}
                name={`track-midi-out-channel-${track.id}`}
                value={out?.channel ?? 1}
                disabled={!out}
                onChange={(e) => out && updateTrack(track.id, { midiOut: { ...out, channel: Number(e.target.value) } })}
                title="The channel the track's notes go out on; bent lanes and expressive notes take the channels after it"
                className={field}
                style={{ colorScheme: 'dark' }}
              >
                {Array.from({ length: 16 }, (_, i) => i + 1).map((ch) => (
                  <option key={ch} value={ch}>{String(ch)}</option>
                ))}
              </select>

              <label htmlFor={`${uid}-mpe`} className="text-xs font-bold text-zinc-400">Expression</label>
              <select
                id={`${uid}-mpe`}
                name={`track-mpe-channels-${track.id}`}
                value={members}
                onChange={(e) => updateTrack(track.id, { mpeChannels: Number(e.target.value) })}
                title="Notes with their own pressure, timbre or bend each get a channel of their own from this many, MPE-style"
                className={field}
                style={{ colorScheme: 'dark' }}
              >
                <option value={0}>Off: on the track's channel</option>
                {Array.from({ length: MPE_MAX_MEMBERS }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>{`Rotate across ${n} channel${n === 1 ? '' : 's'}`}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <input
                id={`${uid}-clock`}
                name={`track-midi-out-clock-${track.id}`}
                type="checkbox"
                checked={out?.clock === true}
                disabled={!out}
                onChange={(e) => out && updateTrack(track.id, { midiOut: { id: out.id, label: out.label, channel: out.channel, ...(e.target.checked ? { clock: true } : {}) } })}
                className="size-3.5 accent-sky-400"
              />
              <label htmlFor={`${uid}-clock`} className="text-xs font-bold text-zinc-300">Send clock and song position</label>
            </div>
            <p className="text-xs font-bold text-zinc-500">
              The track plays live on its instrument; its MIDI goes to the port as well. Pull the track fader down to hear the port alone.
            </p>
          </div>,
          document.body,
        )}
    </>
  );
};
