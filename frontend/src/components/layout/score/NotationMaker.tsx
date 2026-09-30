/**
 * The SCORE tab's maker: pick an instrument, pick how to write it, press MAKE.
 *
 * One form stands in for the four makers the backend has (a sheet written
 * straight from a MIDI, tablature, an arrangement, a chord track). The
 * instrument decides which ways are offered and which stem's MIDI is read;
 * notationMakerModel.ts turns the choice into the one request it needs.
 *
 * A band score lists every stem MIDI with the orchestral instrument its staff
 * is written for (lib/orchestra.ts, the registry the backend builds the part
 * on): the staff's name, clef, transposition and place in score order all
 * come from that pick.
 */
import React, { useEffect, useId, useMemo, useState } from 'react';
import { Drum, Guitar, Loader2, MicVocal, Piano, Users } from 'lucide-react';
import {
  convertMidiToMusicXml,
  makeArrangement,
  makeChordTrack,
  makeTabs,
  type NotationArtifact,
  type NotationCapabilities,
} from '../../../lib/notationClient';
import { logError, logInfo } from '../../../state/logStore';
import { describeInstrument, orchestraByFamily, orchestraInstrument } from '../../../lib/orchestra';
import {
  DIFFICULTIES,
  INSTRUMENT_NAMES,
  MAKER_INSTRUMENTS,
  needsMidi,
  pickSource,
  planFor,
  staffInstrumentValue,
  stemOf,
  tuningsFor,
  WAY_HINTS,
  WAY_NAMES,
  wayAfterInstrumentChange,
  WAYS_FOR,
  type Difficulty,
  type MakerInstrument,
  type MakerWay,
} from './notationMakerModel';

const DEFAULT_TUNINGS = [
  'bass-5-string',
  'bass-standard',
  'guitar-7-string',
  'guitar-drop-d',
  'guitar-standard',
  'ukulele-standard',
];

const ICONS: Record<MakerInstrument, React.ReactNode> = {
  piano: <Piano className="size-4" aria-hidden="true" />,
  voice: <MicVocal className="size-4" aria-hidden="true" />,
  guitar: <Guitar className="size-4" aria-hidden="true" />,
  bass: <Guitar className="size-4" aria-hidden="true" />,
  ukulele: <Guitar className="size-4" aria-hidden="true" />,
  drums: <Drum className="size-4" aria-hidden="true" />,
  band: <Users className="size-4" aria-hidden="true" />,
};

/** "guitar-drop-d" -> "Drop D", "bass-5-string" -> "5 string". */
const tuningName = (t: string): string => {
  const rest = t.replace(/^(guitar|bass|ukulele)-/, '').replace(/-/g, ' ');
  return rest.replace(/\b(d)\b/, 'D').replace(/^\w/, (c) => c.toUpperCase());
};

const LABEL = 'font-display text-xs font-bold uppercase text-zinc-500';
const FIELD = 'form-select h-7 w-full px-1.5 text-xs font-bold';
// Every registry instrument, grouped by family in score order, for the staff pickers.
const ORCHESTRA_GROUPS = orchestraByFamily();

const TILE =
  'rounded border flex items-center justify-center gap-1 text-xs font-bold transition-colors outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--et-accent)/0.6)]';
const TILE_ON = 'border-[rgb(var(--et-accent)/0.55)] bg-[rgb(var(--et-accent)/0.15)] et-accent-legend';
const TILE_OFF = 'border-white/10 text-zinc-400 hover:border-white/25 hover:text-zinc-100';

export interface NotationMakerProps {
  entryId: string | null;
  /** The song's MIDI artifacts, one per transcribed stem. */
  midis: NotationArtifact[];
  caps: NotationCapabilities | null;
  /** A new artifact exists; the way it was written tells the caller which view to open. */
  onMade: (artifact: NotationArtifact | null, way: MakerWay) => void;
}

