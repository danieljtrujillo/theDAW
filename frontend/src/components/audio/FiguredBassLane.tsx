/**
 * The piano roll's FIGURED BASS lane, under the velocity lane: a figure field
 * under each onset of the part being edited, where the figures of its bass
 * line are written ('6', '6/4', '7', '#6'), the roll's key, and REALIZE, which
 * realizes the line in four parts (pianoRollStore realizeFiguredBass).
 *
 * Each field is a real labelled text input at its note's step. A figure is
 * written when the field loses focus or on Enter (one undo step), Escape puts
 * back the one before, and a blank field removes it. Zoomed out, onsets closer
 * than a field's width share the room: the first keeps its field and the lane
 * says to zoom in for the rest.
 *
 * The lane scrolls with the grid, and its header keeps to the left edge of the
 * view. PianoRollFiguresKey opens and closes it from the dock's strip, and
 * realizeRollFiguredBass is REALIZE with its log lines.
 */
import React, { useMemo, useState } from 'react';
import { Hash, Wand2 } from 'lucide-react';
import { activeTrackOf, effectiveRollKey, usePianoRollStore } from '../../state/pianoRollStore';
import { barAt } from '../../lib/meterMap';
import { ROLL_KEY_TONICS, rollKeyName, tonicName, tonicPitchClass, type RollKeyMode } from '../../lib/rollKey';
import { logError, logInfo } from '../../state/logStore';
import { FIELD, FIELD_LEGEND, FIELD_SELECT, KEY_ON, KEY_REST, MINI_WORD_KEY, STRIP_GLYPH, StripKey } from './midiDockKit';

const TICKS_PER_STEP = 240;
/** The narrowest a figure field gets (px): '#6/4' at 12px bold. */
const FIELD_MIN_PX = 30;
/** The widest a figure field gets (px). */
const FIELD_MAX_PX = 56;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteLabel = (midi: number) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

