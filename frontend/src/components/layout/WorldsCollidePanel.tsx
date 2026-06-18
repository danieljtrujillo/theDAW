/**
 * GANTASMO — Worlds Collide.
 *
 * An on-screen twin of the Quest "GANTASMO XR MIDI" control surface, living in
 * theDAW's controller section. It emits the SAME MIDI as the headset surface so
 * theDAW treats it identically to the hardware:
 *
 *   6 faders     -> CC 1..6
 *   8 knobs      -> CC 40..47
 *   12 buttons   -> Note 36..47 (momentary)
 *   1 crossfade  -> CC 7        (rests at centre / 64, moves both ways)
 *   hand poses   -> Note 53..59 (momentary; placeholders that line up with a
 *                                future HandPoseMidiSource on the Quest)
 *
 * Everything publishes on the global midiBus (channel 1, matching the Quest
 * MidiControlSurface), so it is mappable / usable everywhere a hardware
 * controller is. In MAP mode each of the 27 standard controls shows the same
 * learn chip the generic controller grid uses: click it, touch the control, and
 * its CC/Note binds to that slot — the SlidePanel learn/route runtime does the
 * rest. Incoming bus traffic on the same numbers is reflected back into the
 * controls, so moving the headset surface animates this one and vice-versa.
 *
 * Control positions follow the profile's section order (faders, crossfade,
 * knobs, buttons) so the learn chips line up with controllerMapStore + routing,
 * even though the visual layout puts knobs between faders and pads and the
 * crossfade under the pads.
 */
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { publishMidi, subscribeToMidi } from '../../state/midiBus';
import { useControllerMapStore, bindingLabel } from '../../state/controllerMapStore';

const CH = 0; // MIDI channel 1 (0-indexed) — matches MidiControlSurface.channel = 1
const STATUS_CC = 0xb0;
const STATUS_NOTE_ON = 0x90;
const STATUS_NOTE_OFF = 0x80;

const FADER_CC = [1, 2, 3, 4, 5, 6];
const CROSSFADE_CC = 7;
const KNOB_CC = [40, 41, 42, 43, 44, 45, 46, 47];
const BUTTON_NOTES = Array.from({ length: 12 }, (_, i) => 36 + i); // 36..47

// Positions in profile-section order [faders 6, crossfade 1, knobs 8, buttons 12]
// so the learn chips align with controllerMapStore + the SlidePanel routing.
const FADER_POS = (i: number) => i;            // 0..5
const CROSSFADE_POS = 6;                        // 6
const KNOB_POS = (i: number) => 7 + i;          // 7..14
const BUTTON_POS = (i: number) => 15 + i;       // 15..26

interface Pose {
  id: string;
  label: string;
  note: number;
  icon: string; // file under /hand-poses (the real Meta / XR Hands gesture icons)
}
const POSES: Pose[] = [
  { id: 'fist', label: 'Fist', note: 53, icon: 'fist.png' },
  { id: 'open', label: 'Open', note: 54, icon: 'open.png' },
  { id: 'point', label: 'Point', note: 55, icon: 'point.png' },
  { id: 'pinch', label: 'Pinch', note: 56, icon: 'pinch.png' },
  { id: 'shaka', label: 'Shaka', note: 57, icon: 'shaka.png' },
  { id: 'thumbup', label: 'Thumb +', note: 58, icon: 'thumb-up.png' },
  { id: 'thumbdown', label: 'Thumb -', note: 59, icon: 'thumb-down.png' },
];

const clamp127 = (v: number) => Math.max(0, Math.min(127, Math.round(v)));

function emitCC(cc: number, v127: number) { publishMidi([STATUS_CC | CH, cc, clamp127(v127)]); }
function emitNoteOn(note: number, vel = 110) { publishMidi([STATUS_NOTE_ON | CH, note, vel]); }
function emitNoteOff(note: number) { publishMidi([STATUS_NOTE_OFF | CH, note, 0]); }

