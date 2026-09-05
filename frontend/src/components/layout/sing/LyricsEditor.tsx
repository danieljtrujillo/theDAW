import React, { useEffect, useMemo, useRef, useState } from 'react';

export interface LyricsEditorProps {
  initialText: string;
  onApply: (text: string) => void;
  onImportLrc: (content: string) => void;
  onCancel: () => void;
}

const LRC_RE = /^\s*\[\d{1,2}:\d{2}/m;

/** Plain-text editor for the lyrics. Ctrl/Cmd+Enter applies, Escape cancels;
 *  pasted LRC is spotted and offered as an import instead. Timings for lines
 *  that did not change survive an APPLY (the server diffs by line). */
export const LyricsEditor: React.FC<LyricsEditorProps> = ({ initialText, onApply, onImportLrc, onCancel }) => {
  const [draft, setDraft] = useState(initialText);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  const looksLikeLrc = useMemo(() => LRC_RE.test(draft), [draft]);
  const counts = useMemo(() => {
    const lines = draft.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
    const words = draft.split(/\s+/).filter(Boolean).length;
    return { lines, words };
  }, [draft]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      onApply(draft);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="h-full flex flex-col gap-2 p-2">
      <label htmlFor="sing-lyrics-text" className="sr-only">Lyrics</label>
      <textarea
        ref={areaRef}
        id="sing-lyrics-text"
        name="sing-lyrics-text"
        className="flex-1 min-h-0 w-full resize-none rounded border border-white/10 bg-black/40 p-3 font-mono text-[12px] leading-relaxed text-zinc-100 focus:border-rose-500/50 focus:outline-none"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={'Paste the lyrics here, one line per line.\n[Chorus] and (bridge) on their own line become section markers.'}
        spellCheck={false}
      />
      <div className="shrink-0 flex items-center gap-2 text-[10px] font-mono text-zinc-400">
        <span className="tabular-nums">{counts.lines} lines · {counts.words} words</span>
        {looksLikeLrc && (
          <button
            type="button"
            className="btn-ghost text-[9px] py-1 px-2 border border-amber-500/40 text-amber-200"
            onClick={() => onImportLrc(draft)}
            title="This looks like an LRC file: import it with its timestamps instead of pasting it as plain text"
          >
            LOOKS LIKE LRC — IMPORT AS LRC
          </button>
        )}
        <span className="ml-auto flex items-center gap-1">
          <button type="button" className="btn-ghost text-[9px] py-1 px-2" onClick={onCancel} title="Discard the edit (Esc)">
            CANCEL
          </button>
          <button
            type="button"
            className="btn-ghost text-[9px] py-1 px-2 border border-rose-500/40 text-rose-200"
            onClick={() => onApply(draft)}
            title="Save the text (Ctrl+Enter). Lines that did not change keep their timings."
          >
            APPLY
          </button>
        </span>
      </div>
    </div>
  );
};

export default LyricsEditor;
