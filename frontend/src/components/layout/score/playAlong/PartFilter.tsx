import React, { useEffect, useMemo } from 'react';
import { Drum } from 'lucide-react';
import {
  defaultPartVisibility,
  usePlayAlongStore,
  type PartDescriptor,
} from '../../../../state/playAlongStore';

export { defaultPartVisibility };
export type { PartDescriptor };

export interface PartFilterProps {
  artifactId: string;
  parts: PartDescriptor[];
  onChange?: (visible: boolean[]) => void;
}

/** Sanitize an artifact id into something an element id can carry. */
const idSlug = (artifactId: string): string => artifactId.replace(/[^A-Za-z0-9_-]+/g, '-');

/** Which parts of a multi-part score are drawn. State lives in the play-along
 *  store per artifact (session only); the first mount of an artifact seeds it
 *  with the default (everything except a 'full' mix when stems exist). One
 *  labelled checkbox per part, plus ALL / NONE. Percussion parts carry a drum
 *  mark so the drum staff is easy to find in a band score. */
export const PartFilter: React.FC<PartFilterProps> = ({ artifactId, parts, onChange }) => {
  const stored = usePlayAlongStore((s) => s.partVisibility[artifactId]);
  const setPartVisibility = usePlayAlongStore((s) => s.setPartVisibility);

  const visible = useMemo<boolean[]>(() => {
    if (stored && stored.length === parts.length) return stored;
    return defaultPartVisibility(parts);
  }, [stored, parts]);

  // Seed the store on first sight of an artifact (or when its part count
  // changed under us) so other views of the same artifact agree with us.
  useEffect(() => {
    if (!stored || stored.length !== parts.length) {
      setPartVisibility(artifactId, defaultPartVisibility(parts));
    }
  }, [artifactId, parts, stored, setPartVisibility]);

  const apply = (next: boolean[]) => {
    setPartVisibility(artifactId, next);
    onChange?.(next);
  };

  const slug = idSlug(artifactId);
  const allOn = visible.every(Boolean);
  const noneOn = !visible.some(Boolean);

  if (parts.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] font-mono text-zinc-300" aria-label="Visible parts">
      <span className="text-zinc-500 select-none">PARTS</span>
      {parts.map((part, i) => {
        const id = `score-part-${slug}-${i}`;
        return (
          <span key={id} className="flex items-center gap-1">
            <input
              id={id}
              name={id}
              type="checkbox"
              className="accent-emerald-400"
              checked={visible[i] ?? true}
              onChange={() => {
                const next = visible.slice();
                next[i] = !next[i];
                apply(next);
              }}
            />
            <label htmlFor={id} className="cursor-pointer select-none flex items-center gap-0.5">
              {part.isPercussion && (
                <Drum className="w-3 h-3 text-amber-300" aria-hidden="true" />
              )}
              {part.name || `Part ${i + 1}`}
              {part.isPercussion && <span className="sr-only"> (percussion)</span>}
            </label>
          </span>
        );
      })}
      <button
        type="button"
        onClick={() => apply(parts.map(() => true))}
        disabled={allOn}
        className="px-1 py-0.5 rounded hover:bg-white/10 disabled:opacity-30"
        title="Show every part"
      >
        ALL
      </button>
      <button
        type="button"
        onClick={() => apply(parts.map(() => false))}
        disabled={noneOn}
        className="px-1 py-0.5 rounded hover:bg-white/10 disabled:opacity-30"
        title="Hide every part"
      >
        NONE
      </button>
    </div>
  );
};

export default PartFilter;
