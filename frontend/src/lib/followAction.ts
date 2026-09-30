/**
 * followAction — what a session-grid clip does to its own column once it has
 * played for a set period, and when that moment arrives.
 *
 * Two pure functions, no clock and no queue:
 *   `nextFollow(state, rule, rng)` answers WHAT happens — the row to launch, a
 *      stop, or `null` for "leave the column alone".
 *   `dueAt(rule, startedAtSec, lengthSec, barSec, beatSec)` answers WHEN, in the
 *      same AudioContext seconds `launchQueue` schedules against, so the follow
 *      lands sample-exact on the clip's own boundary instead of on whatever grid
 *      line the pump happens to reach first.
 *
 * ROWS ARE THE OCCUPIED ONES. `next` from row 1 in a column whose only clips are
 * rows 0, 1, 4 and 7 is row 4, not the empty row 2 — a follow that walked raw
 * row numbers would spend most of a sparse grid stopping the column it was
 * supposed to keep moving.
 *
 * WRAP VS STOP: `next` at the last occupied row and `prev` at the first do
 * NOTHING — they do not wrap, and they do not stop. The clip is simply left to
 * finish. That is Tracktion's rule, and the reason for it is visible in its
 * action list: wrapping is a SEPARATE action there (`trackRoundRobin`), so
 * making `next` wrap would collapse two distinct behaviours into one and leave
 * no way to express "walk down the column and then stay put". Stopping is a
 * separate action too (`globalStop` / our `stop`), for the same reason.
 *
 * `any` includes the current row (so it can land on a relaunch); `other` never
 * does, and with only one occupied row it has nothing to pick, so it does
 * nothing rather than quietly becoming `again`.
 *
 * WHAT VS WHEN. The choice does not depend on progress: `nextFollow` reads only
 * the row it is on and the rows it can reach, exactly as Tracktion's action
 * functions take nothing but the beat they fire on. Progress decides WHEN, and
 * that is `dueAt` alone — a `{plays: n}` rule resolves as `n x lengthSec` from
 * the launch, NOT as a count compared against `playsDone`. `playsDone`,
 * `elapsedSec` and `lengthSec` are therefore carried in `FollowState` as
 * bookkeeping: they make the state a complete description of the armed clip, and
 * `playsDone` is the number a "plays so far" readout on the cell (or a later
 * accumulate-across-relaunches semantic) would need. No kind reads them today.
 *
 * Design source: Tracktion Engine
 * `modules/tracktion_engine/model/clips/tracktion_FollowActions.h:20-52` (the
 * action list: stop / play-again / previous / next / first / last / any / other
 * / round-robin) and `tracktion_FollowActions.cpp:43-51, :174-207, :282-305`
 * (GPL-3.0-or-later / commercial), where the indices are positions in the
 * VALID — i.e. occupied — slot list, `trackPrevious` / `trackNext` produce no
 * handle at the ends while `trackRoundRobin` is the one that wraps, `trackAny`
 * draws uniformly over every valid slot and `trackOther` requires more than one
 * slot and rejects the current. That description of its BEHAVIOUR is the whole
 * of what was taken: no line of it, or of any other copyleft reference under
 * `oss-refs/`, is in this file.
 */

/** One action a follow rule can take on its own column. */
export type FollowKind = 'stop' | 'next' | 'prev' | 'first' | 'last' | 'any' | 'other' | 'again';

/** When the rule comes due: a musical distance from the clip's start, or a
 *  number of times the clip has played. */
export type FollowAfter = { bars: number; beats: number } | { plays: number };

/** A clip's follow rule. `chance` is P(`a`); the rest of the probability is `b`,
 *  and with no `b` the rule is one-sided and `chance` is irrelevant. */
export interface FollowAction {
  after: FollowAfter;
  a: FollowKind;
  b?: FollowKind;
  /** 0..1. */
  chance: number;
}

/** Everything the choice depends on, as the column knows it at the deadline. */
export interface FollowState {
  /** The row the clip that is finishing came from. */
  sceneIndex: number;
  /** Every row of THIS column that holds a playable clip, ascending. */
  occupiedScenes: readonly number[];
  /** How many times this column has launched this row in a row (a relaunch
   *  counts), so a `{plays}` rule is countable by the caller. */
  playsDone: number;
  /** Seconds since the clip started, and its own length. */
  elapsedSec: number;
  lengthSec: number;
}

export type FollowResult = { kind: 'launch'; sceneIndex: number } | { kind: 'stop' } | null;

/** One beat at 120 bpm — the fallback when the caller's clock hands over a
 *  beat length that is not a usable number. */
const DEFAULT_BEAT_SEC = 0.5;

const FOLLOW_KINDS: readonly FollowKind[] = ['stop', 'next', 'prev', 'first', 'last', 'any', 'other', 'again'];

const isFollowKind = (value: unknown): value is FollowKind =>
  typeof value === 'string' && (FOLLOW_KINDS as readonly string[]).includes(value);

const launch = (sceneIndex: number): FollowResult => ({ kind: 'launch', sceneIndex });

/** Uniform over `rows`, from one draw. Clamped both ends so an rng that hands
 *  back exactly 1 (or a negative) still lands on a real row. */
const pick = (rows: readonly number[], rng: () => number): number => {
  const draw = rng();
  const raw = Number.isFinite(draw) ? Math.floor(draw * rows.length) : 0;
  return rows[Math.min(rows.length - 1, Math.max(0, raw))];
};

