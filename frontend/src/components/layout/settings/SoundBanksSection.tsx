/**
 * Settings → Sound banks: orchestral banks the download manager fetches, or
 * links to, each with its licence on the row before any download starts.
 *
 * A download is an ordinary job in the DownloadDock (kind 'soundbank'); when
 * one finishes the list is read again so the row says Installed and the bank
 * files are on disk for the soundfont pickers. SFZ-only libraries cannot load
 * in the soundfont engine, so their row opens the upstream download page.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Download, ExternalLink, Library, Loader2 } from 'lucide-react';
import { formatBytes } from '../../../lib/storageClient';
import {
  SOUNDBANK_STATE_LABEL,
  fetchSoundbanks,
  soundbankSizeText,
  soundbankState,
  type SoundbankEntry,
  type SoundbankState,
} from '../../../lib/soundbankClient';
import { useDownloadStore } from '../../../state/downloadStore';
import { BTN_GHOST_12, BTN_PURPLE_12, CARD, SectionHeader } from './shared';

const STATE_DOT: Record<SoundbankState, string> = {
  link: 'bg-sky-400',
  available: 'bg-zinc-400',
  downloading: 'bg-purple-400 animate-pulse',
  installed: 'bg-emerald-400',
  failed: 'bg-rose-400',
};

const TIP =
  'Orchestral sound banks for the MIDI parts. SF2 and SF3 banks download into theDAW\'s data folder and appear in the soundfont pickers. ' +
  'SFZ libraries play in an SFZ player such as sfizz, loaded as a VST3 instrument, so their rows open the download page. ' +
  'Each row names the licence the bank comes under; read it before you download.';

export interface SoundBankRowProps {
  entry: SoundbankEntry;
  state: SoundbankState;
  busy: boolean;
  error: string | null;
  onDownload: (entry: SoundbankEntry) => void;
}

/** One catalog row. Exported for the tests; the section renders one per bank. */
export const SoundBankRow: React.FC<SoundBankRowProps> = ({ entry, state, busy, error, onDownload }) => {
  const titleId = `soundbank-${entry.id}-title`;
  const licenceId = `soundbank-${entry.id}-licence`;
  const downloading = state === 'downloading' || busy;
  return (
    <li className={`${CARD} px-2 py-1.5`} aria-labelledby={titleId} data-soundbank={entry.id}>
      <div className="flex items-center gap-1.5 min-w-0">
        <span id={titleId} className="text-xs font-bold text-zinc-100 truncate" title={entry.label}>
          {entry.label}
        </span>
        <span className="shrink-0 rounded border border-white/10 px-1 text-xs font-bold uppercase text-zinc-300">
          {entry.format}
        </span>
        <span className="shrink-0 text-xs font-bold tabular-nums text-zinc-400">{soundbankSizeText(entry, formatBytes)}</span>
        <span
          className="ml-auto flex shrink-0 items-center gap-1 text-xs font-bold text-zinc-300"
          title={entry.installed.length ? entry.installed.join('\n') : undefined}
          data-soundbank-state={state}
        >
          <span aria-hidden="true" className={`h-2 w-2 rounded-full ${STATE_DOT[state]}`} />
          {SOUNDBANK_STATE_LABEL[state]}
        </span>
      </div>
      <p className="mt-0.5 text-xs font-bold text-zinc-400 line-clamp-2" title={entry.credit}>
        {entry.summary}
      </p>
      <p id={licenceId} className="mt-1 text-xs font-bold text-zinc-300" data-soundbank-licence>
        Licence:{' '}
        <a
          href={entry.licence.url}
          target="_blank"
          rel="noreferrer"
          className="font-bold text-emerald-300 underline decoration-emerald-500/40 underline-offset-2 hover:text-emerald-100"
        >
          {entry.licence.name}
        </a>
        <span className="block text-zinc-400">{entry.licence.summary}</span>
      </p>
      {entry.notes && <p className="mt-0.5 text-xs font-bold text-amber-200/90">{entry.notes}</p>}
      <div className="mt-1.5 flex items-center gap-1.5">
        {entry.kind === 'link' ? (
          <a
            href={entry.homepage}
            target="_blank"
            rel="noreferrer"
            aria-describedby={licenceId}
            aria-label={`Open the ${entry.label} download page (opens in a new window)`}
            className={BTN_GHOST_12}
          >
            <ExternalLink className="w-3 h-3" aria-hidden="true" />
            Open download page
          </a>
        ) : (
          <button
            type="button"
            onClick={() => onDownload(entry)}
            disabled={downloading}
            aria-describedby={licenceId}
            aria-label={`${state === 'installed' ? 'Download again' : 'Download'} ${entry.label}, licensed ${entry.licence.name}`}
            className={BTN_PURPLE_12}
          >
            {downloading ? (
              <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="w-3 h-3" aria-hidden="true" />
            )}
            {downloading ? 'Downloading' : state === 'installed' ? 'Download again' : 'Download'}
          </button>
        )}
        {entry.kind === 'download' && (
          <a
            href={entry.homepage}
            target="_blank"
            rel="noreferrer"
            aria-label={`${entry.label} source page (opens in a new window)`}
            className={BTN_GHOST_12}
          >
            <ExternalLink className="w-3 h-3" aria-hidden="true" />
            Source
          </a>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs font-bold text-rose-300">
          {error}
        </p>
      )}
    </li>
  );
};

export const SoundBanksSection: React.FC = () => {
  const [banks, setBanks] = useState<SoundbankEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const jobs = useDownloadStore((s) => s.jobs);
  const startDownload = useDownloadStore((s) => s.startDownload);

  const load = useCallback(async () => {
    try {
      setBanks(await fetchSoundbanks());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not read the sound bank list.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A finished download changes what is installed: read the list again.
  const finished = jobs
    .filter((j) => j.kind === 'soundbank' && j.status === 'done')
    .map((j) => j.id)
    .join(',');
  useEffect(() => {
    if (finished) void load();
  }, [finished, load]);

  const onDownload = async (entry: SoundbankEntry) => {
    if (pending) return;
    setPending(entry.id);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[entry.id];
      return next;
    });
    try {
      await startDownload(entry.id, 'soundbank');
    } catch (e) {
      setErrors((prev) => ({ ...prev, [entry.id]: e instanceof Error ? e.message : 'Download did not start.' }));
    } finally {
      setPending(null);
    }
  };

  const installedCount = banks?.filter((b) => b.installed.length > 0).length ?? 0;

  return (
    <section aria-labelledby="settings-soundbanks-title">
      <SectionHeader
        icon={<Library className="w-3.5 h-3.5 text-purple-400" aria-hidden="true" />}
        title="Sound banks"
        tip={TIP}
        meta={banks ? `${installedCount} installed` : undefined}
      />
      <span id="settings-soundbanks-title" className="sr-only">
        Sound banks
      </span>
      {loadError && (
        <p role="alert" className="text-xs font-bold text-rose-300">
          {loadError}
        </p>
      )}
      {!banks && !loadError && (
        <p className="flex items-center gap-1 text-xs font-bold text-zinc-400">
          <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> Reading the list
        </p>
      )}
      {banks && (
        <ul className="flex flex-col gap-1.5">
          {banks.map((entry) => (
            <SoundBankRow
              key={entry.id}
              entry={entry}
              state={soundbankState(entry, jobs)}
              busy={pending === entry.id}
              error={errors[entry.id] ?? null}
              onDownload={(e) => void onDownload(e)}
            />
          ))}
        </ul>
      )}
    </section>
  );
};
