/**
 * VirtuosoControls — the MIDI dock's SHAPE row: the virtuoso transforms
 * (harmony / ragtime / runs / polyrhythm / humanize) under the piano roll, so
 * they are reachable from both the roll and the arpeggiator face. Each amount is
 * a native range (arrow keys step it); changes re-render the roll live from the
 * captured source. Key, scale, style and the groove reference sit beside them.
 * CAPTURE snapshots the current roll as the morph base; SONG assembles a full
 * multi-section arrangement; FORM opens the song-structure editor above the row,
 * which lays out the sections (role, bar count, meter, tempo) the build uses.
 *
 * A SHAPE | METER switch at the row's left end flips it to the METER face
 * (MeterFace.tsx), remembered across sessions; the row keeps its height, its
 * orb clearance and its single line on both faces.
 */
import React from 'react';
import { Camera, ChevronLeft, ChevronRight, LayoutTemplate, ListMusic, Plus, RotateCcw, Ruler, Section as SectionGlyph, X } from 'lucide-react';
import { useVirtuosoStore } from '../../state/virtuosoStore';
import { LibraryPicker, MIDI_ONLY_TABS } from './LibraryPicker';
import { MeterFace } from './MeterFace';
import { logError } from '../../state/logStore';
import { meterLabel, parseMeterLabel, sectionMeterChoices } from '../../lib/meterFace';
import { TEMPO_BPM_MAX, TEMPO_BPM_MIN } from '../../lib/tempoMap';
import {
  STYLES,
  STYLE_NAMES,
  ROLES,
  ROLE_LABELS,
  defaultSections,
  harmonyDescription,
  heldSectionTempo,
  type VirtuosoAmounts,
  type StyleName,
  type Role,
} from '../../lib/virtuosoTransform';
import {
  DOCK_SELECT,
  DockFlyout,
  FIELD,
  FIELD_LEGEND,
  FIELD_SELECT,
  FIELD_SHRINK,
  FIELD_VALUE,
  FLYOUT_CARD,
  FLYOUT_KEY,
  KEY_REST,
  MINI_GLYPH,
  MINI_ICON_KEY,
  RANGE_FILL,
  STRIP_GLYPH,
  Sep,
  StripKey,
  useOrbClearance,
  useStoredToggle,
} from './midiDockKit';

/** The row's face: SHAPE (off) or METER (on). */
const SHAPE_FACE_KEY = 'thedaw-midi-shape-face-v1';

const KEYS = 'C C# D D# E F F# G G# A A# B'.split(' ');
const MODES = [
  'ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian',
  'major', 'minor', 'melodic', 'harmonic',
];

/** Legend = the one printed word, which names the range through its <label>;
 *  label = the full name, in the field's tooltip, with `more` after it when set. */
const SLIDERS: Array<{ k: keyof VirtuosoAmounts; legend: string; label: string; more?: string }> = [
  { k: 'harmony', legend: 'Harmony', label: 'Harmony' },
  { k: 'ragtime', legend: 'Ragtime', label: 'Ragtime' },
  { k: 'runs', legend: 'Runs', label: 'Runs' },
  { k: 'rhythm', legend: 'Poly', label: 'Polyrhythm', more: "cross-accents, and real 3:2, 4:3 and 5:4 notes over a share of each bar's groups" },
  { k: 'humanize', legend: 'Humanize', label: 'Humanize' },
];

const sectionField =
  'h-5 bg-black/50 border border-white/10 rounded-xs px-1 text-[12px] font-semibold tabular-nums text-zinc-200 outline-none';

