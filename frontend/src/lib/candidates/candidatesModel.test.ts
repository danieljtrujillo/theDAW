// candidatesModel: the suite pins three things:
//  1. the lifecycle state machine only allows pending->ready|dismissed and
//     ready->accepted|dismissed, with accepted/dismissed terminal,
//  2. selection/A-B/keyboard-map behaviour on a set's auditionable
//     candidates (ready or accepted; dismissed and pending hidden), and
//  3. that every exported function is pure: called against a deep-frozen
//     set/state, none of them may throw (a mutation attempt on a frozen
//     object throws in strict mode) or change the frozen values.
import assert from 'node:assert/strict';
import {
  transition, auditionable, selectNext, toggleAb, playTarget, applyKey,
  candidateLabel, summarise, EMPTY_AUDITION,
  type Candidate, type CandidateSet, type CandidateStatus, type AuditionState,
} from './candidatesModel.ts';

function makeCandidate(
  id: string,
  status: CandidateStatus,
  createdAt: number,
  params: Record<string, unknown> = {},
): Candidate {
  return { id, status, params, createdAt };
}

function makeSet(candidates: Candidate[]): CandidateSet {
  return {
    id: 'set-1',
    source: { kind: 'clip', id: 'src-1' },
    provider: 'sa3',
    params: {},
    label: 'Generate several',
    createdAt: 0,
    candidates,
  };
}

/** Asserts `fn` throws an Error with exactly `expected` as its message,
 *  without depending on node:assert's error-shape-matching semantics. */
function assertThrowsMessage(fn: () => void, expected: string): void {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    assert.equal(err instanceof Error ? err.message : String(err), expected);
  }
  assert.ok(threw, `expected function to throw "${expected}"`);
}

// ── 1. transition_legal_edges ────────────────────────────────────────────
{
  const pending = makeCandidate('c1', 'pending', 1);
  assert.equal(transition(pending, 'ready').status, 'ready');
  assert.equal(transition(pending, 'dismissed').status, 'dismissed');

  const ready = makeCandidate('c2', 'ready', 2);
  assert.equal(transition(ready, 'accepted').status, 'accepted');
  assert.equal(transition(ready, 'dismissed').status, 'dismissed');

  // transition never mutates its argument.
  assert.equal(pending.status, 'pending');
  assert.equal(ready.status, 'ready');
}

// ── 2. transition_rejects_accepted_to_ready ──────────────────────────────
{
  const accepted = makeCandidate('c1', 'accepted', 1);
  assertThrowsMessage(() => transition(accepted, 'ready'), 'illegal candidate transition accepted -> ready');

  const dismissed = makeCandidate('c2', 'dismissed', 2);
  assertThrowsMessage(() => transition(dismissed, 'ready'), 'illegal candidate transition dismissed -> ready');

  const pending = makeCandidate('c3', 'pending', 3);
  assertThrowsMessage(() => transition(pending, 'accepted'), 'illegal candidate transition pending -> accepted');
}

// ── 3. auditionable_hides_dismissed ──────────────────────────────────────
{
  const set = makeSet([
    makeCandidate('c1', 'pending', 1),
    makeCandidate('c2', 'ready', 2),
    makeCandidate('c3', 'dismissed', 3),
    makeCandidate('c4', 'accepted', 4),
  ]);
  assert.deepEqual(auditionable(set).map((c) => c.id), ['c2', 'c4']);
}

// ── 4. selectNext_clamps_at_both_ends ────────────────────────────────────
{
  const set = makeSet([
    makeCandidate('c1', 'ready', 1),
    makeCandidate('c2', 'ready', 2),
    makeCandidate('c3', 'ready', 3),
  ]);

  // No selection yet: Down starts at the first candidate, Up at the last.
  assert.equal(selectNext(set, EMPTY_AUDITION, 1).selectedId, 'c1');
  assert.equal(selectNext(set, EMPTY_AUDITION, -1).selectedId, 'c3');

  // Walking forward from the first candidate reaches the last, then clamps.
  let state: AuditionState = { ...EMPTY_AUDITION, selectedId: 'c1' };
  state = selectNext(set, state, 1);
  assert.equal(state.selectedId, 'c2');
  state = selectNext(set, state, 1);
  assert.equal(state.selectedId, 'c3');
  state = selectNext(set, state, 1);
  assert.equal(state.selectedId, 'c3', 'clamped at the last candidate, never wraps');

  // Walking back from the last candidate reaches the first, then clamps.
  state = selectNext(set, state, -1);
  assert.equal(state.selectedId, 'c2');
  state = selectNext(set, state, -1);
  assert.equal(state.selectedId, 'c1');
  state = selectNext(set, state, -1);
  assert.equal(state.selectedId, 'c1', 'clamped at the first candidate, never wraps');
}

// ── 5. selectNext_noop_on_empty_set ──────────────────────────────────────
{
  const set = makeSet([makeCandidate('c1', 'pending', 1), makeCandidate('c2', 'dismissed', 2)]);
  const state: AuditionState = { ...EMPTY_AUDITION, selectedId: null };
  const result = selectNext(set, state, 1);
  assert.deepEqual(result, state);
  assert.notEqual(result, state, 'must return a new object even as a no-op');
}