/** Realize the part's figured bass (pianoRollStore realizeFiguredBass) and log what it wrote, or why it could not. */
export async function realizeRollFiguredBass(partId?: string): Promise<void> {
  const s = usePianoRollStore.getState();
  const name = (s.tracks.find((t) => t.id === (partId ?? s.activeTrackId)) ?? activeTrackOf(s)).name;
  try {
    const done = await s.realizeFiguredBass(partId);
    const vl = usePianoRollStore.getState().voiceLeading;
    const flags = vl?.flags.length ?? 0;
    logInfo(
      'piano-roll',
      `Realized the figured bass of ${name} in ${vl ? rollKeyName(vl.key) : 'its key'}: soprano, alto and tenor written${done.created ? ` (${done.created} new part${done.created === 1 ? '' : 's'})` : ''}${
        flags ? `, ${flags} voice-leading flag${flags === 1 ? '' : 's'}` : ''
      }${done.skipped ? `; ${done.skipped} voice${done.skipped === 1 ? '' : 's'} left out, the roll holds its most parts` : ''}`,
    );
  } catch (e) {
    logError('piano-roll', `Realizing the figured bass of ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The roll's key picker: Auto (read from the notes) or one of the 24 major and minor keys. */
export const RollKeyPicker: React.FC<{ id?: string }> = ({ id = 'roll-key' }) => {
  const rollKey = usePianoRollStore((s) => s.rollKey);
  const tracks = usePianoRollStore((s) => s.tracks);
  const notes = usePianoRollStore((s) => s.notes);
  const activeTrackId = usePianoRollStore((s) => s.activeTrackId);
  // Read from the notes only while no key is set, and only when the notes change.
  const read = useMemo(
    () => (rollKey ? null : effectiveRollKey({ rollKey: null, tracks, notes, activeTrackId })),
    [rollKey, tracks, notes, activeTrackId],
  );
  const value = rollKey ? `${tonicPitchClass(rollKey.tonic)}:${rollKey.mode}` : 'auto';
  return (
    <div className={FIELD} title="The key the voice-leading check, REALIZE and the diatonic transforms read. Auto reads it from the notes.">
      <label htmlFor={id} className={FIELD_LEGEND}>Key</label>
      <select
        id={id}
        name={id}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'auto') {
            usePianoRollStore.getState().setRollKey(null);
            return;
          }
          const [pc, mode] = v.split(':');
          usePianoRollStore.getState().setRollKey({ tonic: tonicName(Number(pc), mode as RollKeyMode), mode: mode as RollKeyMode });
        }}
        className={`${FIELD_SELECT} max-w-36`}
      >
        <option value="auto">{read ? `Auto: ${rollKeyName(read)}` : 'Auto'}</option>
        {(['major', 'minor'] as const).map((mode) => (
          <optgroup key={mode} label={mode === 'major' ? 'Major' : 'Minor'}>
            {ROLL_KEY_TONICS.map((_, pc) => (
              <option key={`${pc}:${mode}`} value={`${pc}:${mode}`}>{`${tonicName(pc, mode)} ${mode}`}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
};

/** One figure field: its draft while typed, written on blur or Enter, put back on Escape. */
const FigureField: React.FC<{ id: string; tick: number; figure: string; label: string; left: number; width: number }> = ({ id, tick, figure, label, left, width }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    usePianoRollStore.getState().setFigure(tick, draft);
    setDraft(null);
  };
  return (
    <>
      <label htmlFor={id} className="sr-only">{label}</label>
      <input
        id={id}
        name={id}
        type="text"
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        maxLength={12}
        value={draft ?? figure}
        placeholder="·"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') setDraft(null);
        }}
        title={label}
        data-figure-tick={tick}
        className="absolute top-0.5 h-5 px-1 rounded-xs bg-black/50 border border-white/10 text-[12px] font-bold leading-none et-ink text-center tabular-nums outline-none focus:border-[rgb(var(--et-accent)/0.8)] placeholder:text-white/25"
        style={{ left, width }}
      />
    </>
  );
};

/** The lane. `win` is the steps in view (with the grid's overscan). */
export const FiguredBassLane: React.FC<{ stepPx: number; totalSteps: number; win: { from: number; to: number } }> = ({ stepPx, totalSteps, win }) => {
  const notes = usePianoRollStore((s) => s.notes);
  const part = usePianoRollStore((s) => activeTrackOf(s));
  const meterMap = usePianoRollStore((s) => s.meterMap);
  const pickupSteps = usePianoRollStore((s) => s.pickupSteps);
  const [busy, setBusy] = useState(false);
  const width = Math.max(1, totalSteps * stepPx);

  // The bass line's onsets: the lowest note starting at each tick.
  const onsets = useMemo(() => {
    const low = new Map<number, number>();
    for (const n of notes) {
      const tick = n.tick ?? Math.round(n.step * TICKS_PER_STEP);
      const at = low.get(tick);
      if (at === undefined || n.note < at) low.set(tick, n.note);
    }
    return [...low.entries()].sort((a, b) => a[0] - b[0]);
  }, [notes]);
  const figures = useMemo(() => new Map((part.figuredBass ?? []).map((m) => [m.tick, m.figure])), [part.figuredBass]);

  // Each onset in view gets a field when it has room after the one before.
  const { fields, crowded } = useMemo(() => {
    const out: Array<{ tick: number; note: number; left: number; width: number }> = [];
    let right = -Infinity;
    let skipped = 0;
    for (let i = 0; i < onsets.length; i += 1) {
      const [tick, note] = onsets[i];
      const step = tick / TICKS_PER_STEP;
      if (step < win.from - 8 || step > win.to) continue;
      const left = step * stepPx;
      const next = i + 1 < onsets.length ? (onsets[i + 1][0] / TICKS_PER_STEP) * stepPx : Infinity;
      if (left < right + 2) {
        skipped += 1;
        continue;
      }
      const w = Math.max(FIELD_MIN_PX, Math.min(FIELD_MAX_PX, next - left - 2));
      out.push({ tick, note, left, width: w });
      right = left + w;
    }
    return { fields: out, crowded: skipped };
  }, [onsets, win, stepPx]);

  const placeOf = (tick: number): string => {
    const step = tick / TICKS_PER_STEP;
    const bar = barAt(meterMap, step, pickupSteps);
    const beat = Math.floor((step - bar.start) / (16 / bar.meter.den) + 1e-9) + 1;
    return bar.bar < 0 ? `the pickup, beat ${beat}` : `bar ${bar.bar + 1}, beat ${beat}`;
  };

  const realize = async () => {
    setBusy(true);
    try {
      await realizeRollFiguredBass();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 border-t border-white/8 bg-black/30" data-figured-bass-lane="" style={{ width, minWidth: '100%' }}>
      <div className="sticky left-0 w-max h-6.5 flex items-center gap-1.5 px-1.5">
        <span className={FIELD_LEGEND}>Figures</span>
        <span className="text-[12px] font-semibold et-ink-2 whitespace-nowrap">{part.name}</span>
        <RollKeyPicker />
        <button
          type="button"
          onClick={() => {
            if (!busy) void realize();
          }}
          disabled={notes.length === 0}
          aria-disabled={busy || undefined}
          aria-label={`Realize the figured bass of ${part.name} in four parts`}
          title="Write soprano, alto and tenor over this bass line from its figures, in the roll's key (one undo step)"
          className={`${MINI_WORD_KEY} gap-1 ${busy ? KEY_ON : KEY_REST}`}
        >
          <Wand2 aria-hidden="true" className={`w-3 h-3 ${busy ? 'animate-pulse' : ''}`} />
          Realize
        </button>
        {crowded > 0 && (
          <span className="text-[12px] font-semibold et-ink-3 whitespace-nowrap">Zoom in to write every figure</span>
        )}
        {notes.length === 0 && <span className="text-[12px] font-semibold et-ink-3 whitespace-nowrap">The part has no notes to figure</span>}
      </div>
      <div className="relative h-6" role="group" aria-label={`Figures under ${part.name}'s notes`}>
        {fields.map((f) => (
          <FigureField
            key={`${part.id}-${f.tick}`}
            id={`roll-figure-${f.tick}`}
            tick={f.tick}
            figure={figures.get(f.tick) ?? ''}
            label={`Figure under ${noteLabel(f.note)} at ${placeOf(f.tick)}`}
            left={f.left}
            width={f.width}
          />
        ))}
      </div>
    </div>
  );
};

/**
 * FIGURES: opens the figured-bass lane under the grid. It latches like BEND,
 * and counts the part's figures so a part with figures says so with the lane closed.
 */
export const PianoRollFiguresKey: React.FC = () => {
  const on = usePianoRollStore((s) => s.showFiguredBass);
  const count = usePianoRollStore((s) => activeTrackOf(s).figuredBass?.length ?? 0);
  return (
    <StripKey
      on={on}
      aria-pressed={on}
      onClick={() => usePianoRollStore.getState().setShowFiguredBass(!on)}
      iconOnly
      aria-label="Figures"
      legend="Figures"
      icon={<Hash className={STRIP_GLYPH} />}
      description={
        count > 0
          ? `Figured bass lane under the grid: ${count} figure${count === 1 ? '' : 's'} under this part, the key and REALIZE`
          : 'Figured bass lane under the grid: write figures under this part and REALIZE them in four parts'
      }
    />
  );
};
