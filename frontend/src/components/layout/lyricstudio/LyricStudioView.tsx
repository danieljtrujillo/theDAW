/**
 * The LYRIC tab: a place to write lyrics that belong to no song.
 *
 * The editor on the left, the literary analysis on the right — the SAME pane
 * the SING tab's STUDY view uses, mounted unchanged. It is mounted in its
 * hosted mode: this tab hands it the words (`text`) and the analysis of them
 * (`analysis`), and the pane then loads, runs and stores nothing of its own, so
 * the karaoke's document is left exactly where SING left it.
 *
 * `text` is the text the analysis was computed FROM, not the live draft —
 * every finding is anchored by line and word index, so a line typed since the
 * last pass would put somebody else's rhyme letter on it. Until there is an
 * analysis at all the live draft goes through instead, so the pane's ANALYSE
 * button has words to offer to.
 */
import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { SING_SPLIT_MAX, SING_SPLIT_MIN, useBottomPanelStore } from '../../../state/bottomPanelStore';
import { useLyricStudioStore } from '../../../state/lyricStudioStore';
import { PaneSplitter } from '../PaneSplitter';
import { DocumentRail } from './DocumentRail';
import { LyricEditor } from './LyricEditor';

// The analysis pane drags in the whole findings UI; it is the SING tab's own
// lazy chunk, so importing it here costs nothing extra.
const LyricAnalysisPane = lazy(() =>
  import('../sing/LyricAnalysisPane').then((m) => ({ default: m.LyricAnalysisPane })),
);

/** The pane the separator resizes, for its aria-controls. */
const EDITOR_PANE_ID = 'lyric-studio-editor-pane';

export const LyricStudioView: React.FC = () => {
  const lyricSplit = useBottomPanelStore((s) => s.lyricSplit);
  const setLyricSplit = useBottomPanelStore((s) => s.setLyricSplit);
  const docId = useLyricStudioStore((s) => s.docId);
  const title = useLyricStudioStore((s) => s.title);
  const draft = useLyricStudioStore((s) => s.draft);
  const analysis = useLyricStudioStore((s) => s.analysis);
  const analyzedText = useLyricStudioStore((s) => s.analyzedText);
  const analyzing = useLyricStudioStore((s) => s.analyzing);
  const rowRef = useRef<HTMLDivElement>(null);
  const [dragSplit, setDragSplit] = useState<number | null>(null);

  useEffect(() => {
    void useLyricStudioStore.getState().init();
  }, []);

  // Leaving the tab is a save point: the debounce may still be counting down.
  useEffect(
    () => () => {
      void useLyricStudioStore.getState().saveNow();
    },
    [],
  );

  const frac = Math.min(SING_SPLIT_MAX, Math.max(SING_SPLIT_MIN, dragSplit ?? lyricSplit));

  return (
    <div className="h-full min-h-0 flex flex-col bg-[#07050a]">
      <DocumentRail />
      <div ref={rowRef} className="flex-1 min-h-0 flex">
        <div
          id={EDITOR_PANE_ID}
          className="min-w-0 min-h-0 relative"
          style={{ flexGrow: frac, flexBasis: 0 }}
        >
          <div className="absolute inset-0">
            <LyricEditor />
          </div>
        </div>
        <PaneSplitter
          value={frac}
          onChange={setDragSplit}
          onCommit={(f) => {
            setDragSplit(null);
            setLyricSplit(f);
          }}
          containerRef={rowRef}
          controls={EDITOR_PANE_ID}
          label="Writing and analysis split"
          min={SING_SPLIT_MIN}
          max={SING_SPLIT_MAX}
        />
        <div className="min-w-0 min-h-0 relative" style={{ flexGrow: 1 - frac, flexBasis: 0 }}>
          <div className="absolute inset-0">
            {docId ? (
              <Suspense fallback={null}>
                <LyricAnalysisPane
                  entryId={docId}
                  title={title || 'Untitled'}
                  text={analysis ? analyzedText : draft}
                  analysis={analysis}
                  analyzing={analyzing}
                  onAnalyze={() => void useLyricStudioStore.getState().runAnalysis()}
                />
              </Suspense>
            ) : (
              <div className="h-full flex items-center justify-center px-4 text-center font-mono text-[10px] text-zinc-500">
                Opening the notebook…
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default LyricStudioView;
