/**
 * SECTIONS block for the DETAILS panel: the song's form as the section finder
 * reads it (backend/modules/sections, lib/songSections).
 *
 * The strip draws each section as a block on the song's length, coloured by
 * its repeat letter (a varied repeat, A', is the letter's colour lighter). The
 * list under it gives each section's letter, a name field, a role picker, its
 * start, its bars and how clear the change into it is. A rename (Enter or
 * leaving the field) and a new role are saved with the entry at once, and a
 * later FIND keeps them.
 *
 * Finding is on demand: FIND reads the whole song (seconds of CPU), and the
 * stored sections are shown as they are until it is pressed again.
 */
import React, { useCallback, useEffect, useId, useState } from 'react';
import { ListTree, Loader2 } from 'lucide-react';
import { logError, logInfo } from '../../state/logStore';
import {
  SECTION_ROLES,
  editSongSection,
  fetchSongSections,
  findSongSections,
  gridWords,
  letterTone,
  roleTitle,
  sectionClock,
  type SongSection,
  type SongSectionsDoc,
} from '../../lib/songSections';

type Phase = 'loading' | 'none' | 'finding' | 'found' | 'failed';

const PHASE_WORD: Record<Phase, string> = {
  loading: 'Reading',
  none: 'None',
  finding: 'Finding',
  found: 'Found',
  failed: 'Failed',
};

const PHASE_DOT: Record<Phase, string> = {
  loading: 'bg-zinc-500',
  none: 'bg-zinc-500',
  finding: 'bg-amber-400 animate-pulse',
  found: 'bg-emerald-400',
  failed: 'bg-rose-500',
};

