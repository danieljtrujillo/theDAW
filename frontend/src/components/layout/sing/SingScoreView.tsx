/**
 * The SING tab body: the karaoke lyrics, the whole SCORE tab and the literary
 * analysis, alone or side by side. `singPane` (bottomPanelStore) chooses the
 * layout — LYRICS or SCORE fills the panel, BOTH and STUDY split it at
 * `singSplit` with a draggable separator, the lyrics always on the left.
 * Mirrors DetailsMediaView, which does the same for DETAILS / MEDIA.
 *
 * SCORE is mounted whole, not one of its play-along modes: it owns the
 * artifact list and PAGE's engravers, so embedding it gets every mode for free
 * and the mode picker keeps working inside the split.
 *
 * Each column is a bounded box (`relative` + an `absolute inset-0` child).
 * Without that, OSMD's and alphaTab's ResizeObservers measure a zero-height
 * flex item on the first pass and the score renders blank.
 *
 * A pane is mounted on first use and then kept alive (hidden) across pane
 * switches, the way ScoreView keeps its own play-along modes: re-mounting the
 * score costs an artifact reload and a full synchronous OSMD engrave.
 */
import React, { Suspense, lazy, useRef, useState } from 'react';
import {
  SING_SPLIT_MAX,
  SING_SPLIT_MIN,
  useBottomPanelStore,
} from '../../../state/bottomPanelStore';
import { useLibraryStore } from '../../../state/libraryStore';
import { PlayAlongTransportCompact } from '../score/playAlong/PlayAlongTransport';
import { PaneSplitter } from '../PaneSplitter';

// SingView stays lazy exactly as the SING tab had it in BottomMultiTabPanel:
// the pitch lane and mic capture arrive only when the tab is opened.
const SingView = lazy(() => import('./SingView').then((m) => ({ default: m.SingView })));
// ScoreView is NOT a code-split win — BottomMultiTabPanel already imports it
// statically for the SCORE tab, so this resolves to the same chunk. It is
// dynamic only to keep the two panes symmetrical here.
const ScoreView = lazy(() => import('../ScoreView').then((m) => ({ default: m.ScoreView })));
// The analysis pane pulls in the whole findings UI and its store, and nothing
// else imports either, so this one really is its own chunk.
const LyricAnalysisPane = lazy(() =>
  import('./LyricAnalysisPane').then((m) => ({ default: m.LyricAnalysisPane })),
);

/** The pane the separator resizes, for its aria-controls. */
const LYRICS_PANE_ID = 'sing-split-lyrics-pane';

export const SingScoreView: React.FC = () => {
  const pane = useBottomPanelStore((s) => s.singPane);
  const singSplit = useBottomPanelStore((s) => s.singSplit);
  const setSingSplit = useBottomPanelStore((s) => s.setSingSplit);
  const entry = useLibraryStore((s) =>
    s.selectedEntryId ? s.entries.find((e) => e.id === s.selectedEntryId) ?? null : null,
  );
  const rowRef = useRef<HTMLDivElement>(null);
  // Panes shown at least once; they stay mounted from then on (see below).
  const visitedRef = useRef<Set<string>>(new Set());
  // Live fraction while the separator is dragged; the store only takes the
  // settled value on release, so a drag doesn't write persisted state per frame.
  const [dragSplit, setDragSplit] = useState<number | null>(null);

  const lyrics = (
    <Suspense fallback={null}>
      <SingView />
    </Suspense>
  );
  // SingView early-returns a bare placeholder — no footer at all — when nothing
  // is selected or the selection is not audio (SingView.tsx: `!entry` and
  // `!isAudio`). The score's transport may only be compacted while that footer
  // is really on screen, or the split would have no play button anywhere.
  const singFooterShown = !!entry && (!entry.kind || entry.kind === 'audio');
  // `compact` on the score side only in the split: SING's own footer already
  // carries play/pause and the OTHER TRACK badge for the same entry, so the
  // score's transports drop theirs (they keep OFFSET/CALIBRATE — a different
  // quantity from SING's per-song lyric offset, and with no other home).
  // Alone, SCORE is exactly the standalone tab.
  const score = (
    <PlayAlongTransportCompact.Provider value={pane === 'split' && singFooterShown}>
      <Suspense fallback={null}>
        <ScoreView />
      </Suspense>
    </PlayAlongTransportCompact.Provider>
  );

  const analysis = (
    <Suspense fallback={null}>
      <LyricAnalysisPane entryId={entry?.id ?? null} title={entry?.title} />
    </Suspense>
  );

  // BOTH and STUDY are the same two-column layout with a different right-hand
  // pane, so they share the separator and the stored fraction. The analysis
  // only means anything beside the words it describes, hence never alone.
  const split = pane === 'split' || pane === 'analysis';
  const showLyrics = pane !== 'score';
  const showScore = pane === 'score' || pane === 'split';

  // Clamped on read as well as on write: the setter bounds it, but a value
  // restored from localStorage predates that check, and a fraction outside the
  // range makes `1 - frac` negative and the flexGrow declaration invalid.
  const frac = Math.min(SING_SPLIT_MAX, Math.max(SING_SPLIT_MIN, dragSplit ?? singSplit));

  // Panes are HIDDEN rather than unmounted once they have been shown, the same
  // way ScoreView keeps its own play-along modes alive. Unmounting ScoreView
  // here cost a full artifact reload and a synchronous OSMD engrave on every
  // pane click — measured at ~10 s on a 7-part band score, which is what made
  // the tab feel frozen. A hidden pane is display:none, so its ResizeObserver
  // reports a 0x0 box; ScoreView's computePageW holds its last good width for
  // exactly that case, so parking here does not re-engrave at a bogus width.
  const seen = visitedRef.current;
  if (showLyrics) seen.add('lyrics');
  if (showScore) seen.add('score');
  if (pane === 'analysis') seen.add('analysis');

  return (
    <div ref={rowRef} className="h-full flex min-h-0">
      <div
        id={LYRICS_PANE_ID}
        className="flex-1 min-w-0 min-h-0 relative"
        style={{ flexGrow: split ? frac : 1 }}
        hidden={!showLyrics}
      >
        {seen.has('lyrics') && <div className="absolute inset-0">{lyrics}</div>}
      </div>
      {split && (
        <PaneSplitter
          value={frac}
          onChange={setDragSplit}
          onCommit={(f) => {
            setDragSplit(null);
            setSingSplit(f);
          }}
          containerRef={rowRef}
          controls={LYRICS_PANE_ID}
          label={pane === 'analysis' ? 'Lyrics and analysis split' : 'Lyrics and score split'}
          min={SING_SPLIT_MIN}
          max={SING_SPLIT_MAX}
        />
      )}
      <div
        className="flex-1 min-w-0 min-h-0 relative"
        style={{ flexGrow: split ? 1 - frac : 1 }}
        hidden={!showScore}
      >
        {seen.has('score') && <div className="absolute inset-0">{score}</div>}
      </div>
      <div
        className="flex-1 min-w-0 min-h-0 relative"
        style={{ flexGrow: 1 - frac }}
        hidden={pane !== 'analysis'}
      >
        {seen.has('analysis') && <div className="absolute inset-0">{analysis}</div>}
      </div>
    </div>
  );
};

export default SingScoreView;