export const NotationMaker: React.FC<NotationMakerProps> = ({ entryId, midis, caps, onMade }) => {
  const uid = useId();
  const [instrument, setInstrument] = useState<MakerInstrument>('guitar');
  const [way, setWay] = useState<MakerWay>('tab');
  const [sourceId, setSourceId] = useState('');
  const [tuning, setTuning] = useState('guitar-standard');
  const [capo, setCapo] = useState(0);
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [busy, setBusy] = useState(false);
  // The band score's instrument picks by artifact id; '' keeps the stem's name.
  const [staffPicks, setStaffPicks] = useState<Record<string, string>>({});

  const tunings = useMemo(
    () => tuningsFor(instrument, caps?.tab_tunings ?? DEFAULT_TUNINGS),
    [instrument, caps],
  );
  // The picked MIDI while it is still one of this song's; else the
  // instrument's own stem.
  const source = midis.find((m) => m.id === sourceId) ?? pickSource(instrument, midis);

  // A new song, or a new instrument, re-picks the stem and the tuning.
  useEffect(() => {
    setSourceId('');
  }, [entryId, instrument]);
  // A new song starts from each stem's own instrument again.
  useEffect(() => {
    setStaffPicks({});
  }, [entryId]);
  useEffect(() => {
    if (tunings.length && !tunings.includes(tuning)) {
      setTuning(tunings.find((t) => t.endsWith('-standard')) ?? tunings[0]);
    }
  }, [tunings, tuning]);

  const plan = planFor({ instrument, way, source, midis, tuning, capo, difficulty, staffInstruments: staffPicks });
  const blocked = 'error' in plan ? plan.error : null;

  const chooseInstrument = (next: MakerInstrument) => {
    setInstrument(next);
    setWay((w) => wayAfterInstrumentChange(next, w));
  };

  const make = async () => {
    if (!entryId || 'error' in plan) return;
    setBusy(true);
    const what = `${INSTRUMENT_NAMES[instrument]} ${WAY_NAMES[way].toLowerCase()}`;
    try {
      let artifact: NotationArtifact | null;
      switch (plan.route) {
        case 'from-midi':
          artifact = await convertMidiToMusicXml(entryId, plan.midiId);
          break;
        case 'tabs':
          artifact = await makeTabs(entryId, plan.req);
          break;
        case 'arrange':
          artifact = await makeArrangement(entryId, plan.req);
          break;
        case 'chords':
          artifact = await makeChordTrack(entryId, { source: 'auto' });
          break;
      }
      logInfo('score', `Made ${what}${source && needsMidi(way) && way !== 'score' ? ` from the ${stemOf(source)} MIDI` : ''}`);
      onMade(artifact, way);
    } catch (e) {
      logError('score', `Could not make ${what}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const showSource = needsMidi(way) && way !== 'score' && midis.length > 0;
  const showStaves = way === 'score' && midis.length > 0;

  return (
    <div className="flex flex-col gap-3 border-b border-white/10 p-3 text-xs font-bold">
      <div className="flex flex-col gap-1.5">
        <span id={`${uid}-inst`} className={LABEL}>Instrument</span>
        <div role="group" aria-labelledby={`${uid}-inst`} className="grid grid-cols-4 gap-1">
          {MAKER_INSTRUMENTS.map((inst) => (
            <button
              key={inst}
              type="button"
              className={`${TILE} h-12 flex-col ${instrument === inst ? TILE_ON : TILE_OFF}`}
              onClick={() => chooseInstrument(inst)}
              aria-pressed={instrument === inst}
            >
              {ICONS[inst]}
              {INSTRUMENT_NAMES[inst]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span id={`${uid}-way`} className={LABEL}>Write as</span>
        <div role="group" aria-labelledby={`${uid}-way`} className="flex flex-wrap gap-1">
          {WAYS_FOR[instrument].map((w) => (
            <button
              key={w}
              type="button"
              className={`${TILE} h-7 px-2.5 ${way === w ? TILE_ON : TILE_OFF}`}
              onClick={() => setWay(w)}
              aria-pressed={way === w}
              title={WAY_HINTS[w]}
            >
              {WAY_NAMES[w]}
            </button>
          ))}
        </div>
      </div>

      {showSource && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${uid}-from`} className={LABEL}>From</label>
          <select
            id={`${uid}-from`}
            name={`${uid}-from`}
            className={FIELD}
            value={source?.id ?? ''}
            onChange={(e) => setSourceId(e.target.value)}
          >
            {midis.map((m) => (
              <option key={m.id} value={m.id}>{stemOf(m)} MIDI</option>
            ))}
          </select>
        </div>
      )}

      {showStaves && (
        <div className="flex flex-col gap-1.5">
          <span id={`${uid}-staves`} className={LABEL}>Staves</span>
          <div
            role="group"
            aria-labelledby={`${uid}-staves`}
            className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1"
          >
            {midis.map((m, i) => {
              const fieldId = `${uid}-staff-${i}`;
              const picked = staffInstrumentValue(m, staffPicks);
              const inst = orchestraInstrument(picked);
              return (
                <React.Fragment key={m.id}>
                  <label
                    htmlFor={fieldId}
                    className="max-w-24 truncate text-xs font-bold text-zinc-300"
                    title={`${stemOf(m)} MIDI`}
                  >
                    {stemOf(m)}
                  </label>
                  <select
                    id={fieldId}
                    name={fieldId}
                    className={FIELD}
                    value={picked}
                    onChange={(e) => {
                      const next = e.target.value;
                      setStaffPicks((prev) => ({ ...prev, [m.id]: next }));
                    }}
                    title={inst ? describeInstrument(inst) : 'The staff keeps the stem name and takes a clef from its notes'}
                  >
                    <option value="">Stem name</option>
                    {ORCHESTRA_GROUPS.map((g) => (
                      <optgroup key={g.family.id} label={g.family.label}>
                        {g.instruments.map((o) => (
                          <option key={o.id} value={o.id}>{o.name}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      )}

      {way === 'tab' && (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3.5rem] gap-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={`${uid}-tuning`} className={LABEL}>Tuning</label>
            <select
              id={`${uid}-tuning`}
              name={`${uid}-tuning`}
              className={FIELD}
              value={tuning}
              onChange={(e) => setTuning(e.target.value)}
            >
              {tunings.map((t) => (
                <option key={t} value={t}>{tuningName(t)}</option>
              ))}
            </select>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={`${uid}-level`} className={LABEL}>Level</label>
            <select
              id={`${uid}-level`}
              name={`${uid}-level`}
              className={FIELD}
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value as Difficulty)}
              title="How far up the neck and how wide the hand may reach: easy stays within fret 5, medium 12, hard 19"
            >
              {DIFFICULTIES.map((d) => (
                <option key={d} value={d}>{d[0].toUpperCase() + d.slice(1)}</option>
              ))}
            </select>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={`${uid}-capo`} className={LABEL}>Capo</label>
            <input
              id={`${uid}-capo`}
              name={`${uid}-capo`}
              type="number"
              min={0}
              max={12}
              className={`${FIELD} cursor-text`}
              value={capo}
              onChange={(e) => setCapo(Math.max(0, Math.min(12, Number(e.target.value) || 0)))}
            />
          </div>
        </div>
      )}

      <button
        type="button"
        className="h-8 rounded border border-[rgb(var(--et-accent)/0.55)] bg-[rgb(var(--et-accent)/0.2)] flex items-center justify-center gap-1.5 font-display text-xs font-bold uppercase et-accent-legend transition-colors hover:bg-[rgb(var(--et-accent)/0.3)] disabled:opacity-40 disabled:hover:bg-[rgb(var(--et-accent)/0.2)] outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--et-accent)/0.6)]"
        onClick={() => void make()}
        disabled={!entryId || busy || !!blocked}
        title={blocked ?? WAY_HINTS[way]}
      >
        {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
        Make
      </button>
      {entryId && blocked && <p className="leading-5 text-zinc-500">{blocked}</p>}
    </div>
  );
};

export default NotationMaker;
