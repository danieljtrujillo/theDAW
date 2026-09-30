/**
 * ComposerPanel — the MIDI tab's COMPOSE column: the composer backends
 * (backend/modules/composer) as controls, writing into the piano roll.
 *
 * The COMPOSE key on the action rail shows it to the right of the roll. Six
 * sections, one job each, on a tab row:
 *
 *   HARMONY       a roman-numeral phrase in a key, voiced SATB, optionally in
 *                 a composer's style; WRITE puts the four parts in the roll.
 *   FORM          a whole form's sections (PLAN lists them), and REALIZE
 *                 writes one movement, voiced, with its meters, tempi and
 *                 section markers.
 *   COUNTERPOINT  species counterpoint against a cantus (the selected part or
 *                 one of Fux's), a canon, a fugue exposition, and an
 *                 inversion check of two parts.
 *   ORCHESTRATE   the roll's parts as a sketch written for an ensemble
 *                 (strings, chamber, classical, romantic): RUN adds one part
 *                 per instrument on the orchestra registry's voices, with a
 *                 plan line per section; UNDO takes the added parts back.
 *   CHECK         the roll's key and the voice-leading check over its SATB
 *                 parts, counted by rule; the list is the roll's last
 *                 voice-leading answer (a check's, or a write's), the same
 *                 flags the harmony row shows, and a row selects the notes it
 *                 names.
 *   PROFILE       a style profile counted from corpus pieces or a library
 *                 score, or a shipped style's numbers.
 *
 * The header's status is a dot and one word, with the sentence under it; every
 * result and every refusal (the backend's 422 sentence) also goes to the LOG.
 * Options and limits come from lib/composerPanelModel, which holds the
 * backend's own; the roll is written and read through lib/composeToRoll, whose
 * writes are the roll store's composer actions (one undo step each).
 */
import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { ChartColumn, Dices, FlipVertical2, Layers, ListChecks, Loader2, PenLine, ScrollText, Search, Undo2, Workflow, X } from 'lucide-react';

import {
  COMPOSER_PPQ,
  composerApi,
  type FormRequest,
  type VoiceLeadingFlag,
  type FormResult,
  type InvertibleInterval,
  type InvertibleResult,
  type ModalMode,
  type OrchestratedSection,
  type StyleProfile,
  type StyleSummary,
} from '../../lib/composerClient';
import {
  CADENCE_OPTIONS,
  CANON_INTERVALS,
  CANON_RHYTHMS,
  CANON_TRANSPOSITIONS,
  CANTUS_PRESETS,
  DEFAULT_CANON,
  DEFAULT_COUNTERPOINT,
  DEFAULT_FORM,
  DEFAULT_FUGUE,
  DEFAULT_HARMONY,
  DEFAULT_ORCHESTRATE,
  DEFAULT_PROFILE,
  ENSEMBLE_OPTIONS,
  FORM_METER_OPTIONS,
  FORM_OPTIONS,
  FUGUE_EPISODE_OPTIONS,
  FUGUE_VOICE_OPTIONS,
  IDLE_STATUS,
  INVERSION_INTERVALS,
  INVERTIBLE_OPTIONS,
  KEY_MODES,
  LIMITS,
  MODAL_MODES,
  RONDO_OPTIONS,
  SPECIES_OPTIONS,
  SUBJECT_STARTS,
  TEXTURE_OPTIONS,
  TONICS,
  busyStatus,
  cadenceShares,
  canonIntervalLabel,
  canonRequest,
  clampInt,
  countByRule,
  doneStatus,
  errorStatus,
  flagPlace,
  formBarsMax,
  formControlApplies,
  formRequest,
  fugueRequest,
  harmonicRhythmOptions,
  harmonicRhythmText,
  inversionRequest,
  minCanonBars,
  orchestrateRequest,
  planRequest,
  profileRequest,
  rerollSeed,
  ruleLabel,
  sameFormRequest,
  speciesRequest,
  styleOptionLabel,
  toggleCorpusPiece,
  topChords,
  type AnyFlag,
  type CanonState,
  type ComposeStatus,
  type CounterpointState,
  type FormState,
  type FugueState,
  type HarmonyState,
  type OrchestrateState,
  type ProfileState,
} from '../../lib/composerPanelModel';
import {
  activeRollPartId,
  removeRollParts,
  rollKeyForPanel,
  rollOrchestrateContext,
  rollPartNotes,
  rollRequestContext,
  rollSketchParts,
  runVoiceLeadingCheck,
  selectFlagNotes,
  speciesCantusNotes,
  writeCounterpoint,
  writeFormMovement,
  writeOrchestration,
  writePlan,
  type RollWrite,
} from '../../lib/composeToRoll';
import { searchCorpus, type CorpusPiece } from '../../lib/notationClient';
import { rollKeyName } from '../../lib/rollKey';
import { logError, logInfo, logWarn } from '../../state/logStore';
import { rollTracksOf, usePianoRollStore, type RollVoiceLeading } from '../../state/pianoRollStore';
import { useLibrarySearch } from '../../state/useLibrarySearch';
import { RollKeyPicker } from './FiguredBassLane';
import { FLYOUT_LEGEND, FLYOUT_SELECT, MINI_GLYPH, MINI_KEY, StripKey, keyTone } from './midiDockKit';
import { ExpressionKey } from './ExpressionKey';

export type ComposeSectionId = 'harmony' | 'form' | 'counterpoint' | 'orchestrate' | 'check' | 'profile';
type SectionId = ComposeSectionId;

const SECTIONS: readonly { id: SectionId; word: string; name: string }[] = [
  { id: 'harmony', word: 'Harmony', name: 'Harmony: plan a phrase' },
  { id: 'form', word: 'Form', name: 'Form: plan and realize a form' },
  { id: 'counterpoint', word: 'Counter', name: 'Counterpoint, canon and fugue' },
  { id: 'orchestrate', word: 'Orchestrate', name: 'Orchestrate: the sketch as a full score' },
  { id: 'check', word: 'Check', name: 'Check voice leading' },
  { id: 'profile', word: 'Profile', name: 'Style profile' },
];

const LOG_SOURCE = 'piano-roll';

const INPUT =
  'min-w-0 w-full rounded border border-white/10 bg-black/40 px-1.5 py-1 font-sans text-[12px] font-semibold tabular-nums text-zinc-200 outline-none focus:border-[rgb(var(--et-accent)/0.6)] disabled:opacity-50';
const NOTE = 'text-[12px] font-semibold et-ink-3 leading-snug';
const GROUP = 'flex flex-col gap-2 pt-2 border-t border-white/8 first:border-t-0 first:pt-0';
const CHECK_LABEL = 'flex items-center gap-2 text-[12px] font-semibold text-zinc-300 cursor-pointer';

const DOT: Record<ComposeStatus['tone'], string> = {
  idle: 'bg-zinc-500',
  busy: 'bg-[rgb(var(--et-accent))] animate-pulse',
  ok: 'bg-emerald-400',
  warn: 'bg-amber-400',
  error: 'bg-red-400',
};

/* ── small controls ──────────────────────────────────────────────────────── */

/** A native control with its label above it. */
const Field: React.FC<{ id: string; label: string; children: React.ReactNode; className?: string }> = ({ id, label, children, className = '' }) => (
  <div className={`flex flex-col gap-1 min-w-0 ${className}`}>
    <label htmlFor={id} className={FLYOUT_LEGEND}>
      {label}
    </label>
    {children}
  </div>
);

