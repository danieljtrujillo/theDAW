import React, { useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { rewriteSheetFromMidi, type NotationArtifact } from '../../../lib/notationClient';
import { logError, logInfo } from '../../../state/logStore';

/**
 * The bar over a sheet an older build wrote with its transposing parts at the
 * pitch they sound (a clarinet, horn, trumpet, saxophone, English horn,
 * piccolo, contrabass or banjo part printed a transposition off). This build
 * reads such a sheet at the right pitch, but the file still prints the wrong
 * notes for a player or a PDF. "Rewrite from MIDI" engraves it again from the
 * MIDI it came from, at written pitch, over the same file; the backend keeps
 * the old file until the new one is written. Shown only for such a sheet.
 */
export const LegacySheetNotice: React.FC<{
  entryId: string;
  artifact: NotationArtifact;
  onRewritten: (artifact: NotationArtifact | null) => void | Promise<void>;
}> = ({ entryId, artifact, onRewritten }) => {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (artifact.kind !== 'musicxml' || !artifact.legacy_sounding_pitch) return null;

  const rewrite = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const next = await rewriteSheetFromMidi(entryId, artifact.id);
      logInfo('score', `Rewrote ${artifact.id} from its MIDI at written pitch`);
      await onRewritten(next);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setFailed(message);
      logError('score', `Rewrite from MIDI failed for ${artifact.id}: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 flex flex-wrap items-center gap-2 px-3 py-1.5 border-b border-amber-500/30 bg-amber-500/10 text-xs font-bold text-amber-100">
      <span className="min-w-0 flex-1">
        An older build wrote this sheet with its transposing parts at the pitch they sound, so they print a transposition off.
        {artifact.rewrite_from_midi
          ? ' Rewrite it from its MIDI to print written pitch; the old file stays until the new one is written.'
          : ' Its MIDI is not in the library, so it cannot be rewritten here.'}
      </span>
      {artifact.rewrite_from_midi && (
        <button
          type="button"
          onClick={() => void rewrite()}
          disabled={busy}
          aria-label="Rewrite this sheet from its MIDI at written pitch"
          title="Engrave the sheet again from the MIDI it was made from, with each transposing part at written pitch. The old file is kept until the new one is written."
          className="h-7 shrink-0 inline-flex items-center gap-1.5 rounded border border-amber-400/60 bg-amber-500/20 px-2.5 font-display text-xs font-bold uppercase text-amber-100 transition-colors hover:bg-amber-500/30 disabled:opacity-50 outline-none focus-visible:ring-1 focus-visible:ring-amber-300/70"
        >
          {busy ? <Loader2 aria-hidden="true" className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw aria-hidden="true" className="w-3.5 h-3.5" />}
          <span>{busy ? 'Rewriting' : 'Rewrite from MIDI'}</span>
        </button>
      )}
      <span role="status" className={failed ? 'w-full text-xs font-bold text-red-200' : 'sr-only'}>
        {failed ? `Rewrite failed: ${failed}` : busy ? 'Rewriting the sheet from its MIDI' : ''}
      </span>
    </div>
  );
};
