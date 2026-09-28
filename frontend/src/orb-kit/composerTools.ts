/**
 * The assistant's composer and score tools: composer_* (the piano roll's
 * COMPOSE backends) and notation_* (score import and the music21 corpus).
 *
 * `actionHandlers.ts` dispatches every name in {@link COMPOSER_TOOLS} after its
 * own switch and the editor table, and the declarations the model reads are in
 * backend/modules/assistant/tool_catalog.py. Each tool builds its request with
 * the COMPOSE panel's own model (lib/composerPanelModel), so a tool call and
 * the panel send the same request for the same choice, and writes into the
 * roll through lib/composeToRoll, as the panel does.
 *
 * A tool answers with a ToolResult: `ok` with the sentence the model reads (the
 * numbers it needs next are in it as compact JSON), or `ok: false` with the
 * reason — the backend's own 422 sentence when the backend refused.
 */
import { composerApi, type CounterpointFlag, type KeyMode, type ModalMode, type VoiceLeadingFlag } from '../lib/composerClient';
import {
  CADENCE_OPTIONS,
  CANON_INTERVALS,
  CANTUS_PRESETS,
  DEFAULT_CANON,
  DEFAULT_COUNTERPOINT,
  DEFAULT_FORM,
  DEFAULT_FUGUE,
  DEFAULT_HARMONY,
  DEFAULT_PROFILE,
  FORM_OPTIONS,
  LIMITS,
  MODAL_MODES,
  RONDO_OPTIONS,
  canonRequest,
  clampInt,
  countByRule,
  errorStatus,
  flagPlace,
  formRequest,
  fugueRequest,
  planRequest,
  profileRequest,
  speciesRequest,
  topChords,
  cadenceShares,
  harmonicRhythmText,
  type CanonState,
  type CounterpointState,
  type FormState,
  type FugueState,
  type HarmonyState,
  type ProfileState,
} from '../lib/composerPanelModel';
import { rollPartNotes, rollRequestContext, runVoiceLeadingCheck, writeCounterpoint, writeFormMovement, writePlan } from '../lib/composeToRoll';
import { fetchArtifactText, importScoreFile, openCorpusPiece, searchCorpus } from '../lib/notationClient';
import { importSheetParts } from '../lib/rollPartsImport';
import { parseSheetFile } from '../lib/sheetImportClient';
import { useBottomPanelStore } from '../state/bottomPanelStore';
import type { ToolResult } from '../state/editorTools';
import { logInfo } from '../state/logStore';
import { activeTrackOf, rollTracksOf, usePianoRollStore } from '../state/pianoRollStore';

type Payload = Record<string, unknown>;
export type ComposerToolRun = (payload: Payload) => Promise<ToolResult>;

const done = (message: string, data?: unknown): ToolResult => {
  logInfo('assistant', message.length > 240 ? `${message.slice(0, 240)}…` : message);
  return { ok: true, message, data };
};
const fail = (error: string): ToolResult => ({ ok: false, error });

/** A failure as the panel's status line says it, without its word. */
const failed = (action: string, e: unknown): ToolResult => fail(errorStatus(action, e).message);

