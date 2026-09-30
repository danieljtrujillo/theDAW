// candidatesModel: the candidate-drawer state machine, kept DOM-free so it is
// testable in isolation. Owns three things: the per-candidate lifecycle
// (pending -> ready -> accepted | dismissed), which candidate is selected for
// A/B audition against the set's source, and the keyboard map that drives
// that audition (Up/Down select, Space play/stop, Enter accept, b/B flips
// the A/B side).
//
// Pure functions only: no fetch, no React, no zustand, no timers, no DOM.
// Every exported function returns a NEW object; none mutate their arguments.
// Backend shapes mirror backend/modules/candidates/store.py (F13-1); the
// per-candidate params line reuses providers/capabilities.ts (F13-3) rather
// than re-deriving it here.

import { paramSummary } from '../providers/capabilities.ts';

export type CandidateStatus = 'pending' | 'ready' | 'accepted' | 'dismissed';

export interface CandidateSource {
  kind: 'clip' | 'clip-range' | 'library-entry';
  id: string;
  revision?: string;
  startSec?: number;
  endSec?: number;
}

export interface Candidate {
  id: string;
  status: CandidateStatus;
  params: Record<string, unknown>;
  seed?: number | null;
  providerJobId?: string | null;
  createdAt: number;
  libraryEntryId?: string | null;
}

export interface CandidateSet {
  id: string;
  source: CandidateSource;
  provider: string;
  params: Record<string, unknown>;
  label: string;
  createdAt: number;
  candidates: Candidate[];
}

export interface AuditionState {
  setId: string | null;
  selectedId: string | null;
  playingId: string | null;
  abSide: 'source' | 'candidate';
}

/** Resting audition state: nothing selected, nothing playing. `abSide`
 *  starts on 'candidate' — the default is to hear the take under review;
 *  `toggleAb` flips it to 'source' to compare against the original. */
export const EMPTY_AUDITION: AuditionState = {
  setId: null,
  selectedId: null,
  playingId: null,
  abSide: 'candidate',
};

/** Legal lifecycle edges: pending can become ready or dismissed; ready can
 *  become accepted or dismissed; accepted and dismissed are terminal. */
const LEGAL_TRANSITIONS: Readonly<Record<CandidateStatus, readonly CandidateStatus[]>> = {
  pending: ['ready', 'dismissed'],
  ready: ['accepted', 'dismissed'],
  accepted: [],
  dismissed: [],
};

export function transition(c: Candidate, next: CandidateStatus): Candidate {
  if (!LEGAL_TRANSITIONS[c.status].includes(next)) {
    throw new Error(`illegal candidate transition ${c.status} -> ${next}`);
  }
  return { ...c, status: next };
}

/** Every candidate in `set`, ordered by `createdAt` (a stable sort, so ties
 *  keep their original relative order). Both `auditionable` and
 *  `candidateLabel` build on this single ordering, so a candidate's take
 *  number never shifts just because an earlier take was later dismissed. */
function inCreationOrder(set: CandidateSet): Candidate[] {
  return [...set.candidates].sort((a, b) => a.createdAt - b.createdAt);
}

export function auditionable(set: CandidateSet): Candidate[] {
  return inCreationOrder(set).filter((c) => c.status === 'ready' || c.status === 'accepted');
}

export function selectNext(set: CandidateSet, state: AuditionState, delta: 1 | -1): AuditionState {
  const list = auditionable(set);
  if (list.length === 0) return { ...state };

  const currentIndex = state.selectedId === null ? -1 : list.findIndex((c) => c.id === state.selectedId);
  const nextIndex = currentIndex === -1
    ? (delta === 1 ? 0 : list.length - 1)
    : Math.min(list.length - 1, Math.max(0, currentIndex + delta));

  return { ...state, selectedId: list[nextIndex].id };
}

export function toggleAb(state: AuditionState): AuditionState {
  return { ...state, abSide: state.abSide === 'source' ? 'candidate' : 'source', playingId: null };
}

export function playTarget(
  set: CandidateSet,
  state: AuditionState,
): { kind: 'source' | 'candidate'; id: string } | null {
  if (state.playingId === null) return null;
  return state.abSide === 'source'
    ? { kind: 'source', id: set.source.id }
    : { kind: 'candidate', id: state.playingId };
}

export function applyKey(
  set: CandidateSet,
  state: AuditionState,
  key: string,
): { state: AuditionState; action: 'none' | 'play' | 'stop' | 'accept' | 'ab' } {
  if (key === 'ArrowDown') return { state: selectNext(set, state, 1), action: 'none' };
  if (key === 'ArrowUp') return { state: selectNext(set, state, -1), action: 'none' };

  if (key === ' ') {
    if (state.selectedId === null) return { state: { ...state }, action: 'none' };
    return state.playingId !== null
      ? { state: { ...state, playingId: null }, action: 'stop' }
      : { state: { ...state, playingId: state.selectedId }, action: 'play' };
  }

  if (key === 'Enter') {
    const selected = state.selectedId === null
      ? undefined
      : set.candidates.find((c) => c.id === state.selectedId);
    return selected?.status === 'ready'
      ? { state: { ...state }, action: 'accept' }
      : { state: { ...state }, action: 'none' };
  }

  if (key === 'b' || key === 'B') return { state: toggleAb(state), action: 'ab' };

  return { state: { ...state }, action: 'none' };
}

export function candidateLabel(set: CandidateSet, c: Candidate): string {
  const index = inCreationOrder(set).findIndex((x) => x.id === c.id);
  const label = `Take ${index + 1}`;
  const summary = paramSummary(set.provider, c.params);
  return summary ? `${label} · ${summary}` : label;
}

export function summarise(set: CandidateSet): { total: number; ready: number; accepted: number; dismissed: number } {
  let ready = 0;
  let accepted = 0;
  let dismissed = 0;
  for (const c of set.candidates) {
    if (c.status === 'ready') ready += 1;
    else if (c.status === 'accepted') accepted += 1;
    else if (c.status === 'dismissed') dismissed += 1;
  }
  return { total: set.candidates.length, ready, accepted, dismissed };
}
