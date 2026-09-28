/**
 * EXPRESSION: the roll's phrase-expression toggle (pianoRollStore
 * `expressionOn`). On, the composer's writes (a plan, a counterpoint, a FORM
 * movement) and Virtuoso's song build shape each part they write: CC 1 and
 * CC 11 curves from its hairpins, slurs and note density, a swell inside each
 * held note of a sustaining instrument, and seeded attacks per articulation
 * (lib/clipNotes/expression). The COMPOSE column and Virtuoso's SONG row show
 * the same key over the same setting.
 */
import React from 'react';
import { Wind } from 'lucide-react';
import { usePianoRollStore } from '../../state/pianoRollStore';
import { MINI_GLYPH, STRIP_GLYPH, StripKey } from './midiDockKit';

export const ExpressionKey: React.FC<{ mini?: boolean; iconOnly?: boolean }> = ({ mini = false, iconOnly = false }) => {
  const on = usePianoRollStore((s) => s.expressionOn);
  return (
    <StripKey
      mini={mini}
      iconOnly={iconOnly}
      on={on}
      aria-pressed={on}
      onClick={() => usePianoRollStore.getState().setExpressionOn(!on)}
      legend="Expression"
      icon={<Wind className={mini ? MINI_GLYPH : STRIP_GLYPH} />}
      description={
        on
          ? 'Expression is on: a plan, a counterpoint, a FORM movement and a built song are written with CC 1 and CC 11 phrase curves, swells inside held notes, and played attacks'
          : 'Expression is off: composed parts are written flat. Turn it on to shape each part with phrase curves, swells and played attacks'
      }
    />
  );
};
