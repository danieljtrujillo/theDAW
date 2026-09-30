/**
 * TuningControl — the project tuning (state/tuningStore): A4's pitch, the
 * temperament and the pitch class it is laid from, and a Scala .scl import.
 * A button shows the tuning in a few words; it opens a panel with the
 * controls. Every voice follows a change at once: the soundfont synths, the
 * procedural voices, renders and MIDI exports.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { Tally5 } from 'lucide-react';
import { PITCH_CLASS_NAMES, REFERENCE_PITCHES, TEMPERAMENTS, type TemperamentId } from '../../lib/tuning';
import { useTuningStore } from '../../state/tuningStore';

const field = 'rounded border border-white/10 bg-black/40 px-1.5 py-0.5 text-xs font-bold text-zinc-100 outline-none focus:border-purple-400/60';
const btn =
  'rounded border px-2 py-0.5 text-xs font-bold uppercase tracking-wider transition-colors disabled:opacity-40 disabled:pointer-events-none';

/** The tuning in a few words: "A=415 · Werckmeister III". */
export function tuningSummary(t: ReturnType<typeof useTuningStore.getState>['tuning']): string {
  const hz = Number.isInteger(t.referenceHz) ? String(t.referenceHz) : t.referenceHz.toFixed(1);
  const temperament =
    t.temperament === 'scala' ? t.scala?.name.replace(/\.scl$/i, '') ?? 'Scala' : TEMPERAMENTS.find((x) => x.id === t.temperament)?.label ?? 'Equal';
  return `A=${hz} · ${t.temperament === 'equal' ? 'Equal' : temperament}`;
}

export const TuningControl: React.FC = () => {
  const uid = useId().replace(/:/g, '');
  const tuning = useTuningStore((s) => s.tuning);
  const scalaError = useTuningStore((s) => s.scalaError);
  const [open, setOpen] = useState(false);
  // What is typed in the Hz field, committed on Enter or when the field loses focus.
  const [hzDraft, setHzDraft] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

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

  const presetHz = REFERENCE_PITCHES.some((r) => r.hz === tuning.referenceHz) ? String(tuning.referenceHz) : 'custom';
  const store = useTuningStore.getState;

  const onScala = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    store().importScala(await file.text(), file.name);
  };

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={`${uid}-panel`}
        aria-label={`Project tuning: ${tuningSummary(tuning)}`}
        title="Project tuning: the pitch of A and the temperament every instrument plays in"
        className="flex items-center gap-1 px-1 py-0.5 rounded text-xs font-bold text-purple-200 hover:bg-purple-500/10 whitespace-nowrap"
      >
        <Tally5 aria-hidden="true" className="size-3" />
        A={Number.isInteger(tuning.referenceHz) ? tuning.referenceHz : tuning.referenceHz.toFixed(1)}
      </button>
      {open && (
        <div
          ref={panelRef}
          id={`${uid}-panel`}
          role="dialog"
          aria-labelledby={`${uid}-title`}
          className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-white/10 bg-zinc-900 p-3 flex flex-col gap-2 shadow-2xl"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
              buttonRef.current?.focus();
            }
          }}
        >
          <h2 id={`${uid}-title`} className="text-xs font-bold uppercase tracking-wider text-zinc-200">Project tuning</h2>
          <div className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-2 gap-y-2">
            <label htmlFor={`${uid}-ref`} className="text-xs font-bold text-zinc-400">Pitch of A</label>
            <select
              id={`${uid}-ref`}
              name="tuning-reference"
              value={presetHz}
              onChange={(e) => e.target.value !== 'custom' && store().setReference(Number(e.target.value))}
              className={field}
              style={{ colorScheme: 'dark' }}
            >
              {REFERENCE_PITCHES.map((r) => (
                <option key={r.hz} value={r.hz}>{r.label}</option>
              ))}
              <option value="custom">Other…</option>
            </select>

            <label htmlFor={`${uid}-hz`} className="text-xs font-bold text-zinc-400">A in Hz</label>
            <input
              id={`${uid}-hz`}
              name="tuning-reference-hz"
              type="number"
              min={380}
              max={480}
              step={0.1}
              value={hzDraft ?? String(tuning.referenceHz)}
              onChange={(e) => setHzDraft(e.target.value)}
              onBlur={() => {
                const v = Number(hzDraft);
                if (hzDraft !== null && Number.isFinite(v) && v >= 380 && v <= 480) store().setReference(v);
                setHzDraft(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              title="380 to 480 Hz"
              className={`${field} w-24 tabular-nums`}
            />

            <label htmlFor={`${uid}-temperament`} className="text-xs font-bold text-zinc-400">Temperament</label>
            <select
              id={`${uid}-temperament`}
              name="tuning-temperament"
              value={tuning.temperament}
              onChange={(e) => store().setTemperament(e.target.value as TemperamentId)}
              className={field}
              style={{ colorScheme: 'dark' }}
            >
              {TEMPERAMENTS.filter((t) => t.id !== 'scala' || tuning.scala).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id === 'scala' && tuning.scala ? `Scala: ${tuning.scala.name}` : t.label}
                </option>
              ))}
            </select>

            <label htmlFor={`${uid}-root`} className="text-xs font-bold text-zinc-400">Laid from</label>
            <select
              id={`${uid}-root`}
              name="tuning-root"
              value={tuning.root}
              disabled={tuning.temperament === 'equal'}
              onChange={(e) => store().setRoot(Number(e.target.value))}
              title="The pitch class the temperament is built on, and a Scala scale's tonic"
              className={field}
              style={{ colorScheme: 'dark' }}
            >
              {PITCH_CLASS_NAMES.map((n, i) => (
                <option key={n} value={i}>{n}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <input
              id={`${uid}-scl`}
              name="tuning-scala-file"
              type="file"
              accept=".scl"
              onChange={(e) => void onScala(e)}
              className="sr-only"
            />
            <label htmlFor={`${uid}-scl`} className={`${btn} cursor-pointer border-purple-500/40 text-purple-200 hover:bg-purple-500/15`}>
              Import Scala .scl…
            </label>
            {tuning.temperament === 'scala' && tuning.scala && (
              <span className="min-w-0 truncate text-xs font-bold text-zinc-400" title={tuning.scala.description}>
                {`${tuning.scala.cents.length} notes`}
              </span>
            )}
          </div>
          {tuning.temperament === 'scala' && tuning.scala?.description && (
            <p className="text-xs font-bold text-zinc-400">{tuning.scala.description}</p>
          )}
          {scalaError && (
            <p role="alert" className="text-xs font-bold text-red-300">{scalaError}</p>
          )}
          <p className="text-xs font-bold text-zinc-500">Saved with the project, written into exported MIDI files. Drum kits keep their own pitch.</p>
        </div>
      )}
    </div>
  );
};