/* ----------------------------- learn chip -------------------------------- */
// Mirrors the generic controller grid's chip (.sl-mapchip from track-controls.css).
const MapChip: React.FC<{ profileId: string; pos: number }> = ({ profileId, pos }) => {
  const binding = useControllerMapStore((s) => s.bindings[profileId]?.[pos]);
  const learnPos = useControllerMapStore((s) => s.learnPos);
  const setLearnPos = useControllerMapStore((s) => s.setLearnPos);
  const clearPos = useControllerMapStore((s) => s.clearPos);
  const learning = learnPos === pos;
  return (
    <button
      type="button"
      className={`sl-mapchip${learning ? ' learning' : ''}${binding ? ' bound' : ''}`}
      onClick={() => setLearnPos(learning ? null : pos)}
      onContextMenu={(e) => { e.preventDefault(); clearPos(profileId, pos); }}
      title={
        learning
          ? 'Waiting — touch this control to bind it. Right-click to clear.'
          : binding
            ? `Bound to ${bindingLabel(binding)} (ch ${binding.channel + 1}). Click to relearn, right-click to clear.`
            : 'Unmapped — click, then touch this control.'
      }
    >
      {learning ? 'LEARN' : bindingLabel(binding)}
    </button>
  );
};

/* ----------------------------- vertical fader ---------------------------- */
const VFader: React.FC<{ label: string; value: number; onChange: (v: number) => void; chip?: React.ReactNode }> = memo(
  ({ label, value, onChange, chip }) => {
    const ref = useRef<HTMLDivElement>(null);
    const dragging = useRef(false);
    const fromY = (clientY: number) => {
      const el = ref.current;
      if (!el) return value;
      const r = el.getBoundingClientRect();
      const yl = Math.max(0, Math.min(clientY - r.top, r.height));
      return clamp127((1 - yl / r.height) * 127);
    };
    const down = (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragging.current = true;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      onChange(fromY(e.clientY));
      e.preventDefault();
    };
    const move = (e: React.PointerEvent) => { if (dragging.current) onChange(fromY(e.clientY)); };
    const up = (e: React.PointerEvent) => { dragging.current = false; (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); };
    const pct = (value / 127) * 100;
    return (
      <div className="flex flex-col items-center gap-1 select-none">
        <div
          ref={ref}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          className="relative w-3.5 h-32 rounded-full bg-black/50 border border-white/12 cursor-ns-resize"
        >
          <div className="absolute inset-x-0 bottom-0 rounded-full bg-fuchsia-500/70" style={{ height: `${Math.max(pct, 2)}%` }} />
          <div className="absolute left-1/2 -translate-x-1/2 w-6 h-2.5 rounded-sm bg-fuchsia-100 shadow-[0_0_8px_rgba(217,70,239,0.7)]" style={{ top: `calc(${100 - pct}% - 5px)` }} />
        </div>
        <span className="text-[7px] font-mono uppercase tracking-widest text-zinc-500">{label}</span>
        {chip}
      </div>
    );
  },
);
VFader.displayName = 'VFader';

/* ----------------------------- rotary knob ------------------------------- */
const Knob: React.FC<{ label: string; value: number; onChange: (v: number) => void; chip?: React.ReactNode }> = memo(
  ({ label, value, onChange, chip }) => {
    const dragging = useRef(false);
    const lastY = useRef(0);
    const down = (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      dragging.current = true;
      lastY.current = e.clientY;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };
    const move = (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const dy = lastY.current - e.clientY;
      lastY.current = e.clientY;
      onChange(clamp127(value + (dy / 150) * 127 * (e.shiftKey ? 0.25 : 1)));
    };
    const up = (e: React.PointerEvent) => { dragging.current = false; (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); };
    const sweep = (value / 127) * 270;
    const arcBg =
      `conic-gradient(from 225deg, rgb(217 70 239) 0deg ${sweep}deg, ` +
      `rgba(255,255,255,0.08) ${sweep}deg 270deg, rgba(255,255,255,0) 270deg 360deg)`;
    return (
      <div className="flex flex-col items-center gap-1 select-none">
        <div
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          className="relative w-11 h-11 rounded-full cursor-ns-resize"
          role="slider"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={127}
          aria-valuenow={value}
        >
          <div className="absolute inset-0 rounded-full" style={{ background: arcBg }} />
          <div className="absolute inset-[4px] rounded-full bg-zinc-900 border border-white/10" />
          <div className="absolute inset-0" style={{ transform: `rotate(${225 + sweep}deg)` }}>
            <span className="absolute left-1/2 top-1 -translate-x-1/2 w-1 h-2.5 rounded-full bg-fuchsia-100 shadow-[0_0_6px_rgba(217,70,239,0.8)]" />
          </div>
        </div>
        <span className="text-[7px] font-mono uppercase tracking-widest text-zinc-500">{label}</span>
        {chip}
      </div>
    );
  },
);
Knob.displayName = 'Knob';

