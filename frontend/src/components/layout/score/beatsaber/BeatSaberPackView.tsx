import React, { useMemo } from 'react';
import { Download, Gamepad2 } from 'lucide-react';
import { notationArtifactUrl, type NotationArtifact } from '../../../../lib/notationClient';
import { allowedModes, usePlayAlongStore } from '../../../../state/playAlongStore';
import { describeArtifact } from '../scoreShared';
import { DIFFICULTY_LABELS, levelFolderName, parseBeatSaberMeta, totalNotes } from './beatsaberMeta';

export interface BeatSaberPackViewProps {
  /** The 'beatsaber' artifact (a .beatsaber.zip). */
  artifact: NotationArtifact;
  artifacts: NotationArtifact[];
  /** Select the sheet the pack was mapped from; the view has already switched
   *  the store to the highway's BLOCKS skin. */
  onOpenHighway: (source: NotationArtifact) => void;
}

/**
 * What a Beat Saber export produced: BPM and its source, notes per
 * difficulty, whether song.ogg made it into the pack, a DOWNLOAD ZIP link, an
 * OPEN IN HIGHWAY (BLOCKS) button that shows the very same notes in the
 * browser, and where the level folder goes.
 */
export const BeatSaberPackView: React.FC<BeatSaberPackViewProps> = ({ artifact, artifacts, onOpenHighway }) => {
  const setSkin = usePlayAlongStore((s) => s.setSkin);
  const setMode = usePlayAlongStore((s) => s.setMode);
  const meta = useMemo(() => parseBeatSaberMeta(artifact.metadata_json), [artifact.metadata_json]);
  const source = useMemo(
    () => artifacts.find((a) => a.id === artifact.source_ref) ?? null,
    [artifacts, artifact.source_ref],
  );
  const sourceCanHighway = !!source && allowedModes(source.kind).includes('highway');
  const folder = levelFolderName(artifact.path, meta.folder);
  const total = totalNotes(meta);

  const openHighway = () => {
    if (!source || !sourceCanHighway) return;
    setSkin('blocks');
    setMode('highway');
    onOpenHighway(source);
  };

  const bpmText = meta.bpm === null
    ? 'unknown'
    : `${Math.round(meta.bpm * 100) / 100} BPM (${
      meta.bpmSource === 'analysis'
        ? 'from the audio analysis'
        : meta.bpmSource === 'chart'
          ? 'the chart tempo'
          : 'source not recorded'
    })`;

  return (
    <div className="h-full overflow-auto grid place-items-center p-4 text-[10px] font-mono text-zinc-300">
      <div className="w-full max-w-md rounded-lg border border-white/10 bg-black/40 p-4 space-y-3">
        <header className="flex items-center gap-2">
          <Gamepad2 className="w-4 h-4 text-rose-300" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-[10px] font-black uppercase tracking-widest text-rose-200">Beat Saber pack</div>
            <div className="text-zinc-500 truncate" title={source?.id ?? artifact.source_ref ?? ''}>
              {source ? `from ${describeArtifact(source)}` : 'source sheet not in this list'}
            </div>
          </div>
        </header>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-zinc-500">BPM</dt>
          <dd className="tabular-nums">
            {bpmText}
            {meta.chartBpm !== null && meta.bpmSource === 'analysis' && (
              <span className="text-zinc-500"> · chart {Math.round(meta.chartBpm * 100) / 100}</span>
            )}
          </dd>
          <dt className="text-zinc-500">FORMAT</dt>
          <dd>{meta.version ? `v${meta.version}${meta.version === 2 ? ' (widest tool support)' : ''}` : 'unknown'}</dd>
          <dt className="text-zinc-500">PARTS</dt>
          <dd className="break-words">{meta.parts.length > 0 ? meta.parts.join(', ') : 'every pitched part'}</dd>
          <dt className="text-zinc-500">AUDIO</dt>
          <dd>
            {meta.songOgg ? (
              <span className="text-emerald-300">song.ogg encoded</span>
            ) : (
              <span className="text-amber-300/90">
                {meta.warning || 'no song.ogg in the pack'} — encode the track to Vorbis and add song.ogg to the level folder yourself.
              </span>
            )}
          </dd>
        </dl>

        <table className="w-full text-left border-t border-white/10">
          <caption className="sr-only">Notes per difficulty</caption>
          <thead>
            <tr className="text-[8px] uppercase tracking-widest text-zinc-500">
              <th scope="col" className="py-1 font-normal">Difficulty</th>
              <th scope="col" className="py-1 font-normal text-right">Notes</th>
            </tr>
          </thead>
          <tbody>
            {meta.difficulties.length === 0 && (
              <tr>
                <td colSpan={2} className="py-1 text-zinc-500">No difficulties recorded in this pack&apos;s metadata.</td>
              </tr>
            )}
            {meta.difficulties.map((d) => (
              <tr key={d} className="border-t border-white/5">
                <td className="py-1">{DIFFICULTY_LABELS[d] ?? d}</td>
                <td className="py-1 text-right tabular-nums">{meta.noteCounts[d] ?? 0}</td>
              </tr>
            ))}
          </tbody>
          {meta.difficulties.length > 1 && (
            <tfoot>
              <tr className="border-t border-white/10 text-zinc-400">
                <td className="py-1">Total</td>
                <td className="py-1 text-right tabular-nums">{total}</td>
              </tr>
            </tfoot>
          )}
        </table>

        <div className="flex flex-wrap gap-1.5">
          <a
            className="btn-ghost text-[9px] py-1 px-2 flex items-center gap-1"
            href={notationArtifactUrl(artifact.id)}
            download
            title="Download the zipped level"
          >
            <Download className="w-3 h-3" aria-hidden="true" /> DOWNLOAD ZIP
          </a>
          <button
            type="button"
            onClick={openHighway}
            disabled={!sourceCanHighway}
            className="btn-ghost text-[9px] py-1 px-2 flex items-center gap-1 disabled:opacity-40"
            title={sourceCanHighway
              ? 'Show these notes as Beat Saber blocks in the browser highway'
              : 'The sheet this pack was mapped from is not in the artifact list'}
          >
            <Gamepad2 className="w-3 h-3 text-rose-300" aria-hidden="true" /> OPEN IN HIGHWAY (BLOCKS)
          </button>
        </div>

        <p className="text-zinc-500 leading-relaxed">
          Install: unzip and copy the <code className="text-zinc-300">{folder || 'level'}</code> folder into{' '}
          <code className="text-zinc-300">Beat Saber_Data/CustomLevels</code>. The same note chart feeds the Unity scene and this
          highway.
        </p>
      </div>
    </div>
  );
};

export default BeatSaberPackView;