// ── 6. toggleAb_clears_playing ───────────────────────────────────────────
{
  const playing: AuditionState = { setId: 'set-1', selectedId: 'c1', playingId: 'c1', abSide: 'source' };
  const toggled = toggleAb(playing);
  assert.equal(toggled.abSide, 'candidate');
  assert.equal(toggled.playingId, null);
  assert.equal(playing.playingId, 'c1', 'input untouched');

  const toggledAgain = toggleAb(toggled);
  assert.equal(toggledAgain.abSide, 'source');
  assert.equal(toggledAgain.playingId, null);
}

// ── 7. applyKey_space_toggles_play_then_stop ─────────────────────────────
{
  const set = makeSet([makeCandidate('c1', 'ready', 1)]);
  const selected: AuditionState = { ...EMPTY_AUDITION, selectedId: 'c1' };

  const played = applyKey(set, selected, ' ');
  assert.equal(played.action, 'play');
  assert.equal(played.state.playingId, 'c1');
  assert.deepEqual(playTarget(set, played.state), { kind: 'candidate', id: 'c1' });

  const stopped = applyKey(set, played.state, ' ');
  assert.equal(stopped.action, 'stop');
  assert.equal(stopped.state.playingId, null);
  assert.equal(playTarget(set, stopped.state), null);

  assert.equal(applyKey(set, EMPTY_AUDITION, ' ').action, 'none');
}

// ── 8. applyKey_enter_accepts_only_ready ─────────────────────────────────
{
  const set = makeSet([
    makeCandidate('c1', 'ready', 1),
    makeCandidate('c2', 'pending', 2),
    makeCandidate('c3', 'accepted', 3),
  ]);

  assert.equal(applyKey(set, { ...EMPTY_AUDITION, selectedId: 'c1' }, 'Enter').action, 'accept');
  assert.equal(applyKey(set, { ...EMPTY_AUDITION, selectedId: 'c2' }, 'Enter').action, 'none');
  assert.equal(applyKey(set, { ...EMPTY_AUDITION, selectedId: 'c3' }, 'Enter').action, 'none');
  assert.equal(applyKey(set, EMPTY_AUDITION, 'Enter').action, 'none');
}

// ── 9. applyKey_unknown_key_is_none_and_returns_same_state_values ───────
{
  const set = makeSet([makeCandidate('c1', 'ready', 1)]);
  const state: AuditionState = { setId: 'set-1', selectedId: 'c1', playingId: null, abSide: 'source' };
  const result = applyKey(set, state, 'Escape');
  assert.equal(result.action, 'none');
  assert.deepEqual(result.state, state);
  assert.notEqual(result.state, state, 'must return a new state object');
}

// ── 10. candidateLabel_includes_param_summary ────────────────────────────
{
  const set = makeSet([
    makeCandidate('c1', 'ready', 1, { duration: 8 }),
    makeCandidate('c2', 'ready', 2),
  ]);
  assert.equal(candidateLabel(set, set.candidates[0]), 'Take 1 · Length (s) 8');
  assert.equal(candidateLabel(set, set.candidates[1]), 'Take 2');
}

// ── 11. summarise_counts_every_status ────────────────────────────────────
{
  const set = makeSet([
    makeCandidate('c1', 'pending', 1),
    makeCandidate('c2', 'ready', 2),
    makeCandidate('c3', 'ready', 3),
    makeCandidate('c4', 'accepted', 4),
    makeCandidate('c5', 'dismissed', 5),
  ]);
  assert.deepEqual(summarise(set), { total: 5, ready: 2, accepted: 1, dismissed: 1 });
}

// ── 12. model_never_mutates_input ────────────────────────────────────────
{
  function deepFreeze(value: unknown): void {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const key of Object.getOwnPropertyNames(value)) {
        deepFreeze((value as Record<string, unknown>)[key]);
      }
      Object.freeze(value);
    }
  }

  const frozenSet = makeSet([
    makeCandidate('c1', 'ready', 1, { duration: 8 }),
    makeCandidate('c2', 'pending', 2),
    makeCandidate('c3', 'accepted', 3),
    makeCandidate('c4', 'dismissed', 4),
  ]);
  const frozenState: AuditionState = { setId: frozenSet.id, selectedId: 'c1', playingId: null, abSide: 'source' };
  deepFreeze(frozenSet);
  deepFreeze(frozenState);

  // None of these may throw (a write to a frozen object throws in strict
  // mode) or leave any mark on the frozen inputs.
  transition(frozenSet.candidates[0], 'accepted');
  auditionable(frozenSet);
  selectNext(frozenSet, frozenState, 1);
  toggleAb(frozenState);
  playTarget(frozenSet, frozenState);
  applyKey(frozenSet, frozenState, 'ArrowDown');
  applyKey(frozenSet, frozenState, ' ');
  applyKey(frozenSet, frozenState, 'Enter');
  applyKey(frozenSet, frozenState, 'b');
  candidateLabel(frozenSet, frozenSet.candidates[0]);
  summarise(frozenSet);

  assert.equal(frozenSet.candidates[0].status, 'ready', 'frozen candidate untouched');
  assert.equal(frozenSet.candidates.length, 4, 'frozen candidates array untouched');
  assert.equal(frozenState.selectedId, 'c1', 'frozen state untouched');
  assert.equal(frozenState.playingId, null, 'frozen state untouched');
}

console.log('candidatesModel: ok');
