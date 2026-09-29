/**
 * rollTracks — the piano roll's parts: one document for a whole orchestra.
 *
 * A part (RollTrack, state/pianoRollStore) is a named voice of the roll with
 * its own notes, General MIDI program and bank, export channel, colour, mute
 * and solo. The tempo map, the meter map, the lanes and the bends belong to
 * the document and every part reads them.
 *
 * This module holds the pure rules: how a part's fields are cleaned, which
 * parts sound (mute and solo), which live soundfont channel and which file
 * channel each part takes, and which voice a part plays with. Type imports
 * only from the store, so node tests load it.
 */
import type { FiguredBassMark, PianoNote, RollControl, RollTrack } from '../state/pianoRollStore';
import type { AudioClip, EditorTrack } from '../state/editorStore';
import { GM_STANDARD_KIT, clipVoice, type ClipVoice, type GlobalVoice, type ProgramClip, type ProgramTrack } from './clipProgram';
import { DRUM_CHANNEL } from './editChannels';
import { LIVE_ROLL_CHANNELS, MAX_PREVIEW_CHANNELS, ROLL_PART_FIRST_CHANNEL, bentLanes, liveLaneChannels, type LaneBend } from './pitchBend';
import type { PolyLane } from './meterMap';
import type { ComposeInstrument } from './aiComposeGrid';
import { instrumentForProgram, orchestraInstrument } from './orchestra';

/** The most parts a roll holds: every part after the first takes live channels of its own (rollLiveChannels). */
export const MAX_ROLL_PARTS = 64;

/** The General MIDI percussion channel, one-based as a part stores it. */
export const PERCUSSION_PART_CHANNEL = 10;