function Select<T extends string | number>({
  id,
  value,
  options,
  onChange,
  disabled,
}: {
  id: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <select
      id={id}
      name={id}
      value={String(value)}
      disabled={disabled}
      onChange={(e) => {
        const hit = options.find((o) => String(o.value) === e.target.value);
        if (hit) onChange(hit.value);
      }}
      className={FLYOUT_SELECT}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

const TONIC_OPTIONS = TONICS.map((t) => ({ value: t, label: t }));

/** A whole number field that lands its value clamped on blur or Enter. An empty
 *  field is null where `allowEmpty` says the backend has a default. */
const NumberField: React.FC<{
  id: string;
  label: string;
  value: number | null;
  min: number;
  max: number;
  onChange: (v: number | null) => void;
  allowEmpty?: boolean;
  placeholder?: string;
  disabled?: boolean;
}> = ({ id, label, value, min, max, onChange, allowEmpty = false, placeholder, disabled }) => {
  const [draft, setDraft] = useState(value === null ? '' : String(value));
  useEffect(() => setDraft(value === null ? '' : String(value)), [value]);
  const land = () => {
    if (allowEmpty && draft.trim() === '') {
      onChange(null);
      return;
    }
    const n = clampInt(draft, min, max, value ?? min);
    onChange(n);
    setDraft(String(n));
  };
  return (
    <Field id={id} label={label}>
      <input
        id={id}
        name={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={land}
        onKeyDown={(e) => {
          if (e.key === 'Enter') land();
        }}
        className={INPUT}
      />
    </Field>
  );
};

/** The seed and its re-roll key. */
const SeedField: React.FC<{ id: string; value: number; onChange: (v: number) => void }> = ({ id, value, onChange }) => (
  <div className="flex items-end gap-1 min-w-0">
    <NumberField id={id} label="Seed" value={value} min={LIMITS.seed.min} max={LIMITS.seed.max} onChange={(v) => onChange(v ?? 0)} />
    <StripKey
      mini
      iconOnly
      legend="Re-roll"
      aria-label="Re-roll the seed"
      description="A new random seed: the next WRITE comes out different"
      onClick={() => onChange(rerollSeed())}
      icon={<Dices className={MINI_GLYPH} />}
      className="mb-0.5"
    />
  </div>
);

/** An action key with its glyph and word; a spinner while its job runs. */
const ActionKey: React.FC<{
  legend: string;
  description: string;
  onClick: () => void;
  busy: boolean;
  running: boolean;
  icon: React.ReactNode;
  disabled?: boolean;
}> = ({ legend, description, onClick, busy, running, icon, disabled }) => (
  <StripKey
    flyout
    legend={legend}
    description={description}
    onClick={onClick}
    unavailable={busy}
    disabled={disabled}
    icon={running ? <Loader2 className={`${MINI_GLYPH} animate-spin`} /> : icon}
  />
);

/**
 * Flags as rows: where, which parts, what. A row with `onPick` selects its
 * notes. `partName` names a flag's part as the roll does ('soprano' is the
 * part "Soprano").
 */
function FlagList<F extends AnyFlag>({
  flags,
  onPick,
  label,
  partName = (p) => p,
}: {
  flags: readonly F[];
  onPick?: (f: F) => void;
  label: string;
  partName?: (part: string) => string;
}) {
  if (!flags.length) return <p className={NOTE}>No rule broken.</p>;
  return (
    <ul aria-label={label} className="flex flex-col gap-0.5 max-h-56 overflow-y-auto">
      {flags.map((f, i) => {
        const names = f.parts.map(partName);
        const text = (
          <>
            <span className="block text-[12px] font-bold et-ink tabular-nums">
              {flagPlace(f)} · {names.join(', ')}
            </span>
            <span className="block text-[12px] font-semibold et-ink-3">
              {ruleLabel(f.rule)}: {f.message}
            </span>
          </>
        );
        return (
          <li key={`${f.tick}-${f.rule}-${i}`}>
            {onPick ? (
              <button
                type="button"
                onClick={() => onPick(f)}
                aria-label={`Select the notes: ${flagPlace(f)}, ${names.join(' and ')}, ${ruleLabel(f.rule)}`}
                className="w-full text-left px-1.5 py-1 rounded-xs transition-shadow hover:shadow-[inset_0_0_0_100px_rgba(255,255,255,0.06)]"
              >
                {text}
              </button>
            ) : (
              <div className="px-1.5 py-1">{text}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Where the roll's last voice-leading answer came from, as the CHECK section says it. */
const FLAG_SOURCE: Record<RollVoiceLeading['source'], string> = {
  check: 'the last check',
  plan: 'the plan written',
  continuo: 'the realized figured bass',
  counterpoint: 'the counterpoint written',
  form: 'the movement written',
  orchestrate: 'the orchestration written',
};

/** True when a part the roll's last voice-leading answer read has different notes now. */
const useFlagsStale = (): boolean =>
  usePianoRollStore((s) => {
    const vl = s.voiceLeading;
    if (!vl) return false;
    const parts = rollTracksOf(s);
    return Object.entries(vl.notesAt).some(([id, at]) => parts.find((p) => p.id === id)?.notes !== at);
  });

/** "; 2 voices left out: the roll holds its most parts" when a write left some out. */
const leftOut = (w: RollWrite): string =>
  w.skipped ? `; ${w.skipped} voice${w.skipped === 1 ? '' : 's'} left out: the roll holds its most parts` : '';

const RuleCounts: React.FC<{ flags: readonly AnyFlag[] }> = ({ flags }) => (
  <ul aria-label="Flags by rule" className="flex flex-col gap-0.5">
    {countByRule(flags).map((r) => (
      <li key={r.rule} className="flex items-center justify-between gap-2 text-[12px] font-semibold text-zinc-300">
        <span>{r.label}</span>
        <span className="font-bold et-ink tabular-nums">{r.count}</span>
      </li>
    ))}
  </ul>
);

const ShareList: React.FC<{ title: string; shares: readonly { label: string; pct: number }[] }> = ({ title, shares }) => (
  <div className="flex flex-col gap-0.5">
    <h4 className={FLYOUT_LEGEND}>{title}</h4>
    {shares.length ? (
      <ul aria-label={title} className="flex flex-col gap-0.5">
        {shares.map((s) => (
          <li key={s.label} className="flex items-center gap-2 text-[12px] font-semibold text-zinc-300">
            <span className="w-16 shrink-0 truncate">{s.label}</span>
            <span aria-hidden="true" className="flex-1 h-1.5 rounded-full bg-white/8 overflow-hidden">
              <span className="block h-full bg-[rgb(var(--et-accent))]" style={{ width: `${Math.min(100, s.pct)}%` }} />
            </span>
            <span className="w-11 shrink-0 text-right font-bold et-ink tabular-nums">{s.pct}%</span>
          </li>
        ))}
      </ul>
    ) : (
      <p className={NOTE}>None counted.</p>
    )}
  </div>
);

/** A style profile's numbers: where they come from, top chords, cadences, harmonic rhythm. */
const ProfileNumbers: React.FC<{ profile: StyleProfile }> = ({ profile }) => (
  <div className="flex flex-col gap-2" data-compose-profile="">
    <div>
      <p className="text-[12px] font-bold et-ink">
        {profile.name} {profile.era ? `(${profile.era})` : ''}
      </p>
      <p className={NOTE}>
        {profile.source === 'authored' ? 'Authored' : 'Measured'}: {profile.basis}
      </p>
      <p className={NOTE}>
        {profile.sample.works} work{profile.sample.works === 1 ? '' : 's'}
        {profile.sample.bars ? `, ${profile.sample.bars} bars` : ''}
        {profile.sample.harmonies ? `, ${profile.sample.harmonies} chords` : ''}
        {profile.sample.cadences ? `, ${profile.sample.cadences} cadences` : ''}
      </p>
    </div>
    <ShareList title="Major" shares={topChords(profile, 'major')} />
    <ShareList title="Minor" shares={topChords(profile, 'minor')} />
    <ShareList title="Cadences" shares={cadenceShares(profile)} />
    <div>
      <h4 className={FLYOUT_LEGEND}>Rhythm</h4>
      <p className="text-[12px] font-semibold text-zinc-300">{harmonicRhythmText(profile)}</p>
    </div>
  </div>
);

/* ── the panel ───────────────────────────────────────────────────────────── */

export const ComposerPanel: React.FC<{
  onClose: () => void;
  /** The section the column opens on (HARMONY when left out). */
  initialSection?: ComposeSectionId;
}> = ({ onClose, initialSection = 'harmony' }) => {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const idOf = (name: string) => `compose-${uid}-${name}`;

  const [section, setSection] = useState<SectionId>(initialSection);
  const [status, setStatus] = useState<ComposeStatus>(IDLE_STATUS);
  const [running, setRunning] = useState<string | null>(null);
  const busy = running !== null;

  const tracks = usePianoRollStore((s) => rollTracksOf(s));
  const activeId = usePianoRollStore((s) => s.activeTrackId);
  // The roll's last voice-leading answer: the CHECK list shows what the harmony row shows.
  const voiceLeading = usePianoRollStore((s) => s.voiceLeading);
  const flagsStale = useFlagsStale();
  const partOptions = useMemo(
    () => tracks.map((t) => ({ value: t.id, label: `${t.name} (${t.notes.length} notes)` })),
    [tracks],
  );
  const activeName = tracks.find((t) => t.id === activeId)?.name ?? 'the selected part';
  // A species cantus from "the selected part" is the part marked as the cantus firmus when one is.
  const cantusPart = tracks.find((t) => t.cantusFirmus === true);
  const cantusOption = cantusPart ? `Cantus firmus part: ${cantusPart.name}` : `Selected part: ${activeName}`;
  /** A flag's part name as the roll names that part. */
  const flagPartName = useCallback(
    (name: string) => {
      const id = voiceLeading?.ids[name];
      return (id && tracks.find((t) => t.id === id)?.name) || name;
    },
    [voiceLeading, tracks],
  );

  const [styles, setStyles] = useState<StyleSummary[]>([]);
  // HARMONY and FORM open on the roll's key (its own, else the key its notes are in).
  const [harmony, setHarmony] = useState<HarmonyState>(() => ({ ...DEFAULT_HARMONY, ...rollKeyForPanel() }));
  const [form, setForm] = useState<FormState>(() => ({ ...DEFAULT_FORM, ...rollKeyForPanel() }));
  const [formPlan, setFormPlan] = useState<{ req: FormRequest; result: FormResult; realized: boolean } | null>(null);
  const [movement, setMovement] = useState(0);
  const [cp, setCp] = useState<CounterpointState>(DEFAULT_COUNTERPOINT);
  const [cpFlags, setCpFlags] = useState<AnyFlag[] | null>(null);
  const [canon, setCanon] = useState<CanonState>(DEFAULT_CANON);
  const [fugue, setFugue] = useState<FugueState>(DEFAULT_FUGUE);
  const [orchestrate, setOrchestrate] = useState<OrchestrateState>(DEFAULT_ORCHESTRATE);
  // The last orchestration written: its plan per section, and the parts it added (what UNDO takes back).
  const [orchestration, setOrchestration] = useState<{ sections: OrchestratedSection[]; createdIds: string[] } | null>(null);
  const [invUpper, setInvUpper] = useState('');
  const [invLower, setInvLower] = useState('');
  const [invInterval, setInvInterval] = useState<InvertibleInterval>(8);
  const [inversion, setInversion] = useState<InvertibleResult | null>(null);
  const [checkInKey, setCheckInKey] = useState(false);
  const [profileState, setProfileState] = useState<ProfileState>(DEFAULT_PROFILE);
  const [profile, setProfile] = useState<StyleProfile | null>(null);
  const [corpusQuery, setCorpusQuery] = useState('');
  const [corpusHits, setCorpusHits] = useState<CorpusPiece[]>([]);
  const [libraryQuery, setLibraryQuery] = useState('');

  const libraryScores = useLibrarySearch(
    { q: libraryQuery, kind: 'score', sort: 'created_desc' },
    { enabled: section === 'profile' && profileState.source === 'library', pageSize: 12 },
  );

  // The inversion pickers start on the part being edited and the one after it.
  useEffect(() => {
    if (!tracks.length) return;
    if (!tracks.some((t) => t.id === invUpper)) setInvUpper(activeId);
    if (!tracks.some((t) => t.id === invLower)) {
      const i = tracks.findIndex((t) => t.id === activeId);
      setInvLower(tracks[(i + 1) % tracks.length].id);
    }
  }, [tracks, activeId, invUpper, invLower]);

  const report = useCallback((next: ComposeStatus) => {
    setStatus(next);
    if (!next.message) return;
    if (next.tone === 'error') logError(LOG_SOURCE, `COMPOSE ${next.message}`);
    else if (next.tone === 'warn') logWarn(LOG_SOURCE, `COMPOSE ${next.message}`);
    else if (next.tone === 'ok') logInfo(LOG_SOURCE, `COMPOSE ${next.message}`);
  }, []);

  /** Run one backend job: the status says it runs, then what came of it. */
  const run = useCallback(
    async (key: string, action: string, job: () => Promise<ComposeStatus>) => {
      if (running) return;
      setRunning(key);
      setStatus(busyStatus(action));
      try {
        report(await job());
      } catch (e) {
        report(errorStatus(action, e));
      } finally {
        setRunning(null);
      }
    },
    [running, report],
  );

  useEffect(() => {
    let live = true;
    composerApi
      .styles()
      .then((list) => {
        if (live) setStyles(list);
      })
      .catch((e: unknown) => {
        if (live) report(errorStatus('Styles', e));
      });
    return () => {
      live = false;
    };
  }, [report]);

  const styleOptions = useMemo(
    () => [{ value: '', label: 'None' }, ...styles.map((s) => ({ value: s.id, label: styleOptionLabel(s) }))],
    [styles],
  );

  /* ── actions ── */

  const writeHarmony = () =>
    run('plan', 'Write', async () => {
      // On the roll's meter, in the ranges of its SATB parts: the plan fits the parts it goes into.
      const ctx = rollRequestContext();
      const plan = await composerApi.plan(planRequest(harmony, ctx.meterMap, ctx.ranges));
      const w = writePlan(plan);
      const style = plan.style ? ` in the style of ${styles.find((s) => s.id === plan.style)?.name ?? plan.style}` : '';
      const flags = plan.flags.length;
      return doneStatus(
        `Wrote ${w.parts.join(', ')}: ${w.notes} notes, ${plan.bars} bars in ${plan.key}${style}, ${(CADENCE_OPTIONS.find((o) => o.value === plan.cadence)?.label ?? plan.cadence).toLowerCase()} cadence, seed ${plan.seed}${flags ? `, ${flags} voice-leading flags` : ''}${leftOut(w)}`,
        flags,
      );
    });

  const planForm = () =>
    run('form', 'Plan', async () => {
      const req = formRequest(form, rollRequestContext().ranges);
      const result = await composerApi.form(req);
      setFormPlan({ req, result, realized: false });
      setMovement(0);
      const sections = result.movements.reduce((n, m) => n + m.sections.length, 0);
      return doneStatus(`Planned a ${ruleLabel(result.form).toLowerCase()} in ${result.key}: ${result.bars} bars, ${result.movements.length} movement${result.movements.length === 1 ? '' : 's'}, ${sections} sections`);
    });

  const realizeForm = () =>
    run('realize', 'Realize', async () => {
      const req = formRequest(form, rollRequestContext().ranges);
      const cached = formPlan && formPlan.realized && sameFormRequest(formPlan.req, req) ? formPlan.result : null;
      const result = cached ?? (await composerApi.realizeForm(req));
      setFormPlan({ req, result, realized: true });
      const index = Math.min(movement, result.movements.length - 1);
      const m = result.movements[index];
      const w = writeFormMovement(result, index);
      const flags = m.sections.reduce((n, s) => n + (s.flags?.length ?? 0), 0);
      return doneStatus(
        `Realized ${m.title} in ${m.key}: ${m.bars} bars, ${w.notes} notes, ${m.sections.length} section markers${flags ? `, ${flags} voice-leading flags` : ''}${leftOut(w)}`,
        flags,
      );
    });

  const writeSpecies = () =>
    run('species', 'Species', async () => {
      // "The selected part" is the part marked as the cantus firmus when one is, else the part being edited.
      const req = speciesRequest(cp, cp.cantus === 'part' ? speciesCantusNotes() : undefined);
      const result = await composerApi.species(req);
      const w = writeCounterpoint(result);
      setCpFlags(result.violations);
      const at = INVERSION_INTERVALS.find((o) => o.value === result.invertible)?.label.toLowerCase();
      const inv = result.inversion ? `, ${result.inversion.ok ? 'inverts cleanly' : 'does not invert cleanly'} at the ${at}` : '';
      return doneStatus(
        `Wrote species ${result.species} ${result.position} the cantus in ${result.key}: ${w.notes} notes in ${w.parts.join(' and ')}, ${result.suspensions.length} suspensions${inv}${leftOut(w)}`,
        result.violations.length,
      );
    });

  const writeCanon = () =>
    run('canon', 'Canon', async () => {
      const result = await composerApi.canon(canonRequest(canon));
      const w = writeCounterpoint(result);
      setCpFlags(result.violations);
      const beats = result.lag / COMPOSER_PPQ;
      return doneStatus(
        `Wrote a canon, the follower a ${canonIntervalLabel(result.interval).toLowerCase()} and ${beats} beat${beats === 1 ? '' : 's'} behind, ${result.bars} bars in ${result.key}: ${w.notes} notes${leftOut(w)}`,
        result.violations.length,
      );
    });

  const writeFugue = () =>
    run('fugue', 'Fugue', async () => {
      const req = fugueRequest(fugue, fugue.subject === 'part' ? rollPartNotes(activeRollPartId()) : undefined);
      const result = await composerApi.fugue(req);
      const w = writeCounterpoint(result);
      setCpFlags(result.violations);
      return doneStatus(
        `Wrote a ${result.voices.length}-voice fugue exposition in ${result.key}: ${result.answer.kind} answer, ${result.episodes.length} episode${result.episodes.length === 1 ? '' : 's'}, ${result.strettos.length} stretto${result.strettos.length === 1 ? '' : 's'} found, ${w.notes} notes${leftOut(w)}`,
        result.violations.length,
      );
    });

  const runOrchestrate = () =>
    run('orchestrate', 'Orchestrate', async () => {
      // The whole roll is the sketch: every part with notes, the harmony row, the meter and the section markers.
      const req = orchestrateRequest(orchestrate, rollSketchParts(), rollOrchestrateContext());
      const result = await composerApi.orchestrate(req);
      const w = writeOrchestration(result);
      setOrchestration({ sections: result.sections, createdIds: w.createdIds });
      const ensemble = ENSEMBLE_OPTIONS.find((o) => o.value === result.ensemble)?.label ?? result.ensemble;
      return doneStatus(
        `Orchestrated for a ${ensemble.toLowerCase()} ensemble in ${result.key}: ${w.parts.length} parts, ${w.notes} notes, ${result.sections.length} section${result.sections.length === 1 ? '' : 's'}${w.created ? `, ${w.created} added` : ''}${leftOut(w)}`,
      );
    });

  const undoOrchestrate = () => {
    if (!orchestration) return;
    const n = removeRollParts(orchestration.createdIds);
    setOrchestration(null);
    report({ tone: 'ok', word: 'Removed', message: `${n} part${n === 1 ? '' : 's'} the orchestration added removed; the roll's own undo takes back the rest` });
  };

  const checkInversion = () =>
    run('invert', 'Inversion', async () => {
      if (invUpper === invLower) throw new Error('pick two different parts');
      const req = inversionRequest(rollPartNotes(invUpper), rollPartNotes(invLower), invInterval, cp.key, cp.mode);
      const result = await composerApi.invertibleCheck(req);
      setInversion(result);
      const broken = result.inverted.violations.length + result.original.violations.length;
      return doneStatus(
        result.ok
          ? `The two parts invert cleanly at the ${INVERSION_INTERVALS.find((o) => o.value === result.interval)?.label.toLowerCase()}`
          : `The inversion at the ${INVERSION_INTERVALS.find((o) => o.value === result.interval)?.label.toLowerCase()} breaks ${broken} rule${broken === 1 ? '' : 's'}`,
        result.ok ? 0 : Math.max(1, broken),
      );
    });

  const runCheck = () =>
    run('check', 'Check', async () => {
      // The flags land in the roll's voiceLeading, which this list and the harmony row both show.
      const result = await runVoiceLeadingCheck(checkInKey ? { key: harmony.key, mode: harmony.mode } : {});
      const parts = Object.keys(result.idByName).length;
      const key = usePianoRollStore.getState().voiceLeading?.key;
      const inKey = key ? ` in ${rollKeyName(key)}` : '';
      return doneStatus(
        result.count
          ? `${result.count} voice-leading flag${result.count === 1 ? '' : 's'} over ${parts} parts${inKey}`
          : `No voice-leading flags over ${parts} parts${inKey}`,
        result.count,
      );
    });

  const pickFlag = (f: VoiceLeadingFlag) => {
    const n = selectFlagNotes(f);
    const s = usePianoRollStore.getState();
    const part = rollTracksOf(s).find((t) => t.id === s.activeTrackId)?.name ?? flagPartName(f.parts[0]);
    report({ tone: 'ok', word: 'Selected', message: `${n} note${n === 1 ? '' : 's'} at ${flagPlace(f).toLowerCase()} in ${part}` });
  };

  const searchPieces = () =>
    run('corpus', 'Corpus search', async () => {
      const found = await searchCorpus(corpusQuery.trim());
      setCorpusHits(found.results);
      return doneStatus(`${found.total} corpus piece${found.total === 1 ? '' : 's'} match “${found.query}”${found.total > found.results.length ? `; showing ${found.results.length}` : ''}`);
    });

  const buildProfile = () =>
    run('profile', profileState.source === 'style' ? 'Style' : 'Profile', async () => {
      if (profileState.source === 'style') {
        if (!profileState.style) throw new Error('pick a style');
        const p = await composerApi.style(profileState.style);
        setProfile(p);
        return doneStatus(`${p.name}: ${p.source === 'authored' ? 'authored' : 'measured'} profile shown`);
      }
      const p = await composerApi.profile(profileRequest(profileState));
      setProfile(p);
      return doneStatus(`Counted ${p.name || p.id} from ${p.sample.works} work${p.sample.works === 1 ? '' : 's'}`);
    });

  /* ── render ── */

  const hasStyle = !!harmony.style;
  const canonMinBars = minCanonBars(canon.lagBeats);
  const movements = formPlan?.result.movements ?? [];
  const shownMovement = movements[Math.min(movement, Math.max(0, movements.length - 1))];

  return (
    <aside
      data-dock-aside=""
      aria-label="Compose"
      className="w-80 shrink-0 border-l border-white/8 flex flex-col min-h-0 bg-black/30"
    >
      {/* header: name, status (dot + one word), close */}
      <div className="shrink-0 flex items-center gap-2 px-2 h-8.5 border-b border-white/8">
        <h2 className="text-[12px] font-display font-bold uppercase et-ink">Compose</h2>
        <div role="status" className="flex items-center gap-1.5 min-w-0">
          <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT[status.tone]}`} />
          <span className="text-[12px] font-bold et-ink">{status.word}</span>
          <span className="sr-only">{status.message}</span>
        </div>
        <span className="flex-1" />
        <ExpressionKey mini iconOnly />
        <StripKey
          mini
          iconOnly
          legend="Close"
          aria-label="Close the COMPOSE column"
          onClick={onClose}
          icon={<X className={MINI_GLYPH} />}
        />
      </div>
      {status.message && (
        <p aria-hidden="true" title={status.message} className={`shrink-0 px-2 py-1 border-b border-white/8 line-clamp-3 ${NOTE}`}>
          {status.message}
        </p>
      )}

      {/* the sections, one job each */}
      <div role="tablist" aria-label="Compose sections" className="shrink-0 flex flex-wrap gap-0.5 px-1.5 py-1 border-b border-white/8">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            id={idOf(`tab-${s.id}`)}
            aria-selected={section === s.id}
            aria-controls={idOf(`panel-${s.id}`)}
            aria-label={s.name}
            tabIndex={section === s.id ? 0 : -1}
            onClick={() => setSection(s.id)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
              e.preventDefault();
              const i = SECTIONS.findIndex((x) => x.id === section);
              const next = SECTIONS[(i + (e.key === 'ArrowRight' ? 1 : SECTIONS.length - 1)) % SECTIONS.length];
              setSection(next.id);
              document.getElementById(idOf(`tab-${next.id}`))?.focus();
            }}
            className={`${MINI_KEY} ${keyTone({ on: section === s.id })}`}
          >
            <span>{s.word}</span>
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        id={idOf(`panel-${section}`)}
        aria-labelledby={idOf(`tab-${section}`)}
        className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-2"
      >
        {section === 'harmony' && (
          <div className={GROUP}>
            <div className="grid grid-cols-2 gap-2">
              <Field id={idOf('h-key')} label="Key">
                <Select id={idOf('h-key')} value={harmony.key} options={TONIC_OPTIONS} onChange={(key) => setHarmony((h) => ({ ...h, key }))} />
              </Field>
              <Field id={idOf('h-mode')} label="Mode">
                <Select id={idOf('h-mode')} value={harmony.mode} options={KEY_MODES} onChange={(mode) => setHarmony((h) => ({ ...h, mode }))} />
              </Field>
              <NumberField
                id={idOf('h-bars')}
                label="Bars"
                value={harmony.bars}
                min={LIMITS.planBars.min}
                max={LIMITS.planBars.max}
                onChange={(v) => setHarmony((h) => ({ ...h, bars: v ?? 8 }))}
              />
              <Field id={idOf('h-cadence')} label="Cadence">
                <Select id={idOf('h-cadence')} value={harmony.cadence} options={CADENCE_OPTIONS} onChange={(cadence) => setHarmony((h) => ({ ...h, cadence }))} />
              </Field>
            </div>
            <Field id={idOf('h-style')} label="Style">
              <Select
                id={idOf('h-style')}
                value={harmony.style}
                options={styleOptions}
                onChange={(style) =>
                  setHarmony((h) => ({ ...h, style, harmonicRhythm: !style && h.harmonicRhythm === 'style' ? '' : h.harmonicRhythm }))
                }
              />
            </Field>
            <Field id={idOf('h-rhythm')} label="Harmonic rhythm">
              <Select
                id={idOf('h-rhythm')}
                value={harmony.harmonicRhythm}
                options={harmonicRhythmOptions(hasStyle)}
                onChange={(harmonicRhythm) => setHarmony((h) => ({ ...h, harmonicRhythm }))}
              />
            </Field>
            <SeedField id={idOf('h-seed')} value={harmony.seed} onChange={(seed) => setHarmony((h) => ({ ...h, seed }))} />
            <div className="flex items-center gap-2">
              <ActionKey
                legend="Write"
                description="Plan the phrase and write soprano, alto, tenor and bass into the roll, on the roll's meter"
                onClick={() => void writeHarmony()}
                busy={busy}
                running={running === 'plan'}
                icon={<PenLine className={MINI_GLYPH} />}
              />
            </div>
            <p className={NOTE}>
              Four parts named Soprano, Alto, Tenor and Bass. A roll with notes keeps its other parts; parts with those names are
              replaced.
            </p>
          </div>
        )}

        {section === 'form' && (
          <div className={GROUP}>
            <Field id={idOf('f-form')} label="Form">
              <Select
                id={idOf('f-form')}
                value={form.form}
                options={FORM_OPTIONS}
                onChange={(f) =>
                  setForm((s) => ({ ...s, form: f, bars: s.bars !== null ? Math.min(s.bars, formBarsMax(f)) : null }))
                }
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field id={idOf('f-key')} label="Key">
                <Select id={idOf('f-key')} value={form.key} options={TONIC_OPTIONS} onChange={(key) => setForm((s) => ({ ...s, key }))} />
              </Field>
              <Field id={idOf('f-mode')} label="Mode">
                <Select id={idOf('f-mode')} value={form.mode} options={KEY_MODES} onChange={(mode) => setForm((s) => ({ ...s, mode }))} />
              </Field>
              <NumberField
                id={idOf('f-bars')}
                label="Bars"
                value={form.bars}
                min={LIMITS.formBars.min}
                max={formBarsMax(form.form)}
                allowEmpty
                placeholder="The form's own"
                onChange={(bars) => setForm((s) => ({ ...s, bars }))}
              />
              <NumberField
                id={idOf('f-tempo')}
                label="Tempo (BPM)"
                value={form.tempo}
                min={LIMITS.formTempo.min}
                max={LIMITS.formTempo.max}
                allowEmpty
                placeholder="The form's own"
                disabled={!formControlApplies(form.form, 'tempo')}
                onChange={(tempo) => setForm((s) => ({ ...s, tempo }))}
              />
              <Field id={idOf('f-meter')} label="Meter">
                <Select
                  id={idOf('f-meter')}
                  value={form.meter}
                  options={FORM_METER_OPTIONS}
                  disabled={!formControlApplies(form.form, 'meter')}
                  onChange={(meter) => setForm((s) => ({ ...s, meter }))}
                />
              </Field>
              <Field id={idOf('f-rondo')} label="Rondo pattern">
                <Select
                  id={idOf('f-rondo')}
                  value={form.rondo}
                  options={RONDO_OPTIONS}
                  disabled={!formControlApplies(form.form, 'rondo')}
                  onChange={(rondo) => setForm((s) => ({ ...s, rondo }))}
                />
              </Field>
              <NumberField
                id={idOf('f-variations')}
                label="Variations"
                value={form.variations}
                min={LIMITS.variations.min}
                max={LIMITS.variations.max}
                allowEmpty
                placeholder="The form's own"
                disabled={!formControlApplies(form.form, 'variations')}
                onChange={(variations) => setForm((s) => ({ ...s, variations }))}
              />
            </div>
            {form.form === 'symphony' && <p className={NOTE}>A symphony's four movements keep their own meters and tempi; the bars are all four together.</p>}
            <SeedField id={idOf('f-seed')} value={form.seed} onChange={(seed) => setForm((s) => ({ ...s, seed }))} />
            <div className="flex flex-wrap items-center gap-2">
              <ActionKey
                legend="Plan"
                description="Plan the form's movements and sections: keys, bars and tempi, listed below"
                onClick={() => void planForm()}
                busy={busy}
                running={running === 'form'}
                icon={<Workflow className={MINI_GLYPH} />}
              />
              <ActionKey
                legend="Realize"
                description="Voice every section in four parts and write the chosen movement into the Soprano, Alto, Tenor and Bass parts, with its meters, tempi and section markers (one undo step)"
                onClick={() => void realizeForm()}
                busy={busy}
                running={running === 'realize'}
                icon={<PenLine className={MINI_GLYPH} />}
              />
            </div>
            {movements.length > 1 && (
              <Field id={idOf('f-movement')} label="Movement">
                <Select
                  id={idOf('f-movement')}
                  value={movement}
                  options={movements.map((m, i) => ({ value: i, label: `${m.title} (${m.form.replace(/_/g, ' ')}, ${m.key})` }))}
                  onChange={(v) => setMovement(v)}
                />
              </Field>
            )}
            {shownMovement && (
              <table className="w-full text-[12px] font-semibold text-zinc-300" data-compose-sections="">
                <caption className="text-left text-[12px] font-bold et-ink pb-1">
                  {shownMovement.title}: {shownMovement.tempo.marking}, {shownMovement.meter.num}/{shownMovement.meter.den}
                </caption>
                <thead>
                  <tr className={FLYOUT_LEGEND}>
                    <th scope="col" className="text-left font-bold pb-1">Section</th>
                    <th scope="col" className="text-left font-bold pb-1">Key</th>
                    <th scope="col" className="text-right font-bold pb-1">Bars</th>
                    <th scope="col" className="text-right font-bold pb-1">BPM</th>
                  </tr>
                </thead>
                <tbody>
                  {shownMovement.sections.map((s) => (
                    <tr key={s.index} className="border-t border-white/5">
                      <td className="py-0.5 pr-1" title={s.label}>{ruleLabel(s.role)}</td>
                      <td className="py-0.5 pr-1">{s.key}</td>
                      <td className="py-0.5 text-right tabular-nums" title={`From bar ${s.start_bar + 1}`}>{s.bars}</td>
                      <td className="py-0.5 text-right tabular-nums" title={s.tempo.marking}>{Math.round(s.tempo.bpm)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {section === 'counterpoint' && (
          <>
            <fieldset className={GROUP}>
              <legend className={`${FLYOUT_LEGEND} mb-1`}>Species</legend>
              <div className="grid grid-cols-2 gap-2">
                <Field id={idOf('c-species')} label="Species" className="col-span-2">
                  <Select id={idOf('c-species')} value={cp.species} options={SPECIES_OPTIONS} onChange={(species) => setCp((s) => ({ ...s, species }))} />
                </Field>
                <Field id={idOf('c-position')} label="Line">
                  <Select
                    id={idOf('c-position')}
                    value={cp.position}
                    options={[
                      { value: 'above', label: 'Above the cantus' },
                      { value: 'below', label: 'Below the cantus' },
                    ]}
                    onChange={(position) => setCp((s) => ({ ...s, position }))}
                  />
                </Field>
                <Field id={idOf('c-invertible')} label="Invertible">
                  <Select id={idOf('c-invertible')} value={cp.invertible} options={INVERTIBLE_OPTIONS} onChange={(invertible) => setCp((s) => ({ ...s, invertible }))} />
                </Field>
                <Field id={idOf('c-cantus')} label="Cantus" className="col-span-2">
                  <Select
                    id={idOf('c-cantus')}
                    value={cp.cantus}
                    options={[{ value: 'part' as const, label: cantusOption }, ...CANTUS_PRESETS]}
                    onChange={(cantus) => setCp((s) => ({ ...s, cantus }))}
                  />
                </Field>
                <Field id={idOf('c-key')} label="Key">
                  <Select
                    id={idOf('c-key')}
                    value={cp.key}
                    disabled={cp.cantus !== 'part'}
                    options={[{ value: '', label: 'From the cantus' }, ...TONIC_OPTIONS]}
                    onChange={(key) => setCp((s) => ({ ...s, key }))}
                  />
                </Field>
                <Field id={idOf('c-mode')} label="Mode">
                  <Select<ModalMode | ''>
                    id={idOf('c-mode')}
                    value={cp.mode}
                    disabled={cp.cantus !== 'part'}
                    options={[{ value: '', label: 'From the cantus' }, ...MODAL_MODES]}
                    onChange={(mode) => setCp((s) => ({ ...s, mode }))}
                  />
                </Field>
              </div>
              {cp.cantus === 'part' && (
                <p className={NOTE}>
                  {cantusPart
                    ? `The cantus is read from ${cantusPart.name}, the part marked Cantus firmus, and written back into it.`
                    : 'Mark a part Cantus firmus in the parts column to read the cantus from it and write it back there.'}
                </p>
              )}
              <SeedField id={idOf('c-seed')} value={cp.seed} onChange={(seed) => setCp((s) => ({ ...s, seed }))} />
              <div className="flex items-center gap-2">
                <ActionKey
                  legend="Write"
                  description="Write the counterpoint and its cantus into the roll as two parts"
                  onClick={() => void writeSpecies()}
                  busy={busy}
                  running={running === 'species'}
                  icon={<PenLine className={MINI_GLYPH} />}
                />
              </div>
            </fieldset>

            <fieldset className={GROUP}>
              <legend className={`${FLYOUT_LEGEND} mb-1`}>Canon</legend>
              <div className="grid grid-cols-2 gap-2">
                <Field id={idOf('n-key')} label="Key">
                  <Select id={idOf('n-key')} value={canon.key} options={TONIC_OPTIONS} onChange={(key) => setCanon((s) => ({ ...s, key }))} />
                </Field>
                <Field id={idOf('n-mode')} label="Mode">
                  <Select id={idOf('n-mode')} value={canon.mode} options={MODAL_MODES} onChange={(mode) => setCanon((s) => ({ ...s, mode }))} />
                </Field>
                <Field id={idOf('n-interval')} label="Interval">
                  <Select id={idOf('n-interval')} value={canon.interval} options={CANON_INTERVALS} onChange={(interval) => setCanon((s) => ({ ...s, interval }))} />
                </Field>
                <NumberField
                  id={idOf('n-lag')}
                  label="Lag (beats)"
                  value={canon.lagBeats}
                  min={LIMITS.canonLagBeats.min}
                  max={LIMITS.canonLagBeats.max}
                  onChange={(v) =>
                    setCanon((s) => {
                      const lagBeats = v ?? 4;
                      return { ...s, lagBeats, bars: Math.max(s.bars, minCanonBars(lagBeats)) };
                    })
                  }
                />
                <NumberField
                  id={idOf('n-bars')}
                  label="Bars"
                  value={canon.bars}
                  min={canonMinBars}
                  max={LIMITS.canonBars.max}
                  onChange={(v) => setCanon((s) => ({ ...s, bars: v ?? canonMinBars }))}
                />
                <Field id={idOf('n-transposition')} label="Imitation">
                  <Select
                    id={idOf('n-transposition')}
                    value={canon.transposition}
                    options={CANON_TRANSPOSITIONS}
                    onChange={(transposition) => setCanon((s) => ({ ...s, transposition }))}
                  />
                </Field>
                <Field id={idOf('n-rhythm')} label="Rhythm">
                  <Select id={idOf('n-rhythm')} value={canon.rhythm} options={CANON_RHYTHMS} onChange={(rhythm) => setCanon((s) => ({ ...s, rhythm }))} />
                </Field>
              </div>
              <SeedField id={idOf('n-seed')} value={canon.seed} onChange={(seed) => setCanon((s) => ({ ...s, seed }))} />
              <div className="flex items-center gap-2">
                <ActionKey
                  legend="Canon"
                  description="Write a two-voice canon into the roll as the parts Leader and Follower"
                  onClick={() => void writeCanon()}
                  busy={busy}
                  running={running === 'canon'}
                  icon={<ScrollText className={MINI_GLYPH} />}
                />
              </div>
            </fieldset>

            <fieldset className={GROUP}>
              <legend className={`${FLYOUT_LEGEND} mb-1`}>Fugue</legend>
              <div className="grid grid-cols-2 gap-2">
                <Field id={idOf('g-key')} label="Key">
                  <Select id={idOf('g-key')} value={fugue.key} options={TONIC_OPTIONS} onChange={(key) => setFugue((s) => ({ ...s, key }))} />
                </Field>
                <Field id={idOf('g-mode')} label="Mode">
                  <Select id={idOf('g-mode')} value={fugue.mode} options={MODAL_MODES} onChange={(mode) => setFugue((s) => ({ ...s, mode }))} />
                </Field>
                <Field id={idOf('g-voices')} label="Voices">
                  <Select id={idOf('g-voices')} value={fugue.voices} options={FUGUE_VOICE_OPTIONS} onChange={(voices) => setFugue((s) => ({ ...s, voices }))} />
                </Field>
                <Field id={idOf('g-episodes')} label="Episodes">
                  <Select id={idOf('g-episodes')} value={fugue.episodes} options={FUGUE_EPISODE_OPTIONS} onChange={(episodes) => setFugue((s) => ({ ...s, episodes }))} />
                </Field>
                <Field id={idOf('g-subject')} label="Subject" className="col-span-2">
                  <Select
                    id={idOf('g-subject')}
                    value={fugue.subject}
                    options={[
                      { value: 'generate' as const, label: 'Written for you' },
                      { value: 'part' as const, label: `Selected part: ${activeName}` },
                    ]}
                    onChange={(subject) => setFugue((s) => ({ ...s, subject }))}
                  />
                </Field>
                <Field id={idOf('g-start')} label="Subject starts on">
                  <Select
                    id={idOf('g-start')}
                    value={fugue.subjectStart}
                    options={SUBJECT_STARTS}
                    disabled={fugue.subject !== 'generate'}
                    onChange={(subjectStart) => setFugue((s) => ({ ...s, subjectStart }))}
                  />
                </Field>
                <label htmlFor={idOf('g-cs')} className={`${CHECK_LABEL} self-end pb-1`}>
                  <input
                    id={idOf('g-cs')}
                    name={idOf('g-cs')}
                    type="checkbox"
                    checked={fugue.countersubject}
                    onChange={(e) => setFugue((s) => ({ ...s, countersubject: e.target.checked }))}
                    className="accent-[rgb(var(--et-accent))]"
                  />
                  Countersubject
                </label>
              </div>
              <SeedField id={idOf('g-seed')} value={fugue.seed} onChange={(seed) => setFugue((s) => ({ ...s, seed }))} />
              <div className="flex items-center gap-2">
                <ActionKey
                  legend="Fugue"
                  description="Write a fugue exposition (subject, answer, countersubject, episodes) into the roll, one part a voice"
                  onClick={() => void writeFugue()}
                  busy={busy}
                  running={running === 'fugue'}
                  icon={<Workflow className={MINI_GLYPH} />}
                />
              </div>
            </fieldset>

            <fieldset className={GROUP}>
              <legend className={`${FLYOUT_LEGEND} mb-1`}>Inversion</legend>
              <div className="grid grid-cols-2 gap-2">
                <Field id={idOf('i-upper')} label="Upper part">
                  <Select id={idOf('i-upper')} value={invUpper} options={partOptions} onChange={(v) => setInvUpper(v)} />
                </Field>
                <Field id={idOf('i-lower')} label="Lower part">
                  <Select id={idOf('i-lower')} value={invLower} options={partOptions} onChange={(v) => setInvLower(v)} />
                </Field>
                <Field id={idOf('i-interval')} label="At the">
                  <Select id={idOf('i-interval')} value={invInterval} options={INVERSION_INTERVALS} onChange={(v) => setInvInterval(v)} />
                </Field>
              </div>
              <div className="flex items-center gap-2">
                <ActionKey
                  legend="Check"
                  aria-label="Check inversion"
                  description="Check the two parts as written and with the lower one moved above the upper at the interval"
                  onClick={() => void checkInversion()}
                  busy={busy}
                  running={running === 'invert'}
                  disabled={tracks.length < 2}
                  icon={<FlipVertical2 className={MINI_GLYPH} />}
                />
              </div>
              {inversion && (
                <div className="flex flex-col gap-1">
                  <p className="text-[12px] font-bold et-ink">
                    {inversion.ok ? 'Inverts cleanly' : 'Does not invert cleanly'} at the{' '}
                    {INVERSION_INTERVALS.find((o) => o.value === inversion.interval)?.label.toLowerCase()}, in {inversion.key}
                  </p>
                  <FlagList flags={inversion.inverted.violations} label="Rules the inversion breaks" />
                </div>
              )}
            </fieldset>

            {cpFlags && cpFlags.length > 0 && (
              <div className={GROUP}>
                <h3 className={FLYOUT_LEGEND}>Rules</h3>
                <FlagList flags={cpFlags} label="Rules broken in the last write" />
              </div>
            )}
          </>
        )}

        {section === 'orchestrate' && (
          <div className={GROUP}>
            <fieldset className={GROUP}>
              <legend className={`${FLYOUT_LEGEND} mb-1`}>Orchestrate</legend>
              <div className="grid grid-cols-2 gap-2">
                <Field id={idOf('o-ensemble')} label="Ensemble">
                  <Select id={idOf('o-ensemble')} value={orchestrate.ensemble} options={ENSEMBLE_OPTIONS} onChange={(ensemble) => setOrchestrate((s) => ({ ...s, ensemble }))} />
                </Field>
                <Field id={idOf('o-texture')} label="Texture">
                  <Select id={idOf('o-texture')} value={orchestrate.texture} options={TEXTURE_OPTIONS} onChange={(texture) => setOrchestrate((s) => ({ ...s, texture }))} />
                </Field>
                <Field id={idOf('o-melody')} label="Melody">
                  <Select
                    id={idOf('o-melody')}
                    value={orchestrate.melody}
                    options={[{ value: '', label: 'Highest' }, ...partOptions]}
                    onChange={(melody) => setOrchestrate((s) => ({ ...s, melody }))}
                  />
                </Field>
                <Field id={idOf('o-bass')} label="Bass">
                  <Select
                    id={idOf('o-bass')}
                    value={orchestrate.bass}
                    options={[{ value: '', label: 'Lowest' }, ...partOptions]}
                    onChange={(bass) => setOrchestrate((s) => ({ ...s, bass }))}
                  />
                </Field>
                <Field id={idOf('o-density')} label="Density" className="col-span-2">
                  <div className="flex items-center gap-2">
                    <input
                      id={idOf('o-density')}
                      name={idOf('o-density')}
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={orchestrate.density}
                      onChange={(e) => setOrchestrate((s) => ({ ...s, density: Number(e.target.value) }))}
                      className="min-w-0 flex-1 accent-[rgb(var(--et-accent))]"
                    />
                    <output htmlFor={idOf('o-density')} className="w-8 shrink-0 text-right text-[12px] font-bold et-ink tabular-nums">
                      {orchestrate.density}
                    </output>
                  </div>
                </Field>
              </div>
              <div className="flex items-center gap-2">
                <ActionKey
                  legend="Run"
                  description="Write the roll's parts for the ensemble: one new part per instrument, the melody in Violin I, the bass in the cellos, the harmony spread over the rest"
                  onClick={() => void runOrchestrate()}
                  busy={busy}
                  running={running === 'orchestrate'}
                  icon={<Layers className={MINI_GLYPH} />}
                />
                <ActionKey
                  legend="Undo"
                  description="Remove the parts the last orchestration added"
                  onClick={undoOrchestrate}
                  busy={busy}
                  running={false}
                  disabled={!orchestration?.createdIds.length}
                  icon={<Undo2 className={MINI_GLYPH} />}
                />
              </div>
            </fieldset>
            {orchestration && (
              <div className="flex flex-col gap-0.5">
                <h4 className={FLYOUT_LEGEND}>Plan</h4>
                <ul aria-label="Orchestration plan" className="flex flex-col gap-1">
                  {orchestration.sections.map((s) => (
                    <li key={`${s.tick}-${s.name}`} className={NOTE}>
                      {s.plan}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {section === 'check' && (
          <div className={GROUP}>
            {/* The roll's own key: the harmony row's CHECK, REALIZE and the transforms read it too. */}
            <div className="self-start">
              <RollKeyPicker id={idOf('k-key')} />
            </div>
            <label htmlFor={idOf('k-inkey')} className={CHECK_LABEL}>
              <input
                id={idOf('k-inkey')}
                name={idOf('k-inkey')}
                type="checkbox"
                checked={checkInKey}
                onChange={(e) => setCheckInKey(e.target.checked)}
                className="accent-[rgb(var(--et-accent))]"
              />
              {`Read in ${harmony.key} ${harmony.mode} (the HARMONY key) instead`}
            </label>
            <div className="flex items-center gap-2">
              <ActionKey
                legend="Check"
                description="Check the Soprano, Alto, Tenor and Bass parts (else the four highest parts) for parallels, hidden fifths and octaves, crossing, spacing, range and unresolved tones"
                onClick={() => void runCheck()}
                busy={busy}
                running={running === 'check'}
                icon={<ListChecks className={MINI_GLYPH} />}
              />
            </div>
            {voiceLeading && (
              <>
                <p className={NOTE} data-compose-flags-source="">
                  {`From ${FLAG_SOURCE[voiceLeading.source]}, in ${rollKeyName(voiceLeading.key)}${flagsStale ? '. The parts changed since.' : '.'}`}
                </p>
                <RuleCounts flags={voiceLeading.flags} />
                <FlagList flags={voiceLeading.flags} onPick={pickFlag} partName={flagPartName} label="Voice-leading flags" />
                {voiceLeading.flags.length > 0 && <p className={NOTE}>A row selects its notes and moves the playhead there; the harmony row over the ruler shows the same flags.</p>}
              </>
            )}
          </div>
        )}

        {section === 'profile' && (
          <div className={GROUP}>
            <fieldset className="flex flex-col gap-1">
              <legend className={`${FLYOUT_LEGEND} mb-1`}>Source</legend>
              {(
                [
                  ['corpus', 'Corpus pieces'],
                  ['library', 'A library score'],
                  ['style', 'A shipped style'],
                ] as const
              ).map(([value, label]) => (
                <label key={value} htmlFor={idOf(`p-src-${value}`)} className={CHECK_LABEL}>
                  <input
                    id={idOf(`p-src-${value}`)}
                    name={idOf('p-src')}
                    type="radio"
                    value={value}
                    checked={profileState.source === value}
                    onChange={() => setProfileState((s) => ({ ...s, source: value }))}
                    className="accent-[rgb(var(--et-accent))]"
                  />
                  {label}
                </label>
              ))}
            </fieldset>

            {profileState.source === 'corpus' && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-end gap-1">
                  <Field id={idOf('p-q')} label="Search the corpus" className="flex-1">
                    <input
                      id={idOf('p-q')}
                      name={idOf('p-q')}
                      type="search"
                      value={corpusQuery}
                      placeholder="bach, chorale, mozart…"
                      onChange={(e) => setCorpusQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void searchPieces();
                      }}
                      className={INPUT}
                    />
                  </Field>
                  <StripKey
                    mini
                    iconOnly
                    legend="Search"
                    aria-label="Search the music21 corpus"
                    onClick={() => void searchPieces()}
                    unavailable={busy}
                    icon={<Search className={MINI_GLYPH} />}
                    className="mb-0.5"
                  />
                </div>
                <p className={NOTE}>
                  {profileState.corpus.length} of {LIMITS.profileWorks.max} pieces picked
                </p>
                {corpusHits.length > 0 && (
                  <ul aria-label="Corpus pieces" className="flex flex-col gap-0.5 max-h-48 overflow-y-auto">
                    {corpusHits.map((p) => {
                      const cid = idOf(`p-c-${p.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
                      return (
                        <li key={p.id}>
                          <label htmlFor={cid} className={CHECK_LABEL}>
                            <input
                              id={cid}
                              name={cid}
                              type="checkbox"
                              checked={profileState.corpus.includes(p.id)}
                              onChange={() => setProfileState((s) => ({ ...s, corpus: toggleCorpusPiece(s.corpus, p.id) }))}
                              className="accent-[rgb(var(--et-accent))]"
                            />
                            <span className="min-w-0 truncate" title={p.path}>
                              {p.composer ? `${p.composer}: ` : ''}
                              {p.title || p.path}
                              {p.movement ? `, ${p.movement}` : ''}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            {profileState.source === 'library' && (
              <div className="flex flex-col gap-1.5">
                <Field id={idOf('p-lib')} label="Search library scores">
                  <input
                    id={idOf('p-lib')}
                    name={idOf('p-lib')}
                    type="search"
                    value={libraryQuery}
                    placeholder="Title"
                    onChange={(e) => setLibraryQuery(e.target.value)}
                    className={INPUT}
                  />
                </Field>
                {libraryScores.rows.length > 0 ? (
                  <ul aria-label="Library scores" className="flex flex-col gap-0.5 max-h-48 overflow-y-auto">
                    {libraryScores.rows.map((e) => {
                      const rid = idOf(`p-e-${e.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
                      return (
                        <li key={e.id}>
                          <label htmlFor={rid} className={CHECK_LABEL}>
                            <input
                              id={rid}
                              name={idOf('p-entry')}
                              type="radio"
                              checked={profileState.entryId === e.id}
                              onChange={() => setProfileState((s) => ({ ...s, entryId: e.id }))}
                              className="accent-[rgb(var(--et-accent))]"
                            />
                            <span className="min-w-0 truncate">{e.title}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className={NOTE}>{libraryScores.loading ? 'Searching…' : 'No library scores match. Import a score or open a corpus piece first.'}</p>
                )}
              </div>
            )}

            {profileState.source === 'style' && (
              <Field id={idOf('p-style')} label="Style">
                <Select
                  id={idOf('p-style')}
                  value={profileState.style}
                  options={[{ value: '', label: 'Pick a style' }, ...styles.map((s) => ({ value: s.id, label: styleOptionLabel(s) }))]}
                  onChange={(style) => setProfileState((s) => ({ ...s, style }))}
                />
              </Field>
            )}

            {profileState.source !== 'style' && (
              <div className="grid grid-cols-2 gap-2">
                <Field id={idOf('p-id')} label="Profile id">
                  <input
                    id={idOf('p-id')}
                    name={idOf('p-id')}
                    type="text"
                    value={profileState.id}
                    maxLength={40}
                    pattern="[a-z0-9_\-]{1,40}"
                    onChange={(e) => setProfileState((s) => ({ ...s, id: e.target.value }))}
                    className={INPUT}
                  />
                </Field>
                <NumberField
                  id={idOf('p-bars')}
                  label="Bars a work"
                  value={profileState.maxBars}
                  min={LIMITS.profileMaxBars.min}
                  max={LIMITS.profileMaxBars.max}
                  onChange={(v) => setProfileState((s) => ({ ...s, maxBars: v ?? 96 }))}
                />
                <Field id={idOf('p-name')} label="Name" className="col-span-2">
                  <input
                    id={idOf('p-name')}
                    name={idOf('p-name')}
                    type="text"
                    value={profileState.name}
                    maxLength={LIMITS.profileName}
                    placeholder="My chorale style"
                    onChange={(e) => setProfileState((s) => ({ ...s, name: e.target.value }))}
                    className={INPUT}
                  />
                </Field>
              </div>
            )}

            <div className="flex items-center gap-2">
              <ActionKey
                legend={profileState.source === 'style' ? 'Show' : 'Build'}
                description={
                  profileState.source === 'style'
                    ? "Show the style's numbers: top chords, cadences and harmonic rhythm"
                    : 'Count a style profile from the scores picked and show its numbers'
                }
                onClick={() => void buildProfile()}
                busy={busy}
                running={running === 'profile'}
                icon={<ChartColumn className={MINI_GLYPH} />}
              />
            </div>
            {profile && <ProfileNumbers profile={profile} />}
          </div>
        )}
      </div>
    </aside>
  );
};