const SongStructure: React.FC = () => {
  // Select raw state and derive the effective list with useMemo — calling
  // effectiveSections() inside the selector returns a fresh array each render
  // (the default path) and drives an infinite re-render loop.
  const rawSections = useVirtuosoStore((s) => s.sections);
  const style = useVirtuosoStore((s) => s.style);
  const setSectionRole = useVirtuosoStore((s) => s.setSectionRole);
  const setSectionBars = useVirtuosoStore((s) => s.setSectionBars);
  const setSectionMeter = useVirtuosoStore((s) => s.setSectionMeter);
  const setSectionTempo = useVirtuosoStore((s) => s.setSectionTempo);
  const addSection = useVirtuosoStore((s) => s.addSection);
  const removeSection = useVirtuosoStore((s) => s.removeSection);
  const moveSection = useVirtuosoStore((s) => s.moveSection);
  const resetSections = useVirtuosoStore((s) => s.resetSections);
  const custom = rawSections != null;
  const sections = React.useMemo(() => rawSections ?? defaultSections(style), [rawSections, style]);

  const totalBars = sections.reduce((n, x) => n + x.bars, 0);

  return (
    <div className="flex flex-col gap-1.5 p-2">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-display font-extrabold uppercase et-ink">Form</span>
        <span
          className="inline-flex items-center gap-0.5 text-[12px] font-bold et-ink-2 tabular-nums"
          title={custom ? `Sections: ${sections.length}` : `Sections: ${sections.length}, the style's default`}
        >
          <SectionGlyph aria-hidden="true" className="w-3 h-3 et-ink-3" />
          <span>{sections.length}</span>
          <span className="sr-only">sections</span>
        </span>
        <span className="inline-flex items-center gap-0.5 text-[12px] font-bold et-ink-2 tabular-nums" title={`Bars: ${totalBars}`}>
          <Ruler aria-hidden="true" className="w-3 h-3 et-ink-3" />
          <span>{totalBars}</span>
          <span className="sr-only">bars</span>
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={addSection}
          aria-label="Add a section"
          title="Add a section"
          className={`${FLYOUT_KEY} ${KEY_REST}`}
        >
          <Plus aria-hidden="true" className="w-3 h-3" />
          <span>Add</span>
        </button>
        <button
          type="button"
          onClick={resetSections}
          aria-label="Reset the form"
          title="Discard the custom layout and follow the style's default structure."
          className={`${FLYOUT_KEY} ${KEY_REST}`}
        >
          <RotateCcw aria-hidden="true" className="w-3 h-3" />
          <span>Reset</span>
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        {sections.map((sec, i) => (
          <div key={i} className="flex items-center gap-0.5 rounded-xs border border-white/10 bg-white/3 px-1 py-0.5">
            <span className="text-[12px] font-bold et-ink-3 w-4 text-right tabular-nums">{i + 1}</span>
            <button
              type="button"
              className={`${MINI_ICON_KEY} ${KEY_REST}`}
              aria-label={`Move section ${i + 1} earlier`}
              title="Earlier"
              onClick={() => moveSection(i, -1)}
            >
              <ChevronLeft aria-hidden="true" className="w-3 h-3" />
            </button>
            <label htmlFor={`vt-sec-role-${i}`} className="sr-only">{`Section ${i + 1} role`}</label>
            <select
              id={`vt-sec-role-${i}`}
              name={`vt-sec-role-${i}`}
              value={sec.role}
              onChange={(e) => setSectionRole(i, e.target.value as Role)}
              className={sectionField}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
            <label htmlFor={`vt-sec-bars-${i}`} className="sr-only">{`Section ${i + 1} bars`}</label>
            <input
              id={`vt-sec-bars-${i}`}
              name={`vt-sec-bars-${i}`}
              type="number"
              min={1}
              max={16}
              value={sec.bars}
              onChange={(e) => setSectionBars(i, parseInt(e.target.value, 10) || 1)}
              className={`${sectionField} w-9`}
            />
            <label htmlFor={`vt-sec-meter-${i}`} className="sr-only">{`Section ${i + 1} meter`}</label>
            <select
              id={`vt-sec-meter-${i}`}
              name={`vt-sec-meter-${i}`}
              value={sec.meter ? meterLabel(sec.meter) : ''}
              onChange={(e) => setSectionMeter(i, parseMeterLabel(e.target.value))}
              title="The section's time signature; Roll follows the piano roll's meter map"
              className={sectionField}
            >
              <option value="">Roll</option>
              {sectionMeterChoices(sec.meter).map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
            {/* The section's tempo. Empty keeps the tempo in force, as in a
                score: an earlier section's tempo (its number shows as the
                placeholder), else the roll's tempo map. A typed tempo applies
                on Enter or when the field loses focus, so the "1" of a typed
                132 is never taken as a tempo of its own. */}
            <label htmlFor={`vt-sec-bpm-${i}`} className="sr-only">{`Section ${i + 1} tempo in BPM`}</label>
            <input
              key={`${i}:${sec.bpm ?? ''}`}
              id={`vt-sec-bpm-${i}`}
              name={`vt-sec-bpm-${i}`}
              type="number"
              min={TEMPO_BPM_MIN}
              max={TEMPO_BPM_MAX}
              step="any"
              placeholder={heldSectionTempo(sections, i) === undefined ? 'BPM' : String(heldSectionTempo(sections, i))}
              defaultValue={sec.bpm ?? ''}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
              onBlur={(e) => {
                const text = e.target.value.trim();
                const v = Number.parseFloat(text);
                if (text === '') setSectionTempo(i, null);
                else if (Number.isFinite(v) && v > 0) setSectionTempo(i, v);
                else e.target.value = sec.bpm === undefined ? '' : String(sec.bpm);
              }}
              title={
                heldSectionTempo(sections, i) === undefined
                  ? "The section's tempo; empty follows the piano roll's tempo map. The build slows into each section's last bar."
                  : `The section's tempo; empty keeps ${heldSectionTempo(sections, i)} BPM from an earlier section, as a tempo marking holds until the next one. The build slows into each section's last bar.`
              }
              className={`${sectionField} w-13`}
            />
            <button
              type="button"
              className={`${MINI_ICON_KEY} ${KEY_REST}`}
              aria-label={`Move section ${i + 1} later`}
              title="Later"
              onClick={() => moveSection(i, 1)}
            >
              <ChevronRight aria-hidden="true" className="w-3 h-3" />
            </button>
            <button
              type="button"
              className={`${MINI_ICON_KEY} ${KEY_REST}`}
              aria-label={`Remove section ${i + 1}`}
              title="Remove"
              onClick={() => removeSection(i)}
            >
              <X aria-hidden="true" className="w-3 h-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

/** `songEntryId`: the library entry chosen in the strip's song field, whose
 *  rhythm analysis MATCH reads the meter map from. `onStatus`: the MIDI tab's
 *  status line, where the METER face reports GEN and MATCH. */
export const VirtuosoControls: React.FC<{ songEntryId?: string; onStatus?: (text: string) => void }> = ({ songEntryId, onStatus }) => {
  const [meterFace, setMeterFace] = useStoredToggle(SHAPE_FACE_KEY, false);
  const amounts = useVirtuosoStore((s) => s.amounts);
  const setAmount = useVirtuosoStore((s) => s.setAmount);
  const keyV = useVirtuosoStore((s) => s.key);
  const modeV = useVirtuosoStore((s) => s.mode);
  const setKey = useVirtuosoStore((s) => s.setKey);
  const setMode = useVirtuosoStore((s) => s.setMode);
  const style = useVirtuosoStore((s) => s.style);
  const setStyle = useVirtuosoStore((s) => s.setStyle);
  const songMode = useVirtuosoStore((s) => s.songMode);
  const captureSource = useVirtuosoStore((s) => s.captureSource);
  const resetToSource = useVirtuosoStore((s) => s.resetToSource);
  const buildSong = useVirtuosoStore((s) => s.buildSong);
  const groove = useVirtuosoStore((s) => s.groove);
  const setGrooveFromBytes = useVirtuosoStore((s) => s.setGrooveFromBytes);
  const clearGroove = useVirtuosoStore((s) => s.clearGroove);
  const [showStructure, setShowStructure] = React.useState(false);
  const [pickGroove, setPickGroove] = React.useState(false);
  const formKeyRef = React.useRef<HTMLButtonElement>(null);
  // The app's assistant orb parks on the bottom-left corner, over this row's
  // start; the row's content begins past it (and ends before it on the right).
  const rowRef = React.useRef<HTMLDivElement>(null);
  const orb = useOrbClearance(rowRef);

  return (
    <>
      {/* data-note-obstacle: the bottom strip's feature notes keep their cards off this row's keys.
          data-dock-floor: every dock card (MAP below the strip, FORM and GEN above this
          row's keys, the rail's cards beside their keys) ends 4px above this row.
          @container: the groove name reads the row's content width (orb padding excluded). */}
      <div
        ref={rowRef}
        data-note-obstacle
        data-dock-floor=""
        style={orb.left || orb.right ? { paddingLeft: orb.left || undefined, paddingRight: orb.right || undefined } : undefined}
        className="@container shrink-0 h-9 flex flex-nowrap items-center gap-1 px-1.5 border-t border-white/8 bg-black/40"
        role="group"
        aria-label={meterFace ? 'Meter: time signatures, lanes and generators' : 'Shape: virtuoso transforms'}
      >
        <div role="group" aria-label="Row" className="shrink-0 inline-flex gap-px">
          <StripKey
            aria-pressed={!meterFace}
            description="Morph the piano roll into virtuoso lines. Dial each amount; the roll re-renders live from the captured source."
            on={!meterFace}
            onClick={() => setMeterFace(false)}
            legend="Shape"
          />
          <StripKey
            data-tour="midi-meter"
            aria-pressed={meterFace}
            description="Time signatures, groups, lanes, syncopation and generators"
            on={meterFace}
            onClick={() => setMeterFace(true)}
            legend="Meter"
          />
        </div>

        <Sep />

        {meterFace ? (
          <MeterFace songEntryId={songEntryId} onStatus={onStatus} />
        ) : (
        <div className="contents">
        {/* A short row gives up width in order: the groove name first (96px to 48px,
            by the row's container width), then the five ranges (48px to 32px).
            1366x768 with a groove loaded lands at a 48px name and ranges of 40px. */}
        {SLIDERS.map(({ k, legend, label, more }) => {
          // Harmony says what each range does; its description is also the
          // range's accessible description.
          const tip = k === 'harmony' ? harmonyDescription(amounts[k]) : `${label} amount${more ? `: ${more}` : ''}`;
          return (
            <div key={k} className={FIELD_SHRINK} title={tip}>
              <label htmlFor={`vt-${k}`} className={FIELD_LEGEND}>{legend}</label>
              <input
                id={`vt-${k}`}
                name={`vt-${k}`}
                type="range"
                min={0}
                max={100}
                value={Math.round(amounts[k] * 100)}
                onChange={(e) => setAmount(k, (parseInt(e.target.value, 10) || 0) / 100)}
                aria-describedby={k === 'harmony' ? 'vt-harmony-desc' : undefined}
                className={RANGE_FILL}
              />
              {k === 'harmony' && <span id="vt-harmony-desc" className="sr-only">{tip}</span>}
              <span className={`${FIELD_VALUE} w-5.5`}>{Math.round(amounts[k] * 100)}</span>
            </div>
          );
        })}

        <Sep />

        <label htmlFor="vt-key" className="sr-only">Key</label>
        <select
          id="vt-key" name="vt-key" value={keyV} onChange={(e) => setKey(e.target.value)}
          title="Key the transforms use"
          className={`${DOCK_SELECT} w-12`}
        >
          {KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <label htmlFor="vt-mode" className="sr-only">Scale</label>
        <select
          id="vt-mode" name="vt-mode" value={modeV} onChange={(e) => setMode(e.target.value)}
          title="Scale the transforms use"
          className={`${DOCK_SELECT} w-23.5 capitalize`}
        >
          {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>

        <div className={FIELD} title="Composition style for SONG (sets the scale, section structure, dynamics and feel)">
          <label htmlFor="vt-style" className={FIELD_LEGEND}>Style</label>
          <select
            id="vt-style" name="vt-style" value={style} onChange={(e) => setStyle(e.target.value as StyleName)}
            className={`${FIELD_SELECT} max-w-28`}
          >
            {STYLE_NAMES.map((s) => <option key={s} value={s}>{STYLES[s].label}</option>)}
          </select>
        </div>

        {/* The field keeps its width; only its name gives, and only below 1530px of
            row, where the ranges would otherwise be the first to narrow. The keys
            carry DockTips, so the long explanation sits on the legend alone. */}
        <div className={FIELD}>
          <span
            className={FIELD_LEGEND}
            title="Drive the Humanize timing/feel from a reference song's groove (a Library track's transcribed MIDI). Timing pocket + rhythmic emphasis are learned; transcription does not recover dynamics."
          >
            Groove
          </span>
          {groove ? (
            <>
              <span
                data-groove-name=""
                className="min-w-12 max-w-24 @max-[1530px]:max-w-12 truncate text-[12px] font-semibold et-ink"
                title={groove.name}
              >
                {groove.name}
              </span>
              <StripKey
                mini
                iconOnly
                onClick={clearGroove}
                aria-label="Clear groove reference"
                description={`Stop driving Humanize from ${groove.name}`}
                icon={<X className={MINI_GLYPH} />}
                legend="Clear groove"
              />
            </>
          ) : (
            <StripKey
              mini
              onClick={() => setPickGroove(true)}
              aria-label="Pick a groove reference"
              description="Choose a Library track or MIDI file whose timing pocket and rhythmic emphasis drive Humanize"
              legend="Pick"
            />
          )}
        </div>

        {/* The row's four actions at its end, 1px apart like the row's other key groups. */}
        <div data-shape-actions="" className="ml-auto shrink-0 inline-flex items-center gap-px">
          <StripKey
            iconOnly
            onClick={captureSource}
            aria-label="Capture the roll as the morph source"
            description="Snapshot the current piano roll as the morph source (re-grab after changing the arp or notes)."
            icon={<Camera className={STRIP_GLYPH} />}
            legend="Capture"
          />
          <StripKey
            iconOnly
            onClick={resetToSource}
            aria-label="Reset to the captured source"
            description="Reset amounts to zero and restore the captured source to the roll."
            icon={<RotateCcw className={STRIP_GLYPH} />}
            legend="Reset"
          />
          <StripKey
            ref={formKeyRef}
            iconOnly
            onClick={() => setShowStructure((v) => !v)}
            aria-haspopup="dialog"
            aria-expanded={showStructure}
            aria-controls="vt-structure"
            aria-label="Form: the song structure"
            description="Open the song-structure configurator: lay out the sections (intro, theme, build, chorus, solo, climax, outro) and their length that SONG uses."
            on={showStructure}
            icon={<LayoutTemplate className={STRIP_GLYPH} />}
            legend="Form"
          />
          <StripKey
            iconOnly
            onClick={buildSong}
            aria-pressed={songMode}
            aria-label="Song: build a full arrangement"
            description="Build a full, developing arrangement from the source in the chosen style/structure, with voice-leading, a melody, a crescendo, and a ritardando into each section end written into the tempo map. While built, the sliders reshape the whole song; Reset returns to the phrase."
            on={songMode}
            icon={<ListMusic className={STRIP_GLYPH} />}
            legend="Song"
          />
        </div>
        </div>
        )}
      </div>

      <DockFlyout
        open={showStructure && !meterFace}
        anchorRef={formKeyRef}
        onClose={() => setShowStructure(false)}
        placement="above"
        align="end"
        ceilingSelector="[data-dock-ceiling]"
        floorSelector="[data-dock-floor]"
        id="vt-structure"
        role="dialog"
        aria-label="Song form"
        className={`w-150 max-w-[90vw] ${FLYOUT_CARD}`}
      >
        <SongStructure />
      </DockFlyout>

      <LibraryPicker
        open={pickGroove}
        title="Pick a groove reference"
        subtitle="Its timing and velocities become the groove template"
        tabs={MIDI_ONLY_TABS}
        allowFiles
        showInstrument
        onClose={() => setPickGroove(false)}
        onPick={(pick) => {
          setPickGroove(false);
          if (pick.kind !== 'midi') return;
          const ok = setGrooveFromBytes(pick.bytes, pick.label);
          if (!ok) logError('virtuoso', 'That MIDI had no notes to learn a groove from.');
        }}
      />
    </>
  );
};