/** The colours new parts take, in turn. Each passes 3:1 against the roll's dark ground. */
export const PART_COLORS: readonly string[] = Object.freeze([
  '#a855f7',
  '#22d3ee',
  '#f59e0b',
  '#34d399',
  '#f472b6',
  '#60a5fa',
  '#facc15',
  '#fb7185',
  '#4ade80',
  '#c084fc',
  '#38bdf8',
  '#fb923c',
]);

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A new part id. */
export const partUid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? `part-${crypto.randomUUID()}` : `part-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/** A part name: trimmed, at most 64 characters, `fallback` when blank. */
export const cleanPartName = (name: unknown, fallback: string): string => {
  const text = typeof name === 'string' ? name.trim().slice(0, 64) : '';
  return text || fallback;
};

/** A GM program 0-127, or null (the part follows the roll's voice). */
export const cleanPartProgram = (v: unknown): number | null => (isNum(v) ? Math.max(0, Math.min(127, Math.round(v))) : null);

/** A bank select (MSB) 0-127; 0 for anything else. */
export const cleanPartBank = (v: unknown): number => (isNum(v) ? Math.max(0, Math.min(127, Math.round(v))) : 0);

/** A bank select LSB (CC 32) 0-127, or undefined when there is none (a part sends no CC 32). */
export const cleanPartBankLsb = (v: unknown): number | undefined => (isNum(v) ? Math.max(0, Math.min(127, Math.round(v))) : undefined);

/** A MIDI channel 1-16, or null (the part takes the next free one on export). */
export const cleanPartChannel = (v: unknown): number | null => (isNum(v) ? Math.max(1, Math.min(16, Math.round(v))) : null);

/** A #rrggbb colour, lower case, else `fallback`. */
export const cleanPartColor = (v: unknown, fallback: string): string =>
  typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim()) ? v.trim().toLowerCase() : fallback;

/** The colour the part at `index` takes when it has none. */
export const partColorAt = (index: number): string => PART_COLORS[((Math.round(index) % PART_COLORS.length) + PART_COLORS.length) % PART_COLORS.length];

/** "Part 3": the default name of the part at `index`. */
export const defaultPartName = (index: number): string => `Part ${Math.max(0, Math.round(index)) + 1}`;

/** True when `name` is a default part name ("Part 3"), which choosing an instrument replaces. */
export const isDefaultPartName = (name: string): boolean => /^Part \d+$/.test(name.trim());

/** A part on the General MIDI percussion channel: its notes are drums and its program is the kit. */
export const isPercussionPart = (t: Pick<RollTrack, 'channel'>): boolean => t.channel === PERCUSSION_PART_CHANNEL;

/** One controller a part keeps: its number, its name in the parts column, and the value a channel starts at. */
export interface PartController {
  controller: number;
  name: string;
  /** The value General MIDI's reset gives the controller, which a channel holds until a change arrives. */
  initial: number;
}

/**
 * The controllers a part keeps, the ones lib/midi KEPT_CONTROLLERS reads from a
 * file: modulation, volume, pan, expression, the sustain pedal, brightness
 * (74, the filter a soundfont opens with it) and the reverb send (91), with
 * the values the synth's channel starts at. The roll's CC lane
 * (components/audio/CcLane) draws each of them.
 */
export const PART_CONTROLLERS: readonly PartController[] = Object.freeze([
  { controller: 1, name: 'Modulation', initial: 0 },
  { controller: 7, name: 'Volume', initial: 100 },
  { controller: 10, name: 'Pan', initial: 64 },
  { controller: 11, name: 'Expression', initial: 127 },
  { controller: 64, name: 'Sustain pedal', initial: 0 },
  { controller: 74, name: 'Brightness', initial: 64 },
  // SpessaSynth starts a channel's reverb send at 0 (spessasynth_core's controller
  // reset), not General MIDI 2's 40, and a render starts where the synth does.
  { controller: 91, name: 'Reverb send', initial: 0 },
]);

const CONTROLLER_BY_NUMBER: ReadonlyMap<number, PartController> = new Map(PART_CONTROLLERS.map((c) => [c.controller, c]));

/** The part controller `controller` names, or undefined for one a part does not keep. */
export const partController = (controller: number): PartController | undefined => CONTROLLER_BY_NUMBER.get(controller);

/**
 * A part's controller changes from a file, a clip or an autosave: only the
 * controllers PART_CONTROLLERS lists, each tick whole and at least 0, each
 * value 0-127, sorted by tick with the order of one tick kept. Two changes of
 * one controller at one tick keep the later, the one in force. Undefined when
 * none is left, so a part without any carries no field.
 */
export function cleanPartControls(raw: unknown): RollControl[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const kept: RollControl[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const c = r as Record<string, unknown>;
    if (!isNum(c.tick) || !isNum(c.controller) || !isNum(c.value)) continue;
    const controller = Math.round(c.controller);
    if (!CONTROLLER_BY_NUMBER.has(controller)) continue;
    kept.push({ tick: Math.max(0, Math.round(c.tick)), controller, value: Math.max(0, Math.min(127, Math.round(c.value))) });
  }
  // A stable sort: changes of one tick keep the order they came in.
  kept.sort((a, b) => a.tick - b.tick);
  const out: RollControl[] = [];
  // The changes of the tick being read, by controller: the same controller
  // twice at one tick keeps the later one, the one in force, in its place.
  let group = new Map<number, RollControl>();
  let groupTick = -1;
  const flush = () => {
    for (const c of group.values()) out.push(c);
    group = new Map();
  };
  for (const c of kept) {
    if (c.tick !== groupTick) {
      flush();
      groupTick = c.tick;
    }
    group.delete(c.controller);
    group.set(c.controller, c);
  }
  flush();
  return out.length ? out : undefined;
}

/** The longest figure a part keeps: enough for '#6/4/2' or '7 #5 3'. */
export const FIGURE_MAX = 12;

/**
 * A figure as a part keeps it: trimmed, inner spaces collapsed, only the
 * characters figures are written with (digits, '#', 'b', 'n', '♯', '♭', '♮',
 * '/', '+', '-', ',' and spaces), at most FIGURE_MAX characters.
 */
export const cleanFigure = (raw: unknown): string =>
  typeof raw === 'string'
    ? raw.replace(/[^0-9#bn♯♭♮/+,\- ]/g, '').replace(/\s+/g, ' ').trim().slice(0, FIGURE_MAX).trim()
    : '';

/**
 * A part's figured bass from an edit, a clip or a file: each mark a whole
 * tick at or after 0 with a cleaned figure, sorted by tick, one per tick (the
 * later of two at one tick, the one written last). A blank figure is kept: it
 * says the note is a root-position triad, which is what the lane shows when a
 * note has none. Undefined when none is left, so a part without any carries
 * no field.
 */
export function cleanFiguredBass(raw: unknown): FiguredBassMark[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const byTick = new Map<number, string>();
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const m = r as Record<string, unknown>;
    if (!isNum(m.tick)) continue;
    const tick = Math.max(0, Math.round(m.tick));
    byTick.delete(tick);
    byTick.set(tick, cleanFigure(m.figure));
  }
  const out = [...byTick.entries()].sort((a, b) => a[0] - b[0]).map(([tick, figure]) => ({ tick, figure }));
  return out.length ? out : undefined;
}

/** How many changes of each controller a part carries, in PART_CONTROLLERS order: what the parts column lists. */
export function partControlCounts(controls: readonly RollControl[] | undefined): Array<{ controller: PartController; count: number }> {
  const counts = new Map<number, number>();
  for (const c of controls ?? []) counts.set(c.controller, (counts.get(c.controller) ?? 0) + 1);
  return PART_CONTROLLERS.filter((c) => counts.has(c.controller)).map((c) => ({ controller: c, count: counts.get(c.controller) as number }));
}

/**
 * The value each controller the part uses holds just before `tick` (`controls`
 * sorted by tick): the last change before it, else the controller's initial
 * value. What PLAY sends a part's channels when it starts, seeks or loops back
 * to `tick`, so a part started halfway has the volume and pedal it has there.
 * Changes AT `tick` are left out: they play as the window reaches them.
 */
export function controlStateBefore(controls: readonly RollControl[] | undefined, tick: number): Map<number, number> {
  const state = new Map<number, number>();
  for (const c of controls ?? []) if (!state.has(c.controller)) state.set(c.controller, partController(c.controller)?.initial ?? 0);
  for (const c of controls ?? []) {
    if (c.tick >= tick) break;
    state.set(c.controller, c.value);
  }
  return state;
}

/** What a part is made from: any of its fields, the rest filled in. */
export type RollTrackInit = Partial<RollTrack>;

/** A whole part from `init`: every field cleaned, a new id when it has none, the default name and colour of `index`. */
export function makeRollTrack(init: RollTrackInit, index: number): RollTrack {
  const id = typeof init.id === 'string' && init.id ? init.id : partUid();
  const track: RollTrack = {
    id,
    name: cleanPartName(init.name, defaultPartName(index)),
    program: cleanPartProgram(init.program),
    bank: cleanPartBank(init.bank),
    channel: cleanPartChannel(init.channel),
    color: cleanPartColor(init.color, partColorAt(index)),
    mute: init.mute === true,
    solo: init.solo === true,
    notes: Array.isArray(init.notes) ? init.notes : [],
  };
  if (typeof init.instrumentId === 'string' && init.instrumentId) track.instrumentId = init.instrumentId;
  const bankLsb = cleanPartBankLsb(init.bankLsb);
  if (bankLsb !== undefined) track.bankLsb = bankLsb;
  const controls = cleanPartControls(init.controls);
  if (controls) track.controls = controls;
  const figuredBass = cleanFiguredBass(init.figuredBass);
  if (figuredBass) track.figuredBass = figuredBass;
  if (init.cantusFirmus === true) track.cantusFirmus = true;
  if (init.fromAudio === true) track.fromAudio = true;
  return track;
}

/** Parts with their fields cleaned and their ids unique (a repeated id gets a new one); at least one part, at most MAX_ROLL_PARTS, and one cantus firmus at most. */
export function sanitizeRollTracks(list: readonly RollTrackInit[] | null | undefined): RollTrack[] {
  const seen = new Set<string>();
  const out: RollTrack[] = [];
  for (const init of list ?? []) {
    if (!init || typeof init !== 'object') continue;
    if (out.length >= MAX_ROLL_PARTS) break;
    const track = makeRollTrack(init, out.length);
    // One cantus firmus a roll: the first part that says so keeps it.
    if (track.cantusFirmus && out.some((t) => t.cantusFirmus)) delete track.cantusFirmus;
    if (seen.has(track.id)) track.id = partUid();
    seen.add(track.id);
    out.push(track);
  }
  if (!out.length) out.push(makeRollTrack({}, 0));
  return out;
}

/** The name the next new part takes: the first "Part n" no part has. */
export function nextPartName(tracks: readonly Pick<RollTrack, 'name'>[]): string {
  const names = new Set(tracks.map((t) => t.name));
  for (let i = tracks.length; ; i += 1) {
    const name = defaultPartName(i);
    if (!names.has(name)) return name;
  }
}

/** The colour the next new part takes: the first of PART_COLORS no part has, else the next in turn. */
export function nextPartColor(tracks: readonly Pick<RollTrack, 'color'>[]): string {
  const used = new Set(tracks.map((t) => t.color.toLowerCase()));
  return PART_COLORS.find((c) => !used.has(c)) ?? partColorAt(tracks.length);
}

/**
 * The ids of the parts that sound: every part not muted, or with any part
 * soloed, the soloed parts (a soloed part sounds even when muted, as a solo in
 * a mixer overrides its mute).
 */
export function audiblePartIds(tracks: readonly Pick<RollTrack, 'id' | 'mute' | 'solo'>[]): Set<string> {
  const soloed = tracks.filter((t) => t.solo);
  return new Set((soloed.length ? soloed : tracks.filter((t) => !t.mute)).map((t) => t.id));
}

/** Where one part plays live: its channel, each lane's channel, and the lanes that bend on a channel of their own. */
export interface PartLiveChannels {
  base: number;
  lanes: Map<number, number>;
  /** Lanes whose channel is theirs alone, so the scheduler sends their wheel there. */
  bent: Set<number>;
  /**
   * A channel for each soundfont preset the part's articulations play in
   * (lib/articulationMap articulatedNotes `targets`, in that order): a string
   * part's pizzicato on a channel of its own. Absent when it has none; a
   * target past the last channel plays on the part's own channel.
   */
  arts?: number[];
  /**
   * The member channels the part's expressive notes rotate across
   * (lib/mpeRotation: a note with pressure, timbre or bend of its own plays on
   * a channel of its own). Absent when it has none; fewer than asked for when
   * the channels run out.
   */
  mpe?: number[];
}

/**
 * The live soundfont channel of every part and lane on the preview synth.
 *
 * The first part plays exactly as the roll always has: its lanes on
 * lib/pitchBend liveLaneChannels, from channel 14 down, each bent lane on its
 * own channel, or on the drum channel 9 when it is a percussion part. Every
 * later part takes channels from ROLL_PART_FIRST_CHANNEL (25) up, which the
 * preview synth adds on demand: a melodic part a channel whose number modulo
 * 16 is not 9 (SpessaSynth makes every such channel a drum channel), a
 * percussion part one of those drum channels, and each bent lane of a melodic
 * part one more channel, so its wheel bends only that lane's notes. A part
 * keeps its channels while others are muted or soloed, since the plan is made
 * over every part. When MAX_PREVIEW_CHANNELS runs out a melodic part shares
 * the first part's channel and a bent lane shares its part's.
 *
 * `articulations` counts the soundfont presets each part's articulations play
 * in (lib/articulationMap); each takes a melodic channel after every part's
 * own, so a part's articulation never moves another part off its channel.
 * `members` counts the member channels each part's expressive notes need
 * (lib/mpeRotation), taken after the articulations' the same way.
 */
export function rollLiveChannels(
  parts: readonly Pick<RollTrack, 'id' | 'channel'>[],
  lanes: readonly PolyLane[],
  bends: readonly LaneBend[],
  articulations?: ReadonlyMap<string, number>,
  members?: ReadonlyMap<string, number>,
): Map<string, PartLiveChannels> {
  const out = new Map<string, PartLiveChannels>();
  const bent = [...bentLanes(lanes, bends)].sort((a, b) => a - b);
  let melodic = ROLL_PART_FIRST_CHANNEL;
  let drums = ROLL_PART_FIRST_CHANNEL + ((9 - (ROLL_PART_FIRST_CHANNEL % 16) + 16) % 16);
  const takeMelodic = (): number | null => {
    while (melodic < MAX_PREVIEW_CHANNELS && melodic % 16 === 9) melodic += 1;
    if (melodic >= MAX_PREVIEW_CHANNELS) return null;
    return melodic++;
  };
  const takeDrums = (): number | null => {
    if (drums >= MAX_PREVIEW_CHANNELS) return null;
    const ch = drums;
    drums += 16;
    return ch;
  };
  parts.forEach((part, index) => {
    const percussion = isPercussionPart(part);
    if (index === 0) {
      if (percussion) {
        out.set(part.id, { base: DRUM_CHANNEL, lanes: new Map(lanes.map((l) => [l.id, DRUM_CHANNEL])), bent: new Set() });
        return;
      }
      const map = liveLaneChannels(lanes, bends);
      out.set(part.id, { base: LIVE_ROLL_CHANNELS[0], lanes: map, bent: new Set(bent) });
      return;
    }
    if (percussion) {
      const base = takeDrums() ?? DRUM_CHANNEL;
      out.set(part.id, { base, lanes: new Map(lanes.map((l) => [l.id, base])), bent: new Set() });
      return;
    }
    const base = takeMelodic() ?? LIVE_ROLL_CHANNELS[0];
    const map = new Map<number, number>(lanes.map((l) => [l.id, base]));
    const own = new Set<number>();
    for (const lane of bent) {
      const ch = takeMelodic();
      if (ch === null) break;
      map.set(lane, ch);
      own.add(lane);
    }
    out.set(part.id, { base, lanes: map, bent: own });
  });
  for (const part of parts) {
    const want = articulations?.get(part.id) ?? 0;
    const live = out.get(part.id);
    if (!live || want <= 0 || isPercussionPart(part)) continue;
    const arts: number[] = [];
    for (let i = 0; i < want; i += 1) {
      const ch = takeMelodic();
      if (ch === null) break;
      arts.push(ch);
    }
    if (arts.length) live.arts = arts;
  }
  for (const part of parts) {
    const want = members?.get(part.id) ?? 0;
    const live = out.get(part.id);
    if (!live || want <= 0 || isPercussionPart(part)) continue;
    const mpe: number[] = [];
    for (let i = 0; i < want; i += 1) {
      const ch = takeMelodic();
      if (ch === null) break;
      mpe.push(ch);
    }
    if (mpe.length) live.mpe = mpe;
  }
  return out;
}

/** MIDI file channels (0-15) a melodic part takes when it names none, in order: every channel but the drums'. */
const FILE_MELODIC_CHANNELS: readonly number[] = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]);

/**
 * The zero-based MIDI channel each part is written on. A part that names a
 * channel keeps it; a percussion part is on channel 9 (MIDI channel 10). Every
 * other part takes the next channel no part names, skipping 9; past fifteen
 * melodic parts the channels are shared in turn, and `shared` lists the parts
 * that share one (a file's sixteen channels are all it has).
 */
export function partFileChannels(parts: readonly Pick<RollTrack, 'id' | 'channel'>[]): { channels: Map<string, number>; shared: string[] } {
  const named = new Set(parts.filter((p) => p.channel !== null).map((p) => (p.channel as number) - 1));
  const free = FILE_MELODIC_CHANNELS.filter((ch) => !named.has(ch));
  const pool = free.length ? free : FILE_MELODIC_CHANNELS;
  const channels = new Map<string, number>();
  const used = new Map<number, number>();
  let next = 0;
  for (const p of parts) {
    const ch = p.channel !== null ? p.channel - 1 : pool[next++ % pool.length];
    channels.set(p.id, ch);
    used.set(ch, (used.get(ch) ?? 0) + 1);
  }
  const shared = parts.filter((p) => (used.get(channels.get(p.id) as number) ?? 0) > 1 && !isPercussionPart(p)).map((p) => p.id);
  return { channels, shared };
}

/**
 * The voice a part plays and bounces with.
 *
 *   - its own program, when it has one (on a percussion part, the kit);
 *   - else, linked to an EDIT clip (`link`), that clip's voice (its program,
 *     else its track's, else the picker's), as the roll has always played a
 *     linked clip; a percussion part on a melodic track plays the Standard kit;
 *   - else a percussion part plays the Standard kit, and a melodic part the
 *     roll's own voice (`rollProgram`, the Vocal2MIDI choice) or the picker's.
 */
export function partVoice(
  part: Pick<RollTrack, 'program' | 'channel'>,
  link: string | null,
  clips: ReadonlyArray<ProgramClip & Pick<AudioClip, 'id' | 'trackId'>>,
  tracks: ReadonlyArray<ProgramTrack & Pick<EditorTrack, 'id'>>,
  global: GlobalVoice,
  rollProgram: number | null = null,
): ClipVoice {
  const percussion = isPercussionPart(part);
  if (part.program !== null) return { program: part.program, percussion };
  const clip = link ? clips.find((c) => c.id === link) : undefined;
  if (clip) {
    const voice = clipVoice(clip, tracks.find((t) => t.id === clip.trackId), global);
    if (percussion && !voice.percussion) return { program: GM_STANDARD_KIT, percussion: true };
    return voice;
  }
  if (percussion) return { program: GM_STANDARD_KIT, percussion: true };
  return { program: rollProgram ?? (global.useSoundfont ? global.activeProgram : undefined), percussion: false };
}

/**
 * What a part's EDIT clip holds of its sound (the roll's EDIT key, lib/
 * rollBounce, and Import as tracks, lib/midiImportTracks): the program the
 * clip plays over its track's, and the bank that program is chosen in
 * (AudioClip `instrumentBank`, which lib/clipProgram clipBank selects for
 * EDIT's live notes and every render). `voice` is the voice the part plays
 * with (partVoice). A part with a program of its own puts it on the clip. A
 * bank belongs to a program, so a part in a bank past 0 with no program of its
 * own pins the program it plays with. A part on the drum channel, where the
 * kit is chosen by program, or with no program anywhere, has no bank.
 * `program` undefined leaves the clip on its track's program.
 */
export function partClipSound(part: Pick<RollTrack, 'program' | 'bank'>, voice: ClipVoice): { program: number | undefined; bank: number } {
  const bank = voice.percussion || voice.program === undefined ? 0 : cleanPartBank(part.bank);
  return { program: part.program !== null ? part.program : bank > 0 ? voice.program : undefined, bank };
}

/** Every part's notes in one list, each part's in order: what fits the roll's length and range. */
export const allPartNotes = (tracks: readonly Pick<RollTrack, 'notes'>[]): PianoNote[] => tracks.flatMap((t) => t.notes);

/**
 * The instrument AI COMPOSE writes a part for (lib/aiComposeGrid): the part's
 * registry instrument, else the registry's instrument for its program, with
 * its practical range; a percussion part is drums. Undefined for a part with
 * neither, which is written as the piano part COMPOSE has always written.
 */
export function partComposeInstrument(part: Pick<RollTrack, 'program' | 'bank' | 'channel' | 'instrumentId'>): ComposeInstrument | undefined {
  const percussion = isPercussionPart(part);
  const inst = orchestraInstrument(part.instrumentId) ?? (part.program !== null ? instrumentForProgram(part.program, part.bank, percussion) : undefined);
  if (percussion) return { name: inst?.name ?? 'Drum kit', rangeLow: 35, rangeHigh: 81, grandStaff: false, percussion: true };
  if (!inst) return undefined;
  return { name: inst.name, rangeLow: inst.rangeLow, rangeHigh: inst.rangeHigh, grandStaff: inst.staves >= 2, percussion: false };
}