const str = (p: Payload, key: string): string | undefined => {
  const v = p[key];
  return v === undefined || v === null || v === '' ? undefined : String(v).trim();
};
const num = (p: Payload, key: string): number | undefined => {
  const v = p[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const bool = (p: Payload, key: string, fallback: boolean): boolean => {
  const v = p[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  if (typeof v === 'number') return v !== 0;
  return fallback;
};
const oneOf = <T extends string | number>(value: unknown, allowed: readonly T[], what: string): T | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const hit = allowed.find((a) => String(a) === String(value));
  if (hit === undefined) throw new Error(`${what} is one of ${allowed.join(', ')}; got ${String(value)}`);
  return hit;
};

const KEY_MODES: readonly KeyMode[] = ['major', 'minor'];
const MODES: readonly ModalMode[] = MODAL_MODES.map((o) => o.value);

/** The roll part a tool names: 'active' or 'selected' for the part being edited, else a name (case-insensitive) or an id. */
function rollPart(ref: string | undefined): { id: string; name: string } {
  const s = usePianoRollStore.getState();
  if (!ref || ref === 'active' || ref === 'selected') {
    const a = activeTrackOf(s);
    return { id: a.id, name: a.name };
  }
  const tracks = rollTracksOf(s);
  const hit = tracks.find((t) => t.id === ref) ?? tracks.find((t) => t.name.trim().toLowerCase() === ref.toLowerCase());
  if (!hit) throw new Error(`no roll part "${ref}"; the parts are ${tracks.map((t) => t.name).join(', ')}`);
  return { id: hit.id, name: hit.name };
}

/** The MIDI tab comes up, so the user sees what was written. */
const showRoll = (): void => useBottomPanelStore.getState().showTab('midi');

const flagRows = (flags: readonly (VoiceLeadingFlag | CounterpointFlag)[], max = 40) =>
  flags.slice(0, max).map((f) => ({ at: flagPlace(f), parts: f.parts, rule: f.rule, message: f.message }));

/* ── composer_* ──────────────────────────────────────────────────────────── */

async function composerPlan(p: Payload): Promise<ToolResult> {
  try {
    const h: HarmonyState = {
      ...DEFAULT_HARMONY,
      key: str(p, 'key') ?? 'C',
      mode: oneOf(p.mode, KEY_MODES, 'mode') ?? 'major',
      bars: clampInt(num(p, 'bars'), LIMITS.planBars.min, LIMITS.planBars.max, 8),
      cadence: oneOf(p.cadence, CADENCE_OPTIONS.map((o) => o.value).filter((v): v is Exclude<typeof v, ''> => v !== ''), 'cadence') ?? '',
      harmonicRhythm: (oneOf(p.harmonic_rhythm, ['pulse', 'bar', 'style'], 'harmonic_rhythm') ?? '') as HarmonyState['harmonicRhythm'],
      style: str(p, 'style') ?? '',
      seed: clampInt(num(p, 'seed'), LIMITS.seed.min, LIMITS.seed.max, 0),
    };
    // The roll's meter and the ranges of its SATB parts, as the COMPOSE panel sends them.
    const ctx = rollRequestContext();
    const req = planRequest(h, ctx.meterMap, ctx.ranges);
    const include = Array.isArray(p.include) ? (p.include as unknown[]).map(String) : [];
    const modulateTo = str(p, 'modulate_to');
    const plan = await composerApi.plan({
      ...req,
      ...(include.length ? { include: include as never } : {}),
      ...(modulateTo ? { modulateTo } : {}),
    });
    const write = bool(p, 'write', true);
    const w = write ? writePlan(plan) : null;
    if (w) showRoll();
    const chords = plan.chords.map((c) => ({ bar: c.bar + 1, beat: c.beat, figure: c.figure, key: c.key }));
    return done(
      `${w ? `Wrote ${w.parts.join(', ')} (${w.notes} notes) into the piano roll` : 'Planned (not written)'}: ${plan.bars} bars in ${plan.key}` +
        `${plan.final_key !== plan.key ? ` ending in ${plan.final_key}` : ''}, ${plan.cadence} cadence, seed ${plan.seed}` +
        `${plan.style ? `, style ${plan.style}` : ''}, ${plan.flags.length} voice-leading flags. Chords: ${JSON.stringify(chords)}`,
      { plan, write: w },
    );
  } catch (e) {
    return failed('composer_plan', e);
  }
}

async function composerCheck(p: Payload): Promise<ToolResult> {
  try {
    const key = str(p, 'key');
    const mode = oneOf(p.mode, KEY_MODES, 'mode');
    const result = await runVoiceLeadingCheck(key ? { key, ...(mode ? { mode } : {}) } : {});
    const byRule = countByRule(result.flags).map((r) => ({ rule: r.rule, count: r.count }));
    return done(
      result.count
        ? `${result.count} voice-leading flags over the roll's parts ${Object.keys(result.idByName).join(', ')}. By rule: ${JSON.stringify(byRule)}. Flags: ${JSON.stringify(flagRows(result.flags))}`
        : `No voice-leading flags over the roll's parts ${Object.keys(result.idByName).join(', ')}.`,
      result,
    );
  } catch (e) {
    return failed('composer_check', e);
  }
}

async function composerForm(p: Payload): Promise<ToolResult> {
  try {
    const f: FormState = {
      ...DEFAULT_FORM,
      form: oneOf(p.form, FORM_OPTIONS.map((o) => o.value), 'form') ?? 'sonata',
      key: str(p, 'key') ?? 'C',
      mode: oneOf(p.mode, KEY_MODES, 'mode') ?? 'major',
      bars: num(p, 'bars') ?? null,
      tempo: num(p, 'tempo') ?? null,
      meter: str(p, 'meter') ?? '',
      rondo: oneOf(p.rondo, RONDO_OPTIONS.map((o) => o.value), 'rondo') ?? 'ABACA',
      variations: num(p, 'variations') ?? null,
      seed: clampInt(num(p, 'seed'), LIMITS.seed.min, LIMITS.seed.max, 0),
    };
    const req = formRequest(f, rollRequestContext().ranges);
    const realize = bool(p, 'realize', false);
    const result = realize ? await composerApi.realizeForm(req) : await composerApi.form(req);
    const movements = result.movements.map((m) => ({
      movement: m.index + 1,
      title: m.title,
      form: m.form,
      key: m.key,
      tempo: `${m.tempo.marking} ${Math.round(m.tempo.bpm)}`,
      meter: `${m.meter.num}/${m.meter.den}`,
      bars: m.bars,
      sections: m.sections.map((s) => ({ role: s.role, label: s.label, key: s.key, start_bar: s.start_bar + 1, bars: s.bars, bpm: Math.round(s.tempo.bpm) })),
    }));
    if (!realize) {
      return done(`Planned a ${result.form} in ${result.key}, ${result.bars} bars: ${JSON.stringify(movements)}`, result);
    }
    const index = clampInt(num(p, 'movement'), 1, result.movements.length, 1) - 1;
    const m = result.movements[index];
    const w = writeFormMovement(result, index);
    showRoll();
    return done(
      `Realized movement ${index + 1} (${m.title}, ${m.key}, ${m.bars} bars) into the piano roll as ${w.parts.join(', ')} (${w.notes} notes), with its meter, tempo map and section markers; ${result.flag_count ?? 0} voice-leading flags over the form. Movements: ${JSON.stringify(movements)}`,
      { form: result.form, movement: index + 1 },
    );
  } catch (e) {
    return failed('composer_form', e);
  }
}

async function composerSpecies(p: Payload): Promise<ToolResult> {
  try {
    const preset = oneOf(p.preset, CANTUS_PRESETS.map((o) => o.value), 'preset');
    const cantusPart = str(p, 'cantus_part');
    if (preset && cantusPart) throw new Error('give a preset or a cantus_part, not both');
    const c: CounterpointState = {
      ...DEFAULT_COUNTERPOINT,
      species: oneOf(num(p, 'species'), [1, 2, 3, 4, 5] as const, 'species') ?? 1,
      position: oneOf(p.position, ['above', 'below'] as const, 'position') ?? 'above',
      cantus: cantusPart ? 'part' : preset ?? 'fux_dorian',
      key: str(p, 'key') ?? '',
      mode: oneOf(p.mode, MODES, 'mode') ?? '',
      invertible: oneOf(num(p, 'invertible'), [8, 10, 12] as const, 'invertible') ?? '',
      seed: clampInt(num(p, 'seed'), LIMITS.seed.min, LIMITS.seed.max, 0),
    };
    const notes = cantusPart ? rollPartNotes(rollPart(cantusPart).id) : undefined;
    const result = await composerApi.species(speciesRequest(c, notes));
    const w = writeCounterpoint(result);
    showRoll();
    return done(
      `Wrote species ${result.species} ${result.position} the cantus in ${result.key} into the piano roll as ${w.parts.join(' and ')} (${w.notes} notes), seed ${result.seed}, ${result.suspensions.length} suspensions` +
        `${result.inversion ? `, ${result.inversion.ok ? 'inverts cleanly' : 'does not invert cleanly'} at ${result.invertible}` : ''}` +
        `${result.violations.length ? `; rules broken: ${JSON.stringify(flagRows(result.violations))}` : '; no rule broken'}`,
      { species: result.species, key: result.key, order: result.order },
    );
  } catch (e) {
    return failed('composer_species', e);
  }
}

async function composerCanon(p: Payload): Promise<ToolResult> {
  try {
    const c: CanonState = {
      ...DEFAULT_CANON,
      key: str(p, 'key') ?? 'C',
      mode: oneOf(p.mode, MODES, 'mode') ?? 'major',
      interval: oneOf(num(p, 'interval'), CANON_INTERVALS.map((o) => o.value), 'interval') ?? 8,
      lagBeats: clampInt(num(p, 'lag_beats'), LIMITS.canonLagBeats.min, LIMITS.canonLagBeats.max, 4),
      bars: clampInt(num(p, 'bars'), LIMITS.canonBars.min, LIMITS.canonBars.max, 8),
      transposition: oneOf(p.transposition, ['diatonic', 'real'] as const, 'transposition') ?? 'diatonic',
      rhythm: oneOf(p.rhythm, ['mixed', 'halves', 'quarters'] as const, 'rhythm') ?? 'mixed',
      seed: clampInt(num(p, 'seed'), LIMITS.seed.min, LIMITS.seed.max, 0),
    };
    const req = canonRequest(c);
    const result = await composerApi.canon(req);
    const w = writeCounterpoint(result);
    showRoll();
    return done(
      `Wrote a canon at interval ${result.interval} (${result.transposition}), the follower ${result.lag / 960} beats behind, ${result.bars} bars in ${result.key}, into the piano roll as ${w.parts.join(' and ')} (${w.notes} notes); ` +
        `${result.violations.length ? `rules broken: ${JSON.stringify(flagRows(result.violations))}` : 'no rule broken'}`,
      { key: result.key, bars: result.bars, lag: result.lag },
    );
  } catch (e) {
    return failed('composer_canon', e);
  }
}

async function composerFugue(p: Payload): Promise<ToolResult> {
  try {
    const subjectPart = str(p, 'subject_part');
    const f: FugueState = {
      ...DEFAULT_FUGUE,
      key: str(p, 'key') ?? 'C',
      mode: oneOf(p.mode, MODES, 'mode') ?? 'minor',
      voices: oneOf(num(p, 'voices'), [2, 3, 4] as const, 'voices') ?? 3,
      subject: subjectPart ? 'part' : 'generate',
      subjectStart: oneOf(p.subject_start, ['tonic', 'dominant'] as const, 'subject_start') ?? 'tonic',
      episodes: oneOf(num(p, 'episodes'), [0, 1, 2] as const, 'episodes') ?? 1,
      countersubject: bool(p, 'countersubject', true),
      seed: clampInt(num(p, 'seed'), LIMITS.seed.min, LIMITS.seed.max, 0),
    };
    const notes = subjectPart ? rollPartNotes(rollPart(subjectPart).id) : undefined;
    const result = await composerApi.fugue(fugueRequest(f, notes));
    const w = writeCounterpoint(result);
    showRoll();
    return done(
      `Wrote a ${result.voices.length}-voice fugue exposition in ${result.key} into the piano roll as ${w.parts.join(', ')} (${w.notes} notes): ${result.answer.kind} answer, ` +
        `${result.episodes.length} episodes, entries ${JSON.stringify(result.entries.map((e) => ({ voice: e.voice, form: e.form, beat: e.tick / 960 })))}, ` +
        `${result.strettos.length} stretto possibilities${result.violations.length ? `; rules broken: ${JSON.stringify(flagRows(result.violations))}` : ''}`,
      { key: result.key, voices: result.voices },
    );
  } catch (e) {
    return failed('composer_fugue', e);
  }
}

async function composerStyles(): Promise<ToolResult> {
  try {
    const list = await composerApi.styles();
    const rows = list.map((s) => ({ id: s.id, name: s.name, era: s.era, source: s.source === 'authored' ? 'authored' : 'measured', works: s.works }));
    return done(`${rows.length} styles (pass an id as composer_plan's style): ${JSON.stringify(rows)}`, { styles: list });
  } catch (e) {
    return failed('composer_styles', e);
  }
}

async function composerProfile(p: Payload): Promise<ToolResult> {
  try {
    const style = str(p, 'style');
    const corpus = Array.isArray(p.corpus) ? (p.corpus as unknown[]).map(String) : [];
    const entryId = str(p, 'entry_id');
    let profile;
    if (style) {
      if (corpus.length || entryId) throw new Error('give a style, corpus pieces or an entry_id, one of the three');
      profile = await composerApi.style(style);
    } else {
      const state: ProfileState = {
        ...DEFAULT_PROFILE,
        source: entryId ? 'library' : 'corpus',
        corpus,
        entryId: entryId ?? '',
        id: str(p, 'id') ?? 'custom',
        name: str(p, 'name') ?? '',
        maxBars: clampInt(num(p, 'max_bars'), LIMITS.profileMaxBars.min, LIMITS.profileMaxBars.max, 96),
      };
      if (entryId && corpus.length) throw new Error('give corpus pieces or an entry_id, not both');
      profile = await composerApi.profile(profileRequest(state));
    }
    const summary = {
      id: profile.id,
      name: profile.name,
      source: profile.source === 'authored' ? 'authored' : 'measured',
      basis: profile.basis,
      sample: profile.sample,
      top_chords_major: topChords(profile, 'major'),
      top_chords_minor: topChords(profile, 'minor'),
      cadences: cadenceShares(profile),
      harmonic_rhythm: harmonicRhythmText(profile),
    };
    return done(`Style profile ${profile.name || profile.id}: ${JSON.stringify(summary)}`, profile);
  } catch (e) {
    return failed('composer_profile', e);
  }
}

/* ── notation_* ──────────────────────────────────────────────────────────── */

const TEXT_SCORES = ['.musicxml', '.xml', '.krn', '.abc'] as const;

/** A score into the roll through the sheet importer, as the IMPORT key does. */
async function scoreIntoRoll(file: File): Promise<string> {
  const score = await parseSheetFile(file);
  if (score.tracks.every((t) => t.notes.length === 0)) return 'the score has no notes to put in the roll';
  const r = importSheetParts(score);
  showRoll();
  return r.into === 'parts' ? `opened in the piano roll as ${r.parts} parts` : 'opened in the piano roll';
}

async function notationImport(p: Payload): Promise<ToolResult> {
  try {
    const filename = str(p, 'filename') ?? '';
    const content = typeof p.content === 'string' ? p.content : '';
    const ext = TEXT_SCORES.find((x) => filename.toLowerCase().endsWith(x));
    if (!ext) throw new Error(`filename must end in ${TEXT_SCORES.join(', ')}`);
    if (!content.trim()) throw new Error('content is the score file text');
    const type = ext === '.abc' ? 'text/vnd.abc' : ext === '.krn' ? 'text/plain' : 'application/vnd.recordare.musicxml+xml';
    const file = new File([content], filename.split(/[\\/]/).pop() ?? filename, { type });
    const result = await importScoreFile(file);
    const roll = bool(p, 'into_roll', false) ? `; ${await scoreIntoRoll(file)}` : '';
    return done(
      `Imported "${result.title}"${result.composer ? ` by ${result.composer}` : ''} as library composition ${result.entry_id}${result.sheet ? ' with a MusicXML sheet' : ''}${roll}`,
      result,
    );
  } catch (e) {
    return failed('notation_import', e);
  }
}

async function notationCorpusSearch(p: Payload): Promise<ToolResult> {
  try {
    const query = str(p, 'query') ?? '';
    const limit = clampInt(num(p, 'limit'), 1, 100, 25);
    const found = await searchCorpus(query);
    const rows = found.results.slice(0, limit).map((r) => ({ id: r.id, composer: r.composer, title: r.title, movement: r.movement, parts: r.parts }));
    return done(
      `${found.total} corpus pieces match "${found.query}"${found.total > rows.length ? `, first ${rows.length}` : ''} (ids go to notation_corpus_open or composer_profile's corpus): ${JSON.stringify(rows)}`,
      { total: found.total, results: rows },
    );
  } catch (e) {
    return failed('notation_corpus_search', e);
  }
}

async function notationCorpusOpen(p: Payload): Promise<ToolResult> {
  try {
    const id = str(p, 'id');
    if (!id) throw new Error('id is a corpus piece id from notation_corpus_search');
    const result = await openCorpusPiece(id);
    let roll = '';
    if (bool(p, 'into_roll', false)) {
      if (!result.sheet) throw new Error(`"${result.title}" was imported but has no MusicXML sheet to open in the roll`);
      const text = await fetchArtifactText(result.sheet.id);
      roll = `; ${await scoreIntoRoll(new File([text], `${id}.musicxml`, { type: 'application/vnd.recordare.musicxml+xml' }))}`;
    }
    return done(
      `Opened corpus piece ${id} as library composition ${result.entry_id}: "${result.title}"${result.composer ? ` by ${result.composer}` : ''}${roll}`,
      result,
    );
  } catch (e) {
    return failed('notation_corpus_open', e);
  }
}

/** Every composer and notation tool, by the name the catalog declares. */
const COMPOSER_TOOLS: Record<string, ComposerToolRun> = {
  composer_plan: composerPlan,
  composer_check: composerCheck,
  composer_form: composerForm,
  composer_species: composerSpecies,
  composer_canon: composerCanon,
  composer_fugue: composerFugue,
  composer_styles: () => composerStyles(),
  composer_profile: composerProfile,
  notation_import: notationImport,
  notation_corpus_search: notationCorpusSearch,
  notation_corpus_open: notationCorpusOpen,
};

/** The tool for a name, or undefined when it is not one of these. */
export function composerTool(name: string): ComposerToolRun | undefined {
  return Object.prototype.hasOwnProperty.call(COMPOSER_TOOLS, name) ? COMPOSER_TOOLS[name] : undefined;
}

/** The names this table serves; the allowlist and the catalog must list the same. */
export const composerToolNames = (): string[] => Object.keys(COMPOSER_TOOLS);
