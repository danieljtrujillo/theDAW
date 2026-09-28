/**
 * The piano roll's parts column: one row per part, beside the keyboard.
 *
 * A row shows the part's colour, its name and what it sounds, and its MUTE and
 * SOLO keys; pressing the name makes it the part the grid edits (the other
 * parts draw behind it as ghost notes while GHOSTS is on). The active part's
 * row opens its settings: name, sound (an orchestral instrument from the
 * registry, a General MIDI program, a drum kit, or the roll's own voice), MIDI
 * channel and bank, AUDITION (play this part alone), and keys to move it up or
 * down and to remove it. ADD makes a new part and turns to it, so the next
 * generator, import or drawn note goes there.
 *
 * Every change is a roll undo step (state/pianoRollStore), except which part
 * is active and the column's own settings.
 */
import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Ghost, Headphones, Plus, Trash2 } from 'lucide-react';
import { partLinkOf, usePianoRollStore, type RollTrack } from '../../state/pianoRollStore';
import { GM_NAMES, gmShortName } from '../../lib/gmInstruments';
import { GM_DRUM_KITS, drumKitName } from '../../lib/clipProgram';
import { describeInstrument, orchestraByFamily, orchestraInstrument } from '../../lib/orchestra';
import { MAX_ROLL_PARTS, isPercussionPart } from '../../lib/rollTracks';
import { FIELD_LEGEND, FLYOUT_SELECT, KEY_ON, KEY_REST, MINI_ICON_KEY, MINI_WORD_KEY, STRIP_GLYPH } from './midiDockKit';

const ORCHESTRA_GROUPS = orchestraByFamily();

/** What a part sounds, in a few words: its instrument, program or kit, else whose voice it follows. */
export const partSoundText = (t: Pick<RollTrack, 'program' | 'channel' | 'instrumentId'>, linked: boolean): string => {
  const inst = orchestraInstrument(t.instrumentId);
  if (inst) return inst.name;
  if (t.program === null) return isPercussionPart(t) ? 'Standard kit' : linked ? 'Clip voice' : 'Roll voice';
  return isPercussionPart(t) ? `${drumKitName(t.program)} kit` : gmShortName(t.program);
};

/** The sound select's value for a part: `o:<id>`, `kit:<n>`, `gm:<n>`, or '' for the roll's voice. */
export const partSoundValue = (t: Pick<RollTrack, 'program' | 'channel' | 'instrumentId'>): string => {
  if (t.instrumentId && orchestraInstrument(t.instrumentId)) return `o:${t.instrumentId}`;
  if (t.program === null) return '';
  return isPercussionPart(t) ? `kit:${t.program}` : `gm:${t.program}`;
};

/** Apply a sound select's value to part `id`. */
export const choosePartSound = (id: string, value: string): void => {
  const roll = usePianoRollStore.getState();
  if (value.startsWith('o:')) roll.setTrackInstrument(id, value.slice(2));
  else if (value.startsWith('kit:')) roll.setTrackProgram(id, Number(value.slice(4)), true);
  else if (value.startsWith('gm:')) roll.setTrackProgram(id, Number(value.slice(3)), false);
  else roll.setTrackProgram(id, null);
};

const ROW_KEY = `${MINI_WORD_KEY} w-5 justify-center px-0`;