/**
 * Which of the rule's two actions this firing takes. The a/b draw happens FIRST
 * and only when there IS a `b`, so a one-sided rule consumes no randomness at
 * all and a two-sided one always consumes exactly one number before the chosen
 * kind takes its own.
 */
const pickKind = (rule: FollowAction, rng: () => number): FollowKind => {
  if (rule.b === undefined) return rule.a;
  const chance = Number.isFinite(rule.chance) ? Math.min(1, Math.max(0, rule.chance)) : 1;
  return rng() < chance ? rule.a : rule.b;
};

/** What the column should do now that `rule` has come due. `null` = nothing. */
export const nextFollow = (state: FollowState, rule: FollowAction, rng: () => number): FollowResult => {
  const kind = pickKind(rule, rng);
  if (kind === 'stop') return { kind: 'stop' };
  // `again` names the row it is already on, so it needs no occupied list — a
  // column whose only clip is the one finishing can still repeat itself.
  if (kind === 'again') return launch(state.sceneIndex);

  const rows = [...state.occupiedScenes].sort((x, y) => x - y);
  if (rows.length === 0) return null;

  switch (kind) {
    case 'first':
      return launch(rows[0]);
    case 'last':
      return launch(rows[rows.length - 1]);
    case 'next': {
      const after = rows.find((row) => row > state.sceneIndex);
      return after === undefined ? null : launch(after);
    }
    case 'prev': {
      const before = rows.filter((row) => row < state.sceneIndex);
      return before.length === 0 ? null : launch(before[before.length - 1]);
    }
    case 'any':
      return launch(pick(rows, rng));
    case 'other': {
      const others = rows.filter((row) => row !== state.sceneIndex);
      return others.length === 0 ? null : launch(pick(others, rng));
    }
  }
};

/**
 * The AudioContext second at which `rule` comes due for a clip that started at
 * `startedAtSec`. `barSec` / `beatSec` are the shared clock's own lengths
 * (`beatClock.barSec()` / `beatClock.gridSec('beat')`), so a 7/8 bar is 3.5
 * beats here exactly as it is everywhere else.
 *
 * A rule that resolves to no distance at all — 0 bars 0 beats, 0 plays, or any
 * arithmetic that came out NaN/Infinity — would be due on the tick it was armed
 * and then again on every tick after it, which is an unbounded relaunch loop at
 * the pump's period. Each form therefore has a floor of its own smallest unit:
 * one beat, or one play.
 */
export const dueAt = (
  rule: FollowAction,
  startedAtSec: number,
  lengthSec: number,
  barSec: number,
  beatSec: number,
): number => {
  const beat = Number.isFinite(beatSec) && beatSec > 0 ? beatSec : DEFAULT_BEAT_SEC;
  const { after } = rule;
  const playable = Number.isFinite(lengthSec) && lengthSec > 0;
  const floor = 'plays' in after && playable ? lengthSec : beat;
  // `beat`, not `beatSec`: a clock handing over a bad beat length with a rule of
  // `beats: 0` multiplies out to NaN, which would fall to the floor and silently
  // retime a rule whose bars are perfectly usable.
  let offset = 'plays' in after ? lengthSec * after.plays : barSec * after.bars + beat * after.beats;
  if (!Number.isFinite(offset) || offset <= 0) offset = floor;
  return startedAtSec + offset;
};

/**
 * A `.tasmo` file's `follow_action` back to a rule, or `undefined` when the file
 * does not carry one the app can act on. Storage is deliberately tolerant (the
 * backend model defaults every field so an old or partial file still validates)
 * and interpretation is strict here, so a value the app does not understand
 * becomes "no follow action" rather than a rule the file never expressed.
 */
export const parseFollowAction = (raw: unknown): FollowAction | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  const a = rec.a;
  if (!isFollowKind(a)) return undefined;
  const after = parseAfter(rec.after);
  if (!after) return undefined;
  const chanceRaw = Number(rec.chance);
  const chance = Number.isFinite(chanceRaw) ? Math.min(1, Math.max(0, chanceRaw)) : 1;
  const b = rec.b;
  return isFollowKind(b) ? { after, a, b, chance } : { after, a, chance };
};

/**
 * `Number(null)` is 0, and 0 is finite — so reading the keys with a bare
 * `Number()` made a NULL one look like a value that was really there. The
 * backend defaults all three to None and `model_dump` writes them out, so the
 * shape a half-written rule arrives in is `{bars: null, beats: null, plays:
 * null}`: every rule with no period of its own would have loaded as "every
 * beat" and hammered its column at the pump's resolution.
 */
const asNumber = (value: unknown): number => (value == null ? Number.NaN : Number(value));

const parseAfter = (raw: unknown): FollowAfter | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const rec = raw as Record<string, unknown>;
  // `plays` wins: a file carrying both forms named a play count explicitly,
  // while bars/beats default in the backend model and so can be present
  // without meaning anything.
  const plays = asNumber(rec.plays);
  if (Number.isFinite(plays) && plays > 0) return { plays };
  const bars = asNumber(rec.bars);
  const beats = asNumber(rec.beats);
  const hasBars = Number.isFinite(bars);
  const hasBeats = Number.isFinite(beats);
  if (!hasBars && !hasBeats) return undefined;
  return { bars: hasBars ? bars : 0, beats: hasBeats ? beats : 0 };
};