/* ----------------------------- crossfade --------------------------------- */
const Crossfade: React.FC<{ value: number; onChange: (v: number) => void; chip?: React.ReactNode }> = memo(({ value, onChange, chip }) => {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const fromX = (clientX: number) => {
    const el = ref.current;
    if (!el) return value;
    const r = el.getBoundingClientRect();
    const xl = Math.max(0, Math.min(clientX - r.left, r.width));
    return clamp127((xl / r.width) * 127);
  };
  const down = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    onChange(fromX(e.clientX));
    e.preventDefault();
  };
  const move = (e: React.PointerEvent) => { if (dragging.current) onChange(fromX(e.clientX)); };
  const up = (e: React.PointerEvent) => { dragging.current = false; (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); };
  const pct = (value / 127) * 100;
  return (
    <div className="flex flex-col items-center gap-1 select-none">
      <div
        ref={ref}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onDoubleClick={() => onChange(64)}
        className="relative h-3.5 w-64 rounded-full bg-black/50 border border-white/12 cursor-ew-resize"
        title="Crossfade (CC 7) — double-click to centre"
      >
        <span className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-white/20" />
        <div className="absolute top-1/2 -translate-y-1/2 w-2.5 h-6 rounded-sm bg-fuchsia-100 shadow-[0_0_8px_rgba(217,70,239,0.7)]" style={{ left: `calc(${pct}% - 5px)` }} />
      </div>
      <span className="text-[7px] font-mono uppercase tracking-widest text-zinc-500">XFADE · CC 7</span>
      {chip}
    </div>
  );
});
Crossfade.displayName = 'Crossfade';

/* ----------------------------- momentary pad ----------------------------- */
const Pad: React.FC<{ label: string; lit: boolean; onDown: () => void; onUp: () => void; chip?: React.ReactNode }> = memo(
  ({ label, lit, onDown, onUp, chip }) => {
    const down = (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      onDown();
      e.preventDefault();
    };
    const up = (e: React.PointerEvent) => { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); onUp(); };
    return (
      <div className="flex flex-col items-center gap-1">
        <button
          type="button"
          onPointerDown={down}
          onPointerUp={up}
          onPointerCancel={up}
          onPointerLeave={(e) => { if (e.buttons) onUp(); }}
          className={`h-9 w-full rounded-md border text-[8px] font-mono uppercase tracking-wider transition-colors ${
            lit
              ? 'border-fuchsia-400 bg-fuchsia-500/30 text-fuchsia-100 shadow-[0_0_10px_rgba(217,70,239,0.6)]'
              : 'border-white/12 bg-white/5 text-zinc-500 hover:text-zinc-300 hover:bg-white/8'
          }`}
        >
          {label}
        </button>
        {chip}
      </div>
    );
  },
);
Pad.displayName = 'Pad';

