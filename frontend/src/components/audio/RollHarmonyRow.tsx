/**
 * The piano roll's HARMONY row: a row over the ruler that shows the roll's
 * last voice-leading answer (pianoRollStore `voiceLeading`) and the roman
 * figures of the last plan, realized figured bass or form written into it
 * (`harmonyChords`), each at its bar and beat.
 *
 *   - a flag is a marker button at its tick: its rule and message open in a
 *     tip on hover and focus, and a click (or Enter) selects the notes it is
 *     about (pianoRollStore selectFlagNotes) and moves the playhead there
 *   - a figure is text at its chord's tick, after the flags there
 *   - when a checked part has changed since, the markers read dashed and say so
 *
 * The keyboard column's corner beside the row (RollHarmonyCorner) runs the
 * check and hides the row. PianoRollHarmonyKey opens and closes it from the
 * dock's strip, and runRollVoiceLeadingCheck is the check with its log lines,
 * for any key or menu that runs it.
 */
import React, { useId, useMemo, useState } from 'react';
import { ListChecks, TriangleAlert, X } from 'lucide-react';
import { rollTracksOf, usePianoRollStore, type VoiceLeadingCheckOptions } from '../../state/pianoRollStore';
import type { VoiceLeadingFlag } from '../../lib/composerClient';
import { rollKeyName } from '../../lib/rollKey';
import { logError, logInfo } from '../../state/logStore';
import { KEY_ON, KEY_REST, MINI_ICON_KEY, STRIP_GLYPH, StripKey } from './midiDockKit';

/** The row's height: 12px bold figures and 20px markers with room around them. */
export const HARMONY_ROW_HEIGHT = 24;
/** Each flag's marker is this wide (px); figures at a flagged tick start after the markers. */
const MARKER_PX = 18;
const TICKS_PER_STEP = 240;

