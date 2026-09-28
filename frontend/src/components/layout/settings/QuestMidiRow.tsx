/**
 * Settings → Inputs & outputs → Quest MIDI: the headset bridge's status.
 *
 * A dot and one word, a line saying why, and the one action that applies:
 * Take over while another program serves the headset's port, Re-attach
 * otherwise (after plugging the headset in or accepting USB debugging). Take
 * over is the only way theDAW takes the headset from another program.
 *
 * While the bridge WebSocket is open it pushes every status change; while it
 * is closed the row re-reads the status every QUEST_MIDI_POLL_MS, so a program
 * that takes the headset while Settings is open shows up either way.
 */
import React, { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { isQuestMidiConnected } from '../../../state/questMidiClient';
import {
  QUEST_MIDI_POLL_MS,
  QUEST_MIDI_STATE_WORD,
  questMidiHolderName,
  questMidiHolderSentence,
  questMidiState,
  useQuestMidiStatusStore,
  type QuestMidiBusy,
  type QuestMidiState,
  type QuestMidiStatus,
} from '../../../state/questMidiStatus';

const ROW = 'flex flex-wrap items-center gap-1.5 px-1.5 py-1 border-b border-white/5 last:border-b-0';
const LABEL = 'text-xs font-bold uppercase tracking-wider text-zinc-300 w-28 shrink-0';
const DETAIL = 'text-xs text-zinc-400 min-w-0 flex-1';
const BTN =
  'inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-bold transition-colors disabled:opacity-40 disabled:cursor-default focus-visible:outline-none focus-visible:ring-1';
const BTN_TAKE = `${BTN} border-amber-500/40 bg-amber-500/10 text-amber-100 hover:bg-amber-500/20 focus-visible:ring-amber-400/70`;
const BTN_GHOST = `${BTN} border-white/10 text-zinc-200 hover:text-white hover:bg-white/5 focus-visible:ring-white/30`;

const DOT: Record<QuestMidiState, string> = {
  off: 'bg-zinc-500',
  held: 'bg-amber-400',
  connected: 'bg-emerald-400',
  ready: 'bg-emerald-400/60',
  waiting: 'bg-sky-400',
};

function detailText(status: QuestMidiStatus | null, error: string | null): string {
  const state = questMidiState(status);
  if (error) return error;
  if (!status || state === 'off') return 'The bridge has not started.';
  if (status.holder) return questMidiHolderSentence(status.holder, status.devicePort);
  if (state === 'connected') return `Headset connected on port ${status.devicePort}.`;
  if (state === 'ready') return `Waiting for the headset app on port ${status.devicePort}.`;
  return status.adbFound
    ? 'Plug in the headset, allow USB debugging, then press Re-attach.'
    : 'adb was not found. Install Android platform-tools.';
}

export interface QuestMidiRowViewProps {
  status: QuestMidiStatus | null;
  error: string | null;
  busy: QuestMidiBusy;
  onTakeOver: () => void;
  onReattach: () => void;
}

export const QuestMidiRowView: React.FC<QuestMidiRowViewProps> = ({
  status,
  error,
  busy,
  onTakeOver,
  onReattach,
}) => {
  const state = questMidiState(status);
  const holder = status?.holder ?? null;
  return (
    <div className={ROW}>
      <span id="io-questmidi-label" className={LABEL}>
        Quest MIDI
      </span>
      <span
        role="status"
        aria-labelledby="io-questmidi-label io-questmidi-state"
        className="inline-flex items-center gap-1.5 text-xs font-bold text-zinc-100"
      >
        <span aria-hidden="true" className={`size-2 rounded-full shrink-0 ${DOT[state]}`} />
        <span id="io-questmidi-state">{QUEST_MIDI_STATE_WORD[state]}</span>
      </span>
      <span className={DETAIL}>{detailText(status, error)}</span>
      {holder ? (
        <button
          type="button"
          onClick={onTakeOver}
          disabled={busy !== null}
          aria-label={`Take over the Quest headset from ${questMidiHolderName(holder)}`}
          title={`Map the headset's port ${status?.devicePort ?? ''} to theDAW. ${questMidiHolderName(holder)} stops receiving the headset.`}
          className={BTN_TAKE}
        >
          {busy === 'takeover' && <Loader2 aria-hidden="true" className="w-3 h-3 animate-spin" />}
          Take over
        </button>
      ) : (
        status?.started && (
          <button
            type="button"
            onClick={onReattach}
            disabled={busy !== null}
            aria-label="Re-attach the Quest headset over USB"
            title="Run adb reverse again after plugging the headset in or accepting USB debugging"
            className={BTN_GHOST}
          >
            {busy === 'reattach' && <Loader2 aria-hidden="true" className="w-3 h-3 animate-spin" />}
            Re-attach
          </button>
        )
      )}
    </div>
  );
};

export const QuestMidiRow: React.FC = () => {
  const status = useQuestMidiStatusStore((s) => s.status);
  const error = useQuestMidiStatusStore((s) => s.error);
  const busy = useQuestMidiStatusStore((s) => s.busy);
  const refresh = useQuestMidiStatusStore((s) => s.refresh);
  const takeOver = useQuestMidiStatusStore((s) => s.takeOver);
  const reattach = useQuestMidiStatusStore((s) => s.reattach);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!isQuestMidiConnected()) void refresh({ quiet: true });
    }, QUEST_MIDI_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <QuestMidiRowView
      status={status}
      error={error}
      busy={busy}
      onTakeOver={() => void takeOver()}
      onReattach={() => void reattach()}
    />
  );
};