/* ----------------------------- the surface ------------------------------- */
const WorldsCollidePanel: React.FC<{ profileId: string }> = ({ profileId }) => {
  const initCC: Record<number, number> = {};
  FADER_CC.forEach((cc) => (initCC[cc] = 0));
  KNOB_CC.forEach((cc) => (initCC[cc] = 64));
  initCC[CROSSFADE_CC] = 64;
  const [cc, setCc] = useState<Record<number, number>>(initCC);
  const [lit, setLit] = useState<Set<number>>(new Set());
  const mapMode = useControllerMapStore((s) => s.mapMode);

  const setCcVal = useCallback((num: number, v: number) => {
    setCc((prev) => (prev[num] === v ? prev : { ...prev, [num]: v }));
  }, []);

  // Reflect incoming bus traffic (the Quest surface, or any mapped hardware) so
  // the on-screen twin animates. Display-only: it never re-emits, so no loop.
  useEffect(() => {
    return subscribeToMidi((msg) => {
      const [status, d1, d2] = msg.data;
      if ((status & 0x0f) !== CH) return;
      const cmd = status & 0xf0;
      const isPoseOrButton = BUTTON_NOTES.includes(d1) || POSES.some((p) => p.note === d1);
      if (cmd === STATUS_CC && (FADER_CC.includes(d1) || KNOB_CC.includes(d1) || d1 === CROSSFADE_CC)) {
        setCcVal(d1, clamp127(d2 ?? 0));
      } else if (cmd === STATUS_NOTE_ON && (d2 ?? 0) > 0 && isPoseOrButton) {
        setLit((prev) => { const n = new Set(prev); n.add(d1); return n; });
      } else if ((cmd === STATUS_NOTE_OFF || (cmd === STATUS_NOTE_ON && (d2 ?? 0) === 0)) && isPoseOrButton) {
        setLit((prev) => { if (!prev.has(d1)) return prev; const n = new Set(prev); n.delete(d1); return n; });
      }
    });
  }, [setCcVal]);

  const onCc = (ccNum: number, v: number) => { setCcVal(ccNum, v); emitCC(ccNum, v); };
  const padDown = (note: number) => { setLit((p) => { const n = new Set(p); n.add(note); return n; }); emitNoteOn(note); };
  const padUp = (note: number) => { setLit((p) => { if (!p.has(note)) return p; const n = new Set(p); n.delete(note); return n; }); emitNoteOff(note); };
  const chip = (pos: number) => (mapMode ? <MapChip profileId={profileId} pos={pos} /> : null);

  return (
    <div className="mx-auto my-2 w-fit rounded-xl border border-fuchsia-500/25 bg-[#0d0a14] p-4 shadow-[0_0_40px_rgba(139,92,246,0.12)]">
      {/* title */}
      <div className="mb-3 flex items-baseline justify-between gap-6 border-b border-white/10 pb-2">
        <h2 className="text-[13px] font-black uppercase tracking-[0.2em] text-fuchsia-200">
          GANTASMO <span className="text-zinc-500">·</span> WORLDS COLLIDE
        </h2>
        <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">XR MIDI SURFACE · CH 1</span>
      </div>

      {/* faders (sliders) */}
      <div className="mb-4 flex justify-center gap-3">
        {FADER_CC.map((num, i) => (
          <VFader key={num} label={`F${i + 1}·${num}`} value={cc[num]} onChange={(v) => onCc(num, v)} chip={chip(FADER_POS(i))} />
        ))}
      </div>

      {/* knobs — between the sliders and the pads */}
      <div className="mb-4 flex justify-center gap-3">
        {KNOB_CC.map((num, i) => (
          <Knob key={num} label={`K${i + 1}·${num}`} value={cc[num]} onChange={(v) => onCc(num, v)} chip={chip(KNOB_POS(i))} />
        ))}
      </div>

      {/* buttons — two rows of six, Note 36..47 */}
      <div className="mb-4 grid grid-cols-6 gap-2">
        {BUTTON_NOTES.map((note, i) => (
          <Pad key={note} label={`${i + 1}·${note}`} lit={lit.has(note)} onDown={() => padDown(note)} onUp={() => padUp(note)} chip={chip(BUTTON_POS(i))} />
        ))}
      </div>

      {/* crossfade — under the pads */}
      <div className="mb-4 flex justify-center">
        <Crossfade value={cc[CROSSFADE_CC]} onChange={(v) => onCc(CROSSFADE_CC, v)} chip={chip(CROSSFADE_POS)} />
      </div>

      {/* hand poses */}
      <div className="rounded-lg border border-white/10 bg-black/30 p-2">
        <div className="mb-1.5 text-[8px] font-mono uppercase tracking-widest text-zinc-500">Hand Poses</div>
        <div className="flex justify-between gap-2">
          {POSES.map((p) => (
            <button
              key={p.id}
              type="button"
              onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); padDown(p.note); e.preventDefault(); }}
              onPointerUp={(e) => { (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId); padUp(p.note); }}
              onPointerCancel={() => padUp(p.note)}
              title={`${p.label} · Note ${p.note}`}
              className={`flex flex-1 flex-col items-center gap-1 rounded-md border px-1 py-1.5 transition-colors ${
                lit.has(p.note)
                  ? 'border-fuchsia-400 bg-fuchsia-500/25 shadow-[0_0_10px_rgba(217,70,239,0.55)]'
                  : 'border-white/10 bg-white/5 hover:bg-white/8'
              }`}
            >
              <img
                src={`/hand-poses/${p.icon}`}
                alt={p.label}
                draggable={false}
                className={`h-5 w-5 object-contain ${lit.has(p.note) ? 'opacity-100' : 'opacity-80'}`}
              />
              <span className={`text-[7px] font-mono uppercase tracking-wider ${lit.has(p.note) ? 'text-fuchsia-100' : 'text-zinc-400'}`}>{p.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default memo(WorldsCollidePanel);
