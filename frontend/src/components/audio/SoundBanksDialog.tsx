/**
 * SoundBanksDialog — list, add and remove the sound banks every picker plays
 * from. The bundled General MIDI bank is always there; the user's SF2, SF3
 * and DLS banks are stored by the backend (backend/modules/soundfonts), each
 * at a bank-select offset of its own, and a bank added here is in every
 * instrument picker at once. Bank files the app has seen before (a pick, a
 * download) are offered again from the paths it remembered.
 *
 * `SoundBanksButton` opens it: a button beside an instrument picker.
 */
import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Library, Loader2, Trash2 } from 'lucide-react';
import { placesApi, type PlaceItem } from '../../lib/placesClient';
import { useSoundBankStore, SOUND_BANK_EXTS } from '../../state/soundBankStore';
import { loadBundledBankPresets } from '../../lib/soundfontEngine';

const btn =
  'rounded border px-2 py-0.5 text-xs font-bold uppercase tracking-wider transition-colors disabled:opacity-40 disabled:pointer-events-none';

const sizeText = (bytes: number | undefined): string =>
  bytes === undefined ? '' : bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export const SoundBanksDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const uid = useId().replace(/:/g, '');
  const banks = useSoundBankStore((s) => s.banks);
  const busy = useSoundBankStore((s) => s.busy);
  const error = useSoundBankStore((s) => s.error);
  const fileRef = useRef<HTMLInputElement>(null);
  const [recent, setRecent] = useState<PlaceItem[]>([]);

  useEffect(() => {
    void useSoundBankStore.getState().refresh();
    void loadBundledBankPresets();
    void placesApi.recent({ kind: 'soundfont', limit: 12 }).then(setRecent);
  }, []);

  const users = banks.filter((b) => b.kind === 'user');
  const bundled = banks.find((b) => b.kind === 'bundled');
  // A remembered bank file not listed now: one picked before, or a stored copy whose bank was removed.
  const listedPaths = new Set(users.flatMap((b) => [b.path, b.sourcePath].filter((p): p is string => !!p)));
  const again = recent.filter((r) => !listedPaths.has(r.path) && r.source !== 'install');

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await useSoundBankStore.getState().addFile(file);
    void placesApi.recent({ kind: 'soundfont', limit: 12 }).then(setRecent);
  };

  return createPortal(
    <div className="fixed inset-0 z-200 flex items-center justify-center bg-black/60" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        className="w-[min(640px,95vw)] max-h-[85vh] overflow-y-auto rounded-lg border border-white/10 bg-zinc-900 p-4 flex flex-col gap-3 shadow-2xl"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2">
          <h2 id={`${uid}-title`} className="text-sm font-bold uppercase tracking-wider text-zinc-200">Sound banks</h2>
          <button type="button" autoFocus onClick={onClose} aria-label="Close sound banks" className={`${btn} border-white/10 text-zinc-300 hover:bg-white/10`}>
            Close
          </button>
        </div>

        <p className="text-xs font-bold text-zinc-400">
          Add an SF2, SF3 or DLS bank and its presets are listed by bank in every instrument picker. Each bank plays from bank
          select numbers of its own, live, in renders and in exported MIDI.
        </p>

        <ul className="flex flex-col gap-1.5" aria-label="Loaded sound banks">
          {bundled && (
            <li className="flex items-center gap-2 rounded border border-white/5 bg-black/30 px-2 py-1.5">
              <span className="flex-1 min-w-0 text-xs font-bold text-zinc-200 truncate">{bundled.name}</span>
              <span className="shrink-0 text-xs font-bold text-zinc-400">{`Bundled · ${bundled.presets.length} presets`}</span>
            </li>
          )}
          {users.map((b) => (
            <li key={b.id} className="flex items-center gap-2 rounded border border-white/5 bg-black/30 px-2 py-1.5">
              <div className="flex-1 min-w-0 flex flex-col">
                <span className="text-xs font-bold text-zinc-100 truncate" title={b.path}>{b.name}</span>
                <span className="text-xs font-bold text-zinc-400 truncate" title={b.sourcePath ?? b.path}>
                  {`${b.format.toUpperCase()} · ${b.presets.length} presets · bank select ${b.offset}${b.span > 1 ? `-${b.offset + b.span - 1}` : ''}${b.size !== undefined ? ` · ${sizeText(b.size)}` : ''}`}
                </span>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={() => void useSoundBankStore.getState().remove(b.id)}
                aria-label={`Remove sound bank ${b.name}`}
                title="Remove this bank: parts that play its presets fall back to the bundled bank"
                className={`${btn} flex items-center gap-1 border-red-500/30 text-red-300 hover:bg-red-500/10`}
              >
                <Trash2 aria-hidden="true" className="size-3" />
                Remove
              </button>
            </li>
          ))}
          {users.length === 0 && <li className="text-xs font-bold text-zinc-500">No sound banks of your own yet.</li>}
        </ul>

        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            id={`${uid}-file`}
            name="sound-bank-file"
            type="file"
            accept={SOUND_BANK_EXTS.join(',')}
            onChange={(e) => void onFile(e)}
            className="sr-only"
          />
          <label
            htmlFor={`${uid}-file`}
            className={`${btn} cursor-pointer border-purple-500/40 text-purple-200 hover:bg-purple-500/15 ${busy ? 'opacity-40 pointer-events-none' : ''}`}
          >
            Add sound bank…
          </label>
          {busy && (
            <span className="flex items-center gap-1 text-xs font-bold text-zinc-400">
              <Loader2 aria-hidden="true" className="size-3 animate-spin" />
              Reading the bank…
            </span>
          )}
        </div>

        {again.length > 0 && (
          <div className="flex flex-col gap-1">
            <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-400">Bank files theDAW has seen</h3>
            <ul className="flex flex-col gap-1" aria-label="Bank files theDAW has seen">
              {again.map((r) => (
                <li key={r.path} className="flex items-center gap-2">
                  <span className="flex-1 min-w-0 truncate text-xs font-bold text-zinc-300" title={r.path}>{r.name}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void useSoundBankStore.getState().addPath(r.path)}
                    aria-label={`Add sound bank ${r.name}`}
                    className={`${btn} border-white/10 text-zinc-200 hover:bg-white/10`}
                  >
                    Add
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <p role="alert" className="text-xs font-bold text-red-300">
            {error}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
};

/** A button that opens the sound banks dialog; `compact` shows the glyph alone, its name in its label. */
export const SoundBanksButton: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const [open, setOpen] = useState(false);
  const count = useSoundBankStore((s) => s.banks.filter((b) => b.kind === 'user').length);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={count ? `Sound banks: ${count} of your own` : 'Sound banks'}
        title="Sound banks: add, list and remove SF2, SF3 and DLS banks"
        className={`${btn} flex items-center gap-1 border-white/10 text-zinc-300 hover:bg-white/10 shrink-0`}
      >
        <Library aria-hidden="true" className="size-3" />
        {!compact && 'Banks'}
        {count > 0 && <span className="tabular-nums">{count}</span>}
      </button>
      {open && <SoundBanksDialog onClose={() => setOpen(false)} />}
    </>
  );
};