export const SectionsBlock: React.FC<{ entryId: string | null; title: string }> = ({ entryId, title }) => {
  const [doc, setDoc] = useState<SongSectionsDoc | null>(null);
  const [phase, setPhase] = useState<Phase>('none');
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');

  useEffect(() => {
    let live = true;
    setDoc(null);
    if (!entryId) {
      setPhase('none');
      return undefined;
    }
    setPhase('loading');
    fetchSongSections(entryId)
      .then((d) => {
        if (!live) return;
        setDoc(d.status === 'ready' ? d : null);
        setPhase(d.status === 'ready' ? 'found' : 'none');
      })
      .catch(() => {
        if (live) setPhase('none');
      });
    return () => {
      live = false;
    };
  }, [entryId]);

  const find = useCallback(async () => {
    if (!entryId || phase === 'finding') return;
    setPhase('finding');
    try {
      const d = await findSongSections(entryId);
      setDoc(d);
      setPhase('found');
      const n = d.sections?.length ?? 0;
      logInfo('sections', `Found ${n} section${n === 1 ? '' : 's'} in "${title}"${d.elapsed_sec ? ` in ${d.elapsed_sec}s` : ''}`);
    } catch (e) {
      setPhase(doc ? 'found' : 'failed');
      logError('sections', `Finding the sections of "${title}" failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [doc, entryId, phase, title]);

  const edit = useCallback(
    async (index: number, patch: { name?: string; role?: string }) => {
      if (!entryId) return;
      try {
        setDoc(await editSongSection(entryId, index, patch));
      } catch (e) {
        logError('sections', `Could not save the section: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [entryId],
  );

  const sections = doc?.sections ?? [];
  const total = Math.max(doc?.duration_sec ?? 0, sections.length ? sections[sections.length - 1].end_sec : 0, 1e-6);
  const statusId = `sections-status-${uid}`;

  return (
    <div data-tour="song-sections" className="mt-3 p-2 rounded border border-emerald-500/25 bg-emerald-500/4">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <h3 className="flex items-center gap-1.5 font-display text-[12px] font-bold uppercase et-ink">
          <ListTree aria-hidden="true" className="w-3.5 h-3.5 text-emerald-300" /> Sections
        </h3>
        <div className="flex items-center gap-2">
          <span id={statusId} role="status" className="flex items-center gap-1.5 text-[12px] font-bold et-ink-2">
            <span aria-hidden="true" className={`w-2 h-2 rounded-full ${PHASE_DOT[phase]}`} />
            {PHASE_WORD[phase]}
          </span>
          <button
            type="button"
            onClick={() => void find()}
            disabled={!entryId || phase === 'finding' || phase === 'loading'}
            aria-describedby={statusId}
            className="btn-ghost h-6 px-2 flex items-center gap-1 text-[12px] font-bold disabled:opacity-40"
            title="Find the song's sections: boundaries on its bar lines from what changes and what repeats, with repeat letters and roles. Your names and roles are kept."
          >
            {phase === 'finding' ? <Loader2 aria-hidden="true" className="w-3 h-3 animate-spin" /> : <ListTree aria-hidden="true" className="w-3 h-3 text-emerald-300" />}
            {doc ? 'Find again' : 'Find'}
          </button>
        </div>
      </div>

      {phase === 'finding' && (
        <p className="text-[12px] font-semibold et-ink-3 mb-1">Reading the whole song and its stems; a few seconds for a three-minute track.</p>
      )}
      {phase === 'none' && entryId && (
        <p className="text-[12px] font-semibold et-ink-3">Not read yet. FIND marks where the song changes and names each part.</p>
      )}

      {sections.length > 0 && (
        <>
          <div aria-hidden="true" className="relative h-7 mb-1 rounded-xs overflow-hidden bg-white/4">
            {sections.map((s) => (
              <div
                key={s.index}
                className={`absolute top-0 bottom-0 border-r border-black/60 flex items-center justify-center overflow-hidden ${letterTone(s.letter)}`}
                style={{ left: `${(s.start_sec / total) * 100}%`, width: `${((s.end_sec - s.start_sec) / total) * 100}%` }}
                title={`${s.letter} · ${s.name} · ${sectionClock(s.start_sec)}`}
              >
                <span className="text-[12px] font-extrabold text-black/80 truncate px-0.5">{s.letter}</span>
              </div>
            ))}
          </div>
          <p className="text-[12px] font-semibold et-ink-3 mb-1">{gridWords(doc)}</p>
          <ul aria-label={`Sections of ${title}`} className="flex flex-col gap-0.5">
            {sections.map((s) => (
              <SectionRow key={`${s.index}-${s.start_sec}`} section={s} uid={uid} onEdit={edit} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
};

/** One section: letter, name field, role picker, start, bars, confidence. */
function SectionRow({
  section: s,
  uid,
  onEdit,
}: {
  section: SongSection;
  uid: string;
  onEdit: (index: number, patch: { name?: string; role?: string }) => Promise<void>;
}) {
  const [draft, setDraft] = useState(s.name);
  useEffect(() => setDraft(s.name), [s.name]);
  const nameId = `section-name-${uid}-${s.index}`;
  const roleId = `section-role-${uid}-${s.index}`;
  const commit = () => {
    const text = draft.trim();
    if (!text) setDraft(s.name);
    else if (text !== s.name) void onEdit(s.index, { name: text });
  };
  const confidence = Math.round(s.confidence * 100);
  return (
    <li className="grid grid-cols-[2.25rem_minmax(0,1fr)_6rem_3.5rem_3rem_3rem] items-center gap-1.5" data-section-row={s.index}>
      <span className={`h-6 rounded-xs flex items-center justify-center text-[12px] font-extrabold text-black/80 ${letterTone(s.letter)}`} title={s.repeat_of !== null ? `Repeats section ${s.repeat_of + 1}` : 'First time heard'}>
        {s.letter}
      </span>
      <label htmlFor={nameId} className="sr-only">
        Name of section {s.index + 1}, {s.letter}
      </label>
      <input
        id={nameId}
        name={nameId}
        type="text"
        maxLength={64}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') {
            setDraft(s.name);
            window.requestAnimationFrame(() => (document.getElementById(nameId) as HTMLInputElement | null)?.blur());
          }
        }}
        className="h-6 min-w-0 px-1.5 rounded-xs bg-white/5 border border-white/10 text-[12px] font-bold et-ink outline-none focus:border-emerald-400"
      />
      <label htmlFor={roleId} className="sr-only">
        Role of section {s.index + 1}
      </label>
      <select
        id={roleId}
        name={roleId}
        value={s.role}
        onChange={(e) => void onEdit(s.index, { role: e.target.value })}
        className="h-6 px-1 rounded-xs bg-white/5 border border-white/10 text-[12px] font-bold et-ink cursor-pointer"
      >
        {SECTION_ROLES.map((r) => (
          <option key={r} value={r}>
            {roleTitle(r)}
          </option>
        ))}
      </select>
      <span className="text-[12px] font-bold tabular-nums et-ink-2 text-right" title="Where it starts">
        {sectionClock(s.start_sec)}
      </span>
      <span className="text-[12px] font-bold tabular-nums et-ink-2 text-right" title="Bars">
        {s.bars} bar{s.bars === 1 ? '' : 's'}
      </span>
      <span
        className={`text-[12px] font-bold tabular-nums text-right ${confidence >= 70 ? 'text-emerald-300' : confidence >= 45 ? 'et-ink-2' : 'text-amber-300'}`}
        title="How clear the change into this section is"
      >
        {confidence}%
      </span>
    </li>
  );
}
