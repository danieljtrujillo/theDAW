/**
 * EditTimeMapPanel — the EDIT arrangement's meter map and tempo map, as a list
 * a person can read and edit: every meter change (bar, beats, unit, groups),
 * every tempo change (bar, quarter notes into the bar, BPM, hold or ramp) and
 * every fermata (hold length and stretch), with add and remove, and the
 * selected MIDI clip's maps offered for adoption.
 *
 * It renders the panel's content only; WaveformEditor puts it in its popover.
 * Every write goes through an editorStore action, so each edit is an undo step
 * and reaches the grid, the ruler, snap, bar seeks, the click, autosave and
 * the .tasmo save.
 *
 * Fields commit on Enter or when they lose focus, as the toolbar's BPM field
 * does, so the "1" of a typed 140 is never applied on its own; Escape drops a
 * typed value. A value the maps cannot hold is refused with a reason in the
 * panel's alert line, and the field goes back to what the map holds.
 */
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { beginUndoStep, useEditorStore } from '../../state/editorStore';
import { editClock, editBarAtSec, editBarStartSec, editBarPosToBeat, editBeatToBarPos, editBpmText, editMeterLabel, adoptClipTimeMaps, describeClipTime, parseEditMeter, type EditTempoEventKind } from '../../lib/editTimeMap';
import { METER_DENOMINATORS, sanitizeMeter } from '../../lib/meterMap';
import { FERMATA_STRETCH_MAX, FERMATA_STRETCH_MIN, TEMPO_BPM_MAX, TEMPO_BPM_MIN, getTempoAtBeat } from '../../lib/tempoMap';
import { tickBeat } from '../../lib/rollTempo';

/** Which row a ruler flag asked the panel to show first. */
export type TimeMapFocus =
  | { kind: 'meter'; bar: number }
  | { kind: 'tempo'; beat: number; eventKind: EditTempoEventKind }
  | null;

export interface EditTimeMapPanelProps {
  /** The heading's id, for the dialog's aria-labelledby. */
  headingId: string;
  focus?: TimeMapFocus;
  onClose: () => void;
  /** Move the playhead (and, while stopped, the edit cursor) to a second: "Go to bar". */
  onSeek?: (sec: number) => void;
}