/** "Parallel fifths" for 'parallel_fifths'. */
export const ruleLabel = (rule: string): string => {
  const text = rule.replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** Where a flag stands, as the tip and the marker's name say it: "bar 3, beat 2" (the pickup before bar 1). */
const placeText = (f: Pick<VoiceLeadingFlag, 'bar' | 'beat'>): string => (f.bar < 0 ? `the pickup, beat ${f.beat}` : `bar ${f.bar + 1}, beat ${f.beat}`);

/** True when a part the last answer read has different notes now. */
const useStale = (): boolean =>
  usePianoRollStore((s) => {
    const vl = s.voiceLeading;
    if (!vl) return false;
    const parts = rollTracksOf(s);
    return Object.entries(vl.notesAt).some(([id, at]) => parts.find((p) => p.id === id)?.notes !== at);
  });

/**
 * Run the voice-leading check (pianoRollStore runVoiceLeadingCheck) and say
 * what it found in the log: the count and the first flags, or why it could not run.
 */
export async function runRollVoiceLeadingCheck(opts?: VoiceLeadingCheckOptions): Promise<void> {
  try {
    const res = await usePianoRollStore.getState().runVoiceLeadingCheck(opts);
    const vl = usePianoRollStore.getState().voiceLeading;
    const names = vl ? Object.keys(vl.ids).join(', ') : '';
    const key = vl ? rollKeyName(vl.key) : '';
    if (res.count === 0) logInfo('piano-roll', `Voice leading: no flags in ${names} (${key})`);
    else {
      const first = res.flags.slice(0, 3).map((f) => `${ruleLabel(f.rule)} at ${placeText(f)}`).join('; ');
      logInfo('piano-roll', `Voice leading: ${res.count} flag${res.count === 1 ? '' : 's'} in ${names} (${key}): ${first}${res.count > 3 ? ' ...' : ''}`);
    }
  } catch (e) {
    logError('piano-roll', `Voice-leading check failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The row over the ruler. `top` is where it sticks in the grid's scroll box. */
export const RollHarmonyRow: React.FC<{ stepPx: number; totalSteps: number; win: { from: number; to: number }; top?: number }> = ({
  stepPx,
  totalSteps,
  win,
  top = 0,
}) => {
  const vl = usePianoRollStore((s) => s.voiceLeading);
  const chords = usePianoRollStore((s) => s.harmonyChords);
  const stale = useStale();
  const [tip, setTip] = useState<number | null>(null);
  const tipId = useId();
  const width = Math.max(1, totalSteps * stepPx);
  const flags = vl?.flags ?? [];

  // Flags by tick, in order, so the markers of one tick stand side by side.
  const byTick = useMemo(() => {
    const m = new Map<number, number[]>();
    flags.forEach((f, i) => m.set(f.tick, [...(m.get(f.tick) ?? []), i]));
    return m;
  }, [flags]);
  const inView = (tick: number) => {
    const step = tick / TICKS_PER_STEP;
    return step >= win.from - 8 && step <= win.to;
  };
  const shownChords = chords.filter((c) => inView(c.tick));
  const shownTicks = [...byTick.keys()].filter(inView);
  const tipFlag = tip !== null ? flags[tip] : undefined;

  return (
    <div
      data-roll-harmony=""
      role="group"
      aria-label={
        flags.length
          ? `Harmony row: ${flags.length} voice-leading flag${flags.length === 1 ? '' : 's'}${stale ? ', the parts changed since the check' : ''}`
          : 'Harmony row'
      }
      className="sticky z-25 border-b border-white/5 bg-[#0c0a12]"
      style={{ top, height: HARMONY_ROW_HEIGHT, width, minWidth: '100%' }}
    >
      {shownChords.map((c) => {
        const x = (c.tick / TICKS_PER_STEP) * stepPx + (byTick.get(c.tick)?.length ?? 0) * MARKER_PX + 3;
        return (
          <span
            key={`c${c.tick}`}
            className="absolute top-1 text-[12px] font-bold leading-none et-ink whitespace-nowrap pointer-events-none"
            style={{ left: x }}
            title={c.key ? `${c.figure} in ${c.key}` : c.figure}
          >
            {c.figure}
          </span>
        );
      })}
      {shownTicks.map((tick) =>
        (byTick.get(tick) ?? []).map((i, k) => {
          const f = flags[i];
          const name = `${ruleLabel(f.rule)} at ${placeText(f)}: ${f.message}. Select its notes${stale ? '. The parts changed since the check' : ''}`;
          return (
            <button
              key={`f${i}`}
              type="button"
              data-harmony-flag=""
              aria-label={name}
              aria-describedby={tip === i ? tipId : undefined}
              onClick={() => usePianoRollStore.getState().selectFlagNotes(f)}
              onPointerEnter={() => setTip(i)}
              onPointerLeave={() => setTip((t) => (t === i ? null : t))}
              onFocus={() => setTip(i)}
              onBlur={() => setTip((t) => (t === i ? null : t))}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setTip(null);
              }}
              className={`absolute top-0.5 h-5 w-4 inline-flex items-center justify-center rounded-xs text-amber-300 outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--et-accent))] ${
                stale ? 'border border-dashed border-amber-300/60 bg-transparent' : 'bg-amber-400/15 hover:bg-amber-400/30'
              }`}
              style={{ left: (tick / TICKS_PER_STEP) * stepPx + k * MARKER_PX }}
            >
              <TriangleAlert aria-hidden="true" className="w-3 h-3" strokeWidth={2.5} />
            </button>
          );
        }),
      )}
      {tipFlag && tip !== null && (
        <div
          id={tipId}
          role="tooltip"
          className="absolute z-40 max-w-80 px-2 py-1.5 rounded-xs border border-white/15 bg-[#14111c] shadow-lg pointer-events-none"
          style={{ top: HARMONY_ROW_HEIGHT + 2, left: Math.max(0, (tipFlag.tick / TICKS_PER_STEP) * stepPx - 8) }}
        >
          <div className="text-[12px] font-bold leading-snug et-ink">{ruleLabel(tipFlag.rule)}</div>
          <div className="text-[12px] font-semibold leading-snug et-ink-2">{tipFlag.message}</div>
          <div className="text-[12px] font-semibold leading-snug et-ink-3">
            {placeText(tipFlag)} · {tipFlag.parts.join(', ')}
            {stale ? ' · the parts changed since the check' : ''}
          </div>
        </div>
      )}
    </div>
  );
};

/** The keyboard column's corner beside the harmony row: CHECK runs the check, the count says what it found, X hides the row. */
export const RollHarmonyCorner: React.FC = () => {
  const count = usePianoRollStore((s) => s.voiceLeading?.flags.length ?? null);
  const stale = useStale();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await runRollVoiceLeadingCheck();
    } finally {
      setBusy(false);
    }
  };
  const found = count === null ? 'not checked yet' : `${count} flag${count === 1 ? '' : 's'}${stale ? ', parts changed since' : ''}`;
  return (
    <div className="h-full flex items-center justify-between gap-0.5 px-0.5">
      <button
        type="button"
        onClick={() => {
          if (!busy) void run();
        }}
        aria-disabled={busy || undefined}
        aria-label={`Check voice leading: ${busy ? 'checking' : found}`}
        title="Check the roll's parts for parallel fifths and octaves, crossings, spacing, range and unresolved tendency tones"
        className={`${MINI_ICON_KEY} ${busy ? KEY_ON : KEY_REST}`}
      >
        <ListChecks aria-hidden="true" className={`w-3 h-3 ${busy ? 'animate-pulse' : ''}`} />
      </button>
      <span aria-hidden="true" className={`text-[12px] font-bold tabular-nums leading-none ${count ? 'text-amber-300' : 'et-ink-3'}`}>
        {count ?? '–'}
      </span>
      <button
        type="button"
        onClick={() => usePianoRollStore.getState().setShowHarmony(false)}
        aria-label="Hide the harmony row"
        title="Hide the harmony row (the HARMONY key or the note menu opens it again)"
        className={`${MINI_ICON_KEY} ${KEY_REST}`}
      >
        <X aria-hidden="true" className="w-3 h-3" />
      </button>
    </div>
  );
};

/**
 * HARMONY: opens the harmony row over the ruler. It latches like BEND, and
 * counts the last check's flags so a roll with flags says so with the row closed.
 */
export const PianoRollHarmonyKey: React.FC = () => {
  const on = usePianoRollStore((s) => s.showHarmony);
  const count = usePianoRollStore((s) => s.voiceLeading?.flags.length ?? 0);
  return (
    <StripKey
      on={on}
      aria-pressed={on}
      onClick={() => usePianoRollStore.getState().setShowHarmony(!on)}
      legend="Harmony"
      icon={<ListChecks className={STRIP_GLYPH} />}
      description={
        count > 0
          ? `Harmony row over the ruler: ${count} voice-leading flag${count === 1 ? '' : 's'} and the plan's roman figures`
          : "Harmony row over the ruler: voice-leading flags and the plan's roman figures, with a CHECK key"
      }
    />
  );
};