/** The active part's settings, under its row. */
const PartEditor: React.FC<{ track: RollTrack; index: number; count: number; alone: boolean }> = ({ track, index, count, alone }) => {
  const roll = usePianoRollStore.getState;
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  // A draft belongs to the part it was typed for.
  useEffect(() => setNameDraft(null), [track.id]);
  const commitName = () => {
    if (nameDraft === null) return;
    roll().renameTrack(track.id, nameDraft);
    setNameDraft(null);
  };
  const soundValue = partSoundValue(track);
  const inst = orchestraInstrument(track.instrumentId);
  return (
    <div className="flex flex-col gap-1.5 px-1.5 pb-2 pt-1" data-part-editor="">
      <div className="flex flex-col gap-0.5">
        <label htmlFor="roll-part-name" className={FIELD_LEGEND}>Name</label>
        <input
          id="roll-part-name"
          name="roll-part-name"
          type="text"
          value={nameDraft ?? track.name}
          maxLength={64}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitName();
            else if (e.key === 'Escape') setNameDraft(null);
          }}
          className={FLYOUT_SELECT}
        />
      </div>
      <div className="flex flex-col gap-0.5">
        <label htmlFor="roll-part-sound" className={FIELD_LEGEND}>Sound</label>
        <select
          id="roll-part-sound"
          name="roll-part-sound"
          value={soundValue}
          onChange={(e) => choosePartSound(track.id, e.target.value)}
          title={inst ? describeInstrument(inst) : undefined}
          className={FLYOUT_SELECT}
        >
          <option value="">Roll voice (linked clip or picker)</option>
          {ORCHESTRA_GROUPS.map((g) => (
            <optgroup key={g.family.id} label={`Orchestra · ${g.family.label}`}>
              {g.instruments.map((i) => (
                <option key={i.id} value={`o:${i.id}`} title={describeInstrument(i)}>{i.name}</option>
              ))}
            </optgroup>
          ))}
          <optgroup label="General MIDI">
            {GM_NAMES.map((n, p) => (
              <option key={p} value={`gm:${p}`}>{`${p + 1} ${n}`}</option>
            ))}
          </optgroup>
          <optgroup label="Drum kits (channel 10)">
            {GM_DRUM_KITS.map((k) => (
              <option key={k.program} value={`kit:${k.program}`}>{`${k.name} kit`}</option>
            ))}
          </optgroup>
        </select>
      </div>
      <div className="flex items-end gap-1.5">
        <div className="flex flex-col gap-0.5 flex-1 min-w-0">
          <label htmlFor="roll-part-channel" className={FIELD_LEGEND}>Channel</label>
          <select
            id="roll-part-channel"
            name="roll-part-channel"
            value={track.channel ?? ''}
            onChange={(e) => roll().setTrackChannel(track.id, e.target.value === '' ? null : Number(e.target.value))}
            title="The MIDI channel the part is written on in a .mid file. Channel 10 plays drums."
            className={FLYOUT_SELECT}
          >
            <option value="">Auto</option>
            {Array.from({ length: 16 }, (_, i) => i + 1).map((ch) => (
              <option key={ch} value={ch}>{ch === 10 ? '10 drums' : String(ch)}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-0.5 w-14">
          <label htmlFor="roll-part-bank" className={FIELD_LEGEND}>Bank</label>
          <input
            id="roll-part-bank"
            name="roll-part-bank"
            type="number"
            min={0}
            max={127}
            step={1}
            value={track.bank}
            onChange={(e) => roll().setTrackBank(track.id, Number(e.target.value))}
            title="Bank select (MSB) sent before the program: 0 is the General MIDI set"
            className={FLYOUT_SELECT}
          />
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-pressed={alone}
          onClick={() => roll().soloOnly(track.id)}
          aria-label={alone ? `Stop auditioning ${track.name} alone` : `Audition ${track.name} alone`}
          title={alone ? 'Every part plays again' : 'Solo this part and no other, so PLAY sounds it alone'}
          className={`${MINI_WORD_KEY} gap-1 ${alone ? KEY_ON : KEY_REST}`}
        >
          <Headphones aria-hidden="true" className="w-3 h-3" />
          Audition
        </button>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => roll().moveTrack(track.id, index - 1)}
          disabled={index === 0}
          aria-label={`Move ${track.name} up`}
          title="Move the part up"
          className={`${MINI_ICON_KEY} ${KEY_REST}`}
        >
          <ArrowUp aria-hidden="true" className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={() => roll().moveTrack(track.id, index + 1)}
          disabled={index >= count - 1}
          aria-label={`Move ${track.name} down`}
          title="Move the part down"
          className={`${MINI_ICON_KEY} ${KEY_REST}`}
        >
          <ArrowDown aria-hidden="true" className="w-3 h-3" />
        </button>
        <button
          type="button"
          onClick={() => roll().removeTrack(track.id)}
          disabled={count <= 1}
          aria-label={`Remove ${track.name}`}
          title={count <= 1 ? 'The roll keeps one part' : 'Remove the part and its notes (Ctrl+Z brings it back)'}
          className={`${MINI_ICON_KEY} ${KEY_REST}`}
        >
          <Trash2 aria-hidden="true" className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
};

export const RollTrackColumn: React.FC = () => {
  const tracks = usePianoRollStore((s) => s.tracks);
  const activeTrackId = usePianoRollStore((s) => s.activeTrackId);
  const activeCount = usePianoRollStore((s) => s.notes.length);
  const showGhosts = usePianoRollStore((s) => s.showGhosts);
  const partsOpen = usePianoRollStore((s) => s.partsOpen);
  const editingClipId = usePianoRollStore((s) => s.editingClipId);
  const partLinks = usePianoRollStore((s) => s.partLinks);
  const roll = usePianoRollStore.getState;
  const soloed = tracks.filter((t) => t.solo);
  const full = tracks.length >= MAX_ROLL_PARTS;

  if (!partsOpen) {
    return (
      <div className="shrink-0 w-7 flex flex-col items-center gap-1 py-1 border-r border-white/5 bg-[#0c0a12]" data-roll-parts="closed">
        <button
          type="button"
          onClick={() => roll().setPartsOpen(true)}
          aria-expanded={false}
          aria-controls="roll-parts"
          aria-label={`Show the parts column, ${tracks.length} part${tracks.length === 1 ? '' : 's'}`}
          title="Show the parts"
          className={`${MINI_ICON_KEY} ${KEY_REST}`}
        >
          <ChevronRight aria-hidden="true" className="w-3 h-3" />
        </button>
        <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar flex flex-col items-center gap-1">
          {tracks.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => roll().setActiveTrack(t.id)}
              aria-pressed={t.id === activeTrackId}
              aria-label={`Edit part ${t.name}`}
              title={t.name}
              className={`w-4 h-4 shrink-0 rounded-xs border ${t.id === activeTrackId ? 'border-white' : 'border-black/40'} ${t.mute && !t.solo ? 'opacity-40' : ''}`}
              style={{ backgroundColor: t.color }}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div id="roll-parts" className="shrink-0 w-48 flex flex-col border-r border-white/5 bg-[#0c0a12]" data-roll-parts="open">
      <div className="h-7 shrink-0 flex items-center gap-1 px-1 border-b border-white/5 bg-black/40">
        <button
          type="button"
          onClick={() => roll().setPartsOpen(false)}
          aria-expanded
          aria-controls="roll-parts"
          aria-label="Hide the parts column"
          title="Hide the parts"
          className={`${MINI_ICON_KEY} ${KEY_REST}`}
        >
          <ChevronLeft aria-hidden="true" className="w-3 h-3" />
        </button>
        <span className={FIELD_LEGEND}>Parts</span>
        <span className="text-[12px] font-bold et-ink-2 tabular-nums">{tracks.length}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => roll().setShowGhosts(!showGhosts)}
          aria-pressed={showGhosts}
          aria-label="Ghost notes: draw the other parts behind this one"
          title={showGhosts ? 'Hide the other parts’ notes' : 'Draw the other parts’ notes behind the part you edit'}
          className={`${MINI_ICON_KEY} ${showGhosts ? KEY_ON : KEY_REST}`}
        >
          <Ghost aria-hidden="true" className={STRIP_GLYPH} />
        </button>
        <button
          type="button"
          onClick={() => roll().addTrack()}
          disabled={full}
          aria-label="Add a part"
          title={full ? `The roll holds ${MAX_ROLL_PARTS} parts` : 'Add a part and edit it'}
          className={`${MINI_WORD_KEY} gap-0.5 ${KEY_REST}`}
        >
          <Plus aria-hidden="true" className="w-3 h-3" />
          Add
        </button>
      </div>
      <ul className="flex-1 min-h-0 overflow-y-auto" aria-label="Parts">
        {tracks.map((t, i) => {
          const active = t.id === activeTrackId;
          const linked = !!partLinkOf({ activeTrackId, editingClipId, partLinks }, t.id);
          const count = active ? activeCount : t.notes.length;
          const colorId = `roll-part-color-${t.id}`;
          return (
            <li key={t.id} className={`border-b border-white/5 ${active ? 'bg-white/6' : ''}`} data-roll-part={t.id}>
              <div className="flex items-center gap-1 px-1 py-1">
                <label htmlFor={colorId} className="sr-only">{`Colour of ${t.name}`}</label>
                <input
                  id={colorId}
                  name={colorId}
                  type="color"
                  value={t.color}
                  onChange={(e) => roll().setTrackColor(t.id, e.target.value)}
                  className="w-3.5 h-7 shrink-0 cursor-pointer rounded-xs border-none bg-transparent p-0"
                />
                <button
                  type="button"
                  onClick={() => roll().setActiveTrack(t.id)}
                  aria-pressed={active}
                  aria-label={`Edit part ${t.name}, ${partSoundText(t, linked)}, ${count} note${count === 1 ? '' : 's'}`}
                  className={`flex-1 min-w-0 text-left rounded-xs px-1 outline-none focus-visible:ring-1 focus-visible:ring-[rgb(var(--et-accent))] ${active ? '' : 'hover:bg-white/4'}`}
                >
                  <span className={`block truncate text-[12px] font-bold leading-tight ${active ? 'et-ink' : 'et-ink-2'}`}>{t.name}</span>
                  <span className="block truncate text-[12px] font-semibold leading-tight et-ink-3">
                    {partSoundText(t, linked)} · {count}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => roll().setTrackMute(t.id, !t.mute)}
                  aria-pressed={t.mute}
                  aria-label={`Mute ${t.name}`}
                  title={t.mute ? 'Unmute' : 'Mute: PLAY leaves this part out'}
                  className={`${ROW_KEY} ${t.mute ? KEY_ON : KEY_REST}`}
                >
                  M
                </button>
                <button
                  type="button"
                  onClick={() => roll().setTrackSolo(t.id, !t.solo)}
                  aria-pressed={t.solo}
                  aria-label={`Solo ${t.name}`}
                  title={t.solo ? 'Unsolo' : 'Solo: while any part is soloed, only soloed parts play'}
                  className={`${ROW_KEY} ${t.solo ? KEY_ON : KEY_REST}`}
                >
                  S
                </button>
              </div>
              {active && <PartEditor track={t} index={i} count={tracks.length} alone={soloed.length === 1 && soloed[0].id === t.id} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