/** Timeline seconds as m:ss.cc. */
const clock = (sec: number): string => {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest < 10 ? '0' : ''}${rest.toFixed(2)}`;
};

interface CommitFieldProps {
  id: string;
  name: string;
  label: string;
  value: string;
  onCommit: (text: string) => void;
  type?: 'number' | 'text';
  min?: number;
  max?: number;
  step?: string;
  className?: string;
  title?: string;
  autoFocus?: boolean;
}

/** A field that applies on Enter or blur, and drops a typed value on Escape. */
function CommitField({ id, name, label, value, onCommit, type = 'number', min, max, step, className = '', title, autoFocus }: CommitFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const text = draft;
    setDraft(null);
    if (text !== value) onCommit(text);
  };
  return (
    <>
      <label htmlFor={id} className="sr-only">{label}</label>
      <input
        id={id}
        name={name}
        type={type}
        min={min}
        max={max}
        step={step}
        value={draft ?? value}
        title={title ?? label}
        autoFocus={autoFocus}
        onChange={(e) => {
          // Typing waits for Enter or blur; a spin-button step applies at once.
          if (type === 'number' && !('inputType' in e.nativeEvent)) {
            setDraft(null);
            if (e.target.value !== value) onCommit(e.target.value);
            return;
          }
          setDraft(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape' && draft !== null) {
            e.stopPropagation();
            setDraft(null);
          }
        }}
        className={`rounded border border-white/10 bg-black/40 px-1.5 py-0.5 text-xs font-bold text-zinc-100 tabular-nums outline-none focus:border-purple-400/60 ${className}`}
      />
    </>
  );
}

const btn = 'rounded border px-2 py-0.5 text-xs font-bold uppercase tracking-wider transition-colors disabled:opacity-40 disabled:pointer-events-none';

export function EditTimeMapPanel({ headingId, focus = null, onClose, onSeek }: EditTimeMapPanelProps) {
  const uid = useId().replace(/:/g, '');
  const meterMap = useEditorStore((s) => s.meterMap);
  const tempoMap = useEditorStore((s) => s.tempoMap);
  const editCursorSec = useEditorStore((s) => s.editCursorSec);
  const selectedClipId = useEditorStore((s) => s.selectedClipId);
  const clips = useEditorStore((s) => s.clips);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const maps = useMemo(() => ({ tempoMap, meterMap }), [tempoMap, meterMap]);
  const clk = editClock(tempoMap);
  const cursorBar = editBarAtSec(maps, editCursorSec);
  const [newBar, setNewBar] = useState<string>(() => String(Math.max(2, cursorBar.bar + 1)));
  const [newMeter, setNewMeter] = useState<string>('7/8');
  const [goBar, setGoBar] = useState<string>(() => String(cursorBar.bar + 1));

  // A ruler flag opens the panel on its own row.
  useEffect(() => {
    if (!focus) return;
    const sel = focus.kind === 'meter' ? `[data-meter-bar="${focus.bar}"]` : `[data-tempo-beat="${focus.beat}"][data-tempo-kind="${focus.eventKind}"]`;
    const row = rootRef.current?.querySelector<HTMLElement>(sel);
    row?.scrollIntoView({ block: 'nearest' });
    row?.querySelector<HTMLElement>('input, select, button')?.focus();
  }, [focus]);

  const store = () => useEditorStore.getState();
  const refuse = (msg: string) => setError(msg);
  const ok = () => setError(null);

  /* ── meter rows ─────────────────────────────────────────────────────── */
  const writeMeterRow = (bar: number, patch: { bar?: number; num?: number; den?: number; groups?: number[] }) => {
    const seg = meterMap.find((s) => s.bar === bar);
    if (!seg) return;
    const num = patch.num ?? seg.meter.num;
    const den = patch.den ?? seg.meter.den;
    // A new beat count drops groups that no longer add up to it.
    const groups = patch.groups ?? (seg.meter.groups.reduce((a, b) => a + b, 0) === num ? seg.meter.groups : []);
    const meter = sanitizeMeter({ num, den, groups });
    if (!meter) return refuse(`${num}/${den} is not a meter: beats 1-64 over a unit of 1, 2, 4, 8, 16 or 32.`);
    const target = patch.bar ?? bar;
    if (bar !== 0 && (!Number.isInteger(target) || target < 1)) return refuse('A meter change sits on bar 2 or later; bar 1 always has a meter.');
    if (target !== bar && meterMap.some((s) => s.bar === target)) return refuse(`Bar ${target + 1} already has a meter change. Edit or remove that one.`);
    ok();
    store().setMeterMap([...meterMap.filter((s) => s.bar !== bar), { bar: target, meter }]);
  };

  const addMeter = () => {
    const bar = Math.floor(Number(newBar));
    if (!Number.isFinite(bar) || bar < 1) return refuse('Type the bar the change starts on, 1 or later.');
    const meter = parseEditMeter(newMeter);
    if (!meter) return refuse(`"${newMeter}" is not a meter. Type it as 7/8, or 7/8 3+2+2 with groups that add up to the beats.`);
    ok();
    store().setMeterAt(bar - 1, meter);
  };

  /* ── tempo rows ─────────────────────────────────────────────────────── */
  const moveTempo = (beat: number, kind: EditTempoEventKind, bar: number, beatInBar: number) => {
    if (!Number.isFinite(bar) || bar < 1 || !Number.isFinite(beatInBar) || beatInBar < 0) {
      return refuse('A position is a bar of 1 or more and 0 or more quarter notes into it.');
    }
    const to = editBarPosToBeat(meterMap, bar, beatInBar);
    if (kind === 'tempo' && tempoMap.some((e) => !e.fermata && e.beat === to && e.beat !== beat)) {
      return refuse(`There is already a tempo change at bar ${bar}${beatInBar ? `, ${beatInBar} into it` : ''}.`);
    }
    ok();
    beginUndoStep();
    store().moveTempoEvent(beat, kind, { beat: to });
  };

  const addTempoAtCursor = (kind: EditTempoEventKind) => {
    const beat = tickBeat(Math.max(0, clk.stepAt(Math.max(0, editCursorSec))) / 4);
    if (kind === 'tempo' && beat === 0) return refuse('The start tempo is the first row. Move the edit cursor to where the change goes.');
    const bpm = getTempoAtBeat(clk.map, beat);
    if (kind === 'tempo' && tempoMap.some((e) => !e.fermata && e.beat === beat)) return refuse('There is already a tempo change at the edit cursor.');
    ok();
    store().addTempoEvent(kind === 'fermata' ? { beat, bpm, fermata: { beats: 1, stretch: 2 } } : { beat, bpm, curve: 'step' });
  };

  const numOr = (text: string): number => Number.parseFloat(text);

  /* ── adoption ───────────────────────────────────────────────────────── */
  const selected = clips.find((c) => c.id === selectedClipId && c.sourceKind === 'piano-roll') ?? null;
  const adoptPreview = selected ? adoptClipTimeMaps(maps, selected) : null;

  return (
    <div
      ref={rootRef}
      className="flex flex-col gap-3"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
        <h2 id={headingId} className="text-sm font-bold uppercase tracking-wider text-zinc-200">Meter and tempo</h2>
        <button type="button" onClick={onClose} aria-label="Close meter and tempo" className={`${btn} border-white/10 text-zinc-300 hover:bg-white/10`}>
          Close
        </button>
      </div>

      <p role="alert" className={`min-h-4 text-xs font-bold ${error ? 'text-amber-300' : 'text-zinc-500'}`}>
        {error ?? `Edit cursor: bar ${cursorBar.bar + 1}, ${editMeterLabel(cursorBar.meter)}, ${editBpmText(getTempoAtBeat(clk.map, Math.max(0, clk.stepAt(editCursorSec)) / 4))} BPM`}
      </p>

      {onSeek && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const bar = Math.floor(Number(goBar));
            if (!Number.isFinite(bar) || bar < 1) return refuse('Type a bar of 1 or more to go to.');
            ok();
            onSeek(editBarStartSec(maps, bar - 1));
          }}
        >
          <label htmlFor={`${uid}-go-bar`} className="text-xs font-bold text-zinc-400">Go to bar</label>
          <input
            id={`${uid}-go-bar`}
            name="go-to-bar"
            type="number"
            min={1}
            step="1"
            value={goBar}
            onChange={(e) => setGoBar(e.target.value)}
            className="w-16 rounded border border-white/10 bg-black/40 px-1.5 py-0.5 text-xs font-bold text-zinc-100 tabular-nums"
          />
          <button type="submit" className={`${btn} border-white/15 text-zinc-200 hover:bg-white/10`}>Go</button>
        </form>
      )}

      {/* ── meter ─────────────────────────────────────────────────────── */}
      <section aria-labelledby={`${uid}-meter-h`} className="flex flex-col gap-1.5">
        <h3 id={`${uid}-meter-h`} className="text-xs font-bold uppercase tracking-wider text-purple-300">Meter</h3>
        <div className="grid grid-cols-[3.5rem_3.5rem_4.5rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 text-xs font-bold text-zinc-400" role="presentation">
          <span>Bar</span><span>Beats</span><span>Unit</span><span>Groups</span><span className="sr-only">Remove</span>
        </div>
        <ul className="flex flex-col gap-1">
          {meterMap.map((seg, i) => (
            <li key={seg.bar} data-meter-bar={seg.bar} className="grid grid-cols-[3.5rem_3.5rem_4.5rem_minmax(0,1fr)_auto] items-center gap-x-2">
              {seg.bar === 0 ? (
                <span className="text-xs font-bold text-zinc-300 tabular-nums" title="Bar 1 always has a meter">1</span>
              ) : (
                <CommitField
                  id={`${uid}-meter-bar-${i}`}
                  name={`meter-bar-${i}`}
                  label={`Bar the ${editMeterLabel(seg.meter)} change starts on`}
                  value={String(seg.bar + 1)}
                  min={2}
                  step="1"
                  className="w-full"
                  onCommit={(t) => writeMeterRow(seg.bar, { bar: Math.floor(numOr(t)) - 1 })}
                />
              )}
              <CommitField
                id={`${uid}-meter-num-${i}`}
                name={`meter-num-${i}`}
                label={`Beats per bar from bar ${seg.bar + 1}`}
                value={String(seg.meter.num)}
                min={1}
                max={64}
                step="1"
                className="w-full"
                onCommit={(t) => writeMeterRow(seg.bar, { num: Math.floor(numOr(t)) })}
              />
              <label htmlFor={`${uid}-meter-den-${i}`} className="sr-only">{`Beat unit from bar ${seg.bar + 1}`}</label>
              <select
                id={`${uid}-meter-den-${i}`}
                name={`meter-den-${i}`}
                value={seg.meter.den}
                onChange={(e) => writeMeterRow(seg.bar, { den: Number(e.target.value) })}
                className="rounded border border-white/10 bg-black/40 px-1 py-0.5 text-xs font-bold text-zinc-100"
                style={{ colorScheme: 'dark' }}
              >
                {METER_DENOMINATORS.map((d) => <option key={d} value={d}>{`/${d}`}</option>)}
              </select>
              <CommitField
                id={`${uid}-meter-groups-${i}`}
                name={`meter-groups-${i}`}
                type="text"
                label={`Groups from bar ${seg.bar + 1}, such as 3+2+2; empty for none`}
                value={seg.meter.groups.length > 1 ? seg.meter.groups.join('+') : ''}
                className="w-full"
                onCommit={(t) => {
                  const text = t.trim();
                  if (!text) return writeMeterRow(seg.bar, { groups: [] });
                  const groups = text.split('+').map((g) => Number(g.trim()));
                  if (groups.length < 2 || groups.some((g) => !Number.isInteger(g) || g < 1) || groups.reduce((a, b) => a + b, 0) !== seg.meter.num) {
                    return refuse(`Groups for ${seg.meter.num} beats are whole numbers that add up to ${seg.meter.num}, such as ${seg.meter.num === 7 ? '3+2+2' : `${seg.meter.num - 2}+2`}.`);
                  }
                  writeMeterRow(seg.bar, { groups });
                }}
              />
              {seg.bar === 0 ? (
                <span />
              ) : (
                <button
                  type="button"
                  onClick={() => { ok(); store().removeMeterChange(seg.bar); }}
                  aria-label={`Remove the ${editMeterLabel(seg.meter)} change at bar ${seg.bar + 1}`}
                  className={`${btn} border-white/10 text-zinc-400 hover:text-red-300 hover:border-red-400/40`}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
        <form
          className="flex flex-wrap items-center gap-2 pt-1"
          onSubmit={(e) => { e.preventDefault(); addMeter(); }}
        >
          <label htmlFor={`${uid}-new-meter-bar`} className="text-xs font-bold text-zinc-400">Add at bar</label>
          <input
            id={`${uid}-new-meter-bar`}
            name="new-meter-bar"
            type="number"
            min={1}
            step="1"
            value={newBar}
            onChange={(e) => setNewBar(e.target.value)}
            className="w-16 rounded border border-white/10 bg-black/40 px-1.5 py-0.5 text-xs font-bold text-zinc-100 tabular-nums"
          />
          <label htmlFor={`${uid}-new-meter`} className="text-xs font-bold text-zinc-400">Meter</label>
          <input
            id={`${uid}-new-meter`}
            name="new-meter"
            type="text"
            value={newMeter}
            onChange={(e) => setNewMeter(e.target.value)}
            title="Such as 7/8, 5/4, 3/2, or 7/8 3+2+2"
            className="w-28 rounded border border-white/10 bg-black/40 px-1.5 py-0.5 text-xs font-bold text-zinc-100"
          />
          <button type="submit" className={`${btn} border-purple-500/40 bg-purple-500/15 text-purple-200 hover:bg-purple-500/25`}>Add meter</button>
        </form>
      </section>

      {/* ── tempo ─────────────────────────────────────────────────────── */}
      <section aria-labelledby={`${uid}-tempo-h`} className="flex flex-col gap-1.5">
        <h3 id={`${uid}-tempo-h`} className="text-xs font-bold uppercase tracking-wider text-purple-300">Tempo</h3>
        <div className="grid grid-cols-[3.5rem_4rem_4.5rem_6rem_4rem_auto] items-center gap-x-2 text-xs font-bold text-zinc-400" role="presentation">
          <span>Bar</span><span>Beat</span><span>BPM</span><span>Shape</span><span>Time</span><span className="sr-only">Remove</span>
        </div>
        <ul className="flex flex-col gap-1">
          {tempoMap.map((e, i) => {
            const kind: EditTempoEventKind = e.fermata ? 'fermata' : 'tempo';
            const pos = editBeatToBarPos(meterMap, e.beat);
            const start = kind === 'tempo' && e.beat === 0;
            const at = clk.at(e.beat * 4);
            const where = `bar ${pos.bar}${pos.beatInBar ? `, ${pos.beatInBar} into it` : ''}`;
            return (
              <li key={`${kind}-${e.beat}`} data-tempo-beat={e.beat} data-tempo-kind={kind} className="grid grid-cols-[3.5rem_4rem_4.5rem_6rem_4rem_auto] items-center gap-x-2">
                {start ? (
                  <>
                    <span className="text-xs font-bold text-zinc-300 tabular-nums">1</span>
                    <span className="text-xs font-bold text-zinc-300 tabular-nums">0</span>
                  </>
                ) : (
                  <>
                    <CommitField
                      id={`${uid}-tempo-bar-${i}`}
                      name={`tempo-bar-${i}`}
                      label={`Bar of the ${kind === 'fermata' ? 'fermata' : 'tempo change'} at ${where}`}
                      value={String(pos.bar)}
                      min={1}
                      step="1"
                      className="w-full"
                      onCommit={(t) => moveTempo(e.beat, kind, Math.floor(numOr(t)), pos.beatInBar)}
                    />
                    <CommitField
                      id={`${uid}-tempo-beat-${i}`}
                      name={`tempo-beat-${i}`}
                      label={`Quarter notes into bar ${pos.bar} of the ${kind === 'fermata' ? 'fermata' : 'tempo change'}`}
                      value={String(pos.beatInBar)}
                      min={0}
                      step="any"
                      className="w-full"
                      onCommit={(t) => moveTempo(e.beat, kind, pos.bar, numOr(t))}
                    />
                  </>
                )}
                {kind === 'tempo' ? (
                  <>
                    <CommitField
                      id={`${uid}-tempo-bpm-${i}`}
                      name={`tempo-bpm-${i}`}
                      label={`Tempo at ${where}, ${TEMPO_BPM_MIN}-${TEMPO_BPM_MAX} BPM`}
                      value={editBpmText(e.bpm)}
                      min={TEMPO_BPM_MIN}
                      max={TEMPO_BPM_MAX}
                      step="any"
                      className="w-full"
                      onCommit={(t) => {
                        const v = numOr(t);
                        if (!Number.isFinite(v) || v < TEMPO_BPM_MIN || v > TEMPO_BPM_MAX) return refuse(`A tempo is ${TEMPO_BPM_MIN}-${TEMPO_BPM_MAX} BPM.`);
                        ok();
                        if (start) store().setBpm(v);
                        else store().moveTempoEvent(e.beat, 'tempo', { bpm: v });
                      }}
                    />
                    <label htmlFor={`${uid}-tempo-curve-${i}`} className="sr-only">{`How the tempo at ${where} reaches the next one`}</label>
                    <select
                      id={`${uid}-tempo-curve-${i}`}
                      name={`tempo-curve-${i}`}
                      value={e.curve === 'linear' ? 'linear' : 'step'}
                      onChange={(ev) => { ok(); store().moveTempoEvent(e.beat, 'tempo', { curve: ev.target.value === 'linear' ? 'linear' : 'step' }); }}
                      className="rounded border border-white/10 bg-black/40 px-1 py-0.5 text-xs font-bold text-zinc-100"
                      style={{ colorScheme: 'dark' }}
                    >
                      <option value="step">Hold</option>
                      <option value="linear">Ramp to next</option>
                    </select>
                  </>
                ) : (
                  <>
                    <CommitField
                      id={`${uid}-fermata-beats-${i}`}
                      name={`fermata-beats-${i}`}
                      label={`Quarter notes the fermata at ${where} holds`}
                      value={String(e.fermata?.beats ?? 1)}
                      min={0}
                      step="any"
                      className="w-full"
                      title="Held quarter notes"
                      onCommit={(t) => {
                        const v = numOr(t);
                        if (!Number.isFinite(v) || v <= 0) return refuse('A fermata holds more than 0 quarter notes.');
                        ok();
                        store().moveTempoEvent(e.beat, 'fermata', { fermata: { beats: v, stretch: e.fermata?.stretch ?? 2 } });
                      }}
                    />
                    <CommitField
                      id={`${uid}-fermata-stretch-${i}`}
                      name={`fermata-stretch-${i}`}
                      label={`How many times longer each held beat of the fermata at ${where} lasts, ${FERMATA_STRETCH_MIN}-${FERMATA_STRETCH_MAX}`}
                      value={String(e.fermata?.stretch ?? 2)}
                      min={FERMATA_STRETCH_MIN}
                      max={FERMATA_STRETCH_MAX}
                      step="any"
                      className="w-full"
                      title="Stretch"
                      onCommit={(t) => {
                        const v = numOr(t);
                        if (!Number.isFinite(v) || v < FERMATA_STRETCH_MIN || v > FERMATA_STRETCH_MAX) return refuse(`A fermata stretches each beat ${FERMATA_STRETCH_MIN}-${FERMATA_STRETCH_MAX} times.`);
                        ok();
                        store().moveTempoEvent(e.beat, 'fermata', { fermata: { beats: e.fermata?.beats ?? 1, stretch: v } });
                      }}
                    />
                  </>
                )}
                <span className="text-xs font-bold text-zinc-400 tabular-nums">{clock(at)}</span>
                {start ? (
                  <span />
                ) : (
                  <button
                    type="button"
                    onClick={() => { ok(); store().removeTempoEvent(e.beat, kind); }}
                    aria-label={`Remove the ${kind === 'fermata' ? 'fermata' : `${editBpmText(e.bpm)} BPM change`} at ${where}`}
                    className={`${btn} border-white/10 text-zinc-400 hover:text-red-300 hover:border-red-400/40`}
                  >
                    Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <button type="button" onClick={() => addTempoAtCursor('tempo')} className={`${btn} border-purple-500/40 bg-purple-500/15 text-purple-200 hover:bg-purple-500/25`}>
            Add tempo change at edit cursor
          </button>
          <button type="button" onClick={() => addTempoAtCursor('fermata')} className={`${btn} border-white/15 text-zinc-200 hover:bg-white/10`}>
            Add fermata at edit cursor
          </button>
        </div>
      </section>

      {/* ── from a clip ───────────────────────────────────────────────── */}
      <section aria-labelledby={`${uid}-adopt-h`} className="flex flex-col gap-1.5 border-t border-white/10 pt-2">
        <h3 id={`${uid}-adopt-h`} className="text-xs font-bold uppercase tracking-wider text-purple-300">From a MIDI clip</h3>
        {selected ? (
          <>
            <p className="text-xs font-bold text-zinc-300">
              {`"${selected.label}": ${describeClipTime(selected)}.`}
              {adoptPreview && !adoptPreview.ok ? ` ${adoptPreview.error}` : ''}
              {adoptPreview && adoptPreview.ok && !adoptPreview.changes ? ' The arrangement already follows it.' : ''}
            </p>
            <button
              type="button"
              disabled={!adoptPreview || !adoptPreview.ok || !adoptPreview.changes}
              onClick={() => {
                const res = store().adoptClipTimeMaps(selected.id);
                if (!res.ok) refuse(res.error);
                else ok();
              }}
              className={`${btn} self-start border-purple-500/40 bg-purple-500/15 text-purple-200 hover:bg-purple-500/25`}
            >
              {adoptPreview && adoptPreview.ok ? `Use its tempo and meter from ${clock(adoptPreview.anchorSec)}` : 'Use its tempo and meter'}
            </button>
          </>
        ) : (
          <p className="text-xs font-bold text-zinc-500">Select a MIDI clip to take its tempo and meter into the arrangement from its first bar.</p>
        )}
      </section>
    </div>
  );
}
