/**
 * The motif transforms of the piano roll's selection: INVERT, RETROGRADE,
 * AUGMENT, DIMINISH, SEQUENCE and FRAGMENT (pianoRollStore transformSelection,
 * lib/rollTransforms), invert and sequence by scale degree in the roll's key.
 *
 * Two ways in: the note menu's Transform section (rollTransformMenuItems) and
 * the action rail's TRANSFORM key (PianoRollTransformKey), a key with a menu of
 * the six. Each transform is one undo step, and runRollTransform logs what it did.
 */
import React, { useRef, useState } from 'react';
import { ArrowDownRight, FlipVertical2, Scissors, Shapes, Shrink, Expand, Undo2 } from 'lucide-react';
import {
  ROLL_TRANSFORMS,
  ROLL_TRANSFORM_LABELS,
  effectiveRollKey,
  usePianoRollStore,
  type RollTransformKind,
  type RollTransformOptions,
} from '../../state/pianoRollStore';
import { rollKeyName } from '../../lib/rollKey';
import { logInfo } from '../../state/logStore';
import type { ContextMenuItem } from '../ui/ContextMenu';
import { DockFlyout, FLYOUT_CARD, MenuKey, RAIL_GLYPH, RailKey } from './midiDockKit';

/** What each transform does, in words: the menus' tooltips and the log line. */
export const ROLL_TRANSFORM_HELP: Readonly<Record<RollTransformKind, string>> = Object.freeze({
  invert: 'Mirror the selection upside down about its first note, by scale degree in the roll key',
  retrograde: 'Play the selection backwards inside its own span',
  augment: 'Twice as long, from its first note',
  diminish: 'Half as long, from its first note',
  sequence: 'Repeat the selection twice after itself, each time a scale step lower',
  fragment: 'Keep the first half of the selection, where it started',
});

/** The menus' words for each transform with its default setting. */
export const ROLL_TRANSFORM_MENU_LABELS: Readonly<Record<RollTransformKind, string>> = Object.freeze({
  invert: 'Invert',
  retrograde: 'Retrograde',
  augment: 'Augment ×2',
  diminish: 'Diminish ÷2',
  sequence: 'Sequence, down a step',
  fragment: 'Fragment, first half',
});

const ICONS: Record<RollTransformKind, React.ReactNode> = {
  invert: <FlipVertical2 className="w-3 h-3" />,
  retrograde: <Undo2 className="w-3 h-3" />,
  augment: <Expand className="w-3 h-3" />,
  diminish: <Shrink className="w-3 h-3" />,
  sequence: <ArrowDownRight className="w-3 h-3" />,
  fragment: <Scissors className="w-3 h-3" />,
};

/** Transform the selection (pianoRollStore transformSelection) and say so in the log. Returns how many notes are selected after. */
export function runRollTransform(kind: RollTransformKind, opts?: RollTransformOptions): number {
  const s = usePianoRollStore.getState();
  const before = s.selectedIds.size;
  if (before === 0) return 0;
  const n = s.transformSelection(kind, opts);
  const diatonic = (kind === 'invert' || kind === 'sequence') && opts?.diatonic !== false;
  logInfo(
    'piano-roll',
    `${ROLL_TRANSFORM_LABELS[kind]}: ${before} note${before === 1 ? '' : 's'} in, ${n} out${diatonic ? ` (in ${rollKeyName(effectiveRollKey(usePianoRollStore.getState()))})` : ''}`,
  );
  return n;
}

/** The note menu's Transform section: a header and the six transforms, each on the whole selection. */
export function rollTransformMenuItems(selected: number): ContextMenuItem[] {
  return [
    { type: 'header', label: `Transform ${selected} selected` },
    ...ROLL_TRANSFORMS.map(
      (kind): ContextMenuItem => ({
        type: 'item',
        label: ROLL_TRANSFORM_MENU_LABELS[kind],
        icon: ICONS[kind],
        title: ROLL_TRANSFORM_HELP[kind],
        disabled: selected === 0,
        onSelect: () => {
          runRollTransform(kind);
        },
      }),
    ),
  ];
}

/**
 * TRANSFORM: the action rail's key for the six transforms of the selection.
 * It opens a menu of them to its right; with nothing selected the key is off.
 */
export const PianoRollTransformKey: React.FC = () => {
  const selected = usePianoRollStore((s) => s.selectedIds.size);
  const [open, setOpen] = useState(false);
  const keyRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={wrapRef} className="relative">
      <RailKey
        ref={keyRef}
        onClick={() => setOpen((o) => !o)}
        disabled={selected === 0}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="piano-roll-transform-menu"
        aria-label={selected ? `Transform the ${selected} selected note${selected === 1 ? '' : 's'}` : 'Transform: select notes first'}
        description="Invert, retrograde, augment, diminish, sequence or fragment the selected notes, in the roll key"
        icon={<Shapes className={RAIL_GLYPH} />}
        legend="Transform"
        on={open}
      />
      <DockFlyout
        open={open && selected > 0}
        anchorRef={wrapRef}
        returnFocusRef={keyRef}
        onClose={() => setOpen(false)}
        placement="right"
        floorSelector="[data-dock-floor]"
        id="piano-roll-transform-menu"
        role="menu"
        aria-label="Transform the selection"
        className={`w-52 p-1 flex flex-col gap-0.5 ${FLYOUT_CARD}`}
      >
        {ROLL_TRANSFORMS.map((kind) => (
          <MenuKey
            key={kind}
            onClick={() => {
              setOpen(false);
              runRollTransform(kind);
            }}
            title={ROLL_TRANSFORM_HELP[kind]}
            icon={ICONS[kind]}
            legend={ROLL_TRANSFORM_MENU_LABELS[kind]}
          />
        ))}
      </DockFlyout>
    </div>
  );
};
